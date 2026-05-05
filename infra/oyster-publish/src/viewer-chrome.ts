// Chrome wrapper for successful published views.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Chrome).
// Dark-mode brand surface (matches oyster.to and the Oyster app):
// navy background with subtle purple gradient bloom, light copy in
// Space Grotesk, brand-purple accent on links. Bottom strip carries
// the Oyster brand mark on the left and (mode-aware) CTA on the right.
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@600;700&family=Space+Grotesk:wght@400;500;600&display=swap">
<style>
  :root {
    color-scheme: dark;
    --fg: #e6e6ea;
    --fg-strong: #fff;
    --muted: #9d9da8;
    --bd: rgba(169, 158, 255, 0.16);
    --bg: #0a0b14;
    --chrome-bg: rgba(13, 14, 26, 0.85);
    --accent: #a99eff;
    --accent-hover: #c1b8ff;
    --code-bg: rgba(124, 107, 255, 0.14);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--fg);
    background:
      radial-gradient(ellipse at 30% 20%, rgba(88, 60, 180, 0.22) 0%, transparent 55%),
      radial-gradient(ellipse at 70% 80%, rgba(40, 50, 160, 0.18) 0%, transparent 55%),
      var(--bg);
    background-attachment: fixed;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  main { flex: 1; padding: 2rem 1.5rem; max-width: 48rem; width: 100%; margin: 0 auto; }

  /* Markdown content typography on the dark surface */
  main h1, main h2, main h3, main h4 {
    font-family: 'Barlow', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: var(--fg-strong);
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.01em;
    margin: 1.6em 0 0.5em;
  }
  main h1 { font-size: 2rem; margin-top: 0.2em; }
  main h2 { font-size: 1.45rem; }
  main h3 { font-size: 1.15rem; }
  main p, main li { color: var(--fg); }
  main a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(169, 158, 255, 0.35); }
  main a:hover { color: var(--accent-hover); border-bottom-color: var(--accent-hover); }
  main code { background: var(--code-bg); color: var(--accent); padding: 0.12em 0.4em; border-radius: 4px; font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  main pre { background: rgba(255, 255, 255, 0.04); border: 1px solid var(--bd); border-radius: 10px; padding: 1rem 1.1rem; overflow-x: auto; line-height: 1.5; }
  main pre code { background: transparent; color: var(--fg); padding: 0; border-radius: 0; }
  main blockquote { border-left: 3px solid var(--accent); margin: 1em 0; padding: 0.2em 0 0.2em 1em; color: var(--muted); }
  main hr { border: 0; border-top: 1px solid var(--bd); margin: 2em 0; }
  main img { max-width: 100%; border-radius: 8px; }
  main table { border-collapse: collapse; width: 100%; }
  main th, main td { border: 1px solid var(--bd); padding: 0.5em 0.75em; text-align: left; }
  main th { background: rgba(255, 255, 255, 0.03); font-weight: 600; }

  footer {
    flex-shrink: 0;
    background: var(--chrome-bg);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border-top: 1px solid var(--bd);
    padding: 0.6rem 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    height: 48px;
    font-size: 0.85rem;
    line-height: 1;
  }
  footer .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--accent);
    text-decoration: none;
    transition: color 0.15s ease;
  }
  footer .brand:hover { color: var(--accent-hover); }
  footer .brand-mark {
    width: 20px;
    height: 20px;
    display: block;
    flex-shrink: 0;
  }
  footer .brand-name {
    font-family: 'Barlow', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-weight: 700;
    font-size: 0.95rem;
    letter-spacing: -0.005em;
  }
  footer .cta {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    white-space: nowrap;
    transition: color 0.15s ease;
  }
  footer .cta:hover { color: var(--accent-hover); }
  footer .cta-text-short { display: none; }

  @media (max-width: 540px) {
    main { padding: 1.5rem 1rem; }
    main h1 { font-size: 1.65rem; }
    footer { padding: 0.55rem 0.9rem; height: 44px; font-size: 0.8rem; gap: 0.5rem; }
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
    <img class="brand-mark" src="https://oyster.to/logo.png" alt="" width="20" height="20">
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
