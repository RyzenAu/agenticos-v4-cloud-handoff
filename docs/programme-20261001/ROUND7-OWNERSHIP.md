# Round 7 ownership and resources (3 Oct 2026)

Lead: Claude (Opus 5.5). Live on Ryzen: `5fc21c05` (https://ryzen-pc.tailnet-name.ts.net:8443, tailnet only). Integration branch
`ws/integration-20261002` at `c332d55f` (live code + docs). Every worker branches from `c332d55f` in its own worktree; the lead merges.
Max 8 concurrent workers including reviewers. Final gate: serial, one frozen candidate, run by the lead.

| Worker | Scope | Worktree / branch | Owns (sole resolver) |
|---|---|---|---|
| A | Rakazo + references research, Agents visual implementation | `D:\AgenticOS-r7-a-agents-ui` · `r7/a-agents-ui-20261003` | `src/components/agents/workspace/**` (incl. `layout/**`, selector), `src/components/agents/setup/**`, `src/routes/agents.*`, `docs/programme-20261001/AGENTS-WORKSPACE-REFERENCES.md` |
| B | Conversation, voice, task continuity | `D:\AgenticOS-r7-b-continuity` · `r7/b-continuity-20261003` | `src/components/agents/chat/**`, `src/lib/agent-chat.ts`, `src/lib/voice-scope.ts`, `src/lib/jarvis-command.ts`, `scripts/jarvis-command/**`, `scripts/agents/**`, `scripts/conversations.ts` |
| C | Bot computers, viewer, files, recovery | `D:\AgenticOS-r7-c-computers` · `r7/c-computers-20261003` | `scripts/computers/**`, `src/components/agents/computer/**`, `src/components/computers/**`, `src/lib/computers*.ts` |
| D | Coding jobs, account/model selection, approvals | `D:\AgenticOS-r7-d-coding` · `r7/d-coding-20261003` | `scripts/coding/**`, `src/components/coding/**`, `src/routes/coding*`, `scripts/approvals/**` (coding-facing), `src/components/agents/tasks/**` |
| E | Dot's CRM integration (already running) | `D:\AgenticOS-crm` · `crm/integration-20261003` | `scripts/crm/**`, `src/components/crm/**`, `src/routes/crm.tsx`, CRM mount in `vite.config.ts`, `/__crm` route class, `crm` event topic |
| F | App-wide usability, navigation, accessibility, websites | `D:\AgenticOS-r7-f-app-usability` · `r7/f-app-usability-20261003` | `src/components/shell/**` (navigation), every page/route not owned above (Home, Work, Memory, Finance, Studio/Design, Automations, Activity, System, Settings, Leads UI), `scripts/lead-sites/**` committed files only |
| G | Hosting, desktop shell, pairing in WebView, memory, backups, operations | `D:\AgenticOS-r7-g-ops-shell` · `r7/g-ops-shell-20261003` | `src-tauri/**`, `desktop/**`, `deploy/**`, `scripts/cloud/**`, `scripts/devices/**`, `src/components/profile/**`, `scripts/memory/**` (integration paths) |
| H | Independent acceptance + integration reviewer | `D:\AgenticOS-r7-h-acceptance` · `r7/h-acceptance-20261003` | read-only for product code; owns `docs/programme-20261001/ACCEPTANCE-R7.md` and acceptance scripts under `scripts/acceptance/r7/**` |
| R | Cloud reconciliation research (read-only, running) | scratch report | none |

**Shared files, one resolver each:** `vite.config.ts`: E for the CRM mount, lead for anything else (propose a patch to the lead).
`scripts/identity/**`, `docs/IDENTITY-ROUTES.md`, `src/routeTree.gen.ts` (generated), `scripts/events/**`, `src/lib/activity-stream.ts`,
`package.json`/`bun.lock` (no new dependencies without the lead): **lead**. `src/lib/format.ts`: F. `src/components/ds/**`: F
(A, B and C propose). `scripts/jobs/**`: D. Docs: each worker owns its own new doc; `BOARD.md`, `GATE-RESULT.md`: lead.

**Resources (main PC: 16 logical CPUs, 31 GB RAM).**

| Worker | Synthetic hub port | Preview port | Data dir | WSL display |
|---|---|---|---|---|
| A | 8121 | 8131 | `D:\AgenticOS-r7-data\a` | none |
| B | 8122 | 8132 | `D:\AgenticOS-r7-data\b` | none |
| C | 8123 | 8133 | `D:\AgenticOS-r7-data\c` | `:41`–`:44` (local WSL test computers only) |
| D | 8124 | 8134 | `D:\AgenticOS-r7-data\d` | none |
| E | 8125 | 8135 | `D:\AgenticOS-r7-data\e` | none |
| F | 8126 | 8136 | `D:\AgenticOS-r7-data\f` | none |
| G | 8127 | 8137 | `D:\AgenticOS-r7-data\g` | none |
| H | 8128 | 8138 | `D:\AgenticOS-r7-data\h` | none |

Synthetic identities: founders `usman` / `mehroz` exist only in each synthetic data dir (seed: `scripts/acceptance/seed-gate-hub.ts`).
Heavy runs: at most two workers run a browser or a build at once; nobody runs the full suite (the lead's serial gate does). Production
(Ryzen 8081, `C:\mu-hub\data\production`) is touched only by the lead's release procedure.
