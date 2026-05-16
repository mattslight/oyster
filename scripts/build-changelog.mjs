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

// `\/(?!\/)` allows `/path` (same-origin) but rejects `//evil.com` (protocol-relative).
// `\.\.?\/` covers `./` and `../`. Trim leading whitespace before testing so
// a href like `\tjavascript:...` can't sneak past the scheme check.
const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\.\.?\/|\/(?!\/))/i;
const safeHref = (href) => {
  if (!href) return "#";
  const trimmed = String(href).trim();
  return SAFE_URL.test(trimmed) ? trimmed : "#";
};

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

const REPO_URL = "https://github.com/oyster-to/oyster";
const H2_VERSION_RE =
  /<h2[^>]*>(?:<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>|\[([^\]]+)\])(?:\s*-\s*([^<]+?))?<\/h2>/g;
// What counts as a real git-tag version. The `0.0.x` prototype heading
// isn't tagged, so we skip it when picking a compare base and don't try
// to link the heading itself.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

// Synthesize compare URLs from doc order for headings that lack a footer
// reference in CHANGELOG.md. The Unreleased footer ref pointed at
// `v0.7.0...HEAD` and drifted every release since 0.7.0 (#440); release-
// version footer refs stopped being added at 0.8.0, leaving every newer
// release heading as plain text on docs/changelog.html (#444). Synthesis
// covers the gap so docs/changelog.html always links; we still honour the
// existing footer refs for 0.7.0 and below so GitHub's CHANGELOG.md view
// keeps its links too. One pre-scan in doc order (newest first) gives us:
//   • Unreleased's compare base = the newest real-tag version
//   • each release's compare base = the next real-tag version below it
// For the very first taggable version (no older entry), link to the tag
// itself, matching the footer pattern that used to exist for [0.1.10].
const orderedVersions = [];
for (const m of rawRendered.matchAll(H2_VERSION_RE)) {
  const v = m[2] || m[3];
  if (v) orderedVersions.push(v);
}
const taggedVersions = orderedVersions.filter(
  (v) => v !== "Unreleased" && SEMVER_RE.test(v),
);
const unreleasedCompareUrl = taggedVersions.length
  ? `${REPO_URL}/compare/v${taggedVersions[0]}...HEAD`
  : null;
const previousTagged = new Map();
for (let i = 0; i < taggedVersions.length - 1; i++) {
  previousTagged.set(taggedVersions[i], taggedVersions[i + 1]);
}

function synthesizedHrefFor(version) {
  if (version === "Unreleased") return unreleasedCompareUrl;
  if (!SEMVER_RE.test(version)) return null;
  const prev = previousTagged.get(version);
  return prev
    ? `${REPO_URL}/compare/v${prev}...v${version}`
    : `${REPO_URL}/releases/tag/v${version}`;
}

