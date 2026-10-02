# Configuration names read by the AgenticOS source (placeholders only)

Generated from the shipped source of the package base commit (non-test files): every `process.env.*`, PowerShell `$env:*` and Rust `env::var` name.
**No values are included.** Secret-looking names are marked; set them only in your own local, uncommitted environment (e.g. `~/.config/agentic-os.env`, which the hub reads lazily — see `scripts/provider-config.ts`). Almost all are optional: features that need a missing key show a specific "connect X" state.
For CRM development on synthetic data you need none of the secret ones. Recommended dev settings are in the handoff (section 5).

| Name | Placeholder |
|---|---|
| `AB_EXE` | `<value>` |
| `ACCEPT_CODING_JOB_DIR` | `<value>` |
| `ACCEPT_HUB_PORT` | `<value>` |
| `ACCEPT_JOURNEY_EVIDENCE` | `<value>` |
| `ACCEPT_LOCAL_PROOF_LOG` | `<value>` |
| `ACCEPT_SCRATCH` | `<value>` |
| `ACCEPT_SPOKEN_OBSERVATION` | `<value>` |
| `AGENT_BROWSER_BIN` | `<value>` |
| `AGENT_BROWSER_EXE` | `<value>` |
| `AGENTIC_DEV_SOURCEMAPS` | `<value>` |
| `AGENTIC_LUCIDE_SUBSET` | `<value>` |
| `AGENTIC_OS_NO_BACKGROUND` | `<value>` |
| `AGENTIC_OS_NO_WATCH` | `<value>` |
| `AGENTIC_OS_RESTART_MAX_DEFER_MS` | `<value>` |
| `AGENTIC_OS_RESTART_QUIET_MS` | `<value>` |
| `AGENTIC_OS_TAILNET_NAME` | `<value>` |
| `AGENTIC_OS_VITE_CACHE_DIR` | `<value>` |
| `AGENTIC_OVERLAY_IN_TESTS` | `<value>` |
| `AGENTIC_SKOOL_CONNECTION_FILE` | `<value>` |
| `AGENTIC_VITE_CACHE_DIR` | `<value>` |
| `AGENTIC_WEATHER_CITY` | `<value>` |
| `AGENTIC_WEATHER_LATITUDE` | `<value>` |
| `AGENTIC_WEATHER_LONGITUDE` | `<value>` |
| `AGENTICOS_CONTEXT_MODE_DATA` | `<value>` |
| `AGENTICOS_CONTEXT_MODE_DIR` | `<value>` |
| `AGG_DEBUG_CRED` | `<value>` |
| `ANTHROPIC_API_KEY` | `<secret: set locally, never commit>` |
| `ANTHROPIC_BASE_URL` | `<value>` |
| `ANTHROPIC_MODEL` | `<value>` |
| `AOS_DEBUG_SPAWN` | `<value>` |
| `ARGENTIC_PORT` | `<value>` |
| `ARGENTIC_PREVIEW` | `<value>` |
| `ARGENTIC_VITE_CACHE_DIR` | `<value>` |
| `AWAY_BIN_PATH` | `<value>` |
| `BROWSER` | `<value>` |
| `CAD_TOOLS_ROOT` | `<value>` |
| `CAL_API_KEY` | `<secret: set locally, never commit>` |
| `CHANGEDETECTION_API_KEY` | `<secret: set locally, never commit>` |
| `CHANGEDETECTION_BASE_URL` | `<value>` |
| `CHROME` | `<value>` |
| `CLAUDE_BRIDGE_BIN` | `<value>` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `<value>` |
| `CLAUDE_CODE_ENTRYPOINT` | `<value>` |
| `CLAUDE_CONFIG_DIR` | `<value>` |
| `CLAUDE_OS_ANONYMIZE` | `<value>` |
| `CLAUDE_OS_OBSIDIAN_PATH` | `<secret: set locally, never commit>` |
| `CLAUDE_OS_REDACT_NAMES` | `<value>` |
| `CLAUDE_OS_REDACT_PREVIEWS` | `<value>` |
| `CLAUDE_OS_SHOW_INDEX_NAMES` | `<value>` |
| `CLAUDECODE` | `<value>` |
| `CLINE_BRIDGE_BIN` | `<value>` |
| `CODEX_HOME` | `<value>` |
| `CODING_ACCOUNTS_FILE` | `<value>` |
| `CODING_DATA_DIR` | `<value>` |
| `CODING_JEV` | `<value>` |
| `CODING_LIVE_ROOT` | `<value>` |
| `CODING_LIVE_SMOKE` | `<value>` |
| `CODING_PLANNER` | `<value>` |
| `CODING_REGISTRY_DEFAULTS` | `<value>` |
| `CODING_SHARED_CONTEXT_FILE` | `<value>` |
| `CODING_SMOKE_BUILDER` | `<value>` |
| `CODING_SMOKE_DIR` | `<value>` |
| `CODING_SMOKE_REVIEWER` | `<value>` |
| `CODING_SMOKE_SLOT` | `<value>` |
| `CODING_SMOKE_TASK` | `<value>` |
| `CRAWL4AI_BIN` | `<value>` |
| `CRAWL4AI_BROWSERS_PATH` | `<value>` |
| `CUA_EXE` | `<value>` |
| `CUA_PIPE` | `<value>` |
| `DISPLAY` | `<value>` |
| `FFMPEG_BIN` | `<value>` |
| `FOO_KEY` | `<secret: set locally, never commit>` |
| `GIT_OPTIONAL_LOCKS` | `<value>` |
| `GIT_TERMINAL_PROMPT` | `<value>` |
| `HERMES_HOME` | `<value>` |
| `HERMES_MIRROR` | `<value>` |
| `HF_API_KEY` | `<secret: set locally, never commit>` |
| `HF_API_KEY_ID` | `<secret: set locally, never commit>` |
| `HF_API_KEY_SECRET` | `<secret: set locally, never commit>` |
| `HF_API_SECRET` | `<secret: set locally, never commit>` |
| `HF_CREDENTIALS` | `<secret: set locally, never commit>` |
| `HF_HOME` | `<value>` |
| `HF_KEY` | `<secret: set locally, never commit>` |
| `HIGGSFIELD_API_KEY` | `<secret: set locally, never commit>` |
| `HINDSIGHT_APPROVAL_SECRET_FILE` | `<secret: set locally, never commit>` |
| `HINDSIGHT_BANK` | `<value>` |
| `HINDSIGHT_URL` | `<value>` |
| `JARVIS_AUDIT_DIR` | `<value>` |
| `JARVIS_BROWSER_CDP_PORT` | `<value>` |
| `JARVIS_DECK_ROOTS` | `<value>` |
| `JARVIS_FILE_ROOTS` | `<value>` |
| `JARVIS_GUARD_SELFTEST` | `<value>` |
| `JARVIS_OS_URL` | `<value>` |
| `JARVIS_SCREEN_HARDENED` | `<value>` |
| `JEV_SEO_PYTHON` | `<value>` |
| `JEV_SEO_SRC` | `<value>` |
| `KIE_API_KEY` | `<secret: set locally, never commit>` |
| `LAYA_DEVICE` | `<value>` |
| `LAYA_HOST` | `<value>` |
| `LAYA_MODELS` | `<value>` |
| `LAYA_PORT` | `<value>` |
| `LAYA_PRELOAD` | `<value>` |
| `LAYA_URL` | `<value>` |
| `LEAD_HUNT_LAST` | `<value>` |
| `MAX_THINKING_TOKENS` | `<secret: set locally, never commit>` |
| `MEETING_MODE_HOME` | `<value>` |
| `MEETING_WHISPER_URL` | `<value>` |
| `MEMORY_STATE_DIR` | `<value>` |
| `MEMORY_SYNC_ALLOW` | `<value>` |
| `MEMORY_SYNC_DENY` | `<value>` |
| `MIMO_BULK` | `<value>` |
| `MOTION_CHECK_OUT` | `<value>` |
| `MOTION_STUDIO_CHROME` | `<value>` |
| `MOTION_STUDIO_DRY_RUN` | `<value>` |
| `MOTION_STUDIO_EXPORT_SCALE` | `<value>` |
| `MOTION_STUDIO_HOME` | `<value>` |
| `MOTION_STUDIO_IMPROVER` | `<value>` |
| `MOTION_STUDIO_MODEL` | `<value>` |
| `MU_ALERT_TELEGRAM_CHAT_ID` | `<value>` |
| `MU_AUDIT_SITES` | `<value>` |
| `MU_CHROMIUM` | `<value>` |
| `MU_COMPUTER_NO_SANDBOX` | `<value>` |
| `MU_COMPUTERS_AGENT_LEASE_MS` | `<value>` |
| `MU_COMPUTERS_BRIDGE_PORT` | `<value>` |
| `MU_COMPUTERS_DISPLAY_BASE` | `<value>` |
| `MU_COMPUTERS_HOME` | `<value>` |
| `MU_COMPUTERS_HOST_LABEL_SSH` | `<value>` |
| `MU_COMPUTERS_HOST_LABEL_WSL` | `<value>` |
| `MU_COMPUTERS_IDLE_SUSPEND_MS` | `<value>` |
| `MU_COMPUTERS_MONITOR_MS` | `<value>` |
| `MU_COMPUTERS_PERSON_LEASE_MS` | `<value>` |
| `MU_COMPUTERS_SSH_ALIAS` | `<value>` |
| `MU_COMPUTERS_SSH_BIN` | `<value>` |
| `MU_COMPUTERS_SSH_COMPUTERS_HOME` | `<value>` |
| `MU_COMPUTERS_SSH_REMOTE_PORT` | `<value>` |
| `MU_COMPUTERS_SSH_RUN_AS_PREFIX` | `<value>` |
| `MU_COMPUTERS_SSH_TUNNEL` | `<value>` |
| `MU_COMPUTERS_SSH_WSL_DISTRO` | `<value>` |
| `MU_COMPUTERS_SSH_WSL_USER` | `<value>` |
| `MU_COMPUTERS_WSL_DISTRO` | `<value>` |
| `MU_DATA_DIR` | `<value>` |
| `MU_HARNESS_FAKE_PUBLISH` | `<value>` |
| `MU_HUB_ROLE` | `<value>` |
| `MU_LEAD_SITE_BUILDS` | `<value>` |
| `MU_LOCAL_OWNER_TOKEN_FILE` | `<secret: set locally, never commit>` |
| `MU_MEMORY_REAL_VAULT` | `<value>` |
| `MU_MEMORY_WRITER_LOCK` | `<value>` |
| `MU_MEMORY_WRITER_PORT` | `<value>` |
| `MU_MEMORY_WRITER_ROOT` | `<value>` |
| `MU_MEMORY_WRITES` | `<value>` |
| `MU_OWNER_PROBE` | `<value>` |
| `MU_PAIR_CODE` | `<value>` |
| `MU_PREVIEW_ORIGIN_PORT` | `<value>` |
| `MU_PREVIEW_PORT` | `<value>` |
| `MU_RESEARCH` | `<value>` |
| `MU_RESEARCH_MODEL` | `<value>` |
| `MU_ROUTER_REAL_FILES` | `<value>` |
| `MU_RUN_AS_PREFIX` | `<value>` |
| `MU_SEARXNG_URL` | `<value>` |
| `MU_TRIGGERS` | `<value>` |
| `MU_TRIGGERS_NOTIFY` | `<value>` |
| `MU_WIKI_ROOT` | `<value>` |
| `MU_WIKI_VAULT_NAME` | `<value>` |
| `NOTEBOOKLM_KEEPALIVE_TIMEOUT_MS` | `<value>` |
| `NOTION_API_KEY` | `<secret: set locally, never commit>` |
| `NOTION_TOKEN` | `<secret: set locally, never commit>` |
| `OPENAI_API_KEY` | `<secret: set locally, never commit>` |
| `OPENAI_BASE_URL` | `<value>` |
| `OPENROUTER_API_KEY` | `<secret: set locally, never commit>` |
| `OVERPASS_URLS` | `<value>` |
| `PATHEXT` | `<value>` |
| `PGPASSWORD` | `<secret: set locally, never commit>` |
| `PILOT_CONFIG_DIR` | `<value>` |
| `PILOT_MODEL` | `<value>` |
| `PINECONE_API_KEY` | `<secret: set locally, never commit>` |
| `PLAYWRIGHT_CORE_PATH` | `<value>` |
| `PREVIEW_HUB_PORT` | `<value>` |
| `PREVIEW_PAGE_MS` | `<value>` |
| `PYTHONHOME` | `<value>` |
| `PYTHONPATH` | `<value>` |
| `RECEPTIONIST_CRM_FILE` | `<value>` |
| `SKOOL_COOKIE` | `<secret: set locally, never commit>` |
| `SKOOL_GROUP_NAME` | `<value>` |
| `SPEED_TO_LEAD_FROM_EMAIL` | `<value>` |
| `STAGE_D_SESSION` | `<secret: set locally, never commit>` |
| `TELEGRAM_BOT_TOKEN` | `<secret: set locally, never commit>` |
| `TERM_PROGRAM` | `<value>` |
| `USER` | `<value>` |
| `WT_SESSION` | `<secret: set locally, never commit>` |
| `XDG_CONFIG_HOME` | `<value>` |
| `YOUTUBE_API_KEY` | `<secret: set locally, never commit>` |
| `YOUTUBE_CHANNEL_ID` | `<value>` |
