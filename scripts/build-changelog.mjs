#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mdPath = path.join(root, "CHANGELOG.md");
const outPath = path.join(root, "docs", "changelog.html");

// This page is built from CHANGELOG.md which is edited in PRs and published to
// oyster.to, so anything exploitable there ships as stored XSS. Defense:
//   1. Escape `&<>"'` everywhere we inject strings into the template.
//   2. Render raw HTML tokens as escaped text (no pass-through).
//   3. Allow only safe URL protocols on links and images.
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const safeHref = (href) => (href && SAFE_URL.test(href) ? href : "#");

marked.use({
  renderer: {
    // Block + inline html tokens both route here in marked v12+.
    html({ text, raw }) {
      return escapeHtml(text ?? raw ?? "");
    },
    link({ href, title, tokens }) {
      const resolved = safeHref(href);
      const url = escapeHtml(resolved);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      const relAttr = /^https?:/i.test(resolved) ? ' rel="noopener noreferrer"' : "";
      const inner = this.parser.parseInline(tokens);
      return `<a href="${url}"${titleAttr}${relAttr}>${inner}</a>`;
    },
    image({ href, title, text }) {
      if (!href || !SAFE_URL.test(href)) return escapeHtml(`[image: ${text ?? ""}]`);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text ?? "")}"${titleAttr}>`;
    },
  },
});

const md = fs.readFileSync(mdPath, "utf8");
// Strip the title + lead paragraph; the template owns the hero.
const body = md.replace(/^#\s+Changelog[\s\S]*?\n## /m, "## ");
const rawRendered = marked.parse(body, { gfm: true });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Match: <h2>[Version]</h2>, <h2>[Version] - YYYY-MM-DD</h2>, <h2>[Version] - Prototype (...)</h2>
// Marked may render `[X.Y.Z]` as a reference link if it parses as a shortcut reference.
// We post-process both the raw-bracket form and the link-rendered form.
const releases = [];

// Single pass: marked renders `[Unreleased]` as a reference-link (because of the
// compare-link footer defining it) and `[0.0.x]` as plain brackets (no matching
// definition). Match both forms in one regex so releases stay in document order.
// The `<h2[^>]*>` tolerates any attributes marked may emit in future versions.
// Captured values (version, rest, href) are escaped before interpolation.
const rendered = rawRendered.replace(
  /<h2[^>]*>(?:<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>|\[([^\]]+)\])(?:\s*-\s*([^<]+?))?<\/h2>/g,
  (_, linkedHref, linkedVersion, bracketVersion, rest) => {
    const version = linkedVersion || bracketVersion;
    const id = `v-${slug(version)}`;
    const versionSpan = `<span class="release-version">${escapeHtml(version)}</span>`;
    const resolvedHref = linkedHref ? safeHref(linkedHref) : null;
    const relAttr = resolvedHref && /^https?:/i.test(resolvedHref) ? ' rel="noopener noreferrer"' : "";
    const versionHtml = resolvedHref
      ? `<a class="release-version-link" href="${escapeHtml(resolvedHref)}"${relAttr}>${versionSpan}</a>`
      : versionSpan;
    const suffix = rest
      ? `<span class="release-date"> — ${escapeHtml(rest.trim())}</span>`
      : "";
    releases.push({ version, id });
    return `<h2 id="${escapeHtml(id)}">${versionHtml}${suffix}</h2>`;
  },
);

