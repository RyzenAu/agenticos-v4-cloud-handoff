# Round 7 acceptance matrix (worker H, 3 Oct 2026)

Worker H, independent acceptance and integration reviewer. Model: Claude Opus 5.5 (`claude-opus-5-5`). Branch `r7/h-acceptance-20261003`, base
`491b8ee0`. Read-only for product code. This page owns the matrix; the runnable checks are `scripts/acceptance/r7/**`.

**Phase 1 status:** the matrix covers all 44 route files (47 URLs incl. unknown ids and a 404) and the owner's journeys A–L plus personal-device
isolation. The synthetic-hub scripts ran against the baseline `491b8ee0`: **380 PASS · 13 FAIL · 18 BLOCKED · 1 NOT RUN · 6 OUT OF SCOPE**
(raw results: `scripts/acceptance/r7/results/baseline-491b8ee0/`).

**Phase 2b status (final pre-gate candidate `e8d04d69`, every worker merged):** **434 PASS · 0 FAIL · 11 BLOCKED · 1 NOT RUN · 6 OUT OF
SCOPE**, no release blocker; see section 11. Raw results: `scripts/acceptance/r7/results/candidate-e8d04d69/`.

**Phase 2a status (preliminary candidate `r7/candidate-20261003` @ `4d97c98b`, without D):** **429 PASS · 3 FAIL · 13 BLOCKED · 1 NOT RUN ·
6 OUT OF SCOPE**. No FAIL is a release blocker; see section 10. Raw results: `scripts/acceptance/r7/results/candidate-4d97c98b/`.

## 1. How to read this

**Status words, used precisely.**

| Status | Meaning |
|---|---|
| PASS | The expected effect was observed AND persisted: re-read after a reload, in a second browser, or through the app's own API. A toast, an HTTP 200 or a screenshot alone is never a pass. |
| FAIL | Observed, and the observed state was wrong. Each FAIL has a finding below. |
| BLOCKED | Could not run in this environment for a stated reason (no computer host, no CRM mount, no account). Not a judgement of the code. |
| NOT RUN | Could run here but has not been run yet (or not in this phase). |
| OUT OF SCOPE | Not this worker's to run from this worktree (production, real devices, Dot's cloud browser). Who runs it is named. |

**Environments.** SYN = synthetic local hub (this worktree, `127.0.0.1:8128`, data `D:\AgenticOS-r7-data\h`, pc role unless stated);
WSL = a local WSL test computer (worker C's displays `:41`–`:44`; H has none); RYZEN = production hub on Ryzen-PC (server role, tailnet);
DOT = Dot's cloud browser against staging; HW = hardware (microphone, a second founder's PC, the Tauri desktop shell).

**OWNER** in the "Who" column marks a row only the owner can run: a confirmed founder session on production, the physical microphone, Mehroz's own
device, or Dot's cloud browser.

