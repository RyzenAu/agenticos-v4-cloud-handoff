# Native perf pass — 28 Sep 2026

Branch `f/native-perf-20260928`. Raw runs: `results-*.json`; script: `measure.mjs` (this table: `summarise.mjs`).

**Conditions.** Quiet preview `vite dev` from this worktree on 127.0.0.1:8097
(`ARGENTIC_PREVIEW=1 AGENTIC_OS_NO_BACKGROUND=1`, own `.preview-cache`), headless Chrome 154, 1440×900,
a fresh browser context per visit with the cache disabled (cold browser cache). BEFORE = base commit
3fb7226's versions of every file this pass changed, AFTER = this branch; same machine, same session.
The PC was also running the lead's Tauri/cargo builds, so single runs carry multi-second outliers:
read the medians, and the byte/request columns, which do not depend on load.

- **Warm**: one warm-up visit per page (Vite transforms on first request), then 5 rounds, on 2 separate server starts; median of all 10 runs per page.
- **First visit**: fresh server start, 25 s idle, then one visit per page in order; median of 3 server starts,
  BEFORE and AFTER starts interleaved (before, after, before, …) so machine load hits both alike.
- *hydrated* = React has committed the shell's `<main>` (first-interactive proxy). *JS KB* = encoded bytes of
  every script until the page goes quiet (no script/style/font/image request for 1.5 s). *font block* = time the
  render-blocking fonts.googleapis.com stylesheet took before first paint.

## Warm (median of 10 runs)

| page | TTFB ms | FCP ms | DCL ms | load ms | hydrated ms | requests | JS KB | image KB | font block ms |
|---|---|---|---|---|---|---|---|---|---|
| / (→ /today) | 29 → **54** | 520 → **324** | 498 → **149** | 697 → **311** | 1319 → **1105** | 431 → **430** | 11807 → **9777** | 0 → **0** | 322 → **0** |
| /workspace (→ /today) | 31 → **19** | 604 → **212** | 584 → **109** | 863 → **183** | 1496 → **733** | 431 → **430** | 11807 → **9777** | 0 → **0** | 337 → **0** |
| /finance | 20 → **22** | 476 → **240** | 458 → **129** | 696 → **233** | 1158 → **831** | 436 → **435** | 12159 → **10128** | 0 → **0** | 303 → **0** |
| /memory | 90 → **28** | 644 → **360** | 606 → **166** | 790 → **391** | 1652 → **1261** | 399 → **469** | 12481 → **12766** | 1441 → **160** | 308 → **0** |
| /receptionist | 23 → **25** | 444 → **296** | 421 → **147** | 679 → **285** | 1304 → **904** | 442 → **441** | 12320 → **10290** | 0 → **0** | 329 → **0** |
| /jarvis | 19 → **16** | 460 → **216** | 438 → **115** | 625 → **189** | 1025 → **733** | 422 → **421** | 11646 → **9615** | 0 → **0** | 342 → **0** |
| /design | 531 → **32** | 896 → **204** | 881 → **123** | 979 → **202** | 1625 → **732** | 495 → **495** | 13045 → **11014** | 94073 → **94073** | 361 → **0** |

## First visit after a server start (median of 3 / 3 starts)

| page | TTFB ms | load ms | hydrated ms |
|---|---|---|---|
| / (→ /today) | 3018 → **1893** | 4046 → **2733** | 4684 → **3317** |
| /workspace (→ /today) | 28 → **27** | 504 → **140** | 866 → **627** |
| /finance | 233 → **59** | 764 → **208** | 1355 → **745** |
| /memory | 1111 → **480** | 1547 → **754** | 3004 → **1380** |
| /receptionist | 323 → **53** | 763 → **164** | 1580 → **710** |
| /jarvis | 1404 → **32** | 1935 → **179** | 2426 → **701** |
| /design | 3338 → **3670** | 4198 → **3910** | 5902 → **5902** |

The first page after a start (`/`) also pays for Vite's own startup work; the others share its shell.

## lucide-react in dev: whole barrel vs subset (median of 5, all other changes applied)

| page | hydrated ms barrel → subset | JS KB barrel → subset |
|---|---|---|
| /today | 2007 → **973** | 7654 → **8668** |
| /finance | 1422 → **1062** | 10994 → **10128** |
| /jarvis | 1276 → **794** | 10481 → **9615** |

A third variant — one import per icon file — measured 1198 / 1247 / 1332 ms hydrated on the same three pages
(~120 more requests); its raw file was not kept.

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

## Spot check (AFTER): other sidebar destinations

- /today: rendered /today, hydrated 704 ms, console errors: 0
- /work: rendered /work, hydrated 1040 ms, console errors: 0
- /studio: rendered /studio, hydrated 8093 ms, console errors: 0
- /system: rendered /system, hydrated 697 ms, console errors: 0

Re-check on a quieter start (`results-spot-after.json`, median of 3): /studio hydrated 443 ms, /today hydrated 498 ms, /work hydrated 467 ms, /system hydrated 421 ms; console errors: 0. The 8 s /studio above was a load spike.

Console errors across all AFTER runs: none.
