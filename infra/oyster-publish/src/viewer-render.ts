// Per-kind/content-type render dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Render dispatch).
//
// Each render function returns a Response with status + headers + body set.
// Per-mode cache headers are applied here; ETag is set only for open mode.

import MarkdownIt from "markdown-it";
import { renderChromePage } from "./viewer-chrome";
import type { PublicationRow } from "./types";

const md = new MarkdownIt({
  html: false,        // raw HTML in markdown is escaped (XSS defence)
  linkify: true,      // bare URLs become links (validateLink still applied)
  typographer: false,
});

// ─── Markdown ──────────────────────────────────────────────────────────────

export function renderMarkdownPage(bytes: Uint8Array, row: PublicationRow): Response {
  const source = new TextDecoder().decode(bytes);
  const html = md.render(source);
  // Title: first H1 if present, else fallback.
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? stripTags(titleMatch[1]!) : "Shared via Oyster";
  const page = renderChromePage({ title, bodyHtml: html });

  const headers = new Headers(cacheHeaders(row, "text/html; charset=utf-8"));
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'",
  );
  return new Response(page, { status: 200, headers });
}

// ─── Cache headers ─────────────────────────────────────────────────────────

export function cacheHeaders(row: PublicationRow, contentType: string): HeadersInit {
  const headers: Record<string, string> = { "content-type": contentType };
  if (row.mode === "open") {
    headers["cache-control"] = "public, max-age=60, must-revalidate";
    headers["etag"] = `"${row.share_token}-${row.updated_at}"`;
  } else {
    headers["cache-control"] = "private, no-store";
  }
  // Block content-type sniffing across all responses.
  headers["x-content-type-options"] = "nosniff";
  return headers;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

// ─── Mermaid ───────────────────────────────────────────────────────────────

const MERMAID_VERSION = "10.9.1";
const MERMAID_SRI = "sha384-WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr";  // computed via openssl dgst -sha384 -binary; pinned with version
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

export function renderMermaidPage(bytes: Uint8Array, row: PublicationRow): Response {
  const source = new TextDecoder().decode(bytes);
  // Only escape chars that would break HTML structure; mermaid reads textContent so &gt; would appear literally in the diagram.
  const escaped = source.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
  const body = `
<pre class="mermaid">${escaped}</pre>
<script src="${MERMAID_URL}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>
<script>
(function() {
  if (typeof mermaid === 'undefined') {
    showSourceFallback('mermaid CDN unavailable');
    return;
  }
  try {
    mermaid.initialize({ startOnLoad: false });
    mermaid.run({ querySelector: 'pre.mermaid' }).catch(function(err) {
      showSourceFallback(err && err.message ? err.message : 'render failed');
    });
  } catch (err) {
    showSourceFallback(err && err.message ? err.message : 'init failed');
  }
  function showSourceFallback(reason) {
    var el = document.querySelector('pre.mermaid');
    if (!el) return;
    el.removeAttribute('class');
    el.outerHTML = '<pre><code>' + el.textContent.replace(/[&<>]/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}) + '</code></pre>' +
      '<p style="font-size:0.8rem;color:#999">Diagram could not render: ' + reason.replace(/[<>]/g,'') + '</p>';
  }
})();
</script>
`;
  const page = renderChromePage({ title: "Diagram", bodyHtml: body });
  const headers = new Headers(cacheHeaders(row, "text/html; charset=utf-8"));
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  );
  return new Response(page, { status: 200, headers });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

// ─── Iframe chrome (app / deck / wireframe / table / map) ──────────────────

export function renderChromeWithIframe(row: PublicationRow): Response {
  const iframe = `
<!-- Deliberately omit allow-same-origin.
     With allow-scripts only, the sandboxed document gets an opaque origin
     and cannot access oyster.to cookies or same-origin storage. -->
<iframe sandbox="allow-scripts" src="/p/${escapeAttr(row.share_token)}/raw"
        style="border:0;width:100%;flex:1;display:block;"></iframe>`;
  // Iframe view: main fills remaining flex space and stretches the iframe to it.
  // Avoids vh-math that would drift when header height changes at responsive breakpoints.
  const cssExtra = `main { padding: 0; max-width: none; display: flex; }`;
  const page = renderChromePage({ title: "Shared via Oyster", bodyHtml: iframe, cssExtra });
  return new Response(page, {
    status: 200,
    headers: cacheHeaders(row, "text/html; charset=utf-8"),
  });
}

// Inline shim injected into every iframe-content document. Sandboxed iframes
// without allow-same-origin can't access localStorage/sessionStorage — every
// access throws SecurityError. Most AI-generated apps read storage at boot
// (e.g. to restore a font preference), and a single uncaught SecurityError
// halts the rest of the bootstrap, leaving the iframe blank.
//
// The shim defines no-op replacements when the native APIs are unreachable
// so apps boot. State doesn't persist (correct for sandboxed content — each
// visitor gets a fresh load anyway).
const STORAGE_SHIM = `<script>
(function() {
  function noop() { return {
    getItem: function() { return null; },
    setItem: function() {},
    removeItem: function() {},
    clear: function() {},
    key: function() { return null; },
    get length() { return 0; },
  }; }
  try { localStorage.length; } catch (e) {
    Object.defineProperty(window, 'localStorage', { value: noop(), configurable: false });
  }
  try { sessionStorage.length; } catch (e) {
    Object.defineProperty(window, 'sessionStorage', { value: noop(), configurable: false });
  }
})();
</script>`;

export function injectStorageShim(bytes: Uint8Array): Uint8Array {
  // Byte-level splice — never decode the user's HTML to a string, so we don't
  // corrupt non-UTF-8 (or invalid-UTF-8) payloads on the round trip. Tag names
  // are ASCII; we case-fold the haystack bytes manually.
  //
  // Insertion priority: <head> > <html> > <!doctype>. Putting a <script> before
  // an existing <!doctype> would trigger quirks mode, so we always inject AFTER
  // any structural marker we recognise. If none are present (e.g. a bare HTML
  // fragment), we leave the doc untouched rather than risking corruption.
  const at = findShimInsertionPoint(bytes);
  if (at < 0) return bytes;

  const shimBytes = new TextEncoder().encode(STORAGE_SHIM);
  const out = new Uint8Array(bytes.length + shimBytes.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(shimBytes, at);
  out.set(bytes.subarray(at), at + shimBytes.length);
  return out;
}

function findShimInsertionPoint(bytes: Uint8Array): number {
  for (const tag of ["<head", "<html", "<!doctype"]) {
    const start = findTagOpen(bytes, tag);
    if (start < 0) continue;
    const close = findByte(bytes, 0x3e /* > */, start + tag.length);
    if (close >= 0) return close + 1;
  }
  return -1;
}

function findTagOpen(haystack: Uint8Array, lowerNeedle: string): number {
  // Case-insensitive ASCII match. `lowerNeedle` must already be lowercase.
  // Also enforces a tag-name boundary after the needle so `<head` doesn't
  // falsely match `<header>` and `<html` doesn't match `<html5>` etc.
  const n = lowerNeedle.length;
  outer: for (let i = 0; i + n <= haystack.length; i++) {
    for (let j = 0; j < n; j++) {
      const c = haystack[i + j]!;
      const want = lowerNeedle.charCodeAt(j);
      const cl = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
      if (cl !== want) continue outer;
    }
    // Tag-name boundary: the byte after the needle must NOT be an ASCII
    // letter or digit, otherwise this is the prefix of a longer tag.
    const after = haystack[i + n];
    if (after !== undefined && isTagNameByte(after)) continue outer;
    return i;
  }
  return -1;
}

function isTagNameByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39); // 0-9
}

