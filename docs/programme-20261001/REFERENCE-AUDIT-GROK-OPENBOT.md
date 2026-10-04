# Reference audit: Grok Build and OpenBot against AgenticOS-v4 (3 Oct 2026)

Read-only. Shallow clones under `scratchpad/refs/`; nothing run, installed or signed in. Ours read at `D:\AgenticOS-ws-integration` (HEAD `0b3cc9b0`). No env, credential or auth file content was read. Marks: **[R]** read in source, **[I]** inferred.

## 1. Revisions and licences

| Repo | Upstream SHA | Licence (verified) | Notices and vendored parts |
|---|---|---|---|
| xai-org/grok-build | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (29 Sep 2026). `SOURCE_REV` records monorepo `559751fdcec02d413e4c57c8832ab275e4f44980` | Apache-2.0, "Copyright 2023-2026 SpaceXAI" (`LICENSE`). No root `NOTICE`, so no §4(d) text to carry | `THIRD-PARTY-NOTICES` (16.7k lines): mostly MIT / Apache-2.0 crates; in-tree **ports of openai/codex (Apache-2.0) and sst/opencode (MIT)** in `xai-grok-tools` with a §4(b) change notice. `third_party/`: mermaid-to-svg (MIT), dagre_rust, graphlib_rust, ordered_hashmap (Apache-2.0). `third_party/NOTICE` also lists nfsserve (BSD-3) but that directory is **absent** from the tree. External contributions not accepted |
| ashhart/OpenBot | `b544cb743986193fdc3d234ae66c8e44ef68fc00` (14 Aug 2026) | MIT, "Copyright (c) 2026 OpenBOT contributors" (`LICENSE`, `package.json`) | `THIRD-PARTY-NOTICES.md`: bundled highlight.js (BSD-3), marked (MIT), React, Electron (MIT); **adapted from Synara (MIT, T3 Tools Inc. and Emanuele Di Pietro)**: the agent-CLI backend layer. README calls it a re-implementation of "GrokBot". Containerfile pins `node:22-bookworm-slim` by digest. **No test files in the repo** [R] |

Consequence: anything lifted from OpenBot's backend layer carries Synara's notice as well as OpenBot's. Anything lifted from Grok's tool crates carries OpenAI and sst notices.

## 2. Findings that decide the matrix

- Our coding harness already does what OpenBot's Claude adapter attempts, more safely. OpenBot keeps session state **in module memory** (`claudeSession.ts:14,23`, `resumePrompt.ts:23`); ours persists `nativeSessionId` on the run.
- OpenBot's retry has a defect we must not copy: `answered` flips only on text or reasoning (`claude.ts:179-189`), so a failed resume after **tool calls already ran** is retried on a fresh session. That can repeat side effects.
- OpenBot's "takeover" **stops the turn** (`ComputerFrame.tsx:91`) unless the bot asked for help. Ours moves a fenced lease at a safe step boundary (`scripts/computers/lease.ts:3-20`).
- OpenBot's rail is a fixed 320 px, not resizable (`tokens.css:224`, `RightRail.css:62-72`) [R]. The computer view is screenshot polling, not a stream.
- Our only demonstrated operator-facing gap is layout: Chat and Computer are mutually exclusive tabs.

## 3. Matrix (priority order)

