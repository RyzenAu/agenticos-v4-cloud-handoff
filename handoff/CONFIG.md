# Configuration names

Names and placeholders only. **No values are recorded here, and none were read to write this.** The names were extracted
from the code at `82d6962d` (`process.env.*`, `env.*`, PowerShell `$env:*`, Python `os.environ`, and the `providerKey`
reader).

## Where configuration is read from

| Source | Used for | Read by |
|---|---|---|
| The hub process's environment | Everything below | `process.env` throughout `scripts/` and `vite.config.ts` |
| `hub.env` on the always-on hub: a `KEY=VALUE` file the supervisor loads into the hub's environment | Role, ports, data dirs, computers host, provider keys | `deploy/windows/mu-hub-supervisor.ps1 -EnvFile` |
| `<repo>/.env.local`, then `~/.config/agentic-os.env`, then `~/.hermes/.env` | Provider keys, looked up lazily by name when the environment does not have them | `providerKey(root, name)` in `scripts/provider-config.ts` |
| `<data>/people.json` | Who the founders are: Tailscale logins and Telegram ids | `scripts/remote-access.ts` |
| `<data>/devices.json`, `<data>/devices-secret` | Sessions, paired devices, the cookie signing secret | `scripts/devices/store.ts` |
| `<data>/coding/repos.json`, `<data>/coding/accounts.json` | The coding repo registry and the connected coding accounts | `scripts/coding/registry.ts`, `scripts/coding/accounts.ts` |
| `<data>/agents/bots.json` | Bot records | `scripts/agents/store.ts` |
| `<data>/local-owner.token` | The local-owner proof in the server role | `scripts/identity/local-owner-token.ts` |
| `<data>/away-mode/relay.token` | The Hermes gateway's relay bearer | `scripts/identity/principal.ts` (`gatewayBearerOk`) |

`<data>` is `MU_DATA_DIR` when set, otherwise `<repo>/.operator-data`. None of these files is in this repository.
`deploy/env/production.env.example` and `staging.env.example` are name-only templates for the Linux path.

Format below: `NAME=<placeholder>` — what it does — where it is read.

## Hub role, ports, data directories

- `MU_HUB_ROLE=<pc|cloud|server>` — where the hub runs; anything else is `pc`. `server` is the headless always-on hub — `scripts/cloud/hub-role.ts`
- `MU_DATA_DIR=<absolute path>` — the hub's data directory for every store — `scripts/cloud/data-dir.ts`
- `ARGENTIC_PORT=<port>` — the hub's port as other code needs to know it (the listener itself is set by `--port` on the Vite command; production uses 8081) — `scripts/account-connections.ts`, `scripts/identity/pair-code.ts`
- `AGENTIC_OS_TAILNET_NAME=<this hub's tailnet DNS name>` — overrides the detected tailnet name — `scripts/remote-access.ts`
- `MU_LOCAL_OWNER_TOKEN_FILE=<path>` — where the local-owner proof lives; default `<data>/local-owner.token` — `scripts/identity/local-owner-token.ts`
- `AGENTIC_OS_NO_BACKGROUND=<1>` — a quiet read-only copy: no schedulers, every mutating `/__*` request refused — `scripts/preview-guard.ts`, `scripts/cli-home-guard.ts`
- `ARGENTIC_PREVIEW=<1>` — preview copy behaviour — `scripts/preview-guard.ts`, `scripts/operator-plugin.ts`
- `MU_SYNTHETIC_HUB=<1>` — marks a test hub: it gets its own empty CLI homes and isolated memory — `scripts/cli-home-guard.ts`, `scripts/memory/synthetic-guard.ts`
- `MU_DESIGN_PROJECTS_DIR=<path>` — the designs folder (the release script appends it to `hub.env` if missing) — `vite.config.ts`
- `MU_LEAD_SITE_BUILDS=<path>` — where lead-site builds go — `scripts/lead-sites/next-templates.ts`
- `MU_PREVIEW_PORT=<port>`, `MU_PREVIEW_ORIGIN_PORT=<port>` — the lead-site preview server and its origin — `scripts/lead-sites/preview-server.ts`, `scripts/lead-sites/preview-origin.ts`
- `AGENTIC_OS_NO_WATCH=<1>`, `AGENTIC_OS_RESTART_QUIET_MS=<ms>`, `AGENTIC_OS_RESTART_MAX_DEFER_MS=<ms>` — dev-server restart policy — `scripts/dev-restart-policy.ts`
- `AGENTIC_OS_VITE_CACHE_DIR=<path>` (also `AGENTIC_VITE_CACHE_DIR`, `ARGENTIC_VITE_CACHE_DIR`) — a private Vite cache for a second copy — `vite.config.ts`

## Jev (TypeSafe)

- `TYPESAFE_API_KEY=<secret>` — the Jev key. Absent means Jev is unavailable and the controller says so — read by name through `providerKey` in `vite.config.ts`, `scripts/operator-plugin.ts`, `scripts/computers/plugin.ts`, `scripts/jev-hermes.ts` and others
- `JEV_API_KEY=<secret>` — the alternative name for the same key, accepted wherever `TYPESAFE_API_KEY` is — same readers
- `CODING_JEV=<off>` — `off` makes the coding shaper draft by its own rules with no Jev call (test hubs) — `scripts/coding/plugin.ts`

