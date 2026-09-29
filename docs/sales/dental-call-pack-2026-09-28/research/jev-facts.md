# Jev (TypeSafe) facts — for the dental receptionist integration proposal

Compiled 27 Sep 2026, Australian English. Read-only research; nothing installed or changed.
No `.env`, key files or tokens were opened — API keys are referred to by env var name only
(`TYPESAFE_API_KEY`, and locally `.operator-data/jev-shim.token`).

---

## 1. What Jev is (verified, TypeSafe's own docs)

- Jev is TypeSafe AI's first "System One" model: it returns **typed, calibrated decisions**
  (choice / score / yes-no), not generated text, and per TypeSafe's own claim it "mathematically
  cannot hallucinate or produce type errors" because every answer is constrained to the schema
  you gave it.
  Source: [docs.typesafe.ai/api](https://docs.typesafe.ai/api) (fetched 27 Sep 2026); also summarised at
  [typesafe.ai](https://typesafe.ai/) and third-party write-ups: [MarkTechPost](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/),
  [DataCamp](https://www.datacamp.com/blog/system-one-models-jev), [flaviocopes.com](https://flaviocopes.com/jev/).

## 2. API contract (verified against docs.typesafe.ai/api, fetched 27 Sep 2026)

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`
- **Auth:** `Authorization: Bearer <TYPESAFE_API_KEY>` header (bearer token; name only, value never read/recorded here)
- **Request body:**
  - `state` — the content to evaluate (string, object or array)
  - `model` — e.g. `"jev-latest"`
  - `questions` — a map of named questions, each one of three typed forms:
    - `noul` — yes/no, returns a probability 0–1
    - `choice` — pick one of up to 255 defined options (`criteria` required)
    - `score` — rate against an ordered rubric of 2–10 levels (`criteria` required)
- **Response body:**
  - `model` — which model actually answered
  - `answers` — one Answer per question, matching the question's type, plus:
    - `noul` answers → a `noul` probability field
    - `choice` answers → `choice`, a `probabilities` map, and `confidence`
    - `score` answers → `score`, `legend`, `probabilities`, `confidence`
  - `usage` — `input_tokens` / `output_tokens`
- **Errors:** `401` bad/missing key, `422` malformed request, `429` rate limited, `529` overloaded
  — TypeSafe's docs say to retry 429/529 with exponential backoff.
- **Documented timeouts/SLA latency figures:** none published on docs.typesafe.ai/api as fetched.

This matches how AgenticOS-v4 actually calls it (`scripts/jev.ts`, `scripts/jev-hermes.ts`): one
`fetch` to `JEV_URL = "https://api.typesafe.ai/v1/systemone"`, model `"jev-latest"`, a `state`
object plus a `questions` map of `choice`/`noul` questions, wrapped in a 1.5 s client-side
`AbortSignal.timeout` (our own choice, not a TypeSafe-documented limit — code comment: "the
community routers fall back at 1.5 s; so do we").

## 3. Models behind it

- TypeSafe's model catalogue lists `jev-latest` as the current alias; third-party model-router
  listings (Cloudflare AI docs, TrustedRouter, Opper.ai) show a versioned model such as "Jev 1.13"
  behind it. AgenticOS-v4 hard-codes `JEV_MODEL = "jev-latest"` everywhere (never pins a numbered
  version), so which numbered build answers a given call is TypeSafe's choice, not ours.
  Source: [docs.typesafe.ai/models](https://docs.typesafe.ai/models) (title only, not fully fetched — see Unverified below).

## 4. Latency — TypeSafe's own claims vs our measured numbers

- **TypeSafe's claim:** Jev runs "40x–200x faster than frontier LLMs on comparable tasks."
  Source: search-result summary of TypeSafe/MarkTechPost material (27 Sep 2026) — treat the exact
  multiplier as marketing copy, not independently verified here.
- **Our own measured latencies** (all from `C:\Users\Nebula PC\source\repos\AgenticOS-v4\docs\JEV-ROUTING.md`
  and the underlying `docs/jev-bench/*.json` files, measured on Usman's PC around 24 Sep 2026, over
  our production-shaped multi-question requests — not TypeSafe's own benchmark):
  - Cold request: **683 ms**. Idle 60 s: **463 ms**. Kept warm (unauthenticated `HEAD` every 20 s):
    **~250–300 ms**. (`JEV-ROUTING.md`, "Cache, prefetch and warm connection")
  - Router endpoint, live 77-utterance benchmark, first pass: **p50 294 ms / p95 1,222 ms**
    all-turns; Jev-router-only path **p50 282–311 ms / p95 393–447 ms**
    (`docs/jev-bench/round2-after.json`, `docs/jev-bench/after.json`, `docs/jev-bench/calib-tree.json`).
  - Repeat pass (cache warm): **p50 ~1 ms** (cache hit, not a fresh Jev call).
  - Hermes approval guardian (`/__jev/v1/chat/completions`, 4 yes/no questions + a code
    risk list): calibration run "in ~0.3 s" per verdict, vs the ~4 s gpt-6-sol call it replaced
    (`JEV-ROUTING.md`, section 3 and "Round 2").
  - **These are all our own client-measured numbers around a single-PC network path (Sydney
    residential → api.typesafe.ai), for small multi-question requests. They are not a TypeSafe
    SLA and won't transfer directly to a different network, payload size or request volume.**

## 5. Pricing / free tier (UNVERIFIED — not confirmed on typesafe.ai directly)

- Search results (not independently confirmed by fetching TypeSafe's own pricing page) report:
  **$0.042 per million input tokens, output tokens free**, with TypeSafe estimating an average
  decision costs about **$0.0004**.
  Sources (third-party, not typesafe.ai itself): [flaviocopes.com/jev-pricing](https://flaviocopes.com/jev-pricing/),
  [opper.ai/typesafe/jev-1-13-0](https://opper.ai/typesafe/jev-1-13-0), [trustedrouter.com/models/typesafe-ai/jev](https://trustedrouter.com/models/typesafe-ai/jev).
- **UNVERIFIED:** whether there is a genuine free tier (vs. a small trial credit), any minimum
  spend, and current September 2026 pricing (these third-party pages may lag TypeSafe's own
  page). Before quoting a per-call cost to a dental client, fetch `https://typesafe.ai/pricing`
  (or the current canonical pricing URL) directly and confirm the figure.
- **UNVERIFIED:** "early access" status mentioned in one search summary — confirm current
  general-availability status before selling on it.

## 6. Data retention / training terms (verified — typesafe.ai/legal/privacy-policy, fetched 27 Sep 2026)

- TypeSafe states twice, for emphasis: **"We will not train or fine tune any artificial
  intelligence or machine learning models on your prompts or other Input."**
- General retention language: data is kept "for as long as reasonably necessary to provide you
  with the Services, or otherwise in support of our business or commercial purposes"; on request
  they delete or anonymise data no longer needed, "unless legal obligations require longer
  retention." This is a general/vague retention clause, not a fixed number of days.
- **UNVERIFIED / third-party only:** search results reference a **zero-data-retention (ZDR)
  option for enterprise customers** (source: Medium article by Eduard Ruzga, not typesafe.ai
  itself) — this was not confirmed by directly reading TypeSafe's own ZDR/enterprise terms.
  Confirm directly with TypeSafe (or their DPA) before relying on ZDR for anything containing
  patient-identifiable data.
- Source: [typesafe.ai/legal/privacy-policy](https://typesafe.ai/legal/privacy-policy) (fetched 27 Sep 2026).

## 7. Processing location / region (verified)

- **"The Services are hosted in the United States ('U.S.')."** Any data sent to Jev — including
  from an Australian dental receptionist integration — is processed and stored in the US, not in
  Australia. This is directly relevant to any Australian Privacy Principle (APP 8, cross-border
  disclosure) discussion for a healthcare-adjacent client.
  Source: [typesafe.ai/legal/privacy-policy](https://typesafe.ai/legal/privacy-policy) (fetched 27 Sep 2026).

## 8. Subprocessors (UNVERIFIED — no list found)

- TypeSafe's privacy policy mentions using unnamed "third-party vendors and service providers"
  (payment processors, analytics, email) but **does not publish a subprocessor list** on the page
  fetched. **UNVERIFIED:** no dedicated subprocessor page was located. If a client needs a formal
  subprocessor list (common for health-adjacent DPAs), this has to be requested directly from
  TypeSafe (privacy@typesafe.ai, per their own policy).

## 9. HIPAA / health-data statements (verified absence)

- **No HIPAA compliance statement and no health-data-specific handling disclosure appears in
  TypeSafe's privacy policy as fetched 27 Sep 2026.** This is a fact about absence, not a claim
  that they are non-compliant — but it means we cannot currently tell a dental client "TypeSafe is
  HIPAA-ready" or point to a BAA (Business Associate Agreement) offering. This would need to be
  confirmed directly with TypeSafe before any claim involving patient health information reaching
  Jev.
- Note: HIPAA itself is a US statute; for an Australian dental practice the operative regime is
  the **Privacy Act 1988 (Cth)**, the **Australian Privacy Principles**, and — depending on the
  practice — **My Health Records Act** obligations, not HIPAA. Worth stating explicitly in the
  proposal so "no HIPAA statement" isn't misread as the relevant compliance gap for an AU client.

## 10. Unverified items — summary list

- Exact current pricing figures and whether a genuine free tier exists (only third-party sources
  checked; TypeSafe's own pricing page not directly fetched).
- Enterprise zero-data-retention (ZDR) option — mentioned only in a third-party (Medium) source.
- Full subprocessor list — not published.
- General-availability vs "early access" status as of 27 Sep 2026.
- The exact numbered model build behind `jev-latest` at any given time (TypeSafe can roll this
  forward without our code changing).
- "40x–200x faster than frontier LLMs" — TypeSafe's own marketing claim, not independently
  reproduced here (our own measured numbers in section 4 are the only latencies we can stand
  behind).

## 11. Where AgenticOS calls Jev today (for context, not part of the proposal's integration design)

- `scripts/jev.ts` — the voice reflex layer: one fan-out request with `lane` (choice),
  `page`/`site` (choice), `complete`/`addressed`/`stakes` (noul).
- `scripts/jev-router.ts` — the tree-structured voice router described in `docs/JEV-ROUTING.md`.
- `scripts/jev-hermes.ts` — two uses: `planHermesTask` (reasoning-effort + toolset nouls) and the
  `/__jev` Hermes approval guardian (`operator-plugin.ts` mounts it at Connect middleware path
  `/__jev`, loopback only, bearer token from `.operator-data/jev-shim.token`, name only — value
  never read).
- `docs/JEV-ROUTING.md` is the authoritative local write-up of routing behaviour, thresholds and
  every benchmark number cited in section 4 above.
