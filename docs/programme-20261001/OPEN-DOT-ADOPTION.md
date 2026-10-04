# Open Dot adoption (programme 20261001)

Reference: `composio-community/open-dot`, read at commit `f838e17cf5c3a88ade5ceea54680a8145d048c1d` (local clone `D:/prog-scratch/open-dot`, read only).
Licence: GitHub reports none; the owner treats it as open source (README and `electron/package.json` say "open source", no licence file). The lead's rule (1 Oct):
adapted code may be used where it genuinely fits, with the header "Adapted from composio-community/open-dot @ f838e17 (<path>), described by its authors as open
source; no licence file at that commit", an entry in `THIRD-PARTY-NOTICES.md`, and an exact adapted-vs-independent record here.

Other builders append their own sections below. This file holds the **Voice and background work** section (builder V, Sonnet 5.5).

---

## Activity stream (builder S)

**Outcome.** One authenticated server-sent event stream, `GET /__events`, carries job and step updates, agent messages, computer
availability, control-lease changes, approval changes and finished results. The client keeps one connection per browser, and the
polls it makes redundant now run as a slow safety net (or not at all while the stream is healthy).

### Adapted vs independent

| What | Status |
|---|---|
| Idea: one SSE route that sends a full snapshot on connect, then every change, with a keep-alive ping (`src/app/api/events/route.ts`, 33 lines) | Idea only. **No code adapted**, so no entry was added to `THIRD-PARTY-NOTICES.md` |
| Event bus, ring buffer, ids and epochs, replay, scoping, producers, route, caps, client, leader election, hooks | Independent. Open Dot's bus is in-memory with no ids, no replay, no auth and no scope; ours has to survive a restart (snapshot from the durable stores), be per-person, and never run anything |

### Decision: a new `/__events`, not an extension of `/__jobs/events`

`/__jobs/events` is a cursor over one SQLite table (`seq`), unscoped, jobs only. The stream has to span six topics, carry a
per-person scope, replay across topics and survive a hub restart, so it is a separate route registered in
`scripts/identity/routes.ts` as shared (read) / local-owner (write), `docs/IDENTITY-ROUTES.md` and `routes.test.ts` in step. It does
not replace `/__jobs/events`: that stays as the durable log, the fallback when there is no stream, and what the job producer reads
(`JobService.subscribe`, in-process). Job events keep their own `jobSeq` inside the envelope, so the old cursor still lines up.

### Protocol (`scripts/events/bus.ts`, `stream.ts`, `sources.ts`, `plugin.ts`)

* Frames: `hello` (epoch, head, `mode: replay|snapshot`), then either the missed events or one `snapshot`; then unnamed `message`
  events `{id, at, topic, type, final, data}`; `ping` every 15 s (a real event, because EventSource cannot see SSE comments).
* Ids: monotonic per boot, wire form `<epoch>:<n>`. Bounded ring, 500 events. `Last-Event-ID` (header, or `?last=` for a client that
  reconnects by hand): inside the ring and same epoch, replay exactly what was missed; too old, ahead of the head, malformed or
  another epoch (a restart), a fresh `snapshot` built from the durable stores. So no completion is missed, and nothing is replayed that
  the client could not verify.
* Snapshot (also `GET /__events/snapshot`, same auth and scope, used by the safety poll): 20 newest jobs plus `jobsHead`, pending
  approvals, computers, this person's permitted devices.
* Payloads are capped at 16 KB (over: a stub with `truncated`, the client refetches). A consumer that stops reading is dropped
  (512 KB), not buffered. Caps: 8 streams per person, 24 total, then 429.
