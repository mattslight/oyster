#!/usr/bin/env node
// Preview banner variants locally — for iterating without booting the
// full server. Run with `npm run preview:banner` (tip rotation) or
// `npm run preview:banner -- --fonts` (logo font comparison).

import { printHeroBox, getTips, LOGO_FONTS } from "../bin/_banner.mjs";

const url = "http://127.0.0.1:4444";
const args = process.argv.slice(2);

if (args[0] === "--fonts" || args[0] === "-f") {
  console.log(`\nComparing ${Object.keys(LOGO_FONTS).length} logo fonts (using tip 1 throughout):\n`);
  for (const name of Object.keys(LOGO_FONTS)) {
    console.log(`--- font: ${name} ---`);
    printHeroBox(url, 0, { logo: LOGO_FONTS[name] });
  }
} else {
  const tips = getTips();
  console.log(`\nRendering ${tips.length} tip variants:\n`);
  for (let i = 0; i < tips.length; i++) {
    console.log(`--- variant ${i + 1} of ${tips.length} ---`);
    printHeroBox(url, i);
  }
}
