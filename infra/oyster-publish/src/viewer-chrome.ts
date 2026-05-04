// Chrome wrapper for successful published views.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Chrome).
// Header (logo + mode-aware action slot) + body slot + footer. Used for:
//   - open viewer (action: "Get your own at oyster.to")
//   - password viewer post-unlock (action: same)
//   - signin viewer post-auth (action: empty in v1)
//
// `bodyHtml` is the rendered content (markdown HTML, mermaid HTML, or
// the iframe element). `bodyExtraStyle` is optional — used by the iframe
// path to remove default body padding.

export interface ChromeOpts {
  title: string;
  bodyHtml: string;
  cssExtra?: string;        // e.g. iframe sizing override
  showActionSlot?: boolean; // default true; password viewer + open viewer get true; signin viewer gets false
}

export function renderChromePage(opts: ChromeOpts): string {
  const action = opts.showActionSlot === false
    ? ""
    : `<a class="cta" href="https://oyster.to" target="_blank" rel="noopener">Get your own at oyster.to</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --bd: #e4e4e7; --bg: #fff; --chrome-bg: #fafafa; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f4f4f5; --muted: #a1a1aa; --bd: #27272a; --bg: #18181b; --chrome-bg: #0c0a09; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); display: flex; flex-direction: column; min-height: 100vh; line-height: 1.55; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 1rem; background: var(--chrome-bg); border-bottom: 1px solid var(--bd); font-size: 0.85rem; height: 36px; flex-shrink: 0; }
  header .logo { font-weight: 600; }
  header .cta { color: var(--muted); text-decoration: none; }
  header .cta:hover { color: var(--fg); }
  main { flex: 1; padding: 1.5rem; max-width: 48rem; width: 100%; margin: 0 auto; }
  footer { background: var(--chrome-bg); border-top: 1px solid var(--bd); font-size: 0.7rem; color: var(--muted); padding: 0.4rem 1rem; text-align: center; height: 24px; flex-shrink: 0; }
  ${opts.cssExtra ?? ""}
</style>
</head><body>
<header><span class="logo">🦪 oyster</span>${action}</header>
<main>${opts.bodyHtml}</main>
<footer>Powered by Oyster · oyster.to</footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
