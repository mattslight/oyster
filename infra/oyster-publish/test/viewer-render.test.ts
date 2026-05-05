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
    expect(body).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(body).toContain('src="/p/app1/raw"');
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

  it("sets a CSP that allows same-origin + HTTPS fetches and blocks frames + forms", async () => {
    const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;
    const res = renderRawHtmlBody(new TextEncoder().encode(""), ROW);
    const csp = res.headers.get("content-security-policy") ?? "";
    // Origin-isolated apps can fetch their own subdomain and any HTTPS API.
    expect(csp).toContain("connect-src 'self' https:");
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

describe("renderRawHtmlBody — passthrough", () => {
  const ROW = { share_token: "app1", mode: "open", updated_at: 3000, content_type: "text/html" } as any;

  it("passes the user's HTML through byte-for-byte (no transform)", async () => {
    const original = "<!doctype html><html><head></head><body><p>Hello</p></body></html>";
    const body = await renderRawHtmlBody(new TextEncoder().encode(original), ROW).text();
    expect(body).toBe(original);
  });

  it("preserves invalid-UTF-8 bytes (no string round-trip)", async () => {
    // A non-UTF-8-safe byte in the user's payload must reach the response
    // bytes unchanged; a TextDecoder round-trip would replace it with U+FFFD.
    const head = new TextEncoder().encode("<!doctype html><html><body>");
    const tail = new TextEncoder().encode("</body></html>");
    const lonelyContinuation = new Uint8Array([0xc3, 0x28]); // invalid UTF-8
    const bytes = new Uint8Array(head.length + lonelyContinuation.length + tail.length);
    bytes.set(head, 0);
    bytes.set(lonelyContinuation, head.length);
    bytes.set(tail, head.length + lonelyContinuation.length);

    const out = new Uint8Array(await renderRawHtmlBody(bytes, ROW).arrayBuffer());
    let found = false;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === 0xc3 && out[i + 1] === 0x28) { found = true; break; }
    }
    expect(found).toBe(true);
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