// Single pass: marked may render `[X.Y.Z]` as either a reference-link (when
// CHANGELOG.md has a footer def for it) or plain brackets (no def). Match
// both forms in one regex so releases stay in document order. For Unreleased
// we always override any footer reference with the synthesized URL because
// the footer can't track HEAD. For released versions we prefer the footer
// reference when present (keeps GitHub's CHANGELOG.md view linked exactly as
// before) and fall back to synthesis only when none exists.
// The `<h2[^>]*>` tolerates any attributes marked may emit in future versions.
// Captured values (version, rest, href) are escaped before interpolation.
const rendered = rawRendered.replace(
  H2_VERSION_RE,
  (_, linkedHref, linkedVersion, bracketVersion, rest) => {
    const version = linkedVersion || bracketVersion;
    const id = `v-${slug(version)}`;
    const versionSpan = `<span class="release-version">${escapeHtml(version)}</span>`;
    const resolvedHref =
      version === "Unreleased"
        ? synthesizedHrefFor(version)
        : linkedHref
          ? safeHref(linkedHref)
          : synthesizedHrefFor(version);
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

// Drop the Unreleased section entirely if there's no content between its h2
// and the next h2 — post-release, `[Unreleased]` sits empty in CHANGELOG.md
// until the next change lands, and we don't want to render a bare heading
// and pill for nothing.
const emptyUnreleasedRe = /<h2 id="v-unreleased">[\s\S]*?<\/h2>\s*(?=<h2 )/;
const unreleasedEmpty = emptyUnreleasedRe.test(rendered);
const cleanedRendered = unreleasedEmpty ? rendered.replace(emptyUnreleasedRe, "") : rendered;

// Group pills by minor version (0.3.4 → 0.3) so the nav stays flat as patches
// accumulate. Releases are already in reverse-chrono order, so the first entry
// per minor is the newest patch — that's where the pill links to.
const pillGroups = [];
const seen = new Set();
for (const r of releases) {
  if (r.version === "Unreleased" && unreleasedEmpty) continue;
  const minor =
    r.version === "Unreleased"
      ? "Unreleased"
      : (r.version.match(/^(\d+\.\d+)/)?.[1] ?? r.version);
  if (seen.has(minor)) continue;
  seen.add(minor);
  pillGroups.push({ label: minor, id: r.id });
}

const pills = pillGroups
  .map(
    (g) =>
      `<a class="version-pill" href="#${escapeHtml(g.id)}">${escapeHtml(g.label)}</a>`,
  )
  .join("\n      ");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changelog — Oyster</title>
  <meta name="description" content="Every shipped change to Oyster, newest first.">
  <link rel="stylesheet" href="assets/oyster.css">
  <style>
    .hero {
      position: relative;
      z-index: 2;
      max-width: 880px;
      margin: 0 auto;
      padding: 160px 28px 0;
      text-align: center;
    }
    h1 {
      font-family: var(--sans);
      font-size: clamp(40px, 6.5vw, 88px);
      font-weight: 800;
      line-height: 0.98;
      letter-spacing: -0.04em;
      color: var(--ink);
      margin-bottom: 22px;
    }
    h1 .accent {
      font-family: var(--serif);
      font-style: italic;
      font-weight: 400;
      letter-spacing: -0.005em;
      background: linear-gradient(180deg, #fff 0%, var(--accent-2) 50%, var(--signal) 100%);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 18px;
      line-height: 1.55;
      color: var(--ink-2);
      max-width: 540px;
      margin: 0 auto;
      letter-spacing: -0.005em;
    }

    .version-pills {
      position: relative;
      z-index: 2;
      max-width: 820px;
      margin: 56px auto 0;
      padding: 0 28px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
    }
    .version-pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.06em;
      color: var(--ink-3);
      background: rgba(20, 23, 44, 0.6);
      border: 1px solid rgba(139, 118, 255, 0.16);
      border-radius: 9999px;
      text-decoration: none;
      transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.15s;
    }
    .version-pill:hover {
      color: var(--ink);
      border-color: rgba(139, 118, 255, 0.45);
      background: rgba(139, 118, 255, 0.14);
      transform: translateY(-1px);
    }

    .entries {
      position: relative;
      z-index: 2;
      max-width: 760px;
      margin: 0 auto;
      padding: 56px 28px 120px;
    }
    .entries h2 {
      display: flex;
      align-items: baseline;
      gap: 14px;
      flex-wrap: wrap;
      margin: 72px 0 26px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(139, 118, 255, 0.20);
      scroll-margin-top: 80px;
    }
    .entries h2:first-child { margin-top: 0; }
    .release-version {
      font-family: var(--sans);
      font-size: 32px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.025em;
      line-height: 1.05;
    }
    .release-version-link {
      text-decoration: none;
      border-bottom: 0 !important;
      transition: opacity 0.15s;
    }
    .release-version-link:hover .release-version {
      color: var(--accent-2);
    }
    .release-date {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent-2);
    }
    .entries h3 {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--star);
      margin: 32px 0 14px;
    }
    .entries h4 {
      font-family: var(--sans);
      font-size: 17px;
      font-weight: 600;
      color: var(--ink);
      margin: 22px 0 8px;
      letter-spacing: -0.01em;
    }
    .entries p {
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.65;
      color: var(--ink-2);
      margin-bottom: 10px;
      letter-spacing: -0.005em;
    }
    .entries ul {
      list-style: none;
      padding: 0;
      margin: 0 0 18px;
    }
    .entries li {
      position: relative;
      padding-left: 20px;
      margin-bottom: 8px;
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.6;
      color: var(--ink-2);
      letter-spacing: -0.005em;
    }
    .entries li::before {
      content: "";
      position: absolute;
      left: 4px;
      top: 10px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.7;
    }
    .entries li > ul { margin: 8px 0 0; }
    .entries strong {
      color: var(--ink);
      font-weight: 600;
    }
    .entries code {
      font-family: var(--mono);
      font-size: 13px;
      background: rgba(139, 118, 255, 0.12);
      color: var(--accent-2);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .entries a {
      color: var(--accent-2);
      text-decoration: none;
      border-bottom: 1px dotted rgba(169, 158, 255, 0.4);
    }
    .entries a:hover { color: var(--ink); border-bottom-color: var(--ink); }

    .install-section {
      position: relative;
      z-index: 2;
      max-width: 640px;
      margin: 0 auto;
      padding: 0 28px 80px;
      text-align: center;
    }
    .install-label {
      font-family: var(--sans);
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin-bottom: 24px;
    }
    .terminal-frame {
      position: relative;
      max-width: 480px;
      margin: 0 auto;
      isolation: isolate;
    }
    .terminal-frame::before {
      content: '';
      position: absolute;
      inset: -30px -40px;
      background:
        radial-gradient(ellipse 60% 60% at 50% 100%, rgba(139, 118, 255, 0.45) 0%, transparent 65%),
        radial-gradient(ellipse 50% 50% at 50% 0%, rgba(123, 231, 255, 0.20) 0%, transparent 65%);
      filter: blur(36px);
      z-index: -1;
      pointer-events: none;
    }
    .terminal {
      background: rgba(13, 16, 36, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
      overflow: hidden;
      backdrop-filter: blur(14px);
      text-align: left;
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      position: relative;
    }
    .terminal-dots { display: flex; gap: 6px; }
    .terminal-dots span { width: 10px; height: 10px; border-radius: 50%; }
    .terminal-title {
      position: absolute; left: 0; right: 0; text-align: center;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-4);
      letter-spacing: 0.06em;
      pointer-events: none;
    }
    .terminal-body {
      padding: 22px 24px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .terminal-line .prompt { color: var(--ink-4); font-family: var(--mono); font-size: 14px; }
    .terminal-line code {
      font-family: var(--mono);
      font-size: clamp(15px, 2.2vw, 18px);
      color: var(--accent-2);
      background: none;
      padding: 0;
    }

    @media (max-width: 600px) {
      .hero { padding-top: 110px; }
      .entries { padding-top: 40px; }
    }
  </style>
</head>
<body>
  <div class="cosmos" aria-hidden="true">
    <div class="stars stars-far" id="stars-far"></div>
    <div class="stars stars-near" id="stars-near"></div>
  </div>

  <nav class="nav">
    <a href="/"><img src="logo.png" alt="Oyster" class="nav-logo" /></a>
    <a href="/#install">Install</a>
    <a href="/plugins">Plugins</a>
    <a href="/pricing">Pricing</a>
    <a href="/changelog" class="active">Changelog</a>
  </nav>

  <section class="hero">
    <h1><span class="accent">Every</span> shipped change.</h1>
    <p class="subtitle">Newest first. The full release log of what's shipping in Oyster.</p>
  </section>

  <nav class="version-pills" aria-label="Jump to version">
      ${pills}
  </nav>

  <main class="entries">
${cleanedRendered}
  </main>

  <section class="install-section">
    <div class="install-label">Don't have Oyster yet?</div>
    <div class="terminal-frame">
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
  </section>

  <div class="site-footer">
    <p>Built with <span class="heart">&hearts;</span> by <a href="https://github.com/mattslight">Matthew Slight</a></p>
  </div>

  <script>
    (function () {
      function seed(s) { return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
      const rand = seed(42);
      function makeStars(el, count, twinkle) {
        if (!el) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
          const d = document.createElement('div');
          d.style.left = (rand() * 100).toFixed(2) + '%';
          d.style.top = (rand() * 100).toFixed(2) + '%';
          if (twinkle && rand() < 0.18) {
            d.classList.add('star-twinkle');
            d.style.setProperty('--dur', (2.5 + rand() * 4).toFixed(2) + 's');
            d.style.setProperty('--delay', (rand() * 5).toFixed(2) + 's');
          }
          frag.appendChild(d);
        }
        el.appendChild(frag);
      }
      makeStars(document.getElementById('stars-far'), 80, false);
      makeStars(document.getElementById('stars-near'), 22, true);
    })();
  </script>
</body>
</html>
`;

fs.writeFileSync(outPath, html);
console.log(`wrote ${path.relative(root, outPath)}`);