const pills = releases
  .map(
    (r) =>
      `<a class="version-pill" href="#${escapeHtml(r.id)}">${escapeHtml(r.version)}</a>`,
  )
  .join("\n      ");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changelog — Oyster</title>
  <meta name="description" content="Every shipped change to Oyster, newest first.">
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: 24px; }
    body {
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0b14;
      color: #e0e0e0;
      min-height: 100vh;
      overflow-x: hidden;
    }
    .bg {
      position: fixed;
      inset: 0;
      background: radial-gradient(ellipse at 30% 20%, rgba(88, 60, 180, 0.25) 0%, transparent 60%),
                  radial-gradient(ellipse at 70% 80%, rgba(40, 50, 160, 0.2) 0%, transparent 60%),
                  #0a0b14;
      z-index: 0;
    }
    .back-nav {
      position: fixed;
      top: 16px;
      left: 0;
      right: 0;
      z-index: 10;
      display: flex;
      justify-content: center;
    }
    .back-bar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 20px;
      background: rgba(20, 22, 40, 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 9999px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    }
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.5);
      text-decoration: none;
      transition: color 0.15s;
    }
    .back-link:hover { color: #fff; }

    .hero {
      position: relative;
      z-index: 1;
      max-width: 820px;
      margin: 0 auto;
      padding: 120px 24px 0;
      text-align: center;
    }
    h1 {
      font-family: 'Barlow', sans-serif;
      font-size: clamp(32px, 5vw, 48px);
      font-weight: 700;
      line-height: 1.15;
      color: #fff;
      margin-bottom: 16px;
    }
    .subtitle {
      font-size: 18px;
      line-height: 1.7;
      color: rgba(255, 255, 255, 0.5);
      max-width: 560px;
      margin: 0 auto;
    }

    .version-pills {
      position: relative;
      z-index: 1;
      max-width: 820px;
      margin: 48px auto 0;
      padding: 0 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
    }
    .version-pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.55);
      background: rgba(20, 22, 40, 0.7);
      border: 1px solid rgba(124, 107, 255, 0.18);
      border-radius: 9999px;
      text-decoration: none;
      transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.15s;
    }
    .version-pill:hover {
      color: #fff;
      border-color: rgba(124, 107, 255, 0.45);
      background: rgba(124, 107, 255, 0.12);
      transform: translateY(-1px);
    }

    .entries {
      position: relative;
      z-index: 1;
      max-width: 760px;
      margin: 0 auto;
      padding: 48px 24px 120px;
    }
    .entries h2 {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
      margin: 64px 0 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(124, 107, 255, 0.18);
      scroll-margin-top: 24px;
    }
    .entries h2:first-child { margin-top: 0; }
    .release-version {
      font-family: 'Barlow', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.5px;
    }
    .release-version-link {
      text-decoration: none;
      border-bottom: 0 !important;
      transition: opacity 0.15s;
    }
    .release-version-link:hover .release-version {
      color: #a99eff;
    }
    .release-date {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(169, 158, 255, 0.7);
    }
    .entries h3 {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: rgba(169, 158, 255, 0.85);
      margin: 28px 0 12px;
    }
    .entries h4 {
      font-family: 'Barlow', sans-serif;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      margin: 20px 0 8px;
    }
    .entries p {
      font-size: 15px;
      line-height: 1.7;
      color: rgba(255, 255, 255, 0.62);
      margin-bottom: 10px;
    }
    .entries ul {
      list-style: none;
      padding: 0;
      margin: 0 0 16px;
    }
    .entries li {
      position: relative;
      padding-left: 20px;
      margin-bottom: 8px;
      font-size: 15px;
      line-height: 1.65;
      color: rgba(255, 255, 255, 0.62);
    }
    .entries li::before {
      content: "";
      position: absolute;
      left: 4px;
      top: 10px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba(124, 107, 255, 0.6);
    }
    .entries li > ul {
      margin: 8px 0 0;
    }
    .entries strong {
      color: rgba(255, 255, 255, 0.82);
      font-weight: 600;
    }
    .entries code {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      background: rgba(124, 107, 255, 0.1);
      color: #a99eff;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .entries a {
      color: #a99eff;
      text-decoration: none;
      border-bottom: 1px dotted rgba(169, 158, 255, 0.4);
    }
    .entries a:hover { color: #fff; border-bottom-color: #fff; }

    .install-section {
      position: relative;
      z-index: 1;
      max-width: 640px;
      margin: 0 auto;
      padding: 0 24px 100px;
      text-align: center;
    }
    .install-label {
      font-family: 'Barlow', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 24px;
    }
    .terminal {
      background: rgba(8, 9, 18, 0.95);
      border: 2px solid rgba(124, 107, 255, 0.14);
      border-radius: 12px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      overflow: hidden;
      text-align: left;
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: rgba(0, 0, 0, 0.25);
      position: relative;
    }
    .terminal-dots { display: flex; gap: 6px; }
    .terminal-dots span { width: 10px; height: 10px; border-radius: 50%; }
    .terminal-title {
      position: absolute; left: 0; right: 0; text-align: center;
      font-size: 11px; color: rgba(255,255,255,0.25);
      font-family: 'IBM Plex Mono', monospace; pointer-events: none;
    }
    .terminal-body {
      padding: 20px 24px 24px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .terminal-line .prompt { color: rgba(255,255,255,0.35); font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
    .terminal-line code {
      font-family: 'IBM Plex Mono', monospace;
      font-size: clamp(16px, 2.5vw, 20px);
      color: #a99eff;
      background: none;
      padding: 0;
    }

    .footer {
      position: relative;
      z-index: 1;
      text-align: center;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.3);
      padding: 0 24px 60px;
    }
    .footer .heart { color: #e25555; }
    .footer a { color: rgba(255, 255, 255, 0.4); text-decoration: none; }
    .footer a:hover { color: rgba(255, 255, 255, 0.6); }

    @media (max-width: 600px) {
      .hero { padding-top: 100px; }
      .entries { padding-top: 48px; }
    }
  </style>
</head>
<body>
  <div class="bg"></div>

  <div class="back-nav">
    <div class="back-bar">
      <a class="back-link" href="/">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
        </svg>
        oyster.to
      </a>
    </div>
  </div>

  <div class="hero">
    <h1>Changelog</h1>
    <p class="subtitle">Every shipped change, newest first.</p>
  </div>

  <nav class="version-pills" aria-label="Jump to version">
      ${pills}
  </nav>

  <main class="entries">
${rendered}
  </main>

  <div class="install-section">
    <div class="install-label">Don't have Oyster yet?</div>
    <div class="terminal">
      <div class="terminal-bar">
        <div class="terminal-dots">
          <span style="background: #ff5f57;"></span>
          <span style="background: #febc2e;"></span>
          <span style="background: #28c840;"></span>
        </div>
        <span class="terminal-title">terminal</span>
      </div>
      <div class="terminal-body">
        <div class="terminal-line"><span class="prompt">$ </span><code>npm install -g oyster-os</code></div>
        <div class="terminal-line"><span class="prompt">$ </span><code>oyster</code></div>
      </div>
    </div>
  </div>

  <div class="footer">
    <p>Built with <span class="heart">&hearts;</span> by <a href="https://github.com/mattslight">Matthew Slight</a></p>
  </div>
</body>
</html>
`;

fs.writeFileSync(outPath, html);
console.log(`wrote ${path.relative(root, outPath)}`);
