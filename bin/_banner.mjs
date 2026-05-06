// Hero banner for the `oyster` CLI.
// Boxed + coloured so it doesn't get lost in scrolling server logs above
// and Node deprecation warnings below. Extracted into its own module so
// `scripts/preview-banner.mjs` can iterate every tip variant in dev.

// ANSI colour codes — no extra dep. `\x1b[95m` bright magenta (indigo-ish,
// Oyster's accent). `\x1b[1;96m` bold bright cyan, reserved for real,
// clickable URLs and copy-paste commands.
const M = "\x1b[95m";
const C = "\x1b[1;96m";
const R = "\x1b[0m";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// "Oyster" rendered in figlet's "ANSI Shadow" font. All glyphs are single-
// cell box-drawing / block characters — `.length` matches display width.
const OYSTER_ASCII = [
  ` ██████╗ ██╗   ██╗███████╗████████╗███████╗██████╗ `,
  `██╔═══██╗╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝██╔══██╗`,
  `██║   ██║ ╚████╔╝ ███████╗   ██║   █████╗  ██████╔╝`,
  `██║   ██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██╔══██╗`,
  `╚██████╔╝   ██║   ███████║   ██║   ███████╗██║  ██║`,
  ` ╚═════╝    ╚═╝   ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝`,
];

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
    `Latest changes: ${C}https://oyster.to/changelog${R}`,
  ];
}

// `tipIndex` lets the preview script iterate every variant deterministically;
// production calls omit it and get a random tip.
export function printHeroBox(url, tipIndex) {
  const tips = getTips();
  const tip = tipIndex != null
    ? tips[tipIndex]
    : tips[Math.floor(Math.random() * tips.length)];

  // `.length` on strings with surrogate-pair emojis (👉, 💡) returns 2 and
  // those emojis render as 2 terminal cells — so length ≈ display width
  // in the modern terminals we target. Avoid BMP-presentation emojis like
  // ✨ (U+2728) here — they have .length 1 but render 2-wide, breaking the
  // padding maths.
  const contentLines = [
    ``,
    ` 👉  Open: ${C}${url}${R}    |    MCP server: ${C}${url}/mcp/${R}  (give this to your AI)`,
    ``,
    ` 💡  ${tip}`,
    ``,
  ];

  // Pad ASCII rows to a uniform width so the block centres as one shape.
  const artLineLen = Math.max(...OYSTER_ASCII.map((l) => l.length));
  const paddedArt = OYSTER_ASCII.map((l) => l + " ".repeat(artLineLen - l.length));
  const contentMaxVis = Math.max(...contentLines.map((l) => stripAnsi(l).length));
  // Floor the box width to the widest possible tip — otherwise the box
  // visibly jitters between boots as different tips are drawn.
  const allTipsMaxVis = Math.max(...tips.map((t) => stripAnsi(` 💡  ${t}`).length));
  const maxVis = Math.max(contentMaxVis, artLineLen, allTipsMaxVis);
  const innerWidth = maxVis + 4; // 2 cells breathing room on each side

  // Centre the ASCII block. The render loop already inserts 2 leading cells
  // before each line, so distribute the rest as left/right padding.
  const artLeftPad = Math.floor((innerWidth - 2 - artLineLen) / 2);
  const artLines = paddedArt.map((l) => `${" ".repeat(artLeftPad)}${M}${l}${R}`);

  const lines = [``, ...artLines, ...contentLines];

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
