# HTTP contracts the frontend depends on

Baseline routes are read from `82d6962d`; the Stop/idempotency section includes this branch's proposed durable-admission
update and is not a production-release claim. Where a server file documents its own routes, that file is the source of truth and is named. Shapes here are abridged: check the named type before changing either side.

## Common rules

- Every `/__*` request passes the identity gate first (`scripts/identity/gate.ts`). A request from another origin is
  refused (Origin mismatch, or `Sec-Fetch-Site` of `cross-site` or `same-site`). A non-canonical target is 400.
- Identity is the gate's verified principal. A `personId` in a body is never read.
- Browser writes send JSON and the caller's **own page token** in the `x-claude-os-token` header. The token comes from
  `GET /__token`.
- Route classes (`scripts/identity/routes.ts`, mirrored in `docs/IDENTITY-ROUTES.md`): `shared`, `local-owner`, `self`.
  An unlisted path is `local-owner`. "read" is GET or HEAD; "write" is every other method.

## `/__token`

`GET /__token` (served by the gate):

| Caller | Response |
|---|---|
| A browser principal (`loopback-owner`, `paired-session`, `tailnet-person`) | `200 { token }`: the internal token only for the owner at the hub; a person-bound derived token for anyone remote |
| A verified Tailscale login with no principal (must pair) | `200 { token, scope: "pairing" }` |
| Anyone else | `401 { error }` |

Any other method is 405.

## Identity principals

`PrincipalVia` in `scripts/identity/principal.ts`. Each principal also has `actor`: `human` (a confirmed browser
session) or `process`.

| Principal | What it is | What it may do |
|---|---|---|
| `loopback-owner` | The owner at the hub: loopback socket, local Host, no relay header. In the server role it also needs the local-owner proof (`scripts/identity/local-owner-token.ts`); without it a loopback request is nobody | Everything, console-only routes included |
| `paired-session` | A request through Tailscale Serve from a login in `people.json`, carrying a live, signed 30-day `mu_session` cookie for that person. Revocable. `actor: human` once confirmed | All `shared` routes. In the server role also the `local-owner` routes, except the console-only set in `scripts/identity/server-role.ts`. Starts, stops and approves work |
| `tailnet-person` | The same Serve-verified login with no session cookie (an unpaired browser or a script). `actor: process` | **Since r11: the pairing page and nothing else.** Non-`/__` paths return the self-contained pairing page. `shared` `/__` routes return `403 { error, confirm: "/__devices/me" }` except `/__version` and `/__health`. Pairing itself uses the `self` routes under `/__devices`. No conversations, jobs, coding jobs, agents, memory, CRM or accounts |
| `telegram-owner` | A Telegram direct message relayed by the Hermes gateway with its relay bearer, from a sender listed in `people.json` | Reaches the hub only through the gateway's `/__away` relay (away-mode commands; approvals answered with a Telegram code). Never a browser principal, so the gate refuses it on browser routes |
| `companion` | A paired companion's bearer token whose owner matches the login it arrived with | Only `/__devices/companion/*`. A shared bot computer's token is not an identity anywhere else |
| `routine` | The hub's own scheduler running a linked routine. No request resolves to it | Runs a person's linked work; no owner, desktop or page-token rights |
| gateway | **Not a principal on this branch.** `PrincipalVia` has no `gateway` value here; Dot's gateway is on `gw/dot-gateway-20261002`. The Hermes relay bearer authenticates `/__away` as a `self` route | n/a |

`mayUseBots(principal)`: `actor === "human"`, or `loopback-owner`, or `routine`. `isHumanSession`, `isAtHub` and
`isBrowserPrincipal` are the other helpers routes use.

## Jarvis command: `/__operator/screen/command`

Source: `scripts/jarvis-command/route.ts`, types in `scripts/jarvis-command/contracts.ts`, client in
`src/lib/jarvis-command.ts`. Every response of this route carries the header `x-mu-command-route: 1`; a 5xx without it
was answered by something in front of the route.

### `POST /__operator/screen/command`

Request (`CommandBody`):

```ts
{
  utterance: string;            // required, trimmed, at most 600 characters
  source?: "voice" | "typed" | "acceptance";   // default "typed"
  spokenTarget?: string;        // at most 60 characters
  pageContext?: PageContext;    // at most 24,000 characters as JSON
  spokenYes?: string;           // a UUID from the voice pipeline only
  steps?: RemoteStep[];         // companion executors only, at most 6; otherwise dropped whole
  conversationId?: string;      // a UUID, or "agent:<personId>:<botId>"
  target?: { bot: string };     // bot id: /^[a-z0-9][a-z0-9-]{0,31}$/
  subjects?: string[];          // CRM references, at most 8
  eventId?: string;             // /^[\w:.-]{6,80}$/, one per utterance, stable across a replay
}
```

