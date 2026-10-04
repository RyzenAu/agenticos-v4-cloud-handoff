# Dot's access to AgenticOS through the gateway

For: Dot (the partner agent that owns the AgenticOS backend, working from its own cloud browser and cloud environment), the
owner (Usman) and the lead. Branch `r11/gateway-20261004`. Design history: `docs/programme-20261001/DOT-GATEWAY-DESIGN.md`
(the reviewed read-only gateway this extends). Staging proof: `docs/programme-20261001/evidence-notes/R11-GATEWAY-STAGING-PROOF.md`.

**What changed in r11.** The reviewed gateway let Dot sign in once per browser session and read. Dot now has its own
revocable IDENTITY (a reconnect key that renews short-lived access, in a browser or from a program) and can OPERATE the
system through capability-checked routes: business records, files, Jarvis tasks, memory, coding jobs, shared bot computers
and diagnostics. The hub stays private on the tailnet; the gateway is still the only public surface, and it still forwards
only an allow-list of `/__` routes.

## 1. The access URL

```
https://<public host>/                 the OS (read-only pages: the gateway's built UI bundle)
https://<public host>/gw/enrol         sign in with a one-time code (browser page, or POST from a program)
https://<public host>/gw/renew         new access from the reconnect key (POST)
https://<public host>/gw/me            who am I, my identity, my capabilities, how to renew
https://<public host>/gw/logout        end this access (POST)
https://<public host>/__gateway/...    Dot's operating API (section 8)
https://<public host>/__health, /__version, /__events, ...   the read routes `view` opens
```

`<public host>` is the Tailscale Funnel name of the hub machine (today `ryzen-pc.tail572fa0.ts.net`, port 443). While the
Funnel points at the staging pair it reaches the SYNTHETIC staging hub; after the switch-over (section 13) it reaches the
production gateway. Nothing else on that machine is reachable from the internet: the hub itself (8081) is tailnet-only.

## 2. Enrolment (the owner, once)

1. When Dot is ready (not before: an unused code absorbs wrong guesses), the owner runs on the hub's console, as the account
   that runs the hub, in the checkout the gateway runs from:

   ```
   bun scripts/gateway/cli.ts enrol-code --by usman --label "Dot" [--identity-days 30] [--minutes 10] [--origin https://<public host>]
   ```

   It prints a one-time code (and, with `--origin`, a link with the code after `#`, which never leaves the browser in a URL).
   On the staging pair: `deploy/windows/gateway/dot-gateway-staging.ps1 -Action mint-code`.
2. The owner gives the code to Dot **out of band** (a private channel; never email, a ticket, a repo or a shared doc).
3. Dot redeems it at once (section 3).

The code is **single use**, expires in 10 minutes by default (60 at most), is stored only as a hash, and is **burned after 20
wrong guesses** from anyone (`bun scripts/gateway/cli.ts audit` then shows `code-burned`); the owner simply mints another.
Redeeming it creates Dot's **identity**: a public id (listed in System › Devices and people and by `cli identities`), a label,
who enrolled it, and an expiry (30 days by default, 90 at most). The identity holds no capabilities by itself: a new identity
can only look (`view`) until a founder grants more (section 7).

## 3. Signing in, and the reconnect key

Two ways to hold access; the token is short-lived either way (idle 2 h, absolute 12 h by default, never past the identity's
expiry; set per code with `--idle-minutes`, `--session-hours`).

**In a browser** (the OS pages): open `https://<public host>/gw/enrol#code=...` and press Sign in. The page then shows the
**reconnect key once**. Copy it into your secret store before pressing Continue. The browser holds an HttpOnly, Secure,
SameSite=Strict `__Host-mu_gw` cookie; the page's own requests carry the CSRF token the OS UI already sends.

