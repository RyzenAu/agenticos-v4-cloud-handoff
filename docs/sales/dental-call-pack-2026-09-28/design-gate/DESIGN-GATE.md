# Design gate: M&U site and the three flagships

> **Historical record (27 Sep 2026, evening).** This design gate was written when the Monday offer was a website callback form. That offer has been **dropped**: the product is the AI receptionist that books appointments (`../00-START-HERE.md`). References below to the callback-form offer are kept only as the record of what was reviewed; screenshots in `evidence/` show site builds from that time.

27 September 2026. Senior design lead review. Read-only: no repository was edited, staged, committed, stashed or reset. No `.env` file was opened. Nothing was published, deployed or submitted.

**Verdicts**

| Asset | Verdict | One-line reason |
|---|---|---|
| M&U marketing site | **REBUILD-SECTION** (opening) + truth fixes | The first screen shows no work. The copy on `/work` and `/ai-receptionist` states things that aren't true today. |
| Lantern Dental | **REVISE** | The opening film is strong, but the header's "Book" route errors, the page contradicts itself about confirmation, and it doesn't demonstrate the product we're selling on Monday. |
| Aldergate | **PASS** (targeted fixes only) | The owner's identity is intact: the locked hero hash matches. The remaining issues are small and asset-level. |
| Marden & Rowe | **REVISE** (small) | This is the most coherent world of the four. It has no enquiry capture, the address needs a real-world check, and one contrast point needs work. |

## How this was rendered

- **My own renders.** Four servers were started from each repo's normal script on free ports: marketing `npm run dev -- -p 3410`, dental `-p 3101`, Aldergate `-p 3351` and legal `npm run preview` with `PORT=3102`. All four were stopped afterwards. The audit agent's servers had already stopped, and port 3000 was taken by a Remotion render in `mu-video-demos`, which I didn't touch. Before and after, the dirty-file counts were identical: 41, 67, 38 and 41.
- **Capture script.** Playwright ran against the local Chrome build. It captured 1440×900, 390×844 and 360×740. The homepages also got frames at 0, 25, 50, 75 and 100% of scroll, a reduced-motion pass at 390, a four-step keyboard Tab pass at 1440, horizontal-overflow and console-error checks, and dumps of the rendered text used for the truth review.
- **Evidence location.** Everything is in `design-gate/evidence/`. The contact sheets are the quickest way in:
  - `sheet-<site>-1440-scroll.png`: the scroll frames plus the focus frame.
  - `sheet-<site>-mobile.png`: 390 fold, 360 fold, reduced-motion fold, and 390 at 25, 50 and 75%.
  - `strip-<page>.png`: the full page, downscaled into four columns.
  - Also `sheet-dental-inner.png` and `sheet-marketing-inner.png`.
- **Measured across all four sites.** None had horizontal overflow at 360, 390 or 1440. Every site shows a visible focus ring: 2px solid, in gold, navy, timber or brass. Every site collapses its motion under reduced motion. The only console error was dental `/book`.
- **Audit agent material.** I reused its screenshots in `site-audit/` as corroboration.
  - Its ports differed from mine: marketing 3000, Aldergate 3200, legal 3351.
  - One correction to AUDIT.md: the Aldergate hero is the owner's locked stock photograph, not AI imagery. `hero-01.jpg` hashes to `3DF61E6B…A870`, which matches DESIGN.md.
- **Not rendered or not tested:**
  - Production URLs, including whether `lanterndental`, `mardenrowe` and `aldergate.muventures.com.au` match these branches.
  - `/book` in production. It returned 500 locally: `password authentication failed for user 'ops_owner'`.
  - The Bianca Brown site.
  - Real devices, screen readers and other browsers.
  - Production-build performance. Dev-mode transfer sizes are shown below only as a warning; they are not a budget measurement.
  - The video and calculator in `mu-video-demos`, and the AgenticOS `/leads` and `/receptionist` pages. These wait for the lead's go.

---

## A. The quality bar

These rules apply to every asset:
- Each site must read as a distinct business at thumbnail size, with its palette and type masked.
- Exactly one signature interaction per site. No fade-and-rise on every block.
- Evidence rules: no invented proof, no fictional person presented as real, no unsourced statistics, no claim the product can't back today.
- Performance thresholds are checked on a production build (`next build && next start`, or the static server), in Lighthouse mobile emulation:
  - LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms.
  - Media above the fold at 390 ≤ 450 KB.
  - Initial JS ≤ 200 KB gzipped for the React sites.
  - Scroll-film frames beyond the first 12 load only after first scroll.

### A1. M&U Ventures (marketing)
- **Audience.** Owners and practice managers at Sydney dental practices, law and conveyancing firms and independent agencies. They are sceptical, busy and arrive from a cold call or email.
- **Primary action.** Arrange a call with Usman or Mehroz.
- **Promise.** "See a working website for a business like yours before you spend a dollar or an hour."
- **Distinctive visual principle.** The M&U frame recedes and the demonstrations are the hero, shown on a neutral "gallery wall". Today the frame is black and gold, which is also what two of the demos use.
- **Signature interaction.** One live-window row: each demonstration's own opening film plays in a labelled browser frame, and opening one keeps a "Back to M&U" return path.
- **Acceptance:**
  1. At 1440, 390 and 360, at least one demonstration window is visible in the first viewport, along with the promise and the primary action.
  2. Every demonstration shows the same label: "Demonstration · fictional business · built by M&U Ventures". No real client or prospect appears in that list.
  3. Every capability sentence about a demo is true of the linked live URL on the day it ships. It's checked by opening the URL and finding the feature.
  4. Receptionist copy matches the pack's capability table: no live transfer, alerts not automatic, not offered to prospects until the gates pass.
  5. The primary button's label names what happens. If it opens a form, it doesn't say "Book".
  6. Keyboard: skip link first. Tab order reaches the primary action within 6 stops. Focus is visible on dark and light grounds.
  7. Reduced motion shows the film posters, with no rotating word.
  8. The contact form shows inline validation, an error state that keeps input, and a success state. It's tested with the delivery env unset (the graceful-failure path), never with a live send.
  9. The performance thresholds above, with three looping videos present.
  10. No unsourced statistics, no testimonials, no client logos.

