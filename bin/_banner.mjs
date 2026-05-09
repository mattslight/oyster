// Hero banner for the `oyster` CLI.
// Boxed + coloured so it doesn't get lost in scrolling server logs above
// and Node deprecation warnings below. Extracted into its own module so
// `scripts/preview-banner.mjs` can iterate every tip variant in dev.

// ANSI colour codes — no extra dep. `\x1b[95m` bright magenta (indigo-ish,
// Oyster's accent). `\x1b[1;96m` bold bright cyan, reserved for real,
// clickable URLs and copy-paste commands on the top line. `\x1b[38;5;238m`
// near-black grey via 256-colour palette — the logo's drop-shadow strokes,
// chosen for high contrast with the bright magenta fill so the letter
// outlines recede instead of competing with the body. `\x1b[90m` bright
// black (grey) for auxiliary text that shouldn't compete. `\x1b[3;38;5;245m`
// adds italic over a 256-colour medium grey; the centred tip uses it so
// it reads as a quiet aside but stays legible — bright-black was a touch
// too dim once the line was unpinned from the 💡 anchor.
const M = "\x1b[95m";
const MD = "\x1b[38;5;238m";
const C = "\x1b[1;96m";
const D = "\x1b[90m";
const T = "\x1b[3;38;5;245m";
const R = "\x1b[0m";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Available logo fonts. `ansiShadow` is shipped; the rest stay here so
// `scripts/preview-banner.mjs --fonts` can compare alternatives in dev.
// All glyphs are single-cell (`█`, box-drawing, ASCII slashes) — `.length`
// matches display width.
export const LOGO_FONTS = {
  ansiShadow: [
    ` ██████╗ ██╗   ██╗███████╗████████╗███████╗██████╗ `,
    `██╔═══██╗╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝██╔══██╗`,
    `██║   ██║ ╚████╔╝ ███████╗   ██║   █████╗  ██████╔╝`,
    `██║   ██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██╔══██╗`,
    `╚██████╔╝   ██║   ███████║   ██║   ███████╗██║  ██║`,
    ` ╚═════╝    ╚═╝   ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝`,
  ],
  slant: [
    `   ____             __           `,
    `  / __ \\__  _______/ /____  _____`,
    ` / / / / / / / ___/ __/ _ \\/ ___/`,
    `/ /_/ / /_/ (__  ) /_/  __/ /    `,
    `\\____/\\__, /____/\\__/\\___/_/     `,
    `     /____/                      `,
  ],
  small: [
    `   ___          _           `,
    `  / _ \\ _  _ __| |_ ___ _ _ `,
    ` | (_) | || (_-<  _/ -_) '_|`,
    `  \\___/ \\_, /__/\\__\\___|_|  `,
    `        |__/                `,
  ],
  standard: [
    `   ___            _            `,
    `  / _ \\ _   _ ___| |_ ___ _ __ `,
    ` | | | | | | / __| __/ _ \\ '__|`,
    ` | |_| | |_| \\__ \\ ||  __/ |   `,
    `  \\___/ \\__, |___/\\__\\___|_|   `,
    `        |___/                  `,
  ],
};

const DEFAULT_LOGO = LOGO_FONTS.ansiShadow;

// Two-tone colourise an ANSI Shadow line: full-block (`█`) → fill colour,
// box-drawing chars → shadow colour. Without this, the shadow strokes
// read as loud as the fill and the letters look hollow / doubled.
// Other fonts use single-line glyphs and don't need this — caller
// short-circuits when no `█` is present.
function twoToneAscii(line, fill, shadow, reset) {
  let out = "";
  let mode = null; // "fill" | "shadow" | "space"
  for (const ch of line) {
    const next = ch === "█" ? "fill" : ch === " " ? "space" : "shadow";
    if (next !== mode) {
      if (mode === "fill" || mode === "shadow") out += reset;
      if (next === "fill") out += fill;
      else if (next === "shadow") out += shadow;
      mode = next;
    }
    out += ch;
  }
  if (mode === "fill" || mode === "shadow") out += reset;
  return out;
}