| # | Reference feature | Ours (file:line) | Demonstrated gap | Verdict | We would own or change | Acceptance proof |
|---|---|---|---|---|---|---|
| 1 | Chat beside live computer: rail with frame, "needs you" banner, "bot is controlling" line (`App.tsx:67`, `RightRail.tsx:9-26`, `ComputerFrame.tsx:157-184`) [R] | Tabs, one body at a time: `workspace-page.tsx:81-86`; `computer-tab.tsx:61-110`; chat link only, `slots.tsx:37` | **Yes.** Cannot type to the agent while watching its screen | **Adapt** (idea only; build on our `PreviewPanel`, lease state and status line; add our own drag resizer, which OpenBot lacks) | `workspace-page.tsx`, new split container, `computer/viewer.tsx`, `status.ts`; stack on phones | Screenshots at 1280 and 375 px: composer usable while viewer connected; status line shows task, blocker and controller; existing `control-state` tests green |
| 2 | Agent-initiated `request_help` (login, 2FA, CAPTCHA): tool blocks, takeover opens, same turn resumes (`tools/agent/help.ts:32`, `ComputerFrame.tsx:78-102`) [R] | Lease takeover is person-initiated only (`lease.ts`); status knows `awaiting-approval` (`status.ts:48`). grep for captcha / request_help / askHuman in `scripts/computers`, `scripts/jobs`: no hit | **Probable [I]**: an agent cannot ask the person to step in and then continue | **Adapt**; confirm with a wider grep first | hub job state, `scripts/computers/lease.ts`, `status.ts`, `control-state.ts` | Test: agent raises request, lease moves to person with epoch bump, return resumes the same job without replaying a completed step |
| 3 | Bot create / duplicate / archive (`store/bots.ts:225,262,296`, `shared/bots.ts:14-36`) [R] | Seed two bots once, patch only: `scripts/agents/store.ts:57-76`; `validate.ts:122` | **Yes.** Cannot add a second Builder on another account | **Adapt, small**: duplicate and archive only; keep `rev` guard; no create wizard | `store.ts`, `routes.ts`, `validate.ts`, `types.ts`, Setup sections | Route tests: duplicate copies fields, new id and rev 1, never the conversation; archived bot hidden from selector, history kept |
| 4 | Claude adapter: `--session-id` then `--resume`, send unseen history only, retries (`claude.ts:125-199`, `resumePrompt.ts:38`) [R] | `runners/claude.ts:139-140,154`; `orchestrator.ts:462-470,532-535` (resume sends a short note, native session holds history); never retries (`runners/types.ts:6-9`); `fallback.ts` no repeats | **No gap.** Ours is persisted, receipted, never replays | **Reject**; copy two lessons as tests (below) | tests only | Test: no retry once any tool call started |
| 5 | Provider failure vs interruption (`stdioJson.ts:112-134`, `supervisedTurn.ts:54`: exit code decides; idle clock) [R] | `RunnerStatus`: succeeded, failed, cancelled, interrupted, blocked_allowance, termination_unverified (`runners/types.ts`); `claude.ts:203-235` | No gap | Reject | none | none |
| 6 | Bot skills: menu of name, description, path in the prompt, capped 40 / 6000 chars, defanged (`skills/prompt.ts:46`) [R] | Abilities derived, read-only (`abilities.ts:4`); PATCH refuses skills (`validate.ts:122`); coding guidance is three pinned files (`guidance.ts`) | Yes, but low value: coding roles load no skills by design | **Defer** | n/a | n/a |
| 7 | Results and inbox (`ActivityPanel.tsx:35-115`) [R] | Tasks & Files with receipts, tests, branch (`scripts/agents/types.ts:96-137`, `tasks-tab.tsx`); per-bot status in selector | No gap; ours is richer. Unread or mark-read is the only extra | Reject | none | none |
| 8 | Multi-bot collaboration: `ACTION: SPEAK/ASK/YIELD/FINAL` text protocol, cap of 12 hand-offs, defanged briefs (`exchange.ts:156`, `limits.ts:19`, `handoffBrief.ts`) [R] | None bot-to-bot; operator-driven; command dedupe by event id (`linked-run.ts`, `jarvis-command/service.ts:300`) | None needed. OpenBot's loop control is a count cap plus one nudge; duplicate-work prevention is **not** demonstrated | **Defer** | n/a | n/a |
| 9 | Execution targets (macOS VM, browser profile, loopback-only daemon contract, `docs/VM_CONTRACT.md`) [R] | WSL desktops, noVNC, leases (`scripts/computers/*`, `bridge-guard.test.ts`) | No gap; macOS-only | Reject | none | none |
| G1 | Grok headless `-p --output-format streaming-json` vs ACP `grok agent stdio` (`14-headless-mode.md`, `15-agent-mode.md`, `xai-acp-lib`) [R] | Claude route uses `--permission-prompt-tool stdio` so every tool use reaches our policy (`claude.ts:17-24`); `policy.ts` | No Grok route exists anywhere in repo. Headless is one-way: no approval channel, so it needs `--yolo` or static rules (docs: approvals use ACP) | **Defer**. If ever built: ACP only, never headless `--yolo` | new `runners/grok.ts` behind `RoleRunner` | see section 4 |
| G2 | Resume `-r <id>`, `-s <uuid>` create-only, `--fork-session` [R doc] | `claude.ts:139-140` | No gap | Reject | none | none |
| G3 | `end` event: always last, `stopReason` end_turn / max_tokens / max_turn_requests / refusal / cancelled; usage may be incomplete; cost absent for OAuth; messages format zero-fills usage (`headless/reducer/acp.rs:182`) [R] | `finalText` "never proof" (`runners/types.ts`); gate and tests decide | No gap. `end` proves only that a turn stopped, not that work, tests or commit succeeded | Reject; keep our rule | none | none |
| G4 | Cancel: first SIGINT/SIGTERM parked so the turn settles, second exits (`headless/signals.rs`); `ProcessScope` killpg / TerminateJobObject (`xai-tty-utils/src/process_scope.rs:170`) [R] | interrupt then `verifiedKill` with `termination_unverified` (`proc.ts:48`, `claude.ts:217-235`) | No gap; ours confirms the kill. Grok's README says Windows is untested | Reject | none | none |
| G5 | Hooks: PreToolUse deny, Stop can block, StopCancelled; allow/deny globs (`10-hooks.md`, `xai-grok-hooks`, `xai-grok-permission-rules`) [R doc] | `runners/policy.ts` before any human; `--restricted` | No gap. Pitfall: Grok loads `~/.claude/settings.json` and Cursor hooks by default | Reject | none | none |
| G6 | Model endpoints `[model.x]` (`chat_completions` / `responses` / `messages`, `api_key`, `env_key`), `init.model`, `modelUsage`, `total_cost_usd` (`11-custom-models.md`) [R doc] | `receipts.ts:126,137-161` records provider-reported model and mismatch; `scripts/model-router` | No gap | Defer | none | none |