### A2. Lantern Dental (dental flagship)
- **Audience.** A Rozelle adult who is anxious about the dentist, or who hasn't been in years. As a demonstration, the second audience is a practice manager on Monday's calls.
- **Primary action.** Book an appointment. After hours, request a callback.
- **Promise.** "You'll know the plan, the fee and the time before we start." This is the incumbent promise, and it's kept.
- **Distinctive visual principle.** Navy for the promise. One warm ground per page. Facts in ruled, tabular lists. No ornament. This follows the incumbent DESIGN.md.
- **Signature interaction.** The committed R16 scroll film ("the lantern comes up"), with the example-appointment picker as the functional counterpart.
- **Acceptance:**
  1. Every "Book" link reaches a working flow or an honest fallback, never a 500.
  2. Nothing on the page contradicts another element about whether a time is held or confirmed.
  3. Callback request, per `01-offer.md`:
     - Minimal fields; topic is a choice; no free-text symptoms.
     - The 000 safety notice is visible before submit.
     - A collection notice names any overseas processors.
     - In demo mode, submit sends nothing and says so.
  4. No named practitioner carries a credential such as "Registered dentist". Fictional profiles are labelled at heading level, not in fine print.
  5. No patient testimonials or outcome claims (National Law s133 and the Ahpra guidelines). Fees appear only with the sample-fees note.
  6. 1440, 390 and 360: the H1 doesn't sit on the tooth's highlights, and the fixed mobile action bar never covers the primary CTA at the fold.
  7. Reduced motion shows a single still with the caption, and no scrubbing.
  8. Keyboard: the picker is operable with arrow keys and Enter; selection changes are announced; focus is restored after the mobile drawer closes.
  9. The performance thresholds above, on the production build.

### A3. Aldergate (real-estate flagship, identity locked)
- **Audience.** Inner West buyers, renters and prospective vendors.
- **Primary action.** Search homes. For vendors, get an appraisal.
- **Promise.** "A local perspective. A place of your own." This is the incumbent promise.
- **Distinctive visual principle.** Architectural cover: a giant Newsreader wordmark over the locked dusk photograph, with timber and paper materials throughout.
- **Signature interaction.** Entry into the property gallery, plus the committed "27 Darling Street" scroll approach.
- **Acceptance:**
  1. `hero-01.jpg` is unchanged: SHA256 `3DF61E6B…A870`.
  2. Search returns a result or an empty state, with the filter in the URL, at 1440 and 390.
  3. Every listing photo shows a real, identifiable house or street under a fictional address and price. So each card carries a visible "Illustrative photo" caption, and no number plate or house number is legible.
  4. No enquiry form promises a reply time without saying it's a demonstration.
  5. The gallery dialog traps and restores focus, and supports Esc and the arrow keys.
  6. Reduced motion: the approach sequence shows its first frame and caption.
  7. The performance thresholds above. The home page moved 7.3 MB in dev at 1440, so re-check on production.
  8. One animation engine per page.

### A4. Marden & Rowe (legal flagship, static, owner's design kept)
- **Audience.** Leichhardt and Inner West residents and small businesses facing a property transaction, a will or a dispute.
- **Primary action.** Prepare for and request a first meeting.
- **Promise.** "The first step is one conversation about where things stand."
- **Distinctive visual principle.** A lamplit chambers world: deep green, Cormorant-style serif, brass accent, hands-only film.
- **Signature interaction.** The "From the first page to the keys" scroll film, together with the "Walk into the first meeting prepared" checklist chooser.
- **Acceptance:**
  1. Enquiry path: the first-meeting checklist leads into a request (demo mode, nothing sent, stated plainly) as well as `tel:`.
  2. Every address, phone number and firm detail is verifiably fictional. The phone numbers are in the 02 5550 range, which the dialling plan reserves for fictional use, so they're fine. The street address needs a check (see L2).
  3. Nothing reads as an outcome guarantee, a credential, an award or a review. "Not legal advice" appears in the footer and beside the checklist.
  4. The hero H1 reaches ≥ 3:1 against its sampled background at 360 and 390, because it's large text.
  5. Header and mobile callbar use the same call label.
  6. Reduced motion loads one still, not the 196-frame sequence.
  7. The performance thresholds above: film frames ≤ 1.5 MB before first scroll.
  8. One animation engine. GSAP is present today.

---

## B. Portfolio coherence: how M&U presents the flagships