Response: `200 application/x-ndjson`, one `CommandStreamEvent` per line, the last one `done`. A body that fails
validation is `400` with a single `done` object.

```ts
| { type: "job"; jobId; targetDeviceId; deviceLabel?; seq }
| { type: "decision"; decision: JevDecision; seq }
| { type: "narrate"; stage; text; speak?; seq? }
| { type: "step"; did?; verified?; ok?; seq? }
| { type: "slow"; said; seq? }
| CommandDoneEvent
```

`CommandDoneEvent`: `{ type: "done", ok, said, kind, jobId, runId, targetDeviceId, decision?, navigate?, url?, handoff?,
outcome?, ask?, stopped?, confirm?, resumeGoal?, checkedAt?, awaiting?, refused?, verified?, numbers?, timing? }`.
`kind` is one of `screen | browser | app | file | answer | navigate | handoff | refused | ask | unavailable | remote`.
`timing` is `{ decisionMs, dispatchMs, completeMs, jevMs? }`, each measured separately; `null` means that stage did not happen.

A dropped stream does not stop the job: it keeps running for 20 s (`RECONNECT_GRACE_MS`) so the client can re-attach.

### `GET /__operator/screen/command/attach?job=<id>&since=<seq>`

NDJSON: the job's events after `since`, then live, ending with `done`. An unknown or foreign job returns one `done` with
`ok: false, kind: "unavailable"`.

### `POST /__operator/screen/command/cancel`

Body `{ jobId }` or `{ eventId }`. Neither: `400 { ok: false, error }`.

- `200` only for a confirmed stop, or a command prevented before any job existed.
- `409` otherwise, with `outcome`.
- `{ jobId }` returns `{ ok, state, outcome, by?, reason? }`; `outcome` is the job service's stop outcome
  (`stopped`, `unconfirmed`, `already-ended`, `no-job`).
- `{ eventId }` returns the same plus `jobId` when a job existed, or `{ ok: true, state: null, outcome: "prevented" }`
  when none did, or `{ ok: false, outcome: "unconfirmed" }` when that command's run is still in progress.

`POST /__jobs/<id>/cancel` also stops a command's job.

### `GET /__operator/screen/command/thread?conversation=<id>&after=<seq>`

`200 { conversationId, entries }`: the server-appended job results in this person's Jarvis thread (`ThreadEntry` in
`scripts/conversations.ts`: `seq, key, at, jobId, state, text, speak?, jobKind?, blocker?, ok?, stopped?, unverified?,
afterMessages`). `403` for someone else's conversation, and for a bot conversation when `mayUseBots` is false.

### `POST /__operator/screen/command/thread/say`

Body `{ requestId, part: "user" | "reply" | "note", role: "user" | "assistant", text }` (`requestId` matches
`/^[\w:.-]{6,80}$/`, `text` at most 4,000 characters). Saves a typed request or its reply into the caller's own default
thread, keyed by `requestId:part`, so a repeat writes nothing. `200 { ok: true, conversationId }`, `400` for a bad body,
`503 { ok: false, error }` when the thread could not be written.

### The Jev decision record

On the wire the decision is `JevDecision` (`decision` events and `done.decision`):

| Field | Meaning |
|---|---|
| `op` | What was chosen |
| `target` | Masked: an app name, a file basename, a page path, a host. Never typed text |
| `confidence`, `policy` | `policy` is `act`, `look-again`, `ask`, `delegate` or `done` |
| `source` | Who decided: `jev` (only with a real Jev call), `rules`, `fallback` (an exact rule run because Jev was unavailable), `context`, `registry` |
| `why` | One short plain line |
| `calibrationRunId` | The threshold set it was judged against |
| `ms`, `requestId`, `model` | Evidence of the Jev call when `source` is `jev`: latency, router request id (the receipt), the model that answered |
| `options` | The finite options Jev was offered |
| `cached`, `cacheAgeMs` | The answer came from the decision cache; `requestId` is then the original call's |
| `delegateTo`, `deviceId` | The specialist or the device |

On a stored job step the same record is `JevDecisionRef` (`scripts/jobs/types.ts`), where the field is named
**`decidedBy`**: `jev | rule | fallback | context | registry | unknown`. A bot task exposes
`TaskDecision { decidedBy, op, confidence, ms, requestId, model, options, cached }` (`scripts/agents/types.ts`). The
frontend renders either form through `src/lib/commands/decided-by.ts`, which reads `decidedBy ?? source`.