## 4. Grok Build proof run: what is unverified

Mechanics are documented: `grok -p ... --output-format json|streaming-json`, ACP `grok agent stdio`. Auth order: per-model `api_key`/`env_key`, then the stored `grok login` session (SpaceXAI OAuth at auth.x.ai, `~/.grok/auth.json`), then `XAI_API_KEY` (console.x.ai).

Local state (existence checks only): `C:\Users\Nebula PC\.grok\bin\grok.exe` is installed (27 Sep) and `~/.grok/auth.json` **does not exist**, so it is not signed in. Binary version was not probed.

**Exact unverified dependency:** a credential the owner must supply, either a completed `grok login` (browser sign-in to a SpaceXAI account) or an xAI API key with billing, plus a custom model entry only if a non-xAI endpoint is wanted. Also unverified: whether any consumer subscription grants CLI entitlement (docs do not say), that the installed 27 Sep binary matches this source, and that headless runs cleanly on Windows. Cost fields appear only for API-key traffic, so a subscription proof would show tokens but no dollars.

## 5. Top recommendations

1. Adapt the chat-beside-computer split (row 1).
2. Verify, then adapt agent-initiated help requests (row 2).
3. Adapt bot duplicate and archive (row 3).
4. Add tests from OpenBot's two failures: no retry after any tool call; session ids persisted, not in memory (row 4).
5. Defer Grok Build until an owner credential exists; if built, ACP only.
