# Deal desk: independent adversarial review

Reviewed 3 Oct 2026. Worktree `D:/AgenticOS-deal-desk`, branch `quoting/deal-desk-20261003`, HEAD `59c567e2`. No repo file was edited (`git status` clean after the review). All scratch files are in `D:/deal-desk-review/`. Review browsers are closed.

## Verdict

**Not ready to hold real deals. The money arithmetic is sound; the app around it can lose every saved deal.**

- The approved prices, per-month rounding, GST per line, stage allocation, FX direction and fee credits all matched hand-derived values (89 of 113 cases matched; none of the 24 mismatches is in an approved-price or invoice calculation).
- One critical defect: an ordinary half-finished edit (for example changing a stage from 50% to 30%) is saved, and on the next reload every saved deal is silently replaced by the seed examples and then overwritten.
- No XSS was found in the page, either preview frame or the HTML downloads. CSV and Markdown exports are not neutralised.
- The agreement PDFs are clean: standard cases are exactly 2 pages, long content goes to Appendix A in full, flags and the draft bar are present, every price equals the app.
- The break-even panel can state "stays profitable" beside a column showing a loss.

Counts: **1 critical, 8 major, 14 minor, 8 nits** confirmed, plus 4 unconfirmed concerns.

## Findings: confirmed defects