// One tip per boot, drawn at random — keeps the banner light and surfaces
// a different feature each time. New shipped features earn a slot here.
// MCP setup is intentionally NOT in this pool: the MCP endpoint is pinned
// to the top line so a new user always sees what to give their AI.
export function getTips() {
  return [
    `Ask "what did we decide about pricing?" — Oyster finds it across every session.`,
    `Right-click any artefact → publish a public oyster.to/p/ link.`,
    `Tell your AI to "scan ~/Dev/my-project" — Oyster proposes spaces from what it finds.`,
    `Pin an artefact to keep it at the top of Home — right-click → Pin.`,
    `Type / in the chat for slash commands — /p, /u, /s, and more.`,
    `Latest changes: https://oyster.to/changelog`,
  ];
}

// `tipIndex` lets the preview script iterate every variant deterministically;
// production calls omit it and get a random tip.
// `options.logo` lets the preview script swap the ASCII font.
// `options.version` (e.g. "0.8.0-beta.2") renders a faint `vX.Y.Z` flush
// to the bottom-right of the ASCII block — quietly visible without
// crowding the rest of the banner.
export function printHeroBox(url, tipIndex, options = {}) {
  const logo = options.logo || DEFAULT_LOGO;
  const version = options.version;
  const tips = getTips();
  const tip = tipIndex != null
    ? tips[tipIndex]
    : tips[Math.floor(Math.random() * tips.length)];

  // `.length` on strings with surrogate-pair emojis (👉, 🤖) returns 2 and
  // those emojis render as 2 terminal cells — so length ≈ display width
  // in the modern terminals we target. Avoid BMP-presentation emojis
  // like ✨ (U+2728) and emojis carrying a variation selector like 🖥️
  // (🖥 + U+FE0F) — both miscount, breaking the padding maths.
  const topLine = ` 👉  Open: ${C}${url}${R}    🤖  MCP server: ${C}${url}/mcp/${R}  ${D}(give this to your AI)${R}`;

  // Pad ASCII rows to a uniform width so the block centres as one shape.
  const artLineLen = Math.max(...logo.map((l) => l.length));
  const paddedArt = logo.map((l) => l + " ".repeat(artLineLen - l.length));
  // Floor the box width to the widest possible tip text — otherwise the
  // box visibly jitters between boots as different tips are drawn.
  const allTipsMaxVis = Math.max(...tips.map((t) => stripAnsi(t).length));
  const maxVis = Math.max(stripAnsi(topLine).length, artLineLen, allTipsMaxVis);
  const innerWidth = maxVis + 4; // 2 cells breathing room on each side

  // Tip is centred (no anchor emoji) so it reads as a quiet inscription
  // rather than a third equal-weight item under the actionable top line.
  const tipPlainLen = stripAnsi(tip).length;
  const tipLeftPad = Math.floor((innerWidth - 2 - tipPlainLen) / 2);
  const tipLine = `${" ".repeat(tipLeftPad)}${T}${tip}${R}`;

  const contentLines = [
    ``,
    topLine,
    ``,
    tipLine,
    ``,
  ];

  // Centre the ASCII block. The render loop already inserts 2 leading cells
  // before each line, so distribute the rest as left/right padding.
  const artLeftPad = Math.floor((innerWidth - 2 - artLineLen) / 2);
  const hasShadowChars = paddedArt.some((l) => l.includes("█"));
  const artLines = paddedArt.map((l) => {
    const coloured = hasShadowChars ? twoToneAscii(l, M, MD, R) : `${M}${l}${R}`;
    return `${" ".repeat(artLeftPad)}${coloured}`;
  });

  // Faint `vX.Y.Z` right-aligned to the ASCII block's right edge — sits
  // immediately under the logo so it reads as an attached marker rather
  // than a separate banner row.
  const versionLines = [];
  if (version) {
    const versionText = `v${version}`;
    const versionLeftPad = Math.max(0, artLeftPad + artLineLen - versionText.length);
    versionLines.push(`${" ".repeat(versionLeftPad)}${D}${versionText}${R}`);
  }

  const lines = [``, ...artLines, ...versionLines, ...contentLines];

  const hr = "─".repeat(innerWidth);
  const out = [];
  out.push(`\n  ${M}╭${hr}╮${R}`);
  for (const line of lines) {
    const plain = stripAnsi(line);
    const rightPad = innerWidth - 2 - plain.length;
    out.push(`  ${M}│${R}  ${line}${" ".repeat(rightPad)}${M}│${R}`);
  }
  out.push(`  ${M}╰${hr}╯${R}\n`);
  console.log(out.join("\n"));
}