* **Notifications only.** There is no write path. Nothing in these modules calls anything that creates, runs, cancels or decides a
  job, approval or lease (a test greps for it, and a test replays a finished job three times and checks the store is untouched), so
  replaying an event cannot duplicate work. The client folds events idempotently (job events by the job log's own `jobSeq`).

### Authorisation and scope

* No signed-in person: 401. Not GET: 405. Cross-site or foreign origin: 403. The identity gate classifies the route first
  (`/__events` shared read; a stranger is refused there), then the handler resolves the same principal.
* Shared business events (coding and memory jobs, approvals, shared computers, leases, Jarvis hints) go to both founders.
  Anything about a personal device (jobs of other kinds targeting it, approvals scoped to it, its online/offline) goes only to that
  device's owner, in the live stream, in replay and in the snapshot. Tested with two people on the same hub.
* Lease events are reduced: the viewer's session id never leaves the hub. Job and approval payloads go through `publicView`
  (no `sk1.` session keys). Agent message text is masked by the job store's `maskJobText`.

### Producers (topics)

| Topic | Source | Latency |
|---|---|---|
| `job` (job, step, receipt; `final` on a terminal state) | `JobService.subscribe`, in process | immediate |
| `approval` (every state change; `final` once decided) | `ApprovalService.subscribe` | immediate |
| `lease` | `LeaseManager.subscribe`, reduced, then an immediate computer sample | immediate |
| `computer` | 2 s sampler over `computers.list()`, only what changed (lastSeen and resource excluded) | at most 2 s |
| `device` (online/offline) | 2 s sampler over the registry; the heartbeat TTL (30 s) expires by clock, so presence has no event of its own | offline shows within about 32 s of the last heartbeat |
| `jarvis` (events, timers, status, protocol) | `onChange` in `scripts/jarvis-events.ts` (an event posted, claimed, quiet or call mode changed) and any successful non-GET `/__operator/jarvis/*` | immediate |
| `agent` (message, `final`) | `activityFor(root)?.agentMessage({ agent, text, jobId?, scope?, final? })` | immediate |

Builder V: conversation and job results already arrive as `job` events (steps, receipts, the terminal `final` job event) because they
go through the job store. For a message that is not a job step, call `activityFor(root)?.agentMessage(...)`.

### Client (`src/lib/activity-stream.ts`, `use-activity.ts`)

* `ActivityClient`: one EventSource with its own reconnect. Backoff 1 s, 2 s, 4 s, capped at 30 s, then 50 to 100 % of that
  (jitter), resumes with `?last=`; a watchdog (45 s, three missed pings) declares a silent connection dead.
* **One connection per browser, not per tab.** The dev hub speaks HTTP/1.1, where a browser allows 6 connections per origin, so a
  stream per tab would starve a fourth tab's own requests. `ActivityHub` elects a leader with the Web Locks API; the leader
  relays every message over a `BroadcastChannel`, followers just listen, and a new tab asks the leader for the current snapshot.
  When the leader tab closes its lock is released, the next tab takes over and gets a snapshot. Without Locks or BroadcastChannel a
  tab leads for itself. Measured (PERF-BASELINE.md): Home plus a HUD tab, one open stream; zero after both close.
* Hooks for the screens: `useActivity(handler, topics?)`, `useActivityStatus()`, `useStreamInvalidate(queryKeys, topics, { match })`
  (coalesced refetch), `streamRefetchInterval(safetyMs, legacyMs)` (a react-query `refetchInterval` that is slow only while the
  stream is healthy). Builder W: for Computers, `useStreamInvalidate([["computers"]], ["computer", "lease", "device"])` is already wired
  in `computers-page.tsx` (one line each in the query and the page); use the same two helpers elsewhere.
* Reconnect nudges: a read that gets an answer while the stream is waiting out a backoff (the HUD or the job bridge), the tab
  becoming visible, and the browser going online all call `retryNow()`, at most once per 2 s and only on a fresh answer, never on a state
  change (a first version nudged on every state change and looped against a dead hub; the kill/restart measurement caught it).
* Kill switch: `localStorage["mu-activity-stream"] = "off"` puts every poll back at its old rate (this is also how "before" was measured).

### Polls replaced, and what stayed

| Poll | Before | With a healthy stream | No stream |
|---|---|---|---|
| Jarvis status, events, timers (HUD) | 3 reads every 45 s | refetch on a hint; safety 90 s | 45 s, as before |
| `/__jobs/events` (chip, step log) | 2 s while busy, 15 s idle | events by stream; one `/__events/snapshot` a minute | 2 s / 15 s, as before |
| `/__computers` (Computers page) | every 4 s | refetch on `computer`/`lease`/`device`; safety 30 s | 4 s |
| `/__devices/devices` | every 60 s | refetch on `device`; safety 120 s | 60 s |

Kept on purpose: the voice companion's 5 s `/jarvis/events` poll while a voice session is on (the server treats a recent GET there as
"a voice client is listening", which decides toast fallback); Home's other panels (`/__operator/state`, ledger, workspace); the
safety polls above. HUD offline: same rules as before, where "heard from" now includes the stream heartbeat, plus a faster rule: a
stream that had connected and then dropped shows the HUD offline once it has been gone 12 s (the poll alone took up to 45 s); a
blink that reconnects in a second or two does not flash.

