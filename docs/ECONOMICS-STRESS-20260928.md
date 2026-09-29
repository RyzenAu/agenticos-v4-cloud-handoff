# Receptionist economics stress test · 28 September 2026

**What this is:** an estimate. The owner-approved prices and launch allowances are stress-tested against official list prices, which were re-read today. Nothing here is measured profit. No provider invoice has been reconciled, no paying receptionist client exists yet, and every "Measured" column is empty on purpose. Unknown costs are listed at the end with no amount. They are never counted as A$0.

**Review trigger:** re-run this with real invoices after the first 30 days of paid service or the first five paying clients, whichever comes first (owner decision, 28 Sep).

- Source of truth: `src/lib/business-economics.ts` (`economicsStressReport()`, `renderStressMarkdown()`), catalogue `src/lib/receptionist-packages.ts` (unchanged).
- Tests: `bun --no-env-file test scripts/business-economics.test.ts`. The tables below are generated, and a test fails if they drift from the code.
- Consistency fixture for the other apps: `docs/receptionist-consistency-fixture.json`.

## Plain-English summary

**The approved prices hold up at the expected Retell cost.** At full use of the allowance, with five clients and the conservative US$0.12/min Retell base, each client leaves an estimated operating margin (after support time and the hosting share) of **74.8% on Essential (A$523/month), 65.3% on Professional (A$717) and 66.9% on Premium (A$1,337)**. Contribution before support is 76–84%.

**Retell is the risk that matters.** Retell's per-minute price is set by which LLM, voice and add-ons the agent uses, and our tiers carry 400–1,800 included minutes.
- At +50% (US$0.18/min), full-use margins are 69.8% / 57.2% / 59.0%.
- At the top of Retell's own published range (US$0.31/min), they fall to 58.9% / 39.8% / 41.8%.
- At the published maximum configuration (GPT 6 Astra fast tier, ElevenLabs voice and every per-minute add-on, US$0.86/min), Professional and Premium lose money at full use (−33.7% / −31.0%). Essential keeps 12.6%.

Nobody would choose that configuration for a receptionist. It is still the ceiling, and a few settings get part of the way there:
- Retell's AI Quality Assurance add-on alone is +US$0.10/min, taking the base to US$0.22.
- The fast LLM tier doubles the LLM cost.
- Moving to GPT 5.4 or Claude 4.6 Sonnet costs US$0.08/min for the LLM instead of US$0.025.

**Rule for the owner:** any change to the agent's LLM, voice tier or Retell add-ons is a pricing decision, not a technical one. Check it against this table first.

**What is actually configured is cheaper than the base.**
- The receptionist's provisioning generator sets `gpt-4.1-mini` with `retell-Cimo` (a Retell platform voice), which is **US$0.0828/min**.
- The live demo agent was recorded on 27 Sep on Claude 4.5 Haiku. If its `retell-` voice is platform tier, it costs **US$0.095/min**.
- US$0.12 (Haiku with the ElevenLabs voice tier) is kept as the base because the live voice tier is unconfirmed and the estimate should err towards cost.

**Premium's A$0.70 extra minute stays above marginal cost under high Retell.** Marginal voice cost per extra minute (Retell, carrier with per-call rounding, short-call overhead and webhooks), with headroom after the payment fee:

| Retell rate | Marginal cost | Headroom on A$0.70 |
|---|---:|---:|
| Base | A$0.187 | A$0.50 |
| +50% | A$0.275 | A$0.41 |
| Published range top, US$0.31 | A$0.466 | A$0.22 |
| Published maximum configuration | A$1.274 | below cost |

- Only the published maximum configuration breaks it. The same holds for Essential (A$0.80) and Professional (A$0.75).
- A$0.70 only just meets a 70% margin target, and only at the base rate: that floor is A$0.678.

**Overage protects the downside.** With overage charged, no tier's margin goes negative at any usage up to 20× the allowance unless Retell reaches the maximum configuration. If overage were never collected (waived, or payments failing), the base fee alone first goes negative at 2,988 min on Essential, 4,300 on Professional and 7,955 on Premium at the base rate. At US$0.31 those points are 1,255, 1,883 and 3,482. Collecting overage reliably matters more than the exact overage price.

