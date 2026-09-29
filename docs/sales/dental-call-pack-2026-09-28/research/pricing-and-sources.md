# Pricing and sources — AI receptionist unit economics + lead-source compliance

Compiled 27 Sep 2026 (Sydney). All figures below were fetched live from the cited official pages
on 27 Sep 2026 unless marked UNVERIFIED. Where a fetch tool truncated or summarised a long legal
document, this is noted so the figure/quote can be treated as lower-confidence and spot-checked
manually before it goes in front of a client.

---

## A. Retell AI pricing

Source: https://www.retellai.com/pricing — accessed 27 Sep 2026.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Voice engine / platform infra | 0.055 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Base "Retell Voice Infra" charge, applies to every call |
| LLM — Claude 4.5 Haiku | 0.025 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | This is our configured LLM |
| LLM — GPT-4.1 mini | 0.0128 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Cheaper alternative to Haiku 4.5 |
| LLM — Gemini 3.5 Flash | 0.048 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Listed as a Flash-class option; more expensive than Haiku on this page, not cheaper — note the mismatch with the brief's assumption |
| TTS — Retell platform voices | 0.015 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Standard/platform voice tier |
| TTS — ElevenLabs voices | 0.040 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | "Leland" is an ElevenLabs-style voice — confirm in Retell dashboard which tier it actually bills at |
| TTS — Fish / Cartesia / OpenAI voices | 0.015 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Same as platform tier |
| Telephony — Retell-provided (Twilio/Telnyx) | 0.015 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Not our setup |
| Telephony — custom SIP / BYO Twilio | 0 (no charge) | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Confirms our BYO-Twilio SIP trunk setup is not double-billed by Retell |
| Knowledge base usage | +0.005 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Add-on while KB is attached to the call |
| Knowledge base hosting | 8.00 | per knowledge base / month | USD | retellai.com/pricing | 27 Sep 2026 | First 10 KBs free per page copy |
| Advanced denoising | +0.005 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | |
| PII removal | +0.01 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Not asked for in the brief but relevant if enabled |
| Concurrency — included free | 20 | concurrent calls | — | retellai.com/pricing | 27 Sep 2026 | |
| Concurrency — additional | 8.00 | per extra concurrent slot / month | USD | retellai.com/pricing | 27 Sep 2026 | |
| Retell-issued phone number | 2.00 | per number / month | USD | retellai.com/pricing | 27 Sep 2026 | Not used — we bring our own Twilio number |
| Minimum / monthly commitment | none stated; $10 free credit to start | — | USD | retellai.com/pricing | 27 Sep 2026 | Page states "no minimum commitment" |
| Billing increment | per-second | — | — | retellai.com/pricing | 27 Sep 2026 | "Each call is tracked to the nearest second" |
| Blended headline range | 0.07–0.31 | per minute | USD | retellai.com/pricing | 27 Sep 2026 | Page's own "typical" range across voice+LLM+telephony combos |

**Transfer billing (does Retell keep billing while bridged to a human) and recording/storage fees:**
UNVERIFIED — not stated in explicit dollar/per-minute terms on the pricing page as fetched. The
page's per-minute model implies the agent leg keeps accruing voice-infra + LLM charges for as long
as Retell's side of the call is active, but this needs confirming against Retell's docs
(dashboard call-log / billing docs) or support, since transfer-leg billing behaviour is not spelled
out on the pricing page itself. Do not present a number for this without checking
retellai.com's docs on call transfer billing directly.

