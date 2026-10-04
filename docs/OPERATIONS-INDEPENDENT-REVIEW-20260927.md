# Independent operations review · 27 September 2026

## CURRENT checkpoint — owner requested stop

Work stopped at a safe boundary on 27 September 2026. Preserve all uncommitted files; no commit, merge, deployment, provider call or new agent was made by this specialist. Root must independently review the narrow P3 implementation before accepting it. No specialist-owned process is running.

Completed: economics replacement verification and local draft JSON preview/comparison overflow repair; independent operations cancellation review and durable actual-source tests; model receipt review and root-authorised canonical UUID/safe-token validation repairs. Exact narrow P3 paths and test evidence appear below. Last completed NAB command: `bun test scripts/nab.test.ts scripts/nab/lifecycle.test.ts scripts/nab/manual-import.test.ts scripts/finance/basiq.test.ts` — **46 pass, 0 fail, 310 assertions**, exit 0. Final NAB source was read, including manual import, owner/generation gates, lifecycle, closed adapter and wrapper pagination.

Unfinished: separate final independent synthetic NAB probes announced immediately before the owner interruption were **not executed**; final NAB independent acceptance/report update has not been issued. Root owns legacy finance route admission and browser acceptance. No NAB source was edited. Prior pre-fix NAB report remains unchanged. Broader fleet validation remains qualified: 30 pass / 1 intermittent synthetic PID-file parse failure; that case passed its isolated rerun. Focused P3 tests passed 12/12; TypeScript passed. No broader suite-green claim.

No generated voice samples, narration or media; no provider spending or cost measurements by this specialist. Cost evidence is only deterministic synthetic receipt validation and the inherited dated public-rate economics assumptions, not new bills or live usage. Await a new owner continuation/reassignment; do not resume from this checkpoint automatically.

Read-only review of `src/components/business/mu-operations.tsx`, `execution-receipts.tsx`, `mu-operations.css` and `src/routes/operations.tsx`. Inspected the imported execution route/runtime/journal and host authentication guards to trace the actual boundary. Only this report was written. No production journal, account data, configuration, caller content or credentials were read; no live execution, cancellation or provider request was sent.

## Finding requiring follow-up

### P2 — Accepted cancellation is lost when the subsequent receipt refresh fails

`src/components/business/execution-receipts.tsx:46–58`: the POST returning 202 records its cancellation acknowledgement only in a local variable. The UI displays that acknowledgement after the following list GET succeeds. If that GET times out, rejects or returns invalid receipts, catch replaces it with the generic receipt-service-unavailable message. The same generic message is used when the cancellation POST itself has an unknown transport outcome. The operator therefore cannot distinguish an accepted cancellation with unreadable settlement from an unreadable service before cancellation.

Independent synthetic probe executed the actual extracted `refresh` function from this component with an in-memory transport: token GET → cancellation POST 202 → list GET throws. Exactly one POST occurred; the final message omitted “Cancellation requested” and said only service unavailable/stale/no task resubmission. Successful list GET retained the proper requested-not-settled wording and running receipt. This is UI failure-handling evidence, not a live cancellation test.

Recommended repair: persist/display cancellation acknowledgement as soon as 202 is received and preserve it when the receipt read fails; distinguish an unknown POST outcome and advise status-only refresh before further action. Never call an accepted request a completed cancellation. No source repair was made by this reviewer.

## Verified boundaries and strengths

- The operations route mounts an interface; no execution is initiated on mount, tab selection or refresh. Receipt reads are explicit. Its source comment about reading only catalogue/calculation/synthetic data is now stale because receipts also read real local metadata; this is documentation, not a discovered privacy leak.
- ExecutionReceipts projects responses to ID, status, evidence fingerprint and usage. It validates UUIDs, status values, digest shape and non-negative safe-integer usage; it displays neither task text nor returned provider error text. Authentication remains ephemeral in the request handler and is not stored in component state or browser storage.
- Host middleware checks loopback, host, origin and cross-site requests. `controlReceiptRoute` additionally denies remote callers and missing page tokens, including GET. Two independent route probes returned 403 without instantiating runtime storage. This is the existing single-local-operator model, not a multi-user auth claim.
- Refresh targets only token and receipt GET endpoints. Stop targets the empty-body cancellation POST for an existing validated UUID; it never submits a task or obtains execution approval. No automatic polling, retry or execution replay is present.
- Receipt 202 is correctly described as a request pending settled outcome. A 409 does not claim cancellation. Old rows remain visibly qualified as possibly stale on failure. Unmount aborts the UI transport; it does not claim to reverse an already accepted cancellation.
- Backend cancellation keeps running until settlement, denies late success, and preserves unverified status when child termination cannot be established. Journal claims and one-use task-bound approvals prevent duplicate execution. Worker recovery does not replay interrupted jobs. Public receipts remain metadata; the backend also exposes task digest/risk tier, which this view drops.
- Existing layout uses wrapping tabs, one-column delivery items on narrow screens, focus outlines and a horizontal table container. No browser screenshot or rendered mobile/keyboard acceptance was performed by this reviewer; the receipt scroll container lacks its own keyboard focus target, a minor usability follow-up.

