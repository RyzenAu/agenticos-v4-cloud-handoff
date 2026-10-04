# Local patches to claude-os

**Vendor:** `claude-os` v3.6.1 by Jack Roberts. **Host:** Windows 11, Node 23.5.0, Bun 1.4.2.
**Maintainer:** Usman (M&U Ventures). **Baseline committed:** 2026-09-23.

This is a vendor application with local modifications. It is **not** a fork of an upstream
git history — the vendor ships a tarball, so the first commit here is
**vendor 3.6.1 *plus* our patches**, not a pristine tree. That distinction matters on
upgrade day; see "Upgrading" below.

Nearly every patch exists because **the vendor tests on macOS only**.

## Identifying our changes

`MANIFEST.sha256` is the vendor's own integrity list of 827 files. Comparing the tree
against it prints exactly the files we have touched — this is the authoritative patch list
and it does not depend on anyone remembering to update this document:

```bash
python - <<'PY'
import hashlib, os
for line in open('MANIFEST.sha256', encoding='utf-8'):
    if not line.strip(): continue
    h, p = line.rstrip('\n').split('  ', 1)
    if not os.path.exists(p): print("MISSING ", p); continue
    if hashlib.sha256(open(p, 'rb').read()).hexdigest() != h: print("MODIFIED", p)
PY
```

As of the baseline commit this reported **42 modified, 0 missing**. After the Jarvis change it is **43**.

## The patches

| # | Area | File(s) | What and why |
|---|---|---|---|
| 1 | Windows argv limit | `vite.config.ts` | Prompts were passed as a command-line argument. Windows caps a whole command line at 32,767 chars; macOS allows ~1 MB, and the daily brief alone is ~55 KB, so it could never work. Now >16,000 chars goes via **stdin** (`claude -p` and `codex exec` both read it with no prompt arg). Measured cliff: 32,000 spawns, 34,000 gives `ENAMETOOLONG: uv_spawn`. |
| 2 | Model-name regex | `vite.config.ts` (2 sites) | The validator rejected 20 of the app's own 383 catalogue names (18 Hermes `~vendor/model`, 2 bracketed `[1m]`), returning 400 `invalid model`. Alone this broke voice's `ask_workspace`, the inbox Summarise/Draft actions, and chat. Widened to `/^[A-Za-z0-9~][A-Za-z0-9_.\/:\[\]-]{0,119}$/`. |
| 3 | Voice hung up on tool errors | `src/components/operator/voice-companion.tsx` | The ElevenLabs SDK calls `onError` for a failed *client tool* as well as for a dead connection, and already returns the error to the agent. The app treated both as a dropped call and ran `stop()`. Tool failures are now logged and the call continues. |
| 4 | ElevenLabs voice setup | `scripts/voice-companion.ts` | Two vendor bugs: `eleven_flash_v2_5` is the *multilingual* model and ElevenLabs hard-rejects it for `language: "en"`; and every new agent now carries a default `start_node` workflow, which the verifier refused. |
| 5 | Hermes CRLF config | `vite.config.ts` | Parser used `indexOf("model:\n")`; Hermes writes CRLF. The `^agent:\n` reasoning-effort writer now preserves existing line endings. |
| 6 | Hermes prompts off argv | `vite.config.ts` | Now uses `--query-file -` (stdin) at both call sites. |
| 7 | Higgsfield catalogue | `scripts/higgsfield-api.ts` | `console.higgsfield.ai` now 301s to `open.higgsfield.ai`, and the console also 301s away from percent-encoded path separators. The adapter fetches with `redirect:"error"`, so the catalogue and every schema page threw, leaving one hardcoded MCP model. Fixed host + per-segment encoding, plus a pricing-API fallback. **1 model -> 23.** |
| 8 | `/__design_author` hang | `scripts/assistant-adapters.ts` | `execFile` on a `.cmd` throws synchronously under Bun; `res` was never ended, hanging the browser forever. Now shim-aware spawn + stdin. |
| 9 | Photos preview | `scripts/photo-index.ts` | Unguarded macOS `sips` call. |
| 10 | Memory file search | `scripts/local-memory-search.ts` | Shelled out to macOS `mdfind`; the ENOENT was swallowed by `Promise.allSettled`, so **every** query silently returned empty. Replaced with a bounded, cycle-safe walk on non-darwin. |
| 11 | Free-tier balance | `vite.config.ts` (2 sites) | Reported the tighter of account balance and key allowance, which is wrong for a free-tier key whose account credit is legitimately $0. Design showed **$0** on a key with $18.98. |
| 12 | Misc Windows fixes | `scripts/run-dream.ts`, entry points, `package.json` | Chat titles, Windows kill paths, Hermes version `\r`, Antigravity/Notion probes, `bun --bun` start. |
| 13 | Test suite | 25 `*.test.ts` | 79 failures -> 0. All were test-only artifacts: `EBUSY` on temp cleanup *after* assertions passed, and POSIX file-mode/path assumptions. |
| 14 | Hermes connections bar | `vite.config.ts` (`/__hermes_connections`) | Read only `auth.json` → `providers`. Hermes ≥0.21 stores every credential in `credential_pool` (env-seeded API keys and `hermes auth add` OAuth logins), so the Hermes page said "No Hermes connections yet · run hermes setup" with three working providers. Pooled providers now surface too, with a count (`openai-codex ×3`). |
| 15 | Hermes console windows | `vite.config.ts` (3 spawn sites) | Hermes was spawned with `detached: true` and no `windowsHide`. On Windows a detached console program gets its **own visible console window**, so every Hermes turn (including every Jarvis `control_pc` task) popped up a terminal, and closing it killed the task after one message. Added `windowsHide: true`, as the vendor already does elsewhere. |
| 16 | Launches hung 15 s | `src/lib/jarvis-control.ts`, `~/.hermes/SOUL.md` | Hermes was told to open apps with `cmd /c start`; the app inherits the terminal's output pipe, so the terminal tool waited for it to exit and timed out (Notepad took 65 s). `Start-Process` returns in 0.3 s. |
| 17 | "Stop" didn't stop | `vite.config.ts` (`/__hermes_chat`) | On hang-up the route called `child.kill()`, which on Windows ends only the `hermes.exe` launcher: its Python worker and every command it started kept running. Now `killTree` on the response closing unfinished; verified 0 leftovers vs 2 before. |