### Known limits

* Job events are published by the process that writes them. A second hub process writing the same `jobs.sqlite` would not be seen by
  the stream; the one-minute safety snapshot and the legacy cursor catch it. (Today only the owning hub writes.)
* A quiet read-only preview server mounts the stream but has no job or approval stores to publish from.
* Behind Tailscale Serve the stream passes through the proxy; this was not exercised here (loopback only). `X-Accel-Buffering: no`
  and 15 s pings are set; if Serve buffers, the watchdog reconnects and the safety poll still carries the data.
* The first measurement of device offline latency is by unit test (fake clock), not a live companion.

### Measured

See `PERF-BASELINE.md`, section "Activity stream": idle requests, job state change to chip (seconds before, milliseconds after), a dropped
stream replayed by `Last-Event-ID`, hub kill and restart, and the open-stream count with two tabs.
## Voice and background work (builder V)

**Adapted from Open Dot: nothing. No Open Dot code, snippet or prompt text is in our tree.** Everything below was read for behaviour and implemented
independently inside our existing components (the licence question never had to be used: the structures that matter do not fit ours).

### What Open Dot does (voice.ts, agent/runtime.ts, agent/tools.ts, bus.ts, db.ts, repo.ts)

| # | Feature | How their code works | Provider / dependency | Where it fits ours | Decision | How proven here |
|---|---|---|---|---|---|---|
| 1 | Voice "front" that hands work to a text agent | `voice.ts` mints a 120 s OpenAI Realtime client secret (WebRTC, model `gpt-realtime-2.1`, semantic VAD, `marin` voice). The realtime model only talks: it has `send_task` (a receipt, "the result arrives later"), `recent_messages`, `end_call`. The prompt injects the dot's purpose, 12 memories and the last 16 chat lines. | OpenAI API key, paid realtime, provider-side STT/TTS/VAD | Jarvis is the voice, Jev the brain: the existing free pipeline (Groq STT, Gemini/Groq brain, ElevenLabs TTS, our VAD in `src/lib/free-voice-client.ts`) and its `jarvis_command` tool. `send_task` == `jarvis_command` into `scripts/jarvis-command/service.ts`. | **Not adopted** (paid dependency, a second voice stack). Behaviour kept: voice only acknowledges; the work is a job elsewhere. Implemented independently. | `open-dot-v.test.ts` (ack carries the job id), journey a |
| 2 | Result lands in the same conversation | Every message has `conversation_id`. `queueTask` writes an `activity` row ("Voice task · ...") into the call's conversation, the agent works through an in-memory per-dot inbox, and its output is written to the same conversation (`repo.addMessage`), then pushed over the bus. `takeVoiceTranscript` folds the call transcript into the written chat. | SQLite (their own DB) | The existing Chat/Jarvis conversation store `scripts/conversations.ts` (JSON file on the data dir). **Extended, no new DB:** a conversation may be one person's `thread: "jarvis"` with `personId`, `jobs[]` links and server-appended `entries[]`. | **Implemented independently** (their store is a parallel SQLite) | store test; journeys a, b (close client, reopen, read the result) |
| 3 | Durable? | Their inbox is an in-memory array; a restart loses queued work. Results are durable only once written. | none | Our work is already durable: `scripts/jobs/**` (SQLite) and the coding store. The thread watcher re-reads every linked job at start so a result that landed while the hub was down is appended once. | **Not adopted** (we must not add a second job engine) | restart test in `open-dot-v.test.ts`; hub restarts during journeys |
| 4 | Event bus | `bus.ts`: one `EventEmitter` (`emit`/`onEvent`) feeding SSE; `notify` events become OS notifications. | none | Existing: `JobService.subscribe` (job/step/receipt events) and the interjection gate `scripts/jarvis-events.ts` (dedupe, daily budget, quiet mode/hours, one claim, toast fallback) which the voice client already polls and speaks at a pause. New: `threads.onEntry` (server side) fans a finished/failed/stopped entry out to the gate. | **Implemented through existing** mechanisms | gate lines in journey a evidence; `onEntry` wiring in `scripts/operator-plugin.ts` |
| 5 | Short spoken update at a pause | The realtime prompt says: when a "work update" arrives, tell the user briefly, in context. | the realtime session | `createAnnouncementQueue` + `canAnnounce` in `free-voice-client.ts` (waits for listening, mic on, not speaking, no turn) and voice-companion's 5 s poll of `/jarvis/events` + one-claim. Each thread entry carries a `speak` line (<= ~60 chars, "X is finished.") and the detail stays in the entry/job view. | **Reused as is** (nothing new built for the pause) | voice-turns tests (pause detection) unchanged and green |
| 6 | Approvals as cards that pause the run | tools with a pause kind (question, approval, connect) stop the agent and show a card; `resolveCard` resumes it. | none | Existing approvals (`scripts/approvals`, spoken yes, Telegram code) and `awaiting-approval` job state. A job waiting on a yes is linked to the thread and reported as "Waiting for you". | **Not adopted**; state surfaced through the thread | `WAITING` states in `threads.ts`, unit tests |
| 7 | Stop / pause / resume per agent | `runtime.stop/pause/resume(dotId)` aborts the run. | none | Existing job cancel path (`JobService.cancel` aborts the executor signal; coding `orch.cancel`). | **Not adopted**; reached by "stop that task" through the one command path | journeys d, f; tests |
| 8 | `recent_messages` / memory in the voice prompt | Voice prompt embeds memories and recent chat. | their memory table | Hindsight/Obsidian stay the memory; Jarvis's own context passing (`pageContext`, per-person recent state) is unchanged. | **Not adopted** (no second memory) | n/a |

