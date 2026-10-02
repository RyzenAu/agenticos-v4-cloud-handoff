# Performance, dependencies and restart resilience (round 6, Builder D, 2 Oct 2026)

Branch `r6/perf-20261002`, base `228bd232` (live code). Same method before and after: `scripts/perf/measure-load.ts` (real headless Chrome through
playwright-core, cache disabled, synthetic data) against my own hub on `127.0.0.1:8154` (`bun --bun vite dev`, `MU_HUB_ROLE=cloud`, fresh data dir on D:,
Hindsight and memory writes off). **Mode: the hub is a Vite dev server** (the `/__*` API routes are Vite plugins), so browser figures are dev-mode figures.
The production bundle cannot be driven end to end, so its first-load weight is measured separately from the build output with
`scripts/perf/dist-first-load.ts` (the manifest's preload list plus each chunk's static import closure). Both are labelled below.

"Usable" = React is listening and the page has more than 300 characters of text (a click works). "Cold" is the first visit after the hub starts (Vite
transforms every module); "warm" is the second visit, which is what Usman sees on a running hub, so the warm column is the one compared. Idle = fetch,
XHR and event-stream requests in 60 s after a 10 s settle, per route. Memory = JS heap after a forced GC, before and after 30 client-side navigations
between six routes. Page content is never recorded.

## BEFORE (commit `228bd232`, measured 2 Oct 2026)

### First load of /business, dev server (browser)

| | Cold | Warm |
|---|---|---|
| Requests | 342 | 608 |
| Script transferred / uncompressed | 7.7 MB / 7.6 MB | 14.9 MB / 14.8 MB |
| CSS transferred | 776 KB | 776 KB |
| DOMContentLoaded / load | 2.06 s / 4.39 s | 0.93 s / 1.18 s |
| Usable | 7.5 s | 1.6 s |
| Page-data calls in the first 6 s | 3 (page was still compiling) | 45 |

(Dev serves unbundled modules with no compression, so transferred = uncompressed. Warm is larger than cold because by the time the page has settled the
deferred overlays, the oracle and the voice companion have loaded.)

Slowest page-data calls (warm, first 6 s): `/__operator/business/today` 2,667 ms, `/__workspace/websites` 551 ms, `/__design_index_status` 96 ms, `/__design_ledger` 95 ms.
Duplicate fetches in that first load: `/__operator/state` x4, `/__operator/models` x3, and two each of the three design reads, `private-advisor`, `finance_manual/summary`,
`jarvis/settings` and `conversations`.

Biggest script bodies (dev): recharts pre-bundle 1,086 KB, react-dom 982 KB, `floating-oracle.tsx` 560 KB and `voice-companion.tsx` 557 KB (each carrying its whole
source again as an inline source map), seroval 436 KB, `business.tsx` 275 KB.

### First load, production build (static analysis of `dist/`, gzip in brackets)

| Route | Scripts | Count | CSS |
|---|---|---|---|
| /business | 1,753 KB raw (566 KB) | 81 | 256 KB (48 KB) |
| /leads | 1,094 KB (353 KB) | 36 | 116 KB |
| /computers | 946 KB (303 KB) | 8 | 116 KB |
| /memory | 1,324 KB (444 KB) | 67 | 218 KB |
| /design | 1,169 KB (374 KB) | 27 | 120 KB |

The shared entry chunk is 883 KB (279 KB gzip). The earlier "under 3 MB" target is already met by the build; the hub just does not serve it.

### Idle network requests per minute (visible tab, warm)

| Route | Per minute | Main sources |
|---|---|---|
| /business | 17 | operator/state 4, three design reads 2 each, events/snapshot 1 |
| /leads | 21 | operator/state 4, leads reads 2 each, design reads 2 each |
| /computers | 15 | operator/state 4, computers 2, design reads 2 each |
| /coding | 28 | **coding/jobs 15 (every 4 s, also in a hidden tab)**, operator/state 4, design reads |
| /memory | 17 | memory/storage 4, operator/state 4, design reads |
| /operations | 13 | operator/state 4, design reads |

### Memory

JS heap on /business: 25.6 MB at start, 32.5 MB after 30 navigations (+6.9 MB; readings at 10/20/30: 30.2, 29.9, 32.3 MB, so it plateaus, not a steady leak).

### Reused from round 5 (not re-measured)

Viewer responsiveness, takeover and Stop timing, and the bot host's CPU/RAM at 2 and 4 desktops: LAN-BOT-HOST-EVIDENCE.md and HANDOFF.md section 2.

## AFTER (same method, same hub settings, 2 Oct 2026; branch `r6/perf-20261002`)

