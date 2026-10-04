# The OS pages as Dot sees them through the gateway

Dot signed in through the gateway and "nothing could be read": every page asked the hub's founder routes for its data, the
gateway's allow-list did not list them, and each panel showed a bare 403. This file records what each page asks for, what
now answers it, under which capability, and what stays the founders' and why.

Proof: `bun scripts/gateway/dot-ui-check.ts` (Playwright, headless Chrome) on the LOCAL SYNTHETIC pair only
(`bun scripts/gateway/staging-local.ts start --data D:\AgenticOS-r11-data\gw3 --memory on --ui <built UI>`, hub 8194,
gateway 8195). It mints a synthetic code, grants the operate set until the identity ends, authorises the synthetic mailbox
`hello@synthetic.example`, signs in through `/gw/enrol`, visits every page below and records every `/__` request
(method, path TEMPLATE, status). Screenshots: `docs/programme-20261001/evidence-notes/dot-ui/` (synthetic data only).
Run 5 Oct 2026: every page shows data; **0 requests refused by the server, 0 console errors on every page**.

## How it works

Three pieces, each small:

1. **Thin hub adapters** (`scripts/gateway/ui-adapters.ts`, routes in `scripts/gateway/hub-ops.ts` under
   `/__gateway/ui/*`). Each answers in the SAME response shape as the founder route the page already calls, filtered for
   the gateway principal exactly as its `/__gateway` routes are. The founder routes themselves stay closed (most are in
   `policy.ts` NEVER).

   | Adapter (`/__gateway/ui/...`) | Page's route | Capability | Filtering |
   |---|---|---|---|
   | `crm/snapshot` | `GET /__crm/snapshot` | `crm.read` | `crm.snapshot` run under the gateway actor (the CRM guard): what `POST /__gateway/crm/read` returns |
   | `crm/record` | `GET /__crm/record` | `crm.read` | `crm.record.get` under the gateway actor |
   | `crm/finance` | `GET /__crm/finance` | `finance.read` | a company's Stripe invoice links, from the CRM snapshot under the gateway actor (so the CRM guard checks `crm.read` too) |
   | `finance/summary`, `finance/status`, `finance/transactions` | `GET /__finance_manual/...` | `finance.read` | the founders' own handler over a BUSINESS-ONLY view of the ledger: personal and unreviewed rows do not exist in it; no audit, no vendor rules; every write refused |
   | `jobs`, `jobs/events`, `jobs/<id>` | `GET /__jobs...` | `ops.read` | review B1 kept: Dot's own jobs in full; a founder's job as id, kind, state, timing and step count only ("Founder's job (details not available to Dot)"); events for Dot's own jobs only |
   | `computers` | `GET /__computers` | `bots.operate` | shared bot computers only; no personal device, no target list |

   Two founder-route reads are opened as they are, because their data is already what `finance.read` gives Dot through
   `/__gateway/finance/stripe`: `GET /__operator/business/finance/stripe/status` (configured or not; never a key) and
   `.../stripe/summary` (the synced snapshot). Every new rule names one capability with its reason in `policy.ts` and is a
   route the hub classes "shared" (`policy.test.ts`).

2. **The gateway's UI bundle only** (`src/lib/dot-gateway.ts`, active only when built with `MU_GATEWAY_SPA_BUILD=1`; the
   founders' app never runs it): a fetch guard sends those reads to the adapters, sends the CRM page's `POST /__crm/ops
   { name, input }` to Dot's own CRM API (`/__gateway/crm/read` for reads by name, `/__gateway/crm/ops` for writes, where the
   founders' operations are refused with their reason), and answers founders-only routes at once, without a request, in
   the server's usual refusal shape: `403 { error: "Not available to Dot: <why>." }`. Each panel shows its existing error
   state with that text; the page's one-line notice (`src/components/shell/dot-gateway-notice.tsx`) says "Signed in as Dot
   through the gateway" and, folded, which parts of the page are the founders' and why.

3. **Audit**: a refused request to a route the policy does not list is recorded as `unlisted <path template>` (ids,
   numbers, emails and odd segments as `*`; never the query, an id or the body), so the next missing route is visible in the
   audit (`pathTemplate` in `scripts/gateway/server.ts`).

