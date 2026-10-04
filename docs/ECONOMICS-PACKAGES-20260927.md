# Receptionist package economics · 27 September 2026

> **Superseded, 28 Sep 2026.** The prices below (A$999 / A$1,690 and their overage rates, all "proposed") are historical. The owner approved A$699 / A$1,099 / A$1,999 a month with A$0.80 / A$0.75 / A$0.70 per extra minute, plus GST, and the launch allowances. The payment fee is now 2.4% + A$0.30: the card rate is 1.7%, Stripe's printed price from 1 Oct 2026, plus Stripe Billing's 0.7%. Current figures, the stress grid and the unknown-cost register are in `ECONOMICS-STRESS-20260928.md`. The calculation rules below still apply.

Supersedes the package section of `ECONOMICS-20260927.md` (which modelled a single tier and a dropped callback-form offer). The calculation rules in that document (integer cents, BigInt, half-up rounding, GST splitting, per-client vendor rounding, fail-closed double counting) still apply; the independent review in `ECONOMICS-INDEPENDENT-REVIEW-20260927.md` is unchanged and its repaired defects stay covered by tests.

- Source of truth: `src/lib/receptionist-packages.ts` (catalogue) and `src/lib/business-economics.ts` (formulas).
- Tests: `bun --no-env-file test scripts/business-economics.test.ts`.
- Exports (never hand-edit): `bun scripts/export-receptionist-catalogue.ts` writes `docs/receptionist-package-catalogue.json` and `docs/sales/receptionist-pack-2026-09-28/package-economics.json`; `--check` verifies both.

**Status: proposal.** No price is approved; GST registration is an owner decision; nothing here changes provider configuration. The live demo line does not book.

## 1. Official rates re-verified (checked 27 Sep 2026)

| Item | Rate used | Source | Effective date |
|---|---|---|---|
| Retell voice infrastructure | US$0.055/min | https://www.retellai.com/pricing | not published |
| Retell LLM Claude 4.5 Haiku | US$0.025/min (GPT-4.1 mini is US$0.0128; not our model) | same | not published |
| Retell voice, ElevenLabs tier | US$0.040/min (platform voices US$0.015; `retell-Leland` tier unconfirmed, so the dearer tier is used) | same | not published |
| Retell telephony with custom SIP | no charge | same | — |
| Retell billing | per second, no per-call rounding, silence billed | same | — |
| Retell add-ons not used | knowledge base +US$0.005/min, denoising +US$0.005, PII removal +US$0.01, concurrency beyond 20 US$8/slot/month, Retell SMS US$20/month | same | — |
| Twilio Elastic SIP origination, AU mobile | 0.0060/min, rounded up per call | https://www.twilio.com/en-us/sip-trunking/pricing/au | "current as of August 2026" |
| Twilio AU mobile number (SIP) | 8.25/month | same | August 2026 |
| Twilio termination to AU mobile (only if transfer is ever built) | 0.0710/min | same | August 2026 |
| Twilio AU SMS | 0.0515/outbound segment; inbound 0.0075 (excluded as negligible) | https://www.twilio.com/en-us/sms/pricing/au | not published |
| Twilio currency | pages show "$" with no currency label; **modelled as USD** (dearer) | — | — |
| Vercel Pro | US$20/seat/month incl. US$20 usage credit; Hobby is non-commercial | https://vercel.com/pricing | not published |
| Neon Launch | US$0.106/CU-hour + US$0.35/GB-month, no minimum; usage unknown → **null** | https://neon.com/pricing | not published |
| Stripe AU domestic card | 1.7% + A$0.30, fees include GST | https://stripe.com/au/pricing | page says "Lower pricing from 1 Oct 2026" |
| Stripe from 1 Oct 2026 | 1.65% + A$0.30 per a secondary source (petboost.com.au), **not shown on Stripe's page**; not used | see `STRIPE_FROM_2026_10_01` | 2026-10-01 |
| Stripe Invoicing | 0.4% per invoice, US$2 cap (cap ignored: conservative) | https://stripe.com/au/pricing | — |
| FX | RBA 0.7019 USD per AUD on 25 Sep 2026 (24 Sep 0.7032, 23 Sep 0.7102) + 3% card/FX buffer | https://www.rba.gov.au/statistics/frequency/exchange-rates.html | 2026-09-25 |

Unknown costs stay `null` and are listed in every result's warnings: Neon usage, staff alert email, Retell concurrency above 20, other subscriptions. Supplier GST treatment stays "unknown" (no invented credits).

Variable cost per connected minute: **A$0.186** (Retell A$0.176 + SIP A$0.009, incl. buffer), shown rounded up as 19c. SMS A$0.076/segment. Number A$12.11/month.

## 2. Catalogue (proposed)

| | Essential | Professional | Premium |
|---|---:|---:|---:|
| Monthly ex GST (incl. GST if registered) | A$699 (A$768.90) | A$999 (A$1,098.90) | A$1,690 (A$1,859.00) |
| Setup ex GST | A$990 | A$1,490 | A$2,490 |
| Included minutes | 400 | 1,000 | 1,800 |
| Overage ex GST | A$0.90/min | A$0.80/min | A$0.75/min |
| Included SMS / extra | 200 / A$0.15 | 600 / A$0.15 | 1,200 / A$0.15 |
| Numbers / locations / calendars | 1 / 1 / 1 | 1 / 1 / 3 | 3 / 3 / 10 |
| Minimum term / notice | 3 months / 30 days | 3 months / 30 days | 6 months / 30 days |
| Support first response | next business day | 4 business hours | 2 business hours |
| Onboarding labour | 8 h | 12 h | 20 h |

