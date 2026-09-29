# Site audit — marketing, dental, aldergate, legal flagships
27 September 2026. Read-only audit; zero repo modification (verified below). Dev servers were started locally by this session and stopped afterward. No `.env` values were read or printed. No form was submitted past the fill stage.

## Zero-modification proof

| Repo | Branch | Before (lines) | After (lines) | Diff | Status |
|---|---|---|---|---|---|
| muv-marketing | marketing/flagships-receptionist-2026-09-25 | 41 | 41 | none | **IDENTICAL** |
| muv-demo-dental | flagship/breathtaking-2026-09-25 | 67 | 67 | none | **IDENTICAL** |
| aldergate | flagship/breathtaking-2026-09-25 | 38 | 38 | none | **IDENTICAL** |
| muv-flagship-legal | flagship/breathtaking-2026-09-25 | 41 | 41 | none | **IDENTICAL** |

`diff` between the before/after `git status --short` captures was empty for all four repos — same files, same status codes, nothing staged, nothing committed.

---

## 1. Marketing (muv-marketing) — M&U Ventures' own site

**Dev port:** 3000 (`npm run dev`, confirmed against README: `npm run dev # http://localhost:3000`).

**Dirty-file classification (41 files):**
- Owner's own edits (per task hints — do not touch): `CLAUDE.md`, `README.md`, `src/app/terms/page.tsx`, `src/app/work/page.tsx`, `src/content/site.ts` (the 1941-line content rewrite), `src/lib/assistant-prompt.ts`.
- Generated/evidence, not source: `memory/` (new, empty scaffold), 20+ untracked PNGs under `public/work/aldergate/`, `public/work/bianca-brown/`, `public/work/lantern-dental/`, `public/work/marden-rowe/`, and `review/marketing-2026-09-25/` + `review/main-site-flagships-2026-09-12/` — these are case-study screenshots and review evidence, not application code.
- No build artefacts in the dirty set (`.next` is git-ignored).

**Screenshots:** `marketing-home-1440.png`, `marketing-home-390.png`, `marketing-contact-1440.png`, `marketing-contact-390.png`.

**Promise / CTA:** "Websites for Dental / Law / Real estate" (rotating), sub-copy: "A complete site designed around your business, with an enquiry, appointment or appraisal form ready on launch. We build a concept site from what's already public first, so you see the work before you talk to us." Primary CTA: **"Book a call"** (top-right, persistent) and **"Request a concept site"** (hero).

**Extra question — is the AI receptionist product, audience and human-call path clear in the first screen?** Partially. The hero states "Websites for Dental / Law / Real estate" and lists audiences at the bottom of the fold ("Dental practices · Law firms & conveyancers · Independent real estate agencies"), so audience is clear. But **"AI receptionist" is not mentioned anywhere in the hero or first screen** — it's a nav item only, competing for attention with 7 other links (Dental, Law, Real estate, AI receptionist, Work, Process, About, Contact). A visitor scanning the hero would conclude this is a web-design studio, not learn that an AI phone receptionist is part of the offer, until they click through. Booking a call is clear and one click away ("Book a call" persists in the header).

**Invented/fake proof:** none observed on the home or contact page — no client logos, no testimonials, no stats. The contact form is honest about process ("You send this form. It goes straight to Usman and Mehroz, not a queue").

**Form endpoint:** `src/app/api/enquiry/route.ts` — real delivery via the **Resend HTTP API** using `RESEND_API_KEY` / `ENQUIRY_TO_EMAIL` / `ENQUIRY_FROM_EMAIL` env vars. If unconfigured it "degrades gracefully" (honest error, form retains input) rather than silently succeeding — but **when configured this is a live send, not a stub**. Walked the form to the fill stage only; did not submit.

**Top 3 UX/conversion weaknesses:**
1. AI receptionist — the product's most differentiated offer — is invisible on the first screen (`marketing-home-1440.png`). It should appear in the hero subhead or as a visible second CTA, not buried in an 8-item nav.
2. Two competing primary CTAs in the header/hero ("Book a call" vs "Request a concept site") with no visual hierarchy between them — both roughly equal-weight buttons.
3. Contact form (`marketing-contact-1440.png`) has no field validation cues visible on load (no inline error states seen — not stress-tested, since no submit was attempted).