The shell polls several panels on every page, so a signed-in browser makes many small reads: the gateway's read limits
went from 1,200/600 per minute (per address/per session) to 3,000/1,500. Writes keep their own limit (60 per minute).

## /jarvis is Dot's OWN Jarvis (5 Oct)

In Dot's browser the Jarvis page is Dot's own conversation, under `tasks.run`:

| Page's request | Goes to | What happens |
|---|---|---|
| Send (the composer) | `POST /__gateway/tasks { text, eventId }` | the Jev-led command path as Dot, no device lanes. The hub saves the request, and a plain reply, into Dot's OWN default Jarvis thread (`jarvisThreadId("dot")`), keyed by the request id so a retry writes nothing twice. A job the command started gets its started/finished lines from the hub's thread watcher (Dot's command service now has its own thread). |
| `GET /__operator/screen/command/thread`, `GET /__operator/conversations` | `GET /__gateway/ui/jarvis/thread` | Dot's thread only: one fixed id, no id from the request is read, so no founder thread is reachable |
| Stop (`POST /__operator/screen/command/cancel { jobId }`) | `POST /__gateway/ui/jarvis/stop` | Dot's own job only (as `/__gateway/jobs/<id>/stop`); replies `{ outcome, state }` the page already reads |
| job facts (`GET /__jobs`) | `GET /__gateway/ui/jobs` (`ops.read`) | as before (B1) |

Founders' conversations, devices, model accounts, `/__journeys` and every other Jarvis route stay "Not available to Dot".
Proof: `bun scripts/gateway/dot-jarvis-check.ts` on the synthetic pair; screenshots in
`docs/programme-20261001/evidence-notes/dot-jarvis/`. The synthetic hub has no Jev key, so a research request there is answered
"nothing ran" (saved as the reply); the job card and Stop are proved with one synthetic queued job of Dot's placed in Dot's thread as
the thread watcher would place it, then stopped through the page, the gateway and the hub.

## What stays the founders' (refused in the page, and by the gateway anyway)

| Route family | Why |
|---|---|
| `/__devices/*` | devices and sign-ins are the founders' own |
| `/__approvals/*` | approvals and decisions are the founders' |
| `/__operator/profile`, `away`, `private-advisor` | a founder's own profile, away mode and advisor |
| `/__operator/jarvis/*`, `conversations`, `screen/*` | a founder's own Jarvis and conversations (Dot runs work through `/__gateway/tasks`) |
| `/__operator/state` | the founders' own workspace state: their mail, saved notes and Jarvis. Dot reads authorised mailboxes through `/__gateway/mail/*` and shared memory through `/__gateway/memory/recall` |
| `/__operator/calendar/*` | the founders' calendars (no calendar capability exists) |
| `/__operator/business/*` (except Stripe status/summary) | the founders' business brief, built from their mail and approvals |
| `/__operator/connections/*`, `setup/*`, `native-connections` | accounts, credentials and mailbox connections |
| `/__operator/coding/accounts`, `focus` | coding accounts hold sign-ins; the focus is a founder's own |
| `/__operator/memory`, `quick-actions`, `search`, `agent-jobs`, `models`, `inbox/*`, `mail-archive/*` | the founders' vault, mail, files and own agent chats |
| `/__claude_models`, `/__hermes_models`, `/__ai_usage` | model accounts and usage |
| `/__design_*` | the design studio (not granted) |
| `/__workspace/needs-you`, `today`, `email`, `receptionist`, `enquiries`, `call-queue` | approvals, mail, calls and enquiries |
| `/__receptionist/*` | receptionist call data (the launch is on hold) |
| `/__lead-sites/*`, `/__websites/*` | publishing and hosting accounts |
| `/__memory/*` | the raw memory vault |
| other `/__finance_manual/*` | the founders' ledger tools: personal rows, imports, vendor rules |
| other `/__crm/*` (files, writes on founder routes) | private attachments need a confirmed founder browser; Dot changes records through its own CRM API |
| `/__computers/*`, writes to `/__jobs*` | the live viewer and computer controls, a founder's job; Dot uses its own bots and tasks APIs |
| `/__dev_restart` | the hub's console |

Pages in the brief that do not exist under that name in this branch: "Departments" is `/agents/workspace` (and
"Departments: Research" `/agents/workspace/research`), so both are checked there.

## Page by page

"in page" = answered by the guard as "Not available to Dot" without a request. (xN) = asked N times while the page was open.

### Home (`/`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/home.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/finance/summary` | 200 (x2) | `finance.read` | GET /__finance_manual/summary |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__health` | 200 | `view` | same |
| GET | `/__operator/business/finance/stripe/summary` | 200 | `finance.read` | same |
| GET | `/__operator/leads/overview` | 200 | `view` | same |
| GET | `/__workspace/pipeline` | 200 | `view` | same |
| GET | `/__workspace/websites` | 200 | `view` | same |
| GET | `/__claude_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/agent-jobs` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/business` | in page (x2) | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/brief` | in page (x2) | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/brief/status` | in page | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/demo` | in page (x2) | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/integrations` | in page (x2) | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/today` | in page (x2) | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/business/wiki-facts` | in page | none: not available to Dot (the founders' business brief (built from their mail and approvals); Dot reads business finance and records) | same |
| GET | `/__operator/calendar/health` | in page (x2) | none: not available to Dot (the founders' calendars) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page (x4) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/quick-actions` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/search` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__websites/overview` | in page | none: not available to Dot (publishing and hosting accounts are the founders') | same |
| GET | `/__workspace/call-queue` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/email` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/enquiries` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/receptionist` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/today` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Jarvis (`/jarvis`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/jarvis.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/computers` | 200 | `bots.operate` | GET /__computers |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/devices` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__devices/me` | in page (x2) | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/agent-jobs` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page (x3) | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page (x3) | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Departments (`/agents/workspace`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/departments.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__agents/bots` | 200 | `view` | same |
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/computers` | 200 | `bots.operate` | GET /__computers |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/coding/jobs` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page (x2) | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Departments: Research (`/agents/workspace/research`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/departments-research.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__agents/bots` | 200 | `view` | same |
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/computers` | 200 | `bots.operate` | GET /__computers |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/coding/jobs` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page (x2) | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Work (`/work`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/work.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__workspace/pipeline` | 200 | `view` | same |
| GET | `/__workspace/websites` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/call-queue` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
| GET | `/__workspace/today` | in page (x2) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### CRM: Today (`/crm?view=today`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/crm-today.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| POST | `/__gateway/crm/read` | 200 (x3) | `crm.read` | POST /__crm/ops (a read by name) |
| GET | `/__gateway/ui/crm/snapshot` | 200 | `crm.read` | GET /__crm/snapshot |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__token` | 200 | (gateway's own) | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### CRM: Companies (`/crm?view=companies`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/crm-companies.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| POST | `/__gateway/crm/read` | 200 (x3) | `crm.read` | POST /__crm/ops (a read by name) |
| GET | `/__gateway/ui/crm/snapshot` | 200 | `crm.read` | GET /__crm/snapshot |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__token` | 200 | (gateway's own) | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### CRM: a company (`/crm?ref=<company>&tab=overview`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/crm-a-company.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| POST | `/__gateway/crm/read` | 200 (x3) | `crm.read` | POST /__crm/ops (a read by name) |
| GET | `/__gateway/ui/crm/finance` | 200 | `finance.read` | GET /__crm/finance |
| GET | `/__gateway/ui/crm/snapshot` | 200 | `crm.read` | GET /__crm/snapshot |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__token` | 200 | (gateway's own) | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Leads (`/leads`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/leads.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/leads/calls` | 200 | `view` | same |
| GET | `/__operator/leads/list` | 200 | `view` | same |
| GET | `/__operator/leads/overview` | 200 | `view` | same |
| GET | `/__operator/leads/summary` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__lead-sites/status` | in page | none: not available to Dot (publishing and hosting accounts are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Finance (`/finance`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/finance.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/finance/status` | 200 | `finance.read` | GET /__finance_manual/status |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/business/finance/stripe/status` | 200 | `finance.read` | same |
| GET | `/__operator/business/finance/stripe/summary` | 200 | `finance.read` | same |
| GET | `/__ai_usage` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__receptionist/dashboard` | in page (x2) | none: not available to Dot (receptionist call data (the launch is on hold)) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Inbox (`/inbox`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/inbox.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/connections` | in page (x2) | none: not available to Dot (accounts, credentials and mailbox connections) | same |
| GET | `/__operator/connections/skool` | in page (x2) | none: not available to Dot (accounts, credentials and mailbox connections) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/mail-archive/status` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/native-connections` | in page | none: not available to Dot (accounts, credentials and mailbox connections) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Inbox triage (`/inbox-triage`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/inbox-triage.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/inbox/triage` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Calendar (`/calendar`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/calendar.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/calendar/health` | in page (x2) | none: not available to Dot (the founders' calendars) | same |
| GET | `/__operator/calendar/native` | in page | none: not available to Dot (the founders' calendars) | same |
| GET | `/__operator/connections` | in page (x2) | none: not available to Dot (accounts, credentials and mailbox connections) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Agents workspace (`/agents/workspace`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/agents-workspace.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__agents/bots` | 200 | `view` | same |
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/computers` | 200 | `bots.operate` | GET /__computers |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/coding/jobs` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page (x2) | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Activity (`/activity`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/activity.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 (x2) | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Coding (`/coding/`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/coding.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/coding/jobs` | 200 | `view` | same |
| GET | `/__operator/coding/repos` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/coding/accounts` | in page | none: not available to Dot (coding accounts hold sign-ins; the focus is a founder's own) | same |
| GET | `/__operator/coding/focus` | in page | none: not available to Dot (coding accounts hold sign-ins; the focus is a founder's own) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Coding: a job (`/coding/<job>`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/coding-a-job.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/computers` | 200 | `bots.operate` | GET /__computers |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__operator/coding/jobs/*` | 200 | `view` | same |
| GET | `/__operator/coding/jobs/*/events` | 200 | `view` | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x4) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### Memory (`/memory`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/memory.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__claude_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/memory/storage` | in page | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/models` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |

### System (`/system`)

Shows: **data**. Console errors: 0. Screenshot: `docs/programme-20261001/evidence-notes/dot-ui/system.png`

| Method | Path template | Status | Capability | Page asked for |
|---|---|---|---|---|
| GET | `/__app_version` | 200 | `view` | same |
| GET | `/__events` | 200 | `view` | same |
| GET | `/__gateway/ui/jobs` | 200 | `ops.read` | GET /__jobs |
| GET | `/__gateway/ui/jobs/events` | 200 | `ops.read` | GET /__jobs/events |
| GET | `/__health` | 200 (x2) | `view` | same |
| GET | `/__operator/capabilities` | 200 | `view` | same |
| GET | `/__version` | 200 | `view` | same |
| GET | `/__ai_usage` | in page (x2) | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__claude_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__design_index_status` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__design_jobs` | in page | none: not available to Dot (the design studio is the founders' (not granted)) | same |
| GET | `/__dev_restart` | in page | none: not available to Dot (the hub's console) | same |
| GET | `/__devices/me` | in page | none: not available to Dot (devices and sign-ins are the founders' own) | same |
| GET | `/__hermes_models` | in page | none: not available to Dot (model accounts and usage are the founders') | same |
| GET | `/__operator/away` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/conversations` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/events` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/settings` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/status` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/jarvis/timers` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/models` | in page (x2) | none: not available to Dot (the founders' vault, mail, files and own agent chats) | same |
| GET | `/__operator/private-advisor` | in page | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/profile` | in page (x4) | none: not available to Dot (a founder's own profile, away mode and advisor) | same |
| GET | `/__operator/screen/command/thread` | in page | none: not available to Dot (a founder's own Jarvis and conversations) | same |
| GET | `/__operator/state` | in page (x6) | none: not available to Dot (the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs) | same |
| GET | `/__workspace/needs-you` | in page (x4) | none: not available to Dot (approvals, mail, calls and enquiries are the founders') | same |
