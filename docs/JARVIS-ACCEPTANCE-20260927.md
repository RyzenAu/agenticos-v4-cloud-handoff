# Jarvis bounded implementation and acceptance — 27 September 2026

## END checkpoint — current replacement specialist handback

**CURRENT STATUS — owner checkpoint: stopped at a safe boundary.** All implementation
files remain frozen and uncommitted. Last completed verification remains 448 passing
tests / zero failures / 1,582 assertions / 22 files, project typecheck exit 0 and
scoped diff check exit 0. Subsequent work was source/docs-only retention investigation;
no code changed and no provider command ran. This opening update is documentation only.
No running process, provider job or shell session belongs to this specialist. Temporary
synthetic fixture directories were retained; owner services were not restarted/stopped.
No generated voice samples, generated narration or provider cost receipts were produced
by this specialist. Synthetic fixture usage is not actual spending evidence.

Read-only alternative-executor investigation found no established supported combined
no-history/no-file-log route. Hermes SDK `session_db=None` can lazily reopen the canonical
store (`run_agent.py:300`); agent initialisation creates a sessions directory
(`agent/agent_init.py:1145`), and provider-error diagnostics write full request-body dumps
(`agent/agent_runtime_helpers.py:1271`). `_persist_disabled` is an internal mechanism,
not an established public no-persistence interface. Cline's installed README documents
`CLINE_LOG_ENABLED=0`, but `--data-dir` relocates session storage rather than eliminating
it; SDK `sessionService` injection is marked internal and does not establish suppression
of transcript artifacts. Installed Codex documentation did not establish the combined
guarantee; native source was not available in its local npm package. No binary commands,
configuration, logs or private stores were inspected. Concrete continuation blocker:
a supported executor interface suppressing session stores, transcript artifacts,
diagnostic request dumps and file logging, including failure paths, followed by synthetic
write-detection/cancellation checks and independent review. Whole Jarvis execution is
incomplete; current Hermes control remains fail-closed 503. Await owner reassignment.

Current source is frozen, uncommitted, awaiting root's independent review. Authenticated
metadata-only receipt list/read/cancel is registered in the actual operator middleware.
The durable admission implementation binds a stable UUID to a task digest, deduplicates
running and terminal jobs, and recovers interrupted work as unverified without replay.
**Actual Hermes control launch is fail-closed (503 `hermes_retention_unverified`) before
journal admission/spawn: supported per-task history AND file logging suppression could
not be established in installed source.** This is a material live execution blocker,
not an ephemeral-pipeline claim. Receipt routes and fleet metadata remain available. Owner/policy
are server-derived; supplied owner/permitted fields are rejected. No raw task, transcript,
provider output or error detail is stored in the execution journal.

Final combined focused run: **448 pass, 0 fail, 1,582 assertions, 22 files**. Typecheck
and scoped whitespace check passed. These results replace the historical 414-test
checkpoint as evidence for the current source. Root's concurrent receipt component
is included by project typecheck; this specialist did not change or render that UI.

### Final client and endpoint contract

- `GET /__operator/control/jobs?limit=50`: `{ receipts: ExecutionReceipt[] }`.
  Valid limits are integer 1 through 100; root's UI requests 50.
- `GET /__operator/control/jobs/:uuid`: `{ receipt: ExecutionReceipt }`; missing 404.
- `POST /__operator/control/jobs/:uuid/cancel`, empty JSON `{}`:
  `{ cancelRequested: boolean, receipt: ExecutionReceipt }`; accepted 202, inactive 409,
  missing 404, nonempty/spoofed body 400. Repeated Stop never dispatches new work.
- All three require `X-Claude-OS-Token` from `GET /__token`, loopback, valid local Host,
  and host origin/cross-site checks. Auth failure and recognised remote callers get 403.
  GET also requires the token. Responses use `Cache-Control: no-store`.
- Receipt fields: `id`, `digest`, `tier`, `status`, `evidence`, `usageMicrousd` only.
  Status: pending/running/succeeded/failed/cancelled/unverified/blocked. Evidence is a
  SHA-256 digest or null; missing measured usage is null, never an invented zero.
