# Reuse notes (adopt / adapt items only)

Upstream SHAs: OpenBot `b544cb743986193fdc3d234ae66c8e44ef68fc00`; grok-build `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`. Paths are relative to each clone. Default stance: **re-implement the behaviour in our own code**. No OpenBot file is liftable: it is Electron, its own IPC store and its own CSS tokens. Copying any substantial expression carries the notices below.

## Obligations if any OpenBot code or close paraphrase is used

MIT: keep "Copyright (c) 2026 OpenBOT contributors" plus the permission notice in a THIRD-PARTY-NOTICES entry. If the file touches the CLI backend layer (`src/main/backends/cli/*`, `jsonRpc.ts`, `spawnProcess.ts`, `loginShellEnv.ts`), also keep Synara's notice: "Copyright (c) 2026 T3 Tools Inc. / Copyright (c) 2026 Emanuele Di Pietro" (MIT). Behaviour described from reading, with our own code and wording, needs no notice, but our `AGENTS-WORKSPACE-REFERENCES.md` should record the row. Do not reuse the OpenBOT name or any "GrokBot" wording.

## Row 1: chat beside computer (adapt)

- Read, do not copy: `src/renderer/src/App.tsx` (rail mounted beside the conversation at line 67), `components/RightRail.tsx`, `components/ComputerFrame.tsx` (banner and live line, lines 157-184), `ComputerFrameHead.tsx`, `lib/paneLayout.ts`.
- Worth taking as ideas: one persistent computer frame next to the conversation; a banner when the bot needs the person; a single sentence saying who is driving; a slimmer layout on narrow windows (`RightRail.css:62-72`).
- Pitfalls: their rail is fixed width and not resizable, and they poll screenshots. Our resizer, phone stacking (viewer collapsed under the composer) and live noVNC are ours to write. `ComputerFrame` resets takeover when the bot changes (`useEffect` on `activeBot?.id`); keep that rule so one bot's pixels never sit under another bot's controls. Do not copy their takeover (it stops the turn); keep our lease.

## Row 2: agent-initiated help request (adapt, after confirming the gap)

- Read: `src/main/tools/agent/help.ts` (`requestHelpTool`, handler at line 32): pending map, blocks until the human returns, refuses when the run was aborted, caps the reason at 500 characters, local target refused. `ComputerFrame.tsx:78-102` for the UI side: no stop of the turn while a help request is pending.
- Take: the contract "tool returns only after hand-back", the 500-character reason cap, refusal when aborted, and never accepting the request on a personal PC.
- Pitfalls: their pending state is in module memory and dies with the app; ours must live in the job and lease record so a hub restart shows "needs you" rather than silence. Our fencing epoch must bump on both hand-over and return. Never let the request text carry credentials; show only the reason.

## Row 3: duplicate and archive bots (adapt)

- Read: `src/main/store/bots.ts` (`duplicateBot` line 262, `updateBot` 276, `removeBot` 296, list ordering that puts archived last at 198-215), `shared/bots.ts:14-36` for the `archived` and `pinned` flags, `ipc/bots.ts:99` for the result shape `{ ok, error }`.
- Take: archived is a flag, not a delete; archived bots sort last and drop out of pickers; duplicate resets `archived`.
- Pitfalls: a duplicate must get a fresh id, `rev: 1`, no shared conversation id, and must not inherit a computer another bot already holds (our lease allows one holder per computer). Their schema (backend, model, tools list) does not map to ours (`route`, `coding.accountSlot`); do not import it.

## Row 4: lessons as tests only (reject code)

- Read: `src/main/backends/cli/claude.ts:125-199`, `claudeSession.ts`, `resumePrompt.ts`.
- Ideas worth a test in `scripts/coding/runners/claude.test.ts`: (a) a failed resume after any tool call has started must not trigger another attempt (their `answered` flag ignores tool use, so ours should assert the opposite); (b) a derived session id must not be reused after a failed resume (their note at `claudeSession.ts:17-22`: `--session-id` refuses a seen id).
- Pitfall: their module-level maps lose state on restart; we persist, keep it that way.

## Grok Build (defer; notes if ever built)

- Surface to use: `crates/codegen/xai-acp-lib` and `xai-grok-pager/docs/user-guide/15-agent-mode.md` (ACP over `grok agent stdio`, `session/request_permission`, `session/prompt`, `session/set_config_option`). Use the TypeScript ACP SDK (`@agentclientprotocol/sdk`) rather than porting Rust. Its licence is **not verified** here.
- Do not use headless `--yolo`; it removes the approval channel. If headless is used for read-only review, pass `--tools` allowlist and `--permission-mode`, parse `streaming-json`, and treat `end` as "turn stopped", never "work done".
- Licence: Apache-2.0. Reusing Rust code needs the Apache text, retained copyright headers and a change notice; reusing the codex or opencode ports inside `xai-grok-tools` adds OpenAI (Apache-2.0) and sst (MIT) notices. We would not copy Rust into a TypeScript harness, so the practical obligation is nil unless a schema or prompt text is lifted.
- Pitfalls: Grok loads `~/.claude/settings.json` and Cursor hooks by default, and project hooks need folder trust (`--trust`); a proof run must use an isolated `GROK_HOME`. Cost fields exist only for API-key traffic. A Windows build is untested upstream.