**Accessibility (observed, not audited):** dark background (`#000`-ish) with gold/cream text — good contrast on hero headline; smaller nav links look borderline lower-contrast against near-black. No motion/animation issue observed on static load; hero heading rotates text (Dental/Law/Real estate) — reduced-motion behaviour not verified.

---

## 2. Dental (muv-demo-dental) — Lantern Dental flagship

**Dev port:** 3101 (`next dev -p 3101`, no port pinned in package.json/README — this session's own choice).

**Dirty-file classification (67 files):** this is the deepest, most-documented history of the four repos (`HANDOFF.md` runs 1,111 lines across 16 rounds of design iteration).
- Owner-facing memory/process docs: `CLAUDE.md`, `HANDOFF.md`, `docs/DESIGN.md` (modified) — round-by-round design history, explicitly preserved per the task brief ("R13 frozen … R14 … awaiting owner/Astra").
- Core app source, modified: `src/app/{book,contact,faqs,fees,globals.css,layout.tsx,new-patients,page.module.css,team,treatments}/*`, `src/components/{DemoBar,Footer,Header,Logo}.*`, `src/lib/site.ts`, `tsconfig.json`. **Deleted:** `src/components/Reveal.tsx` (round-16 change: "no scroll motion" — matches the memory note that R13 is frozen with no scroll motion).
- New app source (untracked): `src/components/{ChooseExampleLink,ExampleAppointments*,SiteFooter,VisitScene*}`, `src/lib/example-visit.ts` — the "example appointment" booking-safety feature described at length in `HANDOFF.md`.
- Generated assets pool, untracked: `public/img/{dental-mirror-probe-*,dental-model-explained-*,generated/*,lantern-blue-still-life.*}`, `public/lantern-outline.svg`.
- Verification scripts, untracked: 14 files under `scripts/` (`*-check.mjs`, `*-review.mjs`) — the round-by-round render/behaviour verifiers described in `HANDOFF.md`.
- `memory/` — new scaffold (`current-strategy.md`, `session-summaries/`).

Nothing here looks like a build artefact; `.next` is git-ignored and not in the dirty set.

**Screenshots:** `dental-home-1440.png`, `dental-home-390.png`, `dental-book-1440.png` (error page — see below), `dental-book-390.png` (error page), `dental-appointment-picker-selected-1440.png` (a real example-time selection, mid-journey).

**Promise / CTA:** "Dentistry. At your pace." / "You'll know the plan, the fee and the time before we start." Two CTAs: **"Book an appointment"** (header/hero, routes to `/book`) and **"See example times"** (scrolls to the in-page appointment picker).

**Primary conversion journey walked:** the homepage's **"Choose an example appointment"** widget (not `/book`). Selected "Tue 29 Sept, 2:30pm" with synthetic interaction only — no personal data was requested at this stage; the widget explicitly discloses under the picker: *"These times are examples generated for this demonstration from the published opening hours, in Australia/Sydney time — not a live booking calendar, not specific to any dentist, and no appointment is held."* This is the opposite of an appointment-confirmation promise the site can't back — it is an unusually careful disclaimer, consistent across 16 documented design rounds in `HANDOFF.md`.

**`/book` route is broken in this checkout:** navigating to `/book` (the header's actual "Book an appointment" link) throws a **server error**: `password authentication failed for user 'ops_owner'` — `src/app/book/page.tsx` calls a live Postgres query (`SELECT … FROM appointment_types`) via `src/lib/db`, and no working DB credentials are available in this local session (as required, `.env` was never read). Screenshots (`dental-book-1440.png`, `dental-book-390.png`) show Next.js's dev error overlay. **This cannot be judged as a site defect** — it may work fine against the real client DB — but it means the header's headline CTA is currently unusable in any environment without that specific Postgres instance reachable, which is worth confirming before a client demo.

**Extra question — does it promise appointment confirmation it can't back?** No, for the "new patient" flow: explicitly labelled "SAMPLE" and "example," with the strongest disclaimer of the four sites. However, the homepage's "Came for something else?" panel states check-ups **"are confirmed straight away"** — a real-booking claim on a page whose primary flow is elsewhere explicitly a non-booking demo; worth flagging as a copy inconsistency, not a fabrication, since `/book` (where a real submission would occur) does carry a real `submitBooking` server action with validation.

**Does the enquiry flow show the AI-receptionist/human-handoff value prop?** No — this is a booking/appointment demo site, not a receptionist demo. There is no visible "an AI receptionist answers your calls" messaging on the dental flagship itself; that positioning lives only on the marketing site. A prospect looking at Lantern Dental in isolation would see a generic (if well-disclaimed) booking form, not evidence of the AI-receptionist product line.

**Invented/fabricated claims:** none found that overstate reality — `HANDOFF.md` documents an unusually thorough photo-pool audit (Round 9) that **removed** five images for misrepresenting the practice (another practice's wall lettering, a legible NCI oncology badge, GP-not-dentist imagery, a real child mid-treatment). Team portraits are labelled "Fictional profile for this demonstration."

**Form endpoint:** `/book`'s `submitBooking` server action and `/contact`'s `submitEnquiry` server action both write to a live Postgres DB via `src/lib/db` — **not a stub/console.log**. Did not attempt submission.

**Top 3 UX/conversion weaknesses:**
1. `/book` (the header CTA's actual destination) errors out — see above; needs DB reachability confirmed before any client-facing demo.
2. Two "booking" mental models on one homepage — the real `/book` flow and the example-only picker — communicate differently (one confirms, one explicitly does not); a first-time visitor scanning quickly could walk away thinking either "this is live" or "nothing here is real."
3. The homepage is dense with the example-picker, a fee ledger, and five "came for something else" branches above one screen height on desktop (see `dental-home-1440.png`) — a lot of reading before any action, even though the design history shows multiple rounds spent trimming this.

**Page weight:** not measured — capturing the production `.next` build size was out of scope for a dev-server-only session and would have required a full `next build`, which risks longer-running writes to `.next` outside the audit's read-only intent; flagged as a gap rather than estimated.

---

## 3. Aldergate (aldergate) — real estate flagship

**Dev port:** 3200 (`next dev -p 3200`, this session's own choice; historical `HANDOFF.md`/`DESIGN.md` entries reference `3320`/`3311` from earlier rounds, not a fixed convention).

**Dirty-file classification (38 files):**
- Owner's core app source, modified: `public/photos/CREDITS.md`, `src/app/{demonstration,globals.css,home.module.css,page.tsx}`, `src/app/property/[slug]/*`, `src/app/saved/*`, `src/components/forms/EnquiryForm.tsx`, `src/components/home/HeroSearch.*`, `src/components/property/{Gallery,PropertyCard}.*`, `src/components/search/SearchPage.*`, `src/components/shell/Header.*`, `src/data/site.ts`.
- New app source (untracked): `src/components/home/{NeighbourhoodExplorer,PropertyCollection,PropertyScene}.*` — the "architectural cover" homepage direction documented as current in `HANDOFF.md`.
- Process docs (untracked, new): `AGENTS.md`, `CLAUDE.md`, `DESIGN.md`, `HANDOFF.md`, `PRODUCT.md`, `memory/`.
- Evidence/generated, untracked: `docs/review/` (round-by-round screenshots), `public/architecture-studies/`, `public/design-studies/`, `public/photos/concept/` (includes the AI-generated hero illustration referenced, then superseded, in `HANDOFF.md`).
- **One odd untracked path:** `i.src)` — a literal directory/file named `i.src)` at repo root, almost certainly a stray artefact from a shell redirection or truncated command during an earlier session, not real project content. Worth the owner deleting it (out of scope for this read-only audit to touch).

**Screenshots:** `aldergate-home-1440.png`, `aldergate-home-390.png`, `aldergate-contact-1440.png`, `aldergate-contact-390.png`.

**Promise / CTA:** "A local perspective. A place of your own." Primary CTA: **"Get an appraisal"** (header, persistent) and **"Find homes"** (search bar). Secondary: "Step inside" / "Explore this home" on the hero listing.

**Owner identity constraint respected:** no rebranding proposed anywhere in this audit; the current dusk/oxblood-to-blue identity churn is entirely the owner's own prior direction history in `HANDOFF.md`, not something this audit suggests changing.

**Primary journey walked:** `/contact` form — filled no fields (per the hard rule against submitting), but confirmed the form ("Tell us what you're trying to do") has Name*, Phone, Email*, "Who should this go to?"*, Message* — and an honest disclosure checkbox: *"This is a demonstration site; no agent will respond."*

**Form endpoint:** `src/app/api/enquiry/route.ts` posts through **Resend** with per-department routing env vars (`ENQUIRY_TO_SALES`, `ENQUIRY_TO_MANAGEMENT`, `ENQUIRY_TO_LEASING`, `ENQUIRY_TO_GENERAL`) — real send capability, not a stub, gated on env config; the visitor-facing copy is honest that it's a demo. There is also a second, separate `/api/assistant` route (Claude-Haiku-backed listing walkthrough assistant) gated on `ANTHROPIC_API_KEY`.

**Invented/fabricated claims:** the hero listing photo is AI-generated architectural imagery, disclosed via "Illustrative property photography" caption directly under the hero (`aldergate-home-1440.png`). Agent portraits are described in the README as "illustrated monograms," not photos of real people — good practice, no fabricated staff found.

**Top 3 UX/conversion weaknesses:**
1. The hero wordmark "Aldergate" is set in large serif type directly over the photo with no scrim in the letterforms' immediate background band — on the captured render it's legible, but it's tight against window mullions in the photo; worth a contrast check against `interior/twilight` photo variants if those are swapped later.
2. Two roughly-equal top-of-page CTAs again (search bar "Find homes" vs header "Get an appraisal") without a clear single primary action, same pattern seen on the marketing site.
3. Contact page copy promises "We reply to every enquiry within one business day" directly beside a form whose own copy elsewhere says "no agent will respond" — internally consistent once read carefully (it's about the demo, not the promise), but a fast scanner could read the reply-time promise as a live claim on a form that is explicitly non-functional.

**Extra note:** stray `i.src)` file noted above — cosmetic, not a security or content issue, but should be cleaned up when the owner next touches this tree.

---

## 4. Legal (muv-flagship-legal) — Marden & Rowe flagship (static HTML)

**Dev port:** 3351 (`node serve.mjs`, `PORT` env var overridable — this is the file's own default, confirmed in source: `const port = Number(process.env.PORT || 3351)`).

**Dirty-file classification (41 files):** unlike the other three repos, **100% of the dirty set is new, untracked screenshot evidence** — `review/flagship-2026-09-25/{before,after}/*.png` (before/after scroll captures at 1440/390/360, plus two comparison sheets). **No source file is modified or untracked** — `git diff --stat` returned nothing to summarise because there is no tracked-file diff at all. This is the cleanest of the four repos to reason about: **any future source edit here would not be "compounding uncommitted work" in the same way the other three are**, since the only uncommitted content is disposable review evidence.

**Screenshots (this audit):** `legal-home-1440.png`, `legal-home-390.png`, `legal-call-1440.png`, `legal-call-390.png`.

**Promise / CTA:** "Talk it through with a Leichhardt solicitor." Primary CTA: a service-type dropdown ("What's it about?") + **"Get my first-meeting list"**, plus a persistent header **"Call (02) 5550 0188"** button and a mobile-visible "First meeting" quick-contact bar.

**Primary journey walked:** the `#call`/"First meeting" anchor section — a static single-page site with no form to fill (it routes to `tel:` and a "first-meeting list" content anchor, not a data-collecting form), so there was nothing to fill with synthetic data short of a phone call link. Confirmed via source (`index.html`) that the callbar's actions are `tel:+61255500188` and `#prepare` (an anchor), not a submission endpoint.

**Form endpoint:** none — this flagship has **no data-collecting form at all**, only `tel:` links and in-page anchors. No live or stub endpoint risk exists here.

**Invented/fabricated claims:** none found. `CLAUDE.md` states the hard rule explicitly ("never use a real firm's name, staff, address, phone or claims; no outcome guarantees, credentials, awards or reviews"), and the rendered footer matches: *"Marden & Rowe is a fictional firm... Nothing on this site is legal advice, and contacting the firm does not make it your solicitor."* No dubious legal claims, no fake testimonials, no fabricated credentials observed on the home or call sections.

**Top 3 UX/conversion weaknesses:**
1. No lead-capture form anywhere — the only conversions are a phone call or an in-page anchor scroll. For a flagship meant to demonstrate conversion capability to a prospect, the total absence of an enquiry form (compared to marketing/dental/aldergate, which all have one) is the single biggest structural gap.
2. The hero photograph is dense (dark wood-panelled office, AI-generated) with white serif text over it — legible in the captured render at 1440 and 390, but there's no visible focus outline tested on the CTA button (not stress-tested via keyboard in this pass).
3. The mobile callbar duplicates the header's call CTA but with different wording ("Call us" vs "Call (02) 5550 0188") — minor inconsistency, easy fix.

**Extra note — static-site caveat:** `serve.mjs` deliberately serves only `index.html` and `assets/*` (regex-gated), and returns 404 for anything else, including dotfiles/docs/memory — a genuinely hardened tiny static server, worth noting as good practice.

---

## Ranked top 8 bounded, high-impact changes (across all four sites)

| # | Site | File(s) likely touched | Currently dirty? | Acceptance criteria |
|---|---|---|---|---|
| 1 | Dental | `.env`/deployment config for the `/book` route's Postgres connection (not a source file) | N/A — config, not tracked source | `/book` loads without a 500 in the target environment; `submitBooking` succeeds against a seeded DB in a staging test, not production |
| 2 | Legal | New `src/` or `assets/` form + a lightweight submit endpoint (site currently has none) | **Not dirty** — clean to build against right now | A "Request a first meeting" form exists with Name/Email/Phone/Message, honest demo-mode messaging matching the other three sites, and a stub or Resend-backed endpoint consistent with the marketing/aldergate pattern |
| 3 | Marketing | `src/app/page.tsx`, `src/content/site.ts` | **BLOCKED UNTIL OWNER COMMITS** (`site.ts` is explicitly owner's own dirty work per the task brief) | AI receptionist gets one visible sentence + secondary CTA in the hero fold, without removing "Book a call" as primary |
| 4 | Dental | `src/app/page.tsx` copy only (the "came for something else" panel) | **BLOCKED UNTIL OWNER COMMITS** (`src/app/page.tsx` is dirty; part of the round-16 rewrite) | "Check-ups are confirmed straight away" is either removed or qualified to match the example-booking disclaimer tone used elsewhere on the same page |
| 5 | Aldergate | delete stray `i.src)` path at repo root | **Not itself tracked/dirty as content** — it is an untracked stray file | Path removed; `git status --short` count drops by exactly one line; no other file touched |
| 6 | Aldergate | `src/components/shell/Header.tsx`, `src/app/page.tsx` | **BLOCKED UNTIL OWNER COMMITS** (both dirty) | Single clear primary CTA established between "Get an appraisal" and "Find homes" (e.g. one visually secondary) |
| 7 | Legal | `index.html` mobile callbar copy ("Call us" → match header's "Call (02) 5550 0188") | **Not dirty** — clean to touch right now | Callbar and header share identical CTA wording at all three captured widths |
| 8 | Marketing / Aldergate (shared pattern) | `src/app/page.tsx` (marketing), `src/app/page.tsx` (aldergate) | **BLOCKED UNTIL OWNER COMMITS** on both | Each homepage settles on one visually dominant primary CTA in the hero, with the secondary CTA demoted (outline/ghost style), verified at 1440 and 390 |

---

## Closing statement — what's safe to touch right now

- **muv-flagship-legal is the only repo safe to work on immediately from the current dirty tree without compounding uncommitted work.** Its entire dirty set (41 files) is disposable before/after screenshot evidence, not source — a new form or copy fix there touches files that are currently completely clean in git's eyes. Recommendation #2 and #7 above can start today.
- **muv-marketing, muv-demo-dental, and aldergate all carry substantial uncommitted source edits** (6, 32, and 21 modified/deleted tracked files respectively, plus many more untracked new components) that are the owner's own in-progress work per the task brief and each repo's `HANDOFF.md`. Any further edit to the specific files listed as "BLOCKED UNTIL OWNER COMMITS" above should wait until Usman commits that work — otherwise a subsequent `git diff` mixes this audit's changes into his own uncommitted redesign history and makes it harder to review or roll back either one independently. Non-overlapping files in those same repos (e.g. aldergate's stray `i.src)` cleanup) are still fine to touch now.