**The journey the M&U site should walk:**
1. **Impact.** One sentence about the visitor's own problem, not about us. For example: "When your desk can't pick up, people who wanted to book go somewhere else." No statistics.
2. **Evidence.** The three demonstrations appear in the first viewport as live windows. Each one says what is real in it, for example "Booking flow runs against a test diary", and what isn't.
3. **Offer.** What we'd build for them. This week that means the dropped callback-form offer (the callback path, `01-offer.md`) and a website build. The receptionist appears only as "in testing, founding pilot list", or not at all, until the gates pass.
4. **Demo.** "Open the demonstration" opens the flagship in a new tab. Each flagship's disclosure bar links back to its `/work/<slug>` page on M&U.
5. **Book a human.** One action, "Arrange a 15-minute call with Usman or Mehroz". It lands on the form with the existing "we reply within a business day". No scheduler is implied.

**Labelling rules. Today there are six different wordings; there should be one.**
- On M&U: "Demonstration · fictional business · built by M&U Ventures".
  - This replaces "Flagship demonstration", "Concept study" and "Prospect concept".
- On each flagship's bar: "Demonstration website by M&U Ventures. [Name] is fictional. About M&U →".
  - This replaces "Concept demonstration…", "Demonstration website…" and "Demo website…".
- **Client work lives in a separate section**, and only with written approval. That applies to Bianca Brown Realty (see M1).

**Distinctness check, on the current renders:**
- **The good news:**
  - Dental reads as navy on white with a grotesk: `sheet-dental-1440-scroll.png`.
  - Aldergate reads as paper and timber with Newsreader: `sheet-realestate-1440-scroll.png`.
- **The problem:**
  - Legal is dark green with a brass-gold button and a high-contrast serif.
  - M&U itself is near-black with a gold button and a serif.
  - Bianca is described as "black-and-gold".
  - At thumbnail size (`strip-marketing-work-1440.png`), the legal demo and the M&U frame look like one brand, which weakens "each site is its own business".
- **Fix without redesigning legal** (the owner rule): put the demo windows on a neutral mid-grey wall inside M&U's work sections, so the demos' own colours carry. Longer term, give M&U an identity that isn't gold on dark. That's an owner decision, not a builder task.

---

## C. Verdicts, evidence and fix lists

Every fix below has a priority, the evidence, an acceptance check, an effort and a dirty-tree status.
- **Priority:** P0 = must fix before any prospect sees it; P1 = before Monday's follow-ups if possible; P2 = next pass.
- **Effort:** S / M / L.
- **Dirty status:** checked with `git status --short` on 27 Sep. "BLOCKED-ON-OWNER-COMMIT" means the target file carries uncommitted owner or agent work.

### C1. M&U marketing: REBUILD-SECTION (opening) + truth fixes

**What I saw:**
- **Home fold** (`marketing-home-1440-fold.png`, `-390-fold.png`, `-360-fold.png`):
  - The first screen is text only on near-black: a tracked caps eyebrow, "Websites for *Dental*" with a rotating word, two buttons and a four-cell fact row.
  - None of our work appears until 25% scroll (`marketing-home-1440-scroll-025.png`).
  - The full stop after the rotating word is detached. It sits about 130px right of "Dental" at 1440 and floats alone at 390 and 360. The cause is `Hero.tsx:16` `{"."}` after a fixed-width `VerticalSwitch`.
  - In the fact row, each value is indented about 40px from its label.
- **Home at 75%** (`strip-marketing-home-1440.png`): the cream "How it works" band leaves its right half empty.
- **`/work`** (`text-marketing-work.txt`, `strip-marketing-work-1440.png`):
  - Bianca Brown Realty is labelled "A fictional business, not a client" and mentions "a polished follow-up deck for Brooke and Zac".
  - Per memory `first-client-2026-09`, Bianca Brown Realty is M&U's **first paying client** (signed 17 Sep). Brooke and Zac are real people.
  - The same page states "We publish client work only with the business's approval".
  - This entry exists only in the uncommitted `site.ts`. It isn't in HEAD.
- **`/ai-receptionist`** (`text-marketing-ai-receptionist.txt`) says:
  - "hands the caller to your staff"
  - "a transfer during opening hours"
  - "Your practice gets a summary of every call"

  The pack (`00-START-HERE.md`, `01-offer.md`) says there's no transfer tool, alerts aren't delivered, and the receptionist is "INTERNAL ONLY, not offered on Monday". The page does honestly say it has never run on a real practice's phones.
- **`/work` and `site.ts` case studies:**
  - Marden & Rowe is described as a multi-page app with a "five-step quote request", a "demo client portal" and "Postgres persistence". The legal flagship on this branch is a single static `index.html` with no form.
  - Lantern is described as "instant confirmation… live Postgres diary". Meanwhile the flagship homepage says "not a live booking calendar… no appointment is held", and `/book` 500s locally.
- **Positives:**
  - The receptionist page's "Disclosure first" and "What it won't do" sections are well judged and honest.
  - The contact page is clear.
  - The focus ring is visible (gold, 2px).
  - Reduced motion collapses the rotation to "Dental · Law · Real estate." (`marketing-home-390-reduced-fold.png`).

**Fix list:**

