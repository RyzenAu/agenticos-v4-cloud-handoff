# Historical NAB evidence — before file-import implementation

These are dated pre-file-import reports and checkpoints. They are preserved as evidence, not current status or current blockers. See NAB-CONNECTION-20260927.md for the final implementation and verification.

# NAB connection: synthetic implementation and live decision

27 September 2026. Bounded specialist handoff; uncommitted, pending lead review.

## Replacement specialist freeze — 27 September 2026, approximately 15:43 Sydney

**Frozen for independent lead review; no commit.** This section supersedes historical verification counts and the STOP checkpoint's remaining work. Owner confirms NAB BUSINESS account type only. No live consent or real-data permission is inferred.

Changes made by the replacement specialist:

- `src/components/finance/nab-connection.tsx`: explicit opt-in start/stop controls for the existing synthetic scheduler; one/seven/thirty-day synthetic permission duration; scheduler stopped on permission replacement, revoke and unmount; truthful NAB Business eligibility wording. Named manual built-in imports remain the only import interface, with no upload or watched folder.
- `scripts/nab/lifecycle.test.ts`: mounted React/manual import/scheduler integration case proves duplicate import leaves totals unchanged, due refresh occurs once, stop/revoke remove the scheduler timer, and unmount removes all timers. Existing expiry/focus/visibility cases retained.
- `scripts/finance/basiq.ts`: malformed legacy account and connection lists now reject instead of succeeding as empty results. Corrected the misleading read-only header: legacy user-create and connection-refresh methods exist and need separate root admission guards. Preserved earlier pagination/decimal hardening.
- `scripts/finance/basiq.test.ts`: new check covers malformed identity/decimal/numeric account and connection reads plus `redirect: error` on token and authenticated dispatch. This verifies request policy with in-memory interception, not live redirect transport acceptance.
- `scripts/nab/preview.ts`: `--build-only` compiles without binding a port; optional `--port=4190` permits isolated final review without replacing the existing 4188 preview. No app config or environment file loading; no files written by the bundle build.
- `docs/NAB-CONNECTION-20260927.md`: reconciled stale wrapper/scheduler/expiry descriptions and recorded this freeze.

Inherited owned candidate paths also preserved: `scripts/nab/normalise.ts`, `scripts/nab/fixtures.ts`, `scripts/nab/insights.ts`, `scripts/nab/service.ts`, `scripts/nab/basiq-adapter.ts`, `scripts/nab/lifecycle.ts`, `scripts/nab/preview.tsx`, `scripts/nab/preview.html`, `scripts/nab.test.ts`. Together with the six paths above, these are the complete NAB specialist candidate. `docs/NAB-INDEPENDENT-REVIEW-20260927.md` is preserved unchanged as independent pre-fix findings. Economics source and other concurrent tracks untouched.

Fresh verification:

| Command/check | Observed result |
|---|---|
| `bun test scripts/nab.test.ts scripts/nab/lifecycle.test.ts scripts/finance/basiq.test.ts` before replacement edits | 37 pass, 0 fail, 205 assertions |
| Same command after all implementation edits | **39 pass, 0 fail, 228 assertions**, exit 0 |
| `bun node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext --moduleResolution bundler scripts/nab/service.ts scripts/nab/basiq-adapter.ts scripts/nab/lifecycle.ts src/types/bun-sqlite.d.ts` | Exit 0 |
| `bun node_modules/typescript/bin/tsc --noEmit -p .` | Exit 0 on the concurrent checkout at this check; supersedes the older cline-bridge failure, not a frozen all-track acceptance |
| `bun scripts/nab/preview.ts --build-only` | Exit 0; 42 modules, three in-memory assets, no server started |
| `bun scripts/nab/preview.ts --port=4190` | Fresh compiled server, 42 modules; actual UI reviewed through the in-app browser |
| Impeccable `detect --json src/components/finance/nab-connection.tsx` | `[]`, exit 0; mechanical check only |
| `git diff --check -- scripts/finance/basiq.ts scripts/finance/basiq.test.ts scripts/nab.test.ts scripts/nab src/components/finance/nab-connection.tsx docs/NAB-CONNECTION-20260927.md` | Exit 0; Git does not inspect untracked files with this command |

