# Independent economics review — 27 September 2026

> **Superseded prices (updated 28 Sep 2026).** Every price, allowance and rate in this document is historical. The single source is `src/lib/receptionist-packages.ts` (exported to `docs/receptionist-package-catalogue.json`): approved monthly prices Essential A$699, Professional A$1,099, Premium A$1,999 with 400 / 1,000 / 1,800 included minutes and A$0.80 / A$0.75 / A$0.70 per extra minute, all ex GST with 10% GST added (M&U is GST registered). Setup fees are proposed, not approved; pilot terms are not approved. Use `docs/ECONOMICS-STRESS-20260928.md` for current estimates. This review is kept as a record of the 27 Sep proposal.

## Disposition

**Bounded acceptance of the supplied ordinary-value scenarios; two reproduced arithmetic/guard defects remain.** The proposed A$699 margins and A$990 setup contribution reproduce under the declared known-cost assumptions. This is not acceptance of unrestricted integer inputs, the one-cent overage warning, live vendor configuration, actual tax eligibility, pricing approval or invoice-reconciled profit.

Read-only review of `src/lib/business-economics.ts` and `src/lib/receptionist-packages.ts`, plus their tests and consuming workbench for interpretation. No source/test changes. Only this report was written. All probes used synthetic in-memory inputs; no bank, invoice, account, environment or private client records were accessed.

Reviewed file SHA-256:

- `src/lib/business-economics.ts`: `F4016DFBC8FC5CDF949D3C58AFE579F6A6B74F6BDE81A289FAADB828CD5B779D`
- `src/lib/receptionist-packages.ts`: `B9DBBB30B3907ED91A5FAFBAB36E343788C983CE2204C00F6C6229EDE55475AC`

These files were untracked working-tree additions during review. Findings apply to these contents; concurrent edits require checking the hashes or rerunning the repros.

## Findings

### P2 — Overage warning misses an actual loss after aggregate GST rounding

Location: `src/lib/business-economics.ts:221` (`overageBelowFloor`), related quoted floor at line 204.

The warning compares the **rounded net amount of one unit** with the ex-GST floor, whereas revenue correctly calculates GST on the aggregate overage line. A one-cent GST-inclusive unit rounds to one cent net, but eleven units produce ten cents net after GST. This permits a negative contribution while the underpricing flag is false.

Reproduced with GST registration enabled, monthly price zero, included minutes zero, eleven actual minutes, one-cent inclusive overage, one-cent/minute AUD service cost, zero payment fee/support and target margin zero:

| Output | Observed |
|---|---:|
| Net revenue | 10 cents |
| Variable cost | 11 cents |
| Contribution | -1 cent |
| Ex-GST floor | 1 cent/minute |
| Quoted GST-inclusive floor | 2 cents/minute |
| `overageBelowFloor` | **false** |

Expected: a one-cent quote below the returned two-cent quoted floor must trigger the warning. Compare amounts on the same quoted GST basis, or compare exact rational unit values before rounding. Keep invoice-line GST aggregation intact. Add a regression at one cent and several small aggregate quantities; changing tax computation to make this test green would be the wrong repair.

Default A$1.10 overage does not encounter this specific rounding discrepancy. The defect is reachable through the current decimal price control.

### P2 — Final money totals can escape the safe-integer guard

Locations: `src/lib/business-economics.ts:184`, `:189`, `:193` and related final additions/subtractions.

Individual BigInt conversions are checked, but totals return to unchecked Number arithmetic. Inputs can each pass validation and produce individually safe cost/support amounts whose combined operating contribution exceeds `Number.MAX_SAFE_INTEGER`. This violates the module's deterministic safe-money boundary and silently loses cent precision instead of rejecting the scenario.

Reproduced with one client; one 60-second call; a USD minute rate of `50000000000000` micros; FX `usdPerAudMillionths: 1`, card fee zero; support `1000000000` minutes at `400000000` cents/hour; zero payment fee and no other cost rows. These are deliberately extreme synthetic values, all accepted by the current validators:

```text
variableCostCents:          5000000000000000
supportCents:              6666666666666667
operatingContributionCents: -11666666666616758
Number.isSafeInteger(operatingContributionCents): false
```

Expected: reject before returning any unsafe money result. Keep aggregation/subtraction in BigInt until checked conversion, including negative totals, or validate every final money operation. Audit `setupCost`, `monthlyInputGst`, `variableCost`, contribution and operating totals together. This is not an observed error in ordinary package values and should not be presented as one.

### P3 — FX date validation accepts impossible calendar dates

Location: `src/lib/business-economics.ts:128`.