| # | Pri | What | Why (evidence) | Acceptance check | Effort | Target files, dirty? |
|---|---|---|---|---|---|---|
| M1 | P0 | Remove Bianca Brown Realty from the "fictional demonstrations" list. If Brooke gives written approval, re-add it under a separate "Client work" label with no personal names. | A real, paying client is labelled fictional, and real people are named. It contradicts the page's own approval rule. | `/work` rendered text contains neither "Bianca" nor "Brooke" nor "Zac", OR it shows under "Client work" with the approval on file. | S | `src/content/site.ts`: **BLOCKED-ON-OWNER-COMMIT** (the entry exists only in the dirty copy; owner decision) |
| M2 | P0 | Rewrite receptionist claims to today's capability: takes a message, no live transfer, M&U emails a morning summary during a pilot. Or take `/ai-receptionist` out of the nav and home until the gates pass. | Three capability claims contradict `01-offer.md`, and the pack says don't offer it Monday. | Rendered text has no "transfer" or "hands the caller"; every "does" sentence maps to a row in the pack's capability table. | S | `src/content/site.ts`: **BLOCKED-ON-OWNER-COMMIT**; `ReceptionistTeaser.tsx` and `Header.tsx` are clean |
| M3 | P1 | Rewrite each case study to what its linked live demo shows today, then open each live URL and tick every claim. | The M&R and Lantern descriptions don't match the flagships on these branches. | For each bullet, a screenshot of the feature on the live URL; any bullet without one is deleted. | M | `src/content/site.ts`: **BLOCKED-ON-OWNER-COMMIT** |
| M4 | P1 | Rebuild the opening per direction D1-A: promise and primary action, with a live-window row of the three demonstrations in the first viewport. Drop the rotating word, and with it the detached full stop. | The first screen shows no work (`marketing-home-1440-fold.png`), and the floating full stop is visible at every width. | At 1440, 390 and 360 the first viewport contains the H1, the primary action and at least one labelled demo window; no stray glyph; reduced motion shows posters. | L | `components/sections/Hero.tsx`, `Hero.module.css`, `ui/VerticalSwitch.tsx`, `app/page.tsx`: **clean** |
| M5 | P1 | Rename "Book a call" to "Arrange a call" everywhere, or wire a real scheduler. | Every "Book a call" lands on an enquiry form ("Send enquiry"), `marketing-contact-1440-fold.png`. | The button label and the destination's primary button describe the same action. | S | `Header.tsx`, `ui/CtaBand.tsx`: clean; labels inside `site.ts`: **BLOCKED-ON-OWNER-COMMIT** |
| M6 | P1 | Add an the dropped callback-form offer section to home and to `/dental`, linking to the Lantern callback demo (D2). | The Monday offer leads with the dropped callback-form offer; the site doesn't mention it. | Home and `/dental` each have one the dropped callback-form offer block with "captures requests, doesn't book", a link to the demo and no outcome promise. | M | `site.ts`: **BLOCKED-ON-OWNER-COMMIT**; new component: clean |
| M7 | P2 | One demonstration label everywhere (see B), and present the demos on a neutral wall. | Six different labels; legal and M&U read as one brand (`strip-marketing-work-1440.png`). | Grepping the rendered text of all four sites finds only the two approved strings. | S | `site.ts` and `work/page.tsx`: **BLOCKED-ON-OWNER-COMMIT**; flagship bars as listed under each site |
| M8 | P2 | Cut `Reveal` from 65 uses to the opening only; everything else renders static. | Fade-and-rise on every block is the generic pattern, and scroll-075 shows a half-empty band while content waits. | `grep -c "<Reveal"` ≤ 3; scroll frames at 25, 50 and 75% show no blank or pending blocks. | M | `components/Reveal.tsx` and section components: **clean**; `work/page.tsx`: **BLOCKED-ON-OWNER-COMMIT** |

### C2. Lantern Dental: REVISE

**What I saw:**
- **Opening** (`sheet-dental-1440-scroll.png`, `dental-home-1440-scroll-000.png`):
  - The glass-tooth scroll film on navy, with "Dentistry. At your pace." It's a confident, premium opening.
  - The tooth is the most literal dental image available, but the lighting and the film make it the practice's own.
  - Captions are truthful ("Illustrative film, AI-generated… Not Lantern Dental's premises, staff or patients").
- **Mobile** (`sheet-dental-mobile.png`): at 390 the H1 sits below the tooth, and the fixed "Book an appointment" bar and phone button work. At 360 the H1 rides up over the tooth base; it's legible, but tight.
- **Lower sections** (`strip-dental-home-1440.png`): three numbered steps ("We talk", "We look", "You decide", a genuine sequence), the warm "Your first visit" feature with the example picker, the "Came for something else?" router, the fees ledger, and the location and hours.
- **Contradiction** (`text-dental-home.txt`):
  - Line 101: "not a live booking calendar… no appointment is held".
  - Line 105: "Check-ups are confirmed straight away", from `src/app/page.tsx:23`.
- **`/book`** (`dental-book-1440-fold.png`): a Next.js 500 overlay, `password authentication failed for user 'ops_owner'`. It's the destination of the header "Book" and every "Book an appointment". `.env.local` exists, but I didn't read it.
- **`/team`** (`dental-team-1440-fold.png`):
  - "Dr Amara Osei, Principal dentist · Registered dentist", with a biography ("opened Lantern in 2019 after a decade in general practice").
  - "Fictional profile for this demonstration" appears only in small type below.
  - `/fees` redirects (307) to `/#fees`.
- **Inner pages** (`dental-team-1440-fold.png`, `dental-new-patients-1440-fold.png`) drop to small body text on plain white. They don't carry the homepage's standard.
- **Missing:** no callback or after-hours enquiry path, which is exactly what Monday's calls sell (`01-offer.md`, "the dropped callback-form offer").
- **Positives:** disclosure bar on every page, focus ring visible, no overflow, reduced motion gives a still.

**Fix list:**

