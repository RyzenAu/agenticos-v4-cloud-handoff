# Agents workspace: reference repositories, current licences and what we reuse

Checked 2 Oct 2026. Read-only: `git fetch` in each clone under `D:/prog-scratch/`, files read with `git show origin/HEAD:<path>` (no checkout, no install, nothing run). OpenMausBot `enterprise/` was never opened. No env or credential file was read.

Target: the unified Agents workspace (pick a bot, then Chat, live Computer, Tasks & Files, Setup in one place). Existing pieces stay: `src/components/agents/workspace-parts.tsx`, `src/lib/agent-workspace.ts`, `src/components/computers/*`, `src/lib/thread-events.ts`, `scripts/jarvis-command/threads.ts`, `scripts/computers/*`, `scripts/coding/*`.

## 1. Revisions and licences (verified at current origin HEAD)

| Repo | Recorded | Current `origin` HEAD | Licence now | Changed since recorded? |
|---|---|---|---|---|
| composio-community/open-dot | `f838e17` (30 Sep) | `f838e17` (no new commits) | **None.** No LICENSE/COPYING file in the tree, `package.json` has no `license` field (`"version": "0.1.0"`), README has no licence section. README only calls it "an open source version" of OpenAI Dots (line 3), which is a description, not a grant | No. Still unlicensed. GitHub licence API could not be queried (no `gh` here); the tree is the evidence |
| milind-soni/OpenMausBot | `90ffde77` | `97fa2849` (2 Oct; 169 commits ahead) | **Apache-2.0** (`LICENSE`, `package.json` `"license": "Apache-2.0"`) for everything outside `enterprise/`. `enterprise/` is the source-available OpenMausBot Enterprise License (`LICENSING.md`). Trademarks (name, mascot) are not licensed | Licence unchanged (`LICENSE` and `LICENSING.md` untouched). `NOTICE` gained 2 paragraphs: a T3 Code (MIT) selected-text citation adaptation, and the bundled **noVNC 1.7.0 under MPL-2.0** with notice in `public/novnc-NOTICE.txt` |
| NVIDIA/OpenShell | `2935e97` | `8719fc9` (2 Oct; 20 commits ahead) | **Apache-2.0**, "Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES"; also a `THIRD-PARTY-NOTICES` file | Unchanged (no commits to LICENSE or notices) |
| mksglu/context-mode | `573e697` | `928bdf1` (2 Oct; 2 commits, both "update install stats") | **Elastic-2.0** (`LICENSE`, "Copyright 2026 Mert Koseoglu"; `package.json` `"license": "Elastic-2.0"`; README "License" section) | Unchanged. Version still 1.0.169 |
| mattpocock/skills | `d81f3a1` | `d81f3a1` (no new commits) | **MIT**, "Copyright (c) 2026 Matt Pocock" | No |

Compatibility facts that matter: OpenMausBot is React 19.1 + Vite 7 + Tailwind 4 + TypeScript 5.8, the same stack as AgenticOS (React ^19.2, Vite ^7.3, Tailwind ^4.2). Open Dot is Next.js 16-style App Router with server actions, so its components cannot be lifted without rewriting every data call. AgenticOS already ships `@novnc/novnc` 1.7.0 as an exact-pinned npm dependency (THIRD-PARTY-NOTICES section 8), so noVNC itself adds nothing new.

## 2. Open Dot (no licence: ADAPT PATTERN only, no copying)

No grant means all rights reserved by default. Nothing below is copied; the behaviour is re-implemented from a description. The owner "treats it as open source" (existing notice section 9) but that is not a licence from the authors, so the safe line stays: ideas and behaviour yes, code, strings and prompt text no. Revisit only if the authors add a LICENSE file.

Files examined at f838e17: `src/components/DotView.tsx` (98 lines), `SetupPane.tsx` (228), `ComputerPane.tsx` (205), `FilesPanel.tsx` (65), `Chat.tsx` (543), `VoicePanel.tsx` (78), `lib/status.ts`, `lib/types.ts`, `server/agent/runtime.ts` (609), `server/snapshot.ts`, `server/scheduler.ts`.

What it does that we want (behaviour, not code):

