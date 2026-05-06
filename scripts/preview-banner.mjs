#!/usr/bin/env node
// Preview every banner-tip variant locally — for iterating on tip copy
// without booting the full server. Run with `npm run preview:banner`.

import { printHeroBox, getTips } from "../bin/_banner.mjs";

const url = "http://127.0.0.1:4444";
const tips = getTips(url);
console.log(`\nRendering ${tips.length} tip variants:\n`);
for (let i = 0; i < tips.length; i++) {
  console.log(`--- variant ${i + 1} of ${tips.length} ---`);
  printHeroBox(url, i);
}