**From a program** (Dot's cloud environment; no browser, no cookie):

```
POST https://<public host>/gw/enrol
Content-Type: application/json
X-MU-Gateway-Enrol: 1

{ "code": "<the one-time code>", "mode": "bearer" }

-> 200 { "ok": true, "person": "dot",
         "reconnectKey": "mugw_rk_...",                      shown ONCE; only its hash is kept
         "identity": { "id", "label", "enrolledBy", "createdAt", "expiresAt" },
         "access": { "mode": "bearer", "session", "expiresAt", "idleMinutes", "accessToken": "mugw_at_..." } }
```

Then every request carries `Authorization: Bearer mugw_at_...`. A bearer request needs no Origin or CSRF token (no browser
attaches it on its own, so it cannot be forged cross-site); any Origin it does send must be the gateway's own. A bearer token
is never accepted as a cookie, and a cookie value never as a bearer.

**Keep the reconnect key secret.** It is Dot's identity: whoever holds it can get access until the identity expires or is
revoked. Store it only in Dot's own secret store. Never put it, or an access token, in a repository, a commit, a chat or
model transcript, a log, a URL or a screenshot.

## 4. Reconnecting in a new task, and renewing expired access

Same call for both. When a task starts with no access, or a request answers `401` with `"reason": "expired"` or `"idle"`:

```
POST https://<public host>/gw/renew
Content-Type: application/json
X-MU-Gateway-Enrol: 1

{ "reconnectKey": "mugw_rk_...", "mode": "bearer" }        (browser form: "mode" omitted, sent from the gateway's own page)

-> 200 { "ok": true, "identity": {...}, "access": { "mode": "bearer", "accessToken": "mugw_at_...", "expiresAt", ... } }
-> 401 "That reconnect key is not valid..."   unknown, expired or revoked (one answer for all three): ask the owner for a new code
-> 429                                         too many attempts from this address (30 a minute)
```

The reconnect key does not rotate; renewing never needs the owner. One identity holds at most 6 live access sessions at once
(parallel tasks); a seventh ends the oldest. When the identity itself expires, the owner enrols Dot again (section 2).
The 401 for a lapsed request says what to do: `{ "error", "reason": "expired" | "idle" | "revoked" | "unknown", "renew": "/gw/renew" }`.
`"revoked"` means a founder ended this access: do not retry, ask the owner.

## 5. Revocation (the owner, any time; immediate)

| Where | How | Effect |
|---|---|---|
| System › Devices and people | "Gateway access (Dot)" card → Revoke (a confirmed browser) | that identity: every access session it holds and its reconnect key, at once |
| Hub console | `bun scripts/gateway/cli.ts identities` then `revoke-identity <id>` | same |
| Hub console | `revoke-identity --all` | every identity, every session, every unused code |
| Hub console | `revoke-grant <capability>` or `revoke-grant --all` | capabilities only; Dot stays signed in, read-only |
| Hub console | `kill on` / `kill off` | the gateway answers 503 to everything (sign-in included); the hub refuses every assertion |
| Emergency | `deploy/windows/gateway/dot-gateway-emergency-disable.ps1` | KILL file in every gateway data folder, Funnel off, gateway stopped |

Revocation is checked on **every request** at the gateway (it re-reads the founders' control file when it changes) and
**again at the hub** (each signed assertion now names the identity; the hub refuses a revoked identity or session itself).
Open live streams close within about a second. Jobs Dot already started keep running; stop them from Activity. Proven:
`identity.test.ts`, `access.e2e.test.ts` ("revocation: immediate, everywhere"), and steps 51-54 of the staging proof.

## 6. What the gateway enforces on every request

- **Deny by default.** A route that is not in `scripts/gateway/policy.ts` does not exist for Dot. Each rule names one
  capability. The table is enforced three times: by the gateway, by the hub's identity gate (same table, plus the hub's own
  route classes), and by the route itself (the verified capability for THIS request, and Dot's own page token on a write).
- **Dot is never a founder.** Person `dot`, via `gateway`, a process actor: every founder check (`isPersonId`, approvals'
  `isPrincipal`, `isHumanSession`, "at this PC") stays false. It never approves, decides or releases anything.
- **Limits.** 1,200 requests a minute per address, 600 per session, 60 writes per session; bodies over 1 MiB are 413; a file
  write at most 512 KB, a file read at most 2 MB; sign-in 30 attempts a minute per address; renew 30.
- **Origin and CSRF.** Host must be the public host; any Origin must be the public origin; cross-site fetches are refused. A
  browser write needs the page's Origin and CSRF token; a bearer write needs neither (nothing ambient to forge).
- **No secret leaves.** No response carries a token, cookie, key, account path, `.env` value or absolute path. Codes, keys
  and cookies are stored as hashes only. The coding accounts read (sign-in check, plans, usage) is never open.
- **Recorded.** Every request is a line in the gateway's audit (`<data>/gateway/audit-YYYY-MM-DD.jsonl`: person `dot`, the
  session, the identity, the route TEMPLATE, the capability, the status, record ids, the founder who granted it). Every write
  is also a line in the hub's own action log (`hub-actions-YYYY-MM-DD.jsonl`), readable with `ops.read`. Records Dot makes
  are attributed to Dot (CRM: agent `dot` with its gateway session; jobs: owner `dot`; memory: actor Dot).
- **The raw hub is never exposed.** The gateway serves the UI from a built bundle and forwards only listed `/__` routes; the
  hub refuses any non-`/__` path from the gateway principal.

## 7. Capabilities and grants

| Capability | Opens | In `grant operate` |
|---|---|---|
| `view` | every session: read-only pages, coding job reads, `/__health`, `/__version`, `/__events` (coding job events), the capability matrix | always |
| `crm.read` | CRM read operations (snapshot, record, queries, search, follow-ups, drafts list) | yes |
| `crm.write` | CRM write operations: companies, contacts, deals, tasks, activities, projects, documents (as drafts) | yes |
| `files.read` / `files.write` | the approved file roots (section 8.2) | yes |
| `tasks.run` | Jarvis tasks through the Jev-led command path; Dot's own jobs (read, Stop) | yes |
| `memory.read` / `memory.write` | recall; remember (as Dot) | yes |
| `coding.start` | draft a coding job, start Dot's own draft, resume, rerun tests, stop Dot's own job | yes |
| `bots.operate` | shared bot computers: list, start a job, screenshots, take/renew/return the control lease, input | yes |
| `bots.terminal` | a terminal on a shared bot computer while holding its lease | **no: granted on its own** (R9-OPS: bots on one host are not isolated from each other) |
| `ops.read` | diagnostics: the whole job log (`/__jobs`), release receipts, the hub's action log | yes |

Grants always expire (8 h by default, 30 days at most):

```
bun scripts/gateway/cli.ts grant operate --by usman --hours 8
bun scripts/gateway/cli.ts grant bots.terminal --by usman --hours 2
bun scripts/gateway/cli.ts capabilities            what each one opens
bun scripts/gateway/cli.ts status                  what is in force now
```

## 8. The operating API (all under `/__gateway`, JSON)

### 8.1 Business records (`crm.read`, `crm.write`)

`POST /__gateway/crm/read { "name": "crm.record.get", "input": { "ref": { "kind": "company", "id": "..." } } }` and
`POST /__gateway/crm/ops { "name": "crm.company.update", "input": { "id", "expectedVersion", "patch": {...} } }`.
These are the CRM's own typed operations (`scripts/crm/ops.ts`) with the founders' exact validation (strict schemas, version
conflicts, idempotent activities) and the CRM's own receipt. Answers: 200 ok, 422 validation (with `fieldErrors`), 409
conflict, 403 refused, 404 unknown. The CRM itself refuses a gateway principal that lacks the capability or asks for a
founder-only operation, on every path (`gatewayCrmGuard`, called inside `operations.run`), not only on this route.

Never through the gateway (the owner's, always): proposal, invoice and quote drafts, CSV import and export, a document set to
`issued` or `accepted`, an activity that says a message was `queued`, `sent` or `received`, provider evidence, another
person's or agent's attribution, `emailAllowed` / `doNotContact` / `excluded`, moving a deal to a won stage (it starts
onboarding), pipelines, workflows, automations, saved views, duplicate merges. Outreach stays unsent.

### 8.2 Files (`files.read`, `files.write`)

`GET /files/roots`, `GET /files/list?root=&path=`, `GET /files/read?root=&path=`, `POST /files/write { root, path, content,
encoding?: "base64", expectedSha256?: "<hash>" | "absent" }`. Roots by NAME, never a path:

| Root | Where | When |
|---|---|---|
| `drafts` | `<hub data>/gateway/files/drafts` | always (Dot's own working drafts) |
| `designs` | `MU_DESIGN_PROJECTS_DIR` (the design projects the Design page reads) | only when the hub sets it (the Ryzen hub does) |
| owner-listed | `MU_GATEWAY_FILE_ROOTS="name=path;name=path|ro"` | none until the owner lists project roots |

Refused anywhere: traversal, absolute paths, drives, NTFS streams, links and junctions, hard links, dot files, `.env`,
credentials, keys, tokens, sign-in and session files, databases, logs, backups; a root that is or holds the hub's data folder,
a vault, a backup folder or a home. Writes: documents and web assets only, atomic, 512 KB; `expectedSha256` makes a write
conditional; the previous hash comes back so a change can be reversed. Nothing is deleted.

### 8.3 Jarvis tasks and jobs (`tasks.run`)

`POST /tasks { "text": "...", "eventId"?: "stable-id" }` sends the words through the **Jev-led command path** like any new
task (Jev decides the lane; with no Jev key, exact commands run as the labelled fallback). It answers when the command
finishes, or after 20 s with `202 { jobId }`. `GET /jobs`, `GET /jobs/<id>` (steps and result), `POST /jobs/<id>/stop`.
Dot sees and stops only jobs it started; a founder's job does not exist for it. The same `eventId` is the same job.

Dot's tasks run on **Dot's own command service** over the same job store: lanes are pages and the CRM (held to Dot's CRM
capabilities). Dot owns no device, so a desktop request reaches nothing: not the hub's desktop, not a founder's PC or
companion (proven with a paired companion and the hub entry wired in, `operate.test.ts`). Bot conversations, receptionist,
leads, memory-by-voice and skills are not lanes for Dot; use the dedicated routes.

### 8.4 Memory (`memory.read`, `memory.write`)

`POST /memory/recall { query, limit? }` returns business, research and general facts only (personal, deen and finance facts
are withheld and counted). `POST /memory/remember { text, title? }` saves through the memory API with Dot as the actor
(`channel: agent`, a note naming the gateway). It honours `MU_MEMORY_WRITES`: while memory writes are off the answer is
`409 writes-disabled` and nothing is saved. No vault, forget or bucket control.

### 8.5 Coding jobs (`coding.start`)

`POST /coding/draft { utterance, requestId, draftId?, answer? }` (the founders' own drafting step; a program never gets the
Claude planner), `POST /coding/jobs/<id>/start { specDigest }`, `/resume`, `/tests/rerun { commandId }`, `/cancel`, on
Dot's OWN jobs only. Reads: the existing `/__operator/coding/jobs`, `/jobs/<id>` (plan, progress, diff, tests, review),
`/jobs/<id>/events`, `/artefacts/...` (`view`). Jobs run on the hub's own signed-in CLIs with the existing pins and limits;
Dot never sees a token or account folder. There is **no merge route**: merging or pushing to a protected branch is asked and
approved by the owner (the coding page), unchanged. A repository is usable by Dot only when the owner lists `dot` in its
`allowedPeople` (`<hub data>/coding/repos.json`).

### 8.6 Shared bot computers (`bots.operate`, `bots.terminal`)

`GET /bots`, `GET /bots/<name>`, `GET /bots/<name>/screenshot` (watch: a still image; the live VNC viewer is not available
through the gateway), `POST /bots/<name>/jobs { steps, title? }` (the computers service validates steps; send, pay, delete and
publish are refused), `POST /bots/<name>/takeover`, `/lease/renew`, `/return`, `POST /bots/<name>/input { executor, args }`
(the founders' input list: `input.click|type|key`, `browser.navigate`, `observe.page`, `file.write|read`, `computer.info`).
Terminal (`bots.terminal`, while holding the lease): `POST /bots/<name>/terminal`, `GET .../terminal/<id>/events?after=&wait=`,
`POST .../terminal/<id>/input { data }`, `POST .../terminal/<id>/close`; it closes when the lease goes.

Only shared cloud computers exist here. A founder's personal desktop or companion and the hub's own desktop are refused by
the permission table (`mayControl("dot", …)`), by the device resolver (Dot owns no device; only an exact shared computer
resolves) and by the dispatcher's lease guard.

### 8.7 Diagnostics and operations (`view`, `ops.read`)

`GET /__health` and `/__version` (`view`); `GET /__gateway/diagnostics` (sanitised health, version, gateway state),
`/diagnostics/releases` (release receipts: time, old and new commit, rollback tag; never the backup or config paths; needs
`MU_RELEASE_RECEIPTS_DIR` on the hub), `/diagnostics/actions?tail=` (the hub's log of Dot's actions), `GET /__gateway/diagnostics/jobs[/<id>]?kind=&state=&limit=`
(the job log: Dot's own jobs in full; founders' jobs as id, kind, state, timing and step count only, never their words or
Jarvis's replies) (`ops.read`). The raw `/__jobs` log and its stream are never forwarded. `GET /__gateway/capabilities` (`view`) is the live matrix for THIS hub.

## 9. The release workflow (Dot prepares; the release owner releases)

Production releases stay a **single, coordinated step by the release owner at the hub's console**. The gateway has no
release, deploy, restart or shell-on-the-hub route, by design; none will be added.

1. In Dot's own cloud environment: clone the repository, branch from the release baseline (`r11/next-...` or the tag the lead
   names), make the change, run the focused tests and both typechecks (`bun run typecheck`, `bun run typecheck:scripts`) and
   `bun run build`.
2. Push the branch and open a pull request (the PR, not a merge). Include what changed, the tests run and their results.
3. Optionally build a reviewed source bundle: `bun scripts/cloud/release-package.ts build --sha <commit>` (three files:
   tarball, manifest with hashes and a secret scan, SHA256SUMS), and attach the manifest to the PR.
4. Read production through the gateway to support the release: `/__version`, `/__health`, `/__gateway/diagnostics`,
   `/__gateway/diagnostics/releases`, `/__jobs` (with `ops.read`).
5. Hand over to the release owner. They review, merge, and run `deploy/windows/release-ryzen.ps1` on the hub's console
   (backup, fast-forward, health check, automatic rollback, receipt). Dot confirms the new receipt and version afterwards.

## 10. Capability matrix (feature × state)

States: **working** (built, tested, and works once granted) · **missing authorisation** (works, needs the owner's grant) ·
**unsupported** (not available through the gateway, or not on this hub) · **owner action** (needs the owner to set something
up or to do it themselves). "Staging" is the synthetic hub of the proof; "production" is what the switch-over gives.

| Feature / integration | State | Detail |
|---|---|---|
| Sign in, reconnect, renew, logout | working | browser cookie or bearer; proven on staging (steps 4-9, 49-50) |
| Identity listed and revocable (console, Devices and people) | working | immediate at gateway and hub (steps 51-54) |
| OS pages (read-only UI) | working | the built bundle; pages whose data is outside `view` show empty or error states |
| CRM read | missing authorisation | `crm.read`; staging: read back a synthetic record (step 15) |
| CRM write (companies, contacts, deals, tasks, activities, projects, documents) | missing authorisation | `crm.write`; staging: create, update, revert (steps 14-18) |
| Sending email/messages, quotes and invoices to clients, outreach | owner action | the owner's approval, unchanged; refused through the gateway (steps 19-20) |
| Contact permissions, won deals, pipelines, automations, CSV | owner action | founder-only operations |
| Files: drafts root | missing authorisation | `files.read` / `files.write`; staging: write, change, guarded by hash (steps 21-25) |
| Files: designs root | missing authorisation | needs `MU_DESIGN_PROJECTS_DIR` on the hub (set on Ryzen; set on staging) |
| Files: project roots | owner action | the owner lists them in `MU_GATEWAY_FILE_ROOTS` |
| Jarvis tasks through Jev | missing authorisation | `tasks.run`; staging: a page task as a job owned by `dot`, result read back (steps 26-27) |
| Tasks on a founder's PC, companion or the hub desktop | unsupported | by design; refused (step 28) |
| Read and Stop own jobs | missing authorisation | `tasks.run` |
| Whole job log, receipts | missing authorisation | `ops.read` (step 39) |
| Memory recall | missing authorisation | `memory.read`; business, research, general only; staging: memory off, says so (step 32) |
| Memory remember | owner action | `memory.write` plus the owner's `MU_MEMORY_WRITES=on`; refused while off (step 33) |
| Raw vault, forget, buckets | unsupported | by design |
| Coding: draft, start own draft, resume, rerun tests, stop own | owner action | `coding.start` plus the owner listing `dot` in a repository's `allowedPeople`; proven with fake CLIs (`operate-coding.test.ts`); staging has no repositories (step 34) |
| Coding: read jobs, diffs, tests, reviews | working | `view` |
| Coding: merge or push to a protected branch | owner action | no gateway route; the owner asks and approves |
| Coding accounts (sign-in check, plans, usage) | unsupported | never open; tokens stay on the hub |
| Shared bots: list, job, screenshot, lease, input | missing authorisation | `bots.operate`; proven on the in-process bot host (`operate.test.ts`); staging has no bots (step 30) |
| Shared bots: live VNC viewer | unsupported | no WebSocket through the gateway (screenshots instead) |
| Shared bots: terminal | owner action | `bots.terminal`, granted separately; R9-OPS isolation condition is the owner's call |
| Provisioning, starting, stopping or setting up a bot | owner action | founders' routes only |
| Founder's personal desktop or companion, hub desktop | unsupported | never |
| Health, version | working | `view` (steps 35-36) |
| Diagnostics, release receipts, action log | missing authorisation | `ops.read`; receipts need `MU_RELEASE_RECEIPTS_DIR` (steps 37-40) |
| Releasing to production | owner action | the release owner at the console (section 9) |
| Approvals, decisions, job release | unsupported | never Dot's |
| Mail, calendars, transcripts, vault notes, finance, receptionist data | unsupported | not in any capability (owner decision, unchanged) |
| Receptionist launch, money moves, trades | unsupported | holds and money rules unchanged |

## 11. Proof steps Dot runs from its own cloud environment

Against the URL the owner gives (staging first, then production after the switch-over). Capture for each: time with time
zone, request (method and path only), status, and a short summary. **Never** capture a code, reconnect key, access token,
cookie, CSRF token or request body. The script `scripts/gateway/staging-local.ts proof` shows the shape (it was run on a
local synthetic hub; its output is the staging proof).

1. **Baseline and a harmless branch.** Clone the repository, check out the baseline the lead names, create
   `dot/gateway-proof-<date>`, change one line in a doc (e.g. a dated line in your own notes file), commit, push the branch.
   Do not open a merge. Record the branch name and commit.
2. **Sign in to the running app.** Redeem the owner's code in a browser at `/gw/enrol`, store the reconnect key, open the OS
   pages (home, Leads, Coding). Then, from your program, renew in bearer mode and call `GET /gw/me`.
3. **Read and reversibly update a synthetic record.** With `crm.read` and `crm.write` granted: create a company named
   `Synthetic Proof <date>` (`crm.company.create`), read it back (`crm.record.get`), change its `locality`, change it back
   (each with `expectedVersion`), add a `note` activity with `communicationState: "drafted"`. Show that
   `communicationState: "sent"` is refused.
4. **Start a harmless job and retrieve its result.** `POST /__gateway/tasks { "text": "open the leads page" }`; poll
   `GET /__gateway/jobs/<jobId>` until `succeeded`; record the owner (`dot`), the steps and the note.
5. **Access an authorised shared bot.** `GET /__gateway/bots`. If a shared bot exists and `bots.operate` is granted: start
   `{ "steps": [{ "executor": "computer.info" }] }` (or another executor the bot lists in `capabilities`) on it and read the job; take the lease, send one `observe.page` input,
   take a screenshot, return the lease. If none exists, record the honest empty answer.
6. **The supported operations workflow.** `GET /__version`, `/__health`, `/__gateway/diagnostics`,
   `/__gateway/diagnostics/releases` (with `ops.read`); then the release procedure of section 9 for the branch from step 1
   (open the PR; do not merge or release).
7. **Limits hold.** `POST /__approvals/x/decide`, `POST /__operator/screen/command`, `GET /__gateway/admin/access` and
   `GET /__operator/coding/accounts` are 403; ask the owner to revoke your identity and confirm the next request is
   `401 "revoked"` and renewal is refused.

## 12. Staging proof (done, on a local synthetic hub)

`bun scripts/gateway/staging-local.ts seed|start|proof|stop` ran a synthetic hub (127.0.0.1:8194, server role,
`MU_GATEWAY_TRUST=1`, `MU_SYNTHETIC_HUB=1`) and the gateway (127.0.0.1:8195) on the lead's PC, not the Ryzen staging pair and
not production. 59 steps passed as expected; the evidence (summaries only) is
`docs/programme-20261001/evidence-notes/R11-GATEWAY-STAGING-PROOF.md`. The Ryzen staging pair (8086/8096) needs
`dot-gateway-staging.ps1 -Action start -Operate` to prove writes there: without `-Operate` it is a read-only copy and every
gateway write answers 409.

## 13. Switch-over checklist: Funnel from the staging hub to production (lead and owner; NOT done)

Prerequisites (owner decisions): this branch reviewed and released; the capability set to grant; session and identity
lifetimes; who mints codes; audit retention; whether to grant `bots.terminal` at all.

1.  [ ] Release the reviewed commit to production with the normal release (`deploy/windows/release-ryzen.ps1`); confirm
       `/__version` shows it.
2.  [ ] Add to `C:\mu-hub\config\hub.env` (owner): `MU_GATEWAY_TRUST=1`; `MU_RELEASE_RECEIPTS_DIR=C:\mu-hub\logs`; confirm
       `MU_DESIGN_PROJECTS_DIR=C:\mu-hub\designs` is present; optionally `MU_GATEWAY_FILE_ROOTS` (project roots for Dot).
       Restart the hub through its supervisor task; confirm `/__health`.
3.  [ ] Build the production UI bundle from a CLEAN export of the released commit (`dot-gateway-staging.ps1 -Action export
       -Revision <commit>` builds one; or `bun scripts/gateway/build-ui.ts` in a clean export).
4.  [ ] Start the production gateway on 127.0.0.1:8092 with `deploy/windows/gateway/mu-gateway-supervisor.ps1 -RepoRoot
       C:\mu-hub\AgenticOS-v4 -BunPath C:\mu-hub\bin\bun.exe -DataDir C:\mu-hub\data\production -LogDir C:\mu-hub\logs
       -PublicOrigin https://ryzen-pc.tail572fa0.ts.net -UiDir <export>\dist\client -DryRun` first, then without `-DryRun`
       (install it as a scheduled task if it should survive reboots).
5.  [ ] Check locally: `http://127.0.0.1:8092/gw/health` with `Host: ryzen-pc.tail572fa0.ts.net` answers `{"ok":true}`; the
       port's only listener is the gateway process running `scripts/gateway/main.ts`, on 127.0.0.1.
6.  [ ] Prove the new keys and data folders are separate: production has its own `C:\mu-hub\data\production\gateway\
       hub-assertion.key`; staging's key is never copied.
7.  [ ] Turn the staging Funnel off: `dot-gateway-funnel.ps1 -Action off`; `tailscale funnel status` shows nothing on 443.
8.  [ ] Point the Funnel at production: `dot-gateway-funnel.ps1` refuses 8092 by design, so by hand, after the checks in step
       5: `tailscale funnel --bg --https=443 http://127.0.0.1:8092` (verify syntax with `tailscale funnel --help`), then
       `tailscale funnel status` shows 443 → 127.0.0.1:8092 only.
9.  [ ] From a phone off the tailnet: `https://ryzen-pc.tail572fa0.ts.net/gw/health` answers `{"ok":true}`;
        `https://ryzen-pc.tail572fa0.ts.net:8443/` (the hub) does NOT answer; `/__version` without signing in is 401.
10. [ ] Stop the staging pair (`dot-gateway-staging.ps1 -Action stop`) and revoke its identities (`cli revoke-identity --all`
        with `MU_DATA_DIR` set to the staging data folder).
11. [ ] Owner: `bun scripts/gateway/cli.ts enrol-code --by usman --label "Dot" --origin https://ryzen-pc.tail572fa0.ts.net`
        (with `MU_DATA_DIR=C:\mu-hub\data\production`), give the code to Dot out of band; after Dot signs in,
        `grant operate --by usman --hours <n>`.
12. [ ] Dot runs section 11 against production; the owner watches `cli audit --tail 40` and System › Devices and people.
13. [ ] Update `dot-gateway-emergency-disable.ps1` defaults if the production gateway port or data folder differ (they match
        today: 8092 and `C:\mu-hub\data\production`). Rollback at any point: Funnel off, stop the gateway, remove
        `MU_GATEWAY_TRUST` from `hub.env` and restart the hub.

## 14. Known limits

From the one review (4 Oct; the blocker, founders' words in the raw job log, is fixed). Owner decisions, not defects:

- Base `view` (not revocable short of revoking the identity) reads `/__operator/leads/**`, `/__workspace/pipeline` and
  `/__agents/**`: CRM leads and pipeline, and the shared Agents workspace (bot tasks and files). Business data Dot is meant to
  work on; say if `view` should be narrower.
- Grants are global, not per identity: revoke every stale identity (staging's included) before granting on production.
- `coding.start` means code runs on the hub through the coding CLIs under the coding policy; it only takes effect for
  repositories whose `allowedPeople` lists `dot`.
- A founder cannot take a shared bot back from Dot until Dot's control lease lapses (60 to 90 s).
- Dot's memory saves are recorded with `via: "system"`; keep `MU_MEMORY_WRITES` off until the owner wants Dot writing memory.
- The hub checks an identity's revocation on every request but leaves expiry to the gateway.
- An owner-listed file root that is a junction is checked by its literal path, not its target: list real folders only.
- The production gateway port is **8092**: 8090 (the Hermes gateway) and 8091 are taken on Ryzen.

- Funnel's `X-Forwarded-For` is unverified, so behind Funnel the per-address limits act gateway-wide (unchanged).
- The UI bundle has no real `script-src` CSP yet (a production item from the design review, unchanged).
- Dot's live stream (`/__events`) carries coding job events only; Dot follows its own tasks by polling `/__gateway/jobs/<id>`.
- Jobs Dot started keep running after a revocation (stop them from Activity).
- The gateway principal's view of `/__operator/coding/jobs` includes the founders' coding jobs (shared business work, as
  reviewed); each carries account SLOTS and the CLI's resume id, never a token.