**Generic check codes** (every journey and route row lists the ones that apply; the result column gives each one's status):
S submit/reload/reopen · K keyboard, focus, Escape · L 1440/834/390 layouts · N back/forward · St loading/empty/error/offline states ·
C duplicate clicks and concurrent edits · R interrupted requests and reconnects · Rs restart recovery · A accessible saved results ·
Id identity and permission enforcement.

**Evidence rule for phase 2.** Every PASS names the persisted effect it re-read (store row, API body after reload, second browser) and the
evidence file (results JSON check + screenshot path). Screenshots support a PASS; they never make one.

## 2. The owner's connected journeys (A–L)

| # | Feature · journey | Env · Who | Fixture | Expected effect | Evidence required | Generic checks | Baseline 491b8ee0 | Defect | Retest (phase 2) |
|---|---|---|---|---|---|---|---|---|---|
| A | Desktop shell launches into the Ryzen hub with no competing main-PC hub | HW + RYZEN · OWNER | the Tauri `app.exe` on the main PC; Ryzen hub `317c5e6a`→candidate | the shell opens `https://ryzen-pc…:8443`, `/__version` shows the candidate sha, nothing listens on main-PC 8081 | `netstat` on the main PC (no 8081 listener, no `bun --bun` hub process), shell window URL, `/__version` from inside the shell | S, Rs, St (Ryzen unreachable → plain message), Id | OUT OF SCOPE (G builds; owner runs) | – | owner: launch, quit, relaunch; pull the network once (St) |
| B | Pair a fresh browser/WebView, open an existing bot conversation, reload and keep the session | SYN (local confirm-code form) · RYZEN+HW for tailnet/WebView · OWNER for production | seeded hub; owner's confirmed browser; one fresh browser | fresh browser is pending; a one-time code made on the confirmed browser confirms it; the same bot conversation (same id, same entries) opens; reload and a new tab keep `actor: human`; the code works once | `journey-b-session.ts`: `/__devices/me` actor before/after, `/__agents/bots/research/thread` id and entries, single-use refusal | S ✓, K (code field) ✓, L 390 ✓, Id ✓, St (wrong code says why) ✓ | **PASS 11 · OUT OF SCOPE 1** (tailnet pairing, WebView) | H-03 (pc role lets the pending browser read the thread, by design), H-04 (copy says "Profile"; the panel is under System) | rerun on candidate; owner: pair the Tauri WebView and a phone over tailnet on Ryzen, reload, reopen the app |
| C | Bounded Research task on a test computer: progress observed, saved output verified independently | WSL or RYZEN · lead (WSL) / OWNER (Ryzen) | a test computer named `research`; a goal with a known answer (two public sources) | progress entries arrive in the Research conversation; the job ends `succeeded`/`partial` with a saved result; the saved file's content matches the claimed sources | conversation entries over time; `/__computers/artifacts/<job>` read back; the cited URLs fetched independently | S, R (tab closed mid-run → returns to the live state), Rs, A (result opens with an h1, readable at 390), C (Send double-clicked = one job) | BLOCKED (H has no computer host) | – | lead: on C's WSL display or Ryzen staging; script: extend `journey-b-session.ts` with a host (`--host local-wsl`) |
| D | Takeover pauses agent input; release resumes; Stop cancels the real work and prevents later effects | WSL or RYZEN (+SYN for the host-less part) · lead / OWNER | a computer with a running 4-step job; a 2-step job whose 2nd step writes a file | during takeover agent input is refused and no step is added; Return resumes the SAME job with no replay; Stop ends it and the file is never written | `r6b-gate-drive.ts --scenario computers-controls` (existing) + `journey-d-stop.ts`: step counts at pause and +8 s, the file's absence, job state after reload | K (Stop confirmation by keyboard, Keep it), C (Stop double-clicked), Rs, Id (a program cannot take the lease) | **PASS 5 · FAIL 1 · BLOCKED 4** | H-08 (Stop on a job no worker holds shows "Stopping…" forever) | lead runs `computers-controls` on a host; H reruns `journey-d-stop.ts` on candidate |
| E | Create, edit, duplicate and archive a bot, with configuration, history and computer assignment verified | SYN (+RYZEN server-role refusal) | seeded hub; Research has 2 saved results | create (double-clicked) makes one bot and opens it; edits persist with rev+1; a stale tab is refused and keeps its text; Ctrl+Enter saves; duplicate copies configuration only; archive hides, Show archived lists, reads stay open, PATCH refused; unarchive restores | `journey-e-bots.ts`: `/__agents/bots/<id>` after each reload, `history`, copy's tasks/files/thread = 0 | S ✓, K ✗ (Escape), L 834/390 ✓, C ✓ (double-click, stale tab), Id ✓ (program refused) | **PASS 18 · FAIL 2 · BLOCKED 1** (computer assignment: no computers on a host-less hub) | H-01 (Escape), H-02 (edits not in history), H-03 | rerun on candidate; computer assignment on a hub with a host; owner: server-role refusal for a pending/tailnet-only browser on Ryzen |
| F | A small coding job on the selected account and model, with receipts, review, approval, failure recovery and no duplicate execution | SYN (synthetic coding jobs) + lead/OWNER for a real job | gate seed's 9 synthetic coding jobs; a disposable repo and one pinned account for the real run | every stored job is listed and opens; Deny on a pending request is written once; Stop asks first; a real job: one run per Start (double-click, restart), receipts per model call, independent reviewer, approval before apply, honest pause/fallback on a limit | `journey-f-coding.ts` + the receipts and job record of the real job; `/__operator/coding/jobs/<id>` after reload | S ✓, K (Stop confirm), C (Start/Deny double-clicked), Rs, R, Id | **PASS 3 · BLOCKED 6** | H-05 (synthetic hubs can see the owner's real Codex login) | needs a live coding seed after boot (D) for Deny/Stop; the real job is lead/OWNER on the candidate |
| G | CRM create, edit, deal and task progression, imports, conflicting edits, result/job linking | SYN (Leads today; CRM on the candidate) | 6 synthetic leads; Dot's CRM fixtures on the candidate | edits persist; a stale tab is refused; a logged call is written once; CRM: company+contact, deal stage, tasks, CSV import preview/conflicts/re-run no-op, `crm.activity.add(eventId=<jobId>:result)` twice = one activity linked to the saved result | `journey-g-crm.ts`: `/__operator/leads/detail` after reload, activity counts; CRM API reads after reload | S ✓, C ✗ (double-click logs twice), L 390 ✓, Id, St | **PASS 3 · FAIL 1 · BLOCKED 6** (no `/__crm` on the baseline) | H-06 | E's branch merged → H extends the script against the frozen CRM API (AGENTS-CRM-CONTRACTS.md) |
| H | Synthetic memory save, recall, correct and delete on a disposable bank | Hindsight engine (local or Ryzen staging) · lead | a disposable bank (`r7-accept-<ts>`), `MU_MEMORY_WRITES=on` on a test hub only | a saved fact is recalled; a correction replaces it (old answer gone); delete removes it from recall; the bank is deleted at the end | API reads after each step; recall text; bank listing before/after | S, C (double save = one memory), Id (a program cannot write), St (engine down → plain message) | BLOCKED (no Hindsight engine reachable from this PC: `127.0.0.1:8888` refused) | – | lead: run `scripts/memory/stage-d-acceptance.ts` pattern on candidate with a disposable bank; H adds a browser pass over /memory |
| I | Website generation reopened remotely: pages, listings, assets, links, failed-generation recovery | SYN (+RYZEN preview origin :8445) · lead / OWNER for remote | synthetic dental, legal and real-estate leads; templates copied read-only | preview builds; every page link and asset returns 200 through the preview origin; real-estate keeps listings; a failed generation ends `failed` with the step named and can be retried | F's evidence (APP-INVENTORY-R7.md "Websites"); on candidate: fetch every URL of each preview from a second browser | S, L, St, Rs, A | NOT RUN by H (F reports dental/legal pass, real-estate **fails on the committed code**: owner's uncommitted overlay) | H-07 (the Websites page starts a Vercel device login on the desktop) | H: browser pass over each preview on candidate; lead: real-estate after the owner's overlay lands |
| J | A synthetic routine: one execution, one notification, across restart and duplicate events | SYN | seeded trigger "New enquiry: draft a reply" (synthetic source only) | first event → one job + one approval card; the same event again = duplicate of the same delivery; after a hub restart and a tick, a third identical event is still a duplicate; still one approval; Automations shows it after reload | `journey-j-routine.ts`: delivery ids, `/__approvals` filtered by the ref, `/__jobs`, the page's own `/__events` stream | S ✓, C ✓ (duplicate events), Rs ✓, St | **PASS 6 · NOT RUN 1** (a clock routine crossing 07:30 while the hub is down) | – | rerun on candidate |
| K | Dot's gateway within its staging scope only | DOT · OWNER (founder mints the code; Dot runs) | staging with synthetic data (`gw/dot-gateway-20261002` DOT-GATEWAY-CHECKLIST.md) | stage 1: anonymous 401, bad/used code refused, cookie attributes, `view` only, reads render, every write 403, events once + reconnect without duplicates, idle/absolute expiry, revocation ≤ 1 s, logout, kill switch; stage 2 only after `crm.write` is granted | Dot's per-step evidence list (statuses, attribute lists, screenshots, no cookie or code values) | S, N, R, St, Id | OUT OF SCOPE (Dot + founder) | – | H reviews Dot's evidence against the checklist; H can pre-run steps 1, 2, 5a against a local gateway if the lead starts one |
| L | Backup, isolated restore and app verification | SYN (+RYZEN nightly backup: lead) | the synthetic hub after journeys B–J; a marker bot | backup of the stopped hub verifies; restore into a new folder matches per-table counts; a second hub on 8138 serves the same bots (with revs), jobs, leads, coding jobs, saved results and conversation; a change there never reaches the original | `journey-l-restore.ts`: snapshot through the APIs before and after; the restored saved result opens; the original's value after its restart | S ✓, Rs ✓, A ✓ (saved result opens on the restored hub), Id (owner session valid on restore) | **PASS 9 · OUT OF SCOPE 1** (production nightly backup) | – | rerun on candidate; lead: Ryzen backup → restore into a fresh folder → hash and count compare |