- `src/lib/jarvis-control.ts` exports `ExecutionReceipt`, `ReceiptUnavailable`,
  `listExecutionReceipts({ fetch?, signal?, limit? })`,
  `readExecutionReceipt(id, { fetch?, signal? })` and
  `cancelExecutionReceipt(id, { fetch?, signal? })`. Helpers acquire ephemeral token
  auth; list/cancel throw on unavailable service. Read returns null for missing 404.
  Root's explicit-fetch panel matches this contract and need not use these wrappers.
- `runHermesTask` keeps its Promise<string> API. Options add `requestId?: UUID`,
  `onRequestId?`, `onReceipt?`. `runControlTask` adds the same options and returns
  `requestId?`/`receipt?` on ControlResult. Supply the saved UUID for an explicit retry;
  existing receipts are read before consuming new approval or dispatching. Different
  task digest is rejected. CLI duplicate 409 returns status/receipt without retry.
  No UUID or raw task is automatically persisted in browser storage. Generated UUID
  is exposed before dispatch, so callers can track it even if transport later fails.

### Exact paths changed by the replacement specialist

- `scripts/jarvis-execution/runtime.ts`: status type repair, validation before journal
  insertion, owner/permitted spoof rejection, acknowledged stop settlement and watchdog
  helper. Parent close waits for tree-stop acknowledgement; failure becomes unverified.
- `scripts/jarvis-execution/routes.ts`: rejects nonempty cancellation bodies.
- `scripts/jarvis-execution/child.ts`: adds `stopOwnedChild`; existing `runChild` API intact.
- `scripts/jarvis-execution/runtime.test.ts` (new): real temporary filesystem child effect,
  concurrent duplicate admission, reopen, lease exclusion, recovery, failed tree stop,
  watchdog stop with real child and static guard of actual Vite watchdog registration.
- `scripts/jarvis-execution/routes.test.ts` (new): actual operator registration over real
  loopback HTTP with synthetic home/state; auth, local/remote, list/read/cancel, missing
  IDs, limit validation, metadata privacy, owner spoof and client reconnect checks.
- `scripts/jarvis-execution/client-receipt.test.ts` (new): duplicate CLI 409 interface,
  stable UUID callbacks and unavailable preview responses. Transport is synthetic.
- `scripts/jarvis-execution/hermes-retention.ts` (new): code-owned fail-closed gate
  before Hermes control admission; no client/environment override.
- `scripts/jarvis-execution/hermes-retention.test.ts` (new): synthetic real HTTP refusal,
  zero executor calls and static guard of gate placement before durable admission.
- `scripts/jarvis-execution/voice-lifecycle.test.ts`: adds pending speculative navigation
  interruption and Stop checks through actual voice orchestration with fake media/tools.
- `scripts/operator-plugin.ts`: cancellation body for existing receipt registration;
  exact authorised `clineBridge({ onReceipt: modelFleetReceiptSink(root) })` hook;
  `modelFleetReceiptRoute` registration under existing host/origin checks. GET
  `/__operator/model-fleet/receipts?limit=50` requires local token before file access,
  returns `{ receipts }` with flattened sink rows plus source/cost metadata. Real
  operator HTTP tests use synthetic SQLite metadata only. Fleet modules remain owned
  by the fleet writer and were not changed by this specialist.
- `vite.config.ts`: removes unused gate import, binds disconnect at admission, prevents
  spawning after disconnect, attaches acknowledged tree stop and routes control watchdog
  through that same path; retention gate before Hermes control journal admission/spawn.
  Other provider routes unchanged.
- `src/lib/jarvis-control.ts`: metadata receipt helpers, explicit stable IDs, callbacks,
  digest-bound reconnect reads and truthful duplicate responses.
- `src/lib/free-voice-client.ts` (preexisting dirty): only new replacement additions are
  aborting reflex on turn invalidation, combined speculative tool signal, pending/late
  outcome wording. All owner and predecessor changes preserved.
