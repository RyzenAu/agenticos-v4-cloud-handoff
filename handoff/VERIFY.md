# Verification

Commands that exist in this tree. Run focused checks while developing; run the full suite once, serially, on a final
candidate. Never run two full suites at the same time on one machine.

## Setup

```powershell
bun install            # bun.lock is in the tree; node_modules is not
```

On Windows, set these in the shell that runs the tests:

```powershell
$env:TEMP = 'D:\tmp'; $env:TMP = 'D:\tmp'                 # a temp folder on D: (a short path, with free space)
$env:Path = 'C:\Program Files\Git\bin;' + $env:Path       # Git's bash first, so `bash` is not WSL's
```

Without Git's bash first on `PATH`, `bash` resolves to WSL and the shell-script tests fail
(`docs/programme-20261001/DOT-CRM-HANDOFF.md`). One microphone-ownership test is timing-sensitive under full-suite load.

## Type checks and build

| Command | What it runs |
|---|---|
| `bun run typecheck` | `tsc --noEmit` (the app) |
| `bun run typecheck:scripts` | `tsc -p tsconfig.scripts.json` (the server scripts) |
| `bun run build` | `seed:data`, then the Vite build |
| `bun run lint` | ESLint |

## Focused tests

```powershell
bun test scripts/jarvis-command          # command service, routing, threads, Stop and eventId idempotency
bun test scripts/jev-client.test.ts scripts/jev-router.test.ts scripts/jev-command.test.ts scripts/jev-answer-validation.test.ts   # the Jev client and older router; the controller and pins are tested inside scripts/jarvis-command (`routing-r10.test.ts`)
bun test scripts/coding                  # harness: shaper, orchestrator, gate, worktree, runners, registry
bun test scripts/identity                # gate, principals, route table, server role
bun test scripts/devices                 # pairing, sessions, dispatch, resolveTarget
bun test scripts/computers               # computers, lease, terminal, workflows
bun test scripts/jobs scripts/approvals  # job and approval services
bun test scripts/agents                  # Agents workspace
bun test scripts/memory                  # memory API, guard, writer
bun test scripts/crm                     # CRM store, operations, HTTP adapter
bun test companion                       # companion wire and executors
bun test src                             # frontend unit tests under src/
```

`bun run test` is `bun test scripts` (the whole server suite). Two wrapper tests run rendered UI tests in their own
process because those install a fake DOM at import time: `scripts/r6-ui-behaviour.test.ts` and
`scripts/r7-app-usability.test.ts`.

Route-table guard: `scripts/identity/routes.test.ts` fails when a mounted `/__*` route is missing from
`scripts/identity/routes.ts` or `docs/IDENTITY-ROUTES.md`. Add a route in all three places.

Windows deploy scripts (no admin, nothing installed, fake hub and fake `bun`):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuHubWindows.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuOpsWindows.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-ReleaseRyzen.ps1   # parses the release script only
```

## A synthetic hub (never the live one)

`scripts/acceptance/r7/hub.ts` seeds, starts and stops an isolated hub. It sets `MU_SYNTHETIC_HUB=1`, points
`MU_DATA_DIR` at a synthetic folder and `HOME`/`USERPROFILE` at a sibling synthetic home, removes every inherited
variable whose name looks like a credential, sets `HINDSIGHT_URL=off`, binds `127.0.0.1` only, and refuses port 8081 and
any port outside 8120 to 8199.

```powershell
bun scripts/acceptance/r7/hub.ts seed   --data D:\AgenticOS-r7-data\h
bun scripts/acceptance/r7/hub.ts start  --port 8128 --data D:\AgenticOS-r7-data\h --role server   # or pc | cloud; --memory off|on; --triggers off|on
bun scripts/acceptance/r7/hub.ts status --port 8128
bun scripts/acceptance/r7/hub.ts stop   --data D:\AgenticOS-r7-data\h
```

`--repo <worktree>` serves another tree (a frozen candidate). `MU_SYNTHETIC_HUB=1` on a hub you start by hand gives it
its own empty CLI homes (`scripts/cli-home-guard.ts`) and isolated memory (`scripts/memory/synthetic-guard.ts`); a
synthetic hub therefore has no signed-in coding accounts unless you sign one in for it.

A read-only copy beside a live hub: `AGENTIC_OS_NO_BACKGROUND=1`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, a port
other than 8081, `bun --bun run dev --port <port> --strictPort --host 127.0.0.1`.

## Acceptance and journey scripts

All of these drive a **synthetic** hub that is already up, one browser at a time.

| Script | What it checks |
|---|---|
| `bun scripts/acceptance/r7/run-all.ts --hub http://127.0.0.1:8128 [--only <names>] [--label <name>] [--out <dir>]` | The round 7 journeys in order: `routes-sweep`, `journey-b-session`, `journey-e-bots`, `journey-g-crm`, `journey-f-coding`, `journey-d-stop`, `journey-i-vercel`, `isolation`, `journey-j-routine`, `journey-l-restore` (the last restarts the hub itself) |
| `bun scripts/acceptance/r10/biz-acceptance.ts --hub <url> --data <dir> --out <dir>` | Business rows 15 and 16: find a synthetic client, note, linked task, quote and invoice drafts, read back after reload |
| `bun scripts/acceptance/r11/staging-flows.ts --hub http://127.0.0.1:8191 --data <dir> [--only send,overlay]` | The Jarvis send and Stop flows through the real UI on a server-role synthetic hub |
| `bun scripts/acceptance/r11/probe.ts`, `send-probe.ts`, `err-probe.ts`, `a11y-sweep.ts` | Round 11 probes (read each header for its arguments) |
| `bun scripts/jobs/journey-r10-loops.ts --hub <url> --data <dir> --out <dir> [--only ...]` | Round 10 loops 2 and 3 through the real executors on a synthetic server-role hub: research on a bot computer, and a coding job pinned to an account and model |
| `bun scripts/acceptance/run.ts` | The earlier programme acceptance runner (`ACCEPT_*` variables, see `CONFIG.md`) |
| `bun run jarvis:acceptance` | `scripts/capability-acceptance.ts`: the capability registry acceptance |

These scripts write screenshots and results under `docs/programme-20261001/evidence/...` or the `--out` folder. That
output is evidence: keep it out of this repository.

## What was run on this handoff tree

- The 22 test files that touch a sanitised value: 2,357 tests pass, 0 fail (site-draft client QA and evidence, inbox
  triage, Hermes customise, dream, automations, `scripts/away-mode/`, the five safety-review files, audit F4, S2D review
  fixes, business economics).
- `bun run typecheck` and `bun run typecheck:scripts`: both exit 0 with no errors on this tree.
- The full suite and the release gate were **not** run on this tree. Run them before treating a change built on it as a candidate.
