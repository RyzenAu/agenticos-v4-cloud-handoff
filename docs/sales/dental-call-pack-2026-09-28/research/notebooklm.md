# NotebookLM research — five collections, 27 Sep 2026

> **Historical record (27 Sep 2026, evening).** Questions below that mention the callback-form offer were researched before it was dropped. The current offer is the AI booking receptionist (`../00-START-HERE.md`); the DNCR, privacy and consent findings still apply to it.

Built via the browser (notebook.google.com, signed in as muventuresau@muventures.com.au),
one request at a time, per the `notebooklm-research` skill's caution against parallel calls.
No notebook was published or shared. Treat every NotebookLM answer below as a synthesis of
the cited sources, not as an authority in itself — two consequential claims per notebook
were spot-checked against the original page (see each notebook's "Spot-check" line).

---

## 1. M&U — Premium agency positioning & offer

**URL:** https://notebook.google.com/notebook/aac5e65a-3f7b-424f-ae0d-61029ffda38e
**Sources (10, all loaded successfully):**

| Title | URL / origin | Date |
|---|---|---|
| False or misleading claims — ACCC | https://www.accc.gov.au/business/advertising-and-promotions/false-or-misleading-claims | fetched 27 Sep 2026 |
| Review of AI and the Australian Consumer Law, Final Report (Treasury, Oct 2025) | https://treasury.gov.au/sites/default/files/2025-10/p2025-702329-fr.pdf | fetched 27 Sep 2026 |
| Trustworthiness in Web Design: 4 Credibility Factors — NN/G | https://www.nngroup.com/articles/trustworthy-design/ | fetched 27 Sep 2026 |
| Perceived Value in User Interfaces — NN/G | https://www.nngroup.com/articles/perceived-value/ | fetched 27 Sep 2026 |
| Trust and Credibility: Ecommerce UX — NN/G report | https://www.nngroup.com/reports/ecommerce-ux-trust-and-credibility/ | fetched 27 Sep 2026 |
| FAQs for Consumers — Do Not Call Register | https://www.donotcall.gov.au/consumers/faqs-for-consumers | fetched 27 Sep 2026 |
| Telecommunications (Telemarketing and Research Calls) Industry Standard 2017 | https://www.legislation.gov.au/F2017L00323/asmade/2017-03-28/text/original/epub/OEBPS/document_1/document_1.html | fetched 27 Sep 2026 |
| M&U internal: `01-offer.md` (pasted text, business facts only) | AgenticOS-v4/docs/sales/dental-call-pack-2026-09-28/01-offer.md | project doc |
| M&U internal: `08-lead-source-decision.md` (pasted text) | AgenticOS-v4/docs/sales/dental-call-pack-2026-09-28/08-lead-source-decision.md | project doc |
| M&U internal: `DESIGN-GATE.md` positioning excerpt (pasted text) | AgenticOS-v4/docs/sales/dental-call-pack-2026-09-28/design-gate/DESIGN-GATE.md | project doc |

### Q&A

**Q1. Does anything in 01-offer.md's value worksheet or positioning risk breaching the ACL, and what should our copy avoid / say instead?**
No new risk found — the notebook confirmed `01-offer.md`'s own "what we must never say" list correctly anticipates the ACL exposure. Five risk categories identified, each mapped to a source: absolute performance claims ("never miss a call", "capture every enquiry"); future/outcome guarantees (patient numbers, revenue) needing reasonable grounds *at the time made*; false track record / social proof (claiming "proven with other dental practices" — we have none); misleading by omission (not disclosing overseas data processing); and functionality overstatement ("books appointments", a "Book Now" button on a capture-only tool). It produced a wording table: avoid *"you'll never miss a call"* → use the offer's own callback-request framing; avoid *"guaranteed 20+ new patients"* → use the Value Worksheet with practice-supplied inputs and a "illustration, not a forecast" label plus a zero-benefit row; avoid *"it automatically books appointments"* → "captures requests and delivers a clean hand-off... does not book." **Citations:** ACCC false-or-misleading-claims page, Treasury AI/ACL Review (Oct 2025), `01-offer.md`.
**No contradiction with the call pack** — this reinforces `compliance.md` rule 12 exactly.

**Q2. Where does NN/G's trust/perceived-value/credibility research agree or disagree with DESIGN-GATE's "work is the hero" opening, and what's the open question?**
**Agreement:** lowering interaction cost by putting live demos in the first viewport (not behind a 25% scroll) matches NN/G's "perceived value vs interaction cost" balance; DESIGN-GATE's ban on fake logos/unsourced stats aligns with NN/G's "authentic content" pillar; DESIGN-GATE's explicit demo labelling satisfies NN/G's "radical upfront disclosure" trust factor.
**Genuine tension flagged:** NN/G's fourth credibility pillar is *external* third-party validation (reviews, social proof, "connection to the rest of the web") — DESIGN-GATE relies entirely on M&U's own internally-produced fictional demonstrations, because M&U has no real dental or legal client yet. NN/G's own research says no matter how polished an internal demo is, visitors still look for outside confirmation. **Open research question posed:** does showing three concurrent industry demos in the hero create cognitive overload that depresses perceived value, and does the "fictional business" disclaimer overcome the total absence of external social proof for sceptical practice managers? Recommended test: single dynamically-matched industry demo vs. the proposed three-window layout, measured for initial attention, perceived clutter and comprehension.
**Flag for the call pack:** this is a real, unresolved gap — M&U's positioning currently has no answer to "how do we build trust with zero real clients," beyond honesty about that fact.

**Q3. What open research questions remain in applying the Do Not Call Register and the 2017 Telemarketing Standard to our own lead-sourcing (08-lead-source-decision.md)?**
Four gaps identified, organised under DNCR business-number eligibility, the 2017 Standard's operational controls, synthetic/automated voice rules, and cross-border telephony compliance. Two worth carrying forward: (1) *line classification* — `08-lead-source-decision.md` describes manually verifying a practice's *website*, not verifying whether its listed number is a pure business line vs. a dual-use/sole-trader line that would actually be DNCR-eligible; (2) *register-washing* — the notebook asks whether M&U can legally rely on the "published business number" exemption alone, or whether any future list-based campaign needs formal DNCR list-washing regardless. **This doesn't contradict `compliance.md`'s Monday rule** (which already concludes washing isn't required for hand-verified published numbers) but sharpens the edge case for any future *bulk* campaign.

**Spot-check (2 claims verified against primary source):**
- ACCC "predictions/future claims need reasonable grounds at the time made" — consistent with ACCC's published doctrine (cross-referenced against `compliance.md`'s own 27 Sep fetch of the same ACCC page — matches).
- Do Not Call Register "business numbers ineligible except fax-only" — matches the wording already independently fetched into `compliance.md` from the same official FAQ page on 27 Sep 2026. **Result: consistent, no discrepancy.**

---

## 2. M&U — Dental patient enquiry & receptionist journeys

**URL:** https://notebook.google.com/notebook/f2041f2c-f230-4305-82e8-b0d941bd668e
**Sources (10 of 11 attempted loaded; 1 failure — see below):**

| Title | URL / origin | Date |
|---|---|---|
| AI disclosure required under new commercial radio rules — ACMA | https://www.acma.gov.au/articles/2026-02/ai-disclosure-required-under-new-commercial-radio-rules | fetched 27 Sep 2026 |
| Chapter 7: APP 7 Direct marketing — OAIC | https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-7-app-7-direct-marketing | fetched 27 Sep 2026 |
| Chapter 8: APP 8 Cross-border disclosure — OAIC | https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information | fetched 27 Sep 2026 |
| Guidelines for advertising a regulated health service — Dental Board of Australia | https://www.dentalboard.gov.au/Codes-Guidelines/Advertising-a-regulated-health-service/Guidelines-for-advertising-regulated-health-services.aspx | fetched 27 Sep 2026 |
| Medical Usability: How to Kill Patients Through Bad Design — NN/G | https://www.nngroup.com/articles/medical-usability/ | fetched 27 Sep 2026 |
| Small business — OAIC | https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business | fetched 27 Sep 2026 |
| Website Forms Usability: Top 10 Recommendations — NN/G | https://www.nngroup.com/articles/web-form-design/ | fetched 27 Sep 2026 |
| M&U internal: `01-offer.md` (pasted text) | project doc | project doc |
| M&U internal: `research/compliance.md` excerpt (pasted text) | project doc | project doc |
| M&U internal: `research/video-study.md` excerpt (pasted text, source-linked note only, no raw transcripts) | project doc | project doc |

**Failed source (honestly reported per the skill's "always verify" rule):** Health Practitioner Regulation National Law (NSW) s133 — `https://legislation.nsw.gov.au/view/whole/html/inforce/current/act-2009-86a` — failed to fetch on **two separate attempts** (highlighted red, error icon, no resolved title). Removed via "Remove all failed sources." The Dental Board of Australia advertising guidelines (which quote and operationalise s133) loaded successfully and cover the same ground.

### Q&A

**Q1. Where does compliance.md's dental-advertising / AI-voice-disclosure reading agree or conflict with the Dental Board guidelines and the ACMA AI-disclosure source? Is the "you are speaking with an AI" house rule actually required anywhere?**
**Complete agreement** on dental advertising: both sources prohibit false/misleading advertising, gifts without disclosed terms, unreasonable-expectation claims, and confirm that any review referencing a clinical aspect (symptom, diagnosis, treatment, outcome) is a prohibited testimonial even if organically posted and later republished by the practice. Before/after imagery rules match (consistent framing/lighting/exposure, unedited, explanatory context).
**No conflict** on AI-voice disclosure — the ACMA rule is confirmed **broadcasting-specific** (Commercial Radio Code of Practice 2026, applies to radio broadcasters with a scheduled program/news broadcast), and does **not** extend to telephony, call handling or AI receptionist agents. The notebook confirms our house rule to disclose "you're speaking with an AI" is **strictly voluntary** for telephony — no source (Dental Board, ACMA, or Privacy Act guidance) requires it. **Citations:** Dental Board guidelines, `compliance.md`, ACMA article.

**Q2. What should the the dropped callback-form offer callback form get right/wrong per NN/G form-design and medical-usability research, and what should we test with real patients?**
Four concrete risks flagged: (1) *banner blindness* — NN/G medical-usability research shows safety information in small fonts, or placed away from the primary interaction path, is easily overlooked by stressed users; if the 000 emergency notice sits in fine print below the submit button, patients in acute pain may scan past it and submit the form instead of calling emergency services; (2) *duplicate submissions* — anxious users resubmit forms when feedback isn't immediate; the confirmation must clearly state the request was received and the expected callback window; (3) *placeholder-text pitfalls* — NN/G explicitly advises against placeholder text inside fields (increases memory load, disappears when typing, gets mistaken for pre-filled data) — the callback-time field should use visible labels; (4) notice placement/readability generally. **Open research question posed:** does placing the 000 safety notice at the top of the form with an interactive "Tap to Call 000 / Tap to Call Practice" button redirect acute-emergency patients faster than placing the disclaimer text at the bottom near submit? **Recommended test:** simulated-urgency usability sessions with real dental patients, measuring eye-tracking/scroll patterns, submission error rates and time-to-action.
**Flag for the call pack:** the current design puts the 000 notice as static text per `01-offer.md`; this genuinely-useful finding suggests reconsidering placement and interactivity before Monday's demo, not just its wording.

**Q3. What should the 75-120s receptionist demo show about data location, and is there tension between "show the result first" and being upfront about US-based processing?**
**Yes, real tension, and the notebook proposes a resolution.** The tension: video-lesson 3 says open immediately with a live call, capturing a message, before any setup explanation — but APP 8 requires Australian entities to remain accountable for overseas processing and arguably favours early disclosure. Resolution proposed: incorporate real-time on-screen telemetry during the live-call open (a lower-third banner reading something like *"Live Call | Voice Engine: Retell (US) | APP 8 Cross-Border Hand-off"*) so viewers see the data path without interrupting the demo's flow, then in the post-demo breakdown explicitly frame the US processing as a **strength** ("we ensure full APP 8 cross-border compliance and accountability in our practice hand-offs"), leaning on video-lesson 5 (admitting limitations builds trust).
**Caution for the call pack:** the exact marketing phrase the notebook suggested — *"we ensure full APP 8 cross-border compliance and accountability"* — is NotebookLM's own drafted copy, not a verified compliance claim. Before using anything like it, it must be substantiated per the ACCC "reasonable grounds" rule (Notebook 1, Q1) — don't adopt it verbatim without a compliance review.

**Spot-check (2 claims verified against primary source):**
- Dental Board: "any statement addressing clinical aspects... counts as a testimonial and is prohibited... even an organic review the practice republishes" — **verified verbatim** against the live Dental Board guidelines page via direct fetch: *"A clinical aspect exists if one of the following is expressed: Symptom... Diagnosis or treatment... Outcome..."* and *"The advertiser... is responsible for compliance with the prohibition on the use of testimonials..."* **Confirmed, no discrepancy.**
- ACMA AI-disclosure rule scope (broadcasting-specific, not telephony) — consistent with the article's own headline and `compliance.md`'s independent 27 Sep reading of the same page; not re-fetched separately here since already directly quoted from source in `compliance.md`.

---

## 3. M&U — Independent real-estate buyer/seller journeys

**URL:** https://notebook.google.com/notebook/3968deca-81c8-49cb-9a0d-f23aa669c9c8
**Sources (8, all loaded successfully):**

| Title | URL / origin | Date |
|---|---|---|
| Ecommerce Search User Experience — NN/G report | https://www.nngroup.com/reports/ecommerce-ux-search-including-faceted-search/ | fetched 27 Sep 2026 |
| False or misleading claims — ACCC | https://www.accc.gov.au/business/advertising-and-promotions/false-or-misleading-claims | fetched 27 Sep 2026 |
| Misrepresentation — information for property agents — NSW Government | https://www.nsw.gov.au/housing-and-construction/property-professionals/working-as-an-agent/misrepresentation | fetched 27 Sep 2026 |
| Real estate — ACCC | https://www.accc.gov.au/consumers/specific-products-and-activities/real-estate | fetched 27 Sep 2026 |
| Underquoting guidance for property professionals — NSW Government (x2, both a Fair Trading and an nsw.gov.au copy resolved) | https://www.fairtrading.nsw.gov.au/... and https://www.nsw.gov.au/... underquoting-guidance | fetched 27 Sep 2026 |
| Underquoting quick guide — REINSW | https://www.reinsw.com.au/Web/Web/Members/Real_Estate_Journals/201601/Underquoting%20quick%20guide.aspx | fetched 27 Sep 2026 |
| M&U internal: `DESIGN-GATE.md` Aldergate excerpt (pasted text) | project doc | project doc |

### Q&A

**Q1. What must Aldergate avoid claiming or implying about fictional listing prices, per NSW underquoting guidance, the misrepresentation source and the ACCC real-estate source?**
Four categories: (1) *underquoting/bait pricing* — no fictional listing may display a price lower than a "reasonable estimate" or advertise artificially low prices to generate traffic; (2) *prohibited terminology/formatting* — must avoid banned qualifying phrases ("offers over", "offers above", "$500,000+"), and where a price range is shown for a single property, **the top price cannot exceed the bottom by more than 10%**; multi-unit listings must avoid vague collective pricing ("From $400,000") without per-unit-type ranges; (3) *misleading bidding/auction representations* — no false claim of rejected prior offers, no misrepresenting a property as "passed in" above the highest genuine bid; (4) *unsubstantiated future value/investment claims* — no speculative growth/return predictions without documented reasonable grounds. **Citations:** NSW underquoting guidance (x2), REINSW quick guide, ACCC real estate, misrepresentation source.

**Q2. What should Aldergate's search/filter UX get right per NN/G's ecommerce-search report, and is there tension with keeping the locked hero cover unchanged?**
**Real, structural tension identified.** NN/G research stresses that search controls and filtered results should be immediately visible and scannable with minimal effort, and that filter state should be reflected in the URL. DESIGN-GATE Direction A keeps the full architectural hero cover (giant wordmark over the locked dusk photo) completely unchanged. On mobile viewports (390px), a fixed large hero consumes substantial vertical space, pushing the actual listings and filters below the fold — directly working against NN/G's above-the-fold visibility guidance. **Open research question posed:** when users apply filters on mobile under Direction A, does the static hero impair filter discovery, increase bounce, or cause users to miss dynamic listing updates, compared to a hero that collapses on interaction? **Flag for the call pack:** this doesn't override the owner's "keep the locked identity" rule, but it's a genuine, evidenced usability cost of that choice worth testing (prototyping a collapsing-hero variant was offered as a next step, not yet done).

**Q3. Any contradictions between the NSW sources and REINSW on the 10% rule / "reasonable estimate," and does ACCC add risks beyond NSW Fair Trading?**
**No contradiction found** — both NSW sources and the REINSW quick guide state the identical 10% price-range cap and the same evidence-based definition of "reasonable estimate" (comparable sales, market conditions, unique property characteristics, kept as written evidence on file). **ACCC does add scope**, since it enforces the broader Australian Consumer Law across all commercial conduct, beyond NSW Fair Trading's state-level agency rules: dummy bidding and auction misrepresentation (fictional/non-genuine bids to inflate price, misrepresenting vendor bids); misleading comparative-pricing claims ("WAS $X / NOW $Y" without genuine prior offer); unsubstantiated premium/feature claims (e.g. "eco-friendly", "luxury finishes" without verifiable backing); and a specific duty to consider impact on vulnerable consumers. **Flag for the call pack:** none of these contradict our existing plan, but the ACCC list (dummy bidding, comparative-pricing claims) is a useful addition to Aldergate's copy-editing checklist beyond the state underquoting rules already known.

**Spot-check (2 claims verified against primary source):**
- NSW 10% price-range rule — **verified verbatim** via direct fetch of nsw.gov.au: *"ensure the higher price in a price range does not exceed the lower price by more than 10 percent... if the lower price is $500,000, the maximum price cannot exceed $550,000."* **Confirmed, exact match** to what the notebook and REINSW both stated.
- ACCC dummy-bidding / auction misrepresentation risk — consistent with ACCC's published real-estate consumer guidance (cross-referenced against the WebSearch summary used to select this source; not independently re-fetched word-for-word in this pass, flagged as a lighter-touch check than the 10% rule above).

---

## 4. M&U — Law-firm enquiry & trust journeys

**URL:** https://notebook.google.com/notebook/46f52a1a-c3a3-41a3-9007-e1d4e588d0d8
**Sources (8, all loaded successfully):**

| Title | URL / origin | Date |
|---|---|---|
| Advertising Legal services — The Law Society of NSW | https://www.lawsociety.com.au/practising-law-in-NSW/ethics-and-compliance/regulatory-compliance/advertising-legal-services | fetched 27 Sep 2026 |
| Costs — The Law Society of NSW | https://www.lawsociety.com.au/practising-law-in-NSW/ethics-and-compliance/costs | fetched 27 Sep 2026 |
| What a solicitor must tell you — The Law Society of NSW | https://www.lawsociety.com.au/for-the-public/going-court-and-working-with-lawyers/solicitor-client-relationship/what-your-solicitor-must-tell-you | fetched 27 Sep 2026 |
| False or misleading claims — ACCC | https://www.accc.gov.au/business/advertising-and-promotions/false-or-misleading-claims | fetched 27 Sep 2026 |
| FAQs for Consumers — Do Not Call Register | https://www.donotcall.gov.au/consumers/faqs-for-consumers | fetched 27 Sep 2026 |
| Trustworthiness in Web Design — NN/G | https://www.nngroup.com/articles/trustworthy-design/ | fetched 27 Sep 2026 |
| Website Forms Usability: Top 10 Recommendations — NN/G | https://www.nngroup.com/articles/web-form-design/ | fetched 27 Sep 2026 |
| M&U internal: `DESIGN-GATE.md` Marden & Rowe excerpt (pasted text) | project doc | project doc |

### Q&A

**Q1. What must Marden & Rowe's demo form/copy avoid claiming about costs or outcomes, and are there gaps in the DESIGN-GATE fix plan?**
Avoid: misleading "free"/discount claims with hidden conditions; framing cost estimates as fixed/guaranteed quotes (Law Society rules require disclosures to be *estimates*, updated as matter scope changes); incomplete price displays that omit GST or compulsory disbursements; implying legal work begins on form submission without formal written cost disclosure; outcome guarantees, settlement predictions or success-rate claims; using "Accredited Specialist" or implying specialist expertise without formal accreditation; and silently omitting scope limitations (e.g. what the first meeting covers vs full representation).
**Four genuine gaps identified** in the current DESIGN-GATE fix plan (which currently covers: the two-step prefilled flow, prohibitions on outcome guarantees/testimonials/fake awards, "not legal advice" disclaimers, and address verification): (1) the plan doesn't state the **fee status of the first meeting itself** — if marketed as free, it must comply with ACCC "free offer" rules; if paid/estimated, it must follow Law Society cost-disclosure principles (estimates not quotes, GST/disbursements included); (2) the plan bans fake accreditations but doesn't explicitly restrict controlled terms like "Specialist" or "Accredited Specialist" as mandated by Conduct Rule 36.2; (3) the plan bans outcome guarantees but ACCC standards also restrict general future projections (e.g. estimated timeframes) unless backed by documented reasonable grounds; (4) the plan doesn't set expectations that submitting the demo form does **not** create a solicitor-client relationship or replace formal written cost disclosure on retention.
**Flag for the call pack:** these are concrete, actionable additions — worth folding into the Marden & Rowe fix list (L1 in DESIGN-GATE) before that form ships, even in demo mode. **Citations:** Law Society advertising/costs pages, ACCC, `DESIGN-GATE.md`.

**Q2. What credibility signals should the two-step flow include per NN/G, and does the lamplit-chambers aesthetic (no faces, hands-only film) help or hurt trust?**
Recommended signals: give value before asking for personal data (the checklist/bring-ask lists in step 1, before step 2's form, matches NN/G's "reciprocity" principle); disclose cost/process expectations upfront to avoid the perception of hidden charges; keep step 2 to a single-column layout with minimal essential fields, a clearly labelled submit button, no "Reset"/"Clear Form" buttons; avoid placeholder-only field labels; display the (verified, fictional) address and contact details prominently, since NN/G research ties visible physical-location information to legitimacy.
**Genuine trade-off found on the aesthetic:** *helps* — NN/G confirms colour/tone should match the service (deep green + brass reads as traditional, high-value "corporate"/legal, appropriate for the sector) and that visual polish signals professionalism. *hurts* — NN/G explicitly notes that services requiring high personal trust benefit from showing **who** performs the service; a hands-only film with no face risks reading as generic filler imagery rather than authentic proof of the people behind the firm; dark palettes also require strict contrast checks (M&U's own internal audit already flags at least a 3:1 minimum) to avoid feeling cluttered or unapproachable. **Open research questions posed:** does explicitly captioning images "AI-generated" (as M&U's honesty rule requires) increase or decrease trust compared with the lack of real human faces at all; does the dark lamplit palette increase perceived prestige or increase cognitive load/abandonment versus a high-contrast minimalist design; does the two-step flow's added friction increase conversion (via confidence-building) or introduce unwanted interaction cost.
**Flag for the call pack:** this doesn't call for redesigning the owner's chosen aesthetic, but it names a real, testable trust gap (no human faces) worth being aware of before over-indexing on the atmosphere alone.

**Q3. Does the Do Not Call Register source raise any open question for how Marden & Rowe (or M&U) could ever phone-follow-up a real "Request this first meeting" submission?**
**Yes — four genuinely unresolved operational questions**, none of which are answered by the FAQ itself: (1) *express-consent mechanics* — the DNCR FAQ describes how telemarketers must "wash" lists but doesn't specify what exact opt-in language/checkbox standard establishes legally binding "express consent" from a web form, so it's unclear what Step 2's copy needs to say to exempt the firm's return call from being an unsolicited telemarketing call; (2) *scope boundary* — if an intake staff member's callback mentions fixed-fee packages or additional services beyond just confirming the meeting time, does that cross into "secondary telemarketing content" requiring DNCR compliance even though the primary purpose was a booked callback; (3) *M&U's own third-party role* — if M&U operates the intake platform or executes initial follow-ups on the firm's behalf, is M&U itself required to scrub numbers against the DNCR register as a third-party caller, or does the user's own form submission act as a blanket exemption; (4) *separate SMS opt-in* — SMS follow-ups fall under the Spam Act rather than the DNCR, so a phone-callback consent likely wouldn't automatically extend to text messages.
**Flag for the call pack — this is a genuinely important unresolved question, not just an academic one:** before productising any "request a callback" flow across dental, real-estate or legal clients as a live (not demo) feature, M&U needs a clear legal answer to whether a web-form submission alone constitutes sufficient express consent for an outbound callback, and whether M&U itself (as the platform operator, not just the client) has independent DNCR obligations when making or facilitating that callback on a client's behalf. This applies equally to Lantern Dental's the dropped callback-form offer callback path (Notebook 2) — it's a cross-cutting product question, not specific to law.

**Spot-check (2 claims verified against primary source):**
- Law Society Rule 36 (advertising must not be false/misleading, no false specialist-accreditation claims) — consistent with the WebSearch-sourced summary used to select this source (*"Rule 36... requires... advertising... is not false, misleading or deceptive... must not advertise specialist accreditation unless they are actually accredited"*); not independently re-fetched word-for-word here.
- Law Society costs page: the notebook's discussion referenced general cost-disclosure duties but never specifically cited a "$750 exception" figure, so that WebSearch-sourced detail from a different search pass was **not** re-tested as a notebook claim. A direct fetch of the Law Society "Costs" page confirmed the general disclosure/fairness duty but **did not surface the $750 threshold** on that particular page — it likely sits in a linked PDF (Costs Guidebook) not fetched by NotebookLM. **Flag:** don't rely on the $750 figure without checking the underlying Costs Guidebook directly if it becomes relevant to a client-facing claim.

---

## 5. M&U — Motion, video, component & performance techniques

**URL:** https://notebook.google.com/notebook/7dd20c10-e7f2-4cd4-875a-ca9f6fd9ed70
**Sources (11, all loaded successfully). Design/technique research only — kept separate from business-facts notebooks 1-4 as instructed.**

| Title | URL / origin | Date |
|---|---|---|
| Motion (motion.dev) — home | https://motion.dev/ | fetched 27 Sep 2026 |
| LazyMotion — Optimise size of React bundle — Motion for React | https://motion.dev/docs/react-lazy-motion | fetched 27 Sep 2026 |
| Reduce bundle size of Framer Motion — Motion for React | https://motion.dev/docs/react-reduce-bundle-size | fetched 27 Sep 2026 |
| Anime.js — JavaScript Animation Engine | https://animejs.com/ | fetched 27 Sep 2026 |
| GitHub — juliangarnier/anime | https://github.com/juliangarnier/anime | fetched 27 Sep 2026 |
| Web Vitals — web.dev | https://web.dev/articles/vitals | fetched 27 Sep 2026 |
| How the Core Web Vitals metrics thresholds were defined — web.dev | https://web.dev/articles/defining-core-web-vitals-thresholds | fetched 27 Sep 2026 |
| C39: Using the CSS prefers-reduced-motion query — W3C WAI | https://w3c.github.io/wcag/techniques/css/C39 | fetched 27 Sep 2026 |
| Understanding Success Criterion 2.3.3: Animation from Interactions — W3C WAI | https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html | fetched 27 Sep 2026 |
| M&U internal: `research/design-tools.md` excerpt (pasted text) | project doc | project doc |
| M&U internal: `research/video-study.md` motion/UI-breakdown excerpt (pasted text, source-linked note only) | project doc | project doc |

### Q&A

**Q1. What exactly must our scroll-film sites show under reduced motion to be WCAG 2.3.3 compliant, and is there a gap vs DESIGN-GATE's bar ("a single captioned still, no scrubbing")?**
WCAG 2.3.3 requires non-essential motion triggered by interaction to be disableable — specifically parallax shifts, multi-axis transforms, scaling and decorative slide-ins. It explicitly **permits** essential scrolling movement (new content entering the viewport as a direct result of user scrolling) and non-motion transitions (opacity/colour fades are not "motion animation"). Motion's `useReducedMotion()`/`MotionConfig reducedMotion="user"` align with this by disabling transform/layout animation while preserving opacity and colour transitions.
**A real gap exists, but in the safer direction:** DESIGN-GATE's bar ("a single captioned still, no scrubbing entirely") is **more restrictive than WCAG requires** — WCAG would permit user-controlled scroll-scrubbing and fade/opacity transitions to remain active, while our internal rule strips all of it down to one static frame. **Flag for the call pack:** this is not a compliance risk — if anything it's over-compliance — but it means our own rule is a design/brand choice, not a strict accessibility requirement, and could in principle be relaxed (e.g. allow fade transitions under reduced motion) without breaching WCAG, if that's ever wanted.

**Q2. Would using full Motion instead of LazyMotion risk breaching DESIGN-GATE's 200KB gzipped JS budget, and what's an open question about our actual bundles?**
**Not breaching on its own, but a significant contributor.** Full Motion tree-shakes to ~34kB vs ~4.6kB via LazyMotion + `m` — a ~7-8x difference. 34kB alone is about 17% (over one-sixth) of the 200KB total JavaScript budget, before counting React, React DOM, routing and application logic, so it "substantially increases the risk" of breaching the budget rather than causing it outright. Media assets (images/video) don't count against the JS budget — they drive LCP separately. **Open research question posed:** Motion's own published bundle figures (34kB vs 4.6kB) are benchmarked against **Rollup**-generated bundles; Motion's own documentation warns that **Webpack is less effective at tree-shaking** and produces slightly larger bundles. Since M&U's stack (Next.js/marketing, dental, real-estate) relies on Webpack or Turbopack, not Rollup, **the actual gzipped size of Motion inside our production Next.js builds is unverified** — the 4.6kB/34kB figures may not hold as-is.
**Flag for the call pack / next actions:** run an actual bundle analysis on a production build of one of the three Motion-using React sites before assuming the vendor's Rollup-benchmarked numbers apply.

**Q3. What should our scroll-film components do differently on mobile to avoid LCP/CLS failure, and is this covered by DESIGN-GATE or a gap?**
**A significant, currently uncovered gap was found.** To protect LCP (≤2.5s): mobile devices face tighter CPU/network constraints, so loading/decoding/scrubbing heavy multi-frame video sequences on mobile touch viewports risks breaching the 2.5s LCP budget — the recommended mobile strategy is to bypass video scrubbing entirely on initial mobile load and serve a lightweight static poster image with explicit fetch priority, so the primary visual element renders within the LCP window. To protect CLS (≤0.1): dynamically swapping between video scrubbers and static touch fallbacks, or re-rendering containers as media metadata streams in, can trigger unexpected content jumps classified as disruptive layout shift — mobile components must use explicit CSS `aspect-ratio` or fixed layout dimensions upfront to reserve the spatial footprint, preventing jumps when touch listeners initialise, viewport heights change (e.g. iOS Safari's address bar collapsing), or static fallbacks load.
**DESIGN-GATE currently checks:** initial JavaScript payload (≤200KB gzipped) and accessibility compliance for the reduced-motion case ("a single captioned still, no scrubbing"). **Where the gap lies:** DESIGN-GATE does **not** audit media asset payload size or container/layout stability specifically for the scroll-film components (Lantern Dental's tooth film, Marden & Rowe's hands film, Aldergate's approach sequence) under normal (non-reduced-motion) mobile conditions — the reduced-motion case is covered, the default-motion mobile case is not.
**Flag for the call pack — genuinely actionable:** this is a real product-quality gap, not just theoretical. Before the dental/legal/real-estate demos are shown on a phone (which is how most of Monday's prospects will eventually see them), the scroll-film components should be checked for an explicit mobile poster-image fallback and fixed aspect-ratio containers, which DESIGN-GATE's current acceptance checklist does not explicitly test for.

**Spot-check (2 claims verified against primary source):**
- Motion bundle sizes (34kB full vs ~4.6kB via LazyMotion) — **verified verbatim** via direct fetch of motion.dev docs: *"impossible for bundlers to tree shake it any smaller than 34kb"* / *"just under 4.6kb"* for the `m` component. **Confirmed, exact match.**
- WCAG 2.3.3 essential-motion/scrolling exemption — **verified verbatim** via direct fetch of the W3C Understanding page: *"Animation that is essential to the functionality or information of a web page is allowed"* and *"Moving new content into the viewport is essential for scrolling. The user controls the essential scrolling movement so it is allowed."* **Confirmed, exact match.**

---

## Cross-cutting findings worth the call pack's attention

1. **Trust gap with zero real clients (Notebook 1, Q2):** NN/G's own credibility research says internal demos alone aren't enough — external validation matters, and M&U has none yet. Positioning should keep leaning on radical honesty ("fictional business", "what's real / what isn't") rather than implying proof it doesn't have.
2. **000 safety-notice placement risk (Notebook 2, Q2):** static, bottom-of-form emergency text risks banner blindness under NN/G's medical-usability research — worth reconsidering placement/interactivity, not just wording, before the callback form ships.
3. **Unresolved DNCR follow-up-consent question (Notebook 4, Q3):** applies equally to the dental the dropped callback-form offer flow and any real-estate/legal callback product. Needs a clear legal answer before any "request a callback" flow goes from demo to live product with phone follow-up.
4. **Mobile scroll-film LCP/CLS gap (Notebook 5, Q3):** DESIGN-GATE's acceptance checklist doesn't test mobile media payload or layout stability for the three scroll-film components under normal motion — a real, currently-untested risk to the performance thresholds the call pack already commits to.
5. **Motion bundle size may not hold under Webpack (Notebook 5, Q2):** the vendor's own 34kB/4.6kB figures are Rollup-benchmarked; our stack uses Webpack/Turbopack, which Motion's own docs say tree-shakes less efficiently. Worth an actual bundle-analyzer run before trusting the vendor number.
6. **Real-estate ACCC risks beyond NSW Fair Trading (Notebook 3, Q3):** dummy-bidding and comparative-pricing rules are a useful addition to Aldergate's copy checklist.
7. **Law-firm cost-disclosure gaps in the current fix plan (Notebook 4, Q1):** the DESIGN-GATE Marden & Rowe fix plan doesn't yet state the first meeting's fee status, restrict "Specialist" terminology per Conduct Rule 36.2, or clarify that form submission doesn't create a solicitor-client relationship.

No finding above contradicts a rule already in `compliance.md`, `01-offer.md` or `DESIGN-GATE.md` — every genuine tension found is an **addition or sharpening**, not a conflict with Monday's existing plan.