## 3. Personal-device isolation

| # | Requirement | Env · Who | Expected effect | Evidence that proves it | Baseline | Retest |
|---|---|---|---|---|---|---|
| ISO-1 | Usman controls only his own device, Mehroz only his | SYN (resolver) · HW OWNER (two companions) | `resolveTarget("here")` → the caller's own device; a command reaches only the caller's companion | `isolation.ts` (resolver via `/__commands/target`): **PASS** for Usman in pc role. Real proof: both companions paired; each founder runs a harmless command; each companion ledger shows only its owner's jobs | PASS (resolver) · OUT OF SCOPE (real devices) | owner + Mehroz on the candidate |
| ISO-2 | Both can use the shared bot computers | SYN with a host · RYZEN | `computer:research` and "the research computer" resolve for either founder | `isolation.ts` with a host; real: each founder starts a task on Research | BLOCKED (no computer on a host-less hub; the refusal "no such shared computer" is correct) | lead on a hub with a host |
| ISO-3 | Neither can control the other's device | SYN · HW OWNER | "on Mehroz's PC" for Usman is refused by name before dispatch, and at execution | `isolation.ts`: **PASS** ("that device belongs to mehroz; you can only run commands on your own devices"); real: Mehroz asks for Usman's PC, the companion ledger shows nothing | PASS (resolver) · OUT OF SCOPE (real) | owner + Mehroz |
| ISO-4 | The server-role Ryzen physical desktop is unavailable to agent work | RYZEN · OWNER | in the server role the hub is never a target or a fallback; no takeover, job or command lands on the Ryzen desktop | code: `scripts/devices/service.ts:72` lists the hub as a device only in the pc role; real: process list on Ryzen during a Research task (Chromium only inside the bot computer's WSL user), companion ledger | BLOCKED on SYN (server role: a loopback browser is nobody without the local-owner proof) | owner on Ryzen; note finding H-07 (a Websites page view can open a browser window on the server's desktop) |

**What is and is not proof.** A separate browser profile, a separate data folder or a redirected HOME is a separation of *state*; it proves
that one test did not read another's files by accident, not that a process cannot. This round shows it directly: a synthetic hub with HOME,
USERPROFILE, APPDATA and LOCALAPPDATA all redirected to an empty folder still reported "Codex Ready · signed in" (finding H-05), because the CLI
resolves the Windows profile itself. Proof of isolation is process and filesystem evidence on the real machines:
- the bot computers run as their own Linux users (`id`, `ps -o user`), and those users get "Permission denied" reading the founders' Windows
  profiles through `/mnt/c` and the companion token files (`ls -l`, `icacls` on the Windows side);
- each companion runs as its founder's own Windows account and holds only its own bearer (the device store shows one companion per owner);
- during a takeover or job, the Ryzen desktop session shows no new process (Task Manager / `Get-Process` before and after).

## 4. Route coverage (every file in `src/routes`)

All rows: Env SYN, fixture = gate seed (`--host none`) + the owner's confirmed browser. "Render" = h1, no error boundary, no horizontal overflow,
no page error and no 5xx at 1440, 834 and 390 (`routes-sweep.ts`). "K" = skip link first with a focus ring, then the next Tab lands in the main
content. Journey references point to section 2. Actions are from the rendered page (`inventory.ts`, `results/…/inventory.json`) and worker F's
APP-INVENTORY-R7.md.

