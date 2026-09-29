// Builds RESULTS.md from the raw results-*.json files written by measure.mjs.
//   node docs/native-perf-20260928/summarise.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, `results-${name}.json`), "utf8"));
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const ms = (x) => (x == null ? "–" : `${Math.round(x)}`);
const kb = (x) => (x == null ? "–" : `${Math.round(x / 1024)}`);
const arrow = (b, a, unit = "") => `${b}${unit} → **${a}${unit}**`;

// Warm sets: results-<tag>.json plus results-<tag>-2.json (a second server start) when present,
// pooled before taking medians.
const KEYS = ["ttfb", "fcp", "dcl", "load", "hydrated", "requests", "jsRequests", "jsBytes", "totalBytes", "imageBytes", "fontBlock"];
function pooled(tag) {
  const sets = [tag, `${tag}-2`].filter((n) => existsSync(join(here, `results-${n}.json`))).map(load);
  const raw = sets.flatMap((r) => r.raw);
  const paths = sets[0].medians.map((m) => m.path);
  const medians = paths.map((p) => Object.fromEntries([["path", p], ...KEYS.map((k) => [k, median(raw.filter((r) => r.path === p).map((r) => r[k]))])]));
  return { runs: raw.filter((r) => r.path === paths[0]).length, starts: sets.length, medians, raw, spot: sets.flatMap((r) => r.spot || []) };
}
const before = pooled("before");
const after = pooled("after");
const pages = before.medians.map((m) => m.path);
const label = (p) => (p === "/" ? "/ (→ /today)" : p === "/workspace" ? "/workspace (→ /today)" : p);

let out = `# Native perf pass — 28 Sep 2026

Branch \`f/native-perf-20260928\`. Raw runs: \`results-*.json\`; script: \`measure.mjs\` (this table: \`summarise.mjs\`).

**Conditions.** Quiet preview \`vite dev\` from this worktree on 127.0.0.1:8097
(\`ARGENTIC_PREVIEW=1 AGENTIC_OS_NO_BACKGROUND=1\`, own \`.preview-cache\`), headless Chrome 154, 1440×900,
a fresh browser context per visit with the cache disabled (cold browser cache). BEFORE = base commit
3fb7226's versions of every file this pass changed, AFTER = this branch; same machine, same session.
The PC was also running the lead's Tauri/cargo builds, so single runs carry multi-second outliers:
read the medians, and the byte/request columns, which do not depend on load.

- **Warm**: one warm-up visit per page (Vite transforms on first request), then 5 rounds, on ${before.starts} separate server starts; median of all ${before.runs} runs per page.
- **First visit**: fresh server start, 25 s idle, then one visit per page in order; median of 3 server starts,
  BEFORE and AFTER starts interleaved (before, after, before, …) so machine load hits both alike.
- *hydrated* = React has committed the shell's \`<main>\` (first-interactive proxy). *JS KB* = encoded bytes of
  every script until the page goes quiet (no script/style/font/image request for 1.5 s). *font block* = time the
  render-blocking fonts.googleapis.com stylesheet took before first paint.

## Warm (median of ${before.runs} runs)

| page | TTFB ms | FCP ms | DCL ms | load ms | hydrated ms | requests | JS KB | image KB | font block ms |
|---|---|---|---|---|---|---|---|---|---|
`;
for (const p of pages) {
  const b = before.medians.find((m) => m.path === p);
  const a = after.medians.find((m) => m.path === p);
  out += `| ${label(p)} | ${arrow(ms(b.ttfb), ms(a.ttfb))} | ${arrow(ms(b.fcp), ms(a.fcp))} | ${arrow(ms(b.dcl), ms(a.dcl))} | ${arrow(ms(b.load), ms(a.load))} | ${arrow(ms(b.hydrated), ms(a.hydrated))} | ${arrow(b.requests, a.requests)} | ${arrow(kb(b.jsBytes), kb(a.jsBytes))} | ${arrow(kb(b.imageBytes), kb(a.imageBytes))} | ${arrow(ms(b.fontBlock), ms(a.fontBlock))} |\n`;
}

