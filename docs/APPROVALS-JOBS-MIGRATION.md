# Approvals and jobs: Stage B2 and the gate migration

Stage B2 adds the durable Approval service (`scripts/approvals/`) and the Job/Step/Receipt service (`scripts/jobs/`).
This page covers what is live on the branch, and exactly how each remaining gate moves onto the two services after
the safety-r3 branch merges. The r3 builder owns the screen, away, control and lesson gates until then, so B2 does
not edit them.

## What B2 ships

| Piece | File | Notes |
|---|---|---|
| Principal seam | `scripts/approvals/principal.ts` | The §3.1 type: B1's Principal with `actor` and `displayName` optional (missing actor = process). The resolver is B1's `requestPrincipal`; the interim `loopbackOwnerOnly` was removed at the B1 merge. |
| Refusal list | `scripts/approvals/policy.ts` | Runs before `request`. Only registered consequential actions can be approved; routine actions get no prompt (V7). The only money action is `away.payment`, limited to the V8 scope. |
| Approval store | `scripts/approvals/service.ts` → `.operator-data/approvals.sqlite` (WAL) | request (asked once) / ask (server-internal; the ONE question registry shared with screen, lesson and control) / card (a per-approval nonce for a verified browser session) / decide (spokenYes, uiConfirm or awayCode) / consume (atomic, digest-bound; a mismatch voids the approval) / recordOutcome / recover |
| Job store | `scripts/jobs/service.ts` → `.operator-data/jobs.sqlite` (WAL) | Jobs, masked steps, receipts (`fallbackFrom`, unknown values stay null) and an event log. `run` only admits a queued job. Cancel sets a flag, aborts the executor and tree-kills (`taskkill /t /f`); a stop that isn't acknowledged quarantines the job. |
| Runtime | `scripts/jobs/runtime.ts` | One instance of each service per process. Only the owning server recovers. A quiet second server (`AGENTIC_OS_NO_BACKGROUND=1`) opens both stores read-only. |
| Routes | `scripts/jobs/routes.ts`, `plugin.ts` | `/__jobs`, `/__jobs/events`, `/__jobs/<id>`, `/__jobs/<id>/cancel`, `/__jobs/<id>/release` (asks once, then releases a quarantine after the tree is gone), `/__approvals`, `/__approvals/<id>`, `/…/card`, `/…/decide`, `/…/cancel`. No route creates an arbitrary approval, and no route asks a spoken question (that is the server's own TTS path). |
| History mirror | `scripts/jobs/mirror-run-log.ts` (wired in `operator-plugin.ts`) | Every screen, voice and away run in the screen run log becomes a job with steps. It only reads the run log and changes no gate. |
| UI | `src/lib/job-events.ts`, `src/components/jobs/job-step-log.tsx` | The Jarvis chip (`jarvis-slot.tsx`) starts the bridge. `jarvis:progress` and `jarvis:decision` are emitted from job events. The Inspector's "Agent steps" tab shows the job step log above the Hermes handoffs. |
| Memory forget | `scripts/approvals/adapters/memory.ts` | Implements Stage D's `MemoryApprovals` (`require`/`grant`/`pending`) on the durable service. |
| Coding merge | `scripts/approvals/adapters/coding.ts` | `requestCodingApply` / `consumeCodingApply` for the C4 orchestrator's apply steps. No coding-merge placeholder existed in the codebase, so this adapter is the placeholder. |
| Gate adapters | `scripts/approvals/adapters/gates.ts` | `spokenGate(action)` and `awayGate`, for the post-r3 migration below. |

### Restart semantics (tested)
- **Approvals:**
  - Pending stays pending.
  - Approved-but-unconsumed stays usable until it expires.
  - Consumed is never replayed.
  - A consumed approval with no recorded outcome becomes `outcome: unknown`.
  - **Exception:** away codes are HMAC-keyed in memory, so nothing on disk can approve anything. A pending
    `away.run` or `away.payment` is therefore cancelled at restart (`reason: restart-code-lost`) and has to be
    asked again. An already-approved one stays usable until its 10-minute expiry.
- **Jobs:**
  - `running` becomes `unknown` and is never re-run.
  - `queued` and `awaiting-approval` become `interrupted`, and are not re-run either.
  - Resuming is always a new, explicit job.

## Merging the two parallel branches
1. **B1 (identity): done.** B1 merged at c73b7fd; see "On B1's identity layer" below. `jobsApprovalsPlugin`
   resolves with B1's `requestPrincipal`, checks each principal's OWN page token (`pageTokenMatches`), and takes
   `actor` and the server-only `sessionId` from B1's verified session cookie, never from the file page token or a
   body. A B1 `actor: "process"` (or a missing actor) gets no card even when a session-key-shaped value is present.
2. **Stage D (memory connector): still open.** The live Memory API still uses `createStubApprovals`. Replacing it
   with `createMemoryApprovals(jobsRuntime(root).approvals)` is **not** a drop-in swap:
   - Stage D calls `grant(id, principal, channel)` (three arguments; `scripts/memory/api.ts`,
     `/__memory/approvals/grant`), while the B2 adapter's `grant(id, principal, channel, proof)` requires a fourth,
     server-verified proof. Update the memory API, the route and the voice turn together.
   - **UI grant:** the session comes from B1's `requestPrincipal(req)` on the server, plus B2's one-use card nonce
     (`POST /__approvals/<id>/card` for that session). Never accept a `sessionId` from the JSON body, and never
     return one: the adapter's `proof.sessionId` must be filled from the resolved principal, not the client.
   - **Voice grant:** `{ spokenYes, questionId }` after the server's own `approvals.ask(id, person)`. A bare
     `grant(id, p, "voice")` is refused.
   - After the forget runs, call `recordOutcome(approvalId, outcome)` so a restart doesn't turn it into `unknown`.
   - Test a process caller, the other founder, a forged or revoked session, a changed target, replay and restart
     before replacing the stub. Keep `MU_MEMORY_WRITES` off in any preview while testing.

## Gate migration after safety-r3 (the lead sequences this)
Each migration keeps the gate's refusal logic, which the r3 builder owns, and replaces only its approval state and
history. Do them one at a time, each with its own tests.

### 1. Control (control_pc / Hermes grants)
**Today** (`scripts/jarvis-execution/server-approval.ts`):
- `ControlDispatchGate` holds `questions`, `grants` and `used` in memory.
- `/control/question` calls `ask`, `/control/approval` calls `issue` (`operator-plugin.ts` ~1190), and
  `runtime.ts:217` calls `consume`.
- `ExecutionJournal.approve` mints a second, hashed approval.

**Migrate:**
1. `ask(task)` becomes `spokenGate(approvals, "control.run").request({ args: { task }, requester, summary })` then
   `.ask(id, person)`. Return `{ approvalId, questionId, expiresAt }` to the voice client. (safety-r3's
   `SpokenConfirmationLedger.ask` is already the ONE registry; approvals uses it, so the control gate's own
   `questions` map can go.)
2. `issue(binding, { spokenYes })` becomes `.confirm(approvalId, principal, { spokenYes, questionId })`. Control
   stays voice-only (the policy lists `spokenYes` only), so a typed or UI yes is refused.
3. `consume(binding, prompt)` becomes `.admit(approvalId, { task })` immediately before `journal.run`. Keep the
   `jarvisTaskPrompt` equality check. Keep `used`/requestId replay protection by recording the job's `requestId`
   in `jobs.create({ requestId })`, which is idempotent.
4. The journal's `approve()`/`approvals` table becomes redundant: pass the consumed approval id as the admission
   evidence and drop the second store.
5. History: create a `control` job per `requestId`. Map `ExecutionJournal` statuses as follows:
   - `succeeded` → `succeeded`
   - `failed` → `failed`
   - `cancelled` → `cancelled`
   - `unverified` → `unknown`

   The runtime's quarantine table stays authoritative for admission. Also set `jobs.cancel` → `runtime.cancel`, so
   the job's registered pid is the owned child.
6. **Tests to carry over:** `server-approval.test.ts`, which covers binding, a superseded question, a typed yes and
   replay.

### 2. Screen (screen_act final button)
**Today** (`scripts/screen-hands/index.ts` ~1933): `askedConfirms` (in memory) plus `spoken.redeem(after: askedAt)`.

**Migrate:**
1. Where the loop asks "Press <button>?", call:
   ```ts
   spokenGate(approvals, "screen.press").request({
     args: { window: handle, button: label, automationId, goalDigest },
     ...
   })
   ```
   Then call `.ask(id, person)`, and put `approvalId` and `questionId` in the ask reply.
2. When the confirm comes back:
   - A voice confirm uses `.confirm(id, principal, { spokenYes, questionId })`.
   - A click on the card in a verified UI session uses `.confirmInUi(id, principal, cardNonce)`.
3. Immediately before the press, call `.admit(id, liveArgs)` with `liveArgs` read back from UIA for the element
   actually under the pointer. A different window, button or id voids it.
4. **Money:** `screen.press` has `screenText: true`, so a money label is refused before `request`, on top of
   r3's `screenGoalRefusal` and `moneyButton`. There is no path from a screen yes to a payment.
5. History is already mirrored (`mirror-run-log.ts`). Once the loop itself creates jobs, drop the mirror for
   screen and keep it only for legacy callers.

### 3. Lesson (teach/drive final button)
**Today** (`scripts/screen-hands/index.ts` ~1852): `lesson.pendingConfirmAt` plus `spoken.redeem`.

**Migrate:** as for Screen, but with `spokenGate(approvals, "lesson.run")`. The args are
`{ lessonId, step, button }`. UI confirm is allowed.

### 4. Away mode (and V8 payments)
**Today** (`scripts/away-mode/runner.ts`):
- `PendingApproval.codeHash` in `state.json` (HMAC, key in memory).
- `answer()` (~711) gives 3 tries.
- `recover()` drops pending approvals.

**Migrate:**
1. `finish(outcome.kind === "approval")` becomes:
   ```ts
   awayGate(approvals).requestRun({ args: { taskId, step, confirm, action }, requester, summary, jobId })
   ```
   Send `r.awayCode` on Telegram. Store only `approvalId` on the task; drop `codeHash`, `wrong` and `expiresAt`
   from `state.json`.
2. `answer(yes, code, sender)` becomes `awayGate.answer(approvalId, principal, yes, code)`. The Principal comes
   from B1's resolver for the owner's Telegram chat (`via: "telegram-owner"`). The only other accepted channel is his
   OS card in a verified browser session, with the card nonce (`answer(…, code, cardNonce)`); any other local
   process is refused. The three-tries rule, constant-time
   comparison and 10-minute expiry are now in the service.
3. Resuming the approved step calls `awayGate.beforePress(approvalId, "away.run", reverifiedArgs)` immediately
   before it runs.
4. **V8 payment:** when r3's away policy recognises an approvable payment, build `AwayPaymentArgs` from the live
   page:
   ```ts
   {
     taskId,
     host: new URL(page).hostname,
     payee: { id, name, saved: true },
     amount: { minor, currency },
     element: { label, ref },
     category,
   }
   ```
   `origin` is `"principal"` only when the payment came from the owner's own away task text. Anything read off a
   page, email or file is `"observed-content"` and is refused before `request`. Then:
   1. Call `requestPayment`.
   2. Send the code.
   3. The owner answers with `answer(…, "yes", code)`.
   4. **Re-verify the page** and rebuild the args from what is on screen now.
   5. Call `beforePress(id, "away.payment", reverified)`. Any change voids it.
   6. Press once.
   7. Call `afterPress(id, outcome)` and write the job step and receipt.

   Trades, crypto, betting, new payees, typed card, password or OTP entry, and an out-of-scope category are all
   refused by `policy.ts` before anything is stored. The agent never types credentials: the args carry none.
5. History: `recover()` in the runner becomes a no-op for approvals, because the service owns them. Away tasks
   become `away` jobs; mirrored runs already are.
6. **Tests to carry over:** `away-mode/runner.test.ts`, which covers the approval flows, three wrong codes and
   restart. The V8 cases in `approvals/service.test.ts` and `adapters.test.ts` already cover the service side.

### 5. Coding merge (C4)
The orchestrator's apply step calls `requestCodingApply` once. Jarvis asks, and the owner answers by voice
(`approvals.ask` plus a spoken yes) or in the UI. Immediately before the merge or push, the orchestrator calls
`consumeCodingApply(id, live)`, where `live.fromSha` is the current job head. After verifying from the source, it
calls `recordOutcome`.

## Checks after each migration
1. `bun --no-env-file test scripts`, with no new failures against the baseline.
2. `bunx tsc --noEmit -p .` returns 0.
3. Restart the server with a pending approval and a running job. Confirm the pending approval is still pending,
   the running job is `unknown`, and nothing ran twice.
4. Send one real spoken yes through `/voice/free/stt` and confirm the Inspector shows the step and decision.

## Review fixes (REVIEW-B2, 28 Sep)
- **Money destinations** come from safety-r3's shared institution table (`moneyHostKind`, `moneySurfaceKind`),
  applied to the host, payee name, payee id and button, with compound and look-alike folding (a brand plus up to
  5 extra characters: `mystake`, `coinspot-login`). Brokers, exchanges and betting are refused. The currency must
  be ISO 4217 (no XBT or XAU).
- **Every registered action** has all its keys and values money-screened, with no silent cap: past 32 levels,
  5,000 nodes or a 20,000-character string it's refused. Top-ups, credit purchases, auto top-up, plan upgrades
  and billing are never approvable, including through `provider.config.change` and `account.change`.
- **A stop that is ignored** is recorded as what happened (`succeeded`, with a note), and the job's kind is
  quarantined.
  - An executor that hasn't settled within the grace period after a stop is quarantined (`unknown` until it settles).
- **Cancel checks each child's identity** before killing: PID plus creation time against the OS process table.
  - A child that has exited, or whose PID now belongs to another process, is never killed.
  - An identity that can't be verified, or an unreadable table, quarantines without killing.
- **Quarantine release:** child trees are persisted, so release works after a restart. Release is
  `POST /__jobs/<id>/release`: it asks once (`jobs.release-quarantine`), then clears the hold only after the
  approval and once independent process accounting shows the tree gone.

## R2 re-check fixes (28 Sep)
- **Orphans:** each running job's process tree is snapshotted (PID plus creation time) when a child is
  registered and every 5 s while it runs.
  - An exited child's row is kept, so its descendants are still found. So is anything still parented by a
    dead owned PID, since Windows keeps the ppid.
  - Cancel kills every owned process whose identity matches, then reads the OS process table AGAIN. Any
    survivor means the stop isn't acknowledged, and the job is quarantined.
  - A Windows Job Object would be stronger, but it needs native code. The snapshot and re-check need none.
- **Executor contract** (documented on `ExecutorContext`, tested):
  - after a stop, return `{ ok: false }`;
  - register every spawned process at once;
  - call `childExited` on a natural exit;
  - settle within the grace period.

  `ok: true` after a stop is recorded as completed and quarantined. A late settle is noted as "Stopped late".
- **Money refusal keys on money ACTIONS:**
  - Only press surfaces (screen, control, lesson, away.run) keep the full screen: bank names, money buttons and
    amounts on labels.
  - Every other action refuses a money verb with an amount, credits or funds ("pay $20/mo", "buy 1000
    credits"). It also refuses billing CHANGES (top-up, auto-reload, plan switch, credit limit, payment method).
  - Message and page COPY fields (body, subject, copy…) may name prices and invoices.
  - `feat/stripe-billing`, "billing page copy" and invoice emails are askable.
- **`provider.config.change` is one allowlisted setting:** `{ provider, setting, value }`, where `setting` is one
  of model, fallbackModel, enabled, timeoutMs, maxOutputTokens, temperature, region, priority or retries. Free
  text, credit limits, auto-reload and plans can't be expressed.
- **Payees:** a name is refused only when it is ENTIRELY institution: brand runs plus qualifier words (legal,
  region, account and money words). Any ordinary word ("Kraken Rum Co", "Stake Dental") makes it another
  business.
  - The host remains strict evidence, and an internationalised (punycode) host is never a payment destination.
  - Pepperstone and other AU CFD brokers are covered by a small list in `policy.ts`, **to upstream into
    safety-r3/r4's shared INSTITUTIONS table.**
- **Runbook:** until B1 provides verified browser sessions and the TTS path, a quarantine can only be released
  after B1 (or by a DB edit). This fails closed. B1 should consider dropping `samePrincipal` for human sessions
  (REVIEW-B2 R2 condition 2), and keep refusing automation principals.

## Process vs human requests (B1 R2 rule, 28 Sep)
- **Who can answer a request depends on who made it**, using B1's `Principal.actor`. A missing actor counts as
  `process`, so this fails closed until B1.
  - **Requested by a process or agent** (a coding job, Hermes, the away runner, the screen loop, curl): a UI
    confirm never counts. At the PC, any local program can send browser-navigation headers and get a "human"
    session. Only evidence a local process can't mint answers it:
    - the server-recorded spoken yes (voice-pipeline STT, stamped with the question);
    - the one-time code the owner sends back from his Telegram DM (`telegramCode`, from a `telegram-owner`
      principal). `request` returns the code once; the caller sends it to the owner's DM.
  - **Requested by a human in the UI themselves:** the approval card (session plus card nonce) is valid, in the
    same session too. The away code on the OS card is also accepted only for a request he made himself.
  - This replaces the earlier "approver ≠ requester" check (`samePrincipal`), which R2 showed wasn't a boundary.
- **Limit, stated plainly:** same-user local processes can drive the owner's browser and read its cookie store.
  This guards against agents and scripts calling the API. It does NOT guard against malware running on the
  owner's Windows account.
- **Paths:** the plugin decides on the RAW request path and serves only `^/__(jobs|approvals)(/[A-Za-z0-9-]+)*$`.
  `/x/../__jobs`, `/__jobs/`, `/__jobs/./events`, `//`, `%2e%2e`, encoded slashes and backslashes get 400; they
  are never normalised into a route. B1 lists `/__jobs` and `/__approvals` in its route table and rejects
  non-canonical paths too, so neither side normalises its way around the other.

## On B1's identity layer (merged into this branch at c73b7fd, 28 Sep)
- **Resolver:** `jobsApprovalsPlugin` resolves the caller with B1's `requestPrincipal`, the same principal the
  identity gate resolved. B2's interim `loopbackOwnerOnly` resolver and its own relay-header list are gone;
  proxied requests are decided by B1 (`hasRelayHeaders`).
- **Page token:** a write needs the caller's OWN page token, checked with B1's `pageTokenMatches`. That is
  the internal token only at this PC; a remote founder uses his per-person token, since he never receives the
  internal one. So Mehroz's writes are no longer 403.
- **UI session:** the UI-confirm rule uses B1's `isHumanSession` and `isBrowserPrincipal`, plus the session key.
  B2's Principal type is B1's with `actor` and `displayName` optional, and a missing actor counts as a process.
- **Session keys stay on the server** (S1 AUDIT-A1-1, with the recon tests, 28 Sep): the card's one-use nonce is
  bound in memory to the live session key, and the stores no longer keep B1's `sessionId` in requester, approver
  or job principals. Every `/__jobs` and `/__approvals` response (lists, details, events, decide/cancel results,
  errors) is serialised through `publicJson` (`scripts/approvals/principal.ts`), which drops a principal's
  `sessionId` and `deviceId` and any `sk1.` value, including rows stored before the fix, for both founders.
  Tested in `scripts/jobs/routes.test.ts`, `scripts/identity/route-matrix.test.ts` and
  `scripts/identity/s1-security.test.ts`.
- **Paths:** B1 classifies `/__jobs` and `/__approvals` as shared routes and refuses non-canonical targets
  first. B2 keeps its own raw-path check as well.
- **Telegram codes** (`telegramCode`, and away codes from Telegram) are decided in-process by the Telegram
  handler, using B1's `resolveTelegramPrincipal`. They never go through the HTTP decide route, because
  `pageTokenMatches` accepts browser principals only.
- **Gap to raise with B1:** its `RELAY_HEADER` doesn't list `true-client-ip`, `cf-connecting-ip`,
  `x-client-ip` or `x-cluster-client-ip`, which B2's own list had. This isn't reachable through Tailscale
  Serve, but it belongs in the one shared list.
