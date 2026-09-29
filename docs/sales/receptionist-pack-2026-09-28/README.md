# Receptionist sales pack (28 Sep 2026 edition)

Editable, client-ready documents for the AI booking receptionist. Rebuilt 28 Sep 2026 from the package catalogue (`docs/receptionist-package-catalogue.json`), the economics export (`package-economics.json`) and the consistency fixture (`docs/receptionist-consistency-fixture.json`). The build scripts read every price, minute allowance, rate and inclusion from those files; nothing is typed by hand.

**Status (owner decisions, 28 Sep 2026):**
- **Monthly plans are approved**, ex GST. M&U is GST registered, so 10% GST is added to every invoice.
- **Setup fees are proposed, not approved.** Setup: quoted separately once approved. No document prices, invoices or waives a setup fee.
- **There is no pilot or trial offer.** The approved promise: "Each business's booking, routing and texts are set up and tested before they go live." CTA: "Book a 15-minute demo".
- The receptionist covers business hours, after hours, alongside staff or overflow, per configuration and package. It is never positioned as missed-call cover.
- Direct booking depends on the client's system: at go-live it books into a connected Google Calendar or Cal.com calendar; otherwise we agree a booking-request / lead workflow.
- **Acceptance** = the go-live tests pass on the client's own configuration (a test booking or booking request, an urgent-wording call, routing through the configured cover and forwarding, and a text when SMS is configured) plus the client's written confirmation. Daily review of flagged calls is Premium's 30-day hypercare only. Live transfer to a person isn't offered in any package.
- **Two owner decisions are open (audit A3, 28 Sep 2026).** Until they're made, the documents carry these placeholders verbatim, and `build/check_catalogue.py` reports them:
  - [OWNER DECISION (a) PENDING: is Essential cover after hours and busy / no answer only, or business hours alongside the team too? Not decided.]
  - [OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, or in arrears after each billing period? Not decided.] Billing terms are confirmed in your agreement.