### What was built (all inside existing components)

| Need | Where | Notes |
|---|---|---|
| One durable conversation per person per Jarvis thread | `scripts/conversations.ts` (extended, same JSON file, no new DB): `ensureThread`, `linkJob`, `touchJob`, `appendEntry`, `entriesAfter`, `get`; `jarvisThreadId(personId)` | Default thread id is a deterministic UUID of the person; a client may name its own (a saved voice transcript's id) with `conversationId`. Entries are stored **beside** `messages` and merged on read, so a server append never bumps `revision` and never conflicts with an open tab's save. A client save cannot change `personId`, `jobs` or `entries`; a tab that was shown job entries keeps their place. Someone else's conversation id is never written to (the job goes to the caller's own thread). |
| Link jobs, append the real result | `scripts/jarvis-command/threads.ts` (`createJobThreads`), started in `operator-plugin.ts` | Watches `jobs.subscribe` (command and computer jobs) and polls the coding store (4 s) for coding jobs. "started / waiting / failed / finished / stopped / ended without a confirmed outcome" are read from the job's state; the entry key `<jobId>:<state>` makes a repeat a no-op. Coding results name the account and the model that actually answered per role (receipt `providerModel`), plus files changed / tests / review / done gate (`coding-snapshot.ts`). |
| Request keeps constraints, selected record, page, device | `linked-run.ts` `requestContext` writes one masked "context" note step on the job at start (words, page, focused/selected items, device) | Reuses the existing context passing (`resolveCommandContext`); coding jobs keep their own spec/receipt. |
| Short acknowledgement with a receipt | `linked-run.ts`: voice: first sentence <= 90 chars + `Job <8 hex>.`; typed: the full line + `(job <8 hex>)` | The id is the job service's id of a job that already exists. A job the command only brought up ("show me the computer") is linked as "Following" and its reply is left alone. |
| Follow-ups | `scripts/jarvis-command/followup.ts` (pure) + `linked-run.ts` | Rules below. |
| Replay-safe | `linked-run.ts` event dedupe + `eventId` from the client (`utteranceEventId` in `src/lib/voice-turns.ts`, stamped in `free-voice-client.ts` on `jarvis_command` calls, sent by `src/lib/jarvis-command.ts`) | Same person + same `eventId` (30 min) returns the first outcome, concurrently or later; the existing 5 s words-based dedupe stays underneath. |
| Stop with work left on the server | `free-voice-client.ts` `backgroundStop` / `hasBackgroundWork`, wired in `voice-companion.tsx` | "Stop that task" with nothing running **in this turn** used to answer "Nothing is running." even when a server job was going. It now goes to the one command path. "Be quiet" is unchanged (speech only). |
| Context added to a running computer job reaches its goal loop | `scripts/computers/goal-loop.ts` `extraContext`, `scripts/computers/service.ts` (reads the job's "added context" steps) | From the next decision on. A running coding builder can't take new instructions; the reply says so. |

**Attach / follow-up rule (`followup.ts`).** Which job does "that" mean, for status, stop and add-context: (1) a topical reference names it ("the research job", "the
coding task", "the Bondi research": title/kind match); (2) otherwise the job most recently referenced (started, asked about, added to); (3) a tie, or several topical
matches, is one short question ("Which one to stop: ... or ...?") and nothing is done. A phrase that names something that is not one of his jobs ("how's the market doing",
"cancel the 3pm meeting") is not a job follow-up. Add-context: an explicit reference ("for the Bondi research, also ...") attaches at once; a continuation marker ("also",
"make sure", "only", "instead") inside the 2-minute active window attaches when it matches the job topically, or when exactly one job is in the window and the words are not
a new device action ("also open YouTube" is a new request); several candidates and no clear match asks; anything else is a new request. A bare "stop" belongs to the existing
stop path first, and only if that found nothing of his own to stop does it act on the thread's single open job (several: ask).

### Evidence

Tests (`bun test scripts/jarvis-command/open-dot-v.test.ts`, 24 tests; real `JobService`/SQLite, real conversation store, real command service): the attach rule (pure,
cases), the thread store (idempotent entries, durable across a fresh store, no revision conflict, ownership), a job linked with a receipt and its result appended after the
client is gone, per-person isolation, stop/failed/unknown states and a restart that re-reads what landed while down, "how's that going?" with two active jobs (most recent;
named; real state), add-context with no second job, ambiguity asks, "stop that task" cancels and no later step runs, a coding job followed and stopped through the coding
delegate's own stop with receipts, the replayed utterance event (sequential, late, concurrent, other person) and the client's `runJarvisCommand` replay, the goal loop receiving
added context, and the "Following" case. Client tests in `scripts/jarvis-execution/voice-turns-client.test.ts` (2 added): a stop with nothing running in this turn goes to the
command path when server work is going.

Real journeys against a real cloud-role hub (`scripts/jarvis-command/open-dot-v-journeys.ts`; details and raw lines in `worker-evidence.md`, "Open Dot V"): a) voice request to
the v-research computer, client closed mid-job, reopened: the result was in the same conversation; b) a coding task on `claude:max-2` (Sonnet builder, Opus reviewer, throwaway repo):
completed, receipts show `claude:max-2` and `claude-sonnet-5-5` / `claude-opus-5-5`, the result was in the same conversation after the client left; c) the same utterance
event replayed after a client close/reopen (twice): one job; d) status / topical status / add-context on a running job, no second job; f) "stop that task": cancelled in 48 ms,
the next step "skipped: it was stopped first".

