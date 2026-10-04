# Founder Jarvis: durable plain answers and compound questions

## Scope and source

This PR addresses the two founder-session reproductions reported on 4 October (5 October locally):

1. `Reply with QA JARVIS 20261005 only.` returned an answer but neither message survived reload.
2. `what's the next action for the Westpoint Dental Clinic opportunity deal, and how many open leads do we have?` treated both questions as one company/deal name.

Base: `handoff/claude-dev-baseline-20261004` at `a0da58145e4534dff29aacfd210ef3599f1f3909`. This is the actual sanitized Git baseline, not reconstructed production ancestry. It was still the latest published handoff when work began. Reported running revision `94c0262` is not present in this repository, so no byte-equivalence to that running source is claimed.

Only this new fix is included. The earlier paused journey/integration publication is separate. Claude owns frontend integration and releases; this PR neither deploys nor changes runtime grants.

## Changes

### Plain answers

The existing conversation store now durably binds typed requests to the verified founder, original Jarvis conversation and stable composer request ID. It saves the original words before execution, then the response and final reply before reporting durable completion. Identical completed retries replay the response, including after engine reconstruction. An interrupted request with no durable result fails closed rather than being regenerated. A same-process failed completion save retains the answer for an identical save retry.

The exact QA token and private conversation text are retained, without job-log masking or silent truncation. Capacity and save failures are explicit. Internal receipts are hidden from conversation responses and cannot be injected through client snapshots. Existing owner, draft and Stop boundaries remain intact.

Full wire details and limitations: [plain-answer contract](JARVIS-PLAIN-ANSWER-PERSISTENCE-20261004.md).

### Compound questions

A quote-aware, bounded clause recognizer prevents a record-name capture from swallowing another question. Up to four supported read-only business questions are answered in order through existing delegates. The open-lead count uses the existing `pipelineSummary.open` definition. Jev routing evidence remains intact. Unsupported mixed read/action clauses are refused before any lane or fallback can execute only part of the request. Quoted names, company conjunctions, and note/task text keep their existing meaning.

## Required Claude client integration

The backend alone cannot close the original reload repro: the baseline client omits its composer ID from `/voice/free/turn`, ignores separate save failures, and can fall back to a different command after a typed error.

The separate review proposal is [plain-answer-client-review.patch](../review/plain-answer-client-review.patch), with [instructions](../review/plain-answer-client-review.md) and [exact original/proposed hashes](../review/plain-answer-client-review-manifest.json). It is a patch asset only; this PR does not modify any `src/` file. Review and reconcile it with the actual current frontend before applying. Integrate the new backend contract and client together.

The client proposal waits for matching persistence receipts, retains unsaved words/answers and request identity, retries saves without rerunning completed tools, and prevents generic command fallback on uncertain typed failures. Scoped bots retain their previous lane; this new protocol is limited to the ordinary founder Jarvis lane. Reload with an interrupted browser-tool checkpoint fails closed rather than guessing whether a tool ran.

## Verified

All checks used synthetic temporary HOME, data and vault directories. No real provider/account action or client communication was used.

- Exact baseline plain-answer regressions: 0 passed / 4 failed. Candidate: all four pass.
- Exact baseline compound HTTP-command-route regression fails with the reported combined-name error.
- Combined candidate: **262 passed, 1 Windows-only skip, 0 failed, 1,355 assertions across 14 files**.
- Separate compatibility projection of the nine verified backend blobs from historical canonical `12432c71` (including already integrated PR #3/#4): **109 passed, 0 failed, 372 assertions across six targeted files**. The changed service merged cleanly with those admission changes. This is a source-only compatibility fixture, not current production proof.
- Actual proposed client helper paired with the real backend: **3 passed, 17 assertions**. Exact QA text reloads once; failed initial save prevents generation; lost response plus engine reconstruction replays without a second model call.
- Independent backend reviewers cleared both changes after retesting their concrete findings.
- Separate Claude client proposal: **27 focused tests passed, 106 assertions**; strict helper/event TypeScript, both TSX syntax checks and clean patch application/hash reconstruction passed. The actual adapter preserves captured command context, refuses stale typed spoken-approval reuse, and honours queued-request cancellation.
- Typecheck attempts are blocked by missing dependencies/modules in the partial source export. They are not reported as passing. Full build, current rendered frontend, microphone and Windows sharing tests remain release-owner gates.

Run the backend checks with `bash handoff/review/run-jarvis-regressions.sh` from an isolated source copy with the existing dependencies installed. The script refuses missing files and creates its own synthetic test home. It performs no install or release.

After applying the reviewed client patch in an isolated copy, the paired test is `handoff/review/verify-plain-answer-seam.test.ts`. Set `BACKEND_REVIEW_ROOT` and `CLIENT_REVIEW_ROOT` to the isolated backend/client source roots, then run it with Bun in the same synthetic environment as the script.

## Integration and acceptance

Do not replace shared production files wholesale. Import the reviewed diff and preserve newer changes, including canonical PR #3/#4 admission/Stop/Windows fixes and any later frontend/gateway work. Reconcile any pending PR #6 conversation-capacity changes with the typed capacity error documented above.

After Claude integrates the client and backend on the current source, verify in a founder session:

1. Send the exact QA request. Inspect the matching saved/complete receipt. Reload and confirm one user message and one exact reply.
2. Retry the same request ID, including a dropped response/reconnect. Confirm no extra message pair or regeneration. Changed words/origin under that ID must be refused.
3. Inject a synthetic user-save failure: retain the draft and ID, show an actionable error, and execute nothing. Inject a final-save failure: keep the answer visible and retry saving the same request without rerunning prior tools.
4. Send the exact Westpoint compound question. Confirm next action then authoritative open-lead count, with the first lookup containing no second clause. Verify a single question and quoted/company-conjunction names still work.
5. Repeat existing Stop-during-job and conversation/draft binding checks. Verify scoped bot and active voice paths remain unchanged.

Claude performs the established full test/typecheck/build and supported backed-up release process. No restart or release is requested here. If acceptance fails, keep this PR unmerged or revert its integrated change before release; if already released, use Claude's existing recorded rollback procedure.

## Remaining limits

Legacy unkeyed callers lack the new persistence guarantee. Durable receipts live with the conversation; deleting that conversation also removes those receipts. The JSON store retains its existing single-hub synchronous atomic-replacement model, not cross-process coordination. Browser-tool exactly-once recovery across a reload is not claimed. Overflow storage, deletion semantics, active voice persistence, and live equivalence to the unpublished running revision are outside this fix.
