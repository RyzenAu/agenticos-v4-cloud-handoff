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
- **Server role** (`MU_HUB_ROLE=server`, a headless hub nobody sits at): the third column below says what changes;
  see "Server role" further down. In `pc` and `cloud` that column is inert.
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

| Route | Class | Server role | Why |
|---|---|---|---|
| `/__away` | self | same | the Hermes gateway's relay bearer |
| `/__devices` | self | same | pairing, sessions, companion bearer tokens (own proofs) |

## Shared business (42)

| Route | Class | Server role | Why |
|---|---|---|---|
| `/__ai_usage` | shared (read) / local-owner (write) | shared (read) / founders (write) | AI usage reads; settings and rescans change the hub |
| `/__app_version` | shared (read) / local-owner (write) | shared (read) / founders (write) | build metadata |
| `/__agents` | shared (read) / local-owner (write) | shared (read) / founders (write) | the Agents workspace: bots with live readiness, their tasks, files and conversations; PATCH sets up what a bot does (server work: a confirmed human founder session, or the owner at the hub); conversations (a bot's thread, and the conversationId on a bot) are for actor human or the owner at the hub: a bare tailnet login gets 403 on the thread and a bot without a conversationId; an unknown path under the mount is a 404 |
| `/__crm` | shared (read) / local-owner (write) | shared (read) / founders (write) | the CRM (`scripts/crm/plugin.ts`): records, deals, follow-ups, tasks, projects and typed `crm.*` operations. Reads are for a verified founder; a write is the hub owner's (the owner at this PC, or in the server role a founder with a confirmed human session) plus the caller's own page token and a hub that is not read-only. A bare tailnet login, a routine principal and a gateway principal are refused for writes. Until the owner-run `scripts/crm/migrate.ts --apply --backup` has run, the mount answers `needs-upgrade` and opens nothing |
| `/__approvals` | shared | same | the shared approvals; B2 decides card/decide/cancel per principal |
| `/__design_balance` | shared (read) / local-owner (write) | shared (read) / founders (write) | provider balances |
| `/__design_carousel` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design decks; writes change hub files |
| `/__design_cost` | shared | same | a price estimate; runs nothing |
| `/__design_file` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design studio assets |
| `/__design_higgsfield_account` | shared (read) / local-owner (write) | shared (read) / console only (write) | Design account status; disconnect wipes hub OAuth tokens |
| `/__design_higgsfield_requests` | shared (read) / local-owner (write) | shared (read) / founders (write) | generation requests |
| `/__design_index_status` | shared (read) / local-owner (write) | shared (read) / founders (write) | asset index status |
| `/__design_jobs` | shared (read) / local-owner (write) | shared (read) / founders (write) | running generations |
| `/__design_ledger` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design studio assets |
| `/__design_makers` | shared (read) / local-owner (write) | shared (read) / founders (write) | which maker lanes are signed in |
| `/__design_media` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design studio assets |
| `/__design_mode` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design system; writes change hub files |
| `/__design_models` | shared (read) / local-owner (write) | shared (read) / founders (write) | engine model lists |
| `/__design_modes` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design systems |
| `/__design_project` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design projects; writes change hub files |
| `/__design_project_asset` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design project assets |
| `/__design_project_file` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design projects |
| `/__design_providers` | shared (read) / local-owner (write) | shared (read) / founders (write) | connected engines (key tails only) |
| `/__design_schema` | shared (read) / local-owner (write) | shared (read) / founders (write) | model controls |
| `/__design_search` | shared (read) / local-owner (write) | shared (read) / founders (write) | asset search |
| `/__design_skills` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design skill names |
| `/__design_system` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design systems; writes change hub files |
| `/__design_system_asset` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design system assets |
| `/__design_system_file` | shared (read) / local-owner (write) | shared (read) / founders (write) | Design system assets |
| `/__events` | shared (read) / local-owner (write) | shared (read) / founders (write) | the live activity stream (SSE, GET only): job, approval, computer, lease, device and Jarvis notifications, scoped per person (a job or approval reaches the person it belongs to, a personal device's events only its owner; coding, memory and trigger jobs, merge/deploy/provider/trigger approvals and shared computers reach both founders; a job or approval with no known device is its requester's, never shared); notifications never run anything |
| `/__finance_manual` | shared | same | business finance (NAB CSV) |
| `/__graphify_graph` | shared (read) / local-owner (write) | shared (read) / founders (write) | one project graph |
| `/__graphify_list` | shared (read) / local-owner (write) | shared (read) / founders (write) | project graphs index |
| `/__commands` | shared (read) / local-owner (write) | shared (read) / founders (write) | command palette: target preview (resolveTarget for the signed-in person) and own-device app/file names; GET only, own page token (Track 1) |
| `/__computers` | shared | same | shared agent cloud computers: list, provision, run agent jobs, take over through a control lease; viewer only behind this auth |
| `/__jobs` | shared | same | the shared job and step history; B2 decides cancel/release per principal |
| `/__live-data` | shared (read) / local-owner (write) | shared (read) / founders (write) | dashboard data (see REVIEW-B1 M-4 for what it contains) |
| `/__memory` | shared | same | the shared memory pool |
| `/__openrouter_credits` | shared (read) / local-owner (write) | shared (read) / founders (write) | AI spend reporting |
| `/__openrouter_key` | shared (read) / local-owner (write) | shared (read) / founders (write) | AI key cap and usage (never the key) |
| `/__operator` | shared | same | the OS's business API; device actions inside it resolve through resolveTarget |
| `/__receptionist` | shared | same | receptionist status, dashboard, sign-offs |
| `/__version` | shared (read) / local-owner (write) | shared (read) / founders (write) | build metadata |
| `/__health` | shared (read) / local-owner (write) | shared (read) / founders (write) | hub health: component status and recovery hints, no secrets |
| `/__workspace` | shared | same | the Workspace page (read-only) |

## Hub owner, at the PC (73)

| Route | Class | Server role | Why |
|---|---|---|---|
| `/__ccr_pin_routes` | local-owner | console only | writes claude-code-router config, restarts it |
| `/__chat_title` | local-owner | founders | spawns claude -p |
| `/__claude` | local-owner | console only | Claude subscription bridge for Hermes |
| `/__claude_abort` | local-owner | founders | stops hub processes |
| `/__claude_abort_all` | local-owner | founders | stops hub processes |
| `/__claude_attach` | local-owner | founders | streams a hub Claude turn |
| `/__claude_chat` | local-owner | founders | runs Claude Code on the hub (skip-permissions, the owner's subscription) |
| `/__claude_chats` | local-owner | founders | the owner's Claude sessions |
| `/__claude_commands` | local-owner | founders | the owner's Claude slash commands |
| `/__claude_file` | local-owner | founders | files from the owner's Claude sessions |
| `/__claude_models` | local-owner | founders | hub Claude Code models |
| `/__claude_session` | local-owner | founders | the owner's Claude transcripts |
| `/__cline` | local-owner | console only | Cline bridge for Hermes |
| `/__design_author` | local-owner | founders | runs codex on the hub |
| `/__design_cancel` | local-owner | founders | stops hub processes |
| `/__design_export` | local-owner | founders | writes hub project folders |
| `/__design_generate` | local-owner | founders | spends provider credit; may spawn CLIs |
| `/__design_index_start` | local-owner | founders | spawns the indexer |
| `/__design_index_stop` | local-owner | founders | stops the indexer |
| `/__design_publish` | local-owner | founders | posts a carousel to social platforms (Blotato); in the server role every caller gets a 202 approval first (`content.publish`), then a single-use run bound to the caption, slide hashes and target accounts |
| `/__design_reference` | local-owner | founders | writes hub files |
| `/__design_remove_key` | local-owner | console only | changes provider keys |
| `/__design_set_key` | local-owner | console only | changes provider keys |
| `/__design_trash` | local-owner | founders | deletes hub files |
| `/__dev_restart` | local-owner | console only | hub dev-server status |
| `/__dream_action` | local-owner | founders | hub Dream state |
| `/__dream_engines` | local-owner | founders | hub Dream engines |
| `/__fish_tts` | local-owner | 501 for every caller | Hermes voice with the hub's key |
| `/__graphify_ingest` | local-owner | founders | graphs any hub path, git clone of any URL |
| `/__graphify_remove` | local-owner | founders | deletes hub graph files |
| `/__hermes_chat` | local-owner | founders | runs Hermes on the hub |
| `/__hermes_cmd` | local-owner | console only | runs hermes commands (incl. update --yes) |
| `/__hermes_connections` | local-owner | founders | hub Hermes connections |
| `/__hermes_documents` | local-owner | founders | hub documents (restore, permanent trash) |
| `/__hermes_effort` | local-owner | console only | writes ~/.hermes/config.yaml |
| `/__hermes_image_upload` | local-owner | founders | writes files for hub Hermes |
| `/__hermes_memory` | local-owner | founders | the owner's Hermes SOUL, MEMORY and USER |
| `/__hermes_owner_profile` | local-owner | founders | the owner's profile in Hermes' USER.md; POST rewrites it |
| `/__hermes_skill_sync` | local-owner | console only | copies the owner's Claude Code skills into Hermes |
| `/__hermes_missions` | local-owner | founders | hub Hermes missions |
| `/__hermes_missions/clear` | local-owner | founders | hub Hermes missions |
| `/__hermes_missions/create` | local-owner | founders | hub Hermes missions |
| `/__hermes_missions/optimize` | local-owner | founders | runs a model turn on the hub |
| `/__hermes_missions/tick` | local-owner | founders | hub Hermes missions |
| `/__hermes_moa_save` | local-owner | console only | writes ~/.hermes/config.yaml |
| `/__hermes_models` | local-owner | founders | hub Hermes config |
| `/__hermes_pantheon` | local-owner | founders (read) / console only (write) | hub persona YAML |
| `/__hermes_pantheon_sync` | local-owner | founders (read) / console only (write) | hub persona mirror |
| `/__hermes_pantheon_templates` | local-owner | founders (read) / console only (write) | hub persona templates |
| `/__hermes_pantheon/create` | local-owner | console only | writes hub persona YAML |
| `/__hermes_pantheon/install` | local-owner | console only | writes hub persona YAML |
| `/__hermes_pantheon/validate` | local-owner | founders (read) / console only (write) | hub persona YAML |
| `/__hermes_profiles` | local-owner | founders | spawns hermes profile list |
| `/__hermes_session` | local-owner | founders | the owner's Hermes sessions |
| `/__hermes_sessions` | local-owner | founders | the owner's Hermes sessions |
| `/__hermes_skills` | local-owner | founders | hub Hermes skills |
| `/__hermes_status` | local-owner | founders | hub Hermes install state |
| `/__jev` | local-owner | console only | Jev approval guardian for Hermes |
| `/__just-installed` | local-owner | founders | deletes a hub marker file on GET |
| `/__lead-sites` | local-owner | founders | generates and deploys previews from the hub |
| `/__mcp_approvals` | local-owner | founders | approves tool use in hub sessions |
| `/__memory_note` | local-owner | founders | reads every Obsidian vault on the hub, incl. the personal vault |
| `/__motion` | local-owner | founders | launches Claude Code / Codex, uploads, exports on the hub |
| `/__operator/coding` | shared | same | coding jobs: plan, progress, changes, tests, review; apply steps go through B2 (Track 3) |
| `/__operator/agent-jobs` | local-owner | founders | delegated Claude/Codex agents on the hub's own logins (C1) |
| `/__operator/model-router` | shared (read) / local-owner (write) | shared (read) / founders (write) | System > Models: catalogue, health and receipt totals (metadata only) |
| `/__operator/model-router/probe` | local-owner | founders | zero-cost provider list reads with the hub's own keys |
| `/__permission_decision` | local-owner | founders | approves tool use in hub sessions |
| `/__question_answer` | local-owner | founders | answers hub agent questions |
| `/__refresh_data` | local-owner | founders | machine scan of the hub |
| `/__seo-audit-files` | local-owner | founders | hub files |
| `/__sessions_live` | local-owner | founders | hub chat processes |
| `/__set_dream_engine` | local-owner | console only | hub Dream config |
| `/__site-draft` | local-owner | founders | hub site drafts |
| `/__start_voice` | local-owner | 501 for every caller | writes OPENAI_API_KEY into ~/.hermes/.env, respawns voice-lab |
| `/__trigger_dream` | local-owner | founders | runs hermes --yolo on the hub |
| `/__website-os/connect` | local-owner | founders | hub preview inspection |
| `/__websites` | local-owner | founders | hub website checkouts and deploys |

## Server role (`MU_HUB_ROLE=server`, the headless Ryzen-PC hub)

Source: `scripts/identity/server-role.ts` (decision), `scripts/cloud/hub-role.ts` (501 groups), `scripts/identity/gate.ts`
(enforcement). With the role unset, `pc` or `cloud` nothing in this section applies and every decision is exactly as
above; `scripts/identity/server-role.test.ts` proves it route by route against a table generated before the role existed.

The **Server role** column shows what changes. `same` means the class above decides. In the server role:

- **founders**: a local-owner route is open to a founder who (a) arrived through Tailscale Serve exactly as
  `remote-access.ts` / `serve-peer.ts` verify today and (b) holds a **confirmed human session** (a live, signed,
  non-pending `mu_session` cookie for that same person: principal `paired-session`, actor `human`). A bare Tailscale
  login (`tailnet-person`, a process) is refused with "pair this browser first", reads included. The owner at the hub
  (loopback) keeps every route, as in every role.
- **Bootstrap, and why a self-paired browser is not enough.** `POST /__devices/pair/tailnet` is callable by a script on a
  founder's machine, so in the server role the session it mints is **pending**: shared access as before, but it does not
  open local-owner routes. It becomes confirmed in one of two ways: (a) a confirmed session of the SAME person approves it ("manage only your own
  devices": Mehroz cannot approve Usman's browser, 403; `POST /__devices/sessions/approve {sessionId}`; the pending session is
  listed in `GET /__devices/sessions` with `pending`, `createdAt` and `source`, the tailnet address and node it paired from,
  besides the label the browser chose for itself), or (b) a one-time code made at the server console. **First browser per founder:** the lead runs
  `bun scripts/identity/pair-code.ts --for usman` (or `mehroz`) on the server (over ssh); it prints a single-use code
  (about 10 minutes); the founder types it into the pairing page ("a one-time code"), and that browser gets a confirmed
  session. The CLI needs the local-owner token (it reads the token file), so only the hub's account can run it. At most
  five unconfirmed browsers are kept per person.
- **Duplicate cookies.** A page on another port of the same host can set its own `mu_session`, and the browser may send it
  first. Only well-formed values count (43 characters, a dot, 43 characters; junk is skipped, not counted). The hub tries them in order, stops at the first that verifies for that person, and looks at no more than 32 well-formed candidates.
- **console only**: stays loopback-only (the server's own console) even in the server role.
- **501 for every caller**: the hub is not a personal device. `windows-control`, `agent-browser` and `local-voice-stack`
  answer 501 "needs the companion" to everyone, a loopback caller included, as the cloud role does; `local-cli-agents`
  (Claude, Codex, Hermes, Cline bridges, agent jobs) stay available. The hub is not in the device registry, so a
  founder's "here" resolves to his own companion, or fails honestly as offline: never the hub, never the other founder's PC.
- Companion and device bearer tokens, computers-bridge clients (`x-mu-bridge`) and the Hermes relay bearer never gain
  local-owner access in any role: they are not browser principals and the gate refuses them first.
- An admitted founder's own page token is handed to the route's legacy write check as the internal one; any other
  value is left as sent. The inline hub-only guards (`requestAtHub`, `refuseUnlessAtThisPc`, Motion's
  `isLocalRequest`) honour the gate's admission for that one request.

### The three categories (scripts/identity/server-role.ts `SERVER_ROLE_CATEGORIES`)

1. **Personal desktop control** (windows-control, agent-browser, local-voice-stack): 501 "needs the companion" for every
   caller; a founder's "here" goes to his own companion or fails honestly. Never executed on the hub or on the other
   founder's device.
2. **Server-side work** (the hub's shared CLIs, bridges and tools): a founder with a confirmed human session, except the
   console-only set (keys, tool configuration, software, restarts) and every unclassified route.
3. **Publishing and other outward actions**: a confirmed founder session **and a B2 approval**. Wired today:
   `/__lead-sites/deploy` (B2 action `content.publish`) and `/__lead-sites/takedown` (`content.unpublish`, one registry
   line next to `content.publish` in `scripts/approvals/policy.ts`). Anything outward with no approval wired yet is
   console-only until it has one (today: nothing; `/__design_publish`, social posting, is wired the same way, `scripts/design-publish.ts`, action `content.publish`, bound to the caption, a hash of every slide and the Blotato account per platform). The `/__websites` routes are read-only
   (overview and thumbnails): nothing there deploys.

**How a remote preview deploy or take-down runs** (`scripts/lead-sites/publish-approval.ts`, the same ask / decide / run
pattern B2 already uses to release a quarantined job):

1. *Ask*: `POST /__lead-sites/deploy {lead, confirm: "<domain>"}` (or `/takedown {lead}`) creates an approval and answers 202
   with its summary (what, which business, which URL). Nothing is published. One live record per exact request.
2. *Decide*, per B2's existing rules (`ApprovalService.decide`, `policy.allowedEvidence`): a founder's own request is
   confirmed on the approval card in a verified session (his own, or the other founder's); a program's request (the owner's
   console, a script, Hermes) needs the owner's spoken yes or the one-time code sent to the requester's own Telegram DM (the
   code is never in the response).
3. *Run*: `POST /__lead-sites/deploy {lead, approvalId}` by the person who asked. The approval is consumed atomically and once,
   bound to a digest of the WHOLE preview folder (every file: relative path, size and sha256, dotfiles included; any change voids the approval) and to the asking browser SESSION (a hash of the confirmed session's server-only key), so neither another session of the same person nor a program holding the owner token can complete a deploy a browser asked for (a program's request is bound to "process"), then the deploy runs and the
   outcome (succeeded / failed) is written on the approval. A second call or a restart never replays it; a crash between
   consume and outcome is recorded as `unknown`. In the server role this holds for EVERY caller, the owner at the console
   included; pc and cloud still deploy from the owner's own click.

<!-- operator-sites:start -->
### The "only at this PC" sites inside `/__operator` (server role)

`/__operator` is shared, and `scripts/operator-plugin.ts` computes `remote` (the caller is not the owner at the hub). It used
that for two things: **device routing** (a remote founder's device actions go to his own device) and "only at this PC"
**permission refusals for server-side work**, which nobody can satisfy on a headless server. In the server role every site is
classified once, in `scripts/identity/operator-sites.ts` (`OPERATOR_SITES`), into exactly one class. ONE helper,
`serverWorkAllowed(principal, role)`, says whether a caller may do server-side work: the server role and a confirmed human
founder session (the proof the gate uses for local-owner routes). A pending session, a bare Tailscale login or a program is
refused with "That runs on the server and needs a confirmed browser session". `by` is always the verified signer. pc and cloud
never consult the table: `remote` behaves exactly as before (tested for every site and principal kind).

| Site | What | Where | Class | pc and cloud (before) | Server role (after) |
|---|---|---|---|---|---|
| `connector-credentials` | connect, configure or disconnect the hub's Google/Outlook/Cal.com/Slack/Skool sign-ins; Notion and Granola config | operator-plugin HUB_CONNECTOR_WRITE | 4 console | refused to a remote caller ("only at this PC") | console only (the hub's own credentials) |
| `skill-approve` | approve a skill draft (installs a SKILL.md into the hub's Claude and Hermes skills folders) | meeting-mode/narrate-api skillDraftsRoute | 4 console | refused to a remote caller ("only at this PC") | console only (installed software) |
| `connector-syncs` | forced connector syncs, imports, the model-catalogue check, setup connection checks, mail-archive sync | operator-plugin HUB_CONNECTOR_WRITE | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `apps-refresh` | rescan the hub's connected apps (?refresh=1) | operator-plugin /memory/apps | 2 server-side work | the refresh flag is ignored for a remote caller | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `skill-drafts` | list, read, edit, discard and delete skill drafts (they can hold what a founder said) | meeting-mode/narrate-api skillDraftsRoute | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `agent-jobs` | delegated Claude/Codex agent jobs on the server's own logins (the local-cli-agents group) | agent-jobs-route | 2 server-side work | refused on every path to any remote or relayed caller | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line (B2: none: a job only ever drafts; coding applies already go through B2 (scripts/coding)) |
| `model-router` | System > Models catalogue, health and the zero-cost provider probe (outbound list reads with the hub's keys) | model-router/api | 2 server-side work | the probe is refused to a remote caller | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `model-fleet-receipts` | read the Cline/fleet model usage receipts | model-fleet/receipt-sink | 2 server-side work | refused to a remote caller | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `jarvis-settings` | who can reach Jarvis, his shorthand and greeting | operator-plugin /jarvis/settings | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `jarvis-alerts` | Jarvis alerts, quiet mode, protocols | operator-plugin /jarvis/* | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `inbox-triage` | the inbox triage overview, digest, alerts and settings | inbox-triage/service | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `leads-find` | Find leads (OpenStreetMap, or Google Places within the fixed monthly allowance of detail lookups) | leads/api find() | 2 server-side work | LocalOnly when remote (spends paid lookups and shares the OSM slot) | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line; the fixed Google Places monthly allowance (MONTHLY_DETAILS_BUDGET) and rate limits still apply; by = the signer (B2: none: B2 has no kind for lookups; Google spend stays bounded by the fixed Places allowance) |
| `leads-seo-audit` | SEO audit of a lead's site | leads/api seoAudit() | 2 server-side work | LocalOnly when remote | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line; by = the signer |
| `triggers` | pause, resume, disable and retry automation triggers | triggers/service handle() | 2 server-side work | refused to a remote caller | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `automations` | run now, pause and resume Hermes cron automations | operator-plugin /automations/* | 2 server-side work | refused to a remote caller ("only at this PC") | confirmed human founder session; otherwise a clear "needs a confirmed browser session" line |
| `connector-os-apps` | the OS privacy pane, native calendar and connection syncs | operator-plugin HUB_CONNECTOR_WRITE | 1 device | refused to a remote caller ("only at this PC") | unchanged: the requester's own companion, or an honest refusal |
| `open-url-browser-screen` | open a link, drive Chrome or the screen, approve a control task | operator-plugin /open-url, /browser/act, /screen/act, /control/approval, /hermes/task | 1 device | deviceDenied: the requester's own device, or refused | unchanged: the requester's own companion, or an honest refusal (also 501 on the server: scripts/cloud/hub-role.ts) |
| `lessons` | Jarvis lessons, overlay, pointer and courses on the screen | screen-hands/routes lessonRoute | 1 device | refused to a remote caller | refused for EVERY caller, the owner at the console included (the server has no desktop) |
| `away-mode` | away mode on/off/stop/queue a task (it drives the PC's screen, windows and apps; also reached by voice and Telegram /task through /__away/telegram) | away-mode/service awayRoute | 1 device | owner role only when remote | refused for EVERY caller (501 on the OS card, the same line by voice and Telegram): "Away mode drives a desktop; on the server use your own PC's companion." The runner never ticks and a carried-over armed state is disarmed at start |
| `narrate` | Narrate my workflow (the PC's microphone) | operator-plugin /narrate/* | 1 device | refused to a remote caller ("only at this PC") | unchanged: the requester's own companion, or an honest refusal |
| `control-audit-receipts` | the control_pc audit log, execution receipts, quarantine and questions | operator-plugin /control/audit, jarvis-execution/routes | 1 device | refused to a remote caller ("only at this PC") | unchanged: the requester's own companion, or an honest refusal |
| `jarvis-skill` | voice skills: clipboard, typing, windows (a remote caller gets the pure answers only) | jarvis-skills/index run() | 1 device | REMOTE_SAFE skills only for a remote caller | REMOTE_SAFE (pure answers) only for EVERY caller, the owner at the console included |
| `jarvis-events-read` | interjections the hub's own speakers claimed (local: !remote) | operator-plugin /jarvis/events GET | 1 device | local flag false for a remote caller | unchanged: the requester's own companion, or an honest refusal |
| `meetings-voice` | meeting mode and the voice stack (the hub's mic and speakers) | operator-plugin /meeting/*, /voice/free/* | 1 device | device rules (deviceDenied) | unchanged: the requester's own companion, or an honest refusal |
| `quick-actions` | pins and run log (shared); the receptionist report that opens on the PC | quick-actions.ts | 1 device | shared; the report opens on the PC only | unchanged (the log's by is the signer) |

Class 3 (publishing) has no `/__operator` site: the B2-gated publishing routes are `/__lead-sites/deploy` and `/takedown`
(see "The three categories"). Find leads keeps the fixed Google Places monthly allowance and its rate limits (there is no AgenticOS model spend cap). The UI's own
"only from this PC" captions (Automations, Hermes) are copy only and were not changed.
<!-- operator-sites:end -->

### Loopback needs the local-owner proof

On a headless server any local process can reach `127.0.0.1:8081`, and the bot desktops' WSL (mirrored networking) shares
that loopback. So in the server role a loopback request is the loopback owner only if it carries the **local-owner
token**; otherwise it is anonymous (401), including on shared, local-owner and console-only routes and on the app shell.
`self` routes keep their own proofs (`/__devices` companion and pairing tokens, `/__away` relay bearer). The one
exception is `GET`/`HEAD /__version`, which answers a data-free `{"ok":true}` so the Windows supervisor's liveness probe
needs no secret.

- The token is a random 256-bit secret the hub creates at startup in `<MU_DATA_DIR>/local-owner.token` (or
  `MU_LOCAL_OWNER_TOKEN_FILE`), readable only by the hub's account, SYSTEM and Administrators (Windows ACL with
  inheritance removed; POSIX 0600). If the ACL cannot be applied the hub refuses to start. On EVERY start an existing file is trusted
  only if its protection is exactly that (its DACL equals a freshly restricted reference file's: current account, SYSTEM,
  Administrators, no inheritance, no other entry; POSIX mode 0600 and ours); otherwise it is replaced with a NEW value and
  the correct protection, logged as "local-owner token rotated: permissions were wrong" (never the value). A correctly
  protected token is never rotated by a restart. A new file is created as a restricted temp file and renamed into place,
  so the secret is never on disk under the folder's ACL and a planted file or link is replaced, not written through.
  Deleting or rotating the file takes effect on the next request; a missing file locks loopback out (never open).
- `GET /__dev_restart` is answered before the gate; in the server role it needs the proof too (a data-free 403 otherwise).
  A `#fragment` is stripped before the 501 and gate matching. A WebSocket upgrade (the VNC viewer) never passes the gate,
  but it needs a confirmed human session, which a loopback program cannot have without a proven page navigation.
- Present it as `Authorization: Bearer <token>` (what Hermes sends as an OpenAI-compatible provider's `api_key`) or
  `X-MU-Local-Owner: <token>`. The gate compares in constant time and strips both before any handler runs. It is never
  logged or returned.
- `/__jev` accepts the token as its one key (the Jev shim's own `jev-shim.token` still works outside the server role).
- `bun scripts/identity/local-owner-token.ts path` prints the token FILE PATH, never the value.
- `localOwnerHeaders()` (same file) is what the hub's own loopback calls and the repo's probe scripts use; it returns
  `{}` on a machine with no token file, so pc and cloud send exactly what they always did.

### Final-review rules (server role)

- **Away mode drives no desktop for any caller.** It controls a screen, windows and apps, and the server has none. `POST /__operator/away`
  with `on`, `resume` or `task` answers 501 "Away mode drives a desktop; on the server use your own PC's companion." for the owner at the
  console and for either founder; voice ("away mode on", "while I'm away, ...") and Telegram `/task` through `/__away/telegram` get the
  same line and queue nothing; the runner never ticks and a state carried over from a PC (armed, a queue) is disarmed at start. Stop and
  off stay available. No clean route to a requester's own companion exists for away tasks, so none is faked. Jarvis lessons and the voice
  skills that touch the hub's windows (clipboard, typing, windows) are closed the same way: refused for everyone, the owner included.
- **Equal founders manage only their own devices.** Pairing codes, session approve and revoke, device revoke and the "require a code" policy
  are same-person only (Usman is not a super-admin); the console code CLI is the cross-person route. A founder lists his own sessions; the
  other founder's online or offline device status stays visible, his session details do not.
- **Loopback needs the proof to pair a companion** (a code redeemed from this machine maps to Usman only with the local-owner token) and
  `GET /__devices/me` from an unproven local process does not list the founders. Pairing over Serve and the bridge are unchanged.
- **An approval is never made against a constant.** A preview folder that can't be checked as one piece (too many files, too large,
  unreadable) is refused at ask and at run with a clear line (`code: "unbindable"`).
- **The token file is re-verified whenever it changes** (its content, owner or ACL: ctime), like a fresh start: protection and owner (the
  hub's account, Administrators or SYSTEM). A file that fails is no proof, logged once without the value. The Telegram relay bearer and the
  Jev shim key are created protected from their first byte (a restricted temp file, then a rename: `mode: 0o600` does nothing on Windows);
  an existing relay token with a wide ACL is tightened in place in the server role (same value).
- **A WebSocket upgrade** (the VNC viewer) never passes the gate, so it applies the same unproven-loopback rule itself, on top of needing a
  confirmed human session.
- **The harness fake publishers** (`MU_HARNESS_FAKE_PUBLISH=1`) also need the marker file `.mu-harness-scratch` inside `MU_DATA_DIR`,
  created only by harness and test setup. With the flag but no marker, every outward call refuses (logged loudly): nothing is faked and
  nothing real runs.
- **Jarvis settings stay server work** (owner decision: both founders manage Jarvis).

### Console-only set

Anything that sets or removes provider keys, rewrites the hub's own tool configuration, restarts or updates hub
software, publishes to or removes from the public internet, or is an internal bridge for local programs. Also: every
unclassified `/__*` path (deny by default survives; Vite's own `/__open-in-editor` is one).

| Route | Why |
|---|---|
| `/__design_set_key` | sets a provider key |
| `/__design_remove_key` | removes a provider key |
| `/__ccr_pin_routes` | rewrites claude-code-router config and restarts it |
| `/__dev_restart` | restarts the hub's dev server |
| `/__start_voice` | writes OPENAI_API_KEY into ~/.hermes/.env and respawns voice-lab (also a desktop voice route) |
| `/__hermes_cmd` | runs arbitrary hermes commands, including update --yes |
| `/__hermes_effort` | rewrites ~/.hermes/config.yaml |
| `/__hermes_moa_save` | rewrites ~/.hermes/config.yaml |
| `/__design_higgsfield_account` | disconnect wipes the hub's Higgsfield OAuth tokens (a provider credential); reads stay shared |
| `/__hermes_pantheon/install` | writes the hub's Hermes persona YAML (tool configuration) |
| `/__hermes_pantheon/create` | writes the hub's Hermes persona YAML (tool configuration) |
| `/__hermes_skill_sync` | copies skills into the hub's Hermes install (tool configuration) |
| `/__set_dream_engine` | changes the hub's Dream engine configuration |
| `/__ai_usage/settings` | changes hub usage settings |
| `/__claude` | Claude subscription bridge for Hermes: an internal service that only local programs call (its handler answers loopback-owner only) |
| `/__cline` | Cline bridge for Hermes: an internal service that only local programs call (its handler answers loopback-owner only) |
| `/__jev` | Jev approval guardian for Hermes: an internal service that only local programs call (its handler answers loopback-owner only) |

Console-only **for writes** (reads stay open to a confirmed founder; PUT, DELETE, POST and PATCH are loopback-only):

| Route | Why |
|---|---|
| `/__hermes_pantheon` | edits or deletes a persona YAML (the hub's Hermes tool configuration); install and create are console-only for every method |
| `/__hermes_pantheon_sync` | writes the hub's persona mirror (tool configuration) |
| `/__hermes_pantheon_templates` | writes the hub's persona templates (tool configuration) |

**Console-only is a guard rail, not a boundary.** Founders can run Claude, Hermes and Codex on the server by design
("full access for both"), and those agents can do anything the service account can. A stolen confirmed founder session
therefore means control of the server. The set keeps accidents and stray scripts away from keys and hub configuration;
it does not contain a hostile session.

### Owner-private data, open to both founders (decision to review)

The standing decision is "one shared workspace, separate logins, full access for both, no data-permission split", so
these are open to a founder with a confirmed session. The choice lives in one constant,
`OWNER_PRIVATE_OPEN_TO_BOTH_FOUNDERS` in `scripts/identity/server-role.ts`: set it to `false` and these eight join the
console-only set.

| Route | What it serves |
|---|---|
| `/__claude_chats` | the owner's Claude session list |
| `/__claude_session` | the owner's Claude transcripts |
| `/__claude_file` | files from the owner's Claude sessions |
| `/__hermes_memory` | the owner's Hermes SOUL, MEMORY and USER |
| `/__hermes_owner_profile` | the owner's profile in Hermes' USER.md (POST rewrites it) |
| `/__hermes_sessions` | the owner's Hermes sessions |
| `/__hermes_session` | one of the owner's Hermes sessions |
| `/__memory_note` | reads every Obsidian vault on the hub, including the personal vault |

### Borderline, left open

Listed with reasons in `scripts/identity/server-role.ts` (hermes/claude chat, missions, documents, studio generate and
publish, graphify, dream, approvals bridges, site tooling). Founders do shared work with them; none edits keys or the hub's
tool configuration.

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
