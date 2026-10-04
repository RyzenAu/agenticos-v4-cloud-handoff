# M&U lead engine + CRM (24 Sep 2026)

Finds dentists, real-estate agencies and law firms, checks their website, scores how much M&U
could help, and keeps them in a CRM that Jarvis and both founders use. **It never sends an email
or places a call**: it produces call lists and drafts, and a founder logs what happened.

## Use it

Say it to Jarvis (Telegram or voice), or run `bun scripts/leads/cli.ts …` in this repo:

| You want | Jarvis | CLI |
|---|---|---|
| New leads | "find 20 dentists in Parramatta" | `find --vertical dental --area "Parramatta NSW" --max 20` |
| Today's calls | "who should I call?" (also 8:30 Mon–Sat on Telegram, with the top 3 prep cards) | `calls --n 10 --by usman` |
| Call-prep card(s) | "prep my calls" / "brief me on X" | `card <lead>` / `cards --n 3 --by usman` |
| Log a call | "Smile Dental, no answer" / "lead 12 interested, call back Friday" | `log 12 --outcome interested --next 2026-09-26 --event <id>` |
| Coach a call | (after logging) score the debrief against the 100-point rubric | `coach 12 --by usman --data '{"categories":{...},"worked":"…","improve":"…","nextStep":"…"}'` |
| Coaching trend | "how am I doing on calls" | `coaching --by usman --days 7` |
| Email draft | "draft an email to lead 12" | `draft 12` |
| Follow-ups due | "what follow-ups are due" / "draft my replies" | `followups --by usman` |
| Won a deal | "we won Smile Dental" / "kick off X" | `won 12 --scope "website + receptionist" --by usman` then `kickoff 12` |
| Update delivery progress | "content's in for X" / "mark the preview sent" | `milestone 12 "Content collected" --state partial --note "…"` |
| Opt-out | "they said stop" | `optout info@practice.com.au` |
| Numbers | "how's the pipeline?" | `stats`, `list --status interested`, `export` (CSV to Desktop\Business - M&U Ventures\data) |

Verticals: `dental`, `real-estate`, `legal` (Google types `dentist`, `real_estate_agency`, `lawyer`).

### Idempotent logging

Pass `--event <id>` to `log` with a stable id for the dictation/message you're parsing (its
Telegram/Hermes message id, or a hash of the utterance + timestamp). Replaying `log` with the
same `--event` is a no-op — it returns the lead unchanged instead of creating a second activity.
Omit `--event` for a manual one-off log where there's nothing to replay.

### Call coaching

`coach <lead>` scores a call from the founder's own post-call debrief only — never a recording —
against a 100-point rubric: Opener 15 / Discovery 25 / Value & fit 15 / Objection handling 20 /
Next step 20 / Delivery 5. A category the debrief didn't cover is left out of `--data`'s
`categories`, never guessed at. `coaching` reports the trend: average score, the categories
dragging it down, the most common objection tag, and whether the same improvement keeps
recurring. NSW needs every party's consent to record or listen to a private conversation, so live
capture exists only as **meeting mode** (`docs/MEETING-MODE.md`). It starts nothing until the
other party has agreed and that's been logged, it transcribes locally, and it discards the
transcript. Its notes land here through the same `log` + `coach` path, with the event id
`meeting:<id>`.

### Won deals and kickoff

`won <lead> --scope "…"` records the win (status → `won`) and builds an internal kickoff
checklist — intake questions, asset requests, accounts access, milestones — tailored to whether
the pitch was website, receptionist, or both. `kickoff <lead>` retrieves it later, with each
milestone's actual state (`pending`/`partial`/`done`, plus any note or due date) and the single
next action. Neither command emails the client, books anything, or touches Retell/Vercel/domain
settings: that's a separate, approved step through `follow-up-desk`, `receptionist-studio` or
`website-studio`.

Milestones are the delivery playbook's own set — content collected, build started, review sent,
revisions closed, balance invoiced, deployed, handover sent, review/referral asked (plus
"Receptionist transfer tested" for a receptionist deal) — tracked on the same `kickoffs` row, no
new table. Update one with `milestone <lead> "<name>" --state pending|partial|done [--note "…"]
[--due 2026-09-26] [--date 2026-09-22]`. Re-running `won` never resets progress already tracked.