`fx.date: '2026-02-30'` returns an estimate; only the text pattern is checked. This does not change the numerical FX conversion but weakens the dated-evidence contract. Validate a real ISO calendar date and retain the distinction between observed rates and scenario overrides. The default 25 September date is valid and independently verified below.

## Independent checks performed

1. `bun test scripts/business-economics.test.ts`: **25 pass, 0 fail, 640 assertions**. These are existing builder tests, not the sole basis of this review.
2. Separate `bun run -` stdin probes ran **900 passing conservation/allocation assertions** across 180 combinations: registered/unregistered, inclusive/exclusive/no output GST, eligible/ineligible payment-fee credit, 1/5/50 clients and prices of 1/5/11/54,900/69,900 cents. Checked revenue = net + output GST, contribution subtraction, operating subtraction, net-GST identity and cohort payment-fee divisibility. These are consistency properties, not a tax-compliance proof.
3. A separate rational default-cost oracle and duration-boundary probe ran **25 passing assertions**: five independently calculated foreign-currency line totals; explicit revenue/output-GST/payment/support amounts; carrier and customer overage boundaries at 0/1/59/60/61/119/120/121 seconds. It used no finance helper to derive expected FX or fee values.
4. The two defect repros and invalid-date probe executed directly against the exported calculator. Their observed outputs appear above. An assertion that confirms current faulty behaviour is evidence of reproduction, not a passing correctness test.
5. Independently recalculated the six low/base/high scenarios for A$549 and A$699 at five clients, using the supplied support mix. Results below.

One initial independent-oracle assertion expected 876 cents of payment cost per A$549 charge; it failed with 875. Investigation showed the **reviewer's expected value was wrong**, not the code: 54900 × 1.7% + 30 = 963.3 cents → 963 cash cents, GST rounds from 963/11 to 88, operating cost = 875. The corrected independent oracle passed all 25 checks. No source was changed to achieve that pass.

## Reproductions

From `C:/Users/Nebula PC/source/repos/AgenticOS-v4`, feed the following JavaScript to `bun run -` (PowerShell single-quoted here-string piped to Bun). It performs no file writes:

```js
import { calculateEconomics, defaultEconomicsInput } from './src/lib/business-economics.ts';
import { getReceptionistPackage } from './src/lib/receptionist-packages.ts';
const base = () => ({
  ...defaultEconomicsInput(structuredClone(getReceptionistPackage('dental-receptionist'))),
  clients: 1, calls: [{ count: 1, seconds: 60 }], rates: [],
  supportMinutesPerClient: 0, onboardingMinutes: 0,
  payment: { percentBps: 0, fixedCents: 0, gst: 'none', creditEligible: false },
  targetMarginBps: 0,
});
const rate = (micros, currency = 'AUD') => ({
  id: 'synthetic', label: 'Synthetic', currency, micros, basis: 'minute',
  gst: 'none', creditEligible: false, covers: ['synthetic'], incrementSeconds: 1,
  source: null, checkedAt: '2026-09-27', effectiveFrom: null,
  evidence: 'assumption', note: 'Independent synthetic repro',
});
let x = base();
x.package.pricing.monthly.cents = 0;
x.package.pricing.includedMinutes = 0;
x.package.pricing.overagePerMinute.cents = 1;
x.calls = [{ count: 1, seconds: 660 }];
x.rates = [rate(10000)];
let r = calculateEconomics(x);
console.log({ contribution: r.contributionCents,
  quotedFloor: r.overageFloorQuotedCents, below: r.overageBelowFloor });
// Observed: { contribution: -1, quotedFloor: 2, below: false }
x = base();
x.fx = { usdPerAudMillionths: 1, date: '2026-09-27', cardFeeBps: 0 };
x.rates = [rate(50000000000000, 'USD')];
x.supportMinutesPerClient = 1000000000;
x.supportHourlyCents = 400000000;
r = calculateEconomics(x);
console.log({ operating: r.operatingContributionCents,
  safe: Number.isSafeInteger(r.operatingContributionCents) });
// Observed: { operating: -11666666666616758, safe: false }
x = base(); x.fx.date = '2026-02-30';
console.log(calculateEconomics(x).basis); // Observed: 'estimate'
```

## Proposed margins and cost interpretation

All rows below use five clients, defaults including 3% FX buffer, one assumed local number/client, the selected Retell model/voice, 1.7% + A$0.30 payment fees with assumed eligible GST credits, and the defined low/base/high support minutes. Monthly revenue includes overage in the high case. All results are `incomplete: true` because unknown costs and supplier GST remain unresolved.

