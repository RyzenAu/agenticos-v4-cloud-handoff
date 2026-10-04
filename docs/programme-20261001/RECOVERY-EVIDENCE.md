# Job recovery after hub or worker termination: full OS (lead, 1 Oct 2026 ~05:42 AEST)

**Setup.**
- **Hub:** the full Vite OS from `prog/integration-20261001` at `2608534`, run as `MU_HUB_ROLE=cloud` with a fresh `MU_DATA_DIR` (`D:\prog-slice\rec-data`) on `127.0.0.1:8110`.
- **Companion:** a real process paired as `usman` ("Usman's PC") through a confirmed browser session on the hub.
- **Jobs:** each was a typed Jarvis command posted to `/__operator/screen/command` with three typed steps: `echo`, then `wait 30 s`, then `echo`. Processes were killed with `Stop-Process -Force` (a hard kill, no goodbye).

**Label:** real local computer, with the hub standing in for the cloud and running on this PC.

## A: worker (companion) killed during step 2

| Observed | Value |
|---|---|
| Job state | `unknown` (read from `jobs.sqlite` and `/__jobs/:id`) |
| Steps | `echo: ok` · `wait: unknown` · `echo: skipped` |
| Jarvis said | "Usman's PC went offline while step 2 (wait) was running, so I can't say whether it happened. I haven't tried it again or run the later steps, and nothing ran anywhere else." |
| Time to an honest outcome | 40 s after the command started (offline detection) |
| Companion restarted | ledger `s1: done`, `s2: interrupted`. The companion answered the hub's observe with `interrupted`. No step re-ran and step 3 never ran |

## B: hub killed during step 2

| Observed | Value |
|---|---|
| Companion while the hub was down | "hub unreachable…; not taking commands until it's back". The running step was aborted locally (ledger `s2: cancelled`); fail closed |
| Hub restarted (same data dir) | job `6b51cf02` → `unknown`, note "Interrupted by a restart: the outcome is unknown and it was not re-run." |
| Companion | reconnected ("online as …") and took no new command for that job. Step 3 never ran; the ledger has no new entries |
| Other records | job A kept its `unknown` state and note across the restart |

## Not covered here

- Reboot of the PC, and sleep and resume.
- A hub on a real VM, where the companion reaches it over Tailscale.
- Agent F proved the same for shared computers: a computer killed mid-step went `failed` → recovered, its job ended `unknown` with no replay (COMPUTERS-EVIDENCE.md).
