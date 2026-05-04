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
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'",
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
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
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
        style="border:0;width:100%;height:calc(100vh - 60px);display:block;"></iframe>`;
  // Body's main padding is removed for iframe so it fills naturally.
  const cssExtra = `main { padding: 0; max-width: none; }`;
  const page = renderChromePage({ title: "Shared via Oyster", bodyHtml: iframe, cssExtra });
  return new Response(page, {
    status: 200,
    headers: cacheHeaders(row, "text/html; charset=utf-8"),
  });
}

export function renderRawHtmlBody(bytes: Uint8Array, row: PublicationRow): Response {
  const headers = new Headers(cacheHeaders(row, row.content_type));
  headers.set(
    "content-security-policy",
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
  );
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("content-disposition", "inline");
  // Buffer.from wrap is required for Workers fetch BodyInit — raw Uint8Array
  // doesn't satisfy the type in cf-types.
  return new Response(bytes, { status: 200, headers });
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
  return new Response(bytes, { status: 200, headers });
}