### Stop and `eventId` idempotency

1. **Stop words are handled before Jev.** They cancel every running command of that person through the job service and
   drop a pending coding-planner question. "Stopped" is said only for a confirmed stop; an unconfirmed one is reported
   as such (`outcome: "unverified"`, the job ids in `numbers.unconfirmed`).
2. **While the coding planner is waiting for an answer**, soft stop words ("forget it", "hold on") go to the harness as
   the answer; only an explicit stop command stops.
3. **Same `eventId`, same person, same immutable request binding.** The jobs SQLite store claims an event before
   follow-ups, planners or executors run. Its digest binds the founder, conversation, origin device, requested target,
   words (including explicit account/model pins), page context and steps. Capture timestamps do not affect the digest.
   A changed binding is refused; it cannot attach to another request. All valid 6–80 character event ids are supported:
   short job keys retain `cmd:<personId>:<eventId>`, and longer keys use a digest rather than truncation.
   Reconnects follow the original in-process stream. After restart, replies use existing job/bot records or a truthful
   already-received/unverified response. An accepted event is never automatically dispatched again, including when
   no job existed at the crash or an executor threw. An uncertain result must be checked before deliberately issuing
   a new event. Duplicate reads do not refresh conversation-reference recency.
4. **Stop before the job exists.** `cancel { eventId }` writes a durable Stop tombstone. Never-admitted tombstones retain
   the existing 30-minute expiry; admitted events and their Stop flags do not expire. Atomic wrapper creation checks
   the Stop and binds the queued job in the same transaction. A previously admitted request with an unknown outcome
   remains `unconfirmed`, never falsely `prevented` after restart. Explicitly started coding/computer tasks are bound
   separately from command wrappers so Stop reaches the actual task. Status/show/attach references never become
   cancellation authority. If work started before Stop, the reply reports its observed stop outcome rather than saying
   nothing ran. The ledger stores identifiers, a digest and bounded outcome flags only, never prompts, outputs or tokens.
5. **Same words, no `eventId`.** A repeat of the same words, target and page context from the same person within 5 s
   while that job runs (or just finished OK) attaches to it instead of starting another. Answers ("yes", "no") are always new.
6. **Client rule.** Mint one `eventId` per utterance, reuse it on a reconnect's replay, and send Stop with the same
   `eventId` when the job id has not arrived yet. `src/lib/typed-send.ts` keeps a Stop from being queued behind what it
   should stop.

## Conversations: `/__operator/conversations`

Source: `scripts/operator-plugin.ts`, store in `scripts/conversations.ts`.

| Route | Shape |
|---|---|
| `GET /__operator/conversations` | `{ conversations }`: the caller's conversations; bot threads are omitted unless `mayUseBots` |
| `POST /__operator/conversations` | Body: a conversation to save. `{ conversation }`. A bot conversation without `mayUseBots` is `403` |
| `POST /__operator/conversations/<id>` with `{ action: "delete" }` | Removes it; same bot rule |

Server-appended thread entries live beside client-saved messages, so a server append never bumps `revision` or conflicts
with an open tab's save. When the conversations file cannot be read the server raises `ConversationsUnreadable` and
routes answer 503 (see the EPERM item in the backlog).

## Jobs and approvals: `/__jobs`, `/__approvals`

Source of truth: the header of `scripts/jobs/routes.ts`. Every route needs a principal (401 without one).

| Route | Shape |
|---|---|
| `GET /__jobs?kind=&state=&limit=&targetDevice=&bot=&subject=` | `{ jobs: JobSummary[] }` |
| `GET /__jobs/events?after=<seq>` and `?tail=1` | `{ events: JobEvent[], last }` |
| `GET /__jobs/<id>` | `{ job }` |
| `POST /__jobs/<id>/cancel` `{}` | `202 { result }` or `409` |
| `POST /__jobs/<id>/release` `{}` then `{ approvalId }` | `202 { approval }`, then `200` released or `409` |
| `GET /__approvals?state=&limit=`, `GET /__approvals/<id>` | `{ approvals }`, `{ approval }` |
| `POST /__approvals/<id>/card` `{}` | `{ cardNonce, expiresAt }`, only for a verified UI session |
| `POST /__approvals/<id>/decide` | `{ decision: "approve" | "reject", evidence }`; evidence is exactly one of `{ spokenYes, questionId }`, `{ uiConfirm: true, cardNonce }`, `{ awayCode, cardNonce? }`, `{ telegramCode }` |
| `POST /__approvals/<id>/cancel` `{}` | |

