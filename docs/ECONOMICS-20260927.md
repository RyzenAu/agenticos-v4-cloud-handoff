# Economics implementation · 27 September 2026

> **Superseded prices (updated 28 Sep 2026).** Every price, allowance and rate in this document is historical. The single source is `src/lib/receptionist-packages.ts` (exported to `docs/receptionist-package-catalogue.json`): approved monthly prices Essential A$699, Professional A$1,099, Premium A$1,999 with 400 / 1,000 / 1,800 included minutes and A$0.80 / A$0.75 / A$0.70 per extra minute, all ex GST with 10% GST added (M&U is GST registered). Setup fees are proposed, not approved; pilot terms are not approved. Use `docs/ECONOMICS-STRESS-20260928.md` for current estimates. The calculation rules in this document still apply.

Local candidate, uncommitted for independent lead review. No account, invoice, bank record, caller content, deployment, send or provider configuration was accessed or changed. Root owns `/operations` integration. This document covers only the five assigned files.

## Integration contract

- `src/components/business/economics-workbench.tsx`: named and default `EconomicsWorkbench`, no props or network calls. Existing Business typography/tokens, responsive inputs, horizontally scrollable scenario tables. Input changes are ephemeral.
- `src/lib/receptionist-packages.ts`: `RECEPTIONIST_PACKAGES`, `getReceptionistPackage`, `projectPackageProposal`, `projectReceptionistConfiguration`. Projections are detached serialisable data. Configuration always returns an unprovisionable draft with no enabled tools; caller must supply and verify tenant configuration separately.
- `src/lib/business-economics.ts`: `calculateEconomics`, `defaultEconomicsInput`, `splitGst`, `billedSeconds`, `validateRates`, `reconcileUsageMetadata`, public source/rate/FX/scenario constants and `PRICE_RECOMMENDATION`.
- `scripts/business-economics.test.ts`: synthetic arithmetic, catalogue, receipt comparison and actual React server-render tests.
- This document: evidence, assumptions, limitations and review handback.

Package switching resets package fees, included usage, overage, call defaults, notification count and onboarding/support time. It deliberately keeps provider-rate edits, supplier GST choices, FX/card assumptions, client count, hourly labour value, target margin and payment assumptions for like-for-like comparison. The UI explains this. Switching does not save or approve anything.

## Official public observations

Sources were read on **27 September 2026**. A check date is not a vendor effective date. Unless explicitly stated below, no effective date was published in the retrieved pricing table; `effectiveFrom: null` means unknown. These are public list observations, never evidence of this account's contract or selected live model.

