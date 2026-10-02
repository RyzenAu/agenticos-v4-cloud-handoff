# Unified Agents workspace: build plan and API contract (2 Oct 2026)

Order: Ryzen cutover first, then this. Ownership: `AGENTS-WORKSPACE-OWNERSHIP.md`. CRM contracts: `AGENTS-CRM-CONTRACTS.md`.
References: `AGENTS-WORKSPACE-REFERENCES.md` (Open Dot = patterns only; OpenMausBot = patterns, Apache-2.0; OpenShell rejected as runtime).

## Experience

Jarvis → Agents (one drilldown under Jarvis). A compact bot selector (Research, Builder; more later) and the bot's status line
("Ready", "Working on …", "Needs you", "Offline: <why>"). One command box (type or speak) under every tab. Tabs: **Chat**, **Computer**,
**Tasks & Files**, **Setup**. Everything a bot does lands in its own conversation; the person never has to change page to follow a task.

## Bot model (new, server)

```ts
type BotId = string;                 // "research", "builder", lowercase slug
type Bot = {
  id: BotId; name: string; purpose: string; instructions: string;      // instructions: appended to the bot's job briefs
  computer: string | null;           // shared computer name (scripts/computers store); null = no computer
  coding: { enabled: boolean; accountSlot: string | null; model: string | null }; // Builder: Claude/Codex coding jobs
  modelPreference: { route: "auto" | "free-only" | string };          // existing router routes only
  skills: string[];                  // existing skill names (scripts/jarvis-skills, skills/)
  routines: string[];                // existing trigger/routine ids
  memory: { recall: boolean; saveResults: boolean };                  // existing shared pool; no new memory
  createdAt: number; updatedAt: number; rev: number;                  // rev for honest concurrent-edit refusal
};
type BotReadiness = { state: "ready" | "working" | "needs-you" | "offline" | "unconfigured"; reasons: string[] }; // derived, never stored
```
Store: `<MU_DATA_DIR>/agents/bots.json` (atomic write, rev check). Seeded once with Research (computer `research`) and Builder (computer
`builder`, coding enabled). Readiness is computed from the real computer state, the coding account readiness (accounts service) and the router.

## API (`/__agents`, shared at the gate; writes need a confirmed human session in server role)

| Method | Path | Result |
|---|---|---|
| GET | `/__agents/bots` | `{ bots: (Bot & { readiness })[] }` |
| GET | `/__agents/bots/:id` | one bot + readiness + `conversationId` |
| PATCH | `/__agents/bots/:id` | `{ rev, ...fields }` → updated bot; 409 on stale rev; validation per field (computer exists, account slot exists, skill/routine ids exist) |
| GET | `/__agents/bots/:id/tasks?limit&before` | merged list: computer jobs (`/__jobs` with `targetDeviceId`=bot computer) + coding jobs where bot = builder; each `{ id, kind, title, state, startedAt, endedAt, account?, model?, blocker?, resultArtifact?, review?, tests? }` |
| GET | `/__agents/bots/:id/files` | saved results (`/__computers/artifacts` for this bot's computer) + coding job outputs `{ artifact, title, jobId, createdAt, files[] }` |
| GET | `/__agents/bots/:id/thread?after` | the bot conversation entries (wraps `/screen/command/thread?conversation=`) |

Conversation id per person and bot: `agent:<personId>:<botId>` (deterministic; created with `ensureThread`). Commands from the workspace
(typed or spoken) call the existing Jarvis command with `{ conversationId, target: { bot } }`. A spoken "Ask Research to…" from anywhere also
routes to `agent:<person>:research`; a request with no bot named stays in the default Jarvis thread. Job progress/completion for a job created
from a bot conversation is linked to THAT thread by the existing `threads.link`.

Jobs may carry `subjects: string[]` (CRM refs, see contracts) and `bot: BotId`.

## Builders (file ownership; one owner per file)

| Builder | Scope | Owns |
|---|---|---|
| B1 backend | bot store + `/__agents` + readiness; per-bot conversation id and Jarvis routing ("Ask Research…", "Have Builder… on Claude Max 2"); `bot`/`subjects` on job create; `/__jobs?targetDevice=&subject=` filters; artifact list read; identity rows | `scripts/agents/**` (new), `scripts/jarvis-command/**` changes, `scripts/conversations.ts`, `scripts/jobs/routes.ts` (filter only), `scripts/computers/artifacts.ts` (list only), `scripts/identity/routes.ts` + docs rows |
| B2 chat | lean `BotChat` (transcript, composer, voice button, live fold, progress, blockers with recovery, results with "Open result"/"Open job"/"Show computer"); no edits to `floating-oracle.tsx` beyond extracting shared pure helpers if needed | `src/components/agents/chat/**`, `src/lib/agent-chat.ts`, voice wiring in `src/lib/jarvis-command.ts` (conversationId option already exists) and `voice-companion.tsx` (pass the active bot's conversationId) |
| B3 shell + computer + tasks | route `src/routes/agents.workspace.tsx` (+ `$botId`), bot selector/status, tabs, Computer tab (move `LiveViewer`/`PreviewPanel` into `src/components/agents/computer/**`, keep `/computers` working by importing them), Tasks & Files tab (cancel/retry/resume via existing APIs), the ONE drilldown line in `destinations.ts`, deep links from Computers/Coding/Activity | `src/routes/agents.workspace*.tsx`, `src/components/agents/workspace/**`, `src/components/agents/computer/**`, `src/components/agents/tasks/**`, `src/components/computers/computers-page.tsx` (imports only), `destinations.ts` (one line) |
| B4 setup | Setup tab: purpose, instructions, computer assignment, model/account preference, skills, routines, memory behaviour; each control persists via PATCH with rev, explains its effect in one line, and is disabled with a reason when not applicable | `src/components/agents/setup/**`, `src/lib/agent-bots.ts` (client) |
| R reviewer | independent review of the combined change; real-browser checks | read-only |

## Done when (owner's acceptance)

Real journey on the Ryzen hub through the UI: spoken request → bot conversation → job execution → live computer → take over → return to
agent → saved result opened from the conversation; plus typed path, Builder coding job in Tasks, Stop prevents later steps, restart/reconnect
no replay, personal desktop ownership, both founders on shared bots, results survive restart, offline/provider failure with recovery, every
control drives a real service, CRM contract test on synthetic records. Desktop, tablet and mobile screenshots.
