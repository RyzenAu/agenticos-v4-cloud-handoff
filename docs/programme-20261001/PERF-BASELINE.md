# Performance baseline: live OS `bc4678a` on Usman's PC (1 Oct 2026, ~03:00 AEST)

Measured through the in-app browser (Chromium) against `127.0.0.1:8081`, the Vite dev server that serves the live OS. No page content was recorded.

| Measure | Value | Note |
|---|---|---|
| Server shell TTFB (9 routes, warm) | 8–37 ms | The server is not the bottleneck |
| First /leads shell TTFB (cold) | 1.2 s | One-off, on first compile |
| Home (/today → /business) full load | DCL 1.0 s, load 1.1 s | 616 resources, **~16 MB script transfer** (unbundled dev modules) |
| Home API fetches in the first 4 s | 59 | |
| Idle polling on Home | 18 requests / 30 s | `jarvis/events`, `jarvis/status`, `jarvis/timers`, each every 5 s: 3 separate polls |
| /leads load (warm modules) | DCL 73 ms, load 94 ms | 31 fetches |
| Slowest /leads data calls | `/__lead-sites/status` 612 ms, `/leads/list` 608 ms, `/leads/calls` 328 ms, `/leads/overview` 318 ms | |
| Hub process | bun, working set ≈ 1.0 GB, 711 CPU-seconds since start | |
| Browser JS heap on Home | 84 MB | |

## First targets (to confirm after agent work lands)

1. Merge the three 5 s Jarvis polls into one status call, and back off when the tab is hidden. Target: ≤ 4 requests/min idle.
2. `/leads/list` and `/lead-sites/status` under 250 ms warm. Profile first: they may do per-lead file reads.
3. Serve a production build (bundled, lazy routes) in cloud mode instead of the dev server. Target: < 3 MB script on first load, with heavy views lazy-loaded.
4. Still to measure (needs the real device or microphone): voice readiness, end-of-speech to first response, device dispatch, action verification, reconnect time.

## Round 2 (Agent C, 1 Oct 2026): idle polling and Leads

Measured with headless Chrome on Home, 90 s idle after a 10 s settle, hub on MU_DATA_DIR (empty), MU_HUB_ROLE=cloud.

| | Before | After |
|---|---|---|
| Jarvis HUD reads (jarvis/status, events, timers) | 3 every 5 s = 36 requests a minute, also in a hidden tab | 3 every 45 s = 4 a minute, paused while the tab is hidden; a protocol run or timer change still refetches at once |
| `/__jobs/events` | every 2 s = 30 a minute | every 15 s when no job is running (4 a minute); 2 s while a job runs or for a minute after a command (`jobs:nudge`) |
| `/__operator/agent-jobs` (running-now poll) | 6 a minute | 1.3 a minute idle, 6 a minute while something runs |
| `/__operator/away` (HUD away status) | 7.5 a minute | 1 a minute |
| Whole Home page, idle | 61 requests in 60 s | 34 requests in 90 s (about 23 a minute) |

The Jarvis HUD target (4 a minute) is met. The remaining idle traffic is `/__operator/state` (15 s), the Design ledger and job reads (30 s) and the workspace panels (60 s).

Leads, synthetic CRM of 500 leads plus 250 previews (warm, 3 runs each): `/__operator/leads/list` 4 to 5 ms, `/__lead-sites/status` 2 to 13 ms (with `?ids=` for 200 leads 6 ms), `/__operator/leads/summary` 3 ms, `/__operator/leads/calls` 4 ms, `/__operator/leads/overview` 75 to 78 ms. The 600 ms seen on the live PC is not reproducible from the code path: `/status` does one registry read and one `existsSync` per preview, which is about 1 ms a preview even at 250. No N+1 was found in the UI-facing routes, so `scripts/leads` is unchanged. The likely cause is the live hub's event loop being busy (many timers, sqlite, agents) rather than these handlers; profile on the live hub with the request timing in the Inspector before touching them.

## Activity stream (builder S, 1 Oct 2026): one SSE stream instead of overlapping polls

Hub: this worktree's OS (`vite dev`, native config) on `127.0.0.1:8114`, `MU_HUB_ROLE=cloud`, `MU_DATA_DIR` on D: (fresh), `HINDSIGHT_URL=off`,
`MU_MEMORY_WRITES=off`, empty HOME. Real headless Chrome (playwright-core), Home (`/` to `/business`), 12 s settle, then 90 s idle.
"Before" is the same build with the stream switched off in the browser (`localStorage["mu-activity-stream"]="off"`), which puts every poll back
at its old rate. Job changes were made inside the hub process (create, begin, finish after 1.5 s) so the page learns of them only from the
stream or a poll. Latency is wall clock from the server's state change to the chip's `jarvis:progress` event; 5 jobs 65 s apart (idle
between each).

| | Before (polling) | After (stream) |
|---|---|---|
| Whole Home page, idle, 90 s | 34 requests (22.7 a minute) | 27 requests (18 a minute), plus the one long-lived stream opened at load |
| Jarvis HUD reads (status, events, timers) | 6 (3 every 45 s) | 3 (3 every 90 s, as a safety net; a hint refetches at once) |
| Job events | 6 (`/__jobs/events`, every 15 s idle, 2 s busy) | 0, plus 2 `/__events/snapshot` (one a minute) |
| Job state change to chip: start | 1.2 s to 14.8 s (median 4.7 s) | 1 to 2 ms |
| Job state change to chip: finished | 0.4 s to 13.3 s (median 3.2 s) | 0 to 1 ms |
| Stream dropped (server closes it) while a job finishes | n/a | reconnected with `?last=` in 0.6 to 0.95 s, 6 trials; the finished state showed within 6 ms of the reconnect; no snapshot was needed (replay) |
| Hub killed: HUD (a second tab on `/hud`) shows offline | 37.6 s | 13.6 s (12 s of grace so a blink that reconnects does not flash) |
| Hub restarted: HUD back online after the hub answers | 6.9 s | 7.8 s to 8.8 s (bounded by the reconnect backoff, jittered, 30 s cap) |
| Outage of about 50 s: stream connection attempts | n/a (poll requests continued) | 5 (1, 2, 4, 8, 16 s backoff) |
| Open streams: Home tab plus `/hud` tab | n/a | 1 (one leader tab holds it); 0 after both tabs closed |

What did not shrink: the other Home panels (`/__operator/state` every 15 s, the Design ledger and job reads every 30 s, the workspace panels
every 60 s) are untouched, so the whole-page cut is 23 to 18 a minute; the polls this stream targets went from 12 to 5 in 90 s (8 to 3.3 a
minute). Restart recovery is not faster than polling: it waits out the reconnect backoff. A first run of this change had a bug the
kill/restart measurement caught (a nudge to reconnect on every state change made a hot loop of 19,000 attempts while the hub was down); it
is fixed (reconnect nudges only on a fresh successful read and at most once per 2 s) and the figures above are from after the fix.
Device offline latency (heartbeat TTL 30 s, hub sampler 2 s) is covered by a fake-clock test, not a live companion.

Tests: `scripts/events/stream.test.ts` (bus, 401/405/403, per-person scope in live, replay and snapshot, 100 connect/disconnect cycles with no
leaked listener, slot or timer, slow consumer dropped, replay vs snapshot on a too-old, foreign, future or malformed id, notifications only),
`scripts/events/client.test.ts` (backoff and jitter, watchdog, leader election and handover, healthy and offline rules, idempotent job folding,
a real-server drop and replay), and the real-gate matrix in `scripts/identity/route-matrix.test.ts`.
