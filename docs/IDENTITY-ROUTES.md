# Identity: every /__* route, classified

Stage B1 (REVIEW-B1 B1-1/B1-2, R2). The source of truth is `scripts/identity/routes.ts`. The identity gate
(`scripts/identity/gate.ts`) enforces it before any route runs, and `scripts/identity/routes.test.ts` fails
when a mounted route is missing from the code table or from this page.

The settled principle (V7): both founders get FULL shared business access. Anything that controls the hub
device (spawns processes, agents or shells, approves tool use, reads or writes the hub's configuration and
keys, or reads the owner's private hub data) belongs to the hub's owner, at the PC. A remote founder's
device commands go to his OWN device (the companion, Stage H), never to the hub.

- **shared**: any verified founder (the owner at this PC, or a founder signed in through Tailscale).
- **local-owner**: only the owner at this PC (loopback socket, local Host, no relay header).
- **self**: the route proves its callers itself (pairing and companion bearers; the Hermes gateway bearer).
- **Deny by default**: an unlisted path is local-owner. "read" is GET/HEAD; "write" is every other method.
- Every /__* request is refused when it comes from another origin (an Origin mismatch, or Sec-Fetch-Site
  cross-site or same-site, which covers other localhost ports). Vite's CORS is off.
- `/__token` is served by the gate: the internal token only to the owner at this PC, a person-bound token to
  a remote founder, a pairing-only token to a login that has to pair. A remote token is never swapped for the
  internal one; shared routes check the caller's own token.
- Inside `/__operator` (shared), device actions (screen, browser, pc, cad, open-url, control approval, Hermes
  task, the hub's voice settings, away mode by voice, improve-os agent jobs) resolve through `resolveTarget`
  to the requester's own device. The hub is never another person's fallback.
- A request target that isn't canonical is refused with 400 before anything else: absolute-form
  (`GET http://host/...`), `.` or `..` segments, `//`, backslashes, and encoded `%2e`, `%2f`, `%5c`, `%25`, `%00`.
- `/__jobs` and `/__approvals` come from B2 (a regex-matched middleware the route scan also detects);
  shared at the gate, and B2's own principal rules decide each write.
- Non-/__ paths (the app, Vite's source and static serving) are served only to a verified founder. A verified
  Tailscale login with no principal (a revoked session, "require a code") gets a self-contained pairing page.

## Self-authenticated (2)

| Route | Class | Why |
|---|---|---|
| `/__away` | self | the Hermes gateway's relay bearer |
| `/__devices` | self | pairing, sessions, companion bearer tokens (own proofs) |

## Shared business (39)

| Route | Class | Why |
|---|---|---|
| `/__ai_usage` | shared (read) / local-owner (write) | AI usage reads; settings and rescans change the hub |
| `/__app_version` | shared (read) / local-owner (write) | build metadata |
| `/__approvals` | shared | the shared approvals; B2 decides card/decide/cancel per principal |
| `/__design_balance` | shared (read) / local-owner (write) | provider balances |
| `/__design_carousel` | shared (read) / local-owner (write) | Design decks; writes change hub files |
| `/__design_cost` | shared | a price estimate; runs nothing |
| `/__design_file` | shared (read) / local-owner (write) | Design studio assets |
| `/__design_higgsfield_account` | shared (read) / local-owner (write) | Design account status; disconnect wipes hub OAuth tokens |
| `/__design_higgsfield_requests` | shared (read) / local-owner (write) | generation requests |
| `/__design_index_status` | shared (read) / local-owner (write) | asset index status |
| `/__design_jobs` | shared (read) / local-owner (write) | running generations |
| `/__design_ledger` | shared (read) / local-owner (write) | Design studio assets |
| `/__design_makers` | shared (read) / local-owner (write) | which maker lanes are signed in |
| `/__design_media` | shared (read) / local-owner (write) | Design studio assets |
| `/__design_mode` | shared (read) / local-owner (write) | Design system; writes change hub files |
| `/__design_models` | shared (read) / local-owner (write) | engine model lists |
| `/__design_modes` | shared (read) / local-owner (write) | Design systems |
| `/__design_project` | shared (read) / local-owner (write) | Design projects; writes change hub files |
| `/__design_project_asset` | shared (read) / local-owner (write) | Design project assets |
| `/__design_project_file` | shared (read) / local-owner (write) | Design projects |
| `/__design_providers` | shared (read) / local-owner (write) | connected engines (key tails only) |
| `/__design_schema` | shared (read) / local-owner (write) | model controls |
| `/__design_search` | shared (read) / local-owner (write) | asset search |
| `/__design_skills` | shared (read) / local-owner (write) | Design skill names |
| `/__design_system` | shared (read) / local-owner (write) | Design systems; writes change hub files |
| `/__design_system_asset` | shared (read) / local-owner (write) | Design system assets |
| `/__design_system_file` | shared (read) / local-owner (write) | Design system assets |
| `/__finance_manual` | shared | business finance (NAB CSV) |
| `/__graphify_graph` | shared (read) / local-owner (write) | one project graph |
| `/__graphify_list` | shared (read) / local-owner (write) | project graphs index |
| `/__commands` | shared (read) / local-owner (write) | command palette: target preview (resolveTarget for the signed-in person) and own-device app/file names; GET only, own page token (Track 1) |
| `/__jobs` | shared | the shared job and step history; B2 decides cancel/release per principal |
| `/__live-data` | shared (read) / local-owner (write) | dashboard data (see REVIEW-B1 M-4 for what it contains) |
| `/__memory` | shared | the shared memory pool |
| `/__openrouter_credits` | shared (read) / local-owner (write) | AI spend reporting |
| `/__openrouter_key` | shared (read) / local-owner (write) | AI key cap and usage (never the key) |
| `/__operator` | shared | the OS's business API; device actions inside it resolve through resolveTarget |
| `/__receptionist` | shared | receptionist status, dashboard, sign-offs |
| `/__version` | shared (read) / local-owner (write) | build metadata |
| `/__workspace` | shared | the Workspace page (read-only) |

## Hub owner, at the PC (73)

| Route | Class | Why |
|---|---|---|
| `/__ccr_pin_routes` | local-owner | writes claude-code-router config, restarts it |
| `/__chat_title` | local-owner | spawns claude -p |
| `/__claude` | local-owner | Claude subscription bridge for Hermes |
| `/__claude_abort` | local-owner | stops hub processes |
| `/__claude_abort_all` | local-owner | stops hub processes |
| `/__claude_attach` | local-owner | streams a hub Claude turn |
| `/__claude_chat` | local-owner | runs Claude Code on the hub (skip-permissions, the owner's subscription) |
| `/__claude_chats` | local-owner | the owner's Claude sessions |
| `/__claude_commands` | local-owner | the owner's Claude slash commands |
| `/__claude_file` | local-owner | files from the owner's Claude sessions |
| `/__claude_models` | local-owner | hub Claude Code models |
| `/__claude_session` | local-owner | the owner's Claude transcripts |
| `/__cline` | local-owner | Cline bridge for Hermes |
| `/__design_author` | local-owner | runs codex on the hub |
| `/__design_cancel` | local-owner | stops hub processes |
| `/__design_export` | local-owner | writes hub project folders |
| `/__design_generate` | local-owner | spends provider credit; may spawn CLIs |
| `/__design_index_start` | local-owner | spawns the indexer |
| `/__design_index_stop` | local-owner | stops the indexer |
| `/__design_publish` | local-owner | publishes from the hub |
| `/__design_reference` | local-owner | writes hub files |
| `/__design_remove_key` | local-owner | changes provider keys |
| `/__design_set_key` | local-owner | changes provider keys |
| `/__design_trash` | local-owner | deletes hub files |
| `/__dev_restart` | local-owner | hub dev-server status |
| `/__dream_action` | local-owner | hub Dream state |
| `/__dream_engines` | local-owner | hub Dream engines |
| `/__fish_tts` | local-owner | Hermes voice with the hub's key |
| `/__graphify_ingest` | local-owner | graphs any hub path, git clone of any URL |
| `/__graphify_remove` | local-owner | deletes hub graph files |
| `/__hermes_chat` | local-owner | runs Hermes on the hub |
| `/__hermes_cmd` | local-owner | runs hermes commands (incl. update --yes) |
| `/__hermes_connections` | local-owner | hub Hermes connections |
| `/__hermes_documents` | local-owner | hub documents (restore, permanent trash) |
| `/__hermes_effort` | local-owner | writes ~/.hermes/config.yaml |
| `/__hermes_image_upload` | local-owner | writes files for hub Hermes |
| `/__hermes_memory` | local-owner | the owner's Hermes SOUL, MEMORY and USER |
| `/__hermes_owner_profile` | local-owner | the owner's profile in Hermes' USER.md; POST rewrites it |
| `/__hermes_skill_sync` | local-owner | copies the owner's Claude Code skills into Hermes |
| `/__hermes_missions` | local-owner | hub Hermes missions |
| `/__hermes_missions/clear` | local-owner | hub Hermes missions |
| `/__hermes_missions/create` | local-owner | hub Hermes missions |
| `/__hermes_missions/optimize` | local-owner | runs a model turn on the hub |
| `/__hermes_missions/tick` | local-owner | hub Hermes missions |
| `/__hermes_moa_save` | local-owner | writes ~/.hermes/config.yaml |
| `/__hermes_models` | local-owner | hub Hermes config |
| `/__hermes_pantheon` | local-owner | hub persona YAML |
| `/__hermes_pantheon_sync` | local-owner | hub persona mirror |
| `/__hermes_pantheon_templates` | local-owner | hub persona templates |
| `/__hermes_pantheon/create` | local-owner | writes hub persona YAML |
| `/__hermes_pantheon/install` | local-owner | writes hub persona YAML |
| `/__hermes_pantheon/validate` | local-owner | hub persona YAML |
| `/__hermes_profiles` | local-owner | spawns hermes profile list |
| `/__hermes_session` | local-owner | the owner's Hermes sessions |
| `/__hermes_sessions` | local-owner | the owner's Hermes sessions |
| `/__hermes_skills` | local-owner | hub Hermes skills |
| `/__hermes_status` | local-owner | hub Hermes install state |
| `/__jev` | local-owner | Jev approval guardian for Hermes |
| `/__just-installed` | local-owner | deletes a hub marker file on GET |
| `/__lead-sites` | local-owner | generates and deploys previews from the hub |
| `/__mcp_approvals` | local-owner | approves tool use in hub sessions |
| `/__memory_note` | local-owner | reads every Obsidian vault on the hub, incl. the personal vault |
| `/__motion` | local-owner | launches Claude Code / Codex, uploads, exports on the hub |
| `/__operator/coding` | shared | coding jobs: plan, progress, changes, tests, review; apply steps go through B2 (Track 3) |
| `/__operator/agent-jobs` | local-owner | delegated Claude/Codex agents on the hub's own logins (C1) |
| `/__operator/model-router` | shared (read) / local-owner (write) | System > Models: catalogue, health and receipt totals (metadata only) |
| `/__operator/model-router/probe` | local-owner | zero-cost provider list reads with the hub's own keys |
| `/__permission_decision` | local-owner | approves tool use in hub sessions |
| `/__question_answer` | local-owner | answers hub agent questions |
| `/__refresh_data` | local-owner | machine scan of the hub |
| `/__seo-audit-files` | local-owner | hub files |
| `/__sessions_live` | local-owner | hub chat processes |
| `/__set_dream_engine` | local-owner | hub Dream config |
| `/__site-draft` | local-owner | hub site drafts |
| `/__start_voice` | local-owner | writes OPENAI_API_KEY into ~/.hermes/.env, respawns voice-lab |
| `/__trigger_dream` | local-owner | runs hermes --yolo on the hub |
| `/__website-os/connect` | local-owner | hub preview inspection |
| `/__websites` | local-owner | hub website checkouts and deploys |

## S1 security hotfix (AUDIT-A1, 28 Sep)

- **Hub guards mean "at the hub".** Inside a handler, `isAtHub(req)` (`requestAtHub` in `scripts/identity/gate.ts`; the old name `isLoopback` is kept as an alias) is true only for the owner at this PC (loopback socket, local Host, no relay header). A founder signed in over Tailscale never passes it. A READ_SHARED route's handler uses `founderMayRead(req)`: any verified founder may read, only the hub writes. The table above stays the outer layer.
- **A page navigation is not proof of a person.** Once this PC has trusted a hub session, a new one minted by a navigation is *pending*: the owner at this PC, but a process caller (no session key, no approval card) until it is confirmed. Pending sessions are capped apart (4) and never evict a confirmed one (8). A confirmed session that opens a page in its last 10 days is renewed. The first hub session on a fresh install is trusted on first use.
- **Confirming a new browser (REVIEW-S1 F2b).** The code travels towards the new browser, never out of it. Usman makes a one-time code (10 minutes, one use) in System > Devices and people on a browser he already uses or his own paired phone (`POST /__devices/sessions/confirm-code`, a human session only), or runs `bun scripts/identity/confirm-browser.ts` himself in PowerShell or Windows Terminal (it refuses without an interactive terminal on stdin and stdout and waits for Enter). He types the code into the new browser's Profile, which confirms itself (`POST /__devices/sessions/confirm`, only from that pending hub session). `/__devices/me` never returns a code, so a program that forged a navigation has nothing to redeem. Wrong codes share the pairing-code lockout (5 per 10 minutes).
- **Tailscale sign-in needs the real Serve (REVIEW-S1 F2a).** The `Tailscale-User-Login` header and this PC's tailnet Host are believed only when the socket's peer is Tailscale's daemon: Windows says the client end of the connection is owned by `tailscaled.exe` in session 0 (`scripts/identity/serve-peer.ts`, iphlpapi + wtsapi32 through `bun:ffi`, one check per connection). A local program sending the same headers is neither a tailnet login nor at the hub. A refused Serve-looking request logs `[identity] Tailscale sign-in headers ignored: ...` once per connection.
- **Device and session administration needs a person (REVIEW-S1 F1).** `/__devices` `pair/code`, `sessions/revoke`, `devices/revoke`, `policy/self-pair`, `policy/finance` and `sessions/confirm-code` refuse any caller that isn't a human session (a confirmed browser or a paired device). A local program can still list sessions, but it can't revoke the owner's.
- **A1-3 status: closed for programs that only use the OS's HTTP API; partial beyond that.** Both review paths (R3b forged Serve headers, R3c self-read confirm code) are closed. Still open by design, the documented limit in `scripts/identity/principal.ts`: a program running as the owner with his file access can write `.operator-data/devices.json` directly (for example a hub confirm code), drive the command through a pseudo-console, or drive his real browser. Consequential approvals needing a spoken yes or a Telegram code instead of a card click (the audit's interim rule) are on the backlog.
- **Session keys stay server-side.** `/__approvals`, `/__jobs` and their events never carry `sessionId` (`sk1.`), including rows stored before the fix.
- **Rejecting or cancelling** someone's pending approval needs a person (a human session, the owner's Telegram DM), or the same principal that asked for it.
- **`/__operator` hub connectors** (memory app syncs and settings, local and Notion imports, Notion/Granola keys, native mail and calendar syncs, mail-archive sync and provider search, the privacy pane) run only for the owner at this PC. So do connecting, configuring and disconnecting the hub's Google, Outlook, Cal.com, Slack and Skool sign-ins (`/connections/start`, `/configure`, `/disconnect`, `/connections/skool/connect`; REVIEW-S1 F4), which change the hub's own credentials. Syncing a connected account (`/connections/sync`, `/connections/skool/sync`) and uploaded exports (`/memory/apps/<app>/import`) stay shared.
