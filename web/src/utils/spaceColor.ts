// Curated palette — dark, desaturated, elegant on navy/purple backgrounds
const SPACE_PALETTE = [
  "#6057c4", // muted indigo
  "#3d8aaa", // slate blue
  "#3a8f64", // forest green
  "#b06840", // burnt sienna
  "#8f5a9e", // dusty violet
  "#3a8a7a", // deep teal
  "#9e7c2a", // dark gold
  "#8f4a5a", // muted rose
];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function spaceColor(spaceId: string): string {
  return SPACE_PALETTE[hash(spaceId) % SPACE_PALETTE.length];
}
