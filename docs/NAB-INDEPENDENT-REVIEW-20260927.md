# Independent NAB review · 27 September 2026

Reviewed read-only: `scripts/nab/{service,basiq-adapter,normalise,insights,fixtures,preview}.ts`, `preview.tsx`, `preview.html`, `scripts/nab.test.ts`, `src/components/finance/nab-connection.tsx`. Inspected imported source `scripts/finance/basiq.ts`, `categories.ts` and the provider-key lookup implementation solely to establish transport/configuration boundaries. No configuration files or real data were read. No specialist files were edited.

## Result

Suitable as an explicitly synthetic, disconnected demonstration after the findings below are triaged. **Not accepted as a safe live banking connector.** This review makes no claim about provider onboarding, accreditation, scopes available on real accounts or live consent. No bank/provider requests were made.

## Concrete findings

### P2 — Provider failure does not reach connection status

`scripts/nab/basiq-adapter.ts:64` catches provider failures and throws a sanitised error, but does not update the service's error/attempt state. Reproduction with actual memory service: successful synthetic adapter read, then a `provider-error` adapter read on the same consent. The second read rejects, yet `service.status(owner)` returns `phase: "fresh", error: null` and retained aggregates. Keeping prior data is reasonable; presenting no failed-refresh state is misleading to a status consumer.

Observed output: `{"probe":"failure-status","phase":"fresh","error":null,"priorDataRetained":true}`.

Requested fix: add a scoped/generation-checked failure-recording operation with a bounded sanitised error code and last-attempt time. Reject late failures after revocation/reconsent so an old job cannot mark new consent failed. Test success → provider failure and revoke/reconsent → late failure. The current UI does not invoke this adapter, so this is an adapter integration defect, not evidence of a current live UI outage.

### P2 — Accounts-only adapter still processes a balance

`scripts/nab/basiq-adapter.ts:45–48` unconditionally calls `listAccounts` and validates `accounts[0].balance` against the fixture. The underlying mapper also requires a numeric balance. For an accounts-only consent, the independent probe completed three synthetic requests (token, connections, accounts), and source confirms the balance is parsed even though no balances scope was granted. The service correctly returns null balance/cash flow and stores no scoped-out balance, so there is **no demonstrated exposure** to the view.

Requested fix before a live adapter: separate identity-only account mapping from balance collection/validation, check the balances scope before processing balance values, and test an accounts-only response that deliberately omits balance. The existing account-only test exercises direct fixture ingestion, not this collection boundary. All current transport records are synthetic.

### P2 — UI does not re-evaluate expiry while left open

`src/components/finance/nab-connection.tsx:10,17–18` stores a status snapshot at mount and after actions. No clock/expiry subscription invalidates it. A view left open beyond its 24-hour consent can continue showing the prior balance and `fresh` label until another action updates status. The service itself checks expiry correctly on every status/import/refresh call. This is a source-established UI state gap; no 24-hour rendered test was run.

Requested fix: expire/hide displayed aggregates at `consentExpiresAt`, and re-read service status on visibility/focus changes. Add a fake-clock component acceptance case. Do not turn the expiry check into a provider refresh or background data collection. Severity is limited by the explicit synthetic-only UI.

### P1 before any live reuse — Inherited Basiq pagination forwards authorization off origin

**Pre-existing dependency, not introduced by the NAB specialist:** `scripts/finance/basiq.ts:198–205,246–255` accepts the provider's absolute `links.next` URL and attaches the bearer header without an origin/user-path check. An independent in-memory transport returned `https://review.invalid/next`; the actual client attempted that URL with an Authorization header. Output recorded only the boolean, never a token value: `{"probe":"inherited-client-pagination","offOriginAuthorised":true,"networkRequests":0}`.

The new `scripts/nab/basiq-adapter.ts:15–16` **does reject other origins inside its closed synthetic transport**, and exposes no injected live transport. `activateLiveNab()` always throws. Therefore this is not a demonstrated credential leak from the new synthetic adapter. It is a concrete blocker to reusing the older client with real transport. Pin HTTPS/origin and expected user endpoint before obtaining/attaching authentication, reject embedded credentials, and fail on unexpected pagination URLs. The dependency also silently truncates at its 30-page ceiling; a live ingest must not label a truncated snapshot complete.

## Independently verified strengths

- `bun test scripts/nab.test.ts`: **20 pass, 0 fail, 98 assertions**, exit 0.
- Tenant map rejects a different owner for an established tenant across status, consent, revoke, audit, import and refresh. Context is explicitly trusted-auth input, not request JSON; the module does not itself authenticate a caller. No server route wiring was evaluated.
- Scope-restricted status suppresses balance and transactions; consent inputs are copied, and returned scope/audit arrays cannot mutate internal state.
- Generation checks run before ingestion and after each adapter await. An additional actual-service probe started a read, revoked, immediately reconsented, then awaited the old read: it rejected and the new consent's cash flow remained null. Existing tests also cover expiry and queued synchronous jobs.
- Revocation clears rows, balances, errors and schedule metadata. Expiry hides aggregates and denies ingestion. Expiry does not physically erase retained rows; a future retention contract must address that distinction.
- Amount parsing uses decimal strings/BigInt; safe-integer aggregate checks reject overflow. Pending, transfers and refunds are separated and GST/profit is not fabricated. Normalisation uses a field allowlist.
- Known fixture IDs only; no arbitrary statement uploads, path reads or live records. Errors/audit entries remain bounded metadata. Fixture state staging is atomic for current fixture validation and arithmetic.
- Basiq adapter transport is closed, fake, and rejects writes except its synthetic token endpoint. Its supplied non-empty synthetic key causes provider lookup to return before any configuration-file fallback. No real secret is needed or read in the exercised tests.
- Adapter executes the existing client but ultimately imports the closed fixture after comparison; it is **not a general provider-response ingestion implementation**. Date equality is not checked against fixture rows and numeric provider mapping loses lexical precision, further reasons not to broaden its claims.
- UI says synthetic/not connected, cannot activate live consent, reads no browser storage and makes no fetch calls. Payment/payee access is absent; invoice matches and recurring charges are suggestions only.

## Independent synthetic probe recipe

Executed as an inline `bun run -` script, with `node:assert/strict` and imports of the actual service, synthetic adapter and existing Basiq client. No test or application files were modified.

1. Create service and explicit synthetic full-scope consent. Read successfully using closed adapter. Read again using `provider-error`; assert rejection and inspect only phase/error/data-presence boolean.
2. Start another read, revoke, reconsent immediately, assert old promise rejects and new cash flow stays null.
3. Create accounts-only consent, read via closed adapter, assert null exposed balance and cash flow; observe request count 3.
4. Create older Basiq client with a non-empty **synthetic** key and entirely in-memory `fetchFn`. Return a synthetic token; first transactions response returns an off-origin `.invalid` pagination link; second response returns empty data. Assert that the off-origin intercepted request contains an authorization header, output boolean only. No URL is fetched over the network.

All additional probe assertions passed. “Pass” here confirms the reported behaviour, including reproduced defects, not overall connector acceptance.

## Review boundary

No changes to NAB/finance specialist files, no live provider checks, no actual transactions, credentials, invoices, account settings or bank consent. Root reported isolated and full app builds passing; those are root evidence, not an independent build performed in this review. Physical/live finance acceptance remains blocked until the owner and provider prerequisites are met and the dependency boundaries are fixed and retested.