| Route (file) | Feature · major user actions | Expected effect | Evidence | Generic checks | Baseline: render · K | Defect | Retest |
|---|---|---|---|---|---|---|---|
| `/` `/today` `/workspace` (index, today, workspace) | redirect to Home | land on `/business` | final URL | N | PASS · PASS | – | candidate sweep |
| `/business` (business) | Home: Needs you, Needs attention, Running now, Enquiries, Pipeline; tabs finance/progress/audience; record a decision, add a goal, NAB CSV | saved decision/goal re-read after reload | F's 500-injection table; H: decision save → reload (phase 2) | S, K, L, N (tabs), St, C | PASS · PASS | – | phase 2: decision + goal persist, tab Back/Forward |
| `/jarvis` (jarvis) | ask Jarvis, handed-off work, agent questions | a request becomes a job in the person's thread | job row + thread entry after reload | S, K, L, St, Id | PASS · PASS | – | phase 2 with a model-free request |
| `/chat` (chat) | typed conversations, model picker, history | messages saved and reopened | `/__operator/conversations` after reload | S, K, L, C (revision 409), St | PASS · **FAIL** (focus starts in the composer; first Tab is "Select model") | H-10 | candidate sweep |
| `/agents/workspace`, `/agents/workspace/$botId` | Agents: bot selector, New bot, Show archived, Chat / Tasks & Files / Setup, Show computer | journeys B, E | section 2 | all | PASS · PASS | H-01, H-02 | journeys B, E |
| `/agents/workspace/<unknown>` | unknown bot | "There is no agent called …", pick one | text + selector still usable | St | PASS | – | – |
| `/agents/hermes`, `/agents/claude-code`, `/agents/openclaw` | external agent status pages, install/start hints | honest "not running / install" states | text | St, L | PASS · PASS | – | candidate sweep |
| `/automations` (automations) | triggers and routines: pause, resume, disable, retry | journey J | section 2 | S, C, Rs | PASS · PASS | – | journey J |
| `/activity` (activity) | job history, Open job, saved results, unknown job id | selected job in view; saved result opens | `r6b-gate-drive.ts --scenario activity` (existing) | K, L, St, A | PASS · PASS; offline nav from Home: **FAIL** | H-09 | rerun r6b activity scenario on candidate |
| `/receptionist` (receptionist) | calls, flags, go-live gates (on hold) | read-only states honest | text | St, L | PASS · PASS | – | sweep only (on hold) |
| `/work` (work) | decisions, calls to make, pipeline, websites; record a decision | decision persists; counts link to items | F's tests; H phase 2 reload check | S, K, C, St | PASS · PASS | – | phase 2 |
| `/leads` (leads) | prospects, drawer, edit lead, log a call, deal, Find leads | journey G | section 2 | S, K, L, N (drawer Back), C | PASS · PASS | H-06 | journey G |
| `/websites` (websites) | sites, previews, make a site, deploy (confirmed) | journey I | section 2 | S, St, Id | PASS · PASS | H-07 | journey I |
| `/workspaces`, `/workspaces/$id` | project workspaces; unknown id | list; "Workspace not found" | text | St | PASS · PASS | – | sweep |
| `/coding`, `/coding/$jobId` | coding jobs, start a job, job detail, Stop, Allow/Deny, Unmark superseded; unknown id | journey F | section 2 | all | PASS · PASS | H-05 | journey F |
| `/computers` (computers) | your PCs, shared agent computers, add, controls | host-less: honest "no host" and no misleading controls | `r6b-gate-drive.ts --scenario computers-none` (existing) | St, Id | PASS · PASS (0 controls in main with no host) | – | lead on a hub with a host (`computers-controls`) |
| `/memory`, `/memory/vault`, `/memory-map` | find, ask, add, vault sync, where memory lives | journey H; writes off → disabled with the reason | F's checks; journey H | S, St, Id | PASS · PASS | – | journey H |
| `/codegraph` (codegraph) | knowledge graph | renders, project picker | – | L | PASS · PASS | – | sweep |
| `/finance`, `/usage`, `/operations` | money, AI spend, package economics; NAB import, edit prices | honest unknowns; edits persist | F's evidence | S, St | PASS · PASS | – | sweep |
| `/studio`, `/design`, `/motion`, `/transitions`, `/share` | media studio, library, motion kit, transitions, share card | no paid generation is clicked | text | St, L | PASS · PASS | – | sweep |
| `/system`, `/models`, `/skills`, `/skill-drafts` | providers, tools, devices and people (pairing), models, skills | journey B uses System → Devices and people | section 2 | St, Id | PASS · PASS (skills/skill-drafts: empty main, K judged on the skip link only) | H-04, H-05 | journey B |
| `/settings` (settings) | personal profile, connections, AI tools, workspace, Jarvis | profile saves; tab Back/Forward | F's evidence | S, N, St | PASS · PASS | H-04 | sweep |
| `/setup` (setup) | first-run guide (full-screen layout) | Continue saves | text | K | PASS · **FAIL** (no skip link: full-screen layout) | H-10 | minor |
| `/inbox`, `/inbox-triage`, `/calendar` | conversations, triage, schedule, new event | honest "connect" states; event form keeps text on failure | F's evidence | S, St | PASS · `/calendar` **FAIL** (focus starts in a chat composer) | H-10 | sweep |
| `/hud`, `/dashboard` | Jarvis HUD (read-only), Mission Control | read-only | text | L | PASS · `/hud` **FAIL** (no skip link; list items are the first stops) | H-10 | minor |
| `*` (404) | unknown path | "Page not found", Go home | text | St | PASS | – | – |
| generic | Back/Forward Activity → Automations → Memory; reload keeps the route; Ctrl+K palette and Escape | – | `routes-sweep.ts` "R generic" | N, K | PASS (3/3) | – | – |
| generic offline | client navigation with the network down | the page says it is offline; no blank page | `routes-sweep.ts` offline checks | St, R | **FAIL** (2/2) | H-09 | candidate sweep |

**API mounts (`/__*`, 116 classified in `scripts/identity/routes.ts`).** Identity enforcement per mount is the gate's job and is unit-covered
(`scripts/identity/routes.test.ts`, `route-matrix.test.ts`). The browser journeys exercise the ones a person reaches: `/__agents` (B, E),
`/__devices` (B), `/__jobs` and `/__approvals` (D, J), `/__operator` leads/coding/triggers/conversations (F, G, J), `/__commands` (ISO),
`/__computers` (C, D), `/__health` and `/__events` (J, L). Each journey script also sends one request with no session (a program) and expects
401/403. The remote (tailnet) and server-role forms of every check are RYZEN rows for the owner.

## 5. Baseline run on `491b8ee0`

