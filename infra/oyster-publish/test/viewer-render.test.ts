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
    expect(res.headers.get("etag")).toMatch(/^W\/"abc-1000"$/);
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
