import { marked } from "marked";

// ── Markdown ──

const MD_STYLES = `
body { font-family: 'Space Grotesk', -apple-system, sans-serif; padding: 2.5rem; max-width: 72ch; margin: 0 auto; background: #1a1b2e; color: #e8e9f0; line-height: 1.7; }
h1, h2, h3 { color: #fff; font-weight: 600; letter-spacing: -0.02em; }
h1 { font-size: 1.8rem; margin-top: 0; }
h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.4rem; }
a { color: #21b981; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: rgba(255,255,255,0.06); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; font-family: 'IBM Plex Mono', monospace; }
pre { background: rgba(255,255,255,0.04); padding: 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); }
th { color: rgba(232,233,240,0.6); font-weight: 500; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; }
blockquote { border-left: 3px solid #21b981; margin: 1rem 0; padding: 0.5rem 1rem; color: rgba(232,233,240,0.7); }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.3rem 0; }
`.trim();

export function renderMarkdown(name: string, content: string): string {
  const rendered = marked(content);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>\n${MD_STYLES}\n</style></head><body>${rendered}</body></html>`;
}

// ── Mermaid ──

export function normalizeMermaidSource(content: string): string {
  let normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  // Strip YAML frontmatter (--- ... ---), allowing leading whitespace and CRLF input.
  normalized = normalized.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");

  // Unwrap markdown fenced blocks
  const fenced = normalized.match(/^\s*```mermaid\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) {
    normalized = fenced[1];
  }

  // Some diagrams are stored inside a fenced block that itself contains frontmatter.
  normalized = normalized.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");

  // Strip leading %% comment lines before the diagram type declaration.
  // Mermaid v11 can misparse %% comments that precede the diagram keyword.
  normalized = normalized.replace(/^(\s*%%[^\n]*\n)+/, "");

  return normalized.trim();
}

export function renderMermaid(name: string, content: string): string {
  const normalized = normalizeMermaidSource(content);
  const escaped = normalized.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
#container { width: 100%; height: 100%; cursor: grab; visibility: hidden; }
#container.ready { visibility: visible; }
#container:active { cursor: grabbing; }
#container .mermaid svg { display: block; }
#raw-view {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: #1e1e2e; overflow: auto;
}
#raw-view pre {
  margin: 0; padding: 24px; color: #cdd6f4; font: 13px/1.6 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
  white-space: pre-wrap; word-wrap: break-word;
}
#raw-view .copy-btn {
  position: fixed; top: 16px; right: 16px; z-index: 201;
  padding: 6px 14px; border: none; border-radius: 6px;
  background: rgba(255,255,255,0.12); color: #cdd6f4;
  font: 13px/1 system-ui; cursor: pointer;
}
#raw-view .copy-btn:hover { background: rgba(255,255,255,0.2); }
.controls {
  position: fixed; bottom: 20px; right: 20px; display: flex; gap: 4px;
  background: rgba(0,0,0,0.7); border-radius: 8px; padding: 4px; z-index: 100;
}
.controls button {
  width: 32px; height: 32px; border: none; background: transparent;
  color: #fff; font-size: 18px; cursor: pointer; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
}
.controls button:hover { background: rgba(255,255,255,0.15); }
.controls .raw-toggle {
  width: auto; padding: 0 10px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.controls .divider { width: 1px; background: rgba(255,255,255,0.2); margin: 4px 2px; }
</style>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import panzoom from 'https://cdn.jsdelivr.net/npm/panzoom@9.4.3/+esm';

mermaid.initialize({ startOnLoad: false, theme: 'default' });

const el = document.querySelector('.mermaid');
const rawSource = el.textContent.trim();
const { svg } = await mermaid.render('diagram', rawSource);
el.innerHTML = svg;

const container = document.getElementById('container');
const svgEl = el.querySelector('svg');

if (svgEl) {
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.style.width = 'max-content';
  svgEl.style.height = 'max-content';
}

const pz = panzoom(container, { smoothScroll: false, zoomDoubleClickSpeed: 1 });

function fitToScreen() {
  if (!svgEl) return;
  const pad = 40;
  const vw = window.innerWidth - pad * 2;
  const vh = window.innerHeight - pad * 2;
  const rect = svgEl.getBoundingClientRect();
  const t = pz.getTransform();
  const sw = rect.width / t.scale;
  const sh = rect.height / t.scale;
  const scale = Math.min(vw / sw, vh / sh);
  const cx = (window.innerWidth - sw * scale) / 2;
  const cy = (window.innerHeight - sh * scale) / 2;
  pz.zoomAbs(0, 0, scale);
  pz.moveTo(cx, cy);
}

fitToScreen();
container.classList.add('ready');

document.getElementById('zoom-in').onclick = () => pz.smoothZoom(window.innerWidth/2, window.innerHeight/2, 1.3);
document.getElementById('zoom-out').onclick = () => pz.smoothZoom(window.innerWidth/2, window.innerHeight/2, 0.7);
document.getElementById('zoom-fit').onclick = fitToScreen;

// Raw toggle
const rawView = document.getElementById('raw-view');
const rawPre = document.getElementById('raw-source');
const rawToggle = document.getElementById('raw-toggle');
const copyBtn = document.getElementById('copy-btn');
rawPre.textContent = rawSource;
let showingRaw = false;

rawToggle.onclick = () => {
  showingRaw = !showingRaw;
  rawView.style.display = showingRaw ? 'block' : 'none';
  rawToggle.textContent = showingRaw ? 'Diagram' : 'Raw';
};

copyBtn.onclick = () => {
  navigator.clipboard.writeText(rawSource).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy', 1500);
  });
};
</script>
</head>
<body>
<div id="container">
<pre class="mermaid">
${escaped}
</pre>
</div>
<div id="raw-view">
  <button class="copy-btn" id="copy-btn">Copy</button>
  <pre id="raw-source"></pre>
</div>
<div class="controls">
  <button id="raw-toggle" class="raw-toggle" title="Toggle raw source">Raw</button>
  <div class="divider"></div>
  <button id="zoom-in" title="Zoom in">+</button>
  <button id="zoom-out" title="Zoom out">&minus;</button>
  <button id="zoom-fit" title="Fit to screen">&#x2922;</button>
</div>
</body>
</html>`;
}