1. **One bot, one header, three tabs** (`DotView.tsx`): Chat, Computer, Setup are views of the same bot, selected by `?tab=`; the bot pill carries a live status line (`status.ts`: idle, working with the current activity words, waiting "Needs you", paused); Stop appears only while working; Pause/Resume is a separate control that also stops in-flight work. The conversation key is `botId:conversationId`, so switching tab and back does not lose the thread.
2. **Work and talk share one thread** (`runtime.ts`, `types.ts`): every job, routine firing or trigger writes into a conversation (`conversationId`), as `activity`, `card` or `system` messages tagged `from: "routine:<name>"`. A routine keeps its own conversation so its runs read as a log. Approvals and questions are **cards in the thread** with a status (pending, approved, denied, answered, expired); resolving one resumes the run. A paused bot answers "paused, resume it to pick this up" instead of dropping the message. Voice tasks enter the same inbox tagged as voice.
3. **Status is derived, with a "waiting" state**: after a run, status is `waiting` if any card is still pending, else `idle` (`runtime.ts` ~line 225). That makes "needs you" visible from the bot list, not only inside the chat.
4. **Computer pane** (`ComputerPane.tsx`): Take over / Hand back (the bot pauses while you drive), a Live/Idle/"You're in control" badge, Refresh, a screenshot fallback when not live, a files list under the screen. Live URL promises are cached per bot and mode so re-renders do not restart the stream.
5. **Files panel** (`FilesPanel.tsx`): a flat tree of the bot's workspace with sizes and download links.
6. **Setup pane** (`SetupPane.tsx`): sections Identity (name, job, instructions), Approvals (rules: allow, ask, never), Routines (name, instruction, cron with four presets), Triggers, Memory (list with "Forget"), Skills (markdown the bot saved), Danger zone. The bot also edits these itself.

Verdicts:

| Candidate | Class | What exactly | Our existing piece it fits |
|---|---|---|---|
| Bot header with live status line, one view switch, shared key | ADAPT PATTERN | A header showing bot name, a status phrase from job state, Stop only while working, and tabs Chat / Computer / Tasks & Files / Setup that keep one thread mounted. Status words come from our job states (`JOB_STATE_WORD`), not theirs | `agent-workspace.ts`, `workspace-parts.tsx` |
| Waiting state when a card is pending | ADAPT PATTERN | A bot is `needs you` when any approval, question or take-over request is open; shown in the bot picker and header | `threads.ts` entries |
| Work reported into the same conversation, idempotent | ADAPT PATTERN (already largely built) | Keep our `thread-events.ts` key-based fold; add only the display of approvals as thread cards | `thread-events.ts` |
| Take over / Hand back + "You're in control" badge, bot pauses while you drive | ADAPT PATTERN | Same user story, but our lease with fencing epoch and safe-step pause is stronger; only the badge wording and button placement are borrowed ideas | `scripts/computers/lease.ts`, `src/components/computers/*` |
| Routines own a conversation (a log you can open) | ADAPT PATTERN | Each routine writes to its own thread; Setup lists routines with last/next run and opens that thread | Setup, `threads.ts` |
| Rules as allow / ask / never | ADAPT PATTERN | Our policy layer already decides approvals; Setup shows them read-mostly, not as free-text rules | `scripts/coding/policy.ts` |
| Files panel | ADAPT PATTERN | Our Tasks & Files lists job results and saved files, not a raw directory tree | `jobFiles()` |
| Dot 3D look, orb, LookEditor, Composio triggers, E2B cloud computer, pause semantics tied to Mac local access | REJECT | Out of scope (mascot, cloud vendor, macOS local control), and unlicensed |
| Any file under `src/components/*.tsx` or `src/server/*` | REJECT as code | No licence |

## 3. OpenMausBot (Apache-2.0 outside `enterprise/`)

Files examined at 97fa2849 (all outside `enterprise/`): `LICENSE`, `LICENSING.md`, `NOTICE`, `docs/approval-levels.md`, `docs/presets.md`, `docs/memory.md`, `docs/routine-schedules.md`, `docs/linux-desktop.md`, `shared/approval-mode.ts`, `shared/routine-schedule.ts`, `shared/computer-contention.ts`, `src/lib/computer-control.ts`, `src/components/{DesktopViewer,ComputerPanel,ApprovalModeSelector,BotSettingsDialog}.tsx`, `src/components/bot-settings/{MemorySection,ModelSection,PermissionsSection,AccessSection}.tsx` (headers and imports), `server/memory-store.ts`, plus the file list of `server/`, `src/`, `electron/`, `companion/`.

Key finding on copyability: the licence allows copying, but **the UI files are tightly coupled** to their store (`@/state/store`), i18n (`@/lib/i18n`, `@/locales`), `MenuMotion`, Electron gates and their `/api/desktop-viewer/...` websockify route. `ComputerPanel.tsx` is 1834 lines with ~40 imports; `AccessSection.tsx` 802; `MemorySection.tsx` 693. Copying any of them costs more than writing ours against `src/components/ds`. The cleanly separable pieces are the pure functions.

What they implement (behaviour):