const firsts = (tag) => [1, 2, 3].map((i) => `first-${tag}-${i}`).filter((n) => existsSync(join(here, `results-${n}.json`))).map(load);
const fb = firsts("before");
const fa = firsts("after");
if (fb.length && fa.length) {
  out += `
## First visit after a server start (median of ${fb.length} / ${fa.length} starts)

| page | TTFB ms | load ms | hydrated ms |
|---|---|---|---|
`;
  for (const p of pages) {
    const pick = (set, k) => median(set.map((r) => r.raw.find((x) => x.path === p)?.[k]));
    out += `| ${label(p)} | ${arrow(ms(pick(fb, "ttfb")), ms(pick(fa, "ttfb")))} | ${arrow(ms(pick(fb, "load")), ms(pick(fa, "load")))} | ${arrow(ms(pick(fb, "hydrated")), ms(pick(fa, "hydrated")))} |\n`;
  }
  out += `\nThe first page after a start (\`/\`) also pays for Vite's own startup work; the others share its shell.\n`;
}

const lb = existsSync(join(here, "results-lucide-barrel.json")) && load("lucide-barrel");
const ls = existsSync(join(here, "results-lucide-subset.json")) && load("lucide-subset");
if (lb && ls) {
  out += `
## lucide-react in dev: whole barrel vs subset (median of 5, all other changes applied)

| page | hydrated ms barrel → subset | JS KB barrel → subset |
|---|---|---|
`;
  for (const m of lb.medians) {
    const s = ls.medians.find((x) => x.path === m.path);
    out += `| ${m.path} | ${arrow(ms(m.hydrated), ms(s.hydrated))} | ${arrow(kb(m.jsBytes), kb(s.jsBytes))} |\n`;
  }
  out += `\nA third variant — one import per icon file — measured 1198 / 1247 / 1332 ms hydrated on the same three pages
(~120 more requests); its raw file was not kept.\n`;
}

out += `
## What each fix bought

- **Self-hosted fonts** (public/fonts, @font-face in styles.css, Inter Latin preloaded): the 250–410 ms render-blocking
  fonts.googleapis.com stylesheet is gone from every page (font block → 0), which is most of the FCP/DCL/load drop.
- **lucide subset** (scripts/dev-page-weight.ts): the 981 KB whole-barrel pre-bundle becomes one 119 KB module
  (−862 KB JS on every page); fastest of the three variants measured (table above).
- **Route stubs without inline source maps**: /src/routes/design.tsx, fetched on every page through
  routeTree.gen.ts, went 525 KB → 9.5 KB (the split component, design.tsx?tsr-split=component, still loads only
  on /design). TanStack Start already forces route code splitting, so routeTree.gen.ts itself needed no change.
- Together these are the ~2,030 KB (−17 %) JS drop per page in the warm table.
- **hermes-face.png** 1.29 MB → 8 KB (256 px palette PNG): /memory images 1,441 KB → 160 KB.
- **First visits**: page warm-up for the sidebar destinations + SSR static-import pre-transform
  (vite.config.ts). The live /jarvis 924 ms TTFB was not a loader — no route has an SSR loader or server function;
  the preview reproduces it as on-demand, serial SSR transforms on a first visit (the live figure may also include
  load from the live server's background jobs) — which is what these fix (first-visit /jarvis TTFB 1,404 → 32 ms).
- **Watcher ignores desktop/**: cargo builds of the Tauri shell write .html files under src-tauri/target, and
  every one full-reloaded every open tab (seen repeatedly in the BEFORE server logs).

Not changed: /design first visit (not in the warm-up list on purpose — it is the heaviest page and not a sidebar
destination); per-run request counts vary by ±70 because the shell's late overlays (shell/late.tsx) load after
the page's own data, so a run may or may not include them.
`;

const spots = after.spot || [];
if (spots.length) {
  out += `\n## Spot check (AFTER): other sidebar destinations\n\n`;
  for (const s of spots) out += `- ${s.path}: rendered ${s.finalPath}, hydrated ${ms(s.hydrated)} ms, console errors: ${s.errors.length}\n`;
}
if (existsSync(join(here, "results-spot-after.json"))) {
  const sa = load("spot-after");
  out += `
Re-check on a quieter start (\`results-spot-after.json\`, median of ${sa.runs}): ` +
    sa.medians.map((m) => `${m.path} hydrated ${ms(m.hydrated)} ms`).join(", ") +
    `; console errors: ${sa.raw.filter((r) => r.errors.length).length}. The 8 s /studio above was a load spike.
`;
}
const errs = after.raw.filter((r) => r.errors.length);
out += `\nConsole errors across all AFTER runs: ${errs.length ? JSON.stringify(errs.map((e) => ({ path: e.path, errors: e.errors }))) : "none"}.\n`;
writeFileSync(join(here, "RESULTS.md"), out);
console.log(out);
