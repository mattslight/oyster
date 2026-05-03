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

  return new Response(page, {
    status: 200,
    headers: cacheHeaders(row, "text/html; charset=utf-8"),
  });
}

// ─── Cache headers ─────────────────────────────────────────────────────────

export function cacheHeaders(row: PublicationRow, contentType: string): HeadersInit {
  const headers: Record<string, string> = { "content-type": contentType };
  if (row.mode === "open") {
    headers["cache-control"] = "public, max-age=60, must-revalidate";
    headers["etag"] = `W/"${row.share_token}-${row.updated_at}"`;
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