| ID | Sev | Where | What is wrong | Evidence | Suggested fix |
|---|---|---|---|---|---|
| F01 | critical | `tools/deal-desk/app.ts:324-330` (refreshOut swallows errors), `:376-377` (rollback never fires), `:27-29`, `:41-43`, `:32-36` | A value that parses but cannot be calculated is kept and saved. On reload `store.read()` fails validation for that one deal, returns null, the app shows only the seed deals with no warning, and the next edit overwrites storage. Every saved deal is lost, not just the broken one. | browser1 A1-A4: stage 50% to 30% shows "Can't calculate yet", status says "Saved"; after reload the deal list has only the 4 seeds while storage still holds 5; one keystroke later storage holds 4. Same loss for target margin 100%, shared across 0, FX 0, average call 3 s, term 121 months, removing a stage (A5, all `lost: true`), and 999,999,999 minutes. Shots `A2-stages-80pct.png`, `A3-after-reload.png`. | Make refreshOut rethrow (or return a failure) so the input handler restores the old value and marks the field invalid. In `store.read`, validate deal by deal and keep the ones that fail (open them in an "needs fixing" state); never fall back to seeds when storage is non-empty; never write over storage that failed to load. |
| F02 | major | `src/lib/deal-desk/deal.ts:142-158` (parseDeals), `app.ts:425` | Import validates only by running the two calculators. A deal with `quote.validDays: 1e300` or a bad `preparedOn` is accepted; opening the Quote tab throws, the tab is saved as "quote" first, and after reload the app is stuck on "Loading the deal desk…". | browser2 I-validdays: `storedTab: "quote"`, body after reload "Loading the deal desk…", RangeError at addDays. calc H06, H11. | Validate quote fields in parseDeals (also call buildQuote and renderAgreementHtml). Wrap `render()` so a failing tab falls back to the Deal tab with a message, and persist the tab only after it renders. |
| F03 | major | `deal.ts:131-133` (arrays taken as-is) | Array items are not validated. A stage without `label`/`trigger` imports fine, then Quote and Agreement throw and the preview is blank. | browser2 I-badstage: "Imported 1 deal(s)", then TypeError in renderQuoteHtml on tab open and on every reload. calc H07, H08. | Merge each stage and cost item against a default item; reject wrong types. |
| F04 | major | `app.ts:393-396` (ids set not updated), `:429` | Two deals with the same id in one import file are both added. The second can never be opened, and deleting one deletes both. | browser2 I-dupids: clicking "Twin B" opens "Twin A"; one delete leaves 0 twins. | Add each new id to `ids` as it is pushed; re-id duplicates inside the file. |
| F05 | major | `src/lib/deal-desk/receptionist.ts:183-189`, `:212-217` | The loss search assumes profit is monotone, but support time is a step function of usage (low / expected / over). It tests only 0, the allowance and the ceiling, so it reports "Stays profitable up to 8,000 minutes" when the first minute over the allowance is a loss. | calc B02: brute force first loss at 401 min, function returns null. Shot `C3-breakeven-contradiction.png`: that sentence sits beside an "Over allowance" column at −A$46.94. | Evaluate at allowance + 1 as well and search each band separately, or scan band boundaries; if any entered column is a loss, never print "stays profitable". |
| F06 | major | `receptionist.ts:219-220` | The recovery search assumes a loss at the allowance. With low-usage support above expected support it returns 401 when the true recovery is 201 minutes. | calc B03: expected `[0, 201]`, got `[0, 401]`. | Check `op(allowance) < 0` before searching; otherwise search inside the allowance. |
| F07 | major | `deal.ts:164-166` (csvCell) | CSV cells are not neutralised. Deal names and cost labels starting with `=`, `+`, `-`, `@`, tab or CR reach the file raw. | calc C-* (7 cases fail). browser1 B6 shows the raw payload as the first cell. | Prefix such text cells with `'` and always quote text cells; also quote on `\r`. |
| F08 | major | `src/lib/deal-desk/quote.ts:51` | A website discount row has `money: null`, so the quote prints "Discount … To be confirmed" while the total is already discounted. The lines do not add to the total and the discount amount is never stated. | calc W30. | Give the row the negative ex-GST, GST and incl. amounts. |
| F09 | major | `tools/deal-desk/index.html` (`.filebtn input{display:none}`), `app.ts:310-323` | Keyboard access: the Import control cannot be reached by keyboard, and any change that re-renders (discount type, care plan tick, package, add/remove row) drops focus to `<body>`. | browser2 K1 `fileInputDisplay: "none"`; K4 focus after change = `BODY` both times. | Hide the file input visually, not with `display:none`; restore focus by element id after `render()`. |
| F10 | minor | `receptionist.ts:121` | `clientsSharingPlatform: 0` is silently treated as 1. | calc R23-0 returned 2935; browser1 C2 `share0: "ok"`. | Reject 0 with a message. |
| F11 | minor | `app.ts:249`, `money.ts:89` | "Largest monthly discount before a loss" is rounded to the nearest whole percent, so it can show a figure that is already a loss (68.85% shown as 69%). | calc B04: −A$1.54 at the displayed 69%. | Round down, or show one decimal. |
| F12 | minor | `src/lib/deal-desk/website.ts:201` | Break-even price is `Infinity` when a creditable fee is 100%, and `0` when a non-creditable fee is 100%. Neither is a price. | calc W25, W26. Not shown in the UI today; the README quotes this figure. | Return null when `1 − feeShare <= 0`. |
| F13 | minor | `deal.ts:131-139` (mergeDefaults) | A `__proto__` key in imported JSON replaces the merged deal's prototype, so attacker keys are inherited. `Object.prototype` is not polluted. | calc H04 pass, H05 fail; browser2 I-proto `protoIsPlain: false, inherited: "yes"`, `({}).polluted` undefined. | Skip `__proto__`, `constructor` and `prototype`; use `Object.hasOwn` rather than `in`. |
| F14 | minor | `deal.ts:131-139`, `website.ts` | Enumerations are not checked on import: `price.gst: "none"` gives a quote with GST A$0.00; currency "EUR" is converted as USD; `includedChangeMinutes: 1e999` prints "up to Infinity minutes" in the agreement. Arrays in place of objects add stray keys. | calc H09, H10, H12; browser2 I-nogst (Checks tab does flag it critical), I-wrongtypes (`include` gained keys 0 and 1). | Validate enums and every number that reaches a document. |
| F15 | minor | `quote.ts:176-196` | Markdown export does not escape HTML or `|`. A raw `<img onerror>` survives, and a pipe in a stage label breaks the table. | calc X04, X05; browser1 B5. | Escape `<`, `&`, `|` in Markdown cells. |
| F16 | minor | `app.ts:437-440` | Switching package discards entered usage columns, onboarding hours and term with no confirmation, while keeping the discount and setup fee. | browser1 E1. | Confirm before replacing edited usage, or keep it. |
| F17 | minor | `quote.ts:66-67` | The monthly row detail always says "(catalogue 2026-09-27, approved 2026-09-28)", even beside a discounted price. "Approved" sits next to an unapproved amount. The flag is present. | `png/q-rev-b-draft-p3.png`. | Drop the approval note when a discount applies, or say "list price approved". |
| F18 | minor | `src/lib/deal-desk/agreement.ts:77` | The agreement strips "(at go-live)" from the report list, so "Weekly proof report" and "M&U works the call-review queue weekly" read as available now. The catalogue marks both at-go-live and never run on a real call. | `png/q-rev-b-agreement-p1.png`, `png/q-rev-d-agreement-p1.png`. | Keep the qualifier, or move reports into the "start at go-live" sentence. |
| F19 | minor | `website.ts:224` | The 50/50 check looks only at the two percentages. Trigger text can be changed to anything (for example "90 days after launch") without a flag. | Source reading. | Compare triggers with the confirmed wording, or flag any edited trigger. |
| F20 | minor | `quote.ts` print CSS | The quote has no `@page` size, so the PDF prints on US Letter (612 × 792 pt) with `preferCSSPageSize`. The agreement is A4. | pdfcheck: every `*-draft.pdf` and `*-review.pdf` is 612 × 792. | Add `@page{size:A4;margin:14mm}`. |
| F21 | minor | `quote.ts:152` | Quote page breaks: a heading can be left alone with one list item at the page bottom, the footer can land alone on a last page, and h3 headings have no break rule. | `q-rev-a-draft` p1 ends "TIMELINE" + 1 item; `q-rev-d-review` p6 holds only the footer. | `h3{break-after:avoid}`, `li{break-inside:avoid}`, keep the footer with the Acceptance block. |
| F22 | minor | `app.ts:279-291`, `:424` | Export buttons are enabled until the preview frame finishes loading, and the fit state is the previous render's. A fast click can export an agreement that has not been measured. | Source reading; not reproduced. | Start disabled; enable in `onload`. |
| F23 | minor | `agreement.ts` screen CSS | At 375 px the agreement preview shows a 794 px sheet in a 341 px frame: only the left 43% is visible without sideways scrolling inside the frame. No page-level overflow on any tab. | browser2 M `frame: {clientW: 341, scrollW: 794}`; `shots/M375-agreement.png`. | Scale the sheet to the frame width on small screens. |
| F24 | nit | `app.ts:218-220` | The 12 usage-grid inputs are labelled with raw paths ("rx.columns.low.billableSeconds"). | browser2 K1 `pathAsName: 12`. | Use "Low usage: billable time". |
| F25 | nit | `app.ts:319` | Tabs have `role="tab"` but no arrow-key movement, no tabpanel, no `aria-controls`. The export menu does not close on Escape or outside click. Error text is not linked with `aria-describedby`. | browser2 K1, K3. | Complete the tab pattern or use plain buttons. |
| F26 | nit | `app.ts:336-344` | Saving is debounced 250 ms with no flush on page hide; the last edit is lost if the tab closes at once. | Source reading. | Flush on `pagehide`. |
| F27 | nit | `website.ts` approval | Choosing "Percent" at 0% or "Fixed" at A$0 is flagged as a discount; A$1,500 ex GST is flagged as differing from A$1,650 incl. | Source reading. | Compare computed totals. |
| F28 | nit | `quote.ts:164` | "Total one-off" excludes a "To be confirmed" setup row without saying so. | `png/q-rev-c-draft-p3.png`. | Label it "Total one-off (confirmed items)". |
| F29 | nit | `agreement.ts` appendix | Appendix pages have no page number, and the second appendix page has no header. | `png/q-rev-d-agreement-p4.png`. | Add a running footer. |
| F30 | nit | `docs/deal-desk/README.md:5, 37, 146, 161` | Stale claims: deep-link list omits `agreement`; "75 pass" and "78 pass" (83 pass now); "the review box lists … the missing M&U ABN" (the ABN is filled and never listed). | `bun --no-env-file test scripts/deal-desk`: 83 pass, 0 fail. | Update the README. |
| F31 | nit | `quote.ts:68-69` (display from the catalogue module) | Per-unit "incl. GST" prices (A$0.83, A$0.17) are rounded per unit; real GST is on the line total (200 × A$0.75 = A$165.00, not 200 × A$0.83). | `png/q-rev-c-draft-p3.png`. | Show the unit price ex GST only, or add "GST is calculated on the line total". |