Job states: `queued, running, awaiting-approval, succeeded, failed, cancelled, interrupted, unknown`. Responses are the
HTTP view: no principal carries its `sessionId` or `deviceId`. A request a process made is never answered by `uiConfirm`.

## Coding: `/__operator/coding/*`

Source of truth: `scripts/coding/routes.ts`; client `src/lib/coding-client.ts`; types `scripts/coding/contracts.ts`.
Every POST except `/coding/shape` needs a person in a signed-in browser session. POSTs are idempotent per `requestId`.

| Route | Shape |
|---|---|
| `GET /coding/jobs?state=&repo=&limit=` | `{ jobs, liveJobs }` |
| `GET /coding/jobs/:id` | `{ job, receipts, modelsUsed, readable, approvals, handoff, events, liveRoles }` |
| `GET /coding/jobs/:id/events?after=N` | SSE; with `poll=1`, `{ events, last }` |
| `GET /coding/artefacts/:jobId/:artefactId` | `text/plain`, redacted |
| `GET /coding/repos`, `/coding/accounts[?refresh=1]`, `/coding/focus` | `{ repos }`, `{ accounts, codexIsolation }`, `{ focus }` |
| `POST /coding/shape` `{ requestId, utterance, channel, draftId?, answer?, replaces? }` | A question, or `{ kind: "draft", spec, jobId, specDigest, validation, spokenSummary }` |
| `POST /coding/jobs` `{ specId, specDigest, requestId, confirmation: "ui" | "typed" }` | `202 { job }` |
| `POST /coding/jobs/:id/cancel` `{ roleId? }`, `/interrupt` `{ roleId? }` | `{ job }` |
| `POST /coding/jobs/:id/resume` `{ roleId?, reassignTo?, paidAcknowledged?, acceptCheckoutChange? }` | `{ job }`; a paid route without `paidAcknowledged: true` is 400 |
| `POST /coding/jobs/:id/input` `{ roleId, inputId, decision: "approve" | "deny", answers? }` | `{ job }` |
| `POST /coding/jobs/:id/tests/rerun` | `{ test }` |
| `POST /coding/jobs/:id/apply` `{ action }` | `202 { apply, approval, answeredBy }`. It only asks: merges and pushes are answered by the owner's spoken yes or Telegram code |
| `POST /coding/jobs/:id/account`, `/plan` | Before Start only: a revised draft; `409` once the job has started |
| `POST /coding/jobs/:id/supersede`, `/unsupersede` | `{ job }` |

## Devices: `/__devices/*`

Source: `scripts/devices/service.ts`. A `self` route: it proves its own callers.

| Route | Shape |
|---|---|
| `GET /me` | `{ authorised, via, person, principal: { personId, via, actor, displayName } | null, displayAs, sharedOnly, local, session, waitingSession, hubSession, canSelfPair, hubRole, people, permissions }` |
| `POST /pair/tailnet`, `/pair/redeem`, `/pair/code`, `/pair/console-code` | Pairing. `/pair/code` body `{ purpose: "browser" | "companion", personId? }` |
| `GET /sessions`; `POST /sessions/confirm`, `/sessions/confirm-code`, `/sessions/approve` `{ sessionId, matchCode }`, `/sessions/revoke` | Session administration; writes need a human session |
| `GET /devices`; `POST /devices/revoke` | Paired devices and presence |
| `POST /policy/self-pair`, `/policy/finance`; `POST /name`; `GET /authorise` | Policy, display name, an authorisation check |
| `POST /commands` `{ executor, args, spokenTarget?, timeoutMs? }`; `POST /commands/cancel` `{ commandId }` | Direct device command; risky executors are refused here |
| `/companion/pair`, `/heartbeat`, `/next?wait=`, `/result`, `/progress`, `/observation`, `/goodbye` | The companion wire; bearer token; never available to web pages |

A bare tailnet login is refused on `/commands`, `/commands/cancel`, `/devices` and `/sessions`.

## Computers: `/__computers/*`

Source of truth: the header of `scripts/computers/routes.ts`; clients `src/lib/computers-client.ts`,
`src/lib/terminal-client.ts`. Reads need a signed-in founder. Lifecycle, takeover, input and the viewer need a person.

