# M&U deal desk: profitability and quoting (3 Oct 2026)

Branch `quoting/deal-desk-20261003`, worktree `D:/AgenticOS-deal-desk`, based on `jarvis-voice` @ `6607e4f7`. **Not merged, not deployed.** Local, draft-only: it sends nothing and creates no invoice or payment session. It does not change any approved price.

Preview: `bun D:/AgenticOS-deal-desk/tools/deal-desk/serve.ts` → http://127.0.0.1:4317 (also `deal-desk` in `MU-Workspace/.claude/launch.json`). Deep links: `?deal=<id>&tab=deal|website|receptionist|quote|checks`.

## Audit: what already existed and what was reused

| Existing | Reused how |
|---|---|
| `src/lib/receptionist-packages.ts`, the approved catalogue (2026-09-27, approved 28 Sep) | Imported. No price, allowance, rate or billing rule is retyped. |
| `src/lib/business-economics.ts` (`calculateEconomics`, rates, FX, Stripe, unknown-cost register, consistency fixture) | Imported. The receptionist model is a thin layer over it. |
| `src/lib/price-status.ts` | Imported for the approval lines in the UI. |
| `scripts/leads/sales-backoffice.ts` (`WEBSITE_OFFER`, `OWNER_DECISION_B`, `BOOKING_DISCLOSURE`) | Not importable in a browser (it uses `node:fs`). The values are mirrored, and a test fails if they drift. |
| `src/components/business/economics-workbench.tsx` (Operations) | Left untouched. The deal desk covers what it lacks: a deal-level receptionist view, website pricing, quotes and saving. |
| `mu-video-demos/calculator` | A client-facing lost-enquiry ROI illustration. Different job; no overlap. |
| `D:/MU-Receptionist` `plan-data.ts` (A$349/749/1,490) | Stale draft plans. Not used. |

## Files (all new; no existing file edited)

| File | Owner after handoff |
|---|---|
| `src/lib/deal-desk/money.ts`: integer-cent helpers, allocation, FX, payment fees | OS lead |
| `src/lib/deal-desk/website.ts`: website project model, one-off and care plan kept separate | OS lead |
| `src/lib/deal-desk/receptionist.ts`: receptionist deal model, four usage columns, break-even search | OS lead |
| `src/lib/deal-desk/deal.ts`: deal document, synthetic seeds, save/reopen, CSV | OS lead |
| `src/lib/deal-desk/quote.ts`: draft quote builder plus HTML and Markdown renderers | OS lead |
| `src/lib/deal-desk/checks.ts`: model checks (audit-xls method) | OS lead |
| `tools/deal-desk/{app.ts,index.html,serve.ts}`: standalone, framework-free UI and local server | OS lead (replace with an OS route when integrating) |
| `scripts/deal-desk/deal-desk.test.ts` (31 tests), `scripts/deal-desk/independent-examples.test.ts` (44 tests, written separately from the rules only) | OS gate |
| `docs/deal-desk/screenshots/*.png` | — |

Outside the repo, the only edit was one added entry, `deal-desk`, in `MU-Workspace/.claude/launch.json`.

## Verification

- `bun --no-env-file test scripts/deal-desk`: **75 pass, 0 fail** (517 expects). No install needed.
- Strict `tsc` over all new sources: clean.
- The independent checker derived every figure by hand from the rules. All matched; it found no code defects.
- Browser, in the pane and headless Edge at 1440 px and 375 px:
  - Edits recalculate live.
  - Invalid input is rejected inline.
  - Package switching works.
  - Reload restores the tab, deal and edits.
  - JSON import works, and a duplicate id is renamed.
  - All five downloads fire: HTML review, HTML client, Markdown, JSON and CSV.
  - There is no page-level horizontal scroll at 375 px.
- Fixed during testing:
  - Unknown-cost inputs displayed "NaN".
  - The single-column layout overflowed on phones.
  - Break-even hours were mis-described as "including contingency".
  - A broken stage split hid the other checks.

### Worked examples (tested)