### Not proven / limits (honest)

- **Physical microphone checks are still owed.** Everything voice-side is synthetic (generated PCM, a fake AudioContext, scripted transcripts) or text events.
- Two **simultaneously running** jobs on the real hub were not shown: one shared computer takes one controller at a time and a second real coding run was not allowed. The "two active jobs" behaviour is proven in the service-level test (real job service).
- Open-ended "research X" goals run the hub's Jev goal loop, which is a navigation loop: on example.com it ended "Failed: not sure what to do next (40-52% sure)" and said so, in the conversation. The title-verified goal ("open example.org and confirm that the title is Example Domain") finished. That is Jev's confidence, not the thread.
- The computers delegate understands "on the v-research computer" only at the end of the sentence, by the computer's own name ("the research computer" is "no shared computer called research").
- A replayed event is deduped in memory (30 min) per hub process; across a hub restart only the existing 5 s words-based dedupe applies.
- Voice transcript persistence is **disabled by owner policy** (`use-voice-transcript.ts`), so job results go to the person's default thread, not a saved voice transcript; passing `conversationId` is supported if that policy changes.
- Spoken updates go through the existing gate (12 a day, quiet hours, quiet mode), and only for a person whose own session was seen at this PC; everyone's full result is in their conversation.
- Journey b ran before the result text was polished (roles, files/tests/review in the entry); that formatting is covered by unit tests, not by a second paid run.
- The spoken-update **pause** is the existing client behaviour (`canAnnounce`), proven by the existing turn-taking tests, not re-measured.
## Agent workspaces (builder W, programme C)