- `src/components/operator/voice-companion.tsx` (preexisting dirty): only new replacement
  additions are signal checks around navigate, navigation tool signal forwarding and
  signal-aware `voiceRequest` for open_url. Already applied navigation cannot be undone.
- `docs/JARVIS-ACCEPTANCE-20260927.md`: current report opening and labelled history.

Inherited predecessor paths/changes remain listed in the historical handback below.
No edits to root's `/operations`, its component, fleet writer code, reviewer report,
`use-voice-transcript.ts` or journal implementation during this replacement turn.

### Verification, review findings and remaining boundaries

Commands from `C:/Users/Nebula PC/source/repos/AgenticOS-v4`:

```powershell
bun --no-env-file test scripts/free-voice.test.ts scripts/free-voice-client.test.ts scripts/screen-result.test.ts scripts/jarvis-e2e/screen-result.test.ts scripts/screen-hands/dialog-safety.test.ts scripts/screen-hands/loop.test.ts scripts/screen-hands/away-regressions.test.ts scripts/away-mode/runner.test.ts scripts/jarvis-execution scripts/jarvis-control.test.ts scripts/control-risk.test.ts scripts/control-outcome.test.ts scripts/cline-bridge.test.ts scripts/model-fleet/receipt-sink.test.ts scripts/model-fleet/bridge.integration.test.ts
bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p .
git diff --check -- scripts/jarvis-execution scripts/operator-plugin.ts vite.config.ts src/lib/jarvis-control.ts src/lib/use-voice-transcript.ts src/lib/free-voice-client.ts src/components/operator/voice-companion.tsx
```

Observed 448/0/1,582/22 and exit 0 for both subsequent checks. The initial typecheck
failed on JobReceipt's status intersection, reproduced and fixed. No final focused
test failure remains. No whole-repository test/build or full Vite boot is claimed.

Independent review reconciliation: watchdog legacy-stop finding repaired and tested;
speculative session-signal finding repaired and tested; absent runtime/routes tests
superseded by current new suites. Watchdog wiring evidence combines a static guard
of actual Vite registration and a real synthetic child through the shared helper;
it is not an exercised full Vite/Hermes HTTP request. Receipt routes ARE exercised
through actual operator middleware over real HTTP, isolated from private state.
Restart recovery uses actual on-disk SQLite with seeded synthetic interrupted rows;
no provider work is replayed. Media/recognition and the tree-stop-failure boundary
are synthetic. Existing real child/grandchild tests also pass in the combined run.

Bounded retention source check (no help/provider invocation): installed
`C:/Users/Nebula PC/.hermes/hermes-agent/hermes_cli/main.py:685` calls setup_logging
for CLI before chat dispatch; `hermes_logging.py:203` installs rotating file handlers,
including agent.log/errors.log; `cli.py:2833` opens the session store. Searches of those
source files and run_agent.py did not establish a supported per-task switch suppressing
both persistence paths. Some guessed parser-file paths were absent; no executable was
run to discover flags because startup may load config/logging. No logs, configuration,
credentials or existing session databases were read. `-Q`, oneshot and ignore-rules
are not accepted as retention proof. Restoring control requires a separately reviewed
supported ephemeral executor/mode; synthetic runtime admission tests remain usable.

Remaining external dependencies: a verified nonpersisting Hermes control mode/executor;
root/reviewer acceptance of the final diff; root's
rendered desktop/mobile receipt-panel checks; authorised live Hermes execution and
cancellation/retention review; owner physical microphone, speaker echo/barge-in and
native Windows Save As acceptance. CLI exit 0 without independent effect verification
remains unverified. The receipt usage field is not invoice reconciliation. Runtime
uses a metadata-only SQLite journal and an exclusive worker lease; this specialist
never opened the owner's runtime directory or private journal. Synthetic fixtures
were created in uniquely named temporary directories; no owner process was restarted.
No sends, calls, provider usage, deploy, merge, account changes, purchases, agents or
commits. Dirty owner work and concurrent UI remain preserved.

## Historical interrupted checkpoint — superseded by END checkpoint above

The following snapshot describes the interrupted predecessor turn, not current blockers.

