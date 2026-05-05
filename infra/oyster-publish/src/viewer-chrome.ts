// Chrome wrapper for successful published views.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Chrome).
// No top header — content fills from the top of the viewport.
// Bottom strip carries the brand on the left and (mode-aware) CTA on the
// right, in oyster brand purple. Used for:
//   - open viewer (action: "Publish AI content with oyster.to")
//   - password viewer post-unlock (action: same)
//   - signin viewer post-auth (action: omitted)

export interface ChromeOpts {
  title: string;
  bodyHtml: string;
  cssExtra?: string;        // e.g. iframe sizing override
  showActionSlot?: boolean; // default true; password viewer + open viewer get true; signin viewer gets false
}

export function renderChromePage(opts: ChromeOpts): string {
  const action = opts.showActionSlot === false
    ? `<span></span>` // keeps space-between balance when CTA hidden
    : `<a class="cta" href="https://oyster.to" target="_blank" rel="noopener"><span class="cta-text">Publish AI content with oyster.to</span><span class="cta-text-short">Publish with oyster.to</span></a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&display=swap">
<style>
  :root {
    color-scheme: light dark;
    --fg: #111;
    --bd: rgba(124, 107, 255, 0.18);
    --bg: #fff;
    --chrome-bg: #ffffff;
    --accent: #7c6bff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f4f4f5;
      --bd: rgba(169, 158, 255, 0.22);
      --bg: #0a0b14;
      --chrome-bg: #0d0e1a;
      --accent: #a99eff;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  main { flex: 1; padding: 1.5rem; max-width: 48rem; width: 100%; margin: 0 auto; }

  footer {
    flex-shrink: 0;
    background: var(--chrome-bg);
    border-top: 1px solid var(--bd);
    padding: 0.6rem 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    height: 44px;
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 500;
    line-height: 1;
  }
  footer .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--accent);
    text-decoration: none;
  }
  footer .brand:hover { text-decoration: underline; }
  footer .brand-mark {
    width: 18px;
    height: 18px;
    display: block;
    flex-shrink: 0;
  }
  footer .brand-name { font-weight: 600; }
  footer .cta {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    white-space: nowrap;
  }
  footer .cta:hover { text-decoration: underline; }
  footer .cta-text-short { display: none; }

  @media (max-width: 540px) {
    footer { padding: 0.55rem 0.9rem; height: 40px; font-size: 0.8rem; gap: 0.5rem; }
    footer .brand-name { display: none; }
    footer .cta-text { display: none; }
    footer .cta-text-short { display: inline; }
  }

  ${opts.cssExtra ?? ""}
</style>
</head><body>
<main>${opts.bodyHtml}</main>
<footer>
  <a class="brand" href="https://oyster.to" target="_blank" rel="noopener" aria-label="Oyster">
    <img class="brand-mark" src="https://oyster.to/logo.png" alt="" width="18" height="18">
    <span class="brand-name">Oyster</span>
  </a>
  ${action}
</footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