## Local features (not vendor bug fixes)

These are deliberate changes to behaviour, not Windows compatibility fixes. Expect them to
conflict on upgrade and re-apply them by intent rather than by patch.

| Area | File(s) | What and why |
|---|---|---|
| Agent reconcile + honest error | `scripts/voice-companion.ts` | `/voice/configure` never overwrites an existing agent, so a prompt edit or a new client tool stayed inert in ElevenLabs forever, while `verifyAgent` rejected every session for not matching. Added `/voice/reconcile`: creates only the missing tools and PATCHes the existing agent's prompt and `tool_ids` in place, never creating a second agent. `request()` gained PATCH support. Also, the "add navigate/search_memory/ask_workspace" error text was hardcoded to three tools, so after a fourth was added it instructed the reader to build the exact configuration it was rejecting -- it is now generated from `VOICE_CLIENT_TOOLS`. |
| Jarvis + meeting drafting | `scripts/voice-companion.ts`, `src/components/operator/voice-companion.tsx`, `src/components/floating-oracle.tsx` | The voice agent called itself "the Agentic OS companion" and had three read-only tools, so it could not act on a request to schedule anything. Renamed to **Jarvis** and added a fourth client tool, `prepare_meeting`. The tool stops at a draft: it fills the existing `ChatCalendarReview` card and the user confirms on screen. Booking emails every attendee, so voice alone must not trigger it. Draft parsing reuses the vendor's `parseCalendarDraft`. |
| Free voice engine (Groq + Gemini) | `scripts/free-voice.ts`, `scripts/operator-plugin.ts`, `src/lib/free-voice-client.ts`, `src/components/operator/voice-companion.tsx`, `src/lib/voice-transcript-store.ts`, `src/lib/use-voice-transcript.ts` | Fourth Jarvis engine, now the default when `GROQ_API_KEY` is set. Turn-based: browser VAD, then Groq Whisper (`/voice/free/stt`), then a Groq brain with tool calls (`/voice/free/turn`), then Groq Orpheus or Gemini TTS (`/voice/free/tts`). Keys stay server-side via `providerKey()`. **Free-tier limits shaped the design:** Groq allows 8,000 tokens/min and 1,000 requests/day *per model*, so the brain uses its own compact brief and a 12-tool subset (~1,450 tokens, against ~4,600 for the realtime brief), rotates `gpt-oss-120b`, then `gpt-oss-20b`, then `qwen3.8-27b`, then `gemini-3.5-flash-lite` with per-model 429 cooldowns, and budgets history in `prepareHistory`. Orpheus allows 100 requests/day, so replies are spoken as one request (`groupForSpeech`) and stock phrases are cached server-side. The tool dispatcher was lifted out of the OpenAI engine into `dispatchTool` so every engine runs identical tool code. |
| Jarvis controls the PC (`control_pc`, `open_url`) | `src/lib/jarvis-control.ts`, `voice-companion.tsx` | `open_url` opens a site in a new tab instantly (`safeUrl`: http(s) only, no credentials). New tool that hands a task to Hermes through `/__hermes_chat` with `yolo` (no TTY for approvals), reusing one Hermes session per conversation. **Outbound or destructive tasks (send, message, book, pay, delete, deploy, push...) are held by `gateControlTask` until the user's last utterance is a clear yes**, and a confirmed call runs the task that was read back, never new model text. This is enforced in code because a fallback model was observed setting `confirmed: true` on its own. Hermes runs on the session's abort signal, not the turn's, so talking over Jarvis does not kill a running task; a late result is fed back as context. |
| "Hey Jarvis" wake word | `src/lib/wake-word.ts`, `public/wakeword/*.onnx`, `vite.config.ts` (`jarvis-ort-runtime`: serves `/ort/` from `node_modules/onnxruntime-web/dist`, so the WASM never drifts from the JS or bloats git), `package.json` (`onnxruntime-web`), `scripts/fixtures/wake/*.wav` | On-device openWakeWord v0.5.1 port (Apache-2.0) on onnxruntime-web; no audio leaves the machine before wake. Off by default; toggle in Voice settings (`localStorage` `jarvis:wake`). Pauses during a conversation; a wake-started conversation ends after 45 s idle. Handles the autoplay policy by arming on the first click/keypress. Fixture test (synthetic TTS): positives 0.998, near-misses 0.0004 or less, threshold 0.5. |
| Personality | `scripts/free-voice.ts` | Dry-witted English butler. Humour is capped at one touch, never on deen, money, health, family or bad news, and never about religion. |
| Hermes page Voice button | `src/routes/agents.hermes.tsx` | Opened `IntelligencePortal`, whose voice depends on a speech sidecar at `localhost:8099` that is not in this repo and never runs. Now opens Jarvis. |
| Capability registry | `scripts/capability-registry.ts`, `scripts/operator-plugin.ts`, `scripts/free-voice.ts` | One live list of what Jarvis can do, rebuilt from probes 20 s after start-up and every 30 min: Hermes skills and toolsets, gateway platforms, Claude Code connectors with exact read/write tool names (from the stream-json init event), OS Google, OpenClaw, Obsidian vault, Claude bridge. Writes `.operator-data/capabilities.json`, serves `GET /__operator/capabilities`, generates the Hermes skill `jarvis-capabilities` (shared by voice via control_pc, chat and Telegram) and gives the voice brain one summary line. "working" only after an acceptance PASS. |
| Acceptance tests | `scripts/capability-acceptance.ts` (`bun run jarvis:acceptance [--ministry] [--only <group>]`) | Live end-to-end tests through the real chain with synthetic data, verified independently (process started, file with a random code, count equal to a direct query), cleaned up afterwards; results feed the registry. |
| Voice routing guard | `scripts/free-voice.ts` (`guardToolCall`) | Deterministic fixes for the fallback brains: Obsidian/clip/save requests go to control_pc not open_url; `confirmed` is dropped unless the user just said yes. |
| Claude bridge | `scripts/claude-bridge.ts` (`/__claude`) | Claude on the Claude subscription for Hermes (provider `claude-sub`) via the official Claude Code CLI; text only, no CLAUDE.md/memory, API-key env stripped, loopback only and refused to browser pages. |
| OpenClaw device relay | `scripts/capability-registry.ts` (`openclawNode`, `devices.openclaw-nodes`), `scripts/capability-acceptance.ts` (`openclaw nodes`), `scripts/windows/openclaw-relay.ps1`, `docs/OPENCLAW-DECISION.md` | OpenClaw kept only as a loopback relay for other devices (nodes); Hermes drives them with `openclaw nodes invoke` via its `openclaw-nodes` skill. Runs on Hermes' Node 22 because the system Node 23.5 lacks `StatementSync.columns()` (the old `doctor` crash). The probe treats a hand-started gateway as running (`Connectivity probe: ok`). Shell on a node is deliberately not reachable. |
| Act while I speak | `scripts/jev.ts` (`speculativeToolCall`), `scripts/free-voice.ts` (`/voice/free/reflex`), `src/lib/free-voice-client.ts` (`reflex` option, `partialStillHolds`), `voice-companion.tsx` (toggle `jarvis:early2`) | Browser interim transcripts, stable for 200 ms, ask Jev early; only navigate/open_url at ≥0.9 run before he finishes, once per utterance, and the final turn records it so nothing runs twice. On by default since 23 Sep at the owner's request (browser speech service); switching it off sticks per browser. See `docs/FILM-JARVIS.md`. |
| Proactive jobs in the registry | `scripts/capability-registry.ts` (`parseCronList`, `proactive.*`, `voice.telegram-notes`, `voice.early`), `scripts/capability-acceptance.ts` (`proactive`, `voice notes`, `voice early`) | The Hermes cron morning brief and watchdog, Telegram voice notes and early voice are live capabilities with acceptance tests. The jobs and script live in Hermes (`%LOCALAPPDATA%\hermes\cron`, `scripts\jarvis-watchdog.py`). |
| Autostart + supervisor | `scripts/windows/agentic-os-supervisor.ps1`, `install-autostart.ps1` | Startup item runs a hidden single-instance supervisor: starts the OS at login, restarts it within ~1 min if it stops (crash test: back in 49-58 s), and restarts the Hermes gateway if it dies (crash test: back unaided). `BROWSER=none` stops a tab opening on each restart. Remove with `install-autostart.ps1 -Remove`. |
| Motion Library on Windows | `src/motion/**`, `src/components/motion/**`, `vite.config.ts` (`motionStudioPlugin`), sidebar Tools, voice nav | Jack's 25 Sep `/motion` (vendor copy in commit 2019cd4). Windows changes: projects on `D:\motion-studio-projects`; "Run in Claude Code/Codex" opens Windows Terminal (or PowerShell) with a short fixed command that reads `PROMPT.md` (no `$(cat)`, no 32k argv risk) and a `motion-settings.json` beside it; Auto-enhance runs the pinned real `claude.exe` with the system prompt in a file, API-billing env stripped, **only on a click**, one at a time, same brief answered from a 30-min cache; brand-from-link uses the free reader (`scripts/site-draft/brand.ts`, robots.txt, public addresses only, DNS and redirects re-checked) instead of Firecrawl; Explorer/ffmpeg (winget) wording. |

## Running and testing

Must run under **Bun, not Node**, or SQLite FTS5 crashes:

```
bun --bun run start      # serves on http://localhost:8081
bun --bun test           # keep green: 953 pass, 1 skip, 0 fail (789 at baseline)
```

Editing `scripts/*.ts` or `vite.config.ts` needs a real restart (they load at config
time). If a `vite.config.ts` edit seems not to apply, delete `node_modules\.vite-temp`.

## Upgrading

1. Commit or stash all local work first.
2. Run the manifest comparison above against the **current** tree and save the list.
3. Unpack the new vendor release into a branch, commit it alone, then merge. Git resolves
   what it can and reports real conflicts; previously this was archaeology across `.bak`
   files.
4. Re-run `bun --bun test` and re-check the manifest against the new release's manifest.

## A note on the `.bak` files

14 `.bak-*` files (`vite.config.ts.bak-preargv`, `.bak-preregex`, `.bak-audit`, etc.) are
committed in the baseline because they were the only record of prior state. Now that
history exists they are redundant and can be deleted in a follow-up commit.