- The service agreement is a **draft for qualified legal review, not for client use**. The live demo line **does not book yet**. Nothing here has been sent.
- **The two PowerPoint decks are STALE, do not send (review T5 R5, 28 Sep 2026).** `STALE-DO-NOT-SEND-sales-presentation.pptx`, `STALE-DO-NOT-SEND-onboarding-deck.pptx` and their PDFs and PNGs (renamed with that prefix so nobody attaches them by accident) predate the A3 fixes: they still carry eight fixed claims (A3 #5, 6, 7, 11, 22, 30, 31, 41), including a billing-timing line that silently decides owner decision (b), and they answer decision (a). PowerPoint can't rebuild them on this PC (unlicensed Office). Until they're rebuilt with `build/build_all.py`, present from the Word documents instead: `proposal-template.docx` for the offer and price, `demo-guide.docx` for the 15-minute demo, and `client-setup-checklist.docx` (with `call-forwarding-guide.docx`) for the kickoff. `renders/render-manifest.json` marks both decks `"stale": true`, and `build/check_catalogue.py` reports them as expected-stale only while that flag is set.

| File | For | Notes |
|---|---|---|
| `proposal-template.docx` | Client, after a demo | Defaults to Essential; yellow fields to replace; includes the Professional invoice example; Appendix A has all three packages. Usman approves before sending. |
| `service-agreement-draft.docx` | Lawyer first, then client | Service, booking modes, billing, data roles (APP), overseas processors, usage, support, cancellation, limitations (not an emergency service; 000). Clauses marked **[FOR QUALIFIED LEGAL REVIEW]**. |
| `STALE-DO-NOT-SEND-sales-presentation.pptx` | **STALE, do not send** (rebuild pending) | Was the 15-minute demo deck. Stale: carries A3 claims fixed everywhere else. Use `demo-guide.docx` and `proposal-template.docx` instead. Old contents: 12 client slides with speaker notes and the honest demo flow; slide 6 states the two booking modes; slide 10 is "set up and tested before go-live"; slide 13 is a **hidden internal economics slide**: delete it before sending the file. |
| `STALE-DO-NOT-SEND-onboarding-deck.pptx` | **STALE, do not send** (rebuild pending) | Was the kickoff deck. Stale: its billing slide states when the monthly fee is billed, which decides owner decision (b). Use `client-setup-checklist.docx`, `call-forwarding-guide.docx` and `proposal-template.docx` §4–§6 instead. Old contents: plan, what we need, calendar, what callers hear, privacy wording, go-live tests and Acceptance, forwarding (with a pointer to `call-forwarding-guide.md`), support and the review each package includes, billing with the invoice example. |
| `demo-guide.docx` | Presenter, one page | Mode A (before go-live) vs Mode B (after); the per-prospect demo close, gated the same way; what never to do. |
| `client-setup-checklist.docx` | Client | 30-minute setup form; asks which booking system they use and which cover they want; no passwords or patient details. |
| `call-forwarding-guide.md` / `.docx` | M&U staff, then client | Carrier-documented codes only, merged 28 Sep 2026 with the receptionist's `carrier-data.ts` (checked against each carrier's own page, 16 Sep 2026); no `##002#`; unverified lines flagged. No porting, ever. The .docx is built from the .md. |
| `lead-capture-positioning.md` | M&U staff | The booking-request / lead-capture mode for legal intake, property and closed-system practices (same packages and prices; trades not sold), what it does and doesn't do, no unsourced stats. |
| `package-economics.json` | Dashboard, docs | Generated by `bun scripts/export-receptionist-catalogue.ts`; don't hand-edit. |
| `renders/` | Visual QA | PDF of every document and a PNG of every page/slide (the sales PDF omits the hidden slide; its PNG showed it). The two decks' PDFs and PNGs are **STALE, do not send** too, and carry the `STALE-DO-NOT-SEND-` prefix until a rebuild with `build/build_all.py` replaces them. |
| `build/` | Rebuilding | `python build/build_all.py` (Windows + Word + PowerPoint + pywin32 + PyMuPDF + `markdown`). Run `bun scripts/export-receptionist-catalogue.ts` first. Then `python build/check_catalogue.py`: it fails if any generated document, render or markdown price block disagrees with the catalogue JSON. |

## Packages (approved monthly plans, ex GST)

<!-- generated:packages (build/build_markdown.py; don't hand-edit) -->
| Tier | Monthly, ex GST | Incl. 10% GST | Minutes | Extra minute | SMS | Base margin after allocated costs (5 clients, estimate) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Essential | A$699 | A$768.90 | 400 | A$0.80 | 200 | 77.0% |
| Professional | A$1,099 | A$1,208.90 | 1,000 | A$0.75 | 600 | 69.4% |
| Premium | A$1,999 | A$2,198.90 | 1,800 | A$0.70 | 1,200 | 71.0% |

Approved 28 Sep 2026, ex GST, + 10% GST. Setup: quoted separately once approved.

**Invoice example:** Professional, 1,200 billable minutes: A$1,099.00 + 200 × A$0.75 = **A$1,249.00 ex GST**; GST A$124.90; **A$1,373.90 incl. GST**. No setup line.
<!-- /generated:packages -->

Method, sources and stress test: `docs/ECONOMICS-STRESS-20260928.md`. Call pack: `../dental-call-pack-2026-09-28/`.

## Before any of this reaches a client
1. A qualified Australian lawyer reviews the service agreement (unfair contract terms, Privacy Act and HRIP Act, Surveillance Devices Act, Spam Act).
2. Booking and SMS go-live approved and retested; until then demos run in Mode A.
3. Setup fees stay "quoted separately once approved" until the owner approves them in the catalogue.
4. Fill Schedule 2's email-alert provider and confirm each processor's location against its current terms.
