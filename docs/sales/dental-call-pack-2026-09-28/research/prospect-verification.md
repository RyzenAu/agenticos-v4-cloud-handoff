# Dental call pack — 28 Sep 2026 — verification notes

Prepared 27 Sep 2026 for Usman and Mehroz's Monday phone calls. Read-only against the CRM;
no contact was made with any practice; no Google Maps or directory bulk-scraping was used.
Each candidate below was verified by fetching the practice's own website (WebFetch or curl,
27 Sep 2026) and quoting what was actually seen on the page.

## Step 1 — CRM state (read-only)

Checked with `bun scripts/leads/cli.ts stats` and direct read-only SQLite queries against
`AgenticOS-v4/.operator-data/crm.sqlite` (branch `jarvis-voice`) — no write commands used.

- **Total leads in CRM:** 963 (962 `new`, 1 `won`).
- **Dental leads:** 379 total.
  - Pitch breakdown: `none` 234, `audit_pending` 95, `receptionist` 26, `redesign` 12,
    `both` 9, `website` 3.
  - `excluded` (chains, duplicates, etc.): 24 dental leads.
- **"No website found automatically" audit queue (dental):** of the 95 `audit_pending`
  dental leads, 21 are a genuine "no website found (checked 2026-09-25)" result; the other
  74 are "couldn't load their site" (bot-protected or timeout) — a real, known site the
  crawler simply couldn't get past, not a "no website" case. Per `docs/LEAD-ENGINE.md`'s
  24 Sep fix, `pitch: "website"` is now reserved for genuinely no-website leads, so the CRM
  itself already distinguishes these two states.