| Group | Routes |
|---|---|
| Lists | `GET /` `{ computers, targets }`; `GET /targets`; `GET /host`; `GET /events` |
| Lifecycle | `POST /` `{ name, adapter?, resolution?, label? }`; `POST /:name/action` `{ action: start | stop | suspend | resume | recover | destroy, force? }`; `POST /host/install-browser` |
| Agent jobs | `POST /:name/jobs` `{ agent?, title?, steps: [{ executor, args?, timeoutMs? }], wake? }` gives `{ jobId }`; `GET /jobs/:id`; `POST /jobs/:id/cancel` |
| Control lease | `POST /:name/takeover`, `/take-here`, `/lease/renew`, `/return`; `POST /:name/input` `{ executor, args }` for the lease holder only; `GET /:name/viewer-state` |
| Screen | `GET /:name/screenshot` (JPEG); `GET /:name/viewer` (noVNC page); `GET /:name/screen`; `POST /:name/screen-report` `{ frame, blank }` |
| Results | `GET /artifacts`; `GET /artifacts/:jobId`; `GET /artifacts/:jobId/f/:file[?download=1]` |
| Terminal | `POST /:name/terminal` `{ cols?, rows? }` gives `{ id, attached }`; `GET /:name/terminal`; `GET /:name/terminal/:id/events?after=<seq>&wait=<ms>` gives `{ chunks: [{ seq, data }], next, gap, closed }` (long-polls up to 25 s); `POST .../input` `{ data }` (at most 4 KB); `POST .../resize` `{ cols, rows }`; `POST .../close` |

The terminal is for a confirmed person who holds the computer's control lease in this window, checked on every call.

## Agents: `/__agents/*`

Source of truth: the header of `scripts/agents/routes.ts`.

| Route | Shape |
|---|---|
| `GET /skills` | `{ skills: [{ name, description? }] }` |
| `GET /bots`, `GET /bots/:id` | `{ bots }` with `readiness` and `lifecycle`; one bot with `conversationId` and `conversationKey` only for a confirmed person |
| `PATCH /bots/:id` `{ rev, ...fields }` | The updated bot; `409 { error, current }` on a stale `rev` |
| `GET /bots/:id/tasks?limit&before&beforeId` | `{ tasks, before, beforeId }` |
| `GET /bots/:id/files`, `GET /bots/:id/thread?after` | `{ files }`; `{ conversationId, conversationKey, entries, last }` |
| `POST /bots` | `201` the new bot; `409 { code: "id-taken" | "name-taken" }` |
| `POST /bots/:id/duplicate`, `POST /bots/:id/archive` `{ rev, archived, afterCurrentWork? }` | `422 { code: "has-running-work", work }` or `"last-active"` |

Changing, creating, duplicating and archiving need a confirmed human session or the owner at the hub, in every role.

## Memory: `/__memory/*`

Source of truth: the header of `scripts/memory/plugin.ts`.

Reads: `GET /status`, `/links`, `/buckets`, `/items?kind=&bucket=&q=&superseded=1`, `/item/<id>`, `/usage`, `/approvals`.
Writes: `POST /recall { query }`, `/remember { text, title?, bucket?, note?, onConflict?, reaffirm? }`,
`/vault/save`, `/correct { id, text, title?, expected_version_hash? }`,
`/forget { kind: unindex | memory | full, target, heading?, approval_id? }`, `/approvals/grant { approval_id }`,
`/reindex { target }`, `/sync {}`, `/facts-used { refs }`, `/voice { utterance, context? }`,
`/held/release { approval_id? }`, and `/mcp` (JSON-RPC for agents). There is no bulk-delete route. Browser POSTs need the
page token. One shared pool: the person is provenance, never an access boundary.

## CRM: `/__crm/*`

Source: `scripts/crm/plugin.ts`; client `src/lib/crm-client.ts`. Founder browser principals only. Private text is
withheld from an unconfirmed caller (`actor` not `human`).

| Route | Shape |
|---|---|
| `GET /__crm/snapshot` | The whole CRM view |
| `GET /__crm/record?ref=<crm ref>` | The result of `crm.record.get`; 404 `not-found` |
| `GET /__crm/ops` | `{ operations }`: the typed operation list |
| `GET /__crm/finance?companyId=` | Finance links for a company; 503 when the adapter is unavailable |
| `GET /__crm/file?id=` | A private attachment's bytes; a confirmed browser session only |
| `GET /__crm/resolve-legacy?lead=<n>` | `{ ref }` or 404 |
| `POST /__crm/ops` `{ name: "crm.*", input }` | The only write. Needs the page token; in the server role a confirmed session. `409 read-only` on a quiet copy |

Errors are `{ ok: false, code, error }`: `validation` 400, `not-found` 404, `conflict` or `idempotency-conflict` 409,
`restricted` 403, `needs-upgrade` or `unavailable` 503.

## Events: `/__events`

`GET` only, SSE. Topics: `job, approval, computer, lease, device, agent, jarvis, thread, crm`
(`scripts/events/bus.ts`, `src/lib/activity-stream.ts`; keep the two lists equal). Scoped per person.