Stopped immediately on the owner's instruction. Preserve all files; no commits.
The **414 passing tests and successful typecheck below predate the latest durable
runtime integration**. Do not present those checks as validation of the current tree.

Latest unverified changes since that stable handback:

- Added `ExecutionJournal.list(owner, limit)` in `scripts/jarvis-execution/journal.ts`.
- Added `scripts/jarvis-execution/runtime.ts`: metadata-only durable admission and
  completion wrapper; server-derived deny policy; fixed server local-owner principal;
  SQLite exclusive worker lease; restart-to-unverified recovery; cached runtime across
  in-process reloads; deferred execution tickets with real-child close/error/abort binding.
- Added `scripts/jarvis-execution/routes.ts`: lazy authenticated local
  `GET /control/jobs`, `GET /control/jobs/:id`, `POST /control/jobs/:id/cancel` handlers.
- Registered those handlers narrowly in `scripts/operator-plugin.ts`; GET receipts
  explicitly require the page token. Remote callers are refused.
- Replaced the direct CLI gate call in `vite.config.ts` with durable runtime admission
  after payload validation, before spawn. Duplicate/policy-blocked requests return
  metadata receipts. Added `X-Jarvis-Request-Id`, early-failure settlement, child-ticket
  attachment and durable runtime cancellation on response disconnect.
- `/operations` UI source and root's operator-plugin test fixture were not touched.

**No tests/typecheck have run after these latest edits. No provider calls, physical
actions, agents, deploys or commits were started. No running shell session, provider
job or child process belongs to this interrupted turn.** All preceding tool calls
completed. The earlier 8081 application process belongs to the owner; leave it alone.

Exact next steps for the replacement Sol/medium specialist:

1. Review the new runtime before running it. Fix the `JobReceipt` type: its current
   `Omit<Receipt, 'owner' | 'permitted'>` still includes `status`, so intersecting
   `'blocked'` does not widen it; omit `status` too. Verify Bun SQLite lease transaction
   semantics, close/recovery, duplicate-worker exclusion, and cancellation settlement.
2. Review actual Vite admission placement and every early-return/error path. Confirm
   cancellation remains registered through process close and that cancellation failure
   stays unverified. Remove the now-unused Vite `controlDispatchGate` import if appropriate.
3. Add synthetic runtime tests: actual temporary-file effect/real child, duplicate
   concurrent CLI ID only spawns once, restart does not replay, wrong binding rejected,
   server policy ignores client owner/permitted values, exclusive lease denies another
   live worker, cancellation updates a receipt only after actual child termination.
4. Add real HTTP/actual operator-registration tests for token-required list/read/cancel,
   remote denial, missing IDs, metadata-only output, and body owner spoof rejection.
   Use isolated synthetic roots/home and existing dependencies; never call providers.
5. Finish the client interface: allow an explicit stable request UUID in
   `runHermesTask`/`runControlTask` and expose it in the result/callback. The current client
   still generates a fresh UUID per invocation and mishandles duplicate 409 as a generic
   failure claiming nothing was done. Return the durable receipt/status without replay.
   Do not edit root's `/operations` UI; document the routes and response fields for root.
6. Run focused suites and typecheck, then update this report to distinguish the new
   validated runtime from the earlier 414-test checkpoint. Independent fleet review
   owns approval-path assessment; preserve the existing nonce checks. Do not commit
   mixed owner files before root review.

Storage intended by the new lazy runtime: `.operator-data/control-execution/jobs.sqlite`
and `worker.sqlite`, metadata only. This specialist did not instantiate the runtime or
inspect those files. Source edits may be observed by the owner's hot-reload server;
that server's runtime state was not probed after these edits. Restart recovery is
lease-protected in the proposed code, but remains untested.

The remaining document is the **previous stable handback**, retained as dated evidence.

Status: integrated local source repairs, uncommitted, awaiting independent root review.
414 focused tests pass / zero fail / 1,389 assertions / 15 files. This is not a
whole-product, live-provider or physical microphone acceptance claim.

## Scope and authority