Cross-check against the one observed real call: the brief notes ~A$0.20/min observed on one call.
At ~1.52 USD/AUD (ASSUMPTION, see currency section) that is roughly US$0.132/min, which sits inside
the sum of voice infra + Haiku 4.5 LLM + ElevenLabs voice (0.055 + 0.025 + 0.040 = US$0.12/min) once
BYO-Twilio telephony (US$0/min on Retell's side) is accounted for — consistent with the anecdotal
figure, but still treat the A$0.20/min observation as a single data point, not a verified rate.

---

## B. Twilio Australia pricing

Sources: https://www.twilio.com/en-us/sip-trunking/pricing/au and
https://www.twilio.com/en-us/voice/pricing/au — both accessed 27 Sep 2026.

**Currency note:** the SIP Trunking AU page rendered with "$" figures under a page context of
"Calls in: Australia," which the fetch interpreted as AUD — Twilio's SIP trunking pricing pages are
normally priced in USD by default with a country/currency selector, so this should be manually
re-confirmed on the live page (select country = Australia, and check the currency toggle) before
being used in a client-facing model. The Voice pricing page explicitly returned USD. Flagging this
inconsistency rather than guessing.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Elastic SIP Trunking — origination, AU local | 0.0060 | per minute | AUD (unconfirmed — see currency note) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Inbound to our trunk |
| Elastic SIP Trunking — origination, AU mobile | 0.0060 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Our number is AU mobile (+61 485 011 208) |
| Elastic SIP Trunking — origination, AU toll-free | 0.0460 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Not our number type |
| Elastic SIP Trunking — termination, AU general/major cities | 0.0212 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Outbound leg for transfer-to-landline |
| Elastic SIP Trunking — termination, AU mobile | 0.0710 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Outbound leg for transfer-to-mobile (the likely live-transfer path) |
| Elastic SIP Trunking — termination, AU shared-cost service | 0.1760 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | |
| SIP trunk phone number — AU local | 2.50 | per month | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | |
| SIP trunk phone number — AU mobile | 8.25 | per month | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Matches our number type |
| SIP trunk phone number — AU toll-free | 20.00 | per month | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | |
| Call recording (SIP trunking) | 0.0025 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | |
| Call recording storage (SIP trunking) | 0.0005 | per minute stored / month | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | |
| SIP Insights advanced features | 0.0024 | per minute | AUD (unconfirmed) | twilio.com/en-us/sip-trunking/pricing/au | 27 Sep 2026 | Not part of our stack currently |
| Voice — AU local number monthly | 3.00 | per month | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | Programmable Voice product, distinct from SIP trunking numbers |
| Voice — AU mobile number monthly | 8.25 | per month | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — outbound local call | 0.0252 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — outbound mobile call | 0.0750 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — inbound local/toll-free call | 0.0100 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — inbound mobile call | 0.0500 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — recording | 0.0025 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — recording storage | 0.0005 | per minute stored / month | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |
| Voice — transcription | 0.0500 | per minute | USD | twilio.com/en-us/voice/pricing/au | 27 Sep 2026 | |

**Regulatory/compliance bundle fee for AU numbers:** UNVERIFIED — not shown on either page as
fetched. Twilio does apply AU-specific regulatory bundle/identity requirements for local numbers
in some cases; for an AU mobile number this should be checked directly against the Twilio Console
regulatory compliance section for the specific number, not assumed to be zero.

**Important reconciliation flag:** the SIP Trunking page and the Voice page show different AU
mobile monthly numbers (both happened to land on 8.25 in this fetch) and different termination
rates for outbound-to-mobile (SIP trunking termination 0.0212–0.0710 vs Voice outbound-mobile
0.0750) — these are two different Twilio products (Elastic SIP Trunking vs Programmable Voice) and
our architecture uses SIP Trunking for both legs, so the SIP Trunking table is the one that applies
to our origination and outbound-transfer costs, not the Voice table.

---

## C. Other platform pricing

### Resend
Source: https://resend.com/pricing — accessed 27 Sep 2026.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Free tier — transactional email | 3,000 | emails / month | USD ($0) | resend.com/pricing | 27 Sep 2026 | Capped additionally at 100/day |
| Free tier — daily cap | 100 | emails / day | USD ($0) | resend.com/pricing | 27 Sep 2026 | |
| Free tier — domains | 3 | domains | USD ($0) | resend.com/pricing | 27 Sep 2026 | |
| Free tier — marketing contacts | 1,000 | contacts / month | USD ($0) | resend.com/pricing | 27 Sep 2026 | |
| Free tier — data retention | 30 | days | — | resend.com/pricing | 27 Sep 2026 | |
| First paid tier (transactional, "Pro") | 20 | per month | USD | resend.com/pricing | 27 Sep 2026 | Covers 50,000 emails/month; overage $0.90/1,000 |
| First paid tier (marketing) | 40 | per month | USD | resend.com/pricing | 27 Sep 2026 | Covers 5,000 contacts |

Handoff alerts on the free tier (a handful of transfer/notification emails per day) sit comfortably
inside the free 3,000/month, 100/day caps.

### Vercel
Source: https://vercel.com/pricing — accessed 27 Sep 2026.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Hobby plan — commercial use | Not permitted | — | — | vercel.com/pricing | 27 Sep 2026 | Page states: "Our Hobby plan is for personal, non-commercial use." Relevant since MU-Receptionist is a paid client product — Hobby is not the compliant tier for it |
| Pro plan | 20 | per month | USD | vercel.com/pricing | 27 Sep 2026 | Per-seat; the commercially-permitted tier |

### Neon
Source: https://neon.com/pricing (redirected from neon.tech/pricing) — accessed 27 Sep 2026.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Free tier — storage | 0.5 | GB / project | USD ($0) | neon.com/pricing | 27 Sep 2026 | |
| Free tier — compute | 100 | CU-hours / project / month | USD ($0) | neon.com/pricing | 27 Sep 2026 | Scale-to-zero after 5 min idle |
| Free tier — projects | 100 | projects (account-level cap) | USD ($0) | neon.com/pricing | 27 Sep 2026 | |
| Free tier — branches | 10 | branches / project | USD ($0) | neon.com/pricing | 27 Sep 2026 | |

Note: hitting a free-tier limit suspends compute/blocks writes rather than deleting data, per the
page's own wording.

---

## D. TypeSafe / Jev pricing

**Local docs checked first**, per instructions, at
`C:\Users\Nebula PC\source\repos\AgenticOS-v4\docs\JEV-ROUTING.md` and
`docs\jev-bench\*.json` (no `.env`/credential files opened).

JEV-ROUTING.md documents the *integration* (how Jarvis calls `POST https://api.typesafe.ai/v1/systemone`,
the router/Hermes-task-plan/approval-guardian use cases, latency figures from `docs/jev-bench/`) but
does **not** state a per-call or per-token dollar price, free tier, retention policy, or country of
processing — those are operational/latency notes, not billing terms. The jev-bench JSON files
(`docs/jev-bench/*.json`) are benchmark run logs (accuracy/latency), not pricing documents.

**Official source check:** typesafe.ai (the vendor's own root domain) confirms the company and
states on-page: **"Jev. Cost $42 Per Billion input tokens"**, with output tokens not separately
priced (Jev returns a typed decision, not generated text, so there is no output-token cost by
design). The same page states this is "238x lower input price than Claude [Sonnet] 5.1" as a
comparison. Source: https://typesafe.ai — accessed 27 Sep 2026.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Jev input tokens | 42 | per billion input tokens ($0.042 / million) | USD | typesafe.ai | 27 Sep 2026 | Equivalent ≈ $0.000042/1K input tokens |
| Jev output tokens | 0 | — | USD | typesafe.ai | 27 Sep 2026 | No output cost — Jev returns typed choice/score/yes-no, not text |
| Free tier | UNVERIFIED | — | — | typesafe.ai | 27 Sep 2026 | Site directs to console sign-in / hello@typesafe.ai for details; no published free-tier allowance found on the pricing/homepage content fetched |
| Data retention policy | UNVERIFIED | — | — | typesafe.ai/legal/privacy-policy | 27 Sep 2026 | Linked from the homepage footer but not fetched/read in this pass — needs a direct follow-up fetch before quoting a retention period |
| Country of processing | UNVERIFIED | — | — | typesafe.ai | 27 Sep 2026 | Homepage states the company is "Made in SF. With Love" (San Francisco), which indicates company location, not a stated data-processing region/jurisdiction |

Third-party sources (OpenRouter's `typesafe/jev-1.13` listing, and blogs such as eesel.ai,
mindstudio.ai, flaviocopes.com) independently corroborate the $0.042/million-input-token,
free-output figure, which is reassuring corroboration but these are **not** official TypeSafe
sources and were not used as the basis for the number above — the number above is sourced directly
from typesafe.ai. Access is also reported (by these third-party sources, unverified officially) as
gated behind an early-access waitlist as of Sep 2026 — worth confirming directly with TypeSafe
before building a firm unit-economics line for Jev.

---

## E. Google Maps Platform — Places API (New)

### Pricing
Source: https://developers.google.com/maps/billing-and-pricing/pricing#places-pricing — accessed
27 Sep 2026. All figures USD, per 1,000 requests, tiered by monthly volume.

| item | price | unit | currency | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| Text Search — Essentials, free cap | 10,000 | requests / month free | USD ($0) | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Essentials, 100,001–500,000 | 32.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Essentials, 500,001–1,000,000 | 19.20 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Essentials, 1M–5M | 9.60 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Essentials, 5M+ | 2.40 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Pro, free cap | 5,000 | requests / month free | USD ($0) | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Pro, cap–100,000 | 32.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Pro, 100,001–500,000 | 25.60 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Enterprise, free cap | 1,000 | requests / month free | USD ($0) | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Enterprise, cap–100,000 | 35.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Text Search — Enterprise, 100,001–500,000 | 28.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Nearby Search — Essentials, free cap | 5,000 | requests / month free | USD ($0) | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Nearby Search — Essentials, cap–100,000 | 32.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | Tiers down to $2.40 at 5M+ volume, mirroring Text Search |
| Nearby Search — Enterprise, cap–100,000 | 35.00 | per 1,000 requests | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Place Details — Essentials, free cap | 10,000 | requests / month free | USD ($0) | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | |
| Place Details — Essentials, price range | 5.00 down to 0.38 | per 1,000 requests, tiered by volume | USD | developers.google.com/maps/billing-and-pricing/pricing | 27 Sep 2026 | Exact tier breakpoints were not fully captured by the fetch — re-confirm the full breakpoint table on the live page before quoting an exact tier to a client |

**March 2025 change confirmed still current as of Sep 2026:** the fetch reflects a per-SKU free
monthly cap model (10,000 / 5,000 / 1,000 requests depending on SKU and tier), which matches the
publicly-documented replacement of the old blanket US$200/month credit. The fetch also surfaced a
residual mention of a "$200 monthly credit" applying "through February 28, 2025" on a different
page (the older grandfather-credit language), which is consistent with that credit having expired
and per-SKU caps being the current (2026) model — but this transition detail should be
double-checked directly on developers.google.com/maps/billing-and-pricing/pricing before being
stated as fact in a client-facing document, since the fetch tool's summarisation is not a
byte-for-byte quote of the page.

### Places API compliance reading

Primary source used: **Google Maps Platform Service Specific Terms**, archived version
`index-20240422` at https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20240422
— accessed 27 Sep 2026. Supplementary source: **Policies and attributions for Places API (New)**,
https://developers.google.com/maps/documentation/places/web-service/policies — accessed 27 Sep 2026.

**Caveat on currency of the primary source:** repeated attempts to fetch the *live, undated* terms
URL (`cloud.google.com/maps-platform/terms/maps-service-terms`) via the WebFetch tool returned only
a truncated/empty body — the tool's own summarising step failed on the document length, not a 404.
A web search surfaced references to later dated snapshots of this document (e.g. dated April,
June and November 2025/2026 in search-result metadata), so the `index-20240422` snapshot quoted
below, while an official Google Cloud archived version of the real terms, **may not be the
current live wording**. Before relying on this for a client contract or a compliance decision with
real stakes, open https://cloud.google.com/maps-platform/terms/maps-service-terms directly in a
browser and diff it against the quotes below.

**Quoted clauses (from the `index-20240422` Service Specific Terms):**

- **Section 5.2 (Places API — Attribution):**
  > "Customer must provide Google with attribution, in accordance with the Documentation, if
  > Customer uses Google Maps Content from the Places API without a corresponding Google Map."

- **Section 5.3 (Places API — no non-Google map):**
  > "Customer must not use Google Maps Content from the Places API in conjunction with a
  > non-Google map."

- **Section 5.4 (Places API — caching):**
  > "Customer can temporarily cache latitude (lat) and longitude (lng) values from the Places API
  > for up to 30 consecutive calendar days, after which Customer must delete the cached latitude
  > and longitude values. Customer can cache Places API Place ID (place_id) values, in accordance
  > with the Places API Policies."

**From the Places API (New) policies page** (developers.google.com/.../policies):

- Attribution: *"You don't need to add extra attribution if the Content is shown on a Google Map
  where the attribution is already visible"*; but *"When displaying Places API data without a
  Google Map, you must include the Google logo, adhering to the provided style guidelines and
  attribution requirements"*; and *"You must always credit the author when displaying photos or
  reviews."*
- Storage: *"The place ID, used to uniquely identify a place, is exempt from the caching
  restrictions. You can therefore store place ID values indefinitely."* Conversely: *"You must not
  pre-fetch, cache, or store Places API content beyond the allowed exceptions."*

**What this does NOT give us, and had to be marked unverified rather than guessed:** neither fetch
surfaced an explicit clause using the words "database" or "CRM" by name. The closest operative
restriction is the combination of (a) the Section 5.4 caching limit — only place_id may be stored
indefinitely, lat/lng only for 30 days, and other Content ("beyond the allowed exceptions") must
not be pre-fetched, cached or stored at all — and (b) Section 5.3's ban on using Places Content "in
conjunction with a non-Google map." Building a persistent sales CRM/prospect list that stores names,
addresses, phone numbers, ratings, etc. from Places results indefinitely, and using that stored data
independently of a live Google Map display, runs against both of these: it stores Content beyond
what Section 5.4 exempts (place_id only), and if that stored data is ever displayed or used
somewhere other than on a Google Map, it also risks Section 5.3.

**Plain-English verdict:** **Exporting Places API (New) results into our own CRM for ongoing sales
prospecting is NOT compliant as a durable data store**, on the wording quoted above. We may store
`place_id` values indefinitely (Section 5.4) and use them to re-fetch fresh data from the API at
call time, and we may cache lat/lng for up to 30 days, but we may not persist business names,
addresses, phone numbers, ratings/reviews etc. from Places responses into a permanent CRM record
and treat that as our system of record independent of Google Maps — that is exactly the "pre-fetch,
cache, or store... beyond the allowed exceptions" and "in conjunction with a non-Google map"
territory the terms restrict. **This verdict is built on an archived (2024-dated) copy of the terms
because the live current page would not fetch cleanly — re-verify the live page before treating this
as final legal guidance, and if the compliance question is high-stakes (e.g. a client contract),
get a lawyer to confirm rather than relying on this document alone.**

### Licensed Australian business-data alternatives

| source | price | terms/scope | source URL | accessed | notes |
|---|---|---|---|---|---|---|
| ABN Lookup web services (abr.business.gov.au) | Free | Free of charge; requires accepting a "web services agreement" and an authentication GUID; read-only lookup (cannot update ABN details) | abr.business.gov.au/Tools/WebServices | 27 Sep 2026 | Government source — the cleanest compliant path to verify an AU business's ABN/entity details for CRM use. The page fetched did not explicitly confirm unrestricted commercial redistribution rights — the actual web services agreement document (linked from that page, not fetched in this pass) should be read before treating bulk commercial use as pre-cleared |
| Licensed B2B list provider (e.g. Data Axle, illion, or similar) | UNVERIFIED | UNVERIFIED | — | — | No specific provider's live current price was fetched in this pass — flagged as not researched rather than guessed. If needed, get a quote directly from a named provider (e.g. Data Axle Australia, illion Direct Marketing) rather than assuming a figure |
| OpenStreetMap (ODbL) | Free | Open Database Licence (ODbL): share-alike applies to the *database* — if you build a derivative database from OSM data and distribute it, you must offer that derivative database under ODbL too; attribution ("© OpenStreetMap contributors") is required wherever the data or a map made from it is displayed | openstreetmap.org / opendatacommons.org/licenses/odbl | not separately fetched this pass — general ODbL terms are well-established public knowledge, but re-confirm current wording at opendatacommons.org before relying on it | Using OSM business-listing data to build an internal (non-redistributed) CRM is generally more permissive than Places' terms because ODbL's share-alike obligation is triggered by *distributing* the derivative database, not by internal use — but attribution and share-alike-on-distribution still apply, and OSM's own POI/business data is typically far less complete/accurate than Google's for AU SMBs |

---

## Currency conversion

- **ASSUMPTION (explicitly labelled, per instructions):** 1 USD = 1.52 AUD.
- **RBA figure attempted:** a fetch of https://www.rba.gov.au/statistics/frequency/exchange-rates.html
  (accessed 27 Sep 2026) returned a paraphrased AUD/USD of 0.7019 (i.e. USD/AUD ≈ 1.4250) dated
  around 25 Sep 2026, per the fetch tool's summary. **This is a paraphrase from a summarising fetch
  tool, not a verbatim table read**, so treat it as indicative only — before using an exchange rate
  in a client-facing model, pull the exact daily figure directly from the RBA's F11 exchange rate
  table (rba.gov.au/statistics/tables, table F11) for the date in question, which gives an
  unambiguous numeric rate rather than a tool-generated summary.
- Recommendation: use the ASSUMPTION of 1.52 for conservative (higher AUD-cost) modelling since it is
  explicitly labelled and higher than the RBA-derived ~1.425, giving headroom in the unit-economics
  model; swap in the verified RBA F11 figure once pulled directly.

---

## Unverified list

Every figure/claim below could not be confirmed from an official source in this pass, and why:

1. **Retell — does billing continue during a bridged transfer to a human?** Not stated in dollar
   terms on retellai.com/pricing. Needs Retell's own docs/support on transfer-leg billing.
2. **Retell — dedicated recording/storage fee.** Not found as a separate line item on the pricing
   page as fetched; may be bundled into the voice-infra per-minute rate, but this wasn't confirmed.
3. **Twilio SIP Trunking AU page currency (USD vs AUD).** The page rendered "$" under an "Australia"
   country context but Twilio SIP trunking pricing pages are usually USD-denominated with a country
   selector — needs a manual re-check of the currency toggle on the live page.
4. **Twilio — AU regulatory/compliance bundle fee for the mobile number.** Not shown on either
   pricing page fetched; Twilio Console's regulatory bundle section for the specific number should
   be checked directly.
5. **Place Details — exact tiered breakpoints between $5.00 and $0.38 per 1,000 requests.** The
   fetch gave the range's endpoints but not the full breakpoint table; re-pull the live pricing page
   before quoting an exact tier.
6. **Google Maps Platform Terms — whether the `index-20240422` snapshot used for the compliance
   verdict is still the current live wording.** The live undated URL would not fetch cleanly through
   this session's tools (truncated each time); search-result metadata suggested later 2025/2026
   dated snapshots exist. The compliance verdict in this document should be re-checked against the
   live page before being treated as final.
7. **TypeSafe Jev — free tier.** typesafe.ai's homepage did not publish a free-tier allowance;
   directs to console sign-in or hello@typesafe.ai.
8. **TypeSafe Jev — data retention policy.** Linked from typesafe.ai's footer
   (`/legal/privacy-policy`) but not fetched/read in this pass.
9. **TypeSafe Jev — country of data processing.** Only "Made in SF" (company HQ) was found; no
   explicit statement of where API calls are processed/data resides.
10. **TypeSafe Jev — whether access is still waitlist-gated as of 27 Sep 2026.** Only third-party
    (non-official) sources mentioned an early-access waitlist; not confirmed on typesafe.ai itself
    in this pass.
11. **RBA USD/AUD exchange rate — exact verbatim daily figure.** The figure obtained (AUD/USD
    0.7019 / USD/AUD ≈ 1.4250) came from a summarising fetch tool paraphrasing the RBA page, not a
    direct table read of rba.gov.au's F11 series — pull the exact number from the F11 table before
    using it as fact.
12. **Licensed AU B2B list provider — a named provider with a published current price.** Not
    researched in this pass; flagged as not found rather than guessed.
13. **OpenStreetMap ODbL terms — current wording.** General ODbL share-alike/attribution principles
    are stated from established public knowledge, not a fresh fetch of opendatacommons.org in this
    session — re-confirm current wording before citing it as a compliance basis.
14. **Google Maps Platform — March 2025 per-SKU free-cap change being fully and correctly reflected
    for every SKU as of Sep 2026** (vs a residual "$200 credit through Feb 28 2025" reference the
    fetch also surfaced). The core pricing table figures were captured, but the full transition
    narrative should be double-checked directly on the live pricing page.

---

## Sources index

- https://www.retellai.com/pricing — accessed 27 Sep 2026
- https://www.twilio.com/en-us/sip-trunking/pricing/au — accessed 27 Sep 2026
- https://www.twilio.com/en-us/voice/pricing/au — accessed 27 Sep 2026
- https://resend.com/pricing — accessed 27 Sep 2026
- https://vercel.com/pricing — accessed 27 Sep 2026
- https://neon.com/pricing (redirected from neon.tech/pricing) — accessed 27 Sep 2026
- https://developers.google.com/maps/billing-and-pricing/pricing#places-pricing — accessed 27 Sep 2026
- https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20240422 — accessed 27 Sep 2026 (archived snapshot — see caveat above)
- https://developers.google.com/maps/documentation/places/web-service/policies — accessed 27 Sep 2026
- https://abr.business.gov.au/Tools/WebServices — accessed 27 Sep 2026
- https://typesafe.ai — accessed 27 Sep 2026
- https://www.rba.gov.au/statistics/frequency/exchange-rates.html — accessed 27 Sep 2026 (paraphrased result — see caveat above)
- Local: C:\Users\Nebula PC\source\repos\AgenticOS-v4\docs\JEV-ROUTING.md — read 27 Sep 2026
- Local: C:\Users\Nebula PC\source\repos\AgenticOS-v4\docs\jev-bench\*.json (listed, not individually parsed) — read 27 Sep 2026
