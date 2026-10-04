# Architecture

Verified against the tree at `82d6962d`. File paths are relative to the repository root.

## The model in one paragraph

**Jarvis** is the assistant's name, personality and voice: the one identity a person talks to. **Jev** is the central
typed decision model (TypeSafe System One, surface `command.controller`) that directs meaningful task routing by choosing
among finite, validated options. Language models, tools and computers are **delegated workers**. **Deterministic code**
keeps permissions, arguments, arithmetic, execution and durable state.

## Rules the code enforces

1. **Every new typed or spoken task goes through the Jev-led controller when Jev is available.** `jevLed` is true when a
   controller is configured and the source is `typed` or `voice` (`scripts/jarvis-command/service.ts`). The exact rules in
   `plan.ts` then only fill the lane Jev chose (the URL, the verbatim query, the ordered steps) and validate it.
2. **Stop and answers to a pending question are handled immediately, before Jev.** Stop words cancel the person's
   running commands through the job service and drop a pending coding-planner question. A whole-utterance answer
   ("yes", "start it") answers the question that is waiting; it is never routed as a new task.
3. **Jev picks from options that can actually run now.** `offeredLanes(catalogue)` in `scripts/jev-controller.ts` builds
   the list from what this person has (their paired device, bots, coding, CRM, memory, pages, built-in answers, brain,
   plus `ask`). A choice outside the list is `rejected`, recorded and never reinterpreted. Below confidence 0.6
   (`CONTROLLER_ACT`) the person gets one clarifying question.
4. **Jev never writes arguments.** The person's words, the page's record ids and the target device stay data the
   executors receive unchanged.
5. **Existing jobs keep their route and their pins.** An explicit account or model in the words becomes a structured pin
   (`scripts/jev-pins.ts`), saved on the job as `spec.builderPin`; retries and the automatic account fallback never move
   it. An account the server does not have is refused by name with the ones it has. A pin never carries to the next request.
6. **Fallbacks and cached decisions are labelled truthfully.** A decision's `source` is `jev`, `rules`, `fallback`,
   `context` or `registry`. When Jev is out (no key, timeout, error, unreadable reply) only supported, safe exact actions
   run, marked `fallback` with the reason on the step and a job receipt; everything else gets the plain outage line
   (`jevOutageLine`). No language model is substituted as router. A cached decision is marked `cached` with the original
   call's request id and its age; only the decision is reused, the action runs again and permissions are checked again.
7. **Completion requires an observed result.** Every executor returns `verified: true | false | null`; `null` means no
   check was possible and success is not claimed. A coding job is complete only when the done gate passes for its exact
   head sha (`scripts/coding/gate.ts`).
8. **The hub is never someone else's fallback device.** Device actions resolve through `resolveTarget` to the requester's
   own device (`scripts/devices/route.ts`).

## Request flow

```text
typed / spoken words (+ page context, + eventId)
  -> identity gate: verified principal                      scripts/identity/gate.ts, principal.ts
  -> POST /__operator/screen/command                        scripts/jarvis-command/route.ts
  -> conversation-aware front: event dedupe, thread links   scripts/jarvis-command/linked-run.ts, threads.ts
  -> command service                                        scripts/jarvis-command/service.ts
       hard refusals in code (money, banks, secrets)
       Stop / pending answer: immediate
       constraints: named device or bot, pin, page reference
       Jev: one bounded decision over the offered lanes     scripts/jev-controller.ts -> scripts/jev-client.ts
       exact rules fill the lane                            scripts/jarvis-command/plan.ts, words.ts, context.ts
  -> a Job with targetDeviceId                              scripts/jobs/service.ts
  -> executor: companion dispatch | bot computer | coding harness | CRM operation | memory | answer | brain
  -> observed outcome, steps and receipts on the job
  -> one line back to the same Jarvis conversation          scripts/jarvis-command/threads.ts, thread-notify.ts
```

## Module map

### Jev