**Support time is the second-largest lever.** Doubling support hours takes 8.5–11 points off operating margin; this assumes founder time at A$60/hour, which is not measured. The other stresses are small:
- Two-segment SMS costs 0.9–2.1 points.
- Cold-transferring 10% of calls for 3 minutes costs 0.8–1.2 points (transfer is not offered today).
- Delivering every webhook four times costs less than a cent.
- Even the combined bad case keeps 30–43% operating margin. That case is 150% usage, Retell +50%, 2-segment SMS, 10% transfers, 4× webhooks, 2× support and a single client carrying all hosting.

**Setup fees (still PROPOSED).**
- With the proposed fees (A$990 / A$1,490 / A$2,490), onboarding makes A$486 / A$734 / A$1,230 per new client after labour and payment fees.
- Without a setup fee, M&U absorbs A$480 / A$720 / A$1,200 of onboarding labour. After first-month support, the first month is negative (−A$77 / −A$183 / −A$463), and each tier recovers it in month 2 at full usage.
- Without a fee, a client who leaves inside the first month is a loss. The 3/3/6-month minimum terms are what protect this.

**Two consistency traps the other apps must avoid:**
1. The receptionist app defaults to `PER_CALL` rounding. The fixture customer would then be billed 1,440 minutes (A$330 overage) instead of 1,200 (A$150), 20% more than the catalogue terms. Every client must be set to `PER_PERIOD`.
2. Post-transfer minutes are carrier cost only. They must not be billed as AI minutes.

**What changed in the model today:**
- Stripe payment fees now include Stripe Billing's 0.7%, because the receptionist bills through Stripe subscriptions and meters. The card fee is the official 1.7% + A$0.30 from 1 Oct 2026, which replaces the 27 Sep secondary-source 1.65%. This moved the old base margins down about 0.3 points.
- Transfer legs, webhooks and short non-billable calls are now costed.
- Four more unknowns are listed: Vercel excess usage and seats, SMS carrier fees, Twilio trunk recording, and the live voice tier.

## Evidence level (V6 reporting)

| Level | State |
|---|---|
| Committed | Yes, on `f/economics-stress-20260928` (see the commit log) |
| Integrated | No. Not merged into `jarvis-voice`; the receptionist app, CRM and Finance have not yet imported the fixture |
| Running | No live service involved; pure functions only |
| Independently reviewed | No |
| Live verified | No. No live Retell, Twilio or Stripe read. Rates come from public price pages, not invoices |

## Rate verification (28 Sep 2026)

Pages were read on 28 Sep 2026, around 00:05–00:15 AEST. Prices were confirmed from the raw page text, not only a summariser:

- **Retell** ([pricing](https://www.retellai.com/pricing)). Headline "$0.07-$0.31 / min for AI Voice Agents".
  - Infrastructure US$0.055.
  - Platform, Cartesia, OpenAI, Minimax, Fish and Inworld voices US$0.015; ElevenLabs US$0.040.
  - LLMs: GPT 4.1 mini US$0.0128 (fast tier 0.0192), Claude 4.5 Haiku US$0.025, GPT 6 Astra US$0.32 (fast tier 0.64).
  - Add-ons: knowledge base +0.005, denoising +0.005, guardrails +0.005, PII removal +0.01, AI QA US$0.10/min after 100 free minutes.
  - Retell telephony: US$0.015/min on Retell's own numbers; no charge for custom SIP.
  - Per-second tracking. Concurrency beyond 20 is US$8/month.
  - No effective date published.
- **Retell transfers** ([docs](https://docs.retellai.com/build/single-multi-prompt/transfer-call)): on a cold transfer the AI agent fee stops, while "Only the telephony fee continues". A warm transfer bills at the normal rate while the agent is on the line.
- **Twilio** ([SIP trunking AU](https://www.twilio.com/en-us/sip-trunking/pricing/au), [numbers CSV](https://assets.cdn.prod.twilio.com/pricing-csv/SiteNumbersPricing.csv), [termination CSV](https://assets.cdn.prod.twilio.com/pricing-csv/OutboundSipTrunkPricing.csv), [SMS AU](https://www.twilio.com/en-us/sms/pricing/au), [Voice AU](https://www.twilio.com/en-us/voice/pricing/au)), "pricing current as of August 2026":
  - SIP origination: local and mobile 0.0060/min, toll-free 0.0460.
  - Termination to AU mobile 0.0710, landline 0.0212.
  - Numbers: mobile 8.25/month, local 2.50 on SIP (3.00 on Voice).
  - Programmable Voice inbound: local and mobile 0.0100, SIP interface 0.0040.
  - SMS: outbound 0.0515 per segment, inbound 0.0075, failed-message fee 0.001; "additional carrier fees may apply".
  - The pages show "$" with no currency label, and the CSVs have no currency column. **Modelled as USD**, the dearer reading. Check the first invoice.
- **Stripe** ([AU pricing](https://stripe.com/au/pricing)):
  - Card: "1.7% + A$0.30 for domestic cards", with "Lower pricing effective starting 1 Oct 2026 for domestic cards"; "Fees include GST".
  - Stripe Billing pay-as-you-go: 0.7% of Billing volume. Invoicing: 0.4% per paid invoice. BECS direct debit: 1% + A$0.30, capped at A$3.50. BECS would be cheaper for large invoices.
  - Modelled: 2.4% + A$0.30 on the GST-inclusive charge.
- **Vercel** ([pricing](https://vercel.com/pricing)): Pro US$20/month with a US$20 usage credit. Extra seats US$20. 1M invocations included, then US$0.60 per 1M. Active CPU from US$0.128/hour.
- **Neon** ([pricing](https://neon.com/pricing)): Launch plan US$0.106/CU-hour plus US$0.35/GB-month, with no minimum. Scale-to-zero after 5 minutes. Usage has not been measured, so **UNKNOWN**.
- **RBA** ([exchange rates](https://www.rba.gov.au/statistics/frequency/exchange-rates.html)): USD per A$1 was 0.7102 (23 Sep), 0.7032 (24 Sep) and **0.7019 (25 Sep, latest)**. It is a reference rate, not a settlement quote. The model adds a 3% card/FX buffer, which is an assumption.

## Configured agent (read-only inspection)

In `D:/MU-Receptionist-wt-prompt` (branch `fix/prompt-truth-20260927`, commit `4debd33`), `src/lib/buildmaster/provision-plan.ts` sets `DEFAULT_MODEL = 'gpt-4.1-mini'` and `DEFAULT_VOICE_ID = 'retell-Cimo'`. There is no fast-tier flag and no knowledge-base, denoising, guardrail or PII add-on. Retell `llm_id`s are created per client from this plan.

The live demo agent was recorded on 27 Sep as Claude 4.5 Haiku (MU-Workspace `memory/master-v3/ENTITY-MAP.md`). It was not re-read today, because no live Retell call is allowed.

The receptionist's own `src/lib/billing/cost-rates.ts` carries the same US$0.12 figure. Its values still match this model's `retell`, `carrier` and `sms` rates, so no drift is introduced.

## Assumptions (all labelled; none measured)

| Assumption | Value |
|---|---|
| Call length | 150 s per billable call |
| Short or never-connected calls | 5% extra at 4 s. Costed (Twilio rounds each to 1 min), never billed |
| Bookings | 50% of billable calls |
| SMS per booking | Essential 1 (confirmation). Professional and Premium 2 (confirmation + reminder). 1 segment base, 2 stress (the template cap) |
| Webhooks | 5 per call (3 lifecycle + 2 tool calls), +10% redeliveries in the base case, 4× in stress |
| Transfers | 0% in the base case (not offered). Stress: 10% of calls, 3 min after the handoff, cold transfer to an AU mobile |
| Support minutes | Catalogue scenarios. ≤50% usage uses low, ≤100% base, >100% high (Essential 30/60/120, Professional 60/120/240, Premium 90/180/360) |
| First-month extra support | Essential 2 h, Professional 3 h, Premium 10 h (daily review for two weeks) |
| Labour | **A$60/hour founder time. An assumption, not a wage paid** |
| Clients sharing hosting | 5 for the grid; 1/5/10/25 shown separately |
| GST | M&U is registered. Prices are ex GST, and GST is added to invoices. The payment fee's GST is credited. Supplier GST is unknown, so no credit is taken |
| Payment | Stripe card 1.7% + Billing 0.7% + A$0.30 on the GST-inclusive invoice |

## Tables (generated)

<!-- stress-tables:start (generated by renderStressMarkdown; do not hand-edit) -->
### Rates used (checked 2026-09-28; USD converted at RBA 2026-09-25 + 3% card/FX buffer)

| Rate | Amount | Basis | Evidence | Source | Effective |
|---|---:|---|---|---|---|
| Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tier | US$0.1200 | minute | public-list | https://www.retellai.com/pricing | not published |
| Twilio Elastic SIP origination, AU mobile | US$0.0060 | minute, rounded up per 60 s | public-list | https://www.twilio.com/en-us/sip-trunking/pricing/au | 2026-08 |
| Twilio AU mobile number | US$8.2500 | number-month | public-list | https://www.twilio.com/en-us/sip-trunking/pricing/au | 2026-08 |
| Twilio AU outbound SMS | US$0.0515 | sms-segment | public-list | https://www.twilio.com/en-us/sms/pricing/au | not published |
| Twilio Elastic SIP termination to AU mobile (cold-transfer leg) | US$0.0710 | transfer-minute, rounded up per 60 s | public-list | https://www.twilio.com/en-us/sip-trunking/pricing/au | 2026-08 |
| Twilio SIP origination continuing after a cold transfer | US$0.0060 | transfer-minute, rounded up per 60 s | public-list | https://www.twilio.com/en-us/sip-trunking/pricing/au | 2026-08 |
| Vercel function invocations (webhooks, tool calls, retries, duplicates) | US$0.6000 per 1,000,000 | webhook-event | public-list | https://vercel.com/pricing | not published |
| Vercel Pro base (1 seat) | US$20.0000 | shared-month | public-list | https://vercel.com/pricing | not published |
| Neon Postgres usage (Launch plan) | **UNKNOWN** | shared-month | unknown | https://neon.com/pricing | not published |
| Vercel usage beyond the US$20 credit and extra seats | **UNKNOWN** | shared-month | unknown | https://vercel.com/pricing | not published |
| AU carrier fees on SMS | **UNKNOWN** | sms-segment | unknown | https://www.twilio.com/en-us/sms/pricing/au | not published |
| Twilio trunk call recording (if switched on) | **UNKNOWN** | minute, rounded up per 60 s | unknown | https://www.twilio.com/en-us/sip-trunking/pricing/au | not published |
| Staff alert email | **UNKNOWN** | notification | unknown | none | not published |
| Retell concurrency above 20 free slots | **UNKNOWN** | shared-month | unknown | https://www.retellai.com/pricing | not published |
| Other tools and subscriptions allocation | **UNKNOWN** | shared-month | unknown | none | not published |
| Stripe card (from 1 Oct 2026) + Stripe Billing | 1.7% + 0.7% + A$0.30, fees include GST | GST-inclusive charge | public-list | https://stripe.com/au/pricing | 2026-10-01 (card) |
| RBA USD per A$1 | 0.7019 | reference rate, not a settlement quote | public-list | https://www.rba.gov.au/statistics/frequency/exchange-rates.html | 2026-09-25 |
| Founder labour | A$60.00/hour | support + onboarding time | **assumption** | none | — |

### Retell configurations (per connected minute; M&U brings its own Twilio SIP trunk, so Retell telephony is US$0)

| Configuration | Components | US$/min | A$/min incl. buffer |
|---|---|---:|---:|
| Receptionist generator default: gpt-4.1-mini + retell-Cimo (Retell platform voice) | infra 0.0550 + platformVoice 0.0150 + gpt41mini 0.0128 | 0.0828 | 0.1215 |
| Live demo agent as recorded 27 Sep: Claude 4.5 Haiku + a retell- voice (platform tier assumed from the prefix) | infra 0.0550 + platformVoice 0.0150 + claude45haiku 0.0250 | 0.0950 | 0.1394 |
| Modelled base (conservative): Claude 4.5 Haiku + ElevenLabs voice tier | infra 0.0550 + elevenlabsVoice 0.0400 + claude45haiku 0.0250 | 0.1200 | 0.1761 |
| Published maximum configuration: ElevenLabs + GPT 6 Astra fast tier + every per-minute add-on | infra 0.0550 + elevenlabsVoice 0.0400 + gpt6AstraFast 0.6400 + knowledgeBase 0.0050 + denoising 0.0050 + guardrails 0.0050 + piiRemoval 0.0100 + aiQualityAssurance 0.1000 | 0.8600 | 1.2620 |
| Retell's published headline range | $0.07-$0.31 / min for AI Voice Agents | 0.07–0.31 | 0.1027–0.4549 |

### Grid: margin per client by usage and Retell rate (5 clients, estimate)

**Essential** · A$699.00/month ex GST · 400 min · A$0.80/extra min

| Usage | Minutes | Revenue ex GST | Variable cost (base) | Contribution (base) | Operating · Base US$0.120 | Operating · +25% US$0.150 | Operating · +50% US$0.180 | Operating · Published range top US$0.310 | Operating · Published max config US$0.860 | Measured |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 25% | 100 | A$699.00 | A$49.37 | A$649.63 (92.9%) | A$613.76 (87.8%) | A$609.35 (87.2%) | A$604.94 (86.5%) | A$585.84 (83.8%) | A$505.02 (72.3%) | — |
| 50% | 200 | A$699.00 | A$69.60 | A$629.40 (90.0%) | A$593.53 (84.9%) | A$584.72 (83.7%) | A$575.90 (82.4%) | A$537.70 (76.9%) | A$376.06 (53.8%) | — |
| 75% | 300 | A$699.00 | A$89.81 | A$609.19 (87.2%) | A$543.32 (77.7%) | A$530.10 (75.8%) | A$516.87 (73.9%) | A$459.57 (65.8%) | A$217.11 (31.1%) | — |
| 100% | 400 | A$699.00 | A$110.04 | A$588.96 (84.3%) | A$523.09 (74.8%) | A$505.46 (72.3%) | A$487.82 (69.8%) | A$411.41 (58.9%) | A$88.15 (12.6%) | — |
| 150% | 600 | A$859.00 | A$154.32 | A$704.68 (82.0%) | A$578.81 (67.4%) | A$552.36 (64.3%) | A$525.91 (61.2%) | A$411.30 (47.9%) | -A$73.60 (-8.6%) | — |

**Professional** · A$1,099.00/month ex GST · 1,000 min · A$0.75/extra min

| Usage | Minutes | Revenue ex GST | Variable cost (base) | Contribution (base) | Operating · Base US$0.120 | Operating · +25% US$0.150 | Operating · +50% US$0.180 | Operating · Published range top US$0.310 | Operating · Published max config US$0.860 | Measured |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 25% | 250 | A$1,099.00 | A$93.09 | A$1,005.91 (91.5%) | A$940.04 (85.5%) | A$929.02 (84.5%) | A$918.00 (83.5%) | A$870.24 (79.2%) | A$668.20 (60.8%) | — |
| 50% | 500 | A$1,099.00 | A$147.40 | A$951.60 (86.6%) | A$885.73 (80.6%) | A$863.68 (78.6%) | A$841.64 (76.6%) | A$746.13 (67.9%) | A$342.05 (31.1%) | — |
| 75% | 750 | A$1,099.00 | A$201.74 | A$897.26 (81.6%) | A$771.39 (70.2%) | A$738.33 (67.2%) | A$705.27 (64.2%) | A$562.00 (51.1%) | -A$44.12 (-4.0%) | — |
| 100% | 1,000 | A$1,099.00 | A$256.06 | A$842.94 (76.7%) | A$717.07 (65.3%) | A$672.99 (61.2%) | A$628.91 (57.2%) | A$437.89 (39.8%) | -A$370.29 (-33.7%) | — |
| 150% | 1,500 | A$1,474.00 | A$373.70 | A$1,100.30 (74.7%) | A$854.43 (58.0%) | A$788.30 (53.5%) | A$722.18 (49.0%) | A$435.65 (29.6%) | -A$776.61 (-52.7%) | — |

**Premium** · A$1,999.00/month ex GST · 1,800 min · A$0.70/extra min

| Usage | Minutes | Revenue ex GST | Variable cost (base) | Contribution (base) | Operating · Base US$0.120 | Operating · +25% US$0.150 | Operating · +50% US$0.180 | Operating · Published range top US$0.310 | Operating · Published max config US$0.860 | Measured |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 25% | 450 | A$1,999.00 | A$182.35 | A$1,816.65 (90.9%) | A$1,720.78 (86.1%) | A$1,700.95 (85.1%) | A$1,681.11 (84.1%) | A$1,595.15 (79.8%) | A$1,231.47 (61.6%) | — |
| 50% | 900 | A$1,999.00 | A$280.15 | A$1,718.85 (86.0%) | A$1,622.98 (81.2%) | A$1,583.31 (79.2%) | A$1,543.64 (77.2%) | A$1,371.72 (68.6%) | A$644.36 (32.2%) | — |
| 75% | 1,350 | A$1,999.00 | A$377.92 | A$1,621.08 (81.1%) | A$1,435.21 (71.8%) | A$1,375.70 (68.8%) | A$1,316.19 (65.8%) | A$1,058.31 (52.9%) | -A$32.73 (-1.6%) | — |
| 100% | 1,800 | A$1,999.00 | A$475.71 | A$1,523.29 (76.2%) | A$1,337.42 (66.9%) | A$1,258.07 (62.9%) | A$1,178.72 (59.0%) | A$834.88 (41.8%) | -A$619.82 (-31.0%) | — |
| 150% | 2,700 | A$2,629.00 | A$686.41 | A$1,942.59 (73.9%) | A$1,576.72 (60.0%) | A$1,457.70 (55.5%) | A$1,338.68 (50.9%) | A$822.92 (31.3%) | -A$1,359.14 (-51.7%) | — |

### Cost lines per client at 100% of allowance, base Retell (5 clients, estimate)

| Tier | Retell | Carrier | SMS | Number | Webhooks | Payment (net of GST credit) | Support | Hosting share | Operating |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Essential | A$70.53 | A$4.30 | A$6.05 (80 seg) | A$12.11 | <A$0.01 (924 events) | A$17.05 | A$60.00 (60 min) | A$5.87 | A$523.09 |
| Professional | A$176.33 | A$10.74 | A$30.23 (400 seg) | A$12.11 | <A$0.01 (2,310 events) | A$26.65 | A$120.00 (120 min) | A$5.87 | A$717.07 |
| Premium | A$317.39 | A$19.34 | A$54.41 (720 seg) | A$36.32 | <A$0.01 (4,158 events) | A$48.25 | A$180.00 (180 min) | A$5.87 | A$1,337.42 |

### Stress overlays (100% of allowance unless stated, estimate)

| Case | Essential | Professional | Premium |
|---|---:|---:|---:|
| Baseline: 100% of allowance, base Retell | A$523.09 (74.8%) | A$717.07 (65.3%) | A$1,337.42 (66.9%) |
| Every SMS is 2 segments | A$517.05 (74.0%) | A$716.12 (63.4%) | A$1,318.14 (64.8%) |
| 10% of calls cold-transferred for 3 min | A$517.67 (74.1%) | A$703.51 (64.0%) | A$1,313.02 (65.7%) |
| Every webhook delivered 4 times | A$523.09 (74.8%) | A$717.06 (65.3%) | A$1,337.41 (66.9%) |
| Support time doubled | A$463.09 (66.3%) | A$597.07 (54.3%) | A$1,157.42 (57.9%) |
| Combined: 150% usage, Retell +50%, 2-segment SMS, 10% transfers, 4× webhooks, 2× support, 1 client | A$371.08 (42.9%) | A$480.85 (30.7%) | A$977.50 (35.3%) |

### Hosting allocation by client count (100% of allowance, base Retell; Neon unknown and excluded)

| Tier | 1 client | 5 clients | 10 clients | 25 clients |
|---|---:|---:|---:|---:|
| Essential | A$29.35 share → 71.5% | A$5.87 share → 74.8% | A$2.94 share → 75.3% | A$1.17 share → 75.5% |
| Professional | A$29.35 share → 63.1% | A$5.87 share → 65.3% | A$2.94 share → 65.5% | A$1.17 share → 65.7% |
| Premium | A$29.35 share → 65.7% | A$5.87 share → 66.9% | A$2.94 share → 67.0% | A$1.17 share → 67.1% |

### Overage floor: extra-minute price vs marginal voice cost (ex GST, per minute)

| Tier | Retell case | Price | Marginal cost | Break-even floor | 70% target floor | Headroom after payment fee | Above marginal cost? |
|---|---|---:|---:|---:|---:|---:|---|
| Essential | Base US$0.120 | A$0.8000 | A$0.1871 | A$0.1918 | A$0.6779 | A$0.5937 | yes |
| Essential | +25% US$0.150 | A$0.8000 | A$0.2312 | A$0.2369 | A$0.8377 | A$0.5496 | yes (below 70% target) |
| Essential | +50% US$0.180 | A$0.8000 | A$0.2752 | A$0.2820 | A$0.9972 | A$0.5056 | yes (below 70% target) |
| Essential | Published range top US$0.310 | A$0.8000 | A$0.4663 | A$0.4778 | A$1.6895 | A$0.3145 | yes (below 70% target) |
| Essential | Published max config US$0.860 | A$0.8000 | A$1.2744 | A$1.3058 | A$4.6174 | -A$0.4936 | **NO** (below 70% target) |
| Professional | Base US$0.120 | A$0.7500 | A$0.1871 | A$0.1918 | A$0.6779 | A$0.5449 | yes |
| Professional | +25% US$0.150 | A$0.7500 | A$0.2312 | A$0.2369 | A$0.8377 | A$0.5008 | yes (below 70% target) |
| Professional | +50% US$0.180 | A$0.7500 | A$0.2752 | A$0.2820 | A$0.9972 | A$0.4568 | yes (below 70% target) |
| Professional | Published range top US$0.310 | A$0.7500 | A$0.4663 | A$0.4778 | A$1.6895 | A$0.2657 | yes (below 70% target) |
| Professional | Published max config US$0.860 | A$0.7500 | A$1.2744 | A$1.3058 | A$4.6174 | -A$0.5424 | **NO** (below 70% target) |
| Premium | Base US$0.120 | A$0.7000 | A$0.1871 | A$0.1918 | A$0.6779 | A$0.4961 | yes |
| Premium | +25% US$0.150 | A$0.7000 | A$0.2312 | A$0.2369 | A$0.8377 | A$0.4520 | yes (below 70% target) |
| Premium | +50% US$0.180 | A$0.7000 | A$0.2752 | A$0.2820 | A$0.9972 | A$0.4080 | yes (below 70% target) |
| Premium | Published range top US$0.310 | A$0.7000 | A$0.4663 | A$0.4778 | A$1.6895 | A$0.2169 | yes (below 70% target) |
| Premium | Published max config US$0.860 | A$0.7000 | A$1.2744 | A$1.3058 | A$4.6174 | -A$0.5912 | **NO** (below 70% target) |

### Break-even minutes per client (operating margin goes negative; 5 clients, base support)

| Tier | Base US$0.120 | +25% US$0.150 | +50% US$0.180 | Published range top US$0.310 | Published max config US$0.860 |
|---|---:|---:|---:|---:|---:|
| Essential overage charged | never (≤8,000) | never (≤8,000) | never (≤8,000) | never (≤8,000) | 574 |
| Essential no overage charged | 2,988 | 2,453 | 2,081 | 1,255 | 469 |
| Professional overage charged | never (≤20,000) | never (≤20,000) | never (≤20,000) | never (≤20,000) | 717 |
| Professional no overage charged | 4,300 | 3,575 | 3,059 | 1,883 | 717 |
| Premium overage charged | never (≤36,000) | never (≤36,000) | never (≤36,000) | never (≤36,000) | 1,325 |
| Premium no overage charged | 7,955 | 6,613 | 5,659 | 3,482 | 1,325 |

### Setup and first month per new client (labour at the A$60/hour assumption)

| Tier | Onboarding | Proposed fee ex GST | Setup contribution with fee | First month net with fee | Setup contribution, no fee | First month net, no fee | Months to recover, no fee |
|---|---:|---:|---:|---:|---:|---:|---:|
| Essential | 8 h (A$480.00) + A$120.00 first-month support | A$990.00 (proposed) | A$485.96 | A$889.05 | -A$480.00 | -A$76.91 | 2 |
| Professional | 12 h (A$720.00) + A$180.00 first-month support | A$1,490.00 (proposed) | A$733.96 | A$1,271.03 | -A$720.00 | -A$182.93 | 2 |
| Premium | 20 h (A$1,200.00) + A$600.00 first-month support | A$2,490.00 (proposed) | A$1,229.96 | A$1,967.38 | -A$1,200.00 | -A$462.58 | 2 |

### Unknown costs (amount null; never in any total above)

| Item | Why unknown | Illustration only (not in totals) |
|---|---|---|
| Neon Postgres usage (Launch plan) | Launch: US$0.106/CU-hour + US$0.35/GB-month, no minimum, scale to zero after 5 min (re-read 28 Sep). Actual compute hours not measured; unknown, not free. | 0.25 CU always on = 0.25 × 730 h × US$0.106 = US$19.35/month shared (about A$28.40 with the FX buffer), before storage |
| Vercel usage beyond the US$20 credit and extra seats | Fluid Active CPU from US$0.128/hour, data transfer US$0.15/GB beyond 1 TB, US$20 per extra seat. Usage and seat count not measured. | — |
| AU carrier fees on SMS | Twilio: 'additional carrier fees may apply'. Amount not published on the AU page. | — |
| Twilio trunk call recording (if switched on) | US$0.0025/min + US$0.0005/min-month storage if trunk recording is on. Retell records the call itself; whether trunk recording is on has not been checked (no live Twilio read allowed). | — |
| Staff alert email | Alert channel not yet configured in production; provider and price unknown. | — |
| Retell concurrency above 20 free slots | US$8/slot/month beyond 20 concurrent calls across ALL clients. Peak concurrency not measured. | — |
| Other tools and subscriptions allocation | Unscoped allocation; excluded from the known-cost subtotal, not assumed free. | — |
| GST on Retell, Twilio, Vercel and Neon invoices, and whether it is creditable | Supplier tax invoices not seen. No GST added and no credit taken on any supplier line. | — |
| Voice tier of the live Retell agent | Recorded 27 Sep as a retell- voice (platform tier by prefix). The base rate uses the dearer ElevenLabs tier until an owner-approved live read confirms it. | — |
| Failed payments, disputes, refunds and service credits | No payment history. Stripe dispute fees and any service credit policy are not modelled. | — |
| Accounting, insurance, legal review of the service agreement, M&U's own phones and domains | Business overhead, not allocated per client; not scoped. | — |
| Actual card FX spread on USD bills | Modelled as RBA 25 Sep + 3% buffer; the real spread depends on the card used. | — |
<!-- stress-tables:end -->

## Consistency fixture

`docs/receptionist-consistency-fixture.json` is one synthetic customer that the receptionist app, the CRM proposal and Finance must all invoice identically:

- Package: Professional.
- Usage: 480 calls × 150 s = 1,200 billable minutes (PER_PERIOD), 40 SMS segments, and 2 cold transfers with 3 minutes after each handoff.

| Line | Qty | Ex GST | GST | Incl GST |
|---|---:|---:|---:|---:|
| Professional monthly fee | 1 | A$1,099.00 | A$109.90 | A$1,208.90 |
| Extra AI minutes (1,200 − 1,000) | 200 × A$0.75 | A$150.00 | A$15.00 | A$165.00 |
| Extra SMS segments (40 of 600 included) | 0 | A$0.00 | A$0.00 | A$0.00 |
| **Total** | | **A$1,249.00** | **A$124.90** | **A$1,373.90** |

No setup line appears, because the fee is proposed. Transfer minutes are not billed. The fixture also lists what must *not* be produced: PER_CALL gives 1,440 minutes and A$330 overage; billing transfer minutes gives 1,206 minutes.

Finance's estimate is labelled an estimate, with measured left null:
- Direct cost A$270.05. That covers Retell A$211.31, carrier A$12.68, number A$12.11, SMS A$3.02, transfer legs A$0.68 and the Stripe fee net of GST credit A$30.25.
- Contribution A$978.95 (78.4%), before support, hosting and unknowns.

The generating function throws if its invoice lines ever disagree with `calculateEconomics`. A test pins the committed file to the function's output.

Other apps should import the JSON and assert their own invoice lines equal `expectedInvoice.lines` and `expectedInvoice.totals`. The export script does not write this file yet; the patch for that is in the handoff report.

## Risks, in order

1. **The Retell configuration can move silently.** An LLM upgrade, the fast tier, ElevenLabs voices or the AI QA add-on can each add anywhere from US$0.025 to over US$0.60/min. At US$0.31/min, Professional and Premium full-use margins fall to about 40%; at the maximum configuration they go negative. Guard: treat agent-config changes as pricing decisions, and record `appliedModel` and `voiceTier` on each client.
2. **Overage collection.** Margin only stays positive at high usage if overage is invoiced and paid. A rounding-mode mistake (PER_CALL) over-bills by about 20%, and a missed meter push under-bills.
3. **Support time is unmeasured.** It is the second-largest cost. Log real support minutes from client one.
4. **Currency of Twilio prices.** They are modelled as USD. If they are AUD, the carrier and SMS costs are about 30% lower. Minor either way.
5. **Unknown costs.** Neon compute, Vercel excess and seats, SMS carrier fees, trunk recording, alert email, Retell concurrency above 20, other subscriptions, supplier GST, bad debt, business overhead and the FX spread. None is in any total. Neon's illustrative bound is 0.25 CU always on, about US$19/month shared (A$28.40). That would cost 1.4–4.1 points of margin with one client and at most 0.2 points with 25.
6. **Setup fees are not approved.** Without them, the first month is loss-making on every tier, and recovery depends on the client staying past month 1.
7. **The 1 October Stripe change and FX.** The Stripe card rate is already modelled at the 1 Oct price. A 10% fall in the AUD raises USD costs by about 10%, which is roughly half of the +25% Retell column.

## Not done here (needs someone else or the owner)

- A live read of the Retell agent's LLM and voice (owner yes needed). This would confirm whether US$0.095 applies.
- Importing the fixture into the receptionist, CRM and Finance tests (those files are owned by their teams).
- Updating `docs/sales/dental-call-pack-2026-09-28/07-unit-economics-and-jev.md`, which may still quote the older payment rate and prices (owned by the sales pack).