- **Bot-protected leads:** 76 across all verticals, 36 of them dental (reasons contain
  `"bot-protected"` — a security-check/challenge page rather than the real site). Examples
  hit during this pack: Your Healthy Smile (Mount Druitt, lead #3) still returns HTTP 403 to
  a plain fetch, confirming the CRM's flag; Belfield Dental (lead #327) returned HTTP 403 to
  a bare `curl` request but loaded normally through the fetch tool used for this pack — worth
  a note in case it also blocks some browsers.

### Leads #252 and #285 — CRM vs actual site

- **#252 "Dental Surgery"** — CRM website field: `https://dental.com.au/`
  (`website_source: discovered_guess`, checked 2026-09-24). **This is wrong.** Fetching
  `https://dental.com.au/` shows it is **The Schwartz Family Foundation**, a charitable
  foundation that funds dental research and lectureships at the University of Sydney and
  Westmead Hospital — not a dental practice, and not the business behind lead #252. The
  domain-guessing heuristic (`name.com.au`/`name.com`) picked a generic industry domain that
  happened to resolve, and the "mentions the business name" check apparently passed on the
  word "dental" alone. **Excluded from the call pack** — not included in `prospects.csv`.
  Recommend a `rescan`/manual fix on #252 in the CRM (not done here — read-only).
- **#285 "Denture Clinic"** — CRM website field:
  `https://goldensmiledentureclinic.au/denture-clinic/new-south-wales/st-marys/`
  (`website_source: discovered_phone_finder`, checked 2026-09-25). **This one is correct** —
  it is a real sub-page of Golden Smile Denture Clinic's own site (`goldensmiledentureclinic.au`),
  which has locations at Cabramatta West and St Marys. Verified by fetching the site's home
  page directly; name, phone `(02) 9711 3272` and the St Marys location all match. Included in
  the pack as priority 1 (St Marys is in the owner's priority Western Sydney area).

## Step 2 — selection method

Queried the CRM (read-only, direct SQLite `SELECT`s — no `find`/`discover`/`enrich`/`send`
commands were run) for dental leads with `excluded = 0`, grouped by area, prioritising:

1. **Western Sydney first** — `area` = "Mount Druitt NSW", "Blacktown NSW", "Penrith NSW"
   (11 candidates found; most already-verified "decent, modern site, nothing to fix" —
   Senior Denture Clinic Penrith was the one with a real, evidenced gap).
2. **Wider Greater Sydney**, ordered by the CRM's own lead score, restricted to
   `pitch IN ('receptionist','redesign','both','website')` — i.e. leads the engine already
   flagged as having *something* observed, not the "nothing to fix" `none` pitch.

No leads were added from ordinary web search — the CRM's Greater Sydney pool was large
enough (317 dental leads) that Western Sydney plus scored Sydney-wide leads gave more than
20 verifiable independent candidates without needing to go outside the CRM. Two CRM leads
with a genuine "no website found" state (Marayong Dental Clinic #4, The Kingsway Family
Dental #242) were checked with an ordinary web search (not Maps scraping) for a real site;
neither search turned up a confirmed practice-owned website, only directory listings
(HealthEngine, Yellow Pages, dentist.com.au). Per the hard rule against inferring "no
website" from an automated absence, **these two are left out of `prospects.csv` entirely**
rather than marked "no website" — there is nothing to verify or evidence a problem against.

## Exclusions and why

- **Corporate chains** — excluded from candidates even where the CRM had them scored:
  - **The Dental Boutique** (lead #214, `dentalboutique.com.au/sydney/`) — confirmed by
    fetch to be a 15-location, five-state, trademarked group brand ("Dental Boutique™"),
    with a second Sydney location cross-referenced on the same page. Excluded.
  - **Glebe Dental Group** (lead #249) — website field is literally a Bupa Dental "find a
    dentist" listing page (`bupadental.com.au/find-a-dentist/...`), i.e. Bupa-owned. Excluded.
- **Directory/portal false positives** — not real single-practice sites:
  - **"DENTIST"** (lead #450, `dentist.com.au/dentist/nsw/epping`) — a directory listing
    page, not a practice's own site. Excluded.
  - **Dental Surgery** (leads #161/#200/#280) — three separate CRM rows, all pointing to the
    same `surgicaldentalservices.com.au` domain with no phone recorded to distinguish them.
    Left out as an unresolved CRM duplicate rather than guessed at.
  - **Dr James Tran** (lead #187, `drjamestran.com.au`) — verified by fetch to be a personal
    teaching/consulting portfolio site (multiple practice affiliations, "opening July 2026"
    language), not a single practice's own booking/contact site, and no phone number was
    found on the page. Excluded as a poor call target.
  - **Dental Surgery** (lead #252, `dental.com.au`) — see the #252 write-up above; the
    domain is a charitable foundation, not the practice. Excluded.
- **Bot-protected / unreachable sites left out of the pack** — Your Healthy Smile (#3,
  Mount Druitt) and several others return HTTP 403 to a plain fetch and could not be
  verified against their real page content within this pack's scope; they remain correctly
  flagged `audit_pending` in the CRM and are candidates for a future pass with a
  real-browser retry (already built into `rescan`, not run here — read-only task).
- **"No website found" leads not converted to rows** — Marayong Dental Clinic (#4) and The
  Kingsway Family Dental (#242); see above.

## Per-practice evidence notes

All sixteen rows in `prospects.csv` were verified by directly fetching the practice's own
homepage on 27 Sep 2026 (WebFetch tool, cross-checked with `curl` for HTML-level signals
like the `viewport` meta tag and `<form>` count where useful). Each row's
`observed_problem` quotes or describes only what was actually seen on the fetched page, and
`evidence_url` is the exact page fetched. Two stand out as the strongest, most concrete
findings:

- **Dundas Dental** — the page itself sends a `Last-Modified: Mon, 08 Oct 2018` HTTP header
  and its own footer says "© Copyright Dundas Dental 2018"; the HTML has no `viewport` meta
  tag at all (confirmed by direct grep of the fetched source) and no `<form>` tag anywhere on
  the page.
- **The Friendly Dentist** — the `https://` address fails outright with a TLS certificate
  hostname mismatch (`Host: www.thefriendlydentist.com.au is not in the cert's altnames:
  DNS:server.kayweb.com.au`), which is what a real visitor typing the secure address or
  clicking an old bookmark would hit; the plain `http://` address does load.

Weaker rows (priority 3: Gordon Dental Practice, Bio Dental Care, Northern Beaches Denture
Clinic) are flagged low-confidence in the CSV because the fetched content didn't cleanly
confirm the absence of a contact route (e.g. Gordon Dental Practice's page has a `<form>`
tag, so "no enquiry form" cannot be claimed with confidence — the opening line for that call
leads with the inconsistent listed hours instead).

## What wasn't verified / follow-ups

- Marayong Dental Clinic (#4) and The Kingsway Family Dental (#242): CRM shows "no website
  found"; an ordinary web search didn't turn up a confirmed practice-owned site either. Left
  out of the pack rather than marked "no website" per the hard rule — worth a phone-book/
  local-knowledge check before the CRM's own discovery is trusted either way.
- Your Healthy Smile (#3, Mount Druitt) and c. 35 other dental leads are bot-protected
  (403/challenge page) and could not be verified this pack; a real-browser retry (the CRM's
  `rescan` already supports this) would likely resolve most of them, but that's a write
  operation and wasn't run here.
- Belfield Dental returned HTTP 403 to a bare scripted request but loaded fine through the
  fetch tool used for this research — noted in the CSV in case it also gives some visitors
  or crawlers a blocked page.
