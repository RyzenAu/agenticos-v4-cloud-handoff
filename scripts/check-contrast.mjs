#!/usr/bin/env node
// Legibility guard for the chat UI.
//
// On 25 Jul 2026 sixty-five text elements in home-command.tsx failed WCAG AA and
// thirty-eight were rendered below 10px — the bottom telemetry strip sat at
// 3.9:1 in 9.5px ALL-CAPS Courier. It got that way one plausible-looking
// `rgba(…, 0.45)` at a time, because nothing ever said no.
//
// home-command.tsx has since moved onto the shared design-system tokens
// (docs/DESIGN-SYSTEM.md): text colour is now `var(--foreground)` /
// `var(--muted-foreground)` / `var(--brand)` rather than a hand-rolled
// cream/amber alpha ladder. This still checks the same shape of regression —
// a translucent text colour that quietly drops below AA on the app
// background — using the current dark-theme token values (src/styles.css
// `.dark` block, mirrored in hex in docs/DESIGN-SYSTEM.md's colour table) in
// place of the old teal/cream pair, so a `color: "rgba(…)"` literal
// reintroduced against one of these tones is still caught.
//
// This says no. It reads the source rather than the browser, so it runs anywhere
// and needs no server:
//
//     node scripts/check-contrast.mjs
//
// Exits non-zero on a regression, and prints the file:line of each one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["src/components/home-command.tsx"];

// The app background, dark-theme `--background` (src/styles.css `.dark`; #0e0e11).
const BG = [14, 14, 17];
// The two dark-theme tones this UI still reaches for with an alpha suffix:
// `--foreground` (#f0edf5) for primary text and `--brand` (#c8afe9) for the
// one accent.
const FOREGROUND = [240, 237, 245];
const BRAND = [200, 175, 233];

const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (f, b) => {
  const [hi, lo] = lum(f) > lum(b) ? [lum(f), lum(b)] : [lum(b), lum(f)];
  return (hi + 0.05) / (lo + 0.05);
};
const composite = (fg, a) => [0, 1, 2].map((i) => fg[i] * a + BG[i] * (1 - a));
const contrastAt = (fg, a) => ratio(composite(fg, a), BG);

// AA for body text. Small text gets held to a higher bar because this UI sets it
// in a light typewriter mono, where the ratio maths flatters the real result.
const MIN_RATIO = 4.5;
const MIN_FONT_PX = 10;

let failures = [];

for (const rel of FILES) {
  const src = readFileSync(join(ROOT, rel), "utf-8");
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    // 1. Text colours declared with alpha.
    for (const m of line.matchAll(/color:\s*"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0?\.\d+|1)\s*\)"/g)) {
      const fg = [Number(m[1]), Number(m[2]), Number(m[3])];
      const a = Number(m[4]);
      // Only judge the palette colours we know sit on the dark app background.
      const known =
        fg.join() === FOREGROUND.join() ? FOREGROUND : fg.join() === BRAND.join() ? BRAND : null;
      if (!known) continue;
      const cr = contrastAt(known, a);
      if (cr < MIN_RATIO)
        failures.push(`${at}  colour alpha ${a} → ${cr.toFixed(2)}:1 (need ${MIN_RATIO})  ${m[0].slice(0, 46)}`);
    }

    // 2. Type smaller than the floor.
    for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      const px = Number(m[1]);
      if (px < MIN_FONT_PX) failures.push(`${at}  ${px}px text (floor is ${MIN_FONT_PX}px)`);
    }
  });
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} legibility regression(s):\n`);
  for (const f of failures) console.error("  " + f);
  console.error(
    `\nOn ${`rgb(${BG})`} the minimum alpha for ${MIN_RATIO}:1 is ~0.48 for --foreground` +
      ` and ~0.63 for --brand.\n`,
  );
  process.exit(1);
}

console.log(`✓ contrast + type-size floors hold across ${FILES.length} file(s)`);