## Fresh verification

- `bun test scripts/jarvis-execution`: **32 pass, 0 fail, 99 assertions**, exit 0. Includes actual isolated synthetic filesystem effect/hash/reopen, duplicate in-flight admission, worker recovery, real synthetic child and grandchild termination, failed termination remaining unverified, and loopback disconnect cancellation. Voice tests use fake media. These tests do not establish physical microphone or general desktop acceptance.
- Independent inline `bun run -` probe: actual extracted UI refresh function, successful and failed post-cancellation reads; exactly one cancellation POST each, no execution/approval endpoints. Transport entirely in memory, synthetic token only, no network requests.
- Same inline probe: unauthenticated-local and authenticated-remote receipt requests return 403; runtime factory touched zero times.

No full build/typecheck or authenticated production request was performed in this independent review. Acceptance is qualified by the cancellation-message finding and lead-owned browser validation.

## NAB coordination

Prior findings remain in `docs/NAB-INDEPENDENT-REVIEW-20260927.md`. Finance freeze has not been confirmed to this reviewer; `docs/NAB-CONNECTION-20260927.md` still lists independent review/freeze as remaining work. Re-review is deferred until the lead supplies the frozen finance paths/revision. Do not treat mutable source presence or prior passing reports as acceptance of the failure-state, scope, expiry or pagination repairs. No NAB source was changed or new banking acceptance claimed.

## Root repair re-review and durable regression coverage

Root moved cancellation acknowledgement/attempt state outside try, publishes 202/409 acknowledgement immediately, preserves it when the status read fails, and reports an unknown cancellation POST outcome separately. Independently re-read the repaired component. The P2 finding above is **resolved for the exercised failure paths**; the original observation remains as fail-before-fix evidence. Root also added a focusable, labelled receipt scroll region and corrected the operations metadata-read comment. Browser rendering/keyboard acceptance remains lead-owned.

Added only `scripts/execution-receipts-ui.test.ts` alongside this report update; no component or runtime edits. The test uses the existing TypeScript compiler to locate/transpile the actual production `refresh`, `validReceipts`, UUID and status declarations, then supplies in-memory transport and captured React state setters. It fails explicitly if source declarations disappear. It contains no mirrored handler, no network requests and no real tokens. This tests handler state transitions, not React mounting, event scheduling or a browser lifecycle.

Fresh command `bun test scripts/execution-receipts-ui.test.ts`: **5 pass, 0 fail, 52 assertions**, exit 0. Cases cover accepted POST + failed GET, unknown POST, ordinary refresh with GETs only, accepted POST + invalid metadata, and 409 + failed GET. Assertions verify acknowledgement is already visible when GET starts, previous rows/check time survive failure, busy settles, unknown outcome directs status refresh before Stop, and exactly one cancellation POST occurs. Ordinary refresh uses the actual metadata validator/projection. No execution-submit endpoint is present in any exercised transport sequence.

The original independent probe reproduced acknowledgement loss before root's source repair. Source was not reverted for testing, preserving concurrent owner work. No IAB, real cancellation or banking success is claimed.

## Bounded model-receipt review

Read-only review of `src/components/business/model-receipts.tsx`, its operations mounting, the registered operator route and `scripts/model-fleet/receipt-sink.ts`. Extended only the existing UI test file and this report. No model calls or production receipt reads were performed.