## Concerns not confirmed

| ID | Concern | Why unconfirmed |
|---|---|---|
| U1 | Care-plan inclusions ("hosting, routine maintenance and up to 30 minutes of content changes a month", "30 days' notice") appear unflagged in quote and agreement. Ground truth confirms only the A$110 price; `sales-backoffice.ts` says exact inclusions are "to be confirmed in writing" and the cancellation term is "proposed". | Needs the owner to say whether these are confirmed terms. |
| U2 | The client copy of a receptionist quote carries no marker for the two open owner decisions (advance vs arrears, mid-month proration) or product readiness; they appear only in the internal review box. The agreement does flag them. Nothing states them as approved. | A judgement call on "never silently". |
| U3 | Once any generated quote box is edited, all scope text freezes. A later package change leaves the scope naming the old package beside the new price. | Not driven end to end. |
| U4 | With every cost row deleted the care-plan card reads "hosting A$0.00" (shot `D1-no-costs.png`). The user removed the row, so it is not an unknown shown as zero by the model, but it reads that way. | Design question. |

## Calculation cases (113; full rows in `calc-results.json`, script `calc.ts`)

All of these matched their hand-derived values:

- Regression: Professional at 1,200 min = A$1,249.00 + A$124.90 = A$1,373.90, no setup line (R01); per-call rounding not produced (R19).
- 59 s / 60 s / 61 s over the allowance on all three tiers: 1 / 1 / 2 extra minutes with half-up GST per line (R02-R10).
- 1,000,000 minutes (R11), 5 extra SMS (R12), 99.99% and 12.5% monthly discounts (R13-R15), a month of 20,000 four-second calls bills nothing extra (R16-R18).
- Provider cost, payment-fee credit and operating profit for the default Professional column (R20-R22); hosting share for 1 and 7 clients (R23); FX 0.0001 and 5.0 (R24, R25, W13-W15); fee 0% and 100% (R26, R27, W19, W20); zero labour rate (R28, W21); setup fee GST (R29).
- Website baseline, 1-cent price, GST half-cent cases 5/15/25/105 c, 99.99% discount, stages 1/1/98, 33.33/33.33/33.34, seven stages, stages not adding to 100% rejected, shared costs, care plan disabled, extra-revision fee with zero rounds, unknown costs excluded (W01-W24); price-for-target and break-even hours are self-consistent (W27-W29); 4,000 random stage splits never gave a negative stage or GST off by more than 1 c (W31, W32).
- parseDecimal rejects negatives, exponents, bad grouping, non-ASCII digits (H13, H14). HTML renderers escape every payload (X01-X03).