- **Dedicated computer per bot** with three places (local, local VM, VPS/cloud), and a viewer (`DesktopViewer.tsx`, 230 lines): noVNC `RFB` in a div, `scaleViewport`, connection states connecting/connected/disconnected/invalid, 15 s connect deadline, clipboard sync, on-screen keyboard panel, fullscreen, retry on `pageshow`, target validated by regex before any request. Control is a server lease (`take`/`release`); a held snapshot never gets released by a false snapshot (`computer-control.ts`); a failed release re-asserts the hold; a turn that owns the computer makes provisioning return a typed busy error (`computer-contention.ts`) so the UI shows "busy" rather than "fault".
- **Approval levels** (`docs/approval-levels.md`, `shared/approval-mode.ts`): ask, auto-accept edits, approve for me, full access, custom. Per bot, applied on the next turn, each level is the provider's own permission mode passed through; Full can only be set from the packaged desktop app (not remote pages); the setting belongs to the source conversation; a webhook/routine turn runs at the bot's level and the decision log notes nobody was at the keyboard.
- **Presets** (`docs/presets.md`): a preset is an allowlist that can carry only name, description, instructions, look, playbooks, skills (text only) and starter notes. It has **no field** for model, computer, approval level, apps, peers or routines, so a preset can never widen authority. Imported skills arrive switched off.
- **Memory** (`docs/memory.md`, `server/memory-store.ts`): plain markdown, `MEMORY.md` (first 200 lines or 24 KB load each turn) plus topic notes and a daily log; a gauge shows what actually loads; writes are atomic, 0600, secret-scrubbed, with an expected-hash check so an editor cannot overwrite what the bot wrote meanwhile; a journal of every change with one-click undo; one switch "Let this bot use memory" that stops loading, recall and automatic logging but keeps the files.
- **Routines** (`docs/routine-schedules.md`, `shared/routine-schedule.ts`): cron (five fields, no seconds or macros) with a required IANA timezone, the next three dates shown in a confirm card before anything is scheduled, preview and execution use one calculation, daylight-saving rules stated, run location defaults to "bot's current setup".
- **Setup shell** (`BotSettingsDialog.tsx`): one dialog, a searchable section list (Identity, Soul/instructions, Skills, Memory, Routines, Access, Model, Permissions, Voice, History, Usage) with keywords per section.

Verdicts:

| Candidate | Class | What exactly | Notes |
|---|---|---|---|
| `memoryCapacity()` (`server/memory-store.ts` lines ~143-226) | **ADOPT CODE** (optional, small) | Pure function returning lines, bytes, what loads and whether it is truncated, mirroring the load cut. Port to our memory loader; use our limits | Apache-2.0 notice required (section 7). Only copy if our loader uses a line/byte cut; otherwise adapt |
| `shared/routine-schedule.ts` validation rules | ADAPT PATTERN | Five-field cron only, named IANA zone, reject macros and seconds, preview next three runs, dates that do not exist are skipped. Add `croner` (MIT, npm) only if we have no cron library; that is a normal dependency, not copied code | We have no cron dependency today (`package.json`). Check the existing scheduler first |
| Memory behaviour: expected-hash write guard, secret scrub, atomic 0600 write, journal with undo, on/off switch that keeps files | ADAPT PATTERN | Exactly those five rules in our memory layer and in Setup's Memory section. Journal row = who, what, before text hash | Our `redact.ts` already scrubs; reuse it |
| Approval levels per bot, applied next turn, belongs to the conversation | ADAPT PATTERN | Setup exposes our existing policy modes as plain levels; a level set from a remote page cannot grant the highest one; a routine turn logs "nobody at the keyboard" | `scripts/coding/policy.ts`. No provider pass-through: our hub decides |
| Preset as an allowlist that cannot widen authority | ADAPT PATTERN | A bot template can carry name, instructions, skills (off by default when imported) and starter notes only; never model, computer, approval level or routines | Needed for "other bots" later |
| Typed "busy" refusal shared by server and UI | ADAPT PATTERN | One constant for "a job owns this computer" used by the API and the Computer tab, so a copy edit cannot turn the busy state into a fault | We already refuse-not-queue; keep one phrase (OPENMAUSBOT-ADOPTION row 12) |
| Take/release lease rules (positive-only sync, failed release re-asserts hold) | ADAPT PATTERN | The client treats a failed hand-back as still held; the UI never shows "released" until the server confirms | Our `lease.ts` has fencing epochs; add the client rule |
| Viewer UX: connect deadline, four states, clipboard, keyboard panel, fullscreen, retry on pageshow, target validated by regex | ADAPT PATTERN | Re-implement in our viewer using the pinned noVNC `RFB` API (documented upstream). Their file is not copied: it uses their i18n, MenuMotion and a hash-route | Our viewer stays on `/__computers/<name>/vnc` with the RFB gate |
| Searchable Setup section list with keywords | ADAPT PATTERN | A Setup tab with sections Purpose and instructions, Computer, Model and account, Skills, Routines, Memory; search is not needed at six sections | Use `src/components/ds` |
| Whole `DesktopViewer.tsx`, `ComputerPanel.tsx`, `BotSettingsDialog.tsx`, `MemorySection.tsx`, `ApprovalModeSelector.tsx` | REJECT as code | Licence permits, but coupling (store, i18n, Electron, their routes, 1834 lines) means a rewrite anyway; copying would also import their provider-specific approval model, which we do not use |
| Mac/Linux local-control (Cua driver), Boat cloud, BYO VPS Docker flow, org library, team setup, `enterprise/` | REJECT | Different architecture or out of scope; `enterprise/` is not Apache |
| Name, mascot, wording of their UI strings | REJECT | Trademarks not licensed; write our own words |