### Verified vs score-only reasons, and a tighter call list

Every reason `calls`/`card`/`cards` shows is tagged `[verified]` (a fact this run actually
observed on the business's own site: no website, unreachable, no HTTPS, not mobile-friendly, no
booking, slow, stale copyright, DIY builder) or `[score-only]` (a directory signal — limited
hours, review count, star rating — real, but not something we looked at directly). `calls`
defaults to a tighter `--n 8` (was 15); pass `--verified` to either command to keep only leads
with at least one directly-observed fact before a calling block.

### Website discovery and exclusions (24 Sep 2026 data-quality fix)

OpenStreetMap often has no `website` tag even when a business has a perfectly real site — the
engine used to read "no tag" as "no website" and pitch these leads "(website)" with a "no
website" reason. Most of the 31 dental/legal/real-estate leads added 24 Sep were mislabelled this
way (St Clair Dental, Mount Druitt, is the clearest example). Fixed in `scripts/leads/
discovery.ts` + `exclusions.ts` + `rescan.ts`:

- **Discovery** (`discoverWebsite`, only for a lead with no `website` on file): (a) Hermes/Codex
  web search on the warm ChatGPT-subscription gateway (127.0.0.1:8642, `scripts/hermes-api.ts`),
  asked for JSON only (`{"url", "confidence"}`); (b) a polite fetch of DuckDuckGo's HTML results
  (robots.txt honoured, rate-limited, directory/social results skipped); (c) a guessed domain
  (`name.com.au` / `name.com`), accepted only once the fetched page actually mentions the business
  name and suburb. The first confident hit wins; "no website" is only ever recorded once all three
  have come back empty — as `no website found (checked <date>)`, never a bare assumption.
- **Rescoring**: a lead whose website (tagged or discovered) is real and reachable now pitches
  `redesign` ("your current site") instead of `website` ("you have none") once site-audit.ts finds
  real, observable problems; `receptionist` when the site is fine but there's no after-hours
  booking. `pitch: "website"` is reserved for a genuine no-website lead.
- **Exclusions** (`checkExclusion`, `scripts/leads/exclusions.ts`): government bodies, legal
  aid/community services, non-profits, universities, hospitals, and national chains/franchises are
  marked `excluded: true` with a reason — kept on file (never deleted), never scored or called.
  Checked against an editable denylist, OSM `operator`/`brand` tags, and a few name-pattern
  families. `excluded` (CLI) lists them; `calls`/`cards`/`list` skip them.
- **`rescan`** (CLI) re-runs exclusion + discovery + scoring against every open lead already in
  the CRM (skips `won`/`lost`/`not_interested`/`do_not_contact` by default) — the fix for leads
  added before this existed.

### Same-day follow-up: audit-pending, a real-browser retry, and duplicates (24 Sep 2026)

A spot-check of the first `rescan` found three more instances of the exact same underlying
mistake — treating "we couldn't check" as "here's the answer":

- **`pitch: "audit_pending"`** — a lead whose real, known site our own crawler couldn't load
  (timeout, or a WAF blocking it) used to fall back to the `website` pitch, which claims they have
  *no* site at all. `scoreLead` (`score.ts`) now gives that case its own pitch, `audit_pending`,
  with a reason that reads as our limitation ("audit pending — couldn't load their site (checked
  <date>): timed out") — never tagged `[verified]`, and never scored as an observed site problem.
  `pitch: "website"` now only ever means "genuinely no website found".
- **A real-browser retry** (`browser-audit.ts`) — a plain, honestly-identified fetch getting
  blocked or timing out isn't evidence a site is down (live case: bkperiodontics.com.au returns
  403 to our polite crawler's User-Agent, 200 to an ordinary browser). This repo has no Playwright
  dependency, so the retry reuses `scripts/site-draft/qa.ts`'s own `agent-browser` CLI plumbing
  (imported, not duplicated) rather than adding one. Off by default (the nightly `find` cron stays
  fast); `rescan` turns it on, bounded to 30s per site so one stuck retry can't hang a whole run.
