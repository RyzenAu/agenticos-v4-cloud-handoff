# Lead-site generator repair, round 8 (3 October 2026)

Branch `gen/lead-sites-repair-20261003`. Built from `r7/candidate-20261003` (c74e2b25) plus the owner's 2 October Aldergate overlay
(commit 44527e5c, byte-identical copy of the 24 working-tree files; each SHA-256 matched the lead's record; none of the 8 modified files had
changed in round-7 F's commits, so nothing needed reconciling). Round 7 as released (3bc6f9e0) is merged in cleanly.

Quality Lab: a private copy at `D:/prog-scratch/qlab-r8` (lab commit 1333bf9, port 4710, MU_DATA_DIR and fetch stub untouched). The lab repo
itself was not edited. Everything the copy changed for listings is in `D:/prog-scratch/qlab-r8/lab-wiring-r8.diff` (see "Lab wiring").

## Baseline (before any change)

Lab run against 44527e5c, which is the state the lab owner tested. For reference, a clean r7/candidate refuses both real-estate fixtures
(it has none of the overlay's residue rules), so it cannot be used as the real-estate baseline.

| | Generated | Fail | Warn | Journeys (pass / fail / skip) | Defects reproduced |
|---|---|---|---|---|---|
| Baseline 44527e5c | 6 of 9 | 20 | 30 | 21 / 11 / 4 | 11 reproduced, 1 not (G-07), 3 by inspection |
| Final (this branch) | 9 of 9 | 3 | 4 | 44 / 0 / 8 | 0 reproduced, 12 not, 3 by inspection |

The 3 remaining fails are one axe colour-contrast finding per dental fixture (see Limits). Self-test 28 of 28.
Classification of G-01..G-15 on the baseline: 14 still reproducible, 1 already fixed (G-07, round 7 commit 4171b6ad), 0 superseded.

## Defect table

Commits: A = 9c591b38, B = e3725273, C = bd22c3b5, D = be764985, E = 045f5bdb, F = 0a165a32, G = the review-fix commit that follows 9c2b38ea. Tests are in
`scripts/lead-sites/repair-r8.test.ts` (R, 33 tests) and `listings.test.ts` (L, 16 tests, 1 skipped when the Aldergate checkout is absent). The 6 original L tests and 27 of the 31 original R tests fail on the baseline (4 were regression guards or already-fixed behaviour); the review-fix tests were written before the fixes.

| ID | Baseline | Fix | Test | Lab before to after | Browser | Limits |
|---|---|---|---|---|---|---|
| G-01 | Reproduced: dental-collision and legal-collision refused | A, own-values.ts: template scanned alone, filled page scanned with the lead's own values set aside (budgets for the static legal page) | R "G-01" x4 (a stale template carrying the surname, a leftover Lantern or Natarajan, a leftover Marden still fail) | 2 refused, now generated | Journeys pass | A flagship word equal to an own value is excused only where the value was placed |
| G-02 | Reproduced: legal-priced-service refused | A: claims audit reads text minus own values | R "G-02" | refused, now generated; lab price check exempts own services since 1333bf9 | pass | See F: services reading as award, guarantee or rating are withheld and noted in PREVIEW.md |
| G-03 | Reproduced on 4 fixtures (full site after expiry) | A (fill.ts): marks `<html>` and appends the notice, a style rule hides the rest; F adds a MutationObserver that restores both | R "G-03" x4 | Expiry journey 4 fail to 9 pass | `expiry.log`: 66 of 66 PASS across dental, legal and real estate, desktop and 390, home, nested routes, 404 and unknown pages, load, refresh, and after the page's own DOM was tampered with | |
| G-04 | Reproduced (overflow 303 and 720 px, menu button at 1066 px) | A: wordmark shrinks and wraps (legal), brand link shrinks and menu button cannot move (real estate), banner wraps | R "G-04" | mobile-overflow, Mobile menu and both enquiry journeys fail to pass | 107-character names read in full at 390 px (shots `rehard`, `leghard`, `dhard`) | Legal header 4 px overlap warning was the sticky header mid-slide in the lab, not at rest (lab now waits 900 ms) |
| G-05 | Reproduced (+61 (0)2 ... ext. 7, 0491-570 156 (a/h)) | A: `telHref` accepts one complete Australian number and writes +61 form, otherwise no link and text only; agent and property pages use the same token | R "G-05" x3 plus "G-05 tel links on sub-pages" x2 | identity fail to pass; new lab check: every tel: on every page dials the supplied number | pass | A number with no area code is shown as text |
| G-06 | Reproduced | B: home page "Services" section mounts the verified services | covered by lab identity check | fail to pass | services visible on home | |
| G-07 | Already fixed (4171b6ad) | none needed | R "G-07" (nested pages) | not reproduced before and after | | |
| G-08 | Reproduced. Cause below | B: `flattenSegmentPayloads` at template build and at fill | R "G-08" x2 | broken-assets prefetch fail to pass; new lab check that every dotted name exists | No 404 for `__next.*` in the browser | |
| G-09 | Reproduced | A: fallback is `/contact` (dental `/#find-us`), mailto only for one plain address; agent pages use the verified email, hidden when absent | R "G-09" x2 | identity and broken-links fail to pass | | |
| G-10 | Reproduced | A: scroll margin on every `[id]` | R "G-10" | Header navigation fail to pass | pass | |
| G-11 | Reproduced | A, D: header anchors and the header phone/email fallback point at `/#...` | R "G-10 and G-11" | 404 broken-links fail to pass | | |
| G-12 | Reproduced | A: email shown beside the phone on legal and dental | R "G-12" | identity warning to none | | |
| G-13 | Reproduced by reading (index.html only) | A: every html page audited, the lead's own text set aside; example figures judged only where fill added words | R "G-13" x2 | by inspection | | The rule is "fill-added words for figures, everything for awards, guarantees, testimonials, named staff" |
| G-14 | Mixed | A, C, D, E: alternating quotes, `&amp;` in the title, per-page tab titles, titled 404, h1 while pages load, skip link and 404 for legal, small text raised to 12 px | R "G-14" x6 | warnings 30 to 4 | | Dental step numbers: axe samples the scroll scene's intentionally dimmed steps (flagship design, unchanged); a few small labels (11.5 px "Sales" role text) remain |
| G-15 | Gap | B, listings.ts and the overlay | L x6 | see below | Journeys "Listing search", "Listing detail", "Listing states" pass | See the shape and the audit |

### G-08 cause

Next 16.3.4 writes each route's segment payloads inside a folder (`buy/__next.buy/__PAGE__.txt`). The browser requests one dotted name
(`buy/__next.buy.__PAGE__.txt`). It reproduces on a fresh `next build` with no generator code involved (probe: 12 of 12 prefetch requests 404 except
the root). Not a routing, hosting or copy problem. A static host serves only existing files, so the dotted copy is written beside each folder.

## Listings input (G-15)

`GenerateOptions.listings?: ListingInput[]` and `listingPhotosRoot?: string` (scripts/lead-sites/listings.ts; callers that pass nothing are unchanged and get the empty state).

1. `id`, `status` (for-sale, under-offer, sold, for-rent, leased, withdrawn), `address` ("9 Ironbark Rise, Marrow Creek" or an object).
2. `price`: the price line as published for a property on the market; omitted gives "Contact the agency for the price". `result`: the sold or leased line; omitted gives "Sold" or "Leased" plus "The sale price was not disclosed."
3. `photos`: local files only (jpg, png, webp, up to 8 MB, checked by their first bytes); remote links are never fetched. None gives a "Photo not supplied" tile, never generated art.
4. `portalUrl` (http or https) shows "View this listing on host" (new tab, noopener). Optional: headline, description[], features[], type, beds, baths, cars (missing counts show a dash), landSqm, internalSqm, priceValue (sorting), inspections[], auctionAt, listedAt, soldAt, rental.
5. Withdrawn: no page, not in any list, not in the page data. Each other listing gets `/property/<street-suburb-slug>` and its photos under `/listing-photos/`.

Lab mapping (`fixtures/real-estate-standard.json`): `address` as is; `status` as is; `priceGuide` becomes `price` (for-sale), `rent` becomes `price` (for-rent), `soldPrice` becomes `result` (sold); `photos: N` becomes N image files in `photos`
(the copy writes tiny PNGs); the lab adds `portalUrl` for fx-01 only. Result: 6 property pages, withdrawn fx-07 absent everywhere, fx-02 "Contact the agency for the price", fx-04 "not disclosed", fx-06 "Leased", fx-02 no photo tile.
No listings (real-estate-hard) gives no property page and plain empty states on Buy, Rent, Sold and the home page.

Design: the static pages carry no property. Listings travel in the page data and render in the browser after hydration (same pattern as the verified
services), one exported placeholder property page is cloned per listing. The template marker is now v3, so a cache with the example stock is refused.

## Aldergate completeness audit (read-only comparison)

Approved cache (mu-site-drafts, 47 pages) against the repaired template (35 pages): the 34 non-property routes are identical (home, Buy, Rent,
Sold, Saved, Sell, Property management, Tenants, Suburbs and 6 guides, Agents and 5 profiles, Insights and 4 articles, About, Contact, Demonstration, Privacy, Terms,
Accessibility, 404). The 13 example property pages are replaced by the placeholder. Header (9 links, saved, phone, appraisal button), mobile menu, 4-column footer,
search with filters, gallery, features, lease details, inspection form, assistant and sticky bar are all kept. Contact flows validate locally and send nothing (lab: pass at 390 and 1440).
Changed on purpose: no example property is anyone's own; the hero photograph is labelled illustrative; stats, activity and the walkthrough band appear only when listings exist;
services section added; banner no longer says listings are fictional. Kept as the owner designed it and labelled as examples: agent profiles, suburb guides (and their "listings" counts, which are zero), insights.
Known gaps: no floor plans or per-listing agents (the business is the contact); suburb pages do not list supplied listings.

## Lab wiring (for the lab owner)

`lab-wiring-r8.diff`: generate.ts passes fixture listings and writes photo files; expectations.mjs makes `/property/` the supplied count and stops requiring "example" labels on Buy, Rent, Sold, property;
static-checks.mjs adds stock-street, withdrawn-leak, listing-in-data, every-tel-link and dotted-prefetch checks; browser-checks.mjs replaces the three stock-specific journeys (they hard-code `/property/3-glover-street-lilyfield`) and waits 900 ms after scrolling so a sliding header is not measured mid-transition.
Also: `scratch` probes `probe-expiry.mjs` (66 checks), `shot.mjs`, screenshots in `shots-r8/`.

## Limits and owner decisions

- Dental contrast fails (3): the scroll scene dims inactive steps on purpose; needs a flagship decision, not a generator change.
- Legal was rebuilt for the lab from flagship commit fa0f8c1 (matches the lab's 24 September baseline). A build from current flagship HEAD also generates; it exposed that the old prune deleted the numbered film frames (now kept), and it shows new flagship contrast findings.
- Photographs are shown as supplied (no resize or WebP variants); large originals make a heavy page.
- The preview data is repeated in every page (about 3 KB per listing, capped at 40 listings).
- Example agents, suburb figures and articles remain fictional content, as the owner approved.
- Services are listed, not described; a service that reads as an award, guarantee or rating is withheld until a person confirms it.

## Review fixes (round 8, after 9c2b38ea)

- Agent pages: label, link and button use the business's own number and email (or the plain placeholder when none), "Email the agency", "Talk to <business>". The template's example agents stay labelled "(example)" and "Fictional profile" with illustrated portrait placeholders; they are not presented as staff. The export leak rules now include the template's example mobile range. The lab scans every page of every vertical for any telephone number that is not the business's.
- Listings: headline, description, features, price, result, photo captions and photo credits are read field by field; a claim, a named staff member, or any trace of the example agency (its name, contact numbers, example property addresses and slugs, agents) is withheld and noted in PREVIEW.md. Only the address is exempt. Bare street names are not stock: a real Balmain agency may use "Darling Street". A backstop audits the preview data JSON that is written into the pages.
- Photos must sit inside the given photos folder (real path, junctions followed); no folder means no photos.
- Claim patterns normalise accents and fullwidth letters and add ratings, spelled-out stars, No.1, winner, satisfaction percentages and money-back.
- mailto strips a leading "mailto:" and rejects anything after the address; an after-hours note in brackets leaves the first complete number linked and the full text visible; two numbers outside brackets stay text only.
- Flaky test: the preview-server test deleted its shared fixture inside one describe block, so any change in block order failed the others. The cleanup now runs once at file end. Every lead-sites test file also passes with randomised order.

## Owner steps

1. Rebuild the real-estate template (and dental if its cache is older than this branch). Command, run from the AgenticOS-v4 checkout: `bun --bun scripts/lead-sites/cli.ts templates real-estate --build-root D:mu-lead-site-builds`.
2. Generate again every real-estate preview that was generated before step 1. A preview made with the older template (marker v2) is refused at deploy with a message saying it must be generated again.
3. Decide the dental step-number contrast finding (flagship design).

## Callers and the listings contract

No existing caller (the Leads page "Generate website" route, the command line, the Jarvis/job path through the same route) passes listings today. They all go through one function, so the convention lives there: a lead's own listings are read from `listings.json` in the lead's drafts folder, and its photographs from `listing-photos/` beside it (override with the `listings` and `listingPhotosRoot` options). The result of Generate now carries `listings` (how many shown, how many photos used, the photos folder that was looked in, and every note), the command line prints it, and the Leads timeline note says when photos were dropped. An unreadable `listings.json` is reported the same way.

## Expiry restore

If the page's own recovery render strips the marker, the hiding rule and the notice (or empties its text), one observer on the whole document puts all three back, and again after load. Covered by a stateful-DOM test; the lab's `expiry-checks` covers a real browser per vertical.

## Re-review fixes (after 226a16a1)

- Price, result, photo captions and photo credits are checked like every other listing field; only the address is the business's own exempt text. Plain prices ("$1,250,000", "Offers over $900k", "Contact agent", "$650 per week") pass.
- A listings file saved as UTF-8 (with or without a byte-order mark) or as UTF-16 (the PowerShell 5.1 default for > and Out-File) is read; anything else gets a plain note. Files over 1 MB, more than 20 photos on a listing, and more than 40 MB of photos in total are skipped with a plain note. Notes appear in PREVIEW.md, the Leads timeline and the one-line `summary` on the Generate result.
- Example properties are matched by their full addresses and slugs, not bare street names; "..x.png" is a legal file name.
- Zero-width and soft-hyphen characters are removed before claim matching; "highly rated", "best ... in" and "top N%" are claims.

Known limit: expiry is enforced by the page's own script (restored by an observer if the page removes it). The local preview server is loopback-only for the founders and deployed previews are static files on the host, so there is no server to refuse an expired page; a visitor with JavaScript switched off would see the site until it is taken down. The take-down in the Leads drawer and the 30-day live cap remain the backstop.

## Follow-ups after release

- Ordinary price lines pass: "Best offers in excess of $1,200,000", "Auction Sat 3/5 at 11am". A date is not read as a 3-out-of-5 rating, and "best ... in" counts only when it ranks the business itself ("best agency in ...").
- Photo limits and skips appear on the Leads timeline. The Leads drawer shows the one-line listings summary after Generate.
- Rebuilding a template has no button in the app yet. A real-estate preview made from an older template says: rebuild the real-estate template, then generate again. The exact command for the builder is in Owner steps above.

## Owner decisions (contrast, and no hand-over promises)

**Contrast.** The dental scroll scene dimmed inactive steps with opacity 0.42, which made their numbers and text fail 4.5:1. Inactive steps now keep full-strength text (the template's inactive ink is 6.9:1 on white, the active ink higher). Active versus inactive is shown by a 3 px bar and by weight, with no motion needed, so reduced motion is unchanged. Edit: `FlagshipVisit.module.css` lines 64-66 and 67 of the flagship's file, applied by the dental template spec; test: "contrast: the dimmed steps ...". The lab's axe check confirms it after the gate.

**Nothing is sent, so nothing promises a person.** Every replaced string (file and line in the template source the generator prepares; "overlay" files are in the generator's own overlay folder):

| File and line | Was | Now |
|---|---|---|
| app/agents/page.tsx:50 | "...we'll put you with the right person." | "Start with what you are trying to do. This is a preview — enquiries aren't sent yet. The contact page shows how to reach the business." |
| app/property-management/page.tsx:126 | "We'll inspect the property, compare ... and send a written estimate." | "A rental appraisal compares a property with current rentals. This is a preview — enquiries aren't sent yet." |
| app/property-management/page.tsx:133-134 | "Request received." / "Callum or Hana will call to arrange an inspection, usually within one business day." | "Preview only." / "This is a preview — enquiries aren't sent yet." |
| app/rent/tenants/page.tsx:23 | "You'll hear from us within three, either way." | "The agency confirms the outcome either way." |
| app/rent/tenants/page.tsx:102-103 | "Request logged." / "Your property manager will acknowledge it the same business day ..." | "Preview only." / preview sentence |
| app/sell/page.tsx:165 | "We'll arrange a time to walk through the property and follow up ..." | "An appraisal request would ask for a time ... This is a preview — enquiries aren't sent yet." |
| app/sell/page.tsx:172-173 | "Appraisal requested." / "We'll call to arrange a time ..., usually within one business day." | "Preview only." / preview sentence |
| app/terms/page.tsx:18 | "No licensed agent will respond to enquiries made through this demonstration." | "Enquiries made through this demonstration are not sent to anyone." |
| data/articles.ts:96 | "...and you will hear from us either way within three" | "...and the agency confirms the outcome either way" |
| components/assistant/Assistant.tsx:29 | "...I'll hand you to <agent> for anything I can't confirm." | "...anything I can't confirm is best asked of the agency directly. This is a preview, so nothing is passed on." |
| components/assistant/Assistant.tsx:150 | "Leave my details for <agent>" | "Try the question form" |
| components/assistant/Assistant.tsx:166 | "Pass this conversation to <agent>" | "This is a preview — questions aren't sent yet" |
| components/assistant/Assistant.tsx:171-173 | "Send to agent" / "Sent to the agent." / "<agent> will reply ... within one business day." | "Try the form" / "Preview only." / preview sentence |
| overlay components/PropertyView.tsx:220-221 | "You're registered." / "We'll send a reminder ..." | "Preview only." / preview sentence |
| overlay components/PropertyView.tsx:310-311 | "Enquiry sent." / "<agent> will be in touch, usually within one business day." | "Preview only." / preview sentence |
| overlay components/forms/EnquiryForm.tsx:34 | default "Thanks, we've got it." | "Preview only." (the success panel already said nothing was sent) |
| overlay data/site.ts:35 | "We reply to every enquiry within one business day. ..." | "Preview only. No enquiry is sent." |
| overlay lib/assistant/engine.ts:71 | "...register through the inspection form ... and we'll send a reminder." | "This is a preview, so the inspection form on this page does not send anything. Please call the agency to arrange an inspection." |
| overlay lib/assistant/engine.ts:88 | "<agent> can talk you through them." | "Please ask the agency directly." |
| overlay lib/assistant/engine.ts:112 | "...You can call <number> or leave your details here and I'll pass this conversation on." | "...Please call the agency on the number shown on this page. This is a preview, so nothing you type here is passed on." |
| overlay lib/assistant/engine.ts:119 | "The agent can send the strata report on request." | "Please ask the agency for the strata report." |
| overlay lib/assistant/engine.ts:122 | "...and put you in touch with the agent." | "...and point you to the agency's contact details. This is a preview, so nothing is passed on." |
| overlay lib/assistant/engine.ts:124 | "Leave your details and <agent> will answer directly." | "Please ask the agency directly. This is a preview, so nothing you type here is passed on." |
| overlay app/page.tsx:227 | "...and put you in touch with the agency." | "...and point you to the agency's contact details." |

Kept as they were: the pending wording for unknown phone numbers, addresses, hours and prices; the example process descriptions on the selling and management pages (for instance how an appraisal works), which describe an example agency and are labelled as examples, not a promise made by the preview. Dental and legal templates carried no such wording in their built pages. The scan is `promise-phrases.ts`: the tests run it over the prepared real-estate source and both overlays, and the lab's static check runs it over every built page and script of every vertical.

## How the lab templates were built, and the npm problem

On Windows the generator's old template build spawned `npm.cmd` directly, which Bun 1.4.2 refuses (`spawn npm.cmd EINVAL`). The fix on the r9 branch (run npm's own CLI script with node, arguments as a list, never a shell) is merged here as is; no second fix was written.

The lab's `templates-r8` was never built through that code path before the merge. At each earlier build (including the one at 07:10Z) the build folders under `D:/prog-scratch/qlab-r8/builds/<vertical>` already held their `node_modules`, installed by hand once with `npm ci` in a Git Bash shell (where npm is an ordinary script). The generator's own step only runs `npm ci` when `node_modules/next` is missing, so it skipped it, and `next build` was already run with node directly. The legal template needs no npm. After the merge all three templates were rebuilt from scratch into a fresh build folder (`builds-fresh`), so the install step really ran through the fixed code, and all three completed on this PC.

## Pinned sources

Template builds are reproducible from these, and each template's `template.json` now records them:

| Template | Source | Pin |
|---|---|---|
| Legal | muv-flagship-legal | revision 3d530c9, read with `git archive`, never the working tree (verified for contrast, 404, skip link, frame folder) |
| Real estate | aldergate | revision 9f374eb, read with `git archive` |
| Dental | muv-demo-dental working tree | Not a commit: the chosen daylit-room design exists only as uncommitted changes (HEAD c9944af is the later "lantern comes up" opening). The manifest records HEAD, whether the tree was dirty, and a SHA-256 of the prepared source. Owner step: commit the dental working tree, then pin that commit. |

Prepared-source SHA-256 at the verified build: dental 4fe215e2610ce44ebec5ebd2a886c7b61ad71d0de6ea1e012eb2087 (prefix as recorded in the lab's `template.json`).

## Legal contrast and the notice-period FAQ

- The legal "From the first page to the keys" band dimmed its inactive steps with opacity .55 (`.keys-n`, `.keys-d`), which failed AA on the dark ground. The legal template CSS now keeps them at full strength; the active step is marked by a bar and weight. The flagship repository is untouched.
- `data/faqs.ts` (tenants page, "How do I end or renew my lease?"): "We will confirm the notice periods that apply and send any renewal offer in writing." became "Notice periods depend on the lease and the tenancy law that applies, and a renewal offer is made in writing."
- The promise scan now also catches "we will confirm/send/call/reply", "our team will contact", "the agent/manager will ..." and similar, skips negated sentences ("No licensed agent will respond ...", "enquiries aren't sent yet"), reads the preview data JSON and scripts as well as page text, and runs at generate time: a page that promises a person will act refuses the preview, and a supplied listing field that does is withheld.

## Review follow-ups (promise scan, ratings, "best ... in")

- The promise scan no longer skips a whole sentence because it contains a negation. A negation applies only within five words before the phrase and inside the same clause (a comma or full stop ends it), so "No obligation, we will call you back." is caught while "No licensed agent will respond ..." passes. The preview data block is parsed and each string value is scanned on its own; each string literal in a script is scanned on its own.
- A service the business names with a promise in it ("We will call you back about wills") is withheld and noted in PREVIEW.md like a claim-like service, and the rest of the preview generates. The generator's own filled text (the hours line) carries no business wording today (no hours evidence is collected), so nothing else needed setting aside.
- A d/d reads as a date only straight after auction, open, inspection or a weekday, or straight before a time, and never when stars, a rating, "rated", reviews or clients are close ("Rated at 5/5 by our clients" is a rating).
- "Best ... in" now also covers manager, clinic, dental, realtor, property, practice and the other business words ("Best property manager in Balmain"); "Best offers in excess of $1,200,000" and "Best of both worlds in Balmain" still pass.

## The /contact form could not be submitted

Cause: the owner's 2 October overlay (`data/site.ts`, commit 44527e5c) set the site's departments to an empty list, and the contact page builds its required "Who should this go to?" select from that list, so the select held only its disabled placeholder and every submit ended in "Please enter who should this go to?". The same overlay is in the released templates (fe283571), so those have the bug too. The listing-page forms were not affected.

Fix: the overlay offers four generic kinds of enquiry (Sales, Property management, Leasing, General enquiry), none of them a person, and the contact page's department list shows the business's one verified email instead of a mailto of the placeholder. Nothing is sent; the success panel still reads "Demo complete — nothing sent."

Test: `forms-completable.test.ts` prepares the source and checks that every required select offers options (it failed on the old code with "options come from site.departments, which is empty"). The lab's form journey is now strict: a completed submit must produce a NEW status message and leave no field marked invalid; the static "Preview only." beside the button no longer counts. Dental and legal templates have no forms; the other real-estate forms (appraisal, maintenance, management, assistant) use literal option lists and pass the same check.

## More lines in the business's own voice (second promise sweep)

The scan now also catches "we'll / we will tell, say, suggest, let you know, advise, walk through, put, show, explain, find, match, book" and "we can arrange". Replaced in the prepared source (upstream file, was, now):

| File | Was | Now |
|---|---|---|
| app/sell/page.tsx:35 | "Where they help. We'll tell you when they don't." | "Useful for some properties and not for others." |
| app/about/page.tsx:77 | "If your property is outside them, we'll say so and suggest someone who knows the area." | "A property outside them may be better served by an agent who knows that area." |
| app/sell/page.tsx:117 | "Choose by area, or ask us and we'll tell you honestly who is the right fit." | "Choose by area." |
| data/articles.ts:28 | "We'll walk through it with you." | "An appraisal is the usual first step." |
| data/articles.ts:96 | "If you are unsuccessful we will tell you, and we will tell you what else we have coming." | "Unsuccessful applicants are told, and other available properties are worth watching." |
| data/faqs.ts:9 | "We will tell you honestly whether styling ... and we can arrange any of them." | "Whether styling, partial styling or simply decluttering makes the difference depends on the home." |
| data/faqs.ts:23 | "... and we will put them to the owner." | "... and they are put to the owner." |
| data/faqs.ts:34 | "You can, and we will put every offer to the vendor." | "You can, and an agent is obliged to pass every offer to the vendor." |
| data/faqs.ts:35 | "We will explain the process at any inspection." | "The process is explained at the auction." |

A quick sweep of every built page for any other "we'll / we will / we can ..." found only the lines above plus "we can't show you the basis for ..." (a refusal, not a promise).