| # | Pri | What | Why (evidence) | Acceptance check | Effort | Target files, dirty? |
|---|---|---|---|---|---|---|
| D1 | P0 | Add a route-level error boundary for `/book`: "Online booking isn't available in this preview. Call (02) 5550 0142 or see example times." Separately, confirm production `/book` against a test database with a synthetic booking. | The header CTA currently lands on a 500 (`dental-book-1440-fold.png`). | With the DB unreachable, `/book` renders the fallback with a 200 or controlled status, no overlay, at 1440 and 390; the production check is logged with a screenshot. | S | New `src/app/book/error.tsx`: **clean (new file)**; `book/page.tsx`: **BLOCKED-ON-OWNER-COMMIT** if its query needs changing |
| D2 | P0 | Build the the dropped callback-form offer demo as `/callback`, per `01-offer.md`: name, best number, new or existing, topic *choice*, preferred callback time; the 000 safety notice; an APP 5 and APP 8 collection notice; demo submit sends nothing and says so. Link it from "Came for something else?" and, outside opening hours, from the mobile action bar. | The product being sold on Monday isn't demonstrated anywhere; Mehroz's schedule needs "a one-page the dropped callback-form offer example link". | Keyboard-only completion at 390; the safety notice is visible before submit; no network request on submit (DevTools); no free-text symptom field. | M | New `src/app/callback/*`: **clean**; link in `src/app/page.tsx`: **clean** |
| D3 | P1 | Resolve the confirmation contradiction. Line 23 becomes "In the full booking system, returning patients can confirm a check-up online. The times on this page are examples." Or delete the sentence. | Two statements on one page disagree (`text-dental-home.txt` lines 101 and 105). | Rendered home text contains no unqualified "confirmed straight away". | S | `src/app/page.tsx`: **clean** |
| D4 | P1 | Remove the "Registered dentist" credential and the invented career history from the fictional profiles. Put "Example profile, not a real practitioner" in the name line. | A registration claim about a fictional person invites an Ahpra register check, and the R13 contract bans invented staff presented as real. | `/team` text contains no "Registered"; the label is in the same block as each name. | S | `src/app/team/page.tsx`: **BLOCKED-ON-OWNER-COMMIT** |
| D5 | P2 | Bring the inner pages up to the three DESIGN.md heading tiers and a 1.05rem minimum body size; give each page head the navy or stone treatment rather than bare white. | Inner pages read as a generic template (`sheet-dental-inner.png`). | Side-by-side of home, team and new-patients at 1440 and 390 shows the same type tiers; the contrast script passes. | M | `team`, `new-patients`, `globals.css`: **BLOCKED-ON-OWNER-COMMIT** |
| D6 | P2 | Performance pass on a production build. The dev home moved 2.9 MB and is about 10,000px tall. | The scroll film plus seven images need checking against the thresholds. | Lighthouse mobile on `next start`: LCP ≤ 2.5 s, CLS ≤ 0.1; the film's first frame is the LCP element and ≤ 200 KB. | M | Asset and loading changes: likely `VisitScene*` (untracked, **BLOCKED-ON-OWNER-COMMIT**) |
| D7 | P2 | At 360, raise the H1's safe area so it never overlaps the tooth base. At ≤ 380px, give the fixed action bar a `safe-area-inset-bottom` pad. | `dental-home-360-fold.png`: the H1 sits on the tooth's plinth. | At 360×640 and 360×740 the H1 bounding box doesn't intersect the tooth mask, and the CTA is fully visible. | S | `page.module.css`: **BLOCKED-ON-OWNER-COMMIT** |

### C3. Aldergate: PASS (targeted, evidenced improvements only)

**What I saw:**
- **Opening** (`sheet-realestate-1440-scroll.png`): the locked dusk house, the giant "Aldergate" wordmark, the "3 Glover Street" caption, search directly below and "Illustrative property photography" beneath. It's a distinct premium identity, recognisable at thumbnail size.
- **Mobile** (`sheet-realestate-mobile.png`): at 390 and 360 the wordmark still fits, and the search sits under the scene.
- **Lower page** (`strip-realestate-home-1440.png`): the "Some homes you read closely." approach sequence, the collection, the "A sale starts with a walk-through" vendor band, the suburb index, the journal, and the close.
- **Listing photos:** the collection uses real street photographs under fictional addresses and prices. "5 Nelson Street, Annandale" shows two parked cars (`realestate-home-390-scroll-050.png`), and "8/42 Wellington Street" is a real-looking warehouse.
- **Journal:** "Preparing a terrace for auction" is illustrated with a modern apartment interior.
- **Positives:** focus rings are visible (timber, 2px), no overflow, and reduced motion is honoured.

**Fix list:**