Billing: per second, summed per billing period, rounded up to a whole minute once (`roundingMode = PER_PERIOD` in the receptionist; its default is `PER_CALL`, so onboarding must set it); calls under 5 s, never-connected calls and demo calls excluded; no rollover; monthly fee in advance, usage in arrears; setup invoiced at Acceptance (founding terms).

**GST basis (proposal):** quote ex GST. Registered: invoice adds 10%, net revenue unchanged. Unregistered: invoice equals the ex-GST price, net revenue unchanged, no input credits. Tested in `ex-GST quotes keep the same net revenue`.

### Why A$1,690 for Premium
Premium carries about three more hours a month of M&U review labour than Professional and up to three numbers. Holding the base price step and the margin policy constant:

| Premium price | Low | Base | High |
|---|---:|---:|---:|
| A$1,590 | 80.1% | 64.4% | 53.5% |
| **A$1,690** | **81.1%** | **66.4%** | **55.5%** |
| A$1,790 | 82.1% | 68.2% | 57.4% |
| A$1,990 | 83.7% | 71.2% | 60.6% |

(5 clients, margin after allocated costs.) A$1,690 is the lowest price in the owner's range that matches Professional's margins (66.8% base, 55.5% high). Higher prices are defensible later with evidence from the first Premium client; before any client exists, the lower price in range is easier to justify.

## 3. Results (5 clients, base usage, per client per month)

| | Essential | Professional | Premium |
|---|---:|---:|---:|
| Revenue ex GST | A$699.00 | A$999.00 | A$1,690.00 |
| Variable cost (voice, carrier, numbers, SMS, payment) | A$92.84 | A$205.35 | A$381.67 |
| Gross contribution | A$606.16 (86.72%) | A$793.65 (79.44%) | A$1,308.33 (77.42%) |
| Support labour | A$60.00 | A$120.00 | A$180.00 |
| Shared platform per client | A$5.87 | A$5.87 | A$5.87 |
| **Margin after allocated costs** | **A$540.29 (77.29%)** | **A$667.78 (66.84%)** | **A$1,122.46 (66.42%)** |
| Overage floor at 70% marginal margin | A$0.69 | A$0.69 | A$0.69 |
| Minutes funded before overage (no overage charged) | 3,158 | 4,300 | 7,322 |
| Setup contribution per new client | A$488.94 | A$738.44 | A$1,237.44 |
| Client break-even (Vercel Pro) | 1 | 1 | 1 |

Full low/base/high × 1/5/10/25 matrix: `docs/sales/receptionist-pack-2026-09-28/package-economics.json` and `docs/sales/dental-call-pack-2026-09-28/07-unit-economics-and-jev.md`.

Scenario assumptions (per client per month, synthetic): 150-second calls; Essential 64/128/240 calls, Professional 160/320/560, Premium 288/576/1,008; SMS segments 30/80/150, 120/300/520, 220/540/950; support minutes 30/60/120, 60/120/240, 90/180/360. Labour A$60/hour. High usage doubles support time.

## 4. Estimated vs measured vs invoice-reconciled

`costEvidenceTable()` and every matrix cell carry three columns. Only **estimated** has values. **Measured** is null: the only observation (about A$0.17/min over 2 calls on 26 Sep) is below a usable sample and predates booking/SMS. **Invoice-reconciled** is null: no provider invoice has been matched to usage metadata. `reconcileUsageMetadata` exists for that step and never marks a result invoice-reconciled by itself. Both need the owner's authorisation and use duration metadata only, never caller content.

## 5. Verification (27 Sep 2026)

- `bun --no-env-file test scripts/business-economics.test.ts`: 46 pass, 0 fail, 1,032 assertions.
- `bun scripts/export-receptionist-catalogue.ts --check`: both exports match.
- `bunx tsc --noEmit -p .`: exit 0 (includes the Operations workbench, which still compiles against the new catalogue).

## 6. Integration note for the lead (workbench is not owned by this track)

`src/components/business/economics-workbench.tsx` still starts with `packageId "dental-receptionist"` (resolved by `LEGACY_PACKAGE_ALIASES` to Essential) and a hard-coded initial price field of the old single-tier value, labels the price "GST-inclusive", uses the generic `SCENARIOS` and a 1.7% payment field. Suggested patch (not applied here):

```diff
- const [packageId, setPackageId] = useState("dental-receptionist");
- const [fields, setFields] = useState({ monthly: "<old>", setup: "990", overage: "1.10", included: "300", clients: "5", calls: "100", seconds: "180", support: "90", hourly: "60", onboarding: "480", fx: "0.7019", card: "3", target: "70", notifications: "0", payment: "1.7", paymentFixed: "0.30" });
+ const first = RECEPTIONIST_PACKAGES[0];
+ const [packageId, setPackageId] = useState<string>(first.id);
+ const [fields, setFields] = useState({ monthly: String(first.pricing.monthly.cents / 100), setup: String(first.pricing.setup.cents / 100), overage: String(first.pricing.overagePerMinute.cents / 100), included: String(first.pricing.includedMinutes), clients: "5", calls: String(first.model.scenarios[1].calls[0].count), seconds: String(first.model.scenarios[1].calls[0].seconds), support: String(first.model.scenarios[1].supportMinutes), hourly: "60", onboarding: String(first.model.onboardingMinutes), fx: "0.7019", card: "3", target: "70", notifications: "0", payment: "2.1", paymentFixed: "0.30" });
- Monthly price (A$, GST-inclusive if registered)
+ Monthly price (A$, ex GST)
- {SCENARIOS.map(...)}
+ {scenariosFor(pkg).map(...)}   // import scenariosFor from business-economics
- the "Explore proposed A$699 price" button (the catalogue now carries the proposal)
```