**How theirs works.** Each "dot" is one agent with three views behind one header (`DotView`): Chat (the conversation), Computer (its own browser, watch it, take over, hand back) and Setup (rules, routines, memory, skills). Status is four words (ready, working, waiting for you, paused) shown as a dot and one line. Files and the schedule hang off the agent, not off a global page.

**Where it maps here.** We already have both halves, split by section: Computers (the shared computer, its screen, the lease: take control, return) and Coding (a job, its agents, account and model, plan, tests, review). We did not add pages. Each existing card became the agent's workspace.

| Open Dot | Here |
|---|---|
| One-line status | Headline: "Research computer — checking three businesses", "Coding agent — building on Claude Max 2", plus a "Waiting for you — ..." line only when something genuinely waits |
| Chat tab | "You asked" and the agent's latest line (computer job: its steps; coding job: its final summary, else Jarvis's last spoken line) |
| Computer tab, take over / hand back | "Open computer", Take control / Request control, Return to agent (existing lease client and noVNC viewer, unchanged) |
| Setup tab (routines, memory) | "Agent, model and routines": routines say "none tied to this" with a link to Automations (no API links a routine to an agent yet) |
| Files | "Working files" (computer: file steps the job reported; coding: changed files and the patch) |

**Decision.** Independently implemented for the M&U design system. Nothing was adapted from Open Dot code, markup, styles or copy, so no THIRD-PARTY-NOTICES entry was added. Reason: their model is one agent per computer with a model behind it; ours has typed computer jobs (no model) and coding jobs (account and model, requested vs reported), so the data and the honest "none" states differ throughout.

Adapted: nothing. Independently implemented: `src/lib/agent-workspace.ts`, `src/components/agents/workspace-parts.tsx`, `src/components/coding/job-workspace.tsx`, `src/components/coding/needs-you.ts` (moved out of coding-list), the rebuilt `ComputerRow`.