| # | Pri | What | Why (evidence) | Acceptance check | Effort | Target files, dirty? |
|---|---|---|---|---|---|---|
| R1 | P1 | Caption every listing image "Illustrative photo" on the card; blur any legible plates or house numbers; re-check each photo's credit line. | Real houses shown "for sale" at invented prices (`realestate-home-390-scroll-050.png`). | Every card in `/`, `/buy` and `/property/*` shows the caption; zoomed crops show no legible plate or number. | M | `PropertyCard.tsx`, `public/photos/CREDITS.md`: **BLOCKED-ON-OWNER-COMMIT**; image files: clean |
| R2 | P2 | Replace the journal image on the terrace article with a terrace interior from the existing credited pool. | Subject mismatch: terrace article, apartment photo (`strip-realestate-home-1440.png`). | The article card shows a terrace or period interior. | S | Insights data file (verify which one), with `src/data/site.ts` **BLOCKED-ON-OWNER-COMMIT** if it's there |
| R3 | P2 | Set "Some homes you read closely." entirely in roman type. | A single italic accent word is a stock generated-page device. | No italic span inside any H2 on home. | S | `src/app/page.tsx`: **BLOCKED-ON-OWNER-COMMIT** |
| R4 | P2 | Qualify the contact page's "We reply to every enquiry within one business day" with "(a real agency would commit to this)", or move the demo notice beside it. | It sits next to "no agent will respond" (`site-audit/aldergate-contact-1440.png`). | The reply promise and the demo disclosure appear in the same visual block. | S | The phrase lives in `src/data/site.ts`: **BLOCKED-ON-OWNER-COMMIT**; also used on `sell`, `property-management` and `property/[slug]` pages |
| R5 | P2 | Production performance check. Dev moved 7.3 MB and 14 images at 1440. | The home page is photo-heavy. | Lighthouse mobile thresholds pass; offscreen images are lazy with explicit sizes. | M | Various; mostly **BLOCKED-ON-OWNER-COMMIT** |
| R6 | P3 | When `ApproachSequence.tsx` is next revised, move its scroll scrub from GSAP to Motion `useScroll` so the React sites run one engine. Don't do it just for the sake of it. | The E motion rule; GSAP 3.15 is the only engine in this repo. | `gsap` absent from `package.json`; the reduced-motion still frame matches. | M | `ApproachSequence.tsx`: clean (committed in `9f374eb`) |

Housekeeping for the owner: there's a stray untracked path, `i.src)`, at the repo root.

### C4. Marden & Rowe: REVISE (small; the owner's design stays)

**What I saw:**
- **Opening** (`sheet-legal-1440-scroll.png`): a lamplit chambers room with "Talk it through with a Leichhardt solicitor.", the "What's it about?" chooser and "Get my first-meeting list".
- **Scroll frames:**
  - 25%: "Most matters start with one conversation", with a pen-and-keys still.
  - 50%: the "From the first page to the keys" hands-only film with a numbered four-stage sequence (a genuine sequence).
  - 75%: "Areas of practice".
  - 100%: "88 Norton Street" and the footer disclaimer.
- **Verdict on the world:** it's the most atmospheric and coherent of the four. Every image is captioned AI-generated, and the phone is in the 02 5550 fictional range.
- **Mobile:** at 360 and 390 (`sheet-legal-mobile.png`), "through with" crosses the lit window. On the brightest pixels it's close to the edge, though it's large text.
- **Other points:**
  - There's no request form: only `tel:` and the checklist (confirmed in AUDIT.md).
  - The mobile callbar says "Call us" while the header says "Call (02) 5550 0188".
  - The 1440 focus pass shows a brass 2px ring.
  - The site ships GSAP and ScrollTrigger (117 KB) plus 196 film frames (7.5 MB on disk).

**Fix list:**

| # | Pri | What | Why (evidence) | Acceptance check | Effort | Target files, dirty? |
|---|---|---|---|---|---|---|
| L1 | P1 | Turn "Walk into the first meeting prepared" into a request: after the checklist, a 4-field demo form (name, phone, matter type prefilled from the chooser, preferred time). Submit shows "Demonstration: nothing was sent. A real firm would call you back." No network. | It's the only flagship with no enquiry capture, and a firm's site exists to start the first meeting. | Keyboard completion at 390; zero network requests on submit; "not legal advice" is visible beside it. | M | `index.html`, `assets/site.js`: **clean** (only review PNGs are untracked) |
| L2 | P1 | Verify "Suite 4, 88 Norton Street, Leichhardt" isn't a real firm's address. If there's any doubt, change it to an obviously non-existent number and suite. | `CLAUDE.md` bans real addresses; Norton Street is a real commercial strip. | A written check that the address matches no listed business, or the address is changed in all 4 places in `index.html`. | S | `index.html`: **clean** |
| L3 | P2 | Guarantee hero H1 contrast at 360 and 390: a 20–30% gradient scrim behind the text block, or shift `object-position` so the window sits right of the H1. | `legal-home-360-fold.png`: "through with" sits on the window light. | Sampled contrast ≥ 3:1 behind every H1 line at 360, 390 and 1440. | S | CSS in `index.html`: **clean** |
| L4 | P2 | Make the callbar label match the header ("Call (02) 5550 0188" or "Call the office" in both). | Label inconsistency. | Identical label at all three widths. | S | `index.html`: **clean** |
| L5 | P2 | Reduced motion and slow networks: load one still and skip the frame sequence entirely; keep frames past the first 12 lazy. | 7.5 MB of frames on disk. | Under `prefers-reduced-motion`, the network panel shows ≤ 2 film images; first load ≤ 1.5 MB. | S | `assets/site.js`: **clean** |
| L6 | P3 | Engine policy: keep GSAP for the existing film. Don't add Anime.js on top. If the film section is ever rebuilt, rebuild it on Anime.js v4 (scroll observer and SVG draw, about 17 KB) and remove GSAP. | The E motion rule: one engine; Anime.js is the static site's designated engine. | Only one animation library in `assets/vendor/`. | M | `assets/vendor/*`: **clean** |

---

## D. Concept directions: opening plus lower section, three per site, one chosen

