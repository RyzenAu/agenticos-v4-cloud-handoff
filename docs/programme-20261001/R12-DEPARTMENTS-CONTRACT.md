# R12 Departments contract (frontend → backend)

Owner of this file: Claude (frontend, branch `r12/ui-structure-20261004`). Reader: Dot (backend). 4 Oct 2026.

The Departments section (`/departments`, `/departments/$dept`), Home's work lists and the Jarvis work cards are a **frontend view over existing data**. This file lists what they read today, what they render when a field is missing, and the exact shapes they need next. Field names below are the ones `src/lib/departments.ts` (`parseJourney`, `journeyHandoffs`) and `src/components/departments/use-departments.ts` already parse, so a backend that sends them is displayed with no frontend change.

It matches the backend task `handoff/tasks/LEAD-JOURNEY-20261004.md` ("the first cross-department journey"): a journey is the durable workflow record, and **each journey step is a hand-off** with one accountable owner, inputs, an expected output, dependencies, an acknowledgement and a completion or failure record. There is no separate hand-off record.

## 1. What the frontend reads today (no backend change needed)

| Route | Fields used | For |
|---|---|---|
| `GET /__agents/bots` | `id, name, purpose, lifecycle, computer, coding, readiness` | agents per department, "Open conversation" (`/agents/workspace/<id>?tab=chat`) |
| `GET /__agents/bots/:id/tasks?limit=50` | `id, kind, title, state, phase, startedAt, endedAt, blocker, resultArtifact, subjects` (+ the coding fields `serviceTask` already reads) | the work queue, Home's attention and active lists, inferred hand-offs |
| `GET /__agents/bots/:id/files` | `artifact, jobId, title, summary, createdAt, source, subjects` | saved results |
| `GET /__jobs?limit=100` | `id, title, state, bot, subjects, stepCount, createdAt, updatedAt` | Jarvis work cards: who the job was handed to and its **real** step count |
| `GET /__crm/record?ref=crm:<kind>:<id>` | `data.name` / `data.title` | the name on a task's CRM link |
| conversation entries (`/__operator/conversations`, `job:<id>:<state>` vias) | as today | Jarvis thread, grouped per job |

Department of a bot: a typed frontend table (`BOT_DEPARTMENT` in `src/lib/departments.ts`: research → Research, builder → Engineering, outreach → Sales, designer → Design), then a guess from the bot's id/name, then Operations.

Hand-offs today: **inferred**. A task of department B is shown as handed over from department A when an earlier task of A is about the same CRM record (`subjects` overlap) and had **finished** before B's task started. Every inferred step says so on screen ("Inferred: same client record…"). When a journey exists for the receiving task, the journey's step replaces the inference.

## 2. Needed: journeys (D2) — `GET /__journeys`, `GET /__journeys/<id>`

Feature-detected: **404 / 405 / 501 means "not on this hub"** and the views fall back to section 1. Any other non-200, or a body without `journeys`, is shown as "couldn't read", never as "none".

```ts
// GET /__journeys?conversationId=<id>&subject=<crm ref>   (both optional; this person's journeys, newest first)
// -> 200 { journeys: Journey[] }
// GET /__journeys/<id> -> 200 { journey: Journey } | 404

type DepartmentId = "sales" | "design" | "engineering" | "finance" | "research" | "operations";
type Party = { department: DepartmentId | "jarvis"; agent: string | null };   // agent = bot id, when one bot is accountable
type JourneyState = "queued" | "running" | "waiting" | "failed" | "completed" | "stopped";
type Output = { label: string; href: string };                                  // href MUST be an in-app path ("/__computers/artifacts/<job>", "/crm?ref=…", "/coding/<id>?tab=changes"); anything else is dropped

type Journey = {
  id: string;
  kind: string;                    // "lead-to-proposal"
  title: string;                   // "Lead to proposal: <company name>"
  conversationId: string | null;   // the ORIGINATING conversation (the Jarvis thread renders the journey there)
  requestedBy: string | null;      // person id
  subjects: string[];              // "crm:company:<id>", "crm:deal:<id>"
  state: JourneyState;
  createdAt: number;               // epoch ms
  updatedAt: number;
  decision?: unknown;              // Jev's typed decision record; shown folded later, not parsed now
  steps: JourneyStep[];            // ordered by `index`
};

type JourneyStep = {
  id: string;                      // stable within the journey: "research" | "concept" | "proposal" | "report"
  index: number;                   // 0-based order
  title: string;                   // imperative, sentence case: "Make a homepage concept"
  owner: Party;                    // the ONE accountable owner (required; a step without it is dropped)
  from: Party | null;              // who handed it over; null = the previous step's owner (the first step: Jarvis)
  inputs: { label: string; ref: string | null }[];   // ref: a CRM ref, "step:<id>", or an artifact/job ref
  expectedOutput: string;          // one line: "A concept preview linked to the CRM record"
  dependsOn: string[];             // step ids
  state: JourneyState;             // waiting = waiting on the founder
  acknowledgedAt: number | null;   // when the owner accepted the hand-off
  startedAt: number | null;
  jobId: string | null;            // the job (computer or coding) the step runs as; links the step to its task row and thread entries
  completion: { at: number; jobId: string | null; summary: string; outputs: Output[] } | null;
  failure: { at: number; jobId: string | null; reason: string; saved: Output[] } | null;   // `saved` = what was kept before it failed
  waitingFor: { question: string } | null;   // the one question asked in the conversation ("Use the approved website catalogue offer for this draft?")
};
```