No blocking privacy/auth/execution finding in the reviewed path. `refreshModels` fetches the local token then `/__operator/model-fleet/receipts?limit=50`, both GETs with no body, and passes the token header to the receipt endpoint. The host registers the route behind its existing loopback/host/origin checks; the route independently denies remote or unauthenticated reads and methods other than GET. Reads open only the dedicated metadata database read-only and never call the model bridge. The sink explicitly projects metadata on append; its flattened response matches the frontend projection.

`projectRows` drops arbitrary additional fields and allowlists provider/model/outcome strings. Null token/cost values remain null; display uses “Unknown”, including null cost, rather than fabricated zero. Failed refresh retains previous rows and gives a bounded stale-data message, without rendering transport error text or retrying a call. Remaining allowance and invoice reconciliation are explicitly unverified. Historical MiMo receipts can be read; this does not select or call that model.

Minor P3 validation follow-up: the shared `usage` predicate accepts finite non-negative fractional token counts and values above the safe-integer range; the dedicated sink has the same rule. Cost may legitimately be fractional, but token counters should ideally require non-negative safe integers separately. The ID regex also accepts any 36-character hex/hyphen arrangement rather than canonical UUID grouping. Neither produces prompt exposure or execution authority with the current generated/allowlisted sink rows. No source repair made here.

Fresh `bun test scripts/execution-receipts-ui.test.ts scripts/model-fleet/receipt-sink.test.ts`: **10 pass, 0 fail, 99 assertions**, exit 0. Two new tests locate/transpile actual production `refreshModels`, `projectRows` and dependent predicates through the TypeScript AST. Synthetic transport proves authenticated GET-only reads, null preservation, prompt/output projection, invalid metadata rejection, stale-row preservation and sanitised failure without new calls. Existing sink tests exercise actual temporary SQLite reopen and synthetic loopback receipt authentication. The bridge test substitutes its executor; no provider is called. This is handler/transport evidence, not browser component lifecycle or production acceptance.

## Root-authorised P3 repair and freeze

Narrow implementation ownership granted by root after the review: `src/components/business/model-receipts.tsx`, `scripts/model-fleet/receipt-sink.ts`, their tests and this report. UI now requires canonical 8-4-4-4-12 hexadecimal UUID grouping. Both boundaries separately require nullable non-negative safe-integer token counts; cost remains nullable finite non-negative and may be fractional. No schema migration, stored-row rewrite, provider call or model selection was made. Existing invalid stored rows fail UI projection instead of being silently corrected. Null remains unknown.

Changed paths in this repair:

- `src/components/business/model-receipts.tsx`
- `scripts/model-fleet/receipt-sink.ts`
- `scripts/model-fleet/receipt-sink.test.ts`
- `scripts/execution-receipts-ui.test.ts`
- `docs/OPERATIONS-INDEPENDENT-REVIEW-20260927.md`

Fail-before-fix evidence: the actual UI projection accepted 36 hyphens as an ID; the real synthetic SQLite sink accepted a fractional token value. New tests failed on those behaviours before source repair. The first sink fixture used `:memory:` and hit the existing Windows `mkdir('.')` behaviour; switched the fixture to a unique temporary SQLite path before establishing the real rejection failure. No unrelated production fix was made.

After repair, `bun test scripts/execution-receipts-ui.test.ts scripts/model-fleet/receipt-sink.test.ts`: **12 pass, 0 fail, 144 assertions**, exit 0. Tests cover malformed UUIDs, fractional/overflow/negative/nonfinite token counts, null/zero/maximum-safe tokens, fractional cost and rejection before insertion. Actual-source AST harness includes the new predicate. `bun node_modules/typescript/bin/tsc --noEmit -p .`: exit 0. Impeccable detector: `[]`. Owned-path whitespace check: exit 0.

Broader `bun test scripts/model-fleet scripts/execution-receipts-ui.test.ts`: **30 pass, 1 fail, 223 assertions**, exit 1. Failure was `process-runner.test.ts:38`, output termination case: `JSON.parse` saw unexpected EOF while reading its synthetic PID fixture. No process-runner source was changed. Focused rerun `bun test scripts/model-fleet/process-runner.test.ts -t 'termination: output'`: **1 pass, 0 fail, 2 assertions**, exit 0. This indicates an intermittent fixture-read failure; no baseline run established historical status, and the broader suite is not claimed green. Root should triage or rerun that gate independently.

Frozen, uncommitted for root review. Finance/manual-import writers remain active per root; final NAB review remains deferred. No live finance, browser or provider acceptance is implied by these tests.
