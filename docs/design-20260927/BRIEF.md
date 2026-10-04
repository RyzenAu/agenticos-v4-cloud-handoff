# AgenticOS shell design brief (27 Sep 2026, os-shell track)

Scope: the OS shell (navigation, header, Jarvis entry, Inspector) and the eight destination
landing pages. Page bodies owned by other tracks are mounted, not redesigned.

## 1. Evidence looked at

- Source and history: `src/styles.css` tokens, `docs/DESIGN-SYSTEM.md`, commit `75b37f2`
  (24 Sep, "one visual language") and `9debece` (27 Sep sidebar regroup).
- Saved renders: `docs/integration-20260927/*` (live 8081 after integration),
  `docs/ux-audit-20260927/{before,after}`.
- Live 8081, read-only GETs, blurred: `before-live/workspace-{1440,390}.png`.

## 2. Keep (what makes v4 recognisable)

| Keep | Why |
|---|---|
| Near-black neutral ground (hue ~290), one iris accent `--brand` | The v4 identity. Used only for the active place, the one primary action, focus and live state. |
| Inter for UI, JetBrains Mono only for IDs, paths and code | Calm, legible; mono isn't used as decoration. |
| The single Sparkles mark + "Agentic OS" wordmark | One fixed identity (audit P1-6). |
| Cards: 12px radius, 1px border, soft shadow; rows on `--inset` | Readable metric cards without glows or gradients. |
| The Jarvis HUD orb (`HudCore`) | The owner's "expressive central assistant visual". Now the centrepiece of `/jarvis`. |
| Honest states: `—` plus a reason, skeletons in the page's shape, "Updated … ago" | Nothing fake stands in for data. |

## 3. Fix

| Problem (before) | Fix |
|---|---|
| 26 links in 7 folding groups; the owner's daily work spread across Business, Finance, Deen, Research, Personal, Files, Operations | 8 destinations. The one you're in opens its drilldowns under it; the rest stay one line. Whole nav fits 900px with no folds. |
| No way to tell where you are on a drilldown | Header breadcrumb "Destination › Page"; the destination links back to its landing. |
| Voice was one of nine header buttons; nothing showed Jarvis working | A persistent Jarvis chip on every page: still when idle, level meter while listening, travelling wave while working, amber while it needs your yes; "Step 2 of 4 · 43s". |
| Technical detail (request errors, source timings, confidence) either hidden or dumped into pages | Inspector drawer (Alt+Shift+I): Decisions with confidence, Agent steps, Requests, Page facts. Pages publish there instead of showing logs. |
| Workspace = six stacked panels, a long read | Today = five signals, "Needs attention", "Next actions", "Running now", "Pipeline". The full panels moved to Work. |
| ~15 shell requests left at the same moment as the page's own and queued on six connections | Overlays that poll mount after the page's queries settle; the accounts hub loads only when opened. Today keeps one small request per source (a batched `/__workspace` was tried and dropped: it made every card wait for the slowest source, the site checks). |
| Estimates next to real spend without a label (Mission Control "API-equivalent", "ROI", "saved") | Labelled "(estimate)"/"(predicted)" with the assumption in the tooltip; Finance margins say "Estimate only" and list what's missing. |

## 4. Tokens

Existing tokens stay authoritative (`src/styles.css`, `docs/DESIGN-SYSTEM.md`). Changes and shell-specific use:

| Token | Value | Use |
|---|---|---|
| `--sidebar` (dark) | `oklch(0.148 0.006 286)`, one step below `--background` `0.165` | Navigation reads as its own layer. Light theme unchanged. |
| `--brand` / `--brand-soft` | iris / iris wash | Active destination wash + icon tint; active drilldown dot; Jarvis bars. |
| Type | 28 h1 · 18 h2 · 15 card title · 13 body · 12 meta · 11 caps floor | Unchanged. Signal-tile values use 22 (`--text-xl`), labels 12 sentence case. |
| Spacing | 4px scale; tiles gap 12; sections 48 apart | Unchanged. |
| Radius | 6 controls · 8 rows · 12 cards · 16 bottom sheet · full for the Jarvis chip | Chip is the one pill in the header. |
| Motion | `--dur-fast 120` / `--dur-base 180` / `--dur-slow 280`, `--ease-out-quart` | Sidebar rail width, drawer entry, one-off value flash (`.sh-tick`, 900ms) when a signal changes. |
| Looping motion | Only the Jarvis bars while listening/working/asking | Nothing else loops. All of it stops under `prefers-reduced-motion`. |

Sparklines: the `Sparkline` primitive stays reserved for real series. No current endpoint returns
one for the shell's signals (calls, spend and usage are point totals), so no tile shows a line.
Candidates when a series exists: `/__ai_usage` daily spend, receptionist calls per day.

## 5. Destination map

Every route has exactly one home (enforced by `scripts/os-shell.test.ts`). Only `/` and
`/workspace` redirect (to `/today`); every other URL is unchanged.

