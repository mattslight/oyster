// Chrome wrapper for successful published views.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Chrome).
// Header (logo + mode-aware action slot) + body slot + footer. Used for:
//   - open viewer (action: "Publish AI content with oyster.to")
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
    : `<a class="cta" href="https://oyster.to" target="_blank" rel="noopener"><span class="cta-text">Publish AI content with oyster.to</span><span class="cta-text-short">Publish with oyster.to</span></a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #111;
    --muted: #6b6b75;
    --bd: rgba(17, 17, 17, 0.08);
    --bg: #fff;
    --chrome-bg: #ffffff;
    --accent: #7c6bff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f4f4f5;
      --muted: #a1a1aa;
      --bd: rgba(255, 255, 255, 0.08);
      --bg: #0a0b14;
      --chrome-bg: #0d0e1a;
      --accent: #a99eff;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  header, footer {
    flex-shrink: 0;
    background: var(--chrome-bg);
    padding: 0.55rem 1.1rem;
    display: flex;
    align-items: center;
  }
  header {
    justify-content: space-between;
    gap: 1rem;
    height: 48px;
    border-bottom: 1px solid var(--bd);
  }
  footer {
    justify-content: center;
    gap: 0.4rem;
    height: 36px;
    border-top: 1px solid var(--bd);
    font-size: 0.78rem;
    color: var(--muted);
    line-height: 1;
  }

  header .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--fg);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.95rem;
    letter-spacing: -0.01em;
  }
  header .brand-mark {
    width: 26px;
    height: 26px;
    display: block;
    flex-shrink: 0;
  }
  header .brand-name {
    font-weight: 700;
    font-size: 1rem;
  }

  header .cta {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    letter-spacing: -0.005em;
    white-space: nowrap;
  }
  header .cta:hover { text-decoration: underline; }
  header .cta-text-short { display: none; }

  @media (max-width: 540px) {
    header { padding: 0.5rem 0.85rem; height: 44px; }
    footer { padding: 0.5rem 0.85rem; height: 32px; font-size: 0.72rem; }
    header .brand-name { display: none; }
    header .cta { font-size: 0.8rem; }
    header .cta-text { display: none; }
    header .cta-text-short { display: inline; }
  }

  main { flex: 1; padding: 1.5rem; max-width: 48rem; width: 100%; margin: 0 auto; }

  footer .footer-mark {
    width: 14px;
    height: 14px;
    display: block;
    flex-shrink: 0;
    opacity: 0.85;
  }
  footer a {
    color: var(--muted);
    text-decoration: none;
    transition: color 0.15s ease;
  }
  footer a:hover { color: var(--fg); }

  ${opts.cssExtra ?? ""}
</style>
</head><body>
<header>
  <a class="brand" href="https://oyster.to" target="_blank" rel="noopener" aria-label="Oyster">
    <img class="brand-mark" src="https://oyster.to/logo.png" alt="" width="26" height="26">
    <span class="brand-name">oyster</span>
  </a>
  ${action}
</header>
<main>${opts.bodyHtml}</main>
<footer>
  <img class="footer-mark" src="https://oyster.to/logo.png" alt="" width="14" height="14" aria-hidden="true">
  <span>Powered by <a href="https://oyster.to" target="_blank" rel="noopener">Oyster</a> · <a href="https://oyster.to" target="_blank" rel="noopener">oyster.to</a></span>
</footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