Mismatches (input; expected; actual; rule):

| Case | Input | Expected | Actual | Rule broken |
|---|---|---|---|---|
| R23-0 | clientsSharingPlatform 0 | rejected | 2935 (as 1 client) | invalid input must not be guessed |
| W25 | fee 100% creditable | null | Infinity | no break-even price exists |
| W26 | fee 100% not creditable | null | 0 | same |
| W30 | 10% website discount in quote | discount amount shown | money null, "To be confirmed" | lines must add to the total |
| H05 | `__proto__` in import | plain prototype | prototype replaced, key inherited | hostile JSON |
| H06 | validDays 1e300 | rejected | accepted | deal that cannot render |
| H07, H08 | stage without label/trigger | rejected | accepted; quote and agreement throw | array validation |
| H09 | price.gst "none" | rejected | accepted, GST 0 | GST always added |
| H10 | currency "EUR" | rejected | converted as USD | no silent guess |
| H11 | preparedOn "not-a-date" | rejected | accepted; buildQuote throws | date validation |
| H12 | includedChangeMinutes 1e999 | rejected | "up to Infinity minutes" | number reaches document |
| C-* (7) | names/labels starting = + - @ tab CR | neutralised | raw | CSV injection |
| B02 | over-allowance support 720 min | first loss 401 | null ("stays profitable") | monotonicity |
| B03 | low support 700, expected 0 | recovers at 201 | 401 | monotonicity |
| B04 | max discount 68.85% | displayed value is safe | 69% shown, loss of 154 c | rounding direction |
| X04, X05 | Markdown export | escaped; 4 columns | raw HTML; 5 columns | export escaping |

Timing: one `rxBreakEven` 5 ms; `calculateRxDeal` with a 1,000,000-minute column 3 ms. No long loops.

## Browser interaction notes (`browser1.ts`, `browser2.ts`; results in `browser1-results-AB.json`, `browser1-results-CDE.json`, `browser2-results.json`; shots in `shots/`)

- XSS: both payloads typed into all 28 text fields. No dialog fired, no `img`, alert `script` or `onerror` node in the page, the quote frame or the agreement frame on any tab. Payloads render as text (`shots/B2-xss-quote.png`, `B2-xss-agreement.png`). Downloaded HTML files contain no raw payload; CSV and Markdown do (F07, F15); the JSON export holds it as data, as expected.
- Print: `window.print` stubbed; the Print button calls it once from a hidden frame.
- Extreme numbers: A$90 trillion and 100,000,024 hours calculate without NaN or Infinity; over-range input shows "Number is too large"; negatives, exponents, 3-decimal percentages and `1000:60` are refused inline.
- Malformed, empty, non-deal, negative and 1e22 imports are refused with a message and leave the deals untouched.
- Keyboard: all main controls are reachable by Tab in a sensible order with a visible 2 px outline (directly or on the input wrapper); every control has a name. Muted text contrast 7.3:1. Exceptions are F09, F24, F25.
- 375 px: no page-level horizontal overflow on any of the six tabs; wide tables scroll inside their own wrapper. Exception F23.

