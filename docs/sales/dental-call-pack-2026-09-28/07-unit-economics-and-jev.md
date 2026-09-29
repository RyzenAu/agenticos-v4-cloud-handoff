# Receptionist unit economics, cost reductions and the Jev pilot

**Internal. Estimates, not measurements.** Source of truth: `src/lib/business-economics.ts` and `src/lib/receptionist-packages.ts` (tests: `scripts/business-economics.test.ts`). Generated numbers: `../receptionist-pack-2026-09-28/package-economics.json`. Every table below is generated from that JSON by `../receptionist-pack-2026-09-28/build/build_markdown.py`; don't edit them by hand. Full method and stress test: `docs/ECONOMICS-STRESS-20260928.md`. If a number here disagrees with the JSON, the JSON wins.

Prices are the owner-approved monthly plans (28 Sep 2026), ex GST. All costs are **estimates** from official public rates (checked 28 Sep 2026). Nothing has been measured over a usable sample and no invoice has been reconciled; those columns stay empty on purpose, and unknown costs stay unknown (excluded, not zero).

## 1. Inputs (official rates)

<!-- generated:inputs (build/build_markdown.py; don't hand-edit) -->
| Cost | Estimate | Source | Checked |
| --- | --- | --- | --- |
| Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tier | US$0.12 per minute (≈ A$0.176) | [www.retellai.com](https://www.retellai.com/pricing) | 2026-09-28 |
| Twilio Elastic SIP origination, AU mobile | US$0.006 per minute (≈ A$0.009) | [www.twilio.com](https://www.twilio.com/en-us/sip-trunking/pricing/au) | 2026-09-28 |
| Twilio AU mobile number | US$8.25 per number month (≈ A$12.106) | [www.twilio.com](https://www.twilio.com/en-us/sip-trunking/pricing/au) | 2026-09-28 |
| Twilio AU outbound SMS | US$0.0515 per sms segment (≈ A$0.076) | [www.twilio.com](https://www.twilio.com/en-us/sms/pricing/au) | 2026-09-28 |
| Twilio Elastic SIP termination to AU mobile (cold-transfer leg) | US$0.071 per transfer minute (≈ A$0.104) | [www.twilio.com](https://www.twilio.com/en-us/sip-trunking/pricing/au) | 2026-09-28 |
| Twilio SIP origination continuing after a cold transfer | US$0.006 per transfer minute (≈ A$0.009) | [www.twilio.com](https://www.twilio.com/en-us/sip-trunking/pricing/au) | 2026-09-28 |
| Vercel function invocations (webhooks, tool calls, retries, duplicates) | US$0.6 per 1M webhook events | [vercel.com](https://vercel.com/pricing) | 2026-09-28 |
| Vercel Pro base (1 seat) | US$20 per shared month (≈ A$29.349) | [vercel.com](https://vercel.com/pricing) | 2026-09-28 |
| Neon Postgres usage (Launch plan) | **unknown: excluded, not zero** | [neon.com](https://neon.com/pricing) | 2026-09-28 |
| Vercel usage beyond the US$20 credit and extra seats | **unknown: excluded, not zero** | [vercel.com](https://vercel.com/pricing) | 2026-09-28 |
| AU carrier fees on SMS | **unknown: excluded, not zero** | [www.twilio.com](https://www.twilio.com/en-us/sms/pricing/au) | 2026-09-28 |
| Twilio trunk call recording (if switched on) | **unknown: excluded, not zero** | [www.twilio.com](https://www.twilio.com/en-us/sip-trunking/pricing/au) | 2026-09-28 |
| Staff alert email | **unknown: excluded, not zero** | — | 2026-09-28 |
| Retell concurrency above 20 free slots | **unknown: excluded, not zero** | [www.retellai.com](https://www.retellai.com/pricing) | 2026-09-28 |
| Other tools and subscriptions allocation | **unknown: excluded, not zero** | — | 2026-09-28 |

- **FX:** RBA 0.7019 USD per AUD (2026-09-25), plus a 3% card/FX buffer.
- **Payments:** modelled at 2.4% + A$0.30 on the GST-inclusive charge (Stripe card 1.7% from 1 Oct 2026, checked 2026-09-28, plus Stripe Billing).
- **Labour:** A$60/hour for onboarding and support (assumption).
- **GST:** Prices ex GST. Model assumes GST registration with eligible Stripe fee credits; unregistered leaves net revenue unchanged and removes credits.
- **Variable cost per connected minute ≈ A$0.19** (Retell US$0.12/min, which includes Claude 4.5 Haiku and the ElevenLabs voice tier, plus Twilio SIP). Unknown costs (database, hosting-excess, sms-carrier-fees, trunk-recording, notifications, concurrency, subscriptions) are excluded, not zero.
<!-- /generated:inputs -->

## 2. Tier economics (5 clients, base usage, ex GST, per client per month)

<!-- generated:tier-economics (build/build_markdown.py; don't hand-edit) -->
|  | Essential | Professional | Premium |
| --- | ---: | ---: | ---: |
| Price | A$699 | A$1,099 | A$1,999 |
| Base usage | 320 min, 80 SMS, 60 support min | 800 min, 300 SMS, 120 support min | 1,440 min, 540 SMS, 180 support min |
| Variable cost (voice, carrier, numbers, SMS, payment fees) | A$94.94 | A$210.75 | A$394.16 |
| **Gross contribution** | A$604.06 (**86.4%**) | A$888.25 (**80.8%**) | A$1,604.84 (**80.3%**) |
| Support labour | A$60.00 | A$120.00 | A$180.00 |
| Shared platform (Vercel ÷ 5) | A$5.87 | A$5.87 | A$5.87 |
| **Margin after allocated costs** | A$538.19 (**77.0%**) | A$762.38 (**69.4%**) | A$1,418.97 (**71.0%**) |
| Overage price / floor at 70% marginal margin | A$0.80 / A$0.69 | A$0.75 / A$0.69 | A$0.70 / A$0.69 |
| Minutes the base price funds before overage (break-even) | ~3,146 | ~4,798 | ~8,882 |
| Setup (proposed, not approved, not quoted): price / labour / contribution | A$990 / 8 h / A$485.96 | A$1,490 / 12 h / A$733.96 | A$2,490 / 20 h / A$1,229.96 |

Client break-even (covering Vercel Pro) is **1 client** in every tier. The setup row is internal modelling only: setup fees are proposed and are never quoted or invoiced.
<!-- /generated:tier-economics -->

### Margin after allocated costs, low / base / high usage × client count

<!-- generated:margin-grid (build/build_markdown.py; don't hand-edit) -->
| Tier | Usage | Min/client | 1 client | 5 clients | 10 clients | 25 clients |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Essential | Low | 160 | 82.7% | 86.1% | 86.5% | 86.8% |
| Essential | Base | 320 | 73.6% | 77.0% | 77.4% | 77.7% |
| Essential | High | 600 | 64.4% | 67.2% | 67.5% | 67.7% |
| Professional | Low | 400 | 80.7% | 82.9% | 83.1% | 83.3% |
| Professional | Base | 800 | 67.2% | 69.4% | 69.6% | 69.8% |
| Professional | High | 1,400 | 56.0% | 57.6% | 57.9% | 58.0% |
| Premium | Low | 720 | 82.2% | 83.4% | 83.6% | 83.7% |
| Premium | Base | 1,440 | 69.8% | 71.0% | 71.1% | 71.2% |
| Premium | High | 2,520 | 58.9% | 59.9% | 60.0% | 60.0% |
<!-- /generated:margin-grid -->

High usage includes overage revenue and **double** the support time. Support hours scale with clients: at 25 Premium clients on base usage that is 75 hours a month of M&U time, so hiring or automation comes before that point.

### Estimated vs measured vs invoice-reconciled

<!-- generated:estimate-status (build/build_markdown.py; don't hand-edit) -->
| Cost | Estimated | Measured | Invoice-reconciled |
| --- | --- | --- | --- |
| Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tier | US$0.12 | **empty**: Not established | **empty**: no invoice matched yet |
| Twilio Elastic SIP origination, AU mobile | US$0.006 | **empty**: Not established: no production usage for a paying receptionist client yet | **empty**: no invoice matched yet |
| Twilio AU mobile number | US$8.25 | **empty**: Not established: no production usage for a paying receptionist client yet | **empty**: no invoice matched yet |
| Twilio AU outbound SMS | US$0.0515 | **empty**: Not established: no production usage for a paying receptionist client yet | **empty**: no invoice matched yet |
| Neon Postgres usage (Launch plan); Vercel usage beyond the US$20 credit and extra seats; AU carrier fees on SMS; Twilio trunk call recording (if switched on); Staff alert email; Retell concurrency above 20 free slots; Other tools and subscriptions allocation | **unknown (excluded, not zero)** | empty | empty |
<!-- /generated:estimate-status -->

## 3. What moves the margin (ranked)
1. **Our own time.** Support and onboarding are the biggest costs after go-live. Automated booking alerts and the weekly report replace manual summaries.
2. **Cover mode.** After-hours and overflow only (not all calls) keeps Essential clients inside 400 minutes. [OWNER DECISION (a) PENDING: is Essential cover after hours and busy / no answer only, or business hours alongside the team too? Not decided.] If business hours are included, re-cost Essential first.
3. **Voice tier.** If `retell-Leland` bills as a platform voice, cost drops US$0.025/min (about A$0.037). Confirm in the Retell dashboard (owner).
4. **Call length caps.** Max call duration 8 minutes and 15 s silence end-call (prompt v3 recommendation, owner yes).
5. **Unknowns to scope next:** Neon compute hours, the alert email provider, a second Vercel seat, Retell concurrency above 20 once there are 10+ clients.
6. **Don't** swap to a cheaper LLM to save cents: safety-rule adherence matters more than A$0.02/min.

Transfer is not sold. If it is ever built: Twilio termination to an AU mobile is 0.071/min and the Retell leg may keep billing; re-model before offering it.

## 4. Jev (TypeSafe) in the receptionist

**Principle:** hard rules, 000 handling, permissions, billing and actions stay in code and the prompt. Jev makes only narrow typed judgments, **after** the call, on minimal non-identifying text.

| Candidate use | Where | Verdict | Why |
|---|---|---|---|
| Callback-window extraction | Async | **Dropped**: Jev docs say date reasoning is unreliable |
| **False-booking claim check on synthetic utterances** | Async | **Pilot** | High value for staff (a sortable callback queue). Input is a short phrase with no name, number or health detail. A deterministic parser struggles with slang and contradictions |
| Follow-up priority | Async | Reject | Rules on structured fields (urgent flag, callback window, new patient) do this in code for free |
| Urgency tier or "needs a human" from the caller's reason | Async | **Reject for now** | The reason text is **health information**. Sending it to a US processor with vague retention needs a DPA or zero-data-retention confirmation and client disclosure first |
| In-call intent/urgency routing | Live call | Reject | Adds 250–700 ms and a US hop per turn. Retell's LLM already handles the turn. Emergency handling must not depend on a network judgment |
| "Response lacks evidence" check | Async | Reject | Low value here; the fee-vs-knowledge-base check is already deterministic |
| QA-flag second opinion on transcripts | Async | Reject on real calls (transcripts); **allowed on synthetic evals only** | Privacy |

### The pilot (revised 27 Sep after the ministry review and TypeSafe's own docs)
**Callback-window extraction is dropped as the pilot.** TypeSafe's model-jaggedness page lists date and time reasoning as **unreliable** (docs.typesafe.ai/model-jaggedness/jev-1.13). The 30-case set in `research/jev-callback-evalset.md` stays as a test asset, with Jev limited to classifying slots and code doing the dates, if ever revisited.

**Pilot: a synthetic-only false-booking shadow checker** (ministry recommendation).
- **Question (Jev `noul`):** "Does this agent utterance claim that an appointment was booked or confirmed?" Criteria: a request taken ("the team will call to confirm") = no.
- **Input state:** one agent utterance from **synthetic** eval transcripts or fictional owner test calls. No caller text, no names, no health details.
- **Output:** probability 0–1. **≥ 0.85** raises a review flag. **0.5–0.85** flags "check". **< 0.5**, timeout or error: rely on the existing regex flag (`FALSE_BOOKING`) alone.
- **Where:** asynchronous, after the call. Never in the live call.
- **Role:** a second opinion beside the deterministic regex. Disagreements go to a human. It certifies nothing and doesn't release gates.
- **Cost:** about US$0.00004 per utterance at US$0.042/M input tokens (TypeSafe's published price). Negligible.
- **Evaluation:** 40 synthetic utterances (20 true booking claims including tricky ones like "Don't worry, you're all set for Tuesday"; 20 honest requests including "I can't book you in, but the team will call"), independently labelled.
  **Pass:** zero missed true claims at the 0.5 threshold, at most 2 false flags, and p95 under 2 s.
  **Fail:** any missed claim. Then keep the regex only.
- **Rejected:** in-call triage, urgency ranking of health text, consent or legal judgments, release approval, and sending any real caller data while TypeSafe's retention is unspecified (standard plans have no retention period; zero data retention is enterprise-only).

## 5. fast-jev-compaction (coding-agent context): REJECT
Its core claim (replacing Claude Code's native compaction) isn't supported by the current hook API (PreCompact is observation-only; see its own issue #88). It would send whole session content, including tool output, to a US API with no redaction, which conflicts with our rules. No reproducible benchmark is published. Details, and a synthetic benchmark design if it's ever revisited: `research/fast-jev-compaction.md`. Nothing was installed.