| Monthly inclusive price | Usage case | Cohort net revenue | Cohort operating contribution | Margin |
|---|---|---:|---:|---:|
| A$549 | Low | A$2,495.45 | A$2,207.75 | 88.47% |
| A$549 | Base | A$2,495.45 | A$1,737.30 | 69.62% |
| A$549 | High | A$4,995.45 | A$3,389.65 | 67.85% |
| A$699 | Low | A$3,177.25 | A$2,877.95 | 90.58% |
| A$699 | Base | A$3,177.25 | A$2,407.50 | 75.77% |
| A$699 | High | A$5,677.25 | A$4,059.85 | 71.51% |

A$990 inclusive setup yields A$900 net revenue; eight hours at A$60 = A$480 labour; modelled payment cost is A$15.57 net; contribution = **A$404.43 per client**. Therefore the hardcoded 75.8%, 71.5% and A$404.43 rationale agrees with its original assumptions. It must not be treated as recalculated advice after changing rates/support/tax inputs: the rationale is static text, while the calculator results are dynamic.

Independently derived base cohort cost rows: Retell A$182.25, carrier A$22.00, SIP A$8.80, phone numbers A$22.00, one shared hosting allocation A$29.35; payment operating cost A$43.75 and support A$450.00. Per-client foreign costs are rounded before scaling as explicitly documented. This estimates cohorts; an actual vendor invoice may round aggregated usage differently.

## GST, fees, FX and public evidence

- **FX direction/date accepted.** [RBA exchange rates](https://www.rba.gov.au/statistics/frequency/exchange-rates.html) shows US$0.7019 per A$1 for 25 September 2026. Dividing USD by 0.7019 is correct. The 3% card buffer remains an assumption, not an RBA charge or verified bank fee.
- **Selected Retell list combination accepted.** [Retell pricing](https://www.retellai.com/pricing) lists US$0.055 infrastructure, US$0.015 platform voices and US$0.0128 GPT 4.1 mini per minute; sum US$0.0828. This is not proof of the owner's configured agent, add-ons, billed duration or actual invoice. No separate STT/TTS/LLM duplication found in the default selected bundle.
- **Twilio local topology estimate accepted with scope limit.** Official [Twilio AU Voice pricing](https://www.twilio.com/en-us/voice/pricing/au) search retrieval lists local inbound US$0.0100/min, SIP interface US$0.0040/min and local rental US$3/month. Direct page retrieval failed on this review; the indexed official result was readable. An actual mobile number, Elastic SIP route, outbound transfer leg or add-on has different charges. The source explicitly says the topology is assumed; no actual-account verification was performed.
- **Payment-fee basis accepted for the stated domestic-card assumption.** [Stripe Australia pricing](https://stripe.com/au/pricing) explicitly says card fees include GST and displays 1.7% + A$0.30, with a lower domestic-card price effective 1 October 2026. The current dated assumption is not itself a defect. International cards, FX conversion and separately charged Billing/Invoicing products need different/additional rows if used. The linked change-detail support page could not be retrieved by the web tool; the future numeric rate was not independently established.
- **Tax arithmetic accepted within declared assumptions.** Inclusive output tax uses 1/11; exclusive adds 10%; unregistered scenarios remove output GST and input credits; supplier tax can remain payable without credit; payment fees apply to the GST-inclusive customer charge; overage tax aggregates the invoice line once. [ATO guidance](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits) requires actual entitlement/registration and applicable tax-invoice evidence. Direct ATO page retrieval failed, but official ATO search content supported these conditions. No account entitlement was established. These outputs are monthly model estimates, not BAS advice or tax-return figures.
- Supplier GST and unpriced database, alerts, bank connector, media, subscription and platform overage allocations remain unresolved. Explicit unknown warnings are appropriate. Labour assumptions, actual support effort and invoice reconciliation remain material external dependencies. Public rate evidence cannot resolve them.

## Package catalogue acceptance

The reviewed entries consistently retain `proposed` pricing and no approval reference. Trades remains unsupported. Proposal/configuration projections are detached, non-publishable/non-provisionable, with no enabled provider tools. Callback-form pricing is separated from receptionist usage, and its ongoing costs are explicitly unscoped. No booking, transfer or SMS capability is promoted to accepted status by selecting a package.

Scope boundary: this review does not revalidate the receptionist source niche list, live end-to-end readiness, clinical/legal language, owner price approval or provider configuration. It accepts the catalogue's fail-closed labels as data-contract behaviour, not as evidence of those external facts.

## Lead handback

Repair the two P2 findings before claiming robust money-range/underpricing protection. Add meaningful regressions using the supplied probes, then rerun ordinary scenarios to ensure the default margins remain unchanged. Calendar-date validation is a smaller follow-up. No source repair, commit, merge, deployment or live call was made in this independent review.
