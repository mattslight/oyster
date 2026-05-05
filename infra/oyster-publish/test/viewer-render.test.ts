import { describe, it, expect } from "vitest";
import { renderMarkdownPage, renderMermaidPage } from "../src/viewer-render";

const ROW = {
  share_token: "abc",
  artifact_kind: "notes",
  content_type: "text/markdown",
  // Other fields not used by markdown render
} as any;

describe("renderMarkdownPage — basic rendering", () => {
  it("returns a 200 HTML response with the title in <title>", async () => {
    const res = renderMarkdownPage(new TextEncoder().encode("# Hello"), ROW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain("<h1>Hello</h1>");
  });

  it("renders a list with linkified URLs", async () => {
    const res = renderMarkdownPage(
      new TextEncoder().encode("- See https://example.com"),
      ROW,
    );
    const body = await res.text();
    expect(body).toContain('href="https://example.com"');
  });
});

describe("renderMarkdownPage — link safety (markdown-it default validateLink)", () => {
  it("does NOT render javascript: as an active href", async () => {
    const res = renderMarkdownPage(
      new TextEncoder().encode("[click me](javascript:alert(1))"),
      ROW,
    );
    const body = await res.text();
    // markdown-it default behaviour is to drop the href entirely,
    // leaving the link text but not making it active.
    expect(body).not.toContain('href="javascript:');
    expect(body).not.toContain("href='javascript:");
  });

  it("does NOT render vbscript: as an active href", async () => {
    const res = renderMarkdownPage(
      new TextEncoder().encode("[x](vbscript:msgbox(1))"),
      ROW,
    );
    const body = await res.text();
    expect(body).not.toContain('href="vbscript:');
  });

  it("does NOT render file: as an active href", async () => {
    const res = renderMarkdownPage(
      new TextEncoder().encode("[x](file:///etc/passwd)"),
      ROW,
    );
    const body = await res.text();
    expect(body).not.toContain('href="file://');
  });

  it("escapes raw <script> in markdown (html: false)", async () => {
    const res = renderMarkdownPage(
      new TextEncoder().encode("<script>alert(1)</script>"),
      ROW,
    );
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("renderMarkdownPage — cache headers", () => {
  it("sets cache-control: public, max-age=60, must-revalidate for open mode", async () => {
    const openRow = { ...ROW, mode: "open", updated_at: 1000 };
    const res = renderMarkdownPage(new TextEncoder().encode("# x"), openRow);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^"abc-1000"$/);
  });

  it("sets cache-control: private, no-store for non-open modes", async () => {
    const pwRow = { ...ROW, mode: "password", updated_at: 1000 };
    const res = renderMarkdownPage(new TextEncoder().encode("# x"), pwRow);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBeNull();
  });
});

describe("renderMermaidPage", () => {
  const SOURCE = "graph TD; A-->B;";
  const ROW = { share_token: "mer1", mode: "open", updated_at: 2000, artifact_kind: "diagram", content_type: "text/plain" } as any;

  it("returns a 200 HTML response", async () => {
    const res = renderMermaidPage(new TextEncoder().encode(SOURCE), ROW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("embeds the source verbatim in <pre class=\"mermaid\">", async () => {
    const res = renderMermaidPage(new TextEncoder().encode(SOURCE), ROW);
    const body = await res.text();
    expect(body).toContain(`<pre class="mermaid">${SOURCE}</pre>`);
  });

  it("loads pinned mermaid CDN with SRI", async () => {
    const res = renderMermaidPage(new TextEncoder().encode(SOURCE), ROW);
    const body = await res.text();
    expect(body).toContain("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js");
    expect(body).toContain("integrity=\"sha384-");
    expect(body).toContain('crossorigin="anonymous"');
  });

  it("includes a fallback that shows source on mermaid.run() failure", async () => {
    const res = renderMermaidPage(new TextEncoder().encode(SOURCE), ROW);
    const body = await res.text();
    expect(body).toContain("mermaid.run");
    expect(body).toContain(".catch");
  });

  it("sets a CSP that allows jsdelivr scripts", async () => {
    const res = renderMermaidPage(new TextEncoder().encode(SOURCE), ROW);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toMatch(/cdn\.jsdelivr\.net/);
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/);
  });
});

import { renderChromeWithIframe, renderRawHtmlBody } from "../src/viewer-render";

describe("renderChromeWithIframe", () => {
  const ROW = { share_token: "app1", mode: "open", updated_at: 3000, artifact_kind: "app", content_type: "text/html" } as any;

  it("returns a 200 HTML response with chrome", async () => {
    const res = renderChromeWithIframe(ROW);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/class="brand-mark"/);
    expect(body).toContain("Published with");
    expect(body).toContain("https://oyster.to");
  });

  it("contains a sandboxed iframe pointing at /p/<token>/raw", async () => {
    const res = renderChromeWithIframe(ROW);
    const body = await res.text();
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).toContain('src="/p/app1/raw"');
    // Critical: sandbox attribute must NOT include allow-same-origin (would defeat origin isolation)
    expect(body).not.toMatch(/sandbox="[^"]*allow-same-origin/);
  });

  it("includes the deliberate-omission comment in source", async () => {
    const res = renderChromeWithIframe(ROW);
    const body = await res.text();
    expect(body).toContain("Deliberately omit allow-same-origin");
  });
});

describe("renderRawHtmlBody — strict CSP for iframe content", () => {
  it("forces text/html; charset=utf-8 regardless of stored content-type", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;
    const bytes = new TextEncoder().encode("<h1>my app</h1>");
    const res = renderRawHtmlBody(bytes, ROW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<h1>my app</h1>");
  });

  it("overrides application/octet-stream so browsers render the HTML (regression for early publish uploads)", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "application/octet-stream" } as any;
    const bytes = new TextEncoder().encode("<h1>my app</h1>");
    const res = renderRawHtmlBody(bytes, ROW);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("sets a strict CSP including connect-src 'none' and form-action 'none'", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;
    const res = renderRawHtmlBody(new TextEncoder().encode(""), ROW);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("allows Google Fonts in style-src and font-src so AI-generated apps can load typography", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;
    const res = renderRawHtmlBody(new TextEncoder().encode(""), ROW);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it("sets X-Frame-Options: SAMEORIGIN", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;
    const res = renderRawHtmlBody(new TextEncoder().encode(""), ROW);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("renderRawHtmlBody — storage shim injection", () => {
  const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;

  it("injects a no-op localStorage/sessionStorage shim into the served HTML", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><html><head><title>x</title></head><body>hi</body></html>");
    const body = await renderRawHtmlBody(bytes, ROW).text();
    expect(body).toContain("localStorage");
    expect(body).toContain("sessionStorage");
    expect(body).toContain("Object.defineProperty");
  });

  it("places the shim immediately after <head> so it runs before any user script", async () => {
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><head><script>window.userCode='ran'</script></head><body></body></html>",
    );
    const body = await renderRawHtmlBody(bytes, ROW).text();
    const shimIdx = body.indexOf("Object.defineProperty");
    const userIdx = body.indexOf("userCode");
    expect(shimIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(shimIdx).toBeLessThan(userIdx);
  });

  it("falls back to <html> when no <head> is present", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><html><body>hi</body></html>");
    const body = await renderRawHtmlBody(bytes, ROW).text();
    const shimIdx = body.indexOf("Object.defineProperty");
    const htmlIdx = body.indexOf("<html>");
    const bodyIdx = body.indexOf("<body");
    expect(shimIdx).toBeGreaterThan(htmlIdx); // after <html>
    expect(shimIdx).toBeLessThan(bodyIdx); // before <body>
  });

  it("falls back to <!doctype> when neither <head> nor <html> is present (avoids quirks mode)", async () => {
    // A <script> before <!doctype> would put the browser in quirks mode.
    // Insert AFTER the doctype instead.
    const bytes = new TextEncoder().encode("<!doctype html><body>fragment</body>");
    const body = await renderRawHtmlBody(bytes, ROW).text();
    const shimIdx = body.indexOf("Object.defineProperty");
    expect(body.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(shimIdx).toBeGreaterThan("<!doctype html>".length - 1);
  });

  it("leaves the document untouched when no <head>/<html>/<!doctype> marker is present (avoids corruption)", async () => {
    const bytes = new TextEncoder().encode("<div>fragment</div>");
    const out = renderRawHtmlBody(bytes, ROW);
    const body = await out.text();
    expect(body).toBe("<div>fragment</div>");
    expect(body).not.toContain("Object.defineProperty");
  });

  it("does not mistake <header> for <head> (tag-name boundary check)", async () => {
    // <header> shares a 5-char prefix with <head>; we must not pick up the
    // wrong tag and inject mid-document. Doc has no real <head>, so the
    // shim should fall through to <html> instead.
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><body><header>nav</header><p>hi</p></body></html>",
    );
    const body = await renderRawHtmlBody(bytes, ROW).text();
    const shimIdx = body.indexOf("Object.defineProperty");
    const htmlOpen = body.indexOf("<html>");
    const headerOpen = body.indexOf("<header>");
    expect(shimIdx).toBeGreaterThan(htmlOpen);
    expect(shimIdx).toBeLessThan(headerOpen); // not after <header>
  });

  it("does not mistake <html5> or similar for <html>", async () => {
    // No real <html>/<head>/<!doctype>; only a fake <html5> tag-like prefix.
    // Should leave the doc untouched.
    const bytes = new TextEncoder().encode("<html5-not-a-tag>x</html5-not-a-tag>");
    const out = renderRawHtmlBody(bytes, ROW);
    const body = await out.text();
    expect(body).not.toContain("Object.defineProperty");
  });

  it("preserves arbitrary bytes after the insertion point (no UTF-8 round-trip)", async () => {
    // Use a payload with a non-UTF-8-safe byte after the head. A byte-level
    // splice should leave it untouched; a TextDecoder round-trip would
    // replace it with U+FFFD or otherwise mangle it.
    const head = new TextEncoder().encode("<!doctype html><html><head></head><body>");
    const tail = new TextEncoder().encode("</body></html>");
    const lonelyContinuation = new Uint8Array([0xc3, 0x28]); // invalid UTF-8 sequence
    const bytes = new Uint8Array(head.length + lonelyContinuation.length + tail.length);
    bytes.set(head, 0);
    bytes.set(lonelyContinuation, head.length);
    bytes.set(tail, head.length + lonelyContinuation.length);

    const out = new Uint8Array(await renderRawHtmlBody(bytes, ROW).arrayBuffer());
    // Find the lonely continuation bytes are still present, byte-for-byte.
    let found = false;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === 0xc3 && out[i + 1] === 0x28) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("preserves the user's original HTML byte-for-byte after the shim", async () => {
    const original = "<!doctype html><html><head></head><body><p>Hello</p></body></html>";
    const body = await renderRawHtmlBody(new TextEncoder().encode(original), ROW).text();
    expect(body).toContain("<body><p>Hello</p></body></html>");
  });
});

import { renderImageInline } from "../src/viewer-render";

describe("renderImageInline", () => {
  const ROW = { share_token: "img1", mode: "open", updated_at: 4000, content_type: "image/png" } as any;

  it("serves bytes inline with the recorded content-type", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const res = renderImageInline(png, ROW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("applies open-mode cache headers", async () => {
    const res = renderImageInline(new Uint8Array(0), ROW);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(res.headers.get("etag")).toBe(`"img1-4000"`);
  });

  it("applies private no-store for non-open modes", async () => {
    const pwRow = { ...ROW, mode: "password" };
    const res = renderImageInline(new Uint8Array(0), pwRow);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sets a minimal CSP with default-src 'none'", async () => {
    const res = renderImageInline(new Uint8Array(0), ROW);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
  });
});