| Case | Result |
|---|---|
| Professional, 1,200 billable min (480 × 150 s) | A$1,249.00 ex + A$124.90 GST = **A$1,373.90**, no setup line. Per-call rounding (1,440 min) is not produced. |
| Professional, 59,999 / 60,000 / 60,001 / 60,060 / 60,061 s | 0 / 0 / 1 / 1 / 2 extra minutes |
| Professional at 1,000:01 | A$1,209.73 (A$1,208.90 + 75c + 8c GST) |
| Zero usage, Essential | A$768.90, provider usage A$0, margin computed; zero website price gives margin `n/a`, not 0% |
| GST half-cent | 5 extra SMS = 75c → GST 8c; 1 extra Professional minute 75c → 8c |
| Website 10% discount on A$1,650 incl. | A$1,350.00 + A$135.00 = A$1,485.00, flagged as unapproved |
| Stages 33.33 / 33.33 / 33.34% of A$1,650 | A$549.95 / A$549.94 / A$550.11; GST A$50.00 / A$49.99 / A$50.01; totals tie exactly |
| US$20 Vercel seat | A$29.35 (÷ 0.7019 × 1.03) |
| Unknown cost | Listed and excluded. Totals are identical to removing the item, never zero. |
| Care plan price change | One-off revenue unchanged |

## Cost sources (none measured or invoiced)

All rates come from `business-economics.ts`, as public list prices re-read on **28 Sep 2026**:

| Item | Rate |
|---|---|
| Retell (conservative base) | US$0.12/min |
| Retell as provisioned | US$0.0828/min |
| Twilio SIP origination | US$0.006/min (Aug 2026) |
| Twilio AU mobile number | US$8.25/month |
| Twilio SMS | US$0.0515 per segment |
| Vercel Pro | US$20/month |
| Stripe (verified on Stripe's page) | 1.7% + A$0.30 from 1 Oct 2026, plus Billing 0.7% |
| FX | RBA US$0.7019 per A$1 (25 Sep) plus a 3% buffer |
| Founder labour | A$60/h, an **assumption** |

The only dashboard reading, about A$0.17/min over two calls (26 Sep), is too small a sample to count.

**Unknown (listed, never zero):**
- Neon usage
- Vercel overage and extra seats
- SMS carrier fees
- Trunk recording
- Alert email
- Retell concurrency above 20
- Other subscriptions
- Supplier GST
- Live voice tier
- Bad debt
- Business overhead
- Real FX spread
- Domain registration and renewal
- Stock and generated assets

**Assumptions in the defaults (editable, labelled in the UI):**
- Website effort: 35 h plus 2 revision rounds of 2 h each. These are placeholder hours, not measured.
- 10% contingency.
- 50% planning target margin.
- Care plan: 30 min maintenance plus 30 min of changes a month.
- Receptionist usage columns come from the catalogue scenarios, with 150 s calls, 5% short calls and 5 webhook events per call.
- Platform carried by one client.

## Pricing risks (estimates under the defaults above)

1. **The A$1,650 website loses money above about 22.7 planned hours** at A$60/h with 10% contingency. The break-even price is A$1,500 ex GST only at that effort.
   - At the placeholder 39 h, the build loses A$1,074. A 50% margin would need **A$5,148 ex GST**.
   - Record real hours on the next build before quoting more sites at A$1,650.
2. **The care plan is thin.** A$110 incl. GST gives about A$10.65/month profit if one client carries a whole Vercel seat, and about A$34 if five sites share it. Any change time beyond the included 30 min makes it a loss.
3. **Receptionist margins hold under the list-rate model.**

   | Package | Expected use | Full allowance |
   |---|---|---|
   | Essential | 73.6% | 71.3% |
   | Professional | 67.2% | 63.3% |
   | Premium | 69.8% | 65.9% |

   - An extra minute costs about 20.5c against a price of 70–80c, so overage is profitable.
   - The real exposure is not charging overage. Without it, losses start at 2,528 / 3,672 / 7,080 minutes.
   - At full allowance a package survives a voice price of up to about US$0.97 / US$0.59 / US$0.62 per minute.
4. **Onboarding is unpaid** while setup fees are unapproved: 8 / 12 / 20 h, or A$480 / A$720 / A$1,200 per client. At expected use this is recovered in month 1, but it is a real cost on every churned client.
5. **Open owner decisions affect cash, not price.**
   - Is the monthly fee billed in advance or in arrears (decision b)?
   - How is a mid-month go-live prorated?
   - The minimum term and notice are catalogue *proposals*.

   Each quote marks these.
6. The 2 Oct handoff records the receptionist as **not safe to sell**. Every receptionist quote carries that readiness flag.

## Integration handoff (for the main OS lead)

- **Mount:** the `src/lib/deal-desk/*` modules are pure and framework-free. Either:
  - add an Operations or Finance route that renders them with OS components, reusing `EconomicsWorkbench` styling; or
  - serve `tools/deal-desk` as a static page under `/deal-desk`.
- **Storage:** the desk uses browser `localStorage` (`mu-deal-desk/v1`). For shared use by Usman and Mehroz, store `Deal` JSON (`serializeDeals` / `parseDeals`) in the OS workspace store. Keep it separate from `crm.sqlite` and the finance databases until the synthetic/real boundary is decided.
- **Drift:**
  - Move `OWNER_DECISION_B`, `BOOKING_DISCLOSURE` and `WEBSITE_OFFER` out of `sales-backoffice.ts` into a pure module. Then `quote.ts` and `website.ts` can import them instead of mirroring them; the drift tests already guard this.
  - Add `scripts/deal-desk` to the gate. It is pure and takes under 1 s.
- **Do not wire** any "send", Stripe, or invoice-issue action to the desk. Quotes are drafts for founder review, and the review box lists everything that blocks issue: unapproved terms, open decisions and missing client details.
- **Next data that would improve it:**
  - real build hours from the Bianca Brown Realty project;
  - one month of Retell, Twilio and Neon invoices once a paying receptionist client exists;
  - the owner's decisions on setup fees, billing timing and proration.

## Addendum (3 Oct, later): two-page proposal and agreement

`src/lib/deal-desk/agreement.ts` and a new **Agreement** tab render a proposal and agreement of at most two A4 pages. It follows the house style of the signed website agreement (`bianca-brown-realty/meeting-pack-20260914`, read for layout and clause wording only).

- **Page 1:** deliverables, investment and payment, working together, signatures.
- **Page 2:** receptionist terms in brief (compressed from the six-page `service-agreement-draft`) and the "few details to get started" checklist.
- **Supplier details:** name, ABN 70 132 896 132 and address are taken from that signed agreement. The quote now uses them too.
- **Unapproved terms** are marked inline: billing timing, minimum term, setup fee, discounts, the liability clause (still needs legal review) and product readiness.
- **Two-page limit:** the tab measures each sheet and warns if content would run over. I measured the four seed deals and an overloaded case (three stages, three special terms, every flag) in headless Edge: content height equals the page height on every sheet, and each PDF is 2 pages.
- **Tests:** 78 pass (3 new).

## Addendum (3 Oct, final): hardening, verified documents and independent review

**State:** 92 unit tests pass, strict typecheck clean, and two real-browser journeys pass (`tools/deal-desk/acceptance/journey.ts` and `journey-review.ts`, headless Edge, synthetic data). Earlier test counts in this file (75, 78) are superseded.

**Saving is now defensive**
- A deal that cannot be calculated is never written to storage; the status line says why and the last good save stays.
- Each saved deal is read on its own. One that will not open is set aside, kept in storage and offered as a download; saved data that cannot be read at all turns saving off rather than being overwritten.
- A newer save from another tab is never overwritten (the tab stops saving and offers "load the latest" or "keep mine as a copy").
- Imports are type-checked field by field, reject unknown enum values, absurd numbers and bad dates, never copy `__proto__`, and give duplicate ids fresh ids. A bad file imports nothing.

**Documents**
- The agreement's standard layout is two A4 pages. Content is never dropped or shrunk to fit: hand-written scope, more than three special terms or more than three payment stages go to a flowing **Appendix A**, and an export that would run past a sheet is blocked with the reason.
- Flagged agreements carry a "Draft for review" bar. The receptionist "terms in brief" say they summarise the full service agreement, which is a draft under legal review, and do not replace it.
- Quote text regenerates from the scenario until it is edited by hand.
- Exported PDFs were inspected page by page (`docs/deal-desk/examples/`): A4, selectable text, smallest type 8 pt (approval tags), body 9.1–9.6 pt, prices equal to the screen, long names wrap, 28 scope lines and 7 special terms carried in full.
- Supplier details were checked against the public ABN register on 3 Oct 2026: ABN 70 132 896 132, "M KHAN & M.M KHAN", active, GST registered from 14 Sep 2026, business name "M&U Ventures".
- Printing uses a same-document frame (no pop-up), so it can work in the desktop client. Not yet tried there.

**Independent review** (`docs/deal-desk/INDEPENDENT-REVIEW-20261003.md`): 1 critical, 8 major, 14 minor, 8 nits. Arithmetic matched hand-derived values in every approved-price and invoice case.

| Finding | Status |
|---|---|
| F01 half-finished edit saved, then all deals overwritten on reload (critical) | Fixed, with unit and browser tests |
| F02–F04 import accepts bad values, malformed items, duplicate ids | Fixed |
| F05–F06 break-even search wrong when support time steps | Fixed: each usage band is searched on its own |
| F07 CSV formula injection; F15 raw HTML and pipes in Markdown | Fixed |
| F08 discount row had no amount | Fixed: rows add up to the total |
| F09 import not keyboard-reachable; focus lost on re-render | Fixed |
| F10–F14, F16–F18, F20, F22 | Fixed |
| F19 50/50 check ignores trigger wording; F21 page-break polish; F23 agreement preview is small on a phone; F24–F31 nits | Open, minor |
| U1 care-plan inclusions and notice period shown unflagged (only the A$110 price is owner-confirmed) | Open: needs the owner's call |

**Still not checked:** Safari and Firefox, real phones, screen readers, the desktop (WebView2) client and the tailnet client, and the legal sufficiency of any wording.

## Addendum (3 Oct, shared workspace): quote workbooks, honest wording, readable documents

Supersedes the earlier notes on browser-only saving and the fixed two-page layout.

**Shared saving (when the OS serves the desk)**
- Deals are saved on the OS as **quote workbooks** through the existing `/leads/*` operator routes (`scripts/leads/deal-desk-store.ts`). A workbook holds pricing scenarios and draft documents; the CRM deal stays the record of the sale, and a workbook only stores a reference to it (`crm:deal:<id>`).
- Every save carries the revision it was based on. A newer save by the other founder is never overwritten: the desk offers "load their version" or "keep mine as a separate copy" (for every deal that tab changed).
- An unfinished edit, such as a payment schedule that does not add to 100%, is kept as a **draft beside the last complete version**, on the server and in browser storage. Drafts are restored on reopen and never exported.
- Deals saved only in a browser stay there and are offered for copying with a preview of what will happen; nothing is moved or deleted.
- Damaged server files are listed and never rewritten. The author of a save is the verified remote signer, or "local" at the PC.
- Attach to a lead's drafts refuses a stale revision, an unfinished draft, and a receptionist package that differs from the lead's saved deal.
- The standalone preview (port 4317) still saves in the browser only.

**Wording**
- Care plan: the A$110/month price is confirmed; inclusions and the notice period are flagged as draft terms awaiting confirmation.
- A caller who asks for a person: callback request plus a staff alert at go-live; the documents say the receptionist does not transfer live calls.

**Documents**
- Agreement body type is 10.5 pt on real A4 pages with page numbers. Content flows onto extra pages; a single offer prints to about three pages and a combined deal to four, plus Appendix A when used.

**Evidence** (`docs/deal-desk/os-evidence/`, isolated test hub on 127.0.0.1:8163 with synthetic data)
- `tools/deal-desk/acceptance/os-journey.ts`: 16 checks pass over real HTTP with two separate browser sessions: local-deal offer and preview, shared save, draft kept across refresh, edit by the second session, conflict refused and kept as a copy, CRM reference, attach to a lead, Operations link, motion kit listing and reduced motion.
- The agreement downloaded in the browser and the copy the server wrote to the lead's drafts are text-identical as PDFs; both show the same prices as the screen.
- Not covered: two authenticated founder identities (both sessions were local), the desktop app, a tailnet browser, Safari, Firefox and physical phones.

## Addendum (3 Oct, after the round-7 release): two confirmed sessions, regenerated documents

- **Two confirmed browser sessions** (`tools/deal-desk/acceptance/two-session-journey.ts`, pc-role synthetic hub from `scripts/acceptance/r7/hub.ts`, one Edge process with two isolated contexts): 16 checks pass. Covered:
  - an unconfirmed browser opens read-only and says so;
  - confirmation with a one-time code;
  - saves credited to the verified person;
  - switching tabs creates no revision;
  - GST, discount, payment stages and USD conversion on screen;
  - a stale edit refused with nothing overwritten;
  - "load their version";
  - refresh persistence;
  - attach refused on a package mismatch, then accepted.
- **Mehroz on loopback is not possible by design.** A browser can only be confirmed as Mehroz through a real Tailscale login, and the confirm-browser command refuses non-interactive shells. Mehroz's attribution is proven through the real plugin in the route-matrix test (`D:/deal-desk-shared/route-matrix-test.patch`, for the lead). A browser test of a remote Mehroz session needs a real tailnet device.
- **Documents regenerated** (`docs/deal-desk/examples/`, synthetic):
  - no street address; region shown with a "supplier address" approval tag;
  - 10.5 pt body text;
  - prices equal to the screen;
  - every pending term tagged;
  - the downloaded agreement is text-identical to the copy written to the lead's drafts.
