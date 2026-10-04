# Dependency isolation, search health and restart resilience (round 6, Builder D)

## What went wrong on 2 Oct 2026

The OpenShell experiment upgraded Kali's Python from 3.13 to 3.14. SearXNG's virtualenv (`~/searxng-venv` in `kali-linux`) was built with `virtualenv` on the
distro's `python3`, so its interpreter link pointed at a Python that no longer existed. SearXNG stopped, research and lead discovery got connection errors, and
(before this round) some of those paths read an empty answer as "no results". An experiment broke something operational because they shared an interpreter.

## Rules (enforced, not just written)

`config/python-envs.json` lists every Python environment the OS depends on as `operational` or `experimental`. `scripts/ops/python-envs.ts` validates it and
`bun test scripts/ops` fails on a violation:

1. Every environment has a class and a path; ids are unique.
2. Two operational environments never share a path.
3. An experimental environment is never at, under or over an operational path on the same host.
4. An experimental WSL environment lives under `~/experiments/` (never loose in the distro).
5. No repo script (`scripts/`, `deploy/`, `companion/`) installs into a system Python (`--break-system-packages`, `sudo pip`). Docs are exempt: they record history.

Human rules that code cannot see: an experiment never upgrades, replaces or `apt`-upgrades the distro's `python3`; it uses its own venv under
`~/experiments/<name>/`, or a container. An operational venv is rebuilt from a pinned interpreter (for example `uv python install 3.13`, then
`uv venv --python 3.13 ~/searxng-venv`), not from the distro's symlinked `python3`. SearXNG's venv is flagged `interpreterPinned: false` in the registry as a known
risk: rebuild it that way the next time it is touched. **This round did not modify the live Kali/WSL packages.**

## After any environment change

```
bun run check:search            (or: bun scripts/ops/check-search.ts [--no-wsl])
```

It prints one `PASS`/`FAIL` line per check with a "do this" line for each failure, then `RESULT: PASS` or `RESULT: FAIL`, and exits 0 or 1. It only reads:

| Check | What it proves |
|---|---|
| environments | the registry is valid and no script installs into a system Python |
| searxng interpreter | the SearXNG venv's Python still runs (`python --version`, read-only, inside WSL) |
| searxng health | SearXNG answers `/healthz` |
| search | one real query through the same client research and lead discovery use returns results |
| lead discovery | discovery's own search step reaches SearXNG and counts as an answer |

Run on the live PC on 2 Oct 2026 it printed `RESULT: PASS (5 of 5 checks)` (Python 3.14.7 in the venv, 28 results, one engine, Brave, suspended for too many
requests, reported rather than hidden). `scripts/ops/check-search.test.ts` runs it against a dead port and requires `RESULT: FAIL`.

## Search: three answers, never two

`scripts/search/searxng.ts` is the one client (lead discovery, the phone finder and bounded research all use it): `results`, `no_results` (the engines answered
and have nothing) or `unavailable` (not running, timeout, HTTP error, not JSON, or no engine returned anything while at least one refused: one, two or ten engines, so a one-engine instance that refuses is never a "no"). Behaviour end to end:

| Layer | Search unavailable | Search empty |
|---|---|---|
| Research (`research.ts`) | one failed result flagged `searchUnavailable`, note "Web search is unavailable (...), so I could not look. That is not the same as finding nothing." Stops after one query; nothing opened | "searching found nothing usable" |
| Lead discovery | "could not search" (`unverifiable`) with the reason; never "no website" | confirmed `none` |
| Phone finder | throws `SearchUnavailable`; the batch backs off and leaves the lead for later | `[]`, the lead is marked looked-at |
| Hub health | `/__health` lists search as unavailable, degraded, with recovery text | n/a |

Two defects were fixed on the way: a SearXNG answer with every engine refusing used to count as an "answer" in lead discovery, and lead discovery ignored
`MU_SEARXNG_URL` (research honoured it); all three now share one base URL.

Tests: `scripts/search/search-availability.test.ts` (11), `scripts/ops/check-search.test.ts`.

## Startup health check and monitor

`scripts/ops/dependencies.ts`, started by `scripts/ops/monitor-plugin.ts`, reports SearXNG, Hindsight, companions and model routes as `healthy` or
`unavailable` in `GET /__health` (`dependencies`, with `since`, `failures`, `alert`, `recovery`; an unavailable one makes the report `degraded`). At startup each is
tried up to 3 times with 1 s and 2 s gaps; an unavailable one raises ONE alert line; afterwards re-checks run every 2 minutes (healthy) or at 15 s, 30 s, 1, 2 then
every 5 minutes (unavailable); a recovery raises one line. Timers are unref'd and stopped when the server closes; a quiet copy (`AGENTIC_OS_NO_BACKGROUND`) probes
nothing. Probes are health GETs or local state reads: no search query, no credentials. Tests: `scripts/ops/dependencies.test.ts` (12).

## Restart resilience

`scripts/resilience/resilience.test.ts` (13 tests, real hub, job store, lease manager, companion worker and memory connector; simulated host and Hindsight). Side
effects are counted by recording executors, so a replay shows as 2.

| Failure | Ends as | Side effects |
|---|---|---|
| Hub killed mid-job (kill -9; the old runner is frozen, the store is read directly and still says `running`) | the NEW hub settles it at startup: `unknown`, "Interrupted by a restart ... not re-run"; computer reconnects and works | in-flight step once, later steps never; unchanged 2.5 s later |
| Tunnel loss while a job runs | never `succeeded`; computer not shown online; ends `unknown` after the 30 s presence TTL; online again on return | step once; recorded end does not flip |
| Supervised ssh dies 3 times | one ssh alive at any moment, bounded backoff, up only after the positive echo, nothing restarts after close | each attempt writes its marker once |
| Browser crash mid-step | job failed with the reason; computer not locked | navigation once, no silent retry; later steps never; next job runs |
| Stale lease | freed after TTL; the dead job's late command (old epoch) refused; a walked-away person returns control to the paused job once | none |
| Computer killed mid-step | `unknown` in seconds (not a timeout) | step once; recover does not replay |
| Memory outage | queued, reported; a burst of syncs makes at most one attempt (backoff); recovery sends once; a lost response replays without a second memory | one retain after recovery |
| Duplicate events | job and step events folded twice, interleaved or replayed give the same state; a report delivered 4 times (2 concurrent) lands once; a finished job is not rewritten | none |

Harness changes: `close({ abrupt: true })` freezes the old hub (its store handle is closed first, so nothing more is written) and a restarted hub runs `jobs.recover()` exactly as `scripts/jobs/runtime.ts` does. No product defect was found by this: the first version of the test let the dead hub settle the job itself and never exercised the restart path. A graceful hub stop ends a running job as
`cancelled` (its step really was stopped), a hard kill as `unknown`.
