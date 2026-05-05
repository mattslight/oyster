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
    : `<a class="cta" href="https://oyster.to" target="_blank" rel="noopener"><span class="cta-text">Publish AI content with oyster.to</span><span class="cta-text-short">Publish with oyster.to</span><span class="cta-arrow" aria-hidden="true">→</span></a>`;
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
    --chrome-bg: rgba(255, 255, 255, 0.85);
    --chrome-accent: rgba(124, 107, 255, 0.06);
    --accent: #7c6bff;
    --accent-fg: #fff;
    --accent-hover: #6a58ff;
    --shadow: 0 1px 0 rgba(17, 17, 17, 0.04), 0 8px 24px rgba(124, 107, 255, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f4f4f5;
      --muted: #a1a1aa;
      --bd: rgba(255, 255, 255, 0.08);
      --bg: #0a0b14;
      --chrome-bg: rgba(13, 14, 26, 0.85);
      --chrome-accent: rgba(124, 107, 255, 0.12);
      --accent: #7c6bff;
      --accent-fg: #fff;
      --accent-hover: #8d7eff;
      --shadow: 0 1px 0 rgba(0, 0, 0, 0.4), 0 8px 32px rgba(124, 107, 255, 0.18);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 1.1rem;
    height: 48px;
    flex-shrink: 0;
    background:
      linear-gradient(180deg, var(--chrome-bg) 0%, var(--chrome-bg) 100%),
      radial-gradient(ellipse at 0% 50%, var(--chrome-accent) 0%, transparent 60%);
    background-color: var(--chrome-bg);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border-bottom: 1px solid var(--bd);
    position: relative;
    z-index: 2;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: linear-gradient(135deg, #7c6bff 0%, #a99eff 100%);
    color: #fff;
    font-size: 0.95rem;
    box-shadow: 0 2px 8px rgba(124, 107, 255, 0.35);
    flex-shrink: 0;
  }
  header .brand-name { font-family: 'Barlow', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-weight: 700; font-size: 1rem; }

  header .cta {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.42rem 0.95rem;
    border-radius: 9999px;
    background: var(--accent);
    color: var(--accent-fg);
    text-decoration: none;
    font-size: 0.82rem;
    font-weight: 500;
    letter-spacing: -0.005em;
    box-shadow: var(--shadow);
    transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
    white-space: nowrap;
  }
  header .cta:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(124, 107, 255, 0.35);
  }
  header .cta:active { transform: translateY(0); }
  header .cta-arrow {
    display: inline-block;
    transition: transform 0.15s ease;
  }
  header .cta:hover .cta-arrow { transform: translateX(2px); }
  header .cta-text-short { display: none; }

  @media (max-width: 540px) {
    header { padding: 0.5rem 0.75rem; height: 44px; }
    header .brand-name { display: none; }
    header .cta { padding: 0.38rem 0.8rem; font-size: 0.78rem; }
    header .cta-text { display: none; }
    header .cta-text-short { display: inline; }
  }

  main { flex: 1; padding: 1.5rem; max-width: 48rem; width: 100%; margin: 0 auto; }

  footer {
    flex-shrink: 0;
    background: var(--chrome-bg);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border-top: 1px solid var(--bd);
    padding: 0.5rem 1rem;
    text-align: center;
    font-size: 0.72rem;
    letter-spacing: 0.01em;
    color: var(--muted);
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
  }
  footer a { color: var(--muted); text-decoration: none; transition: color 0.15s ease; }
  footer a:hover { color: var(--fg); }
  footer .dot { opacity: 0.5; }

  ${opts.cssExtra ?? ""}
</style>
</head><body>
<header>
  <a class="brand" href="https://oyster.to" target="_blank" rel="noopener">
    <span class="brand-mark" aria-hidden="true">🦪</span>
    <span class="brand-name">oyster</span>
  </a>
  ${action}
</header>
<main>${opts.bodyHtml}</main>
<footer><span>Powered by</span> <a href="https://oyster.to" target="_blank" rel="noopener">Oyster</a> <span class="dot">·</span> <a href="https://oyster.to" target="_blank" rel="noopener">oyster.to</a></footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