Hub: `bun scripts/acceptance/r7/hub.ts reset` (fresh gate seed, pc role, background work on), then `run-all.ts` one script at a time, real headless
Chromium (Playwright 1.63 bundled). 3 Oct 2026, about 03:30–03:50 AEST. Results: `scripts/acceptance/r7/results/baseline-491b8ee0/`.

| Script | PASS | FAIL | BLOCKED | NOT RUN | OUT OF SCOPE |
|---|---|---|---|---|---|
| routes-sweep (47 URLs × 3 widths + generic) | 321 | 9 | – | – | – |
| journey-b-session | 11 | – | – | – | 1 |
| journey-e-bots | 18 | 2 | 1 | – | – |
| journey-g-crm | 3 | 1 | 6 | – | – |
| journey-f-coding | 3 | – | 6 | – | – |
| journey-d-stop | 5 | 1 | 4 | – | – |
| isolation (pc role) | 4 | – | 1 | – | 4 |
| journey-j-routine | 6 | – | – | 1 | – |
| journey-l-restore | 9 | – | – | – | 1 |
| **Total** | **380** | **13** | **18** | **1** | **6** |

The 9 sweep FAILs: keyboard on `/chat`, `/calendar`, `/setup`, `/hud` and three empty-main pages, and the two offline checks. A re-check with the
empty-main rule (`results-routes-sweep-keyboard-recheck.json`) turned `/skills`, `/skill-drafts`, `/inbox-triage` into PASS; the counts above are the
original run. Server-role isolation (hub restarted with `--role server`) is BLOCKED: a loopback browser without the local-owner proof is nobody.

## 6. Findings for the owning workers

| # | Finding | Where | Status | Owner | Severity |
|---|---|---|---|---|---|
| H-01 | Escape does not close the New bot panel (focus starts in Name; the panel stays open) | `src/components/agents/workspace/bot-selector.tsx:73-91` (panel toggled by state only), `src/components/agents/setup/new-bot-form.tsx:45` (no key handler) | CONFIRMED (browser) | A | minor |
| H-02 | A bot's settings edits are not recorded in its history: create, archive and unarchive are, purpose/instructions edits are not and carry no `updatedBy`; "who changed Research's instructions" can't be answered | `scripts/agents/store.ts:114` (`patch()` copies `current.history`, adds no event) | CONFIRMED (browser + API: 4 purpose edits, history `created, archived, unarchived`) | B (`scripts/agents/**`) | should-fix |
| H-03 | pc role: a PENDING browser (actor process, a navigation-minted session nobody confirmed) counts as "the owner at the hub" for `/__agents`: it reads bot conversations and passes the manage gate | `scripts/agents/routes.ts:92` (`mayConverse = isHumanSession || isAtHub`), `scripts/identity/principal.ts:388-390` (`isAtHub` = via loopback-owner, any actor) | CONFIRMED (observed: pending browser thread 200, stale-rev PATCH reached 409) · by the routes doc's wording | B + lead (identity) | low now (main PC no longer the hub); server role must be confirmed by the owner on Ryzen |
| H-04 | Pairing copy says "Profile", but the sidebar's "signed in · profile" opens Settings → Personal profile; the confirm/pair UI is System → Devices and people, inside a closed "Plan usage, devices & runtime" disclosure | `src/components/profile/profile-panel.tsx:224,267`, `scripts/devices/store.ts:337`, `scripts/identity/confirm-browser.ts:5`, `src/components/app-sidebar.tsx:190-192`, `src/components/shell/pages/system-page.tsx:346,392` | CONFIRMED (journey B had to open the disclosure) | G (profile copy) + F (sidebar/System) | should-fix (it blocks a new browser's first sign-in) |
| H-05 | Test hubs are not isolated from the owner's real CLI logins: with HOME, USERPROFILE, APPDATA, LOCALAPPDATA redirected and credential-named variables removed, System still shows "Codex Ready · signed in" and Codex models (gpt-6.1-sol); a Start on a synthetic coding draft could spend the owner's real account. `AGENTIC_OS_NO_CODEX` only gates account discovery | `scripts/assistant-adapters.ts:100-135` (app-server `account/read`), `scripts/account-discovery.ts:27` | CONFIRMED (observation) · mechanism PLAUSIBLE (Codex resolves the Windows profile, not the env) | lead (test-hub policy) + D | should-fix before any worker clicks Start on a test hub |
| H-06 | Double-click on a call outcome ("No answer") logs two calls (activities 69 ms apart); the form has no in-flight guard and sends no `event` key although `/leads/log` dedupes on one | `src/components/operator/lead-drawer.tsx:806-818` (`LogCall.log`), `scripts/leads/api.ts` (event dedupe exists) | CONFIRMED (browser + API, both runs) | F (Leads UI) + E (CRM/Leads API, same gap as CLOUD-RECONCILIATION-R7 follow-up 1) | should-fix |
| H-07 | Opening Websites refreshes `vercel project ls` in the background; with no Vercel login the CLI starts a device sign-in and **opens a browser window on the hub's desktop** (seen at 03:20:29 on this PC: Chrome at `vercel.com/oauth/device?user_code=…`; closed, nothing entered). On Ryzen that is the server's physical desktop, and an open device code is a sign-in anyone who sees it could complete | `scripts/websites/catalogue.ts:218-243` (`runVercelList`, `refreshVercelIfStale`) | CONFIRMED | F | should-fix (never start an interactive login from a page view: check `vercel whoami` non-interactively, or require a token) |
| H-08 | Stop on a job no worker in this process holds (another worker, or one that died) sets the durable flag but the UI shows "Stopping…" indefinitely with no reason | `src/components/jobs/job-step-log.tsx:72-84`, `scripts/jobs/service.ts:678-680` | CONFIRMED on a seeded job · real-world reach PLAUSIBLE (multi-process or a dead worker) | lead (`src/components/jobs` is unowned) / D (jobs) | minor |
| H-09 | Offline client navigation: from Activity, clicking Agents with the network down lands on Chrome's error page; from Home, clicking Activity does nothing and says nothing | shell navigation (lazy route chunks under `vite dev`, which production on Ryzen also runs) | CONFIRMED (both runs) | F | minor |
| H-10 | Keyboard start: `/chat` and `/calendar` autofocus a chat composer so the first Tab is "Select model", not the skip link; `/setup` (full-screen) and `/hud` have no skip link | `src/routes/__root.tsx:186-195`, `src/components/ui/ai-chat-input.tsx:1018` | CONFIRMED (keyboard check) | F | minor (`/chat` autofocus is defensible; `/calendar` is not) |
| H-11 | `POST /__operator/conversations` with no `messages` array answers "A conversation can contain up to 500 messages" | `scripts/conversations.ts:297-300` | CONFIRMED (API probe) | B (`scripts/conversations.ts`) | minor |
| H-12 | The gate seed writes coding jobs before the hub boots, so boot recovery turns the "running" and "needs input" synthetic jobs into interrupted; F's Deny and Stop checks can't run | `scripts/acceptance/seed-gate-hub.ts:152-168` | CONFIRMED | D (a live coding seed after boot, like `--phase live` for jobs) | test gap |

