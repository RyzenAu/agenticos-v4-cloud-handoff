# Round 6 plan (2 Oct 2026, from `228bd232`)

Lead: Opus 5.5. Builders: Sonnet 5.5, at most five active including reviewers. Integration: `r6/integration-20261002` at `D:/AgenticOS-prog-int`. Rollback: `rollback/pre-r6-20261002` (= `228bd232`).

**Baseline verified by the lead at start:** live `/__version` = `228bd23`; every round-5 branch is 0 commits ahead of `jarvis-voice`; all round-5 worktrees clean; no test hubs listening; no earlier builders running. Owner's 11 dirty entries hashed before work. C: 16.9 GB free, D: 273.8 GB free.

**Brooke's website: in progress with Dot.** Excluded from everything here.

| # | Outcome | Owner | Branch / worktree | Port | Acceptance | Evidence at start |
|---|---|---|---|---|---|---|
| 1 | Clear, usable OS pages; every control works, saves, fails and recovers | Builder A | `r6/ui-20261002` · `D:/AgenticOS-r6-ui` | 8151 | Every route rendered at 1440 and 390 in empty, populated, loading, failed and awaiting states; control inventory with a result per control; lead edits survive refresh and import; "Needs you" counts equal their linked lists | R5 audit of 36 routes (UI-AUDIT-R5.md) |
| 2 | Reliable coding jobs | Builder B | `r6/coding-20261002` · `D:/AgenticOS-r6-coding` | 8152 | The 14 behaviours in brief section 4 each have a passing test or a real-harness run in a throwaway repo; receipts show the responding model | R4/R5 fixes; real job 20cef94d |
| 3 | Useful bot workflows and conversation continuity | Builder C | `r6/bots-20261002` · `D:/AgenticOS-r6-bots` | 8153 | Research, Builder, Website audit and Business preparation each return a saved artifact to the asking conversation once; concurrent run, takeover, Stop, reconnect and persistence on the real Ryzen-PC via a test hub | LAN-BOT-HOST-EVIDENCE.md (test hub) |
| 4 | Faster loading, lower idle overhead; dependency and restart resilience | Builder D | `r6/perf-20261002` · `D:/AgenticOS-r6-perf` | 8154 | Before/after numbers for first-load size, time to usable, idle requests; search "unavailable" is distinct from "no results"; startup health checks; disk report (no deletion) | PERF-BASELINE.md |
| 5 | Receptionist launch preparation | Builder E | `r6/launch-20261002` · `D:/MU-Receptionist-wt-r6` | 8155 | Section 10 items each have a synthetic test; Professional = A$1,249.00 + A$124.90 = A$1,373.90, no setup; runbook rehearsed against synthetic providers; stays NOT SAFE TO SELL | 1,991 tests, 50/50 evals on `r5/readiness-20261002` |
| 6 | Finished promotional films | Lead | `r6/integration` | — | Spend reconciled first; two films exported with Scotty narration; claims checked | graphics tracks, captions, edit lists; 0 clips |
| 7 | Review, integration, one serial gate, live update | Lead + Opus reviewers | `r6/integration-20261002` | 8141 | Reviews fixed; full suite, both typechecks, build, clean frozen copy, rendered routes; owner hashes unchanged; `/__version` verified | — |

Shared resources: X display numbers 60–69 belong to Builder C. Nobody stops a process they did not start. The live hub on 8081, Hindsight on 8888 and SearXNG on 18888 are read-only for builders.