- **Duplicate detection/merge** (`dedupe.ts`, `mergeLead` in `crm.ts`, CLI `dedupe`) — two CRM rows
  can be the same business (OSM mapped St Clair Dental twice; discovery correctly found the same
  real site, `stclairfamilydental.com.au`, for both). Grouped by shared discovered/tagged website
  domain, then by shared phone. The richer record (more of phone/address/emails/website/mapsUrl
  populated) is kept; the other is folded in — never deleted, just `excluded: true` with a
  "duplicate of #<id>" reason and `merged_into` set, same as any other excluded lead.
- **`list`/`calls` hide excluded leads by default** (`--all` to include them) — this was already
  true for `calls`/`cards`; `list` now takes the same `--all` flag (`excluded` still shows just
  that set on its own).
- Improved the domain guess (`candidateSlugs`): many real small-business domains keep one industry
  word and drop only a secondary descriptor ("Marayong Dental Clinic" is
  `marayongdental.com.au`, not `marayong.com.au` or the full name) — it now also tries stripping
  trailing generic words one at a time, not just "the full name" and "every generic word gone".
- A verification pass on discovery itself (added right after the first rescan, before this
  follow-up): every Hermes/DuckDuckGo hit is now re-fetched and checked for the business's name,
  suburb, *and* a vertical-appropriate keyword before being trusted — catches both a directory
  listing and a same-name, same-suburb false match from an unrelated organisation (live case:
  Hermes returned an actual ANZ Bank branch page, in the right suburb, for "ANZ Real Estate
  Consultants", at 0.97 confidence).

### SearXNG — self-hosted "finding sites" search (25 Sep 2026)

Owner-approved: [SearXNG](https://github.com/searxng/searxng) (AGPL-3.0) running loopback-only
inside the existing `kali-linux` WSL distro (never installed or reset — this only runs a Python
venv inside a distro that was already there), aggregating DuckDuckGo/Brave/Google CSE in one JSON
query. **Discovery order is now: OSM tag → a verified domain guess → SearXNG (falling back to a
DuckDuckGo scrape if it isn't running) → Hermes, last resort and budget-capped** (`scripts/leads/
discovery.ts`'s `discoverWebsite`, and `osm-hunt.ts`'s own `discoverForHunt`) — cheapest and most
self-contained first, so the shared ChatGPT Pro quota (Hermes) is spent only on what nothing else
could resolve.

- Start/stop: `scripts\windows\searxng.ps1` (`-Stop` to stop), `scripts\windows\searxng.vbs` for a
  silent/scheduled launch (same WMI+.vbs pattern as `changedetection.vbs`). Binds `127.0.0.1:18888`
  (8888 collided with something else already running on this machine). `discoverWebsite`/
  `discoverForHunt` fail silently back to DuckDuckGo (logged once per process, not per lead) if
  SearXNG isn't running — nothing in the pipeline depends on it being up.
- One-time setup performed manually (not by the launcher): cloned `searxng` into `~/searxng-src`
  inside `kali-linux`, a `virtualenv` (Kali's `python3.13-venv` needs `sudo`, unavailable in this
  session — `pip install --user --break-system-packages virtualenv` instead) at `~/searxng-venv`,
  `pip install -r requirements.txt` then `pip install -e . --no-build-isolation`, and a settings
  override at `~/searxng-config/settings.yml` (port 18888, `limiter: false`, `image_proxy: false`,
  JSON format enabled — safe only because this is loopback-only for our own programmatic use, never
  a public instance).
- A backgrounded `nohup cmd & disown` on one line was observed to sometimes let the process die
  with its parent shell anyway; the launcher instead captures the PID explicitly
  (`disown $!`) and sleeps briefly before the WSL invocation returns, and polls with a real HTTP
  request rather than `Get-NetTCPConnection` (which can lag behind the actual WSL-forwarded socket
  by a few seconds).

### Prospect-site changes, in the existing lead review

A verified changedetection.io change (`watch changes`) already lands as a note on the lead. That
note now also surfaces as a tagged `[verified]` reason in `calls` and `list` (within the last 7
days) and as a one-line count in `stats` — no new alert stream, no new cron.

## How it works

**Default source: OpenStreetMap — free, no billing, no key.**

```
Overpass search by tag (amenity=dentist / office=lawyer / office=estate_agent), inside a bbox ─┐
  suburb → bbox table (western Sydney), else Nominatim geocoding (≤1 req/s)                     ├─ skip ids
                                                                                                  │  already
                                                                                  in the CRM ─────┘
  → for each new lead's own website (politely: robots.txt honoured, ≤4 concurrent, our own
    User-Agent): HTTPS, viewport, booking widget, chat, © year, speed, platform, published
    emails/phones, "no unsolicited" notice — reuses site-audit.ts, same as the Google path
  → score 0–100 + reasons + pitch (website / receptionist / both)
  → .operator-data/crm.sqlite, `source = 'osm'`, `attribution = "© OpenStreetMap contributors"`
```

A lead with no `website` tag still gets discovery (see below) before it's ever called "no
website" — it's only callable on phone alone if that discovery finds nothing and OSM itself
published a phone number. A personal-looking free-webmail address
(`firstname.lastname@gmail.com` etc) is never treated as a published business contact — it's
counted separately (`flaggedPersonalEmails`) so a founder can look at it, never auto-emailed.

**Google Places — opt-in fallback, only while its key works** (`--source google` / `source:
"google"`; see "Owner step" below):

```
Text Search, IDs-only field mask ─ free, unlimited ─┐
                                                    ├─ skip place IDs already in the CRM
Place Details (Enterprise) for new IDs only ────────┘   ≤900/month (1,000 free), enforced
  → one GET of the business's own home page (+ contact page if no email): HTTPS, viewport,
    booking widget, chat, © year, speed, platform, published emails, "no unsolicited" notice
  → score 0–100 + reasons + pitch from the site audit only (Google's hours/rating/reviews never
    feed the stored score)
  → .operator-data/crm.sqlite, `source = 'google'`: the place ID, `places_checked_at`, and our own
    findings (audit reasons, score, emails/phone the practice publishes on its own site, recorded
    in `field_sources`). Name, address, phone, website, rating, reviews, hours and the Maps link
    from Place Details are NOT stored.
```

**Live details, never stored (27 Sep 2026).** A Google lead's details are fetched when it's shown
or prepped — `detail`, `card`, `cards`, `calls` (API and CLI) and call-script generation — by
`places-live.ts`: one in-memory cache per request, counted against the same monthly budget, and
every response carries `placesLive.attribution = "Google Maps"`, which the CLI/Telegram text and the
OS drawer render beside the data (Places §5.2: Places content without a Google map needs Google
attribution). The lead list/table isn't hydrated (no bulk lookups), so a Google lead shows there as
"Google place" until opened. A value stored with a non-Places `field_sources` entry (`website`,
`manual`, `osm`, discovery) always wins over the live one. Call scripts never send a Google lead's
live name to a model — the prompt says `[practice name]` — so neither the model vendor nor the
cached script (`.operator-data/leads/call-scripts/`) holds it. Check Google's current logo/text
attribution style guide before any client-facing surface shows Places data.

Files: `scripts/leads/{places,osm,enrich,site-audit,score,crm,outreach,engine,card,followups,coach,cli,api,discovery,exclusions,rescan,dedupe,browser-audit}.ts`,
tests in `scripts/leads/{leads,osm,api,ops,discovery,exclusions,rescan,dedupe,browser-audit,score}.test.ts` (`bun test scripts/leads`). Hermes skills:
`productivity/mu-leads` (general reference), `call-outcome` (debrief → log + coaching),
`call-card` (prep cards), `follow-up-desk` (due/overdue + drafts), `deal-proposal` (scope/price
drafts), `client-kickoff` (won → checklist), `jarvis-protocols` and `situational-status` (voice
protocols and status, built against the OS `/__operator/jarvis/*` routes). Crons: `lead-calls`
(`30 8 * * 1-6`, no model, silent when nobody is due, lists due/overdue follow-ups first, then the
tightened call list with the top 3 prep cards) and
`call-coach-<founder>` (11/2/4pm; stops nudging about the call quota once the founder's own
calling block has ended or the target's met — overdue follow-ups still surface either way).

## Rules built in (and why)

| Rule | Source |
|---|---|
| Calls only Mon–Fri 9 am–8 pm, Sat 9 am–5 pm, never Sunday or national public holidays (Sydney time); identify yourself, the business and the purpose; never withhold caller ID | Telecommunications (Telemarketing and Research Calls) Industry Standard 2017. B2B calls to a business number don't need a Do Not Call Register wash |
| Email only an address the business published on its own site, only about its business, identify M&U, working "reply stop" opt-out honoured by `optout` | Spam Act 2003, Sch 2 cl 4 ("conspicuous publication"). ACMA fined Lululemon $702,900 (Dec 2025) over a broken unsubscribe |
| A site that says "no unsolicited emails" is never emailed (`emailOk = false`) | same |
| Only the Google place ID (+ `places_checked_at`) is stored for a Google lead; Places content is fetched live per request with "Google Maps" attribution and never written. `purge` (dry run; `--apply` writes) / `scripts/leads/places-cleanup.ts` removes any older stored Places content — no 30-day grace and no "contacted" exemption — keeping fields whose recorded source isn't Places. Scoped to `source = 'google'`; OSM and manual rows are never touched | Google Maps Platform Service Specific Terms, Places §5.2–5.4 (place IDs are exempt from caching limits; other content isn't; no non-Google map; attribution without a Google map) — archived 2024-04-22 wording, re-check the live page |
| OpenStreetMap rows are kept permanently (ODbL allows it) and always carry `attribution = "© OpenStreetMap contributors"` | ODbL (OSM's licence) requires attribution to travel with the data, not that it be deleted |
| Overpass and Nominatim are used politely: a real User-Agent naming M&U, Nominatim capped at ≤1 request/second, robots.txt honoured before fetching a lead's own site | Overpass usage policy / Nominatim usage policy / standard web-crawling courtesy |
| No third-party email enrichment (Apollo, Hunter) | Privacy Act scraping risk (DLA Piper, Sep 2025); the business's own site is the cleanest consent story |
| A personal-looking free-webmail address is never stored as the business's contact email, only flagged | Same consent story — a personal Gmail address wasn't published *by the business* |

Unverified or to recheck: the exact telemarketing hours came from a secondary summary of the
Standard (check the legislation.gov.au text); the holiday list needs updating each December; the
score weights are a first guess, not tuned on outcomes yet.

## One-off data fixes (27 Sep 2026) — dry run by default

Both print counts/changes only unless `--apply` is given; a dry run opens the CRM read-only (no
schema migration either). Run from the repo root.

- **Stored Places content:** `bun scripts/leads/places-cleanup.ts` then `… --apply`. On 27 Sep the
  CRM had 0 Google-sourced leads (all 963 are OSM/manual), so this is 0 changes today; it's the
  guard for any `--source google` rows added before this change.
- **Wrong website (lead #252 `dental.com.au`, a research charity):**
  `bun scripts/leads/fix-wrong-website.ts --lead 252 --domain dental.com.au --unmerge` then
  `… --apply --by usman`. Clears the website on every lead carrying that domain (#252 and #398),
  marks `website_source = not_verified` with the reason "website not verified — owner to Google",
  sets pitch `audit_pending`/score 0, drops the reasons, emails and issues audit taken from the
  wrong site and its cached call script, and logs a note. `--unmerge` reverses #398 → #252: that
  merge matched on `dental.com.au` alone and the two have different phone numbers. `rescan` never
  re-guesses a `not_verified` website ("held for owner check").

## CRM choice

SQLite inside the OS, not HubSpot/Attio/Pipedrive/Twenty: $0, no Docker, no free-tier caps, and
Jarvis can read and write it directly. Mehroz reaches it through Jarvis (Telegram) or the OS over
Tailscale. Revisit if a third person joins or you want a mobile CRM app.

## Owner step (only needed if you want Google Places too)

Nothing is blocking the default flow — OpenStreetMap needs no key and no billing:
`bun scripts/leads/cli.ts find --vertical dental --area "Mount Druitt NSW" --max 15`.

Google Places stays available as an opt-in fallback (`--source google`), but the key in
`~/.config/agentic-os.env` still gets **403 PERMISSION_DENIED** for Places API (New) (and the
legacy API isn't enabled either). To fix it, in Google Cloud Console, for the project that owns
the key:
1. APIs & Services → Library → **Places API (New)** → Enable.
2. Credentials → the key → API restrictions: include **Places API (New)** (or none).
3. Billing: the project must have a billing account linked (the free caps still apply).

Then: `bun scripts/leads/cli.ts find --vertical dental --area "Mount Druitt NSW" --max 15 --source google`.