Checkout: `C:/Users/Nebula PC/source/repos/AgenticOS-v4`, branch `jarvis-voice`, initial
HEAD `a49b42f`. Read the master execution prompt, full 27 September handoff, context
workspace/project instructions and source AGENTS/CLAUDE/start/release instructions.
Used systematic-debugging and verification-before-completion. The meta-prompting
brief for this bounded task is: inspect owner changes; reproduce lifecycle and
execution failures with synthetic inputs; build and integrate minimal repairs;
preserve all unrelated changes; report exact evidence and physical boundaries.
No agents, commits, merge, deploy, sends, real app control or paid provider calls.
No private state, raw logs, credentials or audio were inspected. Bun runs used
`--no-env-file`. All new filesystem/HTTP/child fixtures are synthetic and isolated.

Initial scope allowed only new execution scripts/tests and this report. Root then
explicitly authorised minimal dirty voice-file changes, followed by real control
approval consumption and server-consumer/cancellation changes. Existing owner
Save As and screen-outcome repairs were preserved. No mixed file was committed.

## Findings repaired in actual paths

1. **Typed interruption:** owner-added `runVoiceToolBatch` rejects with AbortError
   when an interrupted tool returns late. The typed caller had `.finally()` without
   a rejection handler. Reproduced: 6 pass / 1 fail, uncaught `AbortError: Stopped`.
   Added the same guarded rejection boundary already used for captured voice.
2. **Mute:** buffered audio/VAD state survived mute and was submitted after unmute
   without new speech. Added buffer/VAD/partial-reflex cleanup. The independent
   browser recogniser also kept capturing: its new test failed (0 stops, expected
   1) before adding stop/restart, muted-result and muted-onend guards.
3. **Approval replay:** a hand-built `{method:'spoken-yes', at:0}` was accepted by
   `mayRunWithYolo`, repeatedly. Gate-issued opaque grants now bind exact task and
   expiry; execution consumes them synchronously before awaiting transport.
   Server grants independently bind SHA-256(task), request UUID, nonce and a
   two-minute lifetime, and are consumed once immediately before CLI admission.
   The old passing known-gap test now asserts refusal and one-use execution.
4. **Actual cancellation:** `controlPc` deliberately ignored the turn signal.
   It now combines turn and session cancellation. `/hermes/task` no longer starts
   unowned warm work; it returns a pre-dispatch 503 fallback. CLI response closure
   calls its existing process-tree kill, through a shared tested binding.
   Cancellation overrides late success and prevents verifier-based success.
5. **Truthful completion:** CLI error events beat partial output; missing terminal
   SSE receipts are unknown outcomes. A watchdog-killed CLI is not successful just
   because it printed something.
6. **Browser transcript persistence:** the voice hook previously restored and
   saved raw text automatically. `useVoiceTranscript` now defaults to disabled,
   skipping store construction, restore, localStorage access and server saves.
   In-memory conversation display is retained. Existing private history was not
   read, migrated or deleted. Upstream Hermes retention has not been certified.

## Capability matrix