The Jev endpoint and model id are not configuration: `JEV_URL` in `scripts/jev-client.ts` and `typesafe/jev-latest` in
`scripts/model-router/catalogue.json`.

## Model providers

- `OPENROUTER_API_KEY=<secret>` (and `OPENROUTER_API_KEY_ALT`) — metered model routes — `vite.config.ts`, `scripts/run-dream.ts`, the model router
- `ANTHROPIC_API_KEY=<secret>`, `ANTHROPIC_BASE_URL=<url>`, `ANTHROPIC_MODEL=<model id>` — API-route Claude (the coding harness uses native CLI sign-ins instead) — `vite.config.ts`, `scripts/aggregate.ts`, `src/motion/server/improve.ts`
- `OPENAI_API_KEY=<secret>`, `OPENAI_BASE_URL=<url>` — `voice-lab/server.ts`, voice setup
- `GROQ_API_KEY=<secret>`, `GEMINI_API_KEY=<secret>` (and `GEMINI_API_KEY_ALT`) — the free voice engine's hearing, brain and speech — `scripts/free-voice.ts` and its callers, `scripts/ai-usage/snapshot.ts`
- `DEEPSEEK_API_KEY=<secret>` — `scripts/ai-usage/snapshot.ts`, the model router
- `MIMO_BULK=<opt-in flag>` — opts bulk summaries into the MiMo route — `scripts/llm/mimo.ts`, `scripts/receptionist/summaries.ts`
- `MU_RESEARCH_MODEL=<off>` — `off` disables the delegated research model on bot computers — `scripts/computers/plugin.ts`
- `MU_ROUTER_REAL_FILES=<flag>` — lets the model router write its real receipt files outside tests — `scripts/model-router/defaults.ts`
- `HIGGSFIELD_API_KEY`, `HF_KEY`, `HF_API_KEY`, `HF_API_KEY_ID`, `HF_API_KEY_SECRET`, `HF_API_SECRET`, `HF_CREDENTIALS` (all `<secret>`) — image and video generation — `scripts/higgsfield-api.ts`, `scripts/site-draft/imagery.ts`
- `KIE_API_KEY=<secret>` — image generation scripts — `scripts/gen-image.ts`
- `FIRECRAWL_API_KEY`, `GRANOLA_API_KEY`, `BASIQ_API_KEY`, `STRIPE_RESTRICTED_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX_HOST`, `CAL_API_KEY`, `NOTION_TOKEN`, `NOTION_API_KEY`, `YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID`, `CHANGEDETECTION_API_KEY`, `CHANGEDETECTION_BASE_URL` (secrets except the ids and URL) — optional integrations; each shows a "connect" state when missing — `providerKey` callers, `scripts/account-connections.ts`, `scripts/business-integrations.ts`, `scripts/leads/watch.ts`, `scripts/aggregate.ts`

## Voice

- `ELEVENLABS_API_KEY=<secret>` (also read as `ELEVEN_LABS_API_KEY`) — Jarvis's speech — `scripts/free-voice.ts`, `scripts/voice-companion.ts`, `scripts/ai-usage/snapshot.ts`
- `MEETING_WHISPER_URL=<url>`, `MEETING_WHISPER_PORT`, `MEETING_WHISPER_MODEL`, `MEETING_WHISPER_MODELS`, `MEETING_WHISPER_IDLE_EXIT`, `MEETING_MODE_HOME` — the local meeting transcriber — `scripts/meeting-mode/*`
- `LAYA_URL`, `LAYA_HOST`, `LAYA_PORT`, `LAYA_DEVICE`, `LAYA_MODELS`, `LAYA_PRELOAD` — the local Laya model service — `scripts/laya-shadow.ts`, `scripts/windows/laya.ps1`
- `JARVIS_FILE_ROOTS=<paths>`, `JARVIS_DECK_ROOTS=<paths>` — folders Jarvis may open files and decks from — `scripts/jev-files.ts`, `scripts/jev-powerpoint.ts`
- `JARVIS_BROWSER_CDP_PORT=<port>`, `AGENT_BROWSER_EXE=<path>`, `AGENT_BROWSER_BIN=<path>` — the Jarvis browser — `scripts/j2/agent-browser.ts`, `scripts/site-draft/qa.ts`
- `JARVIS_SCREEN_HARDENED=<flag>`, `JARVIS_AUDIT_DIR=<path>` — screen-loop hardening and the control audit folder — `scripts/screen-hands/flags.ts`, `scripts/control-audit.ts`

## Memory and Hindsight