## PDF inspection (`pdf/`, page images `png/<name>-p<n>.png`, extracted text `png/<name>.txt`, data `pdf-inspection.json`)

`Page.printToPDF` answered "Printing is not available" on every attempt across three fresh browsers (8 retries, 3 s apart). The PDFs were produced with the same engine through Edge's command line (`--headless=new --print-to-pdf --no-pdf-header-footer`), which honours CSS page size and prints backgrounds. Text is selectable in all 18 files.

| Document | Pages | Size | Smallest font | Notes |
|---|---|---|---|---|
| (a) website-only agreement `q-rev-a-agreement` | 2 | A4 | 8.0 pt | No flags, no draft bar (all terms match the confirmed offer). A$1,650.00 = A$1,500.00 + A$150.00; A$825.00 / A$825.00; care A$110.00. Equals the app. |
| (a) quote `q-rev-a-draft` / `-review` | 2 / 3 | Letter | 9.0 pt | Draft banner present. Prices equal the app. F20, F21. |
| (b) receptionist + setup + discount agreement `q-rev-b-agreement` | 2 | A4 | 8.0 pt | Draft bar "7 items"; setup A$2,739.00 flagged "setup fees are not approved"; monthly A$1,979.01 (A$1,799.10 + A$179.91) flagged "discounted monthly fee"; billing timing, minimum term, readiness, service agreement and liability flagged. "Summary only … a draft still under legal review. They do not replace it." present. Signature fields and footer clear. F18. |
| (b) quote `q-rev-b-draft` / `-review` | 4 / 4 | Letter | 8.6 pt | Setup and discount flagged inline. Illustration labelled "Illustration only". F17. |
| (c) combined agreement `q-rev-c-agreement` | 2 | A4 | 8.0 pt | Draft bar "5 items". Content reaches y = 771 and 787 of 842 pt; nothing clipped, signatures and footer clear. All prices equal the app (A$1,650.00; A$110.00; A$768.90 = A$699.00 + A$69.90; extra minute A$0.80). Summary-of-draft wording present. |
| (c) quote `q-rev-c-draft` / `-review` | 4 / 5 | Letter | 9.0 pt | No table row split. Client copy has no flags (U2). F28. |
| (d) long content agreement `q-rev-d-agreement` | 4 | A4 | 8.0 pt | 120-character name wraps in the parties block and page-2 header without overlap. Appendix A on pages 3-4 holds all 30 scope lines, deliverables, exclusions, timeline, responsibilities and all 8 special terms (counted in the extracted text). No list item split. F29. |
| (d) quote `q-rev-d-draft` / `-review` | 5 / 6 | Letter | 9.0 pt | All 30 scope lines and 8 notes present. Review copy page 6 is the footer alone (F21). |
| (e) six stages agreement `q-rev-e-agreement` | 3 | A4 | 8.0 pt | Page 1 says "paid in 6 instalments … schedule is in Appendix A", flagged "payment stages"; draft bar "1 item". Appendix table: A$330.00, 4 × A$247.50, A$330.00 = A$1,650.00, equal to the app. No row split. |
| (e) quote `q-rev-e-draft` / `-review` | 3 / 3 | Letter | 8.6 pt | Each of the 6 stage rows carries its own flag; table continues across the page with rows intact. |
| standard receptionist `q-rev-f-agreement` | 2 | A4 | 8.0 pt | Draft bar "5 items"; A$1,208.90 = A$1,099.00 + A$109.90. |

## Truthfulness

- Estimates are labelled as estimates throughout ("Nothing here is a measured or invoiced cost", "Not measured / Not reconciled" columns, "Hours are placeholders, not measured").
- Unknown costs are listed and excluded, never zero, in the model, the UI and the CSV.
- Setup fees, discounts, stage changes, extra-revision fees, term, billing timing, liability and product readiness are flagged in the agreement. Live transfer is stated as not included; "no … booking or revenue guarantees" is stated.
- Nothing sends, issues an invoice or creates a payment session. All seed data is marked synthetic.
- Exceptions: F05 (false "stays profitable"), F17, F18, and concerns U1, U2.

## Not checked

- `Page.printToPDF` over the DevTools protocol (unavailable; command-line printing used instead).
- The agreement over-length block with real overflowing content (long stage wording), and the export race in F22.
- The export menu opened at 375 px, and the multi-tab conflict flow.
- Screen-reader output; only names, roles, focus and contrast were measured.
- The WebView2 desktop client and the `/deal-desk` mount inside the OS.
- `business-economics.ts` and `receptionist-packages.ts` internals, taken as given.
- Legal sufficiency of any agreement wording.