| Destination | Landing | Drilldowns (existing routes) | Also belongs here |
|---|---|---|---|
| Today | `/today` (new) | Inbox `/inbox`, Calendar `/calendar` | `/workspace` → redirect, `/inbox-triage` |
| Jarvis | `/jarvis` (new) | Chat `/chat`, Hermes `/agents/hermes`, Claude Code `/agents/claude-code`, OpenClaw `/agents/openclaw`*, Automations `/automations`, Activity `/activity`, Mission Control `/dashboard`* | `/hud` (window, no shell) |
| Receptionist | `/receptionist` | Packages & economics `/operations` | |
| Work | `/work` (new) | Leads `/leads`, Websites `/websites`, Business brief `/business`, Goals `/business?view=progress`, Projects `/workspaces` (+ `/workspaces/$id`) | |
| Memory | `/memory` | Vault `/memory/vault` (new mount), Memory map `/memory-map`, Knowledge graph `/codegraph` | |
| Finance | `/finance` (new) | Finances `/business?view=finance`, AI usage & spend `/usage` | |
| Studio | `/studio` (new) | Design `/design`, Motion Library `/motion`, Transition lab `/transitions`, Share card `/share` | |
| System | `/system` (new) | Skills `/skills`, Skill drafts `/skill-drafts`, Settings `/settings` | `/setup` |

\* shown only while its Settings toggle is on, as before.

## 6. Contracts for other tracks

- **Jarvis (Jev track)** — `src/components/shell/jarvis-slot.tsx`. Dispatch
  `jarvis:progress` with `JarvisProgress` (`phase`, `label`, `step`, `startedAt`, `taskId`,
  `source`, `at`), and `jarvis:decision` for the Inspector. Optionally create
  `src/components/jarvis/surface.tsx` exporting `JarvisChip(props: JarvisChipProps)` and/or
  `JarvisPanel(props: JarvisPanelProps)`; they load lazily inside an error boundary.
- **Destination mounts** — `src/components/shell/mounts.tsx`. Default-export a component
  taking `MountProps` (`inspect(entry)`) from:
  `src/components/receptionist/destination.tsx` (replaces `/receptionist`),
  `src/components/finance/destination.tsx` (`/finance`),
  `src/components/memory/destination.tsx` (`/memory/vault`),
  `src/components/profile/destination.tsx` (System › Devices and people).
  No sidebar, root or route edit is needed.
- **Inspector** — `window.dispatchEvent(new CustomEvent("agentic:inspect", { detail: { title, detail, confidence, tone, source } }))`.

## 7. Evidence

`<destination>-{1440,390}.png` in this folder (private text blurred; state screenshots use
synthetic Jarvis/Jev events), `shell-*.png` for the chip, Inspector, rail and drawer,
`metrics.json` for axe, overflow and console errors.

## STATUS at owner pause (27 Sep 2026, ~20:40 Sydney)

**Done (committed on `w2/os-shell-20260927`)**
- Economics workbench on the catalogue: Essential A$699 default, ex GST labels, per-package scenarios, no A$549, no "Explore proposed" override (test in `scripts/os-shell.test.ts`).
- Shell: 8-destination sidebar + icon rail + mobile drawer, breadcrumb, global Jarvis chip slot with a documented contract, Inspector drawer, polling overlays deferred until the page settles, accounts hub on demand.
- Destination pages: Today, Work, Jarvis, Finance, Studio, System, `/memory/vault`; `/receptionist` swaps in rx-dash's component by file convention; `/` and `/workspace` redirect to `/today`.
- Mission Control estimates labelled (API-equivalent, ROI → "value per dollar (estimate)", saved/predicted).
- Measurements: `docs/PERF-20260927.md` → "os-shell" (before/after, same method).
- Checks run during the work: `tsc --noEmit` 0 errors; `bun --no-env-file test scripts/os-shell.test.ts` 13 pass; `scripts/business-economics.test.ts` 46 pass. First screenshot pass of all 8 destinations at 1440 and 390 (not committed: unblurred): 0 console errors; axe serious/critical 0 after the two fixes below; no horizontal overflow except Finance at 390, fixed by replacing the shared `AiUsageSummary` with signal tiles.

**Half-done**
- Evidence screenshots of every destination at 1440×900 and 390×844 are NOT in this folder yet. Only the synthetic-state shots are (`shell-*.png`, taken before the phone chip fix; `shell-states.json` has axe/overflow: 0 serious/critical, no overflow). Re-run a blurred capture of the 8 destinations after the pause.
- Today was switched from the batched `/__workspace` request to per-source requests at the end (measured, type-checked; not re-screenshotted).
- The full `bun --no-env-file test scripts` run and `vite build` were not run before the pause.

**Next steps**
1. Blurred 1440/390 captures of the 8 destinations + axe/overflow into this folder.
2. Full test suite vs baseline, `vite build`.
3. Memory revisit long task (1.2–1.5 s, pre-existing) — needs the memory page owner.
4. Report to the lead: live 8081 `/business` showed "Invalid hook call" at ~20:05 after `node_modules/.vite/deps` was rewritten at 19:48:18 by a second `vite dev` (PID 95868, started 19:47:52, not this track); needs a restart of 8081 by the owner. All quiet copies should set `ARGENTIC_PREVIEW=1` so they don't share the live dependency cache (this track's first 4301 run, 19:15–19:18, did not).