Rendered evidence: actual seven-day permissions with balance/transactions selected → built-in import displayed A$2,315 balance and A$915 cash movement, seven changed entries. Repeat import displayed zero changed entries with unchanged amounts. Starting/stopping automatic refresh changed its visible state and action label. Revoke displayed `revoked`, both amounts `Not shared`, and disabled import/scheduler controls. Desktop requested 1440×1000: DOM client/scroll width both 1425. Mobile requested 390×844: both 375. Screenshots observed in tool output; no persistent screenshot artifact claimed. Timer/expiry and full daily scheduler progression are mounted React/fake-clock evidence, not an elapsed-day browser observation. Provider tests use closed in-memory transport, zero live banking requests. No mock or health check is claimed as live acceptance.

Failures/limits: no final test/type/build failure. Initial visible-browser creation was unsupported in a specialist thread; background IAB review succeeded. A first tab binding failed and was recovered using the returned exact tab ID. Two documentation reads used the repository instead of memory-workspace root and one optional skill reference path did not exist; relevant workspace files and applicable skill/context/craft instructions were read from their correct paths. No product source failure inferred from those tooling errors.

Process cleanup: replacement-owned preview exec session 45024 on 4190 was stopped after review; its exit 1 reflects Ctrl-C termination. Browser viewport override reset and replacement-created tab closed. Inherited preview session 35839/4188 left untouched and may still serve the pre-repair bundle. No private/production process inspected or stopped.

Remaining external dependencies: independent root review and authorised path-scoped commit; root's authenticated legacy-route admission checks and combined Operations review; provider acceptance/representative arrangement, verified specific NAB Business product/nominated representative eligibility, written costs/cap and agreed retention/processor terms; supported secure durable token/data lifecycle, bank-hosted live consent and separately approved live acceptance. Future production scheduling requires separate scope. The current adapter compares closed known fixtures and does not ingest arbitrary provider responses. No new provider research or external request was made in this replacement pass; the earlier source-backed route assessment below remains dated evidence.

No agents, sends/calls, bank/provider requests, consent, account changes, purchase, deployment, merge, commit, new external destination, real bank/client data or economics source edit occurred. Freeze is local synthetic engineering completion for review, not connected-banking or whole-project completion.

## What exists

`NabConnection` is a working, memory-only React component. Named and default exports are available. Root mounts it on `/operations`. It creates the actual `createNabSyntheticService` instance and performs scoped permission, fixture import, duplicate protection, refresh eligibility and revoke/erase transitions. Every state says **Synthetic / not connected**. It makes no HTTP requests and has no links to legacy finance routes, credentials, consent URLs, upload inputs or private records. Leaving the view discards state.

This is a synthetic adapter and UI, **not a live bank connection**. An optional in-memory scheduler has explicit start/stop UI controls; construction schedules nothing. It refreshes built-in samples when due and stops on expiry, permission changes, revoke or unmount. No OS task or production scheduler is installed. A separate UI invalidation timer hides expired aggregates and rechecks on focus/visibility without collecting data. An owner-initiated import fallback accepts named built-in synthetic fixtures only. Arbitrary CSV uploads and watched folders remain unavailable until real-data scope is separately approved. Sample permissions default to one day, with seven- and thirty-day choices for synthetic scheduler testing.

## Supported route recommendation and evidence