Raw numbers: `perf-r6-before.json` and `perf-r6-after.json` (same script). The dev server was restarted for each run.

| Measure | Before | After | Cause of the change |
|---|---|---|---|
| Dev first load, warm: script transferred | 14.9 MB | 10.6 MB (-29%) | every app module (`src/**`) is served without its inline source map (`appSourceMapsOff`); the maps carried each file's full source again (floating-oracle 560 to 194 KB, voice-companion 557 to 192 KB). Set `AGENTIC_DEV_SOURCEMAPS=1` to get them back |
| Dev first load, warm: usable | 1.6 s | 0.49 s (second run 0.63 s) | less to download and parse; duplicate fetches removed |
| Dev first load, warm: DOMContentLoaded / load | 0.93 s / 1.18 s | 0.20 s / 0.24 s | same |
| Dev first load, cold (first visit after start): usable | 7.5 s | 1.1 s | same; Vite compile cost is unchanged but lands on a lighter page |
| Page-data calls in the first 6 s, warm | 45 | 48 (cold 3 to 48: the before run was still compiling) | not reduced. `/__operator/state` x4 is now x1 (5 s freshness default); the remainder are plain `useEffect` fetches duplicated by React StrictMode in dev only |
| Slowest page-data call | `/__operator/business/today` 2,667 ms (cold), `/__workspace/websites` 551 ms | warm: every call under 40 ms; the first-ever read of `business/today` is still 2.7 s (an outside weather and news fetch), but a read after the 10-minute cache expiry now answers at once, labelled `stale: true` with its own `updatedAt`, and refreshes in the background | stale-while-revalidate in `scripts/business-today.ts` |
| Idle requests per minute, /business | 17 | 13 | |
| /leads | 21 | 17 | `operator/state` 15 s to 30 s (still 1.2 s while indexing) |
| /computers | 15 | 11 | |
| **/coding** | **28** | **13** | `coding/jobs` 15 a minute (fixed 4 s timer, hidden or not) to 4 (4 s only while a job runs or waits on you, else 15 s; never in a hidden tab; backoff when the hub is down) |
| /memory | 17 | 10 | `memory/storage` 15 s to 60 s |
| /operations | 13 | 9 | |
| Design reads on every route | 3 reads / 30 s | 2 reads / 30 s | the ledger is only read while a generation is running |
| JS heap after 30 navigations | +6.9 MB (25.6 to 32.5) | +4.4 MB (20.3 to 24.7) | lighter modules; no steady growth (readings 22.8, 22.6, 25.4) |
| Hub process (idle, own hub) | | working set 775 MB, 48 CPU-seconds after the whole run | not compared: the before hub was not sampled |
| Production build, first load of /business | 1,753 KB raw / 566 KB gzip, 81 scripts | unchanged | no production change was made: the build is already split (shared entry 883 KB); recharts (364 KB) is the one heavy chunk on /business, left alone because its three chart components live inside `business.tsx` (Builder A's page) |

Honest limits. (1) The hub is a dev server, so the first-load gains are dev-mode gains; a production bundle served by the hub (bundled, lazy routes) was not attempted
because every `/__*` API is a Vite dev-server plugin. (2) Idle polling fell by 2 to 15 requests a minute per route, not to the 4 a minute round 2 reached for the Jarvis HUD:
what remains is `operator/state`, `events/snapshot` (the stream's safety net), `workspace/needs-you`, `operator/away` and the design reads, each of which the page relies on.
(3) Viewer responsiveness and bot resource use are round 5's numbers (LAN-BOT-HOST-EVIDENCE.md), not re-measured.

### Offline and stale stay truthful

Offline detection is the activity stream's watchdog (45 s of missed heartbeats, `scripts/events/client.test.ts`), not a poll, so slower polls cannot hide it. The new poll
(`src/lib/visible-poll.ts`, tests in `scripts/visible-poll.test.ts`) reads at once when a hidden tab returns, treats a read with no answer in 20 s as a failed read (the Coding list fetch also times out at 15 s), so one hung request cannot stall it, backs off 2x per failure (capped at 60 s) and reports each failure;
the Coding list keeps its last good rows and labels them "last successful read" with the error. The brief's stale read says `stale: true` and keeps its own `updatedAt`; the page now shows "Weather as of HH:MM (updating)" and reads once more after 6 s
(`src/components/business/daily-brief.tsx`, `brief-today.tsx`: the only edits there; tests in `scripts/business-today.test.ts`). A 5 s default freshness (`staleTime`) only stops a mount or focus from re-fetching data that is seconds old; polling intervals, invalidation
after a change, Refresh buttons and stream hints are unchanged.