States and how they render (shared status language, R12-UI-SYSTEM.md): `queued` → Queued (clock), `running` → Running (spinner), `waiting` → Needs you (hand), `failed` → Failed (cross, the only red), `completed` → Completed (check), `stopped` → Stopped (grey). A journey's own state follows its steps (a failed step ends it as `failed`; Stop ends it as `stopped`).

Where it shows:
- **Jarvis**: in the originating conversation (`conversationId`), at the first thread entry of any job a step ran as; those jobs are not repeated as separate cards. Each step is a line "Research → Design: make a homepage concept" with its state, its output links, its failure reason or its question.
- **Department**: "Journeys this department is part of" (any step whose `owner.department` is it), hand-offs in (`owner` = this department) and out (`from` = this department).
- **Home**: a running/queued journey is one Active work row ("Step 2 of 4: Make a homepage concept"); a `waiting` or `failed` step is a Needs your attention row.

Stop: through the existing cancel path (not a new route). Identity: classify both routes as `shared` reads (any confirmed founder) in `scripts/identity/routes.ts`; a bare tailnet login gets 403 like `/__jobs`.

Live updates (optional, D5): an `/__events` topic `journey` (type `changed`, data `{ id }`) lets the views refetch at once; without it they poll every 20 s (6 s when the stream is down) and stop polling while the route is absent.

## 3. Needed: smaller fields

| Id | Where | Field | Why |
|---|---|---|---|
| D1 | `GET /__agents/bots`, `PATCH /__agents/bots/:id` | `department?: DepartmentId` | replaces the frontend table; set in Setup. Until then the table decides. |
| D3 | job rows (`/__jobs`, `/__agents/bots/:id/tasks`) | `journeyId?: string`, `stepId?: string` | a queue row opens its journey step without matching on `jobId` |
| D4 | `/__agents/bots/:id/files` | `createdAt` as epoch ms (it is), and the same `subjects` on coding outputs | results sort and link to the CRM record consistently |
| D6 | computer job end note | real step count | production 4 Oct: the research job `92a914fa` ran 31 steps while its end note said "Done on research: 1 step, each checked" (`scripts/computers/service.ts` counts the delegated workflow as one step). The UI no longer shows that sentence's count (it uses `stepCount` from `/__jobs`), but the note itself still says 1. |

## 4. Spec terms → fields (LEAD-JOURNEY-20261004)

| Spec says | Field |
|---|---|
| durable journey record; originating conversation | `Journey.id`, `Journey.conversationId` |
| requestedBy, subjects | `requestedBy`, `subjects` |
| one accountable owner (department/agent) | `JourneyStep.owner` |
| inputs | `JourneyStep.inputs` |
| expected output | `JourneyStep.expectedOutput` |
| dependencies | `JourneyStep.dependsOn` |
| acknowledgement time | `JourneyStep.acknowledgedAt` |
| completion or failure record (with the job id it ran as) | `JourneyStep.completion` / `JourneyStep.failure` (each with `jobId`), and `JourneyStep.jobId` |
| asks ONCE in the conversation | `JourneyStep.state = "waiting"` + `waitingFor.question` |
| truthful states queued, running, waiting, failed, completed (+ Stop) | `JourneyState` |
| a failed step ends the journey with what was saved | `Journey.state = "failed"`, `failure.saved` |

## 5. Synthetic fixture

`scripts/r12-ui-fixtures.ts` (`journeyFixture`) builds one `lead-to-proposal` journey in exactly this shape from the seeded synthetic jobs and serves it to the browser for `/__journeys` (Playwright route), so the screenshots and `scripts/r12-ui-verify.ts` show it. Nothing on the hub is changed by it.

## Business pages (R12 rollout, 4 Oct)

The rollout (`r12/ui-rollout-20261004`) applied the page anatomy to Work, CRM, Leads, Finance, Receptionist, Inbox (+ triage),
Calendar, Agents workspace, Activity, Studio, Design, Memory, System and Settings using only data the hub already serves. No wire
contract changed (`jarvis-command.ts`, `typed-send.ts`, `commands/*`, the `*-client.ts` files are untouched). Records now open in a
drawer held in the URL; these are the places where a backend field would make that exact rather than best-effort:

| Id | Where | Needed | Why |
|---|---|---|---|
| B1 | `GET /__receptionist` | `launch: { onHold: boolean, reason?: string }` | The hold ("Receptionist launch is on hold.") is a frontend constant in `receptionist-destination.tsx`; while on hold the page hides the next-step bar. The flag should come from the server so lifting the hold needs no UI change. |
| B2 | Calendar | `GET /__operator/calendar/:id` | `/calendar?event=<id>` opens only events in the loaded window; a link to an older or not-yet-synced event shows nothing. |
| B3 | Agents workspace | a task lookup by id on `/__agents/bots/:id/tasks` (or D3's `journeyId`/`stepId` on job rows) | `?task=<id>` resolves only within the bot's recent task list. |
| B4 | Work | `Approval.detailHref` distinct from `href` (optional) | The decision drawer shows `detail`/`progress` and an "Open details" link to `href`; some `href`s are the page the decision is about, not its evidence. |
| B5 | Inbox triage | none (confirmed) | Row `messageId` equals the archive id, so the triage drawer's "Open inbox to reply" and the Inbox drawer (`/mail-archive/message?id=`) already line up. |
| B6 | Studio | `thumbUrl` on ledger video items (optional) | The asset drawer previews images through `/__design_file?id=`; a video streams the full file. |