References come from the inspo archive (one `recommend` plus one `search_screens` per sector). The lesson noted is the compositional one taken, not the look. Where the owner has locked an identity (Aldergate, Marden & Rowe) or has rejected earlier directions (Lantern: time-held board, morning at Lantern, rooms in monochrome, one scene, lit register, terms stated), the directions work inside those limits.

### D1. M&U marketing
**References:**
- **nbstudio-co-uk:** a two-sentence intro, then the work grid immediately, with sector filter tags. Lesson: proof starts in the first viewport, and the filters are sectors, not services.
- **alejandromejias-com-au:** a persistent bottom-centre "Book a call" pill with a face and the studio's local time. Lesson: signal a human and availability next to the action.
- **furoweb-eu:** black ground, a serif headline with one coloured italic word. This is an **anti-reference**: it's M&U's current hero almost exactly, which is why it reads as a template.
- **exoape-com:** huge type over a single full-bleed image. Lesson: one image, one statement, nothing competing.

**Directions:**
- **A. "The work is the hero".**
  - *Opening:* a one-line promise and "Arrange a call" on the left, with three live demo windows stepped on the right, each playing its flagship's own film and labelled "Demonstration · fictional business".
  - *Type:* the existing serif at a smaller H1 (2–3 lines), sans labels in sentence case, no tracked caps.
  - *Lower section:* the demo windows become a sector filter (Dental, Law, Real estate). Choosing one swaps the evidence panel beneath to "What's real in it / What isn't / Open it".
  - *Motion:* a Motion `layout` transition on the filter swap, which is user-triggered.
  - *Mobile:* a single demo window with a sector toggle.
- **B. "Two people, one studio".**
  - *Opening:* photographs of Usman and Mehroz (only with their consent), their names and a live "Sydney, replying today" line; a bottom pill CTA.
  - *Lower section:* a dated timeline of one real concept build, from the day the prospect's public info was gathered to the day they saw it.
  - *Motion:* the timeline draws as it's scrolled.
  - Honest and human, but it pushes the work below the fold again and puts the founders' faces on a cold-outreach site.
- **C. "The missed-enquiry ledger".**
  - *Opening:* a typographic two-column comparison of a practice's after-hours path, "Your site at 9:40pm today" versus "With a callback path". A toggle flips the mock phone screen.
  - *Lower section:* the the dropped callback-form offer offer, then the demos.
  - Tightly aligned with Monday's offer, but it narrows a three-vertical studio to one use case.

**Chosen: A.** The only honest proof M&U has is the demonstrations themselves, and today they arrive after a text-only screen. A puts them at the impact-and-evidence step of the journey in B. It retires the rotating word and the floating full stop. It also lets the frame recede so the demos' identities carry, which answers the legal and M&U colour clash. C's comparison becomes the offer section under A for dental visitors.

### D2. Lantern Dental
**References:**
- **menkind-co:** directly under the hero, a stack of full-width tappable rows, one per reason for visiting. Lesson: the situation router belongs in the second screen, and each row is a whole-width target.
- **callbaba-com--blog:** the phone number is a button beside the primary CTA, and guides are headed by situation ("When a claim is denied"). Lesson: the phone is an equal action, and headings name the visitor's situation.
- **ritual-com:** a split hero with the product as a lit object on one side and headline plus two actions on the other. Lesson: an object on a clean ground carries premium without people, which validates the faceless tooth film.
- **calendly-com--about:** one centred primary action in one blue. Lesson: a single action colour; the warm token stays reserved.

**Directions:**
- **A. "Film, then the right door".**
  - *Opening:* keep the committed R16 tooth film and promise.
  - *Lower section:* "Came for something else?" is promoted to the second screen as a Menkind-style row stack. Each row ends in its real action: Book, Call, Example times, or the new Request a callback.
  - *Signature:* a time-aware action bar. Inside opening hours it offers "Book an appointment · Call". Outside them, "Request a callback · Call". The hours come from the published opening hours in `Australia/Sydney`.
  - *Motion:* only the row expand and the bar label change, both state-reporting.
- **B. "Booking-first".**
  - *Opening:* the example-appointment picker is the hero, with the image secondary.
  - *Lower section:* the fees ledger.
  - This is close to the rejected "time-held board", and it makes a demonstration of sample times the first promise. Not chosen.
- **C. "After hours at Lantern".**
  - *Opening:* the practice's live state is the headline ("Closed now. Opens 8am Tuesday.") with a callback request as the primary action, over a dim still of the room.
  - *Lower section:* fees and location.
  - It shows the dropped callback-form offer most directly, but it replaces an opening the owner accepted in R16, and at 10am it reads as a clock widget.

**Chosen: A.** It keeps the owner-committed opening and the DESIGN.md rhythm. It adds the one thing Monday's calls need (a callback path a practice manager can try) inside the existing router. It gets C's after-hours insight through the time-aware action bar without replacing the film.

### D3. Aldergate (identity locked; targeted only)
**References:**
- **humahome-com:** above the headline, a live search summary chip ("Barcelona · For sale · From €500,000") over an interior photo. Lesson: echo the current search state as a chip at the hero's edge.
- **heatherwick-com:** a wordmark centred over a full-bleed architectural image. Lesson: this confirms Aldergate's cover device is a recognised premium composition, so keep it.
- **kkaa-co-jp:** a right-aligned stacked text navigation over an aerial image. Lesson: a place index works as quiet type over photography.
- **fosterandpartners-com:** a single caption at the bottom of a full-bleed image, with a dot pager. Lesson: the caption can carry navigation. It's rejected here because it would rotate the locked hero.

