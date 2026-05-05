// Chrome wrapper for successful published views.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Chrome).
// Dark-mode brand surface (matches oyster.to and the Oyster app):
// navy background with subtle purple gradient bloom, light copy in
// Space Grotesk, brand-purple accent on links. Bottom strip is a
// single centered "Published with oyster.to" line with the brand
// mark — same on every mode (open / password post-unlock / signin
// post-auth).

export interface ChromeOpts {
  title: string;
  bodyHtml: string;
  cssExtra?: string;        // e.g. iframe sizing override
  showActionSlot?: boolean; // retained for caller compat; the footer copy is identical across modes now
}

export function renderChromePage(opts: ChromeOpts): string {
  void opts.showActionSlot; // accepted for back-compat; footer is mode-invariant in v2 chrome
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
    justify-content: center;
    gap: 0.55rem;
    height: 48px;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1;
  }
  footer .brand-mark {
    width: 18px;
    height: 18px;
    display: block;
    flex-shrink: 0;
  }
  footer a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
    transition: color 0.15s ease;
  }
  footer a:hover { color: var(--accent-hover); }

  @media (max-width: 540px) {
    main { padding: 1.5rem 1rem; }
    main h1 { font-size: 1.65rem; }
    footer { padding: 0.55rem 0.9rem; height: 44px; font-size: 0.8rem; }
  }

  ${opts.cssExtra ?? ""}
</style>
</head><body>
<main>${opts.bodyHtml}</main>
<footer>
  <img class="brand-mark" src="https://oyster.to/logo.png" alt="" width="18" height="18" aria-hidden="true">
  <span>Published with <a href="https://oyster.to" target="_blank" rel="noopener">oyster.to</a></span>
</footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