| Item | Public observation / model use | Source / effective date |
|---|---|---|
| Retell | US$0.055/min infrastructure + US$0.015 platform voice + US$0.0128 GPT 4.1 mini = US$0.0828/min chosen estimate. STT is included; no duplicate separate STT/TTS/LLM charge. Retell custom telephony adds no Retell-side carrier fee. | [Retell pricing](https://www.retellai.com/pricing), effective date unpublished |
| Retell duration | Connected call duration includes silence; seconds accumulated without per-call minute rounding. | Same official pricing FAQ |
| Twilio local inbound | US$0.010/min, local number US$3/month. US$0.004/min SIP interface is modelled as an extra leg in a **hypothetical Programmable Voice + SIP topology**. | [Twilio AU voice](https://www.twilio.com/en-us/voice/pricing/au), effective date unpublished |
| Twilio rounding | Each partial minute rounds up, per call/leg; 2 × 61 sec means 240 billed sec per leg, not 180. | [Twilio billing increments](https://help.twilio.com/articles/223132307-How-do-you-round-minutes-for-billing-), current help article |
| Hosting | Vercel Pro US$20/month baseline, one seat; included US$20 usage credit is not charged again. Extra seats/excess usage are unresolved. | [Vercel pricing](https://vercel.com/pricing), effective date unpublished |
| Database | Neon Launch US$0.106/CU-hour, announced effective 3 November 2025. Plan, compute/storage usage and current full tariff not established, so **monthly allocation stays null**. | [Neon announcement](https://neon.com/blog/major-compute-price-reduction-on-neon). Current `/pricing` fetch failed in the available web reader; do not treat this historical announcement as a verified current total. |
| Payment | Stripe AU domestic online cards 1.7% + A$0.30, fees include GST. Applied to customer gross charge; one monthly payment/client and a separate setup payment. | [Stripe AU pricing](https://stripe.com/au/pricing), current on observation date; page explicitly flags a lower domestic price from **1 October 2026**, so recheck before use then |
| FX | **RBA table, 25 September 2026: US$0.7019 per A$1.** Directly read Latest Exchange Rates: 23 Sep 0.7102; 24 Sep 0.7032; 25 Sep 0.7019. Integer conversion uses 1,000,000 / 701,900 AUD per USD, not 0.7019 AUD per USD. | [RBA daily exchange rates](https://www.rba.gov.au/statistics/frequency/exchange-rates.html), observation effective 2026-09-25. RBA reference is not a settlement quote. |
| GST | Credits depend on actual GST and eligibility. No tax credit is invented for unknown overseas supplier treatment. | [ATO claiming GST credits](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits) |

Twilio's retrieved page has conflicting mobile/toll-free subtable labels. Only the consistent **local** rows are used. Direct voice-page open intermittently returned an internal error; its official indexed page returned the table. The Elastic SIP page could not be retrieved. The historical handoff's US$0.006/min and real mobile number must therefore **not** be represented by this local-number scenario. Confirm topology/number type and replace carrier rows before quoting; never add Elastic SIP pricing on top of this hypothetical route.

FX/card buffer 3%, labour A$60/hour, support 30/90/180 minutes, onboarding 8 hours, and client allocations are explicitly modelling assumptions. Unknown database, notification, banking connector, media, other subscriptions and hosting excess costs remain blank/null, visible as excluded gaps. None is labelled free. No provider was selected or connected by entering a placeholder.

## Calculation and rounding policy

Money inputs are integer cents; rates are integer millionths of a currency unit. `BigInt` handles multiplication, FX division and half-up rounding; outputs must fit safe integers. UI decimal parsing avoids binary-float money conversion. Inputs reject negatives, fractional counts, zero client count, zero FX, excessive ranges and 100% target margin.

1. Customer price lines are split into revenue and applicable output GST. Included GST is rounded as gross/11; excluded GST as net/10. Unticking the GST-registered scenario retains quoted amounts and removes output GST and input credits. It does not establish real registration status.
2. Customer overage = ceiling of aggregate actual seconds above included seconds / 60. GST is calculated on the aggregate overage line. Vendor increments are **separate** and apply per call per selected rate. Zero-duration calls have zero minute charge; a separately selected per-call rate can still charge events.
3. A selected vendor line is converted to AUD with the card buffer, rounded to a cent per client, then scaled by client count. Shared monthly costs are charged once. Setup lines remain per new client, outside monthly costs. This is a deterministic allocation policy; an actual account-wide vendor invoice may round differently.
4. Supplier costs can include/exclude/no/unknown GST. Cash cost minus eligible input credit is the operating cost. Unknown tax has no invented tax or credit; results are incomplete. Labour is an economic time allocation without assumed supplier GST.
5. Revenue ex GST − variable service costs (including direct number rental and collection fees) = contribution. Contribution − support − one shared platform allocation = estimated operating contribution. Margins use ex-GST revenue; zero revenue gives an undefined margin, not infinity or 100%.
6. Setup revenue ex GST − onboarding labour − setup-only costs − setup payment fee = setup contribution per new client. Setup revenue does not inflate monthly contribution.
7. Usage cost per call excludes monthly number/platform/support/payment overhead. Per-minute usage cost is conservatively rounded **up** to a cent; this also makes the marginal floor and usage break-even conservative. Exact per-line amounts are available in the breakdown.
8. Overage floor solves marginal cost / (1 − target margin − effective percentage payment burden). It includes output-GST collection and the supplier fee's credit treatment. Fixed collection fee is already in the monthly invoice; separate overage invoices require another fixed fee. Unknown costs/support growth are excluded visibly. An impossible denominator or no usage yields undefined.
9. Usage break-even is the approximate maximum minutes funded by base subscription **with no overage charged**, holding call mix/support fixed. It is not a live utilisation cap. Client break-even covers the shared platform from positive per-client contribution after support; it is undefined when per-client contribution cannot cover it.
10. Duplicate rate IDs or overlapping `covers` fail closed, including an extra TTS line on top of the Retell bundle. Retell hosting and shared website hosting are distinct components.

`reconcileUsageMetadata` compares non-sensitive duration buckets to billed seconds/cost in a supplied receipt and reports missing/matched/different metadata. It never marks a result invoice-reconciled. No measured records or actual invoices were provided; all displayed results remain estimates. An authorised future reconciliation needs month boundaries, route/model, component receipts, GST evidence, settlement FX and invoice rounding. Never ingest caller content to do this.

## Catalogue evidence and recommendation

Inspected `D:/MU-Receptionist-wt-prompt/src/lib/buildmaster/client-profile.ts`: `SUPPORTED_NICHES = ['REAL_ESTATE', 'DENTAL', 'LEGAL']`. Corresponding `research.ts` playbooks and `prompt-builder.ts` gated booking/transfer text exist. This supports a **local template** label only. It does not establish agent acceptance or current production state. Trades is retained visibly as **unsupported**, with no functions/integrations and a null configuration niche.

All five catalogue rows have proposed pricing, null approval timestamps/references, explicit GST, setup/monthly/included/overage terms, limitations, onboarding, integrations, evidence and release gates. Dental, property and legal receptionists remain internal testing. Enquiry Rescue is a separate callback-form proposal at historical A$1,490 incl. GST, with zero phone minutes/recurring price; ongoing hosting/support requires separate scope. Its reported local demo is dated handoff evidence, not a new live acceptance claim.

**Recommendation for review after capability acceptance:** test A$699/month incl. GST, 300 included minutes, A$1.10/min overage, A$990 setup for an eight-hour onboarding scope. The existing A$549 historical price stays the initial comparison input. The UI offers an explicit scenario-only A$699 control; it never approves or provisions a package.

At five clients, GST registration/fee-credit assumption enabled, A$60/hour labour, the public local-number estimate and unknown costs excluded:

| Monthly quoted price | Low: 60 minutes, 30 support min | Base: 300 minutes, 90 support min | High: 800 minutes, 180 support min, 500 overage min |
|---|---:|---:|---:|
| A$549 incl. GST | 88.5% | 69.6% | 67.9% |
| A$649 incl. GST | 90.0% | 74.0% | 70.4% |
| **A$699 incl. GST proposed** | **90.6%** | **75.8%** | **71.5%** |

These are operating-contribution percentages after the specified allocations, not net profit. The A$699 base case leaves A$481.50/client/month known-cost operating contribution; approximately A$36.69/client of additional cost would take it to 70%. High usage has less buffer. A$990 setup leaves A$404.43 contribution after A$480 labour and A$15.57 net payment fee, before any unscoped setup costs. Resolve unknown allocations and actual delivery burden before accepting a fixed price. Unsupported trades has no commercial recommendation.

## Verification and handback

- `bun test scripts/business-economics.test.ts`: final run **25 pass, 0 fail, 640 assertions**, exit 0 (83 ms). Includes receipt metadata comparison added after the first 24-test pass.
- `bun node_modules/typescript/bin/tsc --noEmit -p .`: initial and final runs passed, exit 0.
- Impeccable `detect --json src/components/business/economics-workbench.tsx`: empty finding list (`[]`).
- Actual React server-render test verifies selector, schema copy, rate links, comparison and no NaN/Infinity; this is not a browser interaction test.
- Local `/operations` rendered in the in-app browser at desktop and 390×844. The first screenshot revealed unreadable inherited light text on a white input fallback. Changed to the existing `--op-panel` token; fresh mobile reload visibly confirmed the corrected dark select, readable label and single-column layout.
- Browser interaction checks were **not established**: the browser subsequently reported localhost connection refused / stale nodes. No server was restarted and no success is claimed for those attempted edits. Root should rerun scenario buttons, package selector, invalid-input recovery, keyboard focus, rate edits and horizontal table scrolling in the integrated preview. Viewport reset before handback.
- Lead reported its own desktop render and isolated build passing; this is lead evidence, not a build performed by this specialist. Full release build/suite and independent code review remain lead-owned, avoiding broad scripts that can seed private state.

External dependencies: verified live tenant model/telephony configuration; actual number type; supplier GST and registration/credit eligibility; scoped notification/bank/database/media/subscription allocations; future Stripe effective-rate refresh; genuine receipt/invoice reconciliation only after permission; receptionist acceptance and separate release approval. None blocks local arithmetic or catalogue use as a draft.

No commits or route edits by this specialist. Preserve all concurrent changes and stage only the five named paths after independent review.

## Root-authorised catalogue export follow-up

Additional owned paths authorised by root: `scripts/export-receptionist-catalogue.ts` and generated `docs/receptionist-package-catalogue.json`. The source of truth remains `src/lib/receptionist-packages.ts`; do not hand-edit the JSON.

`exportReceptionistCatalogueJson()` returns stable, pretty-printed JSON with trailing newline, sorted package IDs, `schemaVersion: 1`, fixed `catalogueVersion: 2026-09-27`, `mode: draft-only` and `liveCapabilitiesVerified: false`. Each package contains the proposal projection plus `kind` and `configurationDraft`. Consumers should validate schema version and required fields, preserve price approval/evidence states, and independently gate provisioning; a manifest cannot authorise activation. There are no wall-clock, provider or local account reads.

- Generate: `bun scripts/export-receptionist-catalogue.ts`
- Check exact source/manifest parity without writing: `bun scripts/export-receptionist-catalogue.ts --check`
- Both commands passed. The writer has a fixed OS documentation destination and rejects other CLI arguments. It writes no other repository.
- Updated tests: `bun test scripts/business-economics.test.ts` — **26 pass, 0 fail, 666 assertions**, exit 0. Added deterministic export, ordering, detached state and disabled-capability assertions.
- Root independently reported rendering and exercising usage on `http://127.0.0.1:3410/review/mu-execution/index.html`, with isolated and full AgenticOS builds passing. This supersedes the earlier interaction gap as **root-provided evidence**, not a claim that this specialist's failed browser attempt succeeded.

Separate read-only NAB findings are in `docs/NAB-INDEPENDENT-REVIEW-20260927.md`. NAB implementation files were not edited.

## Independent-review repairs and local proposal download (2026-09-27)

The two P2 findings and calendar-date finding in `docs/ECONOMICS-INDEPENDENT-REVIEW-20260927.md` are repaired in the implementation; the independent report is preserved unchanged. Overage warnings now compare quoted cents to the quoted floor, retaining aggregate invoice-line GST. Combined variable, support, setup and GST totals use checked BigInt aggregation, including signed losses; the client break-even division also stays exact. FX dates must round-trip as actual ISO calendar dates, including century leap-year rules.

Regression evidence: the four new defect groups failed before repair (27 pass / 4 fail); after repair and proposal tests, `bun test scripts/business-economics.test.ts` passes 32 tests, 735 assertions. Coverage includes one-cent quotes at seven quantities, combined unsafe operating/setup/fee totals, invalid and valid leap dates, and unchanged reviewed A$699 base margin (75.77%) and setup contribution (A$404.43).

`Download draft proposal` creates a local JSON Blob from the selected package using `projectPackageProposal` and the current price, usage, GST, FX, provider-rate and labour assumptions. The snapshot includes calculated estimates, unknown-cost warnings and catalogue limitations. It forcibly clears approval references and marks pricing proposed/nonpublishable. It does not change the catalogue, send data or provision tools. Pure projection tests verify overrides, selected legal scope, detachment and invalid-input rejection; server rendering verifies the control and warning. An actual browser download click has not been independently exercised in this pass.

Changed paths for this repair: `src/lib/business-economics.ts`, `src/components/business/economics-workbench.tsx`, `scripts/business-economics.test.ts`, `docs/ECONOMICS-20260927.md`. No catalogue content/schema change. `bun scripts/export-receptionist-catalogue.ts --check` passed. Consumer path remains `C:/Users/Nebula PC/source/repos/AgenticOS-v4/docs/receptionist-package-catalogue.json`.

External dependencies remain actual provider configuration, tax-credit eligibility, usage/invoice reconciliation, unknown cost allocations, tenant acceptance and owner price approval. None was inferred from synthetic tests. Files remain uncommitted for lead review; scope frozen after verification.

Final verification: `bunx tsc --noEmit` exited 1 with one diagnostic outside this scope: `scripts/jarvis-execution/runtime.ts:16` TS2322, `Status | "blocked"` is not assignable to the destination status union. No diagnostic named the economics files. This concurrent implementation was not edited. Full repository typecheck is therefore not passing. `git diff --check -- src/lib/business-economics.ts src/components/business/economics-workbench.tsx scripts/business-economics.test.ts docs/ECONOMICS-20260927.md` exited 0 (tracked diff check only; these additions may remain untracked).

## STOP checkpoint — model handoff requested 2026-09-27

Stopped at user request for lead relaunch on GPT-6 Sol medium. All files preserved; no commits, staging, provider calls, sends, deployments or other-owner process cancellations.

Current repair changes: `src/lib/business-economics.ts` (quoted overage-floor comparison, checked signed money aggregation, real calendar-date validation, draft JSON projection); `src/components/business/economics-workbench.tsx` (local Blob Download draft proposal control); `scripts/business-economics.test.ts` (arithmetic/date/proposal regressions); this report. Earlier catalogue manifest/export and receptionist flag fixes remain preserved.

Latest results: economics 32 tests passed, 735 assertions; catalogue --check passed with no manifest change; tracked diff whitespace check passed. Full `bunx tsc --noEmit` failed solely at `scripts/jarvis-execution/runtime.ts:16` TS2322 (`blocked` status mismatch), outside owned scope. Session 88652 completed exit 1; no running process/job from this specialist. No live provider calls were started. Earlier receptionist broad suite passed 113 tests/420 assertions; NAB synthetic review report already written.

Exact unfinished handoff: lead independently reviews these uncommitted repairs; browser exercise the new local download and inspect JSON overrides/nonpublishable labels (pure projection and server-render tests passed, actual download click not exercised); owning specialist resolves the unrelated runtime status type error, then lead reruns full typecheck. Provider/tax/tenant acceptance and unknown rates remain external dependencies, with no live readiness or approved-price claim. No additional implementation planned before lead review. Catalogue consumer path: C:/Users/Nebula PC/source/repos/AgenticOS-v4/docs/receptionist-package-catalogue.json.
