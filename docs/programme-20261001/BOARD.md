# Programme board: AgenticOS business workspace (from 1 Oct 2026)

Lead: Claude Opus 5.5 (architecture, contracts, integration, acceptance). Builders: Sonnet agents on isolated worktrees. The integration branch is `prog/integration-20261001` at `D:/AgenticOS-prog-int`. Base: `bc4678a` (canonical `jarvis-voice`, live on 8081).

Status words, in order: **planned → implemented → tested → merged → live → verified in use.**

## Baseline (checked 1 Oct 02:40 AEST)

| Fact | Evidence |
|---|---|
| Canonical and live are both `bc4678a`, v3.6.1, dirty build | `git rev-parse`; `/__version` |
| Canonical has 10 pre-existing dirty/untracked docs and skills (owner's) | `git status`; left untouched |
| No companion has ever been enrolled. 344 browser sessions are recorded, all Usman's, and the ones sampled are revoked | `devices.json` counts, no identities read |
| **Tailscale on this PC is not working:** BackendState `NoState` ("starting", can't reach coordination), two `tailscaled` processes, 0 peers. Mehroz's remote access is down | `tailscale status --json` |
| Hindsight 127.0.0.1:8888 is healthy and its database is connected | `/health` |
| `claude:max` is connected (CLI 2.1.280), but weekly usage is **100%** until 5 Oct | `/__operator/coding/accounts` (redacted) |
| `claude:max-2` is connected (CLI 2.1.280), weekly usage 4%. Sonnet and Opus are verified on it | same |
| `codex:openai-2` is at 98% peak and **paused until the owner runs `codex-isolation.ts --apply`** | same |
| The coding harness pins model id `claude-sonnet-5`, not `claude-sonnet-5-5`. The actual model reported back is not yet shown in receipts | `scripts/coding/spec.ts:38` |
| The cloud-UX candidate (NEXUS, device routing, memory/finance) is already merged into canonical | `git merge-base` |
| Receptionist: `D:/MU-Receptionist` is on `feat/sale-ready-20260927` `e501e08`, with newer branches that are unmerged | `git branch` |

## Workstreams

| Agent | Scope | Worktree / branch | State |
|---|---|---|---|
| A (Sonnet) | Cloud hub mode, data dir, health, backup/restore, deploy/, architecture + hosting assessment | `D:/AgenticOS-prog-a-cloud` · `prog/a-cloud-20261001` | running |
| B (Sonnet) | Companion as the executing device: executors with verification, job/step wire contract, expiry/dedupe/cancel/observe-before-retry, logon install, real local proof | `D:/AgenticOS-prog-b-worker` · `prog/b-worker-20261001` | running |
| C (Sonnet) | Rendered route audit, shared tokens/components, motion module, device status slot | `D:/AgenticOS-prog-c-ui` · `prog/c-ui-20261001` | running |
| D (Sonnet) | Coding real execution + model ids/receipts, Hindsight–Obsidian live journeys | `D:/AgenticOS-prog-d-coding` · `prog/d-coding-20261001` | running |
| E (Sonnet) | Receptionist branch reconciliation, readiness matrix, live acceptance checklist | `D:/MU-Receptionist-wt-prog-20261001` · `prog/rx-integration-20261001` | running |
| Lead | Jarvis skill assessment (done), board, integration, full gate, live acceptance | `D:/AgenticOS-prog-int` | active |

## Stage plan

0. Reconcile and define acceptance: **in progress** (this board)
1. Repair current critical journeys (real account execution, Jarvis continuity, broken controls, persistent edits)
2. Cloud-to-one-PC vertical slice: a separate hub process (cloud mode, isolated data) → Jarvis → Jev → Usman's companion → verified action → result in the hub job
3. Second device (Mehroz): **blocked** on Tailscale being healthy and on Mehroz's PC
4. Cloud persistence and services: **needs owner approval** of VM hosting (Agent A brings the recommendation)
5. Interface and motion across every route (Agent C)
6. Memory, coding and business acceptance
7. Release and handoff

## Owner actions (bundled; nothing needed right now)

1. Tailscale on this PC: open the Tailscale app, then quit and restart it (or restart the Tailscale service as admin). It is stuck "starting" and has two daemons.
2. Codex isolation: run `bun scripts/coding/codex-isolation.ts --apply` once from the live checkout, if Codex roles are wanted.
3. Hosting: approve or reject the VM recommendation when it arrives (a new monthly charge).

## Acceptance matrix (17 journeys; status is updated as evidence lands)

| # | Journey | Status | Evidence |
|---|---|---|---|
| 1 | Cloud workspace while Usman's PC is offline | **tested locally** (cloud-role hub on 8110, companion offline: pages render, command honestly refused 'Usman's PC is offline… never send to another machine'); real VM blocked on hosting approval | SLICE-EVIDENCE.md |
| 2 | Sign in as Usman, identify device | **tested locally**: confirmed browser session → pairing code → companion 'Usman's PC', displayLabel 'This PC' | SLICE-EVIDENCE.md |
| 3 | Open Chrome on Usman's PC, verify window | **tested on real PC** via full cloud-role hub (2.3 s, handle read back) | SLICE-EVIDENCE.md |
| 4 | Navigate without false success | **tested on real PC** (title match); compound 'tab→YouTube→search' honestly refused → agent B building screen.goal | SLICE-EVIDENCE.md |
| 5 | PowerPoint bounded task | **tested on real PC**: blank deck created + read back (Office is licensed now); splash-title verification weakness → agent B | SLICE-EVIDENCE.md |
| 6 | Cancel multi-step, later actions stop | **tested on real PC** (agent B, isolated hub) | worker-evidence.md |
| 7 | Resume without replay | agent B | |
| 8 | Worker disconnect mid-task, honest state | **tested on real PC**; job now settles `unknown` (lead fix 65a94f9) | worker-evidence.md |
| 9 | Mehroz's session controls his desktop only | blocked (Tailscale, Mehroz PC) | |
| 10 | Lead edit survives refresh and import | implemented f5125f3; re-verify | |
| 11–12 | Real coding task on Claude account two; account/model/CLI/diff/tests/result | partly done 30 Sep (job 286ff8fb); model-id receipt gap | |
| 13 | Microphone → coding assignment | needs owner (physical mic) | |
| 14 | Memory save/recall/correct/delete (synthetic) live | agent D | |
| 15 | Obsidian edit/rename, no duplicates | agent D | |
| 16 | Receptionist usage + Professional example A$1,373.90 | planned | |
| 17 | Dental flagship generate + deploy | done 30 Sep (b2127f6); re-verify | |
| 18 | Restart without losing jobs/decisions/records | **tested** (cloud-role hub restart: 5 jobs + device pairing kept, version reports new SHA, companion shown offline) | SLICE-EVIDENCE.md |
| 19 | Backup restore into isolated env | **tested** on synthetic data (row counts + checksums match; stores reopen) | CLOUD-ARCHITECTURE.md / agent A |
| 20 | Main pages desktop/mobile, keyboard, reduced motion | agent C | |

## Extension (owner brief, 1 Oct): shared agent cloud computers + personal-PC ownership

| Target | Usman | Mehroz |
|---|---|---|
| Usman's personal PC | control | **denied** |
| Mehroz's personal PC | **denied** | control |
| Shared agent cloud computers | control + takeover | control + takeover |

Design (lead): a shared cloud computer is an isolated Linux desktop running the **same companion worker**, registered in the **same device store** as kind `cloud-computer`, owner `shared`, with a control lease (one controller; human takeover pauses at a step boundary; leases expire). Viewer only through the authenticated hub proxy. First provisioning adapter: WSL2 on this PC (stands in for a VM); VPS adapter documented.

Evidence labels: **mocked · synthetic integration · real local computer · real cloud VM · real remote device · live provider.**

Status words: planned → implemented → reviewed → integrated → deployed → verified in actual use.

| # | Journey | Owner | Status | Evidence label |
|---|---|---|---|---|
| X1 | Real cloud hub starts, serves authenticated sessions | A / owner (VM) | blocked: VM purchase | real local computer (cloud role on this PC) |
| X2 | Usman and Mehroz share business records | lead | planned (identity routes exist; needs Mehroz session) | |
| X3 | Usman controls his own enrolled PC | B | tested | real local computer |
| X4 | Mehroz controls his own enrolled PC | owner + Mehroz | blocked: his PC + Tailscale | |
| X5 | Cross-owner personal-PC commands rejected before dispatch | B | **integrated + tested** (no command row queued; body ids ignored; revoke/re-pair) | real local computer (Usman) + synthetic second companion (Mehroz) |
| X6 | Both users control a shared cloud desktop | F | **integrated + tested** headless (both founders dispatch and take over; desktop packages not installed yet) | real local computer (WSL) |
| X7 | Two agents on separate cloud computers concurrently | F | **integrated + tested** headless (overlapping jobs on 'research' and 'builder') | real local computer (WSL) |
| X8 | Human takeover pauses agent, returns control | F | **integrated + tested** (pause at step boundary, return resumes same job without replay; abandoned viewer freed in 20 s) | real local computer (WSL) |
| X9 | Cloud jobs continue with personal PCs offline | F | by design (computer jobs never touch personal PCs); computers keep working through a hub restart (back online ~11 s). End-to-end with both PCs actually off needs the VM | real local computer (WSL) |
| X10 | Personal-PC commands fail honestly when offline | lead | tested | real local computer |
| X11 | Compound Chrome navigation finishes on intended computer | B | **integrated + tested**: "new tab → YouTube → search Sydney weather" verified (12 videos listed) via screen.goal; "switch back to the website we were using" verified (149 ms, independent foreground check) | real local computer |
| X12 | PowerPoint usable presentation, not splash | B | **integrated + tested** (real "Presentation1 - PowerPoint" window; splash rejected) | real local computer |
| X13 | Stop prevents subsequent actions | B | **integrated + tested** (typed steps and screen.goal; "stop that task") | real local computer |
| X14 | Disconnect/uncertain → no duplicates | B | tested | real local computer |
| X15 | Jobs, pairing, working files survive restart | lead / F | **tested**: jobs + pairing (lead, cloud-role hub restart); computer workdir file survives computer stop/start and hub kill/restart (F) | real local computer (WSL + cloud-role hub) |
| X16 | Real coding job records actual account/model/result | D | **integrated + tested**: job 20cef94d on claude:max-2, builder requested+reported claude-sonnet-5-5, reviewer claude-opus-5-5, CLI 2.1.280, +7/−1 in isolated worktree, tests 2/0, review approve, gate 8/8 | live provider (throwaway repo) |
| X17 | Hindsight + Obsidian memory journeys | D | **tested** 21/21 (save, cited recall, dedupe, correct/supersede, delete, note edit/rename/copy/reindex/delete; cleanup proven); processing model reported openrouter/deepseek-v4.1-flash. Ran on a disposable bank of the real Hindsight stack, not the live bank (live writes are owner-session gated) | synthetic integration on real engine |
| X18 | UI performance vs measured browser baseline | C | in progress | |

Active builders (Sonnet 5.5, `claude-sonnet-5-5`, self-reported by each): B (companion goals + ownership + Mehroz package), C (round 2 + Computers page + perf), D (coding/accounts/memory), F (cloud computers + OpenMausBot adoption). E2 finished (sales consistency, awaiting merge).

### Owner actions (updated)

1. **Tailscale on this PC** is stuck "starting" (two daemons). Restart the Tailscale app/service. This blocks Mehroz's access and journey X4.
2. **Desktop packages for cloud computers (free, this PC):** `wsl -d kali-linux -- sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` (about 164 MiB, asks for your password). This enables screens, preview and takeover with a real display.
3. **VM (A$39.20/mo ex GST, BinaryLane Sydney 4 vCPU/8 GB):** approve, or keep everything on this PC for now. Needed for X1/X9 "PCs off".
4. **Codex isolation `--apply`:** only if you want Codex coding roles.

## Reference adoption summary (details: REFERENCE-ADOPTION.md, COMPUTERS-REFERENCES.md, VOICE-TURNS.md, OPENMAUSBOT-ADOPTION.md)

| Reference | Decision | Why (evidence) |
|---|---|---|
| agent-browser 0.37.1 | **adapted**: strict tab binding + per-companion sessions | it navigates a neighbouring tab after a closed tab id (reproduced on 0.37.1 and 0.38.1); 6 real journeys pass |
| Cua Driver 0.31.0 (MIT) | **deferred** | real Windows comparison: launch 7–11 s vs our 1.4 s; background hotkeys failed; only gain was no-focus typing; structured failure codes copied as an idea |
| OpenMausBot @90ffde7 (Apache-2.0; enterprise/ excluded) | **adapted patterns, no code** | capabilities/readiness, dedicated computers, takeover lifecycle |
| noVNC 1.7.0 (MPL-2.0) | **adopted** | viewer through authenticated hub WS; view-only unless lease holder (tested vs a test RFB server; real x11vnc owed) |
| Kasm `kasmweb/chrome:1.19.0` | **not adopted** | standalone image lacks audio/upload/download/mic, and exposes its own HTTPS+password outside our auth/lease |
| LiveKit Agents @d251b89 (Apache-2.0) | **adapted patterns** | endpointing, interruption, false-interruption recovery, stop disambiguation (synthetic; owner mic test owed) |
| OSWorld | **in progress** (Agent D) | outcome-based evaluators |
| E2B Desktop | **deferred** | ~US$121/mo always-on, no confirmed AU region, needs account+card; persistence via pause |

## Reference licences (lead, 1 Oct 2026)

| Reference | Commit | Licence | Reuse rule |
|---|---|---|---|
| Open Dot (composio-community/open-dot) | f838e17 | No licence file or field (GitHub: none). Authors describe it as "open source" (README; electron/package.json) and publicly as "free and open source" (Karan Vaidya, Composio, post of 1 Oct 2026). Owner accepts this as permission. | Adapt with a header naming repo+commit, listed in THIRD-PARTY-NOTICES.md; keep adapted parts identifiable so they can be stripped from any public AgenticOS release unless the authors add a licence |
| Matt Pocock skills | d81f3a1 | MIT | Adopt/adapt with notice |
| context-mode | 573e697 | Elastic License 2.0 | Internal M&U coding use only; not part of any client-facing/hosted offering without a licence review |
| NVIDIA OpenShell | 2935e97 | Apache-2.0 | Adopt with NOTICE; needs Linux or WSL2 (experimental) + Docker/Podman/VM |

Queued tracks (start when builder slots free; max five Sonnet builders): engineering skills, context-mode pilot, OpenShell pilot, Open Dot triggers/routines, independent verification.

## Known defects logged (lead, 1 Oct)

- Memory screen over-blocks some ordinary URLs with a path ("the docs are at https://example.com/guide", "ssh://git@github.com/org/repo") as secrets. Live at e586622 and unchanged by round 3. Next: tune the URL handling in scripts/memory/guard.ts with tests (must keep credential URLs refused).
- Shared computers: about 4 in 10 `input.scroll` steps on pages that scroll an inner container report "did not scroll" (honest, not silent). Next: scroll the focused scrollable element.

## Round 4 (1 Oct, from 2a1310c)

| Builder (Sonnet 5.5, verified) | Scope | Branch | State |
|---|---|---|---|
| B1a | Model-selection successor (fd219e20), shaper paths and reviewer independence, finance dates (4465ff87), ACL-test diagnosis | `r4/coding-jobs-20261001` | merged, tested |
| B1b | Coding job glance, reassign on Resume, baseline-aware gate, typed paid notice | `r4/coding-ui-20261001` | merged, tested |
| B2 | Bot scrolling and research | `r4/computers-20261001` | merged, tested (real local WSL) |
| B3 | Memory URL screen; receptionist launch pack | `r4/memrx-20261001`; receptionist `r4/launch-pack-20261001` | merged (AgenticOS); receptionist pack on its branch |
| B4 | Cloud activation pack, Tailscale diagnosis, Mehroz package | `r4/cloud-20261001` | merged, tested |
| Reviewer ×2 (Opus 5.5, verified) | Independent reviews | — | 2 blockers + 15 should-fix items, all fixed |
| Lead | Creative review, integration, serial gate (`460cb7a`: 10,656/0), live update | `r4/integration-20261001` | see HANDOFF.md |

## Round 5 (1–2 Oct, from af45e77)

**Brooke's website: in progress with Dot.** It is excluded from every assignment, edit, test, merge and deploy in this programme. No completion is claimed here.

| Track | Scope | Branch | State |
|---|---|---|---|
| A (Sonnet 5.5) | Ryzen-PC LAN bot host: SSH adapter → `wsl.exe`, reverse tunnel, per-computer Linux users, sandbox on, fonts, real-host acceptance | `r5/lan-bots-20261001` | merged; real LAN host evidence in LAN-BOT-HOST-EVIDENCE.md |
| B (Sonnet 5.5) | Jarvis conversation loop: live progress, one spoken completion, person-scoped | `r5/conv-loop-20261001` | merged; synthetic + own-hub rendered |
| C (Sonnet 5.5) | Interface audit (36 routes), Coding "Mark superseded" | `r5/ui-20261002` | merged; rendered at 1440/390 |
| D (Sonnet 5.5) | Memory acceptance on the real engine (disposable bank), guard false positives; receptionist readiness + single live runbook | `r5/memrx-20261002`; receptionist `r5/readiness-20261002` | merged (AgenticOS); receptionist on its branch, NOT SAFE TO SELL |
| F (Sonnet 5.5) | Creative production prep (no paid generation), adoption reconciliation | `r5/creative-20261002` | merged |
| Reviews (Opus 5.5) | LAN ×2, conversation loop, interface, memory guard ×2 | — | findings fixed; see GATE-RESULT.md |
| Lead | SearXNG venv repair (Python 3.14), integration, serial gate, live update | `r5/integration-20261002` | see HANDOFF.md |

**Cloud server:** declined by the owner (1 Oct). Not purchased.

## Round 6 (2 Oct, from 228bd232)

Plan: R6-PLAN.md. Gate: GATE-RESULT.md. **Brooke's website: in progress with Dot.**

| Track | Scope | Branch | State |
|---|---|---|---|
| A (Sonnet 5.5) | Interface cleanup, control inventory, Dot Leads UI reconciliation | `r6/ui-20261002` | live |
| B (Sonnet 5.5) | Coding reliability | `r6/coding-20261002` | live; verified on a test hub |
| C (Sonnet 5.5) | Bot workflows, conversation continuity | `r6/bots-20261002` | live code; real Ryzen-PC via test hub only |
| D (Sonnet 5.5) | Performance, search availability, health, resilience, disk report | `r6/perf-20261002` | live |
| E (Sonnet 5.5) | Receptionist launch preparation | `r6/launch-20261002` (receptionist repo) | reviewed, not merged, NOT SAFE TO SELL |
| Dot | Leads improvements package | `r6/dot-leads-20261002` | live, reconciled |
| Reviews (Opus 5.5) | receptionist, coding, performance, bots, interface + Leads | — | findings fixed |
| Lead | Films, integration, serial gate, live update | `r6/integration-20261002` | see HANDOFF.md |

## Round 8 (3 Oct 2026, from 13:30 AEST): finish, test and release

Live on Ryzen: `5fc21c05` (rollback tag `rollback/pre-agents-20261002` → `1eeb96ca`). Release candidate: `r7/candidate-20261003` @ `74ace895`,
frozen; serial gate running. Next integration batch: `r8/next-20261003` (`D:/AgenticOS-r8-next`). Up to eight model instances including the lead.

| Track | Owner (model) | Worktree · branch | Owned files | State |
|---|---|---|---|---|
| Lead | Opus | `D:/AgenticOS-r7-candidate`, `D:/AgenticOS-r8-next` | `scripts/identity/**`, `scripts/operator-plugin.ts`, release scripts, BOARD, merges | gate → release |
| A: CRM + Dot's deliverables | Opus | staging `D:/AgenticOS-staging/dot-deliverables-20261003` (outside Git) | import plan and preview only; CRM writes after release, against a copy first | downloads hash-verified; plan running |
| B: generator repairs | Sonnet | `D:/AgenticOS-r8-b-generator` · `r8/b-generator-20261003` | `scripts/lead-sites/**`, `scripts/leads/**` EXCEPT the owner's uncommitted overlay paths (patches only) | running |
| C: Agents journey + desktop | Opus | `D:/AgenticOS-r8-c-agents` · `r8/c-agents-20261003` | `src/routes/agents*`, `src/components/agents/**`, `scripts/computers/**`, `scripts/jobs/**`, `scripts/agents/**` | running |
| D: deal desk | quoting session (Opus) | its own `int/deal-desk-motion-20261003` | `tools/deal-desk/**`, deal-desk routes, motion kit | rebasing onto `74ace895` |
| E: interface polish | Sonnet | `D:/AgenticOS-r8-e-polish` · `r8/e-polish-20261003` | non-agents pages; not identity, CRM or lead-sites | running |
| F: operations | Opus | `D:/AgenticOS-r8-f-ops` · `r8/f-ops-20261003` | `deploy/windows/**`, backup scripts; Ryzen read-only | running |
| Reviewer | Opus | read-only | reviews each branch as it arrives | reviewing the unreviewed part of `74ace895` |

Shared-file resolver: the lead, for any file two tracks need. Heavy verification runs one at a time per host.