Observed and judged correct (not findings): a duplicate of a bot whose computer does not exist on the hub starts with no computer
(`scripts/agents/validate.ts:363`); after a restart a routine's job awaiting approval reads "interrupted" while its approval stays pending and still
settles the delivery (`scripts/triggers/engine.ts:189-192, 285-311`); a quiet copy (`AGENTIC_OS_NO_BACKGROUND=1`) answers `/__jobs` with 503, which is
why F's survey saw 503s (environment, as F says) and why H's hub runs with background work on.

## 7. The scripts

`scripts/acceptance/r7/`:

| File | Rows |
|---|---|
| `hub.ts` | start/stop/seed/reset the synthetic hub (refuses 8081 and anything outside 8120–8199 and `D:\AgenticOS-r7-data`) |
| `lib.ts` | browser sessions (the owner's persistent profile, fresh pending profiles), in-page API calls, PASS/FAIL recording, result files |
| `routes.ts`, `routes-sweep.ts`, `inventory.ts` | section 4 |
| `journey-b-session.ts`, `journey-d-stop.ts`, `journey-e-bots.ts`, `journey-f-coding.ts`, `journey-g-crm.ts`, `journey-j-routine.ts`, `journey-l-restore.ts`, `isolation.ts` | sections 2 and 3 |
| `run-all.ts` | runs them one at a time and writes `summary-<label>.json` |

```
bun scripts/acceptance/r7/hub.ts reset                       # fresh gate seed on 8128, the owner's browser trusted on first use
MSYS_NO_PATHCONV=1 bun scripts/acceptance/r7/run-all.ts --label candidate-<sha>
bun scripts/acceptance/r7/hub.ts stop
```

**The test hub's isolation, and its limits.** `hub.ts` gives the hub its own data folder, HOME, USERPROFILE, APPDATA and LOCALAPPDATA, a private
Vite cache, `HINDSIGHT_URL=off`, memory writes off, `MU_SEARXNG_URL` pointed at nothing, a failing `vercel` stub first on PATH (H-07), and removes
every inherited variable whose NAME looks like a credential or a provider (values are never read). It does not stop the Codex CLI from finding the
owner's login (H-05), and local Ollama stays visible. The scripts therefore never click Start on a coding draft, Approve, Deploy, Generate, Publish
or anything that spends or sends. Reset never deletes through a link: it refuses any folder that contains a junction (Windows plants one in a
home's `AppData\Local\Microsoft\Windows\INetCache`), which is why the synthetic home is kept between resets.

**Notes for whoever runs them.** Never hard-kill a run: a killed Chromium lost the owner profile's rotated session cookie once, and the owner
browser came back pending (fixed by `reset`). Git Bash rewrites arguments that start with `/` (use `MSYS_NO_PATHCONV=1`).

## 8. Reconciliation with worker F's APP-INVENTORY-R7.md (first pass)

F surveyed 38 URLs (Home tabs as separate URLs) with a quiet copy; H surveys 47 (unknown ids for the four parameterised routes, the three
redirects and the 404) with background work on. They agree on render, overflow and one h1 everywhere. F's "console 409/503 = environment" is right
for a quiet copy; on a full hub H saw none. F did not cover the skip link, offline navigation or Escape on the New bot panel (Agents is A's).
F's websites table is the evidence for journey I until H's phase-2 browser pass; its "real estate fails on committed code" is carried as open.

## 9. Phase 2 plan (when the lead freezes a candidate)

1. `hub.ts reset` on the candidate worktree (or the lead's integration worktree, read-only), `run-all.ts --label candidate-<sha>`.
2. Extend `journey-g-crm.ts` to the frozen `/__crm` API; extend `journey-f-coding.ts` with D's live coding seed.
3. Review the candidate diff for each journey's code path (A–L), with findings as file:line CONFIRMED/PLAUSIBLE.
4. Hand the lead the owner-only list: A (desktop shell), B (tailnet + WebView), C and D (Ryzen computers), F (real coding job), H (Hindsight bank),
   I (remote preview), K (Dot), ISO-1/3/4 (two founders' devices, Ryzen desktop), L (production backup).
5. Report blockers: any FAIL in sections 2–4 that is new on the candidate, and any of H-02, H-04, H-05, H-06, H-07 still open.

## 10. Phase 2a: preliminary candidate `4d97c98b` (3 Oct 2026, about 04:40–05:00 AEST)

Candidate `r7/candidate-20261003` @ `4d97c98b` (A, B, C, F, G and the CRM; D and two C follow-ups not yet in), merged into this branch. Fresh
gate seed with the CRM migration applied (`hub.ts` now runs `scripts/crm/migrate.ts --apply --backup` after seeding), pc role, port 8128, one script
at a time, real headless Chromium. `run-all.ts --label candidate-4d97c98b`.

**Scripts extended for what the candidate added:** G now runs the CRM half (company create with Escape and Cancel, double-clicked Add company,
search after reload, edit with a stale second tab, contact, deal, stage move with a stale version, task create and complete, CSV preview/commit
twice/re-import, `crm.activity.add` with `eventId <jobId>:result` twice and its artifact, the timeline after reload, 1440/834/390, the company
page on a phone, unlabelled controls, a program refused) and the server half of the leads call-log key; E checks Escape on the empty and the
typed New bot form and that edits are in the bot's history by name and person, never by value; B checks the pairing banner, its link to the
open panel, the wording of the wrong-code message and the banner gone after confirming; D checks screen truth with no computer
(`/__computers/research/screen` and `/screenshot`); the new `journey-i-vercel.ts` checks the signed-out Vercel state on Websites (through the
PATH stub, which now answers exactly as a signed-out CLI) AND runs the real Vercel CLI the way the candidate's background refresh does
(`--non-interactive`, `CI=1`) in an empty profile, watching for a sign-in window; the sweep covers `/crm` and `/crm?view=pipeline`.

| Script | Baseline P · F · B · NR · OOS | Candidate P · F · B · NR · OOS | What changed |
|---|---|---|---|
| routes-sweep | 321 · 9 · – · – · – | **344 · 0** · – · – · – | keyboard start (H-10) and offline navigation (H-09) fixed; +2 CRM URLs |
| journey-b-session | 11 · 0 · – · – · 1 | **13 · 0** · – · – · 1 | pairing banner + link to the open panel, wrong-code copy (H-04) fixed |
| journey-e-bots | 18 · 2 · 1 · – · – | **21 · 1** · 1 · – · – | Escape (H-01) and edit history (H-02) fixed; **new FAIL: Duplicate double-clicked makes two copies (H-13)** |
| journey-g-crm | 3 · 1 · 6 · – · – | **20 · 1** · 0 · – · – | CRM half unblocked, all CRM checks pass; leads double-click still logs twice (H-06) |
| journey-f-coding | 3 · 0 · 6 · – · – | 3 · 0 · 6 · – · – | unchanged (D not in the candidate; H-12 open) |
| journey-d-stop | 5 · 1 · 4 · – · – | 7 · 1 · 5 · – · – | screen truth with no computer: 2 PASS; layers on a real computer BLOCKED; H-08 open |
| journey-i-vercel (new) | – | **2 · 0** | H-07 fixed: signed-out state shown, real CLI exits "No existing credentials found", no sign-in window |
| isolation (pc) | 4 · 0 · 1 · – · 4 | 4 · 0 · 1 · – · 4 | unchanged |
| journey-j-routine | 6 · 0 · – · 1 · – | 6 · 0 · – · 1 · – | unchanged |
| journey-l-restore | 9 · 0 · – · – · 1 | 9 · 0 · – · – · 1 | passes with the lead's `--keep-sessions` |
| **Total** | **380 · 13 · 18 · 1 · 6** | **429 · 3 · 13 · 1 · 6** | |

### The three FAILs (none a release blocker)

| # | Defect | Where (integrated code) | Status | Owner | Blocker? |
|---|---|---|---|---|---|
| H-06 (still open) | Double-clicking a call outcome ("No answer") logs two calls, 63–80 ms apart, on every run. The candidate added an in-flight guard and an `event` key, and the SERVER half works (two requests with one key = one activity, PASS), but the guard is released and the key cleared as soon as the first request answers (`finally { inFlight.current = false }`, `attemptKey.current = null` on success), and a local hub answers within the 30 ms between the two clicks, so the second click is a new attempt with a new key | `src/components/operator/lead-drawer.tsx:818-831` (`LogCall.log`) | CONFIRMED (browser + API, 3 runs) | F (Leads UI) | no (should-fix: double counts calls and daily goals; fix: keep the outcome's key for a few seconds after success, or keep the buttons disabled until the refetch lands) |
| H-13 (new) | Duplicate double-clicked makes two copies ("Research copy", "Research copy 2"). Same class as H-06: `mayManage()` refuses only while the request is in flight, and the button is enabled again the moment the copy is made; on the baseline the request was slow enough to hide it | `src/components/agents/setup/setup-controller.ts:231-240`, `src/components/agents/setup/manage-section.tsx:114` | CONFIRMED (3 runs on the candidate; passed on the baseline) | A (`src/components/agents/setup/**`) | no (an extra copy is harmless and archivable; should-fix: keep Duplicate disabled while the "Made … copy" notice is shown) |
| H-08 (still open) | Stop on a job no worker in this process holds shows "Stopping…" indefinitely | `src/components/jobs/job-step-log.tsx:72-84`, `scripts/jobs/service.ts:678-680` | CONFIRMED on a seeded job | lead (`src/components/jobs` unowned) / D | no (minor) |

### Earlier findings on the candidate

Fixed and verified in the browser: H-01 (Escape closes the empty New bot form, focus returns to New bot; typed text is kept), H-02 (each saved
edit is a history entry naming the person and the fields, never the text), H-04 (banner, sidebar link, wrong-code wording), H-07 (no sign-in
window from Websites; the real CLI with `CI=1 --non-interactive` exits signed-out), H-09 (offline navigation says "You're offline"), H-10 (the
skip link is the first Tab stop on `/chat`, `/calendar`, `/setup`, `/hud`). Fixed in code, not separately exercised: H-11
(`scripts/conversations.ts` no longer reports "500 messages" for a missing list). Still open: H-03 (design: pending browser = owner at the hub in
the pc role; `scripts/agents/routes.ts`, `principal.ts` unchanged), H-05 (Codex login visible to test hubs; `assistant-adapters.ts` unchanged),
H-08, H-12 (needs D's live coding seed).

**Observed and judged correct:** the CRM migration does not carry a lead's Google-sourced business name ("No independently sourced business
name; live Google display content is not migrated", `scripts/crm/migrations.ts:105-110`), so the 6 seeded companies are nameless; every row still
has an accessible name (PASS). Owner note for E and the lead: on production every Google-sourced lead becomes a company with no name until a
founder types one. A re-run of G against the same data shows two correct refusals worth knowing: a re-imported CSV row that matches an existing
company is held for a decision (400 validation, nothing written), and a reused `eventId` with different details is an idempotency conflict (409).

**Still BLOCKED here (13), unchanged in kind:** computer-host rows (C, D takeover/release/Stop on real work, screen-truth layers, computer
assignment, ISO-2), F's live coding seed and the real coding job, and the server-role identity rows. Owner-only rows (A, B tailnet/WebView, C/D on
Ryzen, H Hindsight bank, I remote preview, K Dot, ISO real devices, L production backup) are unchanged.

## 11. Phase 2b: final pre-gate candidate `e8d04d69` (3 Oct 2026, about 05:25–05:45 AEST)

Candidate `r7/candidate-20261003` @ `e8d04d69` (A, B, C, D, F, G and the CRM, plus the fixes for H-05, H-06, H-08, H-12 and H-13), merged into
this branch. Fresh gate seed + CRM migration, pc role, port 8128, one script at a time, real headless Chromium, `run-all.ts --label
candidate-e8d04d69`. Script change: `journey-f-coding.ts` now runs the gate seed's `--phase live` itself (H-12) and drives Deny and Stop on the
two in-flight coding jobs it writes after boot. Nothing clicked Start, Approve or merge, and the hub fails closed on the owner's CLI logins.

| Script | Baseline `491b8ee0` | `4d97c98b` | **`e8d04d69`** |
|---|---|---|---|
| routes-sweep | 321 · 9 · – | 344 · 0 · – | **344 · 0 · –** |
| journey-b-session | 11 · 0 · – (1 OOS) | 13 · 0 · – (1 OOS) | **13 · 0 · – (1 OOS)** |
| journey-e-bots | 18 · 2 · 1 | 21 · 1 · 1 | **22 · 0 · 1** |
| journey-g-crm | 3 · 1 · 6 | 20 · 1 · 0 | **21 · 0 · 0** |
| journey-f-coding | 3 · 0 · 6 | 3 · 0 · 6 | **6 · 0 · 4** |
| journey-d-stop | 5 · 1 · 4 | 7 · 1 · 5 | **7 · 0 · 5** |
| journey-i-vercel | – | 2 · 0 · – | **2 · 0 · –** |
| isolation (pc) | 4 · 0 · 1 (4 OOS) | 4 · 0 · 1 (4 OOS) | **4 · 0 · 1 (4 OOS)** |
| journey-j-routine | 6 · 0 · – (1 NR) | 6 · 0 · – (1 NR) | **6 · 0 · – (1 NR)** |
| journey-l-restore | 9 · 0 · – (1 OOS) | 9 · 0 · – (1 OOS) | **9 · 0 · – (1 OOS)** |
| **Total P · F · B · NR · OOS** | 380 · 13 · 18 · 1 · 6 | 429 · 3 · 13 · 1 · 6 | **434 · 0 · 11 · 1 · 6** |

**Verified fixed on `e8d04d69` (browser + persisted state):** H-06 (a double-clicked "No answer" writes one activity), H-13 (a double-clicked
Duplicate makes one copy), H-08 (Stop on the orphaned seeded job settles as `cancelled`; a second cancel is a 409), H-12 (the live coding seed
writes a "building, asking you" and a "reviewing" job after boot; Deny double-clicked leaves no pending request; Stop asks first, Escape and
"Keep it running" change nothing, "Yes, stop it" persists `cancelled`), H-05 (System now says "Codex: Check failed … could not be verified"
instead of "Ready · signed in"). Earlier fixes (H-01, H-02, H-04, H-07, H-09, H-10) held. **Still open, not blockers:** H-03 (pc-role design:
a pending browser at the hub PC counts as the owner at the hub; `scripts/agents/routes.ts`, `scripts/identity/principal.ts:388-390`; the server
role must be confirmed by the owner on Ryzen).

**Observation (not a FAIL):** Deny on the live seeded coding job leaves the job and its builder run `interrupted` rather than resuming: no agent
process exists for a seeded job, so nothing can continue, and nothing was replayed. On a real job the owner's run is the evidence (row F).

**Final BLOCKED (11) — need a computer host or real accounts:**
- E: computer assignment change → reload → API (no computers on a host-less hub).
- F (4): a real coding job on a pinned account and model; receipts, reviewer independence and approval to apply; provider-limit recovery and
  Resume; no duplicate execution on a live run (Start double-clicked, hub restart mid-run).
- D (5): screen-truth layers on a real computer; takeover pauses agent input; release resumes the same job with no replay; Stop cancels real
  computer work (the file is never written); a program cannot take or use the lease.
- ISO-2: a shared bot computer by name for both founders.

**NOT RUN (1):** J, a clock routine crossing 07:30 with the hub stopped (unit-covered).

**Owner-only / OUT OF SCOPE (6 recorded, plus the owner rows of section 2):** A (Tauri shell launches into Ryzen, no main-PC hub); B tailnet
pairing and the WebView (incl. the server-role match code and console code); C and D on Ryzen computers; F real coding job; H Hindsight
disposable bank; I remote preview through :8445 and the real-estate listings once the owner's overlay lands; K Dot's gateway checklist (Dot +
founder); ISO-1, ISO-3, ISO-4 on the real devices (Mehroz's PC, the Ryzen desktop, process and filesystem evidence); L the production nightly
backup and restore; the server-role identity rows (H-03 confirmation); the physical microphone.