| File | Role |
|---|---|
| `scripts/jev-controller.ts` | The controller decision: catalogue, offered lanes, batched typed questions, validation, decision cache (256 entries, 30 minutes), outage line |
| `scripts/jev-client.ts` | The only Jev client. One endpoint, model id from the catalogue (`typesafe/jev-latest`), a timeout budget and retry count per surface (`JEV_SURFACES`; `command.controller` is 1,500 ms with one retry), a router receipt per decision |
| `scripts/jev-pins.ts` | Explicit account and model pins read from the words; pure |
| `scripts/jev-router.ts`, `scripts/jev-command.ts` | The older voice-turn router and the hub's Jarvis entry (Jev decision, lane, executor, fresh check). Still used beneath the command service |
| `scripts/model-router/*` | Model catalogue, routing, health and receipts for delegated language-model work |

### Jarvis command path (`scripts/jarvis-command/`)

| File | Role |
|---|---|
| `service.ts` | The one path typed and spoken commands take. Refusals, Stop, dedupe, Jev-first routing, device resolution, job creation, cancel and attach |
| `route.ts` | HTTP for `/screen/command`, `/attach`, `/cancel`, `/thread`, `/thread/say`; body validation |
| `contracts.ts` | Shared types for server, companion and UI: `CommandBody`, `CommandStreamEvent`, `CommandDoneEvent`, `JevDecision`, executors, page context |
| `linked-run.ts` | Conversation-aware front: event-id dedupe, follow-ups, linking jobs to the person's thread, bot scope |
| `threads.ts` | Links jobs to a durable conversation and appends result entries as jobs change state |
| `thread-notify.ts` | Sends an appended entry to the person's `/__events` stream and the one spoken line |
| `plan.ts` | Deterministic command shapes whose arguments code can fill exactly; pure |
| `words.ts` | Which spoken requests go to the one command entry |
| `context.ts` | Resolves "this", "that" against the page context sent with the command; never used for identity or permission |
| `live.ts` | The service's wiring on the hub, built once per server |
| `coding.ts`, `crm.ts`, `leads.ts`, `business.ts`, `quotes.ts`, `answers.ts`, `receptionist.ts`, `continuation.ts`, `recent-targets.ts`, `registry.ts`, `thresholds.ts` | Lane adapters and helpers |

### Coding harness (`scripts/coding/`)

| File | Role |
|---|---|
| `voice.ts` | Jarvis's coding phrases answered by rules before any model; per-person state |
| `command-entry.ts` | One facade the command service calls for typed and spoken coding turns |
| `shaper.ts` | A request becomes a bounded, unconfirmed TaskSpec or one clarifying question |
| `orchestrator.ts` | Runs roles, resumes, fallbacks, cancel and interrupt; keeps pinned builders where they are |
| `gate.ts` | The done gate: checks pass for the job's exact head sha; never trusts an agent's claim |
| `worktree.ts` | Worktree manager; the canonical checkout is read-only to the harness |
| `registry.ts` | The owner-edited repo registry (`<data>/coding/repos.json`): the only source of repos, branches and runnable commands |
| `store.ts`, `accounts.ts`, `role-choice.ts`, `receipts.ts`, `routes.ts`, `plugin.ts`, `runners/*` | Job store (SQLite, one writer), account selection, automatic role choice, usage receipts, HTTP, mount, the Claude/Codex/router runners |

### Jobs and approvals