function findByte(haystack: Uint8Array, byte: number, start: number): number {
  for (let i = start; i < haystack.length; i++) {
    if (haystack[i] === byte) return i;
  }
  return -1;
}

export function renderRawHtmlBody(bytes: Uint8Array, row: PublicationRow): Response {
  // Iframe kinds (app/deck/wireframe/table/map) are always HTML. Force
  // text/html regardless of the stored content_type — older publications
  // were uploaded with application/octet-stream, which combined with
  // x-content-type-options: nosniff makes the browser refuse to render
  // them inside the iframe.
  const headers = new Headers(cacheHeaders(row, "text/html; charset=utf-8"));
  headers.set(
    "content-security-policy",
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
  );
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("content-disposition", "inline");
  // Inject the storage shim so apps that touch localStorage/sessionStorage
  // at startup can boot rather than crashing on SecurityError.
  return new Response(injectStorageShim(bytes), { status: 200, headers });
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

// ─── Image inline ──────────────────────────────────────────────────────────

export function renderImageInline(bytes: Uint8Array, row: PublicationRow): Response {
  const headers = new Headers(cacheHeaders(row, row.content_type));
  headers.set("content-disposition", "inline");
  headers.set("content-security-policy", "default-src 'none'; img-src 'self' data:");
  return new Response(bytes, { status: 200, headers });
}