## 4. NVIDIA OpenShell (Apache-2.0)

Files examined at 8719fc9: `README.md`, `docs/about/support-matrix.mdx`, file list of `crates/` (notably `openshell-sandbox/src/sandbox/linux/{landlock,seccomp}.rs`, `openshell-isolation-interface/src/linux/{landlock,child_seccomp,seccomp_notify}.rs`, `openshell-policy`, `openshell-prover`).

Findings:

- It is a Rust control plane: a gateway, a supervisor and per-agent sandboxes enforced by Landlock, seccomp and a policy-checked network proxy, plus a credential-injecting provider layer and a formal policy prover.
- **Windows is "WSL 2 + Docker Desktop, x86_64, Experimental"** (`support-matrix.mdx` line 50), and Docker (28.0+) or Podman is required for the default gateways. Adopting it means adding a second runtime (gateway daemon + container engine) beside our WSL distro and `scripts/computers/docker.ts`, which is exactly the competing runtime we do not want.
- It does not drive a desktop or a noVNC session; it isolates a command-line agent. Our hard parts (a visible browser, noVNC, take over) are outside its scope.

Verdict: **REJECT as a runtime or dependency.** **ADAPT PATTERN** for three things, each done with plain Linux tools inside our existing distro:

1. Per-bot filesystem confinement: a Landlock ruleset (read/write only the bot's home and a shared job-output directory) applied by a tiny launcher at session start, in addition to separate Linux users. Verify first that the WSL kernel exposes Landlock (`cat /sys/kernel/security/lsm` inside the distro); not tested here.
2. Egress allow-list and no raw secrets in the bot's process: keep CDP and noVNC on loopback (already the case), add an allow-listed outbound proxy per computer, and inject credentials at the proxy rather than leaving them in the bot's environment.
3. Policy change review: a change to a computer's allowed hosts waits for the owner (their advisor/prover idea, minus the formal prover).

Do not copy their Rust. If we ever copy a policy schema or seccomp list, Apache-2.0 notice rules apply (section 7).

## 5. context-mode (Elastic-2.0)

Files examined at 928bdf1: `LICENSE`, `README.md` (problem and licence sections), `package.json`, top-level tree (`src/`, `hooks/`, `server.bundle.mjs`, `skills/`, `.claude-plugin/`). Behavioural detail comes from the existing `CONTEXT-MODE-PILOT.md` (v1.0.169; unchanged at HEAD).

Useful for coding context: the `ctx_execute` / `ctx_batch_execute` / `ctx_search` / `ctx_index` MCP tools keep large tool output out of the model's context (their figure: 315 KB to 5.4 KB) and index it in SQLite FTS5 with BM25 for retrieval; session events survive compaction.

Licence limits (ELv2, text verified): you may use, copy, modify and distribute, but **you may not provide it to third parties as a hosted or managed service** that gives them access to a substantial set of its features, **may not move, change, disable or circumvent any licence-key functionality**, and **may not remove or obscure licensing notices**. Modified files need a prominent change notice. For M&U that means: internal coding use is fine; bundling it into a client-facing product or an M&U-hosted agent service is not.

Verdict:

| Candidate | Class | What exactly |
|---|---|---|
| Keep the existing pilot: opt-in, off by default, MCP only, no hooks, four tools, policy wrapper | Already adopted (as a tool, not as code) | No change. Does not belong in the visible workspace for clients |
| Copy any `src/` code (indexer, FTS, hooks) into AgenticOS | REJECT | ELv2 is not a licence we can mix into code we may host for clients; and no need, `bun:sqlite` FTS5 already exists in our stack |
| Pattern: keep large job output as a saved file plus an index, show the model a short summary and a search tool | ADAPT PATTERN | Tasks & Files already saves results; add search over saved results later. Our own code |
| Pattern: session events survive compaction by search, not by dumping back | ADAPT PATTERN | Fits our verified handoff idea; implement independently |

## 6. Matt Pocock's skills (MIT)

Files examined at d81f3a1 (unchanged): the `skills/` tree (engineering, productivity, misc, in-progress) and the `SKILL.md` front matter of the skills below. Already adapted (existing notice section 10, `scripts/coding/guidance/`): `diagnosing-bugs`, `code-review`, `codebase-design`, `tdd`, `to-spec`, `to-tickets`, `implement-spec`, `handoff`.

| Skill (path under `skills/`) | Class | Use for our development workflow |
|---|---|---|
| `engineering/triage` | ADAPT PATTERN (best next) | A state machine for incoming bug reports and requests, each ending in an agent-ready brief. Fits the Tasks view: an owner request becomes a brief with done-when criteria, matching `agent-task-gate` |
| `engineering/prototype` | ADAPT PATTERN | Throwaway prototype to answer one design question. Use for workspace UI questions (tab layout, take-over wording) before building them |
| `engineering/pr` | ADAPT PATTERN | PR body structure for reviewers. Light-touch addition to the reviewer guidance |
| `engineering/domain-modeling` | ADAPT PATTERN | A GLOSSARY.md and short ADRs. Give the workspace one vocabulary (bot, computer, job, thread, lease) and stop the drift between surfaces |
| `engineering/improve-codebase-architecture` | ADAPT PATTERN | Periodic "deepening" scan. Run by hand after the workspace lands, not wired into runners |
| `engineering/retro` | ADAPT PATTERN | Session retrospective; feeds the two-correction rule in the global instructions |
| `engineering/wayfinder` | REJECT for now | Plans work larger than one session on an issue tracker; we plan in programme docs and the board |
| `engineering/research`, `implement`, `ask-matt`, `wizard`, `setup-matt-pocock-skills` | REJECT | Overlap with our planner/builder roles and the `research` bot; `setup-*` and `wizard` are installers for his own setup |
| `misc/git-guardrails-claude-code` | ADAPT PATTERN | Block `push`, `reset --hard`, `clean`, `branch -D` before they run. We already restrict git in the coding policy; compare lists and add anything missing |
| `misc/setup-pre-commit` | REJECT | Husky and lint-staged; not our toolchain |
| `productivity/*`, `in-progress/*`, `deprecated/*` | REJECT | Not development workflow, or unfinished |

Any later verbatim copying of MIT text needs the existing section 10 notice (already present). Keep adapted text condensed and pinned like `manifest.json`.

## 7. Required notices

**No new notice is required for ADAPT PATTERN or REJECT items.** Open Dot adds nothing (nothing copied; existing section 9 stays "adapted files: none"). OpenShell and context-mode add nothing.

If, and only if, `memoryCapacity()` (or any other OpenMausBot file) is copied, add this to `THIRD-PARTY-NOTICES.md` in the same commit, and keep the source file's own comments:

```
## 11. OpenMausBot (Apache-2.0) - adapted code in <list the AgenticOS files>

- Source: https://github.com/milind-soni/OpenMausBot at commit 97fa28497bcc... (record the full 40-hex SHA when copying).
- Copied or adapted: `memoryCapacity()` from `server/memory-store.ts`, changed to use this repository's memory limits and types. State here every other file copied.
- Licence: Apache License, Version 2.0. Full text: https://www.apache.org/licenses/LICENSE-2.0 (reproduce the licence text in `third-party/openmausbot/LICENSE` when first copied).
- Upstream NOTICE, reproduced as Apache-2.0 section 4(d) requires:

  OpenMausBot
  Copyright 2026 Milind Soni and OpenMausBot contributors

- Modifications: each changed file carries a comment "Adapted from OpenMausBot (Apache-2.0), modified by M&U Ventures" with the date.
- Not used: anything under `enterprise/` (separate licence), and the OpenMausBot name, mascot and branding (trademarks are not licensed).
- noVNC is a separate npm dependency under MPL-2.0 (section 8); no OpenMausBot copy of it is used.
```

(The full SHA of 97fa2849 should be taken from `git -C D:/prog-scratch/openmausbot rev-parse origin/HEAD` at the time of copying; only the 8-hex short form was recorded in this review.)

## 8. Recommended reuse for the workspace, in priority order

1. **Open Dot continuity (pattern only, no code).** One bot header with a live status line and a "needs you" state; Chat, Computer, Tasks & Files and Setup as views of one mounted conversation keyed by bot and thread; job, routine and approval messages written into that same thread; a paused or busy bot answers in the thread instead of dropping the message; a routine keeps its own thread. Build on `thread-events.ts`, `agent-workspace.ts` and `workspace-parts.tsx`.
2. **OpenMausBot computer and Setup (patterns, plus at most one small copied function).**
   - Computer: typed busy refusal shared by API and UI; four connection states and a 15 s connect deadline in the viewer; a failed hand-back stays shown as held until the server confirms; keep our lease and RFB gate.
   - Setup: sections Purpose and instructions, Computer, Model and account, Skills, Routines, Memory; approval levels as plain words over our policy; presets that can never widen authority; memory with a load gauge, expected-hash writes, journal with undo and one on/off switch; cron with a named timezone and a three-date preview.
3. **OpenShell patterns for the WSL computers**, as a follow-up task not part of the workspace UI: per-bot Landlock confinement (after checking kernel support), an allow-listed egress proxy with credential injection, owner review of allow-list changes. No dependency, no second runtime.
4. **Matt Pocock skills:** `triage` first (owner request to agent-ready brief), then `domain-modeling` (a glossary for the workspace), `prototype`, `pr`, a comparison against `git-guardrails-claude-code`.
5. **context-mode:** leave as the opt-in internal pilot; do not ship it in client-facing or hosted form (ELv2). Implement search over saved job results ourselves.

## 9. Open items

- Open Dot: if the authors add a LICENSE, this record should be re-run; until then, no code.
- `memoryCapacity()` is optional; decide when the memory loader is designed whether its cut rule matches. If not, adapt instead and no notice is needed.
- OpenMausBot is 169 commits ahead of the recorded revision; the files read here were read at `97fa2849`. Anything copied must be re-read at the SHA recorded in the notice.
- Landlock availability inside the WSL distro is unverified.

## 10. Round 7 re-check (3 Oct 2026): Rakazo and the other references, for the Agents interface

Read-only. Shallow clones (Rakazo and OpenMausBot deepened for history) under the session scratchpad `r7refs/`; nothing run, installed or signed in, no `.env` or credential file opened. Files were read in the working tree of each clone at the SHA below. Earlier decisions in sections 1 to 9 stand unless a row here says otherwise.

### 10.1 Pinned revisions and licences

| Repo | SHA (full) | Date | Licence (file read) | Notices | Verdict for the Agents UI |
|---|---|---|---|---|---|
| elie222/rakazo | `df708491af0e53dec9c4cf9aad1907317db835d0` | 2 Oct 2026 | **Apache-2.0** (`LICENSE`, `package.json` `"license": "Apache-2.0"`) | No `NOTICE` file in the tree, so no section 4(d) text to carry | **Primary pattern source. Nothing copied.** Interaction ideas only, written independently against `src/components/ds` |
| composio-community/open-dot | `f838e17cf5c3a88ade5ceea54680a8145d048c1d` | 30 Sep 2026 | **None** (no LICENSE; unchanged since section 1) | n/a | Unchanged: patterns only, no code or strings |
| milind-soni/OpenMausBot | `b9ab44b973a59166aff56b4b623be238ac4b8ba0` | 2 Oct 2026 | Apache-2.0 outside `enterprise/` (`LICENSE`; `NOTICE` reads "OpenMausBot Copyright 2026 Milind Soni and OpenMausBot contributors") | Unchanged since `97fa2849` | One new thing: Simple/Advanced settings (row 15). Nothing copied |
| NVIDIA/OpenShell | `046fd2a0246d6765845b3abf6f9cb2c74005781f` | 2 Oct 2026 | Apache-2.0 (NVIDIA CORPORATION & AFFILIATES) | unchanged | No Agents UI relevance; section 4 stands |
| mksglu/context-mode | `b706902adbc01e6da17c72464090bc092275c66a` | 2 Oct 2026 | Elastic-2.0 | unchanged | No Agents UI relevance; section 5 stands (never shipped to clients) |
| mattpocock/skills | `d81f3a183412e71a5b1e84ca21bc1a35eea03a60` | 29 Sep 2026 | MIT (Matt Pocock) | unchanged | No Agents UI relevance; section 6 stands |
| Panniantong/Agent-Reach | `a19a171fa980a0785849596492e0af4db800c82f` | 16 Sep 2026 | MIT (Agent Eyes, 2025) | n/a | Not relevant to the Agents UI (an internet-access installer for agent CLIs). Its `doctor` health check is what the hub's readiness reasons already do. Not adopted |
| anthropics/financial-services | `574ed3624aebd0418c7e96cd101262f30210ab26` | 21 Sep 2026 | Apache-2.0 | n/a | Not relevant (finance plugin and cookbook bundles). Finance stays research-only and is not an Agents surface |
| tashfeenahmed/freellmapi | `f56816b8d09522e0609ad6b19d413f24e24f757b` | 1 Oct 2026 | MIT (Tashfeen Ahmed, 2026) | n/a | Not relevant to the UI (an aggregating free-tier proxy). Model choice stays on our existing router routes (model spend policy); no free-tier catalogue in Setup |

### 10.2 Rakazo: what it is, verified

- **Provenance.** Rakazo is a standalone open-source project led by Elie Steinbock (`elie222`; he authors most of the last 40 commits, the rest come from named contributors). Its README calls it "an open-source platform for running persistent AI teammates", on web, Electron and Expo, with a hosted site at rakazo.com. It is **not** an official xAI or Grok project and is unrelated to `xai-org/grok-build` (audited in `REFERENCE-AUDIT-GROK-OPENBOT.md`). Stack: React 19, Vite, Tailwind, Hono, oRPC, PostgreSQL, the Pi agent runtime, Lingui i18n, a local `@rakazo/ui-web` component library.
- **Coupling.** Its UI imports Lingui macros (`useLingui`, `Trans`), `@rakazo/ui-web` and `@rakazo/contracts`, oRPC clients, and Playwright journeys that sign up real accounts. None of that exists here, so **no file is lifted**. Apache-2.0 would permit copying with a header and notice, but rewriting every import costs more than writing the interaction against our design system, and our data model (bots on shared computers, a control lease with a fencing epoch) differs. Consequence: no `THIRD-PARTY-NOTICES.md` entry is required and none was added. Each file that applies a Rakazo idea says so in its header comment ("idea, from Rakazo; no code").
- **Files read at the pinned SHA.** `apps/web/src/pages/shell/bot-panel.tsx` (create form; settings for name, title, description, instructions, colour, notify, computer mode, memory scope, voice, model and thinking level, credentials), `bot-picker.tsx`, `apps/web/src/components/computer/ComputerWorkspace.tsx` (the live screen with a dock that opens Terminal and Files as movable windows; the browser button tucks them away; windows stay mounted), `docs/computer-runtime.md` (computer contract; takeover refused with 409 "Stop the bot first" unless the run waits for takeover; screen connection diagnostics; maintenance jobs), `docs/agent-verification.md` (verification layers), `apps/web/src/lib/computer-screen.ts` (latest-request-wins screen loading), and the browser journeys `bot-crud.spec.ts`, `new-bot-ux.spec.ts`, `computer-screen-error.spec.ts`, `computer-workspace.spec.ts`, `computer-needs-you-card.spec.ts`. History read for intent: resizable right rail with retained width (`5575397`, `7b37fd6`), queued/starting/working state in the bots sidebar (`bbf44ae`), screen connection diagnostics (`2913bb2`), routine run history (`443b83f`).

### 10.3 Feature matrix (what was done with each, and the evidence)

Classes: **Adapted** (idea, independent code, shipped this round), **Already present** (we had it; checked), **Deferred** (not built, owner named), **Rejected**.

| # | Reference behaviour | Ours | Class | Where / evidence |
|---|---|---|---|---|
| 1 | Persistent bot list with identity and live state (`bbf44ae`: queued, starting, working) | `BotRail`: initial mark, name, a few words of live state (`shortStatus`), dot plus words; the compact selector row below 1360 px | **Adapted** | `workspace/bot-selector.tsx`, `status.ts`; `after-1440-01`; `bot-rail.test.tsx` |
| 2 | Bot list collapses; picker with search | We have 2 to 6 bots; search adds nothing. The shell sidebar already collapses | **Deferred** (revisit past 8 bots) | n/a |
| 3 | Conversation beside its computer; rail resizable and remembered (`5575397`, `7b37fd6`) | Resizable panel with separator, keyboard use, remembered width and open state, shipped in round 6 | **Already present**, improved: controls moved to the tab row, the pane fills the window height, the phone switch keeps state | `layout/chat-computer-layout.tsx`; `after-1440-02`, `after-390-01` to `03` |
| 4 | Full-screen computer view | Expand opens the browser's own full screen where allowed, otherwise an overlay over the conversation; Escape or the button returns; the conversation stays mounted | **Adapted** | `chat-computer-layout.tsx` (`setFull`); `after-1440-03` (overlay fallback; native full screen cannot be captured headless) |
| 5 | "Needs you" card opens the computer (`computer-needs-you-card.spec.ts`) | The header status line carries one action button (Show computer, Open Tasks or Open Setup) chosen from the status by `statusAction`; the in-thread card is proposed to worker B | **Adapted** (header) / **Deferred** (card: B) | `workspace-page.tsx`; `R7-A-PROPOSALS.md` |
| 6 | Screen failures stay visible with a retry (`computer-screen-error.spec.ts`, diagnostics `2913bb2`) | Viewer failure and Reconnect exist (C's `ComputerTab`, 15 s deadline). A viewer-only retry is proposed to C | **Deferred** (C) | `R7-A-PROPOSALS.md` |
| 7 | Files app: browse, preview, download, upload under control | Tasks & Files lists job results and saved files with Open and Download (D). A browse-the-computer file list is proposed to C | **Deferred** (C) | `after-1440-04` |
| 8 | Terminal window and activity feed on the computer | **Not built here, so not advertised**: no Terminal button, copy or tab anywhere in the Agents UI (a search of `workspace/` and `setup/` finds none) | **Deferred** (C; needs a PTY) | n/a |
| 9 | Create-bot form (name, title, description, Team or Private computer) | New bot panel (name, purpose, a computer from the existing shared ones, first model, instructions); while open it replaces the workspace body, so a form never squeezes into the list | **Already present**, placement changed | `after-1440-06`, `after-390-06` |
| 10 | Duplicate, archive and delete | Duplicate (copies settings, never history) and archive or unarchive under the hub's rules (the last active bot is refused, open work is named). No delete, by design: nothing a bot did is ever deleted | **Already present** | `after-1440-07` to `11` |
| 11 | Bot settings: colour or avatar, notify on finish, voice, thinking level, credentials | Not copied. Purpose, instructions, computer, model and account, skills, routines and memory are in Setup and write through the rev-checked PATCH. Credentials and an avatar studio are out of scope (accounts are managed by the hub) | **Deferred** / **Rejected** (credentials) | `after-1440-05` |
| 12 | Groups and Spaces | Out of scope: two founders, one shared workspace | **Rejected** | n/a |
| 13 | Teach a task (record and replay) | Out of scope this round | **Rejected** | n/a |
| 14 | Routine run history with older runs (`443b83f`) | Setup lists routines read from the hub; a routine's log opens in its own thread (section 2, row 6) | **Deferred** (B, D) | n/a |
| 15 | OpenMausBot `b9ab44b`: Simple mode by default; the settings panel is Details plus Library, with "All settings" for the rest | Setup already leads with the everyday fields (name, purpose, instructions) and a jump list; Library is our Tasks & Files. A ready bot now shows only the jump list instead of a readiness card; section gaps are tighter. A global Simple/Advanced switch is **not** added: the owner is not a beginner and hiding controls works against durable, discoverable settings | **Adapted** (compact Setup); switch **Rejected** | `setup/sections.tsx`, `bot-setup.tsx`, `controls.tsx`; `after-1440-05` |
| 16 | `agent-verification.md`: keep deterministic regressions apart from real-model quality; missing live credentials mean "not run", not "passing" | Applied to this round's evidence: the computer panel was captured against a synthetic failed computer; a **live** viewer stream was **not run** (this hub has no host) and is not claimed | **Adapted** (as wording) | 10.5 |
| 17 | Computer maintenance as background jobs, with an explicit release for interrupted ones | Lease and recovery exist in `scripts/computers` (C); nothing for the UI shell | **Deferred** (C) | n/a |

### 10.4 What changed in our own files because of this

Owned files only: `workspace/workspace-page.tsx`, `workspace/bot-selector.tsx`, `workspace/status.ts`, `workspace/layout/chat-computer-layout.tsx`, `layout/conversation.tsx`, `setup/sections.tsx`, `setup/bot-setup.tsx`, `setup/controls.tsx`, and the tests beside them. Removed: the visible page title, the separate status row, the repeated "no computer" line on the tab row, the fixed-height clamp that pushed the composer below the fold, the full readiness card on a ready bot, the heavy Setup section gaps. Added: a loading skeleton, "Agents aren't available" with Try again, the bot list, the header action. Changes that belong to other owners are in `R7-A-PROPOSALS.md`.

### 10.5 NOTICE

**Nothing from Rakazo, OpenMausBot, Open Dot or any other repository above was copied in this round**, so there is no new third-party notice. If a later round copies a Rakazo file: keep its Apache-2.0 header, put "Adapted from Rakazo (Apache-2.0), modified by M&U Ventures, <date>" in the file, and add a `THIRD-PARTY-NOTICES.md` section with source `https://github.com/elie222/rakazo`, the full SHA above, the list of files and the licence text (Rakazo has no `NOTICE` file, so there is no upstream notice to reproduce). Re-read the file at the SHA recorded in the notice.

Open items: a live computer viewer was not exercised on this hub (host `none`), so the Computer panel's live stream, take-over and hand-back are evidenced only by round 6 and the unit tests. The Landlock check (section 9) is unchanged.
