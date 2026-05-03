// Tiny MIME map shared by the static route module (file serving for /docs
// and /artifacts) and the SPA fallback in index.ts. Single source of truth
// so adding a new content type doesn't require touching two places.

export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/html",
  ".mmd": "text/html",
  ".mermaid": "text/html",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