**Directions:**
- **A. "Cover plus live search state".**
  - *Opening:* the locked cover is unchanged. The search bar gains a live result count ("13 homes in the Inner West") that updates as Buy, Rent or Sold changes.
  - *Lower section:* the suburb index reuses the kkaa principle, with suburb names as a right-aligned list over the harbour photograph, and hovering or focusing a name swaps the photo.
  - *Motion:* a crossfade on user focus only.
- **B. "Featured-home pager".** Cycle three featured homes in the hero with a caption pager. It breaks the locked-hero rule. Not chosen.
- **C. "Index-first".** Open on the listing index (ArchDaily-style) and push the cover down. It reverses the owner's chosen cover. Not chosen.

**Chosen: A.** It's the only direction that respects "keep the original identity". Each change is small and evidenced: the result count answers "is there anything for me?" before a search, and the suburb index already exists.

### D4. Marden & Rowe (owner's chosen design kept)
**References:**
- **are-na:** it opens by stating plainly what the thing is, as a short numbered list. Lesson: say plainly what the firm does and doesn't do before persuading. The legal site already does this with "we don't act in family law…"; keep it.
- **callbaba-com--blog:** situation-headed guides with the reviewer named. Lesson: organise help by the visitor's situation ("A contract has arrived"), not by practice-area jargon.
- **gehry-getty-edu:** "Scroll for story", with a line drawing that reveals as the page moves. Lesson: an SVG line draw can carry the narrative; that's the Anime.js path if the film is ever replaced.
- **standardvision-com:** an architectural photo with a short headline at lower left and one outlined secondary action. Lesson: anchor text low-left over photography with one outlined secondary.

**Directions:**
- **A. "Prepared, then requested".**
  - *Opening:* unchanged.
  - *Lower section:* the "Walk into the first meeting prepared" chooser becomes a two-step flow. Step 1 picks the situation and shows the bring/ask lists. Step 2 is "Request this first meeting", a demo form prefilled from step 1.
  - *Motion:* none added. The step change is instant, with focus moving to the new heading.
- **B. "The contract, annotated".**
  - *Opening:* a contract page drawn in line (Anime.js SVG draw), with margin notes appearing at "cooling-off" and "special conditions" as the visitor scrolls.
  - *Lower section:* practice areas.
  - It's distinctive, but it replaces the owner's chosen opening. Not chosen without the owner's say.
- **C. "Street front".**
  - *Opening:* the 88 Norton Street façade and today's office status, headline low-left.
  - *Lower section:* the first-meeting flow.
  - It needs a street photograph of a real building and hardens the address problem (L2). Not chosen.

**Chosen: A.** It fixes the only structural gap (no enquiry capture) without touching the owner's design. It adds no new engine or media, and it reuses the checklist, which is the site's most useful idea.

---

## E. Motion rule

- **React sites (marketing, dental, Aldergate): Motion (motion.dev) only**, via `LazyMotion` and `m` (~4.6 kB initial), with `MotionConfig reducedMotion="user"`.
  - None of the three depends on Motion today.
  - Marketing uses a custom `Reveal` plus CSS, and dental uses CSS and its own scroll film.
  - Aldergate uses GSAP in `ApproachSequence.tsx`. Leave it until that component is next revised, then move it to `useScroll` (R6). Never run two engines on one page.
- **Static legal site:**
  - It already ships GSAP and ScrollTrigger for the film.
  - Anime.js v4 is the designated engine only if the film is rebuilt (L6). Don't layer it on top of GSAP.
- **Purposeful only.** One signature interaction per site (listed in section A). Otherwise motion only reports a state change: drawer, selection, step or filter swap. No section fade-ins; M8 removes 62 of marketing's 65.
- **Reduced-motion path (required):**
  - Scroll films show one captioned still and load no frame sequence.
  - The rotating word is removed; there's no replacement animation.
  - Layout transitions become instant.
  - Check at 390 with `prefers-reduced-motion: reduce` (evidence: `*-home-390-reduced-*.png`).
- **Examine motion as the RISE step requires:** frames at 0, 25, 50, 75 and 100% for every new or changed motion before calling it done.

---

## Top portfolio fixes (in order)
1. **M1:** Bianca Brown Realty (a real client) is labelled "fictional", with Brooke and Zac named. Remove it or get approval. BLOCKED-ON-OWNER-COMMIT.
2. **M2:** Receptionist capability claims (transfer, per-call summary) contradict the pack. Rewrite the claims or unlist the page. BLOCKED-ON-OWNER-COMMIT.
3. **D2:** Build the the dropped callback-form offer callback demo on Lantern. Clean, new files.
4. **D1 and D3:** Honest `/book` fallback (new file) and removal of the "confirmed straight away" contradiction. `page.tsx` is clean.
5. **M3:** Case studies must describe what each linked demo actually does (M&R portal and quote, Lantern live diary). BLOCKED-ON-OWNER-COMMIT.

**Can start now on clean files:**
- D1 (`error.tsx`), D2, D3.
- M4, M8 (except `work/page.tsx`).
- L1–L6, R6.

**Blocked until the owner commits:**
- Marketing `site.ts` and `work/page.tsx`: M1, M2, M3, M5 labels, M6, M7.
- Dental `team/page.tsx`, `page.module.css`, `globals.css` and the `VisitScene*` components: D4, D5, D6, D7.
- Aldergate `PropertyCard.tsx`, `CREDITS.md`, `page.tsx` and `data/site.ts`: R1, R2, R3, R4, R5.