- `MU_MEMORY_WRITES=<off|read|on>` — the memory switch; anything else is `off` — `scripts/memory/settings.ts`
- `HINDSIGHT_URL=<url or off>` — the Hindsight service (through the hub's proxy) — `scripts/memory/settings.ts`, `scripts/cloud/health.ts`
- `HINDSIGHT_BANK=<bank name>` — the shared bank — `scripts/memory/settings.ts`
- `HINDSIGHT_APPROVAL_SECRET_FILE=<path to a secret file>` — signs forget approvals — `scripts/memory/settings.ts`
- `MU_WIKI_ROOT=<path to the vault>` — the vault the memory connector syncs — `scripts/memory/settings.ts`, `scripts/hermes-customise.ts`, `scripts/preview-guard.ts`
- `MU_WIKI_VAULT_NAME=<name>` — the vault's name in Obsidian links — `scripts/memory/settings.ts`
- `MEMORY_STATE_DIR=<path>`, `MEMORY_SYNC_ALLOW=<globs>`, `MEMORY_SYNC_DENY=<globs>` — connector state and sync lists — `scripts/memory/settings.ts`
- `MU_MEMORY_WRITER_PORT`, `MU_MEMORY_WRITER_ROOT`, `MU_MEMORY_WRITER_LOCK`, `MU_MEMORY_REAL_VAULT` — the single-writer rule: which copy may write the real memory — `scripts/memory/writer.ts`
- `HINDSIGHT_CLAUDE_ISOLATION_ROOT=<path>`, `CLAUDE_CODE_OAUTH_TOKEN=<secret>` — the Hindsight service's own provider patch — `scripts/hindsight/patch_provider.py`
- `PGPASSWORD=<secret>` — Hindsight's database, used by its backup script only — `scripts/hindsight/backup.ps1`

## Telegram

- `TELEGRAM_BOT_TOKEN=<secret>`, `MU_ALERT_TELEGRAM_CHAT_ID=<chat id>` — the Linux health watcher's alert — `scripts/cloud/health-watch.ts`
- `MU_OPS_ALERTS_TELEGRAM=<off>` — host-alert Telegram switch for the hub process (the Windows health-check task does not load `hub.env`; it uses `<data>/ops/alert-settings.json`, see `docs/programme-20261001/R9-OPS.md`) — `scripts/ops/host-health.ts`
- `MU_TRIGGERS=<off>`, `MU_TRIGGERS_NOTIFY=<1>` — the routine tick, and sending an approval code to the owner's own Telegram — `scripts/triggers/mount.ts`
- Founders' Telegram ids are data in `<data>/people.json`, not environment. Two source constants also hold the owner's id (`scripts/away-mode/notify.ts`, `scripts/inbox-triage/alerts.ts`); in this handoff tree they hold a placeholder (see `handoff/README.md`)

## Tailscale and gateway

- There is no Tailscale auth key in the hub's configuration. Tailscale runs as a system service; Serve fronts `127.0.0.1:8081` on 8443 (`deploy/tailscale/serve.sh` for the Linux path). The hub verifies Serve-relayed requests in `scripts/identity/serve-peer.ts` and `scripts/remote-access.ts`
- `AGENTIC_OS_TAILNET_NAME` (above) is the only Tailscale-related name
- Gateway configuration is on `gw/dot-gateway-20261002`, not this branch
- `AGENCY_FEED_URL=<url>`, `AGENCY_FEED_TOKEN=<secret>` — the receptionist's token-protected feed — `scripts/receptionist/agency-feed.ts`
- `RETELL_API_KEY=<secret>`, `TWILIO_ACCOUNT_SID=<id>`, `TWILIO_AUTH_TOKEN=<secret>`, `RECEPTIONIST_CRM_FILE=<path>` — receptionist (on hold) — `scripts/receptionist/*`

## Coding registry and accounts

- `CODING_DATA_DIR=<path>` — the coding store's folder; default `<data>/coding` — `scripts/coding/plugin.ts`
- `CODING_REGISTRY_DEFAULTS=<path or off>` — the defaults file used to seed the repo registry (`config/coding-repos.defaults.json`) — `scripts/coding/registry.ts`
- `CODING_PLANNER=<off>` — `off` disables the Claude planner in the shaper — `scripts/coding/plugin.ts`
- `CLAUDE_CONFIG_DIR=<path>`, `CODEX_HOME=<path>` — per-account CLI homes; the accounts file names one per slot — `scripts/coding/claude-status.ts`, `scripts/memory-apps.ts`
- `AGENTICOS_CONTEXT_MODE_DIR`, `AGENTICOS_CONTEXT_MODE_DATA` — the pinned context-helper trial — `scripts/coding/runners/context-helper.ts`, `scripts/coding/plugin.ts`
- `CLAUDE_BRIDGE_BIN=<path>`, `CLINE_BRIDGE_BIN=<path>` — the CLI bridges' binaries — `scripts/claude-bridge.ts`, `scripts/cline-bridge.ts`
- `CODING_LIVE_SMOKE`, `CODING_LIVE_ROOT`, `CODING_ACCOUNTS_FILE`, `CODING_SHARED_CONTEXT_FILE`, `CODING_SMOKE_*`, `CODING_SEED_PHASE`, `PILOT_CONFIG_DIR`, `PILOT_MODEL` — live smoke and seed scripts only — `scripts/coding/live-smoke.ts`, `scripts/coding/dev-seed.ts`, `scripts/coding/context-helper-pilot.ts`

## Bot computers

Documented in the header of `scripts/computers/plugin.ts`; none is a secret.

- `MU_COMPUTERS_WSL_DISTRO=<distro>` — the local WSL host
- `MU_COMPUTERS_SSH_ALIAS=<ssh Host alias>`, `MU_COMPUTERS_SSH_WSL_DISTRO`, `MU_COMPUTERS_SSH_WSL_USER`, `MU_COMPUTERS_SSH_RUN_AS_PREFIX`, `MU_COMPUTERS_SSH_COMPUTERS_HOME`, `MU_COMPUTERS_SSH_REMOTE_PORT`, `MU_COMPUTERS_SSH_TUNNEL=<off>`, `MU_COMPUTERS_SSH_BIN` — a Linux host over SSH
- `MU_COMPUTERS_BRIDGE_PORT`, `MU_COMPUTERS_DISPLAY_BASE`, `MU_COMPUTERS_HOME` — bridge port, first X display, computers folder
- `MU_COMPUTERS_AGENT_LEASE_MS`, `MU_COMPUTERS_PERSON_LEASE_MS`, `MU_COMPUTERS_MONITOR_MS`, `MU_COMPUTERS_IDLE_SUSPEND_MS` — lease lengths, probe interval, idle suspend
- `MU_COMPUTERS_HOST_LABEL_SSH`, `MU_COMPUTERS_HOST_LABEL_WSL`, `MU_AUDIT_SITES=<hosts>`, `MU_RESEARCH` — labels, the hosts a website audit may open, research wiring
- On the bot computer itself: `MU_PAIR_CODE`, `MU_CHROMIUM`, `MU_COMPUTER_NO_SANDBOX`, `DISPLAY` — `companion/linux/main.ts`, `companion/linux/cdp.ts`

## Search and leads

- `MU_SEARXNG_URL=<url>` — the local SearXNG — `scripts/search/searxng.ts`, `scripts/ops/check-search.ts`
- `OVERPASS_URLS=<urls>`, `CRAWL4AI_BIN`, `CRAWL4AI_PYTHON`, `CRAWL4AI_BROWSERS_PATH`, `JEV_SEO_SRC`, `JEV_SEO_PYTHON`, `LEAD_HUNT_LAST`, `LEAD_HUNT_STATE`, `LEAD_HUNT_ALERT_STATE`, `SPEED_TO_LEAD_FROM_EMAIL=<address>`, `MU_IMPORT_ALLOW_LIVE` — lead discovery, audit and import tools — `scripts/leads/*`, `scripts/speed-to-lead/run.ts`, `scripts/crm/import-deliverables.ts`

## Every name found in the code

Generated from the tree. Operating-system variables (`PATH`, `HOME`, `APPDATA` and the like) are left out.
`<secret>` marks names that hold a credential; set them only in local, uncommitted configuration.

| Name | Placeholder | Read in (up to two files) |
|---|---|---|
| `AB_EXE` | `<value>` | `scripts/devices/agent-browser-probe.ts` |
| `ACCEPT_CODING_JOB_DIR` | `<value>` | `scripts/acceptance/tasks.ts` |
| `ACCEPT_HUB_PORT` | `<value>` | `scripts/acceptance/tasks.ts` |
| `ACCEPT_JOURNEY_EVIDENCE` | `<value>` | `scripts/acceptance/tasks.ts` |
| `ACCEPT_LOCAL_PROOF_LOG` | `<value>` | `scripts/acceptance/tasks.ts` |
| `ACCEPT_SCRATCH` | `<value>` | `scripts/acceptance/probes.ts`, `scripts/acceptance/run.ts` |
| `ACCEPT_SPOKEN_OBSERVATION` | `<value>` | `scripts/acceptance/tasks.ts` |
| `AGENCY_FEED_TOKEN` | `<secret>` | `scripts/receptionist/agency-feed.ts` |
| `AGENCY_FEED_URL` | `<value>` | `scripts/receptionist/agency-feed.ts` |
| `AGENTICOS_CONTEXT_MODE_DATA` | `<value>` | `scripts/coding/plugin.ts` |
| `AGENTICOS_CONTEXT_MODE_DIR` | `<value>` | `scripts/coding/runners/context-helper.ts` |
| `AGENTIC_DEV_SOURCEMAPS` | `<value>` | `scripts/dev-page-weight.ts` |
| `AGENTIC_LUCIDE_SUBSET` | `<value>` | `scripts/dev-page-weight.ts` |
| `AGENTIC_OS_NO_BACKGROUND` | `<value>` | `scripts/cli-home-guard.ts`, `scripts/acceptance/r7/hub.ts` |
| `AGENTIC_OS_NO_WATCH` | `<value>` | `scripts/dev-restart-policy.ts` |
| `AGENTIC_OS_RESTART_MAX_DEFER_MS` | `<value>` | `scripts/dev-restart-policy.ts` |
| `AGENTIC_OS_RESTART_QUIET_MS` | `<value>` | `scripts/dev-restart-policy.ts` |
| `AGENTIC_OS_TAILNET_NAME` | `<value>` | `scripts/remote-access.ts` |
| `AGENTIC_OS_VITE_CACHE_DIR` | `<value>` | `vite.config.ts` |
| `AGENTIC_OVERLAY_IN_TESTS` | `<value>` | `scripts/screen-hands/overlay.ts` |
| `AGENTIC_SKOOL_CONNECTION_FILE` | `<value>` | `scripts/skool-messages.ts` |
| `AGENTIC_VITE_CACHE_DIR` | `<value>` | `vite.config.ts` |
| `AGENTIC_WEATHER_CITY` | `<value>` | `scripts/business-today.ts` |
| `AGENTIC_WEATHER_LATITUDE` | `<value>` | `scripts/business-today.ts` |
| `AGENTIC_WEATHER_LONGITUDE` | `<value>` | `scripts/business-today.ts` |
| `AGENT_BROWSER_BIN` | `<value>` | `scripts/site-draft/qa.ts` |
| `AGENT_BROWSER_EXE` | `<value>` | `scripts/j2/agent-browser.ts` |
| `AGG_DEBUG_CRED` | `<value>` | `scripts/aggregate.ts` |
| `ANTHROPIC_API_KEY` | `<secret>` | `scripts/aggregate.ts`, `vite.config.ts` |
| `ANTHROPIC_BASE_URL` | `<value>` | `src/motion/server/improve.ts`, `vite.config.ts` |
| `ANTHROPIC_MODEL` | `<value>` | `vite.config.ts` |
| `AOS_DEBUG_SPAWN` | `<value>` | `vite.config.ts` |
| `ARGENTIC_PORT` | `<value>` | `scripts/account-connections.ts`, `scripts/identity/pair-code.ts` |
| `ARGENTIC_PREVIEW` | `<value>` | `scripts/operator-plugin.ts`, `scripts/cli-home-guard.ts` |
| `ARGENTIC_VITE_CACHE_DIR` | `<value>` | `vite.config.ts` |
| `AWAY_BIN_PATH` | `<value>` | `scripts/away-mode/service.ts` |
| `BASIQ_API_KEY` | `<secret>` | `scripts/finance/basiq.ts` |
| `CAD_TOOLS_ROOT` | `<value>` | `scripts/cad-hands.ts` |
| `CAL_API_KEY` | `<secret>` | `scripts/account-connections.ts` |
| `CHANGEDETECTION_API_KEY` | `<secret>` | `scripts/leads/watch.ts` |
| `CHANGEDETECTION_BASE_URL` | `<value>` | `scripts/leads/watch.ts` |
| `CHROME` | `<value>` | `scripts/devices/agent-browser-probe.ts` |
| `CLAUDECODE` | `<value>` | `src/motion/server/improve.ts` |
| `CLAUDE_BRIDGE_BIN` | `<value>` | `scripts/claude-bridge.ts` |
| `CLAUDE_CODE_ENTRYPOINT` | `<value>` | `src/motion/server/improve.ts` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `<secret>` | `scripts/hindsight/patch_provider.py` |
| `CLAUDE_CONFIG_DIR` | `<value>` | `scripts/cli-home-guard.ts`, `scripts/memory-apps.ts` |
| `CLAUDE_OS_ANONYMIZE` | `<value>` | `scripts/aggregate.ts` |
| `CLAUDE_OS_OBSIDIAN_PATH` | `<value>` | `scripts/aggregate.ts` |
| `CLAUDE_OS_REDACT_NAMES` | `<value>` | `scripts/aggregate.ts` |
| `CLAUDE_OS_REDACT_PREVIEWS` | `<value>` | `scripts/aggregate.ts` |
| `CLAUDE_OS_SHOW_INDEX_NAMES` | `<value>` | `scripts/aggregate.ts` |
| `CLICK` | `<value>` | `scripts/acceptance/r11/send-probe.ts` |
| `CLINE_BRIDGE_BIN` | `<value>` | `scripts/cline-bridge.ts` |
| `CODEX_HOME` | `<value>` | `scripts/run-dream.ts`, `scripts/cli-home-guard.ts` |
| `CODING_ACCOUNTS_FILE` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_DATA_DIR` | `<value>` | `scripts/coding/dev-seed.ts`, `scripts/coding/plugin.ts` |
| `CODING_JEV` | `<value>` | `scripts/coding/plugin.ts` |
| `CODING_LIVE_ROOT` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_LIVE_SMOKE` | `<value>` | `scripts/coding/context-helper-pilot.ts`, `scripts/coding/live-smoke.ts` |
| `CODING_PLANNER` | `<value>` | `scripts/coding/plugin.ts` |
| `CODING_REGISTRY_DEFAULTS` | `<value>` | `scripts/coding/registry.ts` |
| `CODING_SEED_PHASE` | `<value>` | `scripts/coding/dev-seed.ts` |
| `CODING_SHARED_CONTEXT_FILE` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_SMOKE_BUILDER` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_SMOKE_DIR` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_SMOKE_REVIEWER` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_SMOKE_SLOT` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CODING_SMOKE_TASK` | `<value>` | `scripts/coding/live-smoke.ts` |
| `CRAWL4AI_BIN` | `<value>` | `scripts/leads/crawl4ai.ts` |
| `CRAWL4AI_BROWSERS_PATH` | `<value>` | `scripts/leads/crawl4ai.ts` |
| `CRAWL4AI_PYTHON` | `<value>` | `scripts/leads/seo_audit_pdf.py` |
| `CUA_EXE` | `<value>` | `scripts/devices/cua-compare.ts` |
| `CUA_PIPE` | `<value>` | `scripts/devices/cua-compare.ts` |
| `DATA_ONLY` | `<value>` | `scripts/acceptance/r11/err-probe.ts` |
| `DEEPSEEK_API_KEY` | `<secret>` | `scripts/ai-usage/snapshot.ts` |
| `DISPLAY` | `<value>` | `scripts/computers/scroll-bench.ts`, `companion/linux/main.ts` |
| `ELEVENLABS_API_KEY` | `<secret>` | `scripts/ai-usage/snapshot.ts` |
| `FFMPEG_BIN` | `<value>` | `scripts/site-draft/imagery.ts` |
| `FIRECRAWL_API_KEY` | `<secret>` | `vite.config.ts` |
| `FULL` | `<value>` | `scripts/acceptance/r11/probe.ts` |
| `GEMINI_API_KEY` | `<secret>` | `scripts/claude-vision.ts`, `scripts/vision.ts` |
| `GIT_OPTIONAL_LOCKS` | `<value>` | `scripts/coding/worktree.ts` |
| `GIT_TERMINAL_PROMPT` | `<value>` | `scripts/coding/worktree.ts` |
| `GRANOLA_API_KEY` | `<secret>` | `scripts/granola-api.ts` |
| `GROQ_API_KEY` | `<secret>` | `scripts/ai-usage/snapshot.ts`, `scripts/meeting-mode/live-test.ts` |
| `HERMES_HOME` | `<value>` | `scripts/run-dream.ts`, `scripts/aggregate.ts` |
| `HERMES_MIRROR` | `<value>` | `vite.config.ts` |
| `HF_API_KEY` | `<secret>` | `scripts/higgsfield-api.ts` |
| `HF_API_KEY_ID` | `<value>` | `scripts/higgsfield-api.ts` |
| `HF_API_KEY_SECRET` | `<secret>` | `scripts/higgsfield-api.ts` |
| `HF_API_SECRET` | `<secret>` | `scripts/higgsfield-api.ts` |
| `HF_CREDENTIALS` | `<secret>` | `scripts/site-draft/imagery.ts` |
| `HF_HOME` | `<value>` | `scripts/windows/laya.ps1` |
| `HF_KEY` | `<secret>` | `scripts/site-draft/imagery.ts` |
| `HIGGSFIELD_API_KEY` | `<secret>` | `scripts/site-draft/imagery.ts` |
| `HINDSIGHT_APPROVAL_SECRET_FILE` | `<secret>` | `scripts/memory/settings.ts` |
| `HINDSIGHT_BANK` | `<value>` | `scripts/memory/settings.ts` |
| `HINDSIGHT_CLAUDE_ISOLATION_ROOT` | `<value>` | `scripts/hindsight/patch_provider.py` |
| `HINDSIGHT_URL` | `<value>` | `scripts/cloud/health.ts`, `scripts/computers/r6-hub.ps1` |
| `JARVIS_AUDIT_DIR` | `<value>` | `scripts/control-audit.ts` |
| `JARVIS_BROWSER_CDP_PORT` | `<value>` | `scripts/j2/agent-browser.ts` |
| `JARVIS_DECK_ROOTS` | `<value>` | `scripts/jev-powerpoint.ts` |
| `JARVIS_FILE_ROOTS` | `<value>` | `scripts/jev-files.ts` |
| `JARVIS_GUARD_SELFTEST` | `<value>` | `scripts/jarvis-e2e/guard.ts` |
| `JARVIS_OS_URL` | `<value>` | `scripts/jarvis-e2e/suite.ts` |
| `JARVIS_SCREEN_HARDENED` | `<value>` | `scripts/screen-hands/flags.ts` |
| `JEV_API_KEY` | `<secret>` | `scripts/computers/plugin.ts`, `scripts/crm-duplicate-review.ts` |
| `JEV_SEO_PYTHON` | `<value>` | `scripts/leads/seo-audit.ts` |
| `JEV_SEO_SRC` | `<value>` | `scripts/leads/seo-audit.ts`, `scripts/leads/seo_audit_pdf.py` |
| `KIE_API_KEY` | `<secret>` | `scripts/gen-hermes-file-type-art.ts`, `scripts/gen-image.ts` |
| `LAYA_DEVICE` | `<value>` | `scripts/windows/laya.ps1` |
| `LAYA_HOST` | `<value>` | `scripts/windows/laya.ps1` |
| `LAYA_MODELS` | `<value>` | `scripts/windows/laya.ps1` |
| `LAYA_PORT` | `<value>` | `scripts/windows/laya.ps1` |
| `LAYA_PRELOAD` | `<value>` | `scripts/windows/laya.ps1` |
| `LAYA_URL` | `<value>` | `scripts/laya-shadow.ts` |
| `LEAD_HUNT_ALERT_STATE` | `<value>` | `scripts/leads/hermes/lead-hunt.py` |
| `LEAD_HUNT_LAST` | `<value>` | `scripts/leads/hunt.ts`, `scripts/leads/hermes/lead-hunt.py` |
| `LEAD_HUNT_STATE` | `<value>` | `scripts/leads/hermes/lead-hunt.py` |
| `MEETING_MODE_HOME` | `<value>` | `scripts/meeting-mode/transcriber.ts` |
| `MEETING_WHISPER_IDLE_EXIT` | `<value>` | `scripts/meeting-mode/whisper_server.py` |
| `MEETING_WHISPER_MODEL` | `<value>` | `scripts/meeting-mode/whisper_server.py` |
| `MEETING_WHISPER_MODELS` | `<value>` | `scripts/meeting-mode/whisper_server.py` |
| `MEETING_WHISPER_PORT` | `<value>` | `scripts/meeting-mode/whisper_server.py` |
| `MEETING_WHISPER_URL` | `<value>` | `scripts/meeting-mode/transcriber.ts` |
| `MEMORY_STATE_DIR` | `<value>` | `scripts/memory/settings.ts`, `scripts/preview-guard.ts` |
| `MEMORY_SYNC_ALLOW` | `<value>` | `scripts/memory/settings.ts` |
| `MEMORY_SYNC_DENY` | `<value>` | `scripts/memory/settings.ts` |
| `MIMO_BULK` | `<value>` | `scripts/receptionist/summaries.ts`, `scripts/llm/mimo.ts` |
| `MOTION_CHECK_OUT` | `<value>` | `src/motion/check/check.ts` |
| `MOTION_STUDIO_CHROME` | `<value>` | `src/motion/server/cdp.ts` |
| `MOTION_STUDIO_DRY_RUN` | `<value>` | `src/motion/server/plugin.ts` |
| `MOTION_STUDIO_EXPORT_SCALE` | `<value>` | `src/motion/server/plugin.ts` |
| `MOTION_STUDIO_HOME` | `<value>` | `src/motion/server/util.ts` |
| `MOTION_STUDIO_IMPROVER` | `<value>` | `src/motion/server/plugin.ts` |
| `MOTION_STUDIO_MODEL` | `<value>` | `src/motion/server/improve.ts` |
| `MU_ALERT_TELEGRAM_CHAT_ID` | `<value>` | `scripts/cloud/health-watch.ts` |
| `MU_ALLOC_DIR` | `<value>` | `deploy/computers/linux/computer-ctl.sh` |
| `MU_AUDIT_SITES` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_CHROMIUM` | `<value>` | `companion/linux/cdp.ts`, `scripts/computers/scroll-bench.ts` |
| `MU_COMPUTERS_AGENT_LEASE_MS` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_BRIDGE_PORT` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_DISPLAY_BASE` | `<value>` | `scripts/computers/script-adapter.ts`, `scripts/computers/store.ts` |
| `MU_COMPUTERS_HOME` | `<value>` | `scripts/acceptance/r7/hub-env.ts`, `scripts/computers/vps-ssh.ts` |
| `MU_COMPUTERS_HOST_LABEL_SSH` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_HOST_LABEL_WSL` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_IDLE_SUSPEND_MS` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_MONITOR_MS` | `<value>` | `scripts/acceptance/r7/hub-env.ts`, `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_PERSON_LEASE_MS` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_SSH_ALIAS` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_SSH_BIN` | `<value>` | `scripts/computers/vps-ssh.ts` |
| `MU_COMPUTERS_SSH_COMPUTERS_HOME` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_SSH_REMOTE_PORT` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_SSH_RUN_AS_PREFIX` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_SSH_TUNNEL` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_SSH_WSL_DISTRO` | `<value>` | `scripts/computers/plugin.ts`, `scripts/computers/r6-hub.ps1` |
| `MU_COMPUTERS_SSH_WSL_USER` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_COMPUTERS_WSL_DISTRO` | `<value>` | `scripts/acceptance/r7/hub-env.ts`, `scripts/computers/plugin.ts` |
| `MU_COMPUTER_NO_SANDBOX` | `<value>` | `companion/linux/main.ts` |
| `MU_DATA_DIR` | `<value>` | `scripts/acceptance/seed-gate-hub.ts`, `scripts/cloud/r7-journey-l.ts` |
| `MU_DESIGN_PROJECTS_DIR` | `<value>` | `vite.config.ts` |
| `MU_HARNESS_FAKE_PUBLISH` | `<value>` | `scripts/harness/fake-publish.ts` |
| `MU_HUB_ROLE` | `<value>` | `deploy/windows/mu-hub-backup.ps1`, `scripts/devices/local-hub.ts` |
| `MU_IMPORT_ALLOW_LIVE` | `<value>` | `scripts/crm/import-deliverables.ts` |
| `MU_LEAD_SITE_BUILDS` | `<value>` | `scripts/lead-sites/next-templates.ts` |
| `MU_LOCAL_OWNER_TOKEN_FILE` | `<value>` | `scripts/identity/local-owner-token.ts` |
| `MU_MEMORY_REAL_VAULT` | `<value>` | `scripts/memory/writer.ts` |
| `MU_MEMORY_WRITER_LOCK` | `<value>` | `scripts/memory/writer.ts` |
| `MU_MEMORY_WRITER_PORT` | `<value>` | `scripts/memory/writer.ts` |
| `MU_MEMORY_WRITER_ROOT` | `<value>` | `scripts/memory/writer.ts` |
| `MU_MEMORY_WRITES` | `<value>` | `scripts/computers/r6-hub.ps1`, `deploy/local/cloud-rehearsal.ps1` |
| `MU_OPS_ALERTS_TELEGRAM` | `<value>` | `scripts/ops/host-health.ts` |
| `MU_OWNER_PROBE` | `<value>` | `scripts/identity/local-owner-token.ts` |
| `MU_PAIR_CODE` | `<value>` | `companion/linux/main.ts` |
| `MU_PREVIEW_ORIGIN_PORT` | `<value>` | `scripts/lead-sites/preview-origin.ts` |
| `MU_PREVIEW_PORT` | `<value>` | `scripts/lead-sites/preview-server.ts`, `deploy/windows/crm-rehearsal.ps1` |
| `MU_RESEARCH` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_RESEARCH_MODEL` | `<value>` | `scripts/computers/plugin.ts` |
| `MU_ROUTER_REAL_FILES` | `<value>` | `scripts/model-router/defaults.ts` |
| `MU_RUN_AS_PREFIX` | `<value>` | `scripts/computers/vps-ssh.ts` |
| `MU_SAMPLER_BASE` | `<value>` | `scripts/computers/journey-lan.ts`, `scripts/computers/wsl-sampler.py` |
| `MU_SEARXNG_URL` | `<value>` | `scripts/ops/check-search.ts`, `scripts/search/searxng.ts` |
| `MU_SYNTHETIC_HUB` | `<value>` | `scripts/cli-home-guard.ts` |
| `MU_TRIGGERS` | `<value>` | `scripts/triggers/mount.ts`, `deploy/windows/crm-rehearsal.ps1` |
| `MU_TRIGGERS_NOTIFY` | `<value>` | `scripts/triggers/mount.ts` |
| `MU_WIKI_ROOT` | `<value>` | `scripts/hermes-customise.ts`, `scripts/preview-guard.ts` |
| `MU_WIKI_VAULT_NAME` | `<value>` | `scripts/memory/settings.ts` |
| `NOTEBOOKLM_KEEPALIVE_TIMEOUT_MS` | `<value>` | `scripts/windows/notebooklm-keepalive.ps1` |
| `NOTION_API_KEY` | `<secret>` | `scripts/aggregate.ts` |
| `NOTION_TOKEN` | `<secret>` | `scripts/aggregate.ts` |
| `OPENAI_API_KEY` | `<secret>` | `voice-lab/server.ts`, `scripts/setup-discovery.ts` |
| `OPENAI_BASE_URL` | `<value>` | `voice-lab/server.ts` |
| `OPENROUTER_API_KEY` | `<secret>` | `vite.config.ts`, `scripts/run-dream.ts` |
| `OVERPASS_URLS` | `<value>` | `scripts/leads/osm.ts` |
| `PAGES` | `<value>` | `scripts/acceptance/r11/a11y-sweep.ts` |
| `PAIRING_HARNESS_DATA` | `<value>` | `scripts/devices/pairing-harness/vite.config.ts` |
| `PGPASSWORD` | `<secret>` | `scripts/hindsight/backup.ps1`, `scripts/hindsight/stage-d-instance.ps1` |
| `PILOT_CONFIG_DIR` | `<value>` | `scripts/coding/context-helper-pilot.ts` |
| `PILOT_MODEL` | `<value>` | `scripts/coding/context-helper-pilot.ts` |
| `PINECONE_API_KEY` | `<secret>` | `scripts/aggregate.ts`, `scripts/ai-usage/snapshot.ts` |
| `PINECONE_INDEX_HOST` | `<value>` | `scripts/ai-usage/snapshot.ts` |
| `PLAYWRIGHT_BROWSERS_PATH` | `<value>` | `scripts/leads/seo_audit_pdf.py` |
| `PLAYWRIGHT_CORE_PATH` | `<value>` | `scripts/screen-hands/browser-exec.ts` |
| `PORT` | `<value>` | `voice-lab/server.ts` |
| `PREVIEW_HUB_PORT` | `<value>` | `scripts/jarvis-command/research-loop-preview-host.ts` |
| `PREVIEW_PAGE_MS` | `<value>` | `scripts/jarvis-command/research-loop-preview-host.ts` |
| `R7_DATA` | `<value>` | `scripts/acceptance/r7/journey-g-crm.ts` |
| `RECEPTIONIST_CRM_FILE` | `<value>` | `scripts/receptionist/plugin.ts` |
| `RETELL_API_KEY` | `<secret>` | `scripts/operator-plugin.ts`, `scripts/ai-usage/snapshot.ts` |
| `SKOOL_COOKIE` | `<secret>` | `scripts/business-integrations.ts` |
| `SKOOL_GROUP_NAME` | `<value>` | `scripts/business-integrations.ts` |
| `SLOW` | `<value>` | `scripts/acceptance/r11/send-probe.ts` |
| `SPEED_TO_LEAD_FROM_EMAIL` | `<value>` | `scripts/speed-to-lead/run.ts` |
| `STAGE_D_SESSION` | `<value>` | `scripts/memory/stage-d-verify-live.ts` |
| `STRIPE_RESTRICTED_KEY` | `<secret>` | `scripts/finance/stripe.ts` |
| `TELEGRAM_BOT_TOKEN` | `<secret>` | `scripts/cloud/health-watch.ts` |
| `TWILIO_ACCOUNT_SID` | `<value>` | `scripts/ai-usage/snapshot.ts`, `scripts/receptionist/twilio.ts` |
| `TWILIO_AUTH_TOKEN` | `<secret>` | `scripts/ai-usage/snapshot.ts`, `scripts/receptionist/twilio.ts` |
| `TYPESAFE_API_KEY` | `<secret>` | `scripts/computers/plugin.ts`, `scripts/crm-duplicate-review.ts` |
| `WAIT` | `<value>` | `scripts/acceptance/r11/send-probe.ts` |
| `YOUTUBE_API_KEY` | `<secret>` | `scripts/business-integrations.ts` |
| `YOUTUBE_CHANNEL_ID` | `<value>` | `scripts/business-integrations.ts` |