| Capability / actual path | State | Evidence | Remaining work / owner |
|---|---|---|---|
| PCM turn detection -> STT -> response -> relisten, `startFreeVoice` | Locally verified with synthetic media/providers | Two turns through actual client; phases return to listening after playback | Owner: physical mic/speaker/echo/latency |
| Typed fallback after provider error | Locally verified | Actual client fails once, then answers next typed turn | Live service recovery unverified |
| Tool interruption and late completion | Locally verified | Actual client AbortSignal abort and late-result suppression; negative-to-positive regression | Root: independently rerun |
| Mute / unmute | Locally verified for capture and optional recogniser | Partial PCM discarded; new speech required; recogniser stops and remains stopped | Already dispatched work is cancelled with Stop, not implicitly by mute |
| Disconnect / reconnect | Locally verified lifecycle | Tracks, worklet ports and AudioContexts close; fresh session has no old history | No claim of browser background/phone reliability |
| Truthful screen outcomes | Existing owner repair, preserved and verified | Structured unverified/limited/stopped outcomes pause tool batch; 255-test existing focused set | Physical desktop evidence still pending |
| Windows Save As | Existing owner repair, synthetic acceptance passes | Wrong focus/native failure/readback mismatch prevent next key; exact native confirmation survives truncated UIA | No new live Notepad/Save As test; no new Save As changes |
| Client approval consumption | Integrated locally | Fabricated/stale/future/tampered/reused grants denied; executor called once | Root review required |
| Server approval consumption | Integrated locally, synthetic transport verified | Exact canonical prompt/task hash/request UUID/nonce; expiry; replay rejection; real HTTP client-to-file fixture | Authenticated loopback token remains trust boundary, not a separate human-identity proof |
| CLI dispatch Stop | Integrated locally; synthetic child transport verified | Real response disconnect aborts actual synthetic child; separate real child+grandchild termination test on Windows | Real Hermes/tool cancellation and usage receipts unverified |
| Browser transcript privacy | Integrated source default | Disabled effect does not instantiate persistence; typecheck | Root review; upstream provider/CLI retention policy unresolved |
| Recoverable execution receipts | New helper locally verified, **not wired into /operations** | SQLite metadata journal; duplicate connections; restart-to-unverified; atomic approval consumption; synthetic file hash; usage stored once | Root owns `/operations` server integration |
| Wake word / phone / background audio | Not assessed or claimed | None | Separate opt-in/hardware acceptance |

A loopback listener was observed on port 8081 (PID 90128). This is only listener
evidence; no live voice action or application-data request was made to it.

## Exact changes owned by this specialist

All paths below are relative to the checkout above.

### Existing files

- `src/lib/free-voice-client.ts` (already dirty): **only my additions** are typed
  `runModelLoop` catch; `setMicMuted` buffer/VAD/partial cleanup and recognition
  stop/start/idempotence; recogniser result/onend mute guards. Existing
  `runVoiceToolBatch`, `screenResultPause` import/use and outcome handling are owner work.
- `src/components/operator/voice-companion.tsx` (already dirty): **only my additions**
  are the `controlPc` cancellation comment and combined `AbortSignal.any` replacing
  the session-only signal. Existing structured screen results/feed changes are owner work.
- `src/lib/jarvis-control.ts`: issued approval registry, nonce/expiry shape, future
  pending rejection, synchronous one-use execution consumption; private dispatch
  separation; server approval request and control envelope; terminal SSE receipt
  checking; cancellation wins over late result/verification.
- `src/lib/use-voice-transcript.ts`: optional `enabled` parameter default false,
  disabled persistence effect and accurate initial backup availability.
- `scripts/operator-plugin.ts`: approval-gate import; local authenticated
  `/control/approval` branch; `/hermes/task` changed to pre-dispatch CLI fallback;
  removal of now-unused warm-task/direct-launch imports. No other route changes.
- `vite.config.ts`: gate/disconnect imports; Hermes payload `control` field;
  pre-launch nonce consumption for `yolo`/control requests; more conservative
  Hermes terminal-success test; shared disconnect binding. Other providers untouched.
- `scripts/jarvis-control.test.ts`: exact approval expectation includes nonce/expiry.
- `scripts/control-risk.test.ts`: positive fixture obtains real gate-issued grant;
  synthetic server nonce response and complete SSE receipt. Negative cases preserved.
- `scripts/control-outcome.test.ts`: positive approval fixture uses the real gate.

Root's `scripts/operator-plugin.test.ts` fixture-date edit was not touched.

### New files

- `scripts/jarvis-execution/server-approval.ts` — **used by actual server consumers**.
- `scripts/jarvis-execution/server-approval.test.ts` — negative admission checks,
  real loopback disconnect/child test and client-to-server synthetic file journey.
- `scripts/jarvis-execution/voice-lifecycle.test.ts` — actual client with fake media
  and providers; no physical microphone or network.
- `scripts/jarvis-execution/existing-gaps.test.ts` — repaired negative regressions,
  despite historical filename; it no longer blesses reusable approval behaviour.
- `scripts/jarvis-execution/journal.ts` — metadata-only SQLite receipt/approval helper.
- `scripts/jarvis-execution/child.ts` — bounded trusted child adapter; no shell,
  output capture or inherited environment; waits for tree termination evidence.