| Path | Role |
|---|---|
| `scripts/jobs/service.ts`, `types.ts`, `runtime.ts` | Job and step history, cancellation (aborts the executor's signal), recovery after a restart (a running job becomes `unknown`/`interrupted`, never re-run), `byRequest` lookup used for idempotency |
| `scripts/jobs/routes.ts`, `plugin.ts` | `/__jobs` and `/__approvals` |
| `scripts/jobs/mirror-run-log.ts` | Mirrors screen-run steps into job steps |
| `scripts/approvals/*` | Approval service, evidence rules, principals' public view |

### Identity (`scripts/identity/`)

| File | Role |
|---|---|
| `principal.ts` | `resolvePrincipal`: the only function that says who is behind a request; `authorise` |
| `gate.ts` | Runs before every route: origin checks, `/__token`, route class enforcement, the pairing page |
| `routes.ts` | The route table: `shared`, `local-owner`, `self`; unlisted is `local-owner`. Mirrored in `docs/IDENTITY-ROUTES.md` and checked by a test |
| `server-role.ts` | What a confirmed founder session may use on a headless hub, and the console-only set |
| `local-owner-token.ts`, `pair-code.ts`, `confirm-browser.ts`, `serve-peer.ts`, `operator-sites.ts`, `role-matrix.ts` | Local-owner proof, pairing codes, browser confirmation, the Tailscale Serve peer check, server-work rule, the role matrix |
| `scripts/cloud/hub-role.ts`, `scripts/cloud/data-dir.ts` | `MU_HUB_ROLE` (`pc`, `cloud`, `server`) and `MU_DATA_DIR` |

### Devices, computers, agents

| Path | Role |
|---|---|
| `scripts/devices/*` | Pairing, sessions, the device registry and presence, `resolveTarget` (`route.ts`), the dispatcher that queues a command for exactly one companion (`dispatch.ts`), the store (`<data>/devices.json`) |
| `companion/*` | The companion that runs on a person's PC: connects out over Tailscale, long-polls, runs only allow-listed executors (`executors.ts`). `companion/linux/*` is the companion of a shared bot computer |
| `scripts/computers/*` | Shared bot computers: lifecycle through a provisioning adapter (`wsl-local.ts`, `vps-ssh.ts`, `docker.ts`), the control lease (`lease.ts`), the viewer (`novnc.ts`, `viewer.ts`), the terminal (`terminal.ts`), the hub-side goal loop (`goal-loop.ts`), the companion bridge (`bridge.ts`), saved results (`artifacts.ts`), routes and mount |
| `deploy/computers/*` | The Linux control script and build of the bot-computer companion |
| `scripts/agents/*` | The Agents workspace: bot records (`store.ts`, `<data>/agents/bots.json`), readiness, a bot's tasks, files and conversation (`service.ts`), bot-scoped Jarvis (`jarvis.ts`), routines linked to bots (`automation.ts`), routes and mount |

### Memory, CRM, events

| Path | Role |
|---|---|
| `scripts/memory/*` | One shared memory pool over the vault and Hindsight: `api.ts`, the capture guard (`guard.ts`), the single-writer rule (`writer.ts`), the agents' MCP endpoint (`mcp.ts`), the only Hindsight client (`hindsight-client.ts`), voice turns, settings, plugin |
| `scripts/hindsight/*` | Scripts that run and back up the local Hindsight service |
| `scripts/crm/*` | The CRM in `<data>/crm.sqlite`: store, typed operation registry (`ops.ts`), runtime, migrations, redaction for unconfirmed callers, attachments, workflows, the HTTP adapter (`plugin.ts`), the hub integration that publishes changes |
| `scripts/events/*` | The activity stream (`/__events`, SSE), scoped per person |
| `scripts/triggers/*` | Routines and triggers on the existing scheduler |

### Voice

| Path | Role |
|---|---|
| `scripts/free-voice.ts` | The turn-based Jarvis voice engine; calls the same tools, including `jarvis_command` |
| `src/components/operator/voice-companion.tsx`, `src/lib/free-voice-client.ts` | The browser side (a shared seam file) |

### Gateway

`scripts/gateway/*` is **not present on this branch**. Dot's gateway lives on branch `gw/dot-gateway-20261002` in the
lead's repository. On this branch "gateway" in identity code means the Hermes Telegram gateway and its relay bearer
(`gatewayBearerOk` in `scripts/identity/principal.ts`, route `/__away`).

### Deployment

| Path | Role |
|---|---|
| `deploy/windows/*` | The always-on Windows hub: supervisor, backup, WSL keep-alive, SearXNG, health check, installer, the release script, vault autocommit (`deploy/windows/vault/`) |
| `deploy/bin/*`, `deploy/systemd/*`, `deploy/env/*.example`, `deploy/tailscale/serve.sh` | The Linux (cloud role) path: install, rollout, rollback, smoke, units, example env files |
| `scripts/cloud/*` | Backup and restore CLI, release packaging, health, hub role |
| `scripts/ops/*` | Host health facts and alert evaluation |

## Frontend entry points

`src/routes/*` (TanStack Router; `src/routeTree.gen.ts` is generated, regenerate it rather than editing),
`src/components/ds` and `src/components/ui` (design system), `src/components/shell` (app shell),
`src/components/calm` (calm page primitives), page components under `src/components/<area>/`. The UI system notes are
`docs/programme-20261001/R11-UI-SYSTEM.md`.
