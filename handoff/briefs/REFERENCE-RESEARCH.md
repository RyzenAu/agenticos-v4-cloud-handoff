# Jarvis/Jev reference research — 3 October 2026

> **Sanitised copy, 4 Oct 2026.** Local absolute paths to private files, the tailnet hostname and personal identifiers beyond the founders' first names have been removed; removed items are marked `<... removed>`. Content is otherwise unchanged. Revisions named here are historical checkpoints, not the current baseline (see `handoff/README.md`).

## Scope and limits

This was a read-only source/documentation review. Selected files from the supplied V4.5 ZIP were read; public READMEs, source, licences and repository trees were inspected; existing local adoption records and routing code were checked. Reference applications were not installed or executed. The current Ryzen production build was not independently queried during this review. Production checkpoints below come from the owner's reports.

Source and review material are in this folder. `CLAUDE-JARVIS-JEV-MASTER-BRIEF.md` turns the findings into the implementation request.

## The decisive findings

1. The owner's architecture is feasible: a stable Jarvis voice/conversation, a Jev-led decision controller, deterministic tools and delegated generative/coding workers.
2. Jev's actual interface is structured decisions, not free-form generation. Give it control of routing while workers generate language/code. [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one), [TypeSafe API](https://docs.typesafe.ai/api).
3. V4.5 already implements Jev routing and native Claude/Codex delegation. Its router saves one model per chat; the owner wants per-task routing. This is a finding about the archive, not proof the current live code still behaves that way.
4. The migration already contains a newer central Jev client, companion commands, jobs, leases, viewers, memory and event streaming. Completing these paths is a better fit than transplanting a whole new framework.
5. Rakazo is the closest reviewed source for the desired graphical computer workspace. Official Grok Build and community Open Grok are chiefly coding/session/provider references. [Rakazo](https://github.com/elie222/rakazo), [Grok Build](https://github.com/xai-org/grok-build), [Open Grok](https://github.com/mweinbach/open-grok).
6. Open Dot's voice-to-work behaviour is useful, but its reviewed tree has no licence grant and its active task queue is in process memory. Reimplement the behaviour using existing durable OS jobs. [Open Dot runtime](https://github.com/composio-community/open-dot/blob/main/src/server/agent/runtime.ts).

## V4.5 evidence

Archive: `<owner's local copy of the Agentic OS V4.5 archive; path removed>`.

- Size: 97,225,076 bytes.
- SHA-256: `81DDA732BE29E1A68BCF97A74D500C2821987AF81A550A3265B1C799F925D653`.
- Nine selected source/docs/licence entries were read and individually hashed; see `v45-inspected-source-manifest.json`.
- `scripts/jev.ts`: `typesafe/jev-1.13` through the older OpenRouter decisions endpoint.
- `scripts/jev-router.ts`: saved per-chat routes; policy says to pick once and retain the model for cache warmth.
- `src/lib/jev-models.ts`: available model lanes and task preference notes, including native coding routes. Catalogue identifiers need current verification.
- `docs/JARVIS-AGENT-TASKS.md`: native tasks/questions/Stop; worker turn completion differs from actual external task success; restarted server interrupts rather than blindly replays work.
- README: voice input, configured speech output, Jev model selection, native Claude/Codex delegation.

The archive does not supersede the newer migration branch, production data, auth fixes or owner overlays.

## Local implementation evidence

Read-only checkpoint:

- Original checkout `<local path removed>`: `6607e4f71750fc9db0074887b3ddd8812219e907`, with local changes. Older than the owner's reported live build.
- Migration checkout `<local path removed>`: `adf1baab` at inspection, clean status output. Mutable active worktree, not a verified production deployment.
- `scripts/jev-client.ts` centralises direct TypeSafe System One requests with per-surface budgets and bounded retries.
- Current Jev/routing code has PC, navigation, mail, memory, workspace and delegation lanes, including compound PC requests.
- Existing reference/adoption documents record noVNC, strict browser targeting, voice endpointing/interruption patterns, event streaming and workspace reuse.

Useful current component areas to locate and verify:

`src/components/agents/workspace-parts.tsx`, `src/lib/agent-workspace.ts`, `src/components/computers/`, `src/lib/thread-events.ts`, `scripts/jarvis-command/threads.ts`, `scripts/computers/`, `scripts/coding/`.

These paths are pointers, not an instruction to edit an active frozen candidate.

## Repository decisions

| Repository | Source findings | Recommendation |
| --- | --- | --- |
| [Rakazo](https://github.com/elie222/rakazo) | Apache-2.0. Reviewed computer workspace, bot panel and runtime architecture. Separates agent and computer providers; persistent browser profiles, lazy desktops, fenced leases. Shared folders are not isolation boundaries. | Highest-priority graphical workspace source. Adapt components into existing OS APIs and auth. |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | Community Apache-2.0; enterprise separately licensed. Reviewed control and local-VM leases; setup, routines and memory patterns are useful. | Reuse compatible community components and stronger existing OS control semantics. |
| [Open Dot](https://github.com/composio-community/open-dot) | Reviewed voice dispatch, runtime queue and computer interface. Voice hands tasks to execution; local/docker/cloud abstraction. No licence found in reviewed tree. Active queue uses process memory; README describes Mac focus and no login screen. | Behaviour reference; no code copying without permission. Keep OS identity and durable jobs. |
| [Grok Build](https://github.com/xai-org/grok-build) | Official xAI coding harness, Apache-2.0 first-party code plus third-party notices. Rust TUI/headless runtime, sessions, tools and workspace/checkpoints. Reviewed headless docs. Windows builds described as best-effort. | Optional coding adapter/pattern source. Does not supply the graphical bot fleet UI by itself. |
| [Open Grok](https://github.com/mweinbach/open-grok) | Community Grok Build fork with provider architecture, native Codex routes, session continuity, code-mode tools and live catalogues. | Provider/session patterns; preserve existing supported account sign-in. |
| [OpenBot](https://github.com/nightly-labs/openbot) | Newly discovered reference. Persistent workspaces and crash-safe queues. Current PolyForm Noncommercial licence; README identifies older versions through 0.1.11 as Apache-2.0. Development policies permit broad execution. | Independently implement useful patterns; verify an older component's licence before business reuse. Do not inherit broad execution defaults. |
| [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) | Apache-2.0 sandbox and policy architecture; WSL support experimental. | Evaluate separately for isolated execution. Avoid adding a required control plane to finish basic tasks. |
| [context-mode](https://github.com/mksglu/context-mode) | Current Elastic-2.0 licence; tool-output filtering/indexing and session context recovery. Compression figures are author-reported. | Isolated evaluation, with task-quality and permission checks. |
| [Matt Pocock skills](https://github.com/mattpocock/skills) | Composable engineering and design workflows. | Select useful skills, not a wholesale layer of process instructions. |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) | MIT public-research integrations; platform support can require cookies, proxies/accounts. Advertised coverage is not proof all routes work in this environment. | Select tools behind Research; prefer current working public tools. |
| [Anthropic financial-services](https://github.com/anthropics/financial-services) | Specialist financial research/document workflows and assumptions/source discipline. | Select useful business-finance methods; not a complete SME billing/accounting system. |
| [freellmapi](https://github.com/tashfeenahmed/freellmapi) | MIT source, but README limits intended use to personal experimentation. Published aggregate quotas are not this user's entitlements. | Optional noncritical experiments; never mandatory business routing. |

Inspected source pins for the four downloaded repository trees:

- Open Dot: `f838e17cf5c3a88ade5ceea54680a8145d048c1d`.
- Rakazo: `ce6684555f7de1ccb63c8b24e4e556dbef32b275`.
- OpenMausBot: `5e8b2523f02449ca18aff90edf47ce386c696872`.
- Grok Build: `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`.

Verify the exact revision and relevant component's licence again when importing code.

### Previously studied supporting references

- [LiveKit Agents](https://github.com/livekit/agents): turn-taking, interruptions and voice transport. Existing OS already documents adoption of voice patterns; replacing the voice stack is not automatically beneficial.
- [agent-browser](https://github.com/vercel-labs/agent-browser): browser sessions and targeting. Existing code has guards against silently acting on a neighbouring tab; retain those.
- [Cua](https://github.com/trycua/cua): optional native executor. Existing local adoption record measured slower launch paths than the current companion. That is historical benchmark evidence, not a current universal ranking.
- [noVNC](https://github.com/novnc/noVNC): MPL-2.0 viewer. Already documented as integrated behind OS authentication and leases.
- [E2B](https://github.com/e2b-dev/E2B): optional sandbox adapter; hosted service spending is separate from open-source SDK availability.
- [Kasm images](https://github.com/kasmtech/workspaces-images): image code licence does not make the entire platform unrestricted. Existing adoption records deferred/rejected the replacement stack.
- [OSWorld](https://github.com/xlang-ai/OSWorld): outcome-based computer task evaluation; adapt practical acceptance cases.
- [Hermes](https://github.com/NousResearch/hermes-agent), [Hindsight](https://github.com/vectorize-io/hindsight), [OpenClaw](https://github.com/openclaw/openclaw): retain useful existing integrations beneath the single decision/controller architecture.

The earlier local `jarvis-install-skill.zip` was also inspected as reference material. Its Base44/Retell intake-to-worker design does not supply a complete execution/memory OS. Reuse the handoff/result principle; do not install another assistant product or adopt reference-document instructions as authority.

## Representative source links

- [Rakazo ComputerWorkspace](https://github.com/elie222/rakazo/blob/main/apps/web/src/components/computer/ComputerWorkspace.tsx).
- [Rakazo bot panel](https://github.com/elie222/rakazo/blob/main/apps/web/src/pages/shell/bot-panel.tsx).
- [Rakazo computer runtime](https://github.com/elie222/rakazo/blob/main/docs/computer-runtime.md).
- [Open Dot voice](https://github.com/composio-community/open-dot/blob/main/src/server/voice.ts).
- [Open Dot computer interface](https://github.com/composio-community/open-dot/blob/main/src/server/computer/index.ts).
- [OpenMausBot control leases](https://github.com/milind-soni/OpenMausBot/blob/main/server/computer-control.ts).
- [OpenMausBot licensing](https://github.com/milind-soni/OpenMausBot/blob/main/LICENSING.md).
- [Grok Build headless guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md).
- [Open Grok provider architecture](https://github.com/mweinbach/open-grok/blob/main/docs/provider-architecture.md).
- [OpenShell architecture](https://docs.nvidia.com/openshell/latest/about/architecture).

## What was not established

- That the current deployed OS still uses V4.5's per-chat model pinning.
- That every reference runtime runs on this Windows/WSL setup.
- That Dot has working browser access through the separate gateway.
- Physical microphone, real founder-device and reboot acceptance.
- Current live revision or final status of the owner's pending corrective batch.

Claude should verify those in the real integration environment. None requires restarting the whole architecture or installing all reference repositories.