Recommend keeping the local synthetic/import path now. For a future custom business integration, first obtain Basiq acceptance under its principal/representative model and a written commercial quote. This is a conditional engineering recommendation, not evidence that M&U is accepted or that Basiq is cheapest. Basiq explicitly says it is B2B and cannot assist personal-use CDR requirements; an owner-only use case may be declined. If so, choose a supported B2C product or retain the manually initiated import path rather than pretending a personal NAB developer API exists. [Basiq access models](https://api.basiq.io/docs/supported-access-models), [Basiq contact/eligibility](https://www.basiq.io/contact.html).

| Route | Coverage, scopes and eligibility | Cost evidence | Refresh, retention and effort |
|---|---|---|---|
| Basiq representative | Approved partner arrangement; consented NAB accounts/transactions; Basiq identifies itself as ADRBNK000208. Product/account acceptance still unverified. | No numeric production tariff verified on reviewed official pages. Written setup/minimum/active-user/refresh/overage/GST quote required; do not assume free API. | Hosted consent and existing app wrapper reduce engineering work. Official guidance recommends Smart Cache, checking last refresh and avoiding excessive refreshes; no universal 24-hour SLA established. Retention governed by agreed purpose/consent and law. |
| Frollo business platform | Official enterprise Open Banking offering for banks, lenders and wealth providers; states it is an ADR. M&U commercial eligibility and NAB account/product coverage need confirmation. | Official business page directs enquiries to sales; no numeric API quote verified. Consumer app access is not an API entitlement. | Managed data collection/consent platform; refresh SLA, retention terms and integration contract need confirmation. More new integration work than reusing the Basiq wrapper. |
| Direct accredited recipient | Accreditation plus register onboarding/conformance; a NAB customer login alone does not grant recipient API access. | NAB charges neither customer nor accredited recipient for CDR sharing. That does not eliminate accreditation, security, insurance or engineering costs. | Highest implementation/operating burden for this small internal tool. Do not recommend starting here. |
| Owner-selected manual import | No recipient API connection; owner chooses exactly what to import after separate real-data authorisation. Currently built-in synthetic fixtures only. | No connector usage cost in this implementation. Real export/import has owner time and reconciliation costs. | Manual, not continuous; source time and stale state required. No watched Downloads folder. Local ephemeral retention here. |

Official sources reviewed on this task:

- [NAB Open Banking](https://www.nab.com.au/customer-notices/open-banking): eligible personal/business products and sharing roles; Internet Banking access and SMS security requirements; NAB Connect customers need Internet Banking registration for CDR sharing; consent can be managed in NAB. The owner's actual product, business-nominated representative status and eligible accounts were **not inspected**.
- [CDR accreditation](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient) and [current provider register](https://www.cdr.gov.au/find-a-provider): accreditation/onboarding requirements and representative arrangements. An API key is not accreditation or account consent.
- [Basiq access models](https://api.basiq.io/docs/supported-access-models): representative acceptance and principal disclosures required. Do not display a claim that M&U is accredited.
- [Basiq consent scopes](https://api.basiq.io/docs/consent-scopes): proposed `bank:accounts.basic:read` (basic account information/balance) and `bank:transactions:read`. Do not request detailed account numbers, customer/contact information, payees, payment initiation or unrelated scopes. The UI's accounts/balances split is a local minimisation choice, **not** a claim that the provider offers those as separate OAuth scopes.
- [Basiq hosted consent](https://api.basiq.io/docs/consent): use provider-hosted consent and bank-hosted authentication. Owner approves selected accounts, purpose, duration and data scopes there; this UI is not a substitute.
- [Basiq connections](https://api.basiq.io/docs/data-connections): refresh/Smart Cache guidance and deletion semantics. Use Open Banking only; never allow its alternative web/credential connection method.
- [Basiq CDR policy](https://docs.basiq.io/en/articles/5088017-consumer-data-right-cdr-policy): minimum necessary data, consent-based use, expiry/withdrawal deletion or de-identification subject to legal retention. Agree deletion choice, processor access and required disclosures before activation; do not invent a retention period.
- [Frollo business platform](https://frollo.com.au/frollo-for-business/): alternative managed enterprise offering; no verified quote/eligibility for this project.

## Precise live blocker

No approved provider arrangement, written price/usage ceiling, verified owner-account eligibility, approved retention/processor terms, live consent, secure token lifecycle or live transport acceptance exists for this implementation. No live activation was attempted. Owner must approve the concrete provider, price, purpose, selected accounts, scopes and duration before completing provider/bank-hosted authentication. Never request a NAB password or OTP in this app. Future production work needs authenticated tenant binding, encrypted persistence/secret references, provider revocation propagation, deletion receipts, verified pagination completeness and provider-specific transaction identity transitions. Those are not delivered by a memory-only demonstration.

`activateLiveNab()` in `scripts/nab/basiq-adapter.ts` always throws `LIVE_NAB_NOT_AUTHORISED_OR_IMPLEMENTED`. There is no opt-in boolean that enables live fetch. Root must also independently fail-close legacy `/business/finance` connect/refresh/import endpoints before exposing them from Operations. A guard in this module cannot secure unrelated old routes. Never fall through from a rejected synthetic command to the old finance sync service.

## Integration contract for root

UI: `import { NabConnection } from '@/components/finance/nab-connection';` then `<NabConnection />`. No props or server handlers needed. Do not pass real account records into it.

Optional API/service: import `createNabSyntheticService`, `NAB_SCOPES`, `OwnerContext`, `ConsentInput`, `NabStatus` from `scripts/nab/service.ts`. Keep one instance per process for synthetic state; restarting clears it. Context **must** be derived from trusted authenticated session/owner mapping, never request body/query. The first trusted owner binds the tenant, and other owners are rejected. This service is an authorisation boundary consumer, not an authentication implementation.

| Method | Input and result |
|---|---|
| `status(ctx)` | Returns `mode: synthetic`, `connected: false`, phase, selected scopes, consent expiry, generation, last attempt/success/next eligible refresh, stale/error metadata, scope-gated synthetic balance/flow/insights, audit count and blocker. |
| `consent(ctx, input)` | `{ acknowledgement: 'synthetic-only', purpose: 'cash-flow-review', scopes: ['accounts', ...], accountIds: ['syn-business'], durationDays: 1..30 }`. Returns status. Accounts required; other scopes opt-in. Clears old records and increments generation. |
| `importFixture(ctx, input)` | `{ fixtureId, ownerInitiated: true, generation }`. Accepted IDs: `cashflow-v1`, `duplicate-v1`, `pending-posted-v1`, `insights-v1`. Returns `{ changed, status }`. No raw data, file paths or network destinations accepted. |
| `refresh(ctx, { generation })` | Returns `{ changed, skipped, status }`. Run only from an explicitly authorised existing scheduler; every job carries generation. First due now, later at 24 hours; error retries also wait 24 hours. This is our synthetic policy, not a NAB/Basiq SLA. |
| `revoke(ctx)` | Clears consent, account balance, transaction data, timestamps and refresh eligibility; increments generation. Keeps bounded payload-free audit. Repeated revoke is safe. |
| `audit(ctx)` | Copies of latest 100 events; sequence/time/action/result/count and allowlisted failure code only. No tenant identifiers, transaction IDs, values, descriptions or provider payloads. |

Optional HTTP mappings: GET status/audit, POST consent/import/refresh/revoke under a distinct synthetic namespace. Require same-origin/CSRF and authenticated owner checks before mutations, validate request size and shape, return allowlisted errors only and do not log bodies. No HTTP handler was added by this specialist; root owns route wiring. No service outputs should be sent to the model fleet.

State is process-local and operations are synchronous/atomic. It is not a distributed database or multi-worker scheduler. Stale generation rejects queued work after revoke/reconsent. Status evaluation on expiry clears rows and balances, hides aggregates and denies operations. The UI invalidation timer ensures this also happens while left open; a suspended tab is checked on focus/visibility. A live implementation still needs durable deletion receipts and provider revocation propagation.

## Existing code reuse and provider boundary

Read source only in `scripts/finance/{basiq,sync,store,csv-import,categories,invoice-matching}.ts`; no private record reads or store initialisation. Reused `BasiqTransaction` fields, `InvoiceMatch` shape and pure `resolveCategory`. Existing sync/CSV/store are not invoked: they can read private files/Downloads, use REAL/number amounts and lack this tenant/consent contract. Existing invoice matcher rounds floats and has no credit currency field; the synthetic matcher therefore uses integer amounts and explicit reference, with its existing result shape.

`createNabBasiqSyntheticAdapter(service, ownerContext, scenario?).read(ctx, generation)` exercises the **actual existing `createBasiqClient` wrapper** with its normal token cache, mapping and cursor pagination against an internally defined synthetic fetch transport. The transport only accepts fixed test routes and never calls global fetch. Fixed dummy configuration prevents providerKey from falling back to filesystem credentials. It checks owner and consent generation before and after awaits, Open Banking connection state/expiry, account/currency and complete known fixture identity/amount/status. Success returns `{ changed, status, transport: 'synthetic-in-memory', requestCount }`; failure returns a fixed error without provider payloads.

This proves a wrapper integration path using simulated transport, **not** Basiq sandbox/live network acceptance. No public live adapter exists here. The inherited wrapper now pins HTTPS/origin and the expected user transaction path before authenticated dispatch, prohibits redirect following, rejects repeated/malformed pagination and page-cap exhaustion, and rejects malformed account/connection lists. Decimal APIs preserve numeric JSON lexemes; the legacy numeric API rejects unrepresentable cents. Identity-only mapping requires no balance. The synthetic adapter validates dates and records generation-scoped sanitised provider failures. The inherited client still exposes user creation and refresh methods for legacy consumers: root must guard those routes independently. It is not certified for live activation by this report.

## Money and insights

Decimal strings become integer AUD cents using BigInt parsing and safe-integer bounds. Reject unsupported currency, malformed money, invalid dates/directions/status, non-synthetic identifiers and aggregate overflow. Do not silently convert FX. Signed transaction direction is separate from nonnegative magnitude.

Repeated account/transaction identity is idempotent. Pending to posted replaces one row; a stale pending replay cannot downgrade it. Fixture balance revisions prevent stale snapshots rolling balances backwards. A provider that changes IDs between pending and posted requires additional live identity reconciliation; no heuristic real-money merge is claimed.

Pending and transfers are excluded from flow both directions. Refunds received/paid are separate from income/expenses. GST is not inferred and accounting profit is null. Synthetic invoice suggestions require exact cents and explicit reference; no invoice is marked paid. Vendor totals exclude pending/transfers and deduct identified refunds. Monthly recurring candidates require two same-amount posted debits 25–35 days apart; they are suggestions, not confirmed subscriptions. No private vendor/client details are accessed.

## Verification and limits

- `bun test scripts/nab.test.ts`: final run 20 tests / 0 failures / 98 assertions, including stale-balance replay rejection.
- Focused typecheck: `bun node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext --moduleResolution bundler scripts/nab/service.ts scripts/nab/basiq-adapter.ts src/types/bun-sqlite.d.ts` passed. First isolated command omitted the existing Bun declaration and failed resolving `bun:sqlite`; corrected by explicitly including it, no dependency installed.
- Full `bun node_modules/typescript/bin/tsc --noEmit -p .` reported `scripts/cline-bridge.ts(159,34): TS2554 Expected 4 arguments, but got 3`. Outside this specialist's scope; baseline status not established. No all-project pass claimed.
- Isolated production bundle: `bun scripts/nab/preview.ts` uses Vite build with `configFile:false`, `envFile:false`, `write:false`, then serves only compiled in-memory assets on `127.0.0.1:4188/preview.html`. No app plugins, seeding, private dashboard or live services. Final build passed (41 modules).
- Browser observed actual opt-in → sample permissions → import: balance A$2,315; cash movement A$915; seven changed entries. Desktop 1440 requested; mobile 390 requested, DOM content/scroll width both 375 (scrollbar), no horizontal overflow. Root independently reported permission/import/mobile pass and owns combined-route review. UI extended with insights after initial capture; root should review final combined UI.
- Impeccable mechanical detector returned `[]` on initial component. No claim of independent audit or live banking acceptance.
- Final rebuilt UI browser journey also confirmed one invoice suggestion (not paid), two synthetic vendor entries totalling A$20 and one recurring candidate (not a confirmed subscription). Root owns final combined-route and duplicate/revoke browser review.
- Initial Vite development preview on 4187 showed a blank IAB view without console errors despite served modules; switched to an isolated compiled asset preview on 4188, which rendered. Do not cite the initial health/HTTP 200 as UI proof.

No commit, merge, deployment, provider/account change, outbound message, live consent, banking API call or private data access was performed. Root independently reviews and commits owned paths.

## Exact specialist paths

- `scripts/nab/normalise.ts`
- `scripts/nab/fixtures.ts`
- `scripts/nab/insights.ts`
- `scripts/nab/service.ts`
- `scripts/nab/basiq-adapter.ts`
- `scripts/nab/preview.ts`
- `scripts/nab/preview.tsx`
- `scripts/nab/preview.html`
- `scripts/nab.test.ts`
- `src/components/finance/nab-connection.tsx`
- `docs/NAB-CONNECTION-20260927.md`

External dependencies remaining: provider acceptance/quote, owner account eligibility and live scope approval, privacy/retention terms, secure durable token/data lifecycle, authenticated route integration, real scheduler approval and live provider acceptance. Existing dependencies only; no packages installed. No commit until lead review.

## STOP checkpoint — 27 September 2026 (lead to relaunch GPT-6 Sol medium)

Work stopped at user instruction; all changes preserved, no commit. Owner now confirms a NAB business account. This resolves account-type uncertainty only: product/representative eligibility and provider acceptance remain unverified. It does not authorise live consent, real data or provider calls. Earlier recommendation remains conditional on provider acceptance and written pricing.

Completed since the original report (supersedes its outdated unresolved-wrapper/timer statements): hardened scripts/finance/basiq.ts with HTTPS/origin/user-endpoint pagination checks before authenticated dispatch, redirect rejection, loop/malformed-page/page-cap failure, exact decimal parsing and lossless decimal APIs; legacy numeric mapping rejects unrepresentable money. Both inherited wrapper files were clean before edits. Synthetic adapter now records generation-scoped sanitised provider failures, supports identity-only accounts without balance, and checks dates/decimal values. Service clears aggregates on expiry. UI re-evaluates expiry on timer/focus/visibility. Added opt-in in-memory synthetic scheduler; construction schedules nothing, no OS/production scheduler installed. Owner import fallback remains named synthetic fixtures only.

Latest verified command: bun test scripts/nab.test.ts scripts/nab/lifecycle.test.ts scripts/finance/basiq.test.ts — 37 pass, 0 fail, 205 assertions. Focused strict typecheck of service.ts, basiq-adapter.ts and lifecycle.ts with src/types/bun-sqlite.d.ts passed. git diff --check for inherited wrapper and wrapper tests passed. Initial numeric-edge test exposed insufficient round-trip checking; corrected and the above rerun passed. No post-checkpoint verification performed.

Changed paths in this repair: scripts/finance/basiq.ts; scripts/finance/basiq.test.ts; scripts/nab/basiq-adapter.ts; scripts/nab/service.ts; scripts/nab/lifecycle.ts (new); scripts/nab/lifecycle.test.ts (new); scripts/nab.test.ts; src/components/finance/nab-connection.tsx; docs/NAB-CONNECTION-20260927.md. Original NAB paths remain listed above. Independent economics work wrote only docs/ECONOMICS-INDEPENDENT-REVIEW-20260927.md; source unchanged, concrete overage-floor/safe-integer/date findings recorded, existing 25 tests/640 assertions plus independent synthetic arithmetic probes passed. Economics source fixes were not authorised in that read-only task.

Exact remaining steps: reconcile the older paragraphs in this report with the repairs (they still say wrapper unchanged, no expiry timer, retained expired rows, and scheduler contract only); inspect final diff and rerun focused tests if changed; rebuild isolated preview to compile the latest UI, optionally repeat rendered expiry/duplicate/revoke acceptance; lead independently review then freeze/commit only if authorised. Preserve docs/NAB-INDEPENDENT-REVIEW-20260927.md as the independent pre-fix findings. No live acceptance claim is warranted. Scheduler is opt-in memory-only, and the adapter compares closed fixtures rather than ingesting arbitrary provider responses.

Process checkpoint: owned isolated synthetic preview last known exec session 35839, loopback port 4188, serving the pre-repair build. OS PID unknown; not queried or stopped at this checkpoint. No other owner's process cancelled. No pending provider job. Provider tests used closed in-memory transport only: zero live banking/provider requests, no consent, credentials, real records or account changes. Prior public documentation research is recorded above; no new external calls during repair. Files remain uncommitted for lead review.