- `scripts/jarvis-execution/journal.test.ts` — synthetic real disk, duplicate/recovery,
  usage and Windows child-tree tests.
- `docs/JARVIS-ACCEPTANCE-20260927.md` — this report.

## Verification commands and observed results

Run from the checkout root:

```powershell
bun --no-env-file test scripts/free-voice.test.ts scripts/free-voice-client.test.ts scripts/screen-result.test.ts scripts/jarvis-e2e/screen-result.test.ts scripts/screen-hands/dialog-safety.test.ts scripts/screen-hands/loop.test.ts scripts/screen-hands/away-regressions.test.ts scripts/away-mode/runner.test.ts scripts/jarvis-execution scripts/jarvis-control.test.ts scripts/control-risk.test.ts scripts/control-outcome.test.ts
```

Observed: **414 pass, 0 fail, 1,389 assertions, 15 files**. This is the combined
focused suite, not the entire repository suite. The loopback tests use production
client/gate/disconnect logic but replace the provider executable and route shell;
they do not boot the full live Vite middleware or call Hermes.

```powershell
bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p .
```

Passed, exit 0, after the final control/server/privacy and client mute-guard
additions. Project tsconfig covers src/Vite and their imports, not every
standalone scripts test. Bun test transpiles and executes the standalone helpers.

`git diff --check` restricted to the nine owned existing files passed. An earlier
unrestricted check reported whitespace in concurrent fleet/lead files outside this
scope; those were not modified. No full build, physical test, paid-provider test or
release verification is claimed. Initial failing interruption and recogniser
checks were reproduced before the corresponding repairs and are now passing.

## Integration requests and material limits for root

1. Review/rerun the listed source changes. Stage selectively: the two dirty voice
   files contain owner changes and my additions together. No commit was made.
2. The server refuses generic `yolo:true` requests without a canonical control
   envelope. Existing graph/chat callers that relied on unreviewed `yolo` now get
   403; add a separately reviewed approval UI for them instead of bypassing the gate.
3. Voice control intentionally falls back to the owned CLI, losing the warm/direct
   launch latency optimisation. Restore a warm route only after its own child
   cancellation and outcome acknowledgement are independently established.
4. **Connect `/operations` to `ExecutionJournal`** in the owning server worker:
   authenticate owner; use opaque owner/job UUIDs; derive `permitted` from trusted
   policy, never model JSON; prepare exact task binding; explicitly approve external
   effects; run a bounded executor and independent verifier; expose receipt reads
   and owner-bound cancellation. Reconnect reads the same ID and never resubmits.
   Recover only at exclusive worker startup, marking interrupted work unverified;
   never replay it or silently mint fresh approval. Keep the DB in a deliberately
   selected metadata-only path. Tests used temporary paths only.
5. The journal's usage field is an exactly-once metadata record in micro-USD,
   **not invoice reconciliation**. Missing usage remains null. A returned execution
   promise must mean its child work has settled; adapters must enforce this. An
   unresponsive adapter stays running rather than falsely claiming cancellation.
6. Server nonce/request maps are process-local and bounded fail-closed. Restart
   invalidates approvals, but safe-job durable deduplication still needs the journal.
   The approval endpoint relies on the existing authenticated loopback page token;
   it does not solve compromised-page/XSS authentication.
7. No runtime transcript history was inspected. Browser persistence is disabled,
   but Hermes/provider-side retention needs a separate scoped runtime review before
   any claim that the whole voice pipeline is ephemeral.
8. Physical acceptance: microphone grant/deny; two spoken turns; speaker echo and
   barge-in; mute during speech; Stop during a synthetic child; disconnect/reconnect;
   denied/replayed confirmation; safe synthetic Save As with exact readback. These
   are pending observed tests, not prerequisites for reviewing the local patches.

No external account, provider entitlement, native computer tool or paid allowance
was required for the completed synthetic engineering. Real microphone/speaker,
Hermes end-to-end execution and native desktop acceptance remain external test
dependencies. Nothing was sent, deployed, merged, purchased or committed.