**What changed.**
- Computers: each shared computer leads with its headline, then Assign work (target named first: computer, state, who holds it; typed work: open a page, keep a note; the hub re-validates), Open result / View progress, Open computer, Take control / Request control / Return to agent, Stop (confirm). "Work and result" (asked, state, steps with checks, latest result, working files) and "Agent, model and routines" expand. Computer jobs use no model, and the card says so instead of inventing one. Anchor `#computer-<name>` scrolls to a card.
- Coding: job page opens with the workspace (headline, waiting line using the server's own needs-you text, actions, computer, model and account requested vs reported, conversation, files, output, routines), with the existing readable job summary reused underneath ("Where this stands", minus the rows the workspace already shows). Job cards say "Coding agent — building on Claude Max 2" while a job acts. "Pause" became "Pause to take over". The draft card names where the job will run before Start.
- Server (read only, one field): `ComputerView.lastJob` (`jobId`, `title`, `agent`, `by`) so a finished job's result stays reachable after the lease is released. In memory: it is null after a hub restart.
- Fixed on the way: the old computer row linked a computer job id to `/coding/$jobId` (wrong route).

**How proven.** Cloud-role hub on 8096 (`MU_HUB_ROLE=cloud`, data and coding store on D:, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, display base 601), one real shared computer `w-desk` (Xvfb, x11vnc, Chromium on WSL kali-linux) provisioned through the API, 9 synthetic coding jobs. Click-through in real Chrome, observed effects:
1. Assign: target line "It will run on Research computer · Online · controls: Nobody"; the headline became the task; a real Chromium opened example.com, title verified "Example Domain", `task-note.txt` written and read back.
2. Progress and result: steps with their checks, "Finished. ... 2 of 2 steps ran, 2 checked against the real result", working file listed.
3. Open computer: live screen, view-only. Take control: lease held by the person (epoch bumped), headline "you have the controls". Return: back to "ready for work".
4. Take over a running job: API-started 4-step job; Request control: "you are taking over, the agent pauses at its next safe step", then paused after the running step with "Waiting for you — return the controls so assistant's job can carry on". Return to agent: job resumed (step 2 and 3 ran, step 1 once).
5. Stop: "Yes, stop it": computer offline, running wait cancelled, last step skipped. Open result: the stopped job's steps, with cancelled and skipped shown.
Screens (synthetic data; the person id is the app's fixed owner id, so "Usman" appears in the sidebar): `screens/od-computers-{d,m}.png`, `od-assign-{d,m}.png`, `od-coding-{d,m}.png`, `od-coding-job-{d,m}.png`. Tests: `scripts/agent-workspace.test.tsx`, `scripts/ui-round2.test.tsx` (row renders), `scripts/computers-page-r3.test.tsx`.

**Not done / honest limits.** Coding jobs do not run on a shared computer yet (architecture note in CODING-LOCATIONS-AND-FALLBACK.md), so "Open computer" from a coding job opens Computers (and the matching card when a receipt names a shared computer); the Computer fact reads "Not reported" when no receipt names one. A routine cannot be tied to an agent because no data links them. "Waiting for you — sign in on the research computer" is not detectable by the hub, so it is never shown. Open-ended goals ("screen.goal") need a hub-side Jev key and are not offered. The synthetic jobs were not run (no real coding runs), so the Pause to take over / Resume flow on a live coding job was not exercised here.
## Triggers and routines

**What Open Dot does.** `src/server/triggers.ts` subscribes to Composio's live event stream and, per event, runs an agent instruction. `src/server/scheduler.ts` registers one in-memory `croner` job per routine at app start. There is no dedupe key, no durable event record, no offline policy: a routine that was due while the app was closed simply never runs, and a repeated delivery runs the agent twice.

**What we took: the idea, not the code.** "An app event or a schedule starts an agent instruction" is the only thing carried over. No Open Dot source was copied or adapted, so no file header or `THIRD-PARTY-NOTICES.md` entry is needed. (If a later change does adapt code, add the `Adapted from composio-community/open-dot @ f838e17 (<path>)` header and a notice then.) Composio itself is not connected: no account, key or package was added. If an app has no native connection, a Composio adapter can later feed `TriggerEvent`s into the same engine; native sources come first.

**What we built instead** (`scripts/triggers/**`, on top of the existing automations page, job service and approval service; there is no second job engine):

| Open Dot | Ours |
|---|---|
| In-memory event handling | `triggers.sqlite` (WAL): a delivery row is written **before** any job exists; the job is created with an idempotent request id; `tick()` finishes whatever a crash left half-way |
| No dedupe | UNIQUE (trigger, sha256 of source + event id): a repeat is counted (`repeats`), never a second job |
| `croner` in memory | no cron in memory: each tick asks which slots fell in `(cursor, now]`; the cursor and every slot's outcome are durable |
| Missed run is lost | explicit per-routine offline policy: `skip`, `run-once` (one job for the latest missed window), `review` (one held job, runs only if approved) |
| Agent writes whatever it likes | actions can only record or draft; sending is an approval request (`message.send`) that nothing here executes; `review` triggers hold every job for `trigger.review` |
| Agent output can re-trigger | ledger of what our own jobs produced; an event with actor `agent`, an `originRef`/event id in the ledger (or a child of it) or one of our job ids is stored as `ignored`, no job |
| Payloads in the db | only ids, the event hash and a short masked projection (`safeFields`): bounded keys, scalars, strings masked and cut, long text refused |
| Failures invisible | retry limit with backoff, then a `failed` state shown as "Failing"; an unknown outcome is never retried automatically; manual Retry creates a new linked job |

**Where it lives:** job kind `trigger` (visible in Activity as "Trigger"), approval action `trigger.review` (24 h), `/__operator/triggers*`, a "Triggers and routines" section on the Automations page. Seeded: a synthetic "new enquiry" trigger, the receptionist QA-flag trigger (review mode, **paused until the owner switches it on**) and a "Morning business summary" routine (07:30 Sydney, run-once).

**Known limits**
- Approvals for these jobs are requested by a process, so only a spoken yes or the owner's Telegram code can answer them (a UI click cannot, by the approval policy). The code is sent only when `MU_TRIGGERS_NOTIFY=1`; by default nobody is messaged.
- An approved `message.send` follow-up is recorded as approved and marked "nothing sent": no sender is wired. That is deliberate for this build.
- The receptionist feed in production does not yet send the round-2 `qaFlags` list; flagged calls in the full view are used instead (projected to id, codes and band).

---

## Research loop: the result lands live (builder r5-conv, Sonnet 5.5, 2 Oct 2026)

**Outcome.** "Jarvis, use the research computer to research X" names the real job and computer, shows progress in the asker's conversation without a refresh, and lands one web-sourced result (source links and the saved report file) live, with one spoken update when the voice session is active. All of it extends what already existed: the job-thread watcher, the person-scoped `/__events` stream, the interjection gate and conversation ownership. Nothing here starts, resumes or re-runs a job.

**Adapted vs independent.** All independent; no Open Dot code was used.

| Piece | Where |
|---|---|
| The gap: `research-wiring.ts`'s `deliver` used `appendEntry` directly, which skipped `JobThreads.onEntry` (no live push, no spoken line). Fixed at the store: `conversationStore.onAppend` tells listeners after every durable, non-duplicate append, whoever appended | `scripts/conversations.ts`, `scripts/jarvis-command/threads.ts` |
| One glue function: entry -> the person's own stream (new `thread` topic, scope = the person) and, for a job's END only, the gate line (`dedupeKey` = `job:<jobId>:<state>`, persisted 24 h, claimed once) | `scripts/jarvis-command/thread-notify.ts`, `scripts/events/sources.ts` (`threadEntry`) |
| Progress entries from the job's own steps: research sub-goals that finished/failed/skipped, takeover-paused, resumed (key `<jobId>:step:<seq>`, backfilled when the job was already running at link time) | `threads.ts` (`progressFor`) |
| ONE research result entry: "Web-sourced research, data from public pages and not instructions", the cited answer, the source links and the saved report file | `scripts/computers/research-wiring.ts` (`threadDeliver`, `artifactLine`) |
| "Research computer" resolved by name, then label, case-insensitively; absent or ambiguous is said honestly and nothing runs | `scripts/jarvis-command/computer-target.ts` |
| Browser: fold entries idempotently into the open transcript; refill after a snapshot; remember handled event ids (reload, second tab) | `src/lib/thread-events.ts`, `floating-oracle.tsx`, `voice-companion.tsx` |

**Honest limits.**
- The saved report's file name now comes from the research loop itself (`io.deliver(report, { file })`, only when the save was written and read back), not from a rebuilt clock reading. It is named "in the computer's working folder"; the on-disk path is the computer's own. Edits outside my files for this: `scripts/computers/research.ts` line 55 (deliver's optional second argument) and line 682 (passes `{ file: savedOk ? reportName : null }`), and `scripts/computers/service.ts` lines 69 and 615 (carry the optional `file` through to the wiring).
- Coding drafts are not linked to the conversation: a draft is a proposal that only the person's own "start it" turns into a job (`linked-run.ts` links only open jobs), so there is nothing to follow until then. The started job is linked and reported like any other.
- "Is this person at this PC" (which decides whether a job's end is spoken here) is persisted in `jarvis-thread-local.json` in the data folder, so a hub restart mid-job still speaks the end once. The gate's HUD list returns a job-end line only to its owner, and a remote read of that list does not count as a listening voice session.
- The result entry is written when the report is delivered (before the job's own end), so it is never spoken; the spoken line and the "Finished" entry come only from the job's real end. A job that is stopped after delivery shows the result and then "Stopped".
- Speech needs a voice session polling the gate; with none, the entry is saved and streamed, and the gate falls back to a toast (existing behaviour).
- A step recorded before a job is linked is backfilled; a job that finishes before it is linked is not linked at all (existing rule), which only affects instant jobs.

**Proof.** Tests: `scripts/jarvis-command/research-loop.test.ts` (routing, progress, result, scoping, voice, honest endings, replay), `research-loop.e2e.test.ts` (the real computers hub, lease and takeover, synthetic web), `scripts/events/thread-client.test.ts` (browser folding, replay safe), `scripts/conversations.test.ts`. Rendered: `scripts/jarvis-command/research-loop-preview.ts` starts the real hub on 8171 with a fresh data folder and a SYNTHETIC computer, and drives headless Chrome at 1440 and 390 wide with no page reload (screenshots in `D:/prog-scratch/r5-conv/`).
