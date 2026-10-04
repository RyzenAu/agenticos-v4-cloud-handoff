# "Jarvis, make a website for `<prospect>`" — v1 and v2

## Current dental default — 30 September 2026

Dental requests from the lead drawer, quick actions, the voice draft endpoint and Hermes's
CLI use the selected daylit-room flagship (the Dental Care Plus local preview). They all
generate into the registered `flagship-preview` folder. The dental default does not start a
Claude build or silently fall back to a generic design if its template is missing.

A fresh custom design remains available explicitly: `--bespoke` on the CLI or
`mode: "bespoke"` on the draft endpoint. The quick-action picker calls this
"Create a new design with Claude". Existing non-dental custom workflows remain available.

Deploy uses the generated preview, explicitly links its Vercel project, adds the custom
production domain, then assigns the exact returned deployment URL as its alias. Each CLI
failure stops the deploy. Live verification compares its built asset paths as well as the
business disclosure and noindex header; an unverified address is reported as failed.

The history below documents the earlier generic/custom generator.

Draft a first-cut, local, static website for one CRM lead, for internal review only. Never
publishes, never deploys, never emails or messages the prospect. v1 built 24 Sep 2026 (below); v2
(art-directed, evidence-checked, built on the Claude subscription, with motion) added the same
day — see "v2 — art-directed drafts" further down. `--fast` on the CLI still gets v1's instant
template path.

## What `/websites` actually is (discovery)

`src/routes/websites.tsx` + `scripts/website-os-plugin.ts` is **not a generator**. It's a live
preview + handoff tool: paste the URL of a website you already have running locally
(`http://localhost:3000`), it connects an iframe preview (desktop/tablet/mobile), and if that
site exposes a `Website OS` field editor (`GET /__wos/model`) it embeds that for live design/copy/
graphics edits. Otherwise it offers a "copy setup request" button that hands a coding agent a
prompt to wire one up. It has no template picker, no CRM integration, and does nothing with a
lead — it assumes a project already exists and is already running. So it can't do what this
brief asked for, and this build doesn't touch it.

## What was built instead

All new files, under `scripts/site-draft/`:

| File | Purpose |
|---|---|
| `vertical-copy.ts` | Generic, business-agnostic copy per vertical (dental/legal/real-estate) — taglines, generic service categories. Never a claim about one specific business. |
| `templates/base.html` | The one static single-page template, `{{TOKEN}}`-substituted. No `<img>` tags, no testimonials section, no staff bios — so there's nowhere to invent a photo of a person, a review or an award. |
| `generate.ts` | Core logic: `draftSite(db, leadRef, opts)` — looks the lead up in the CRM (`scripts/leads/crm.ts`, untouched), fills the template with only its real public fields (name, suburb, phone, address) plus the vertical's generic copy, writes `mu-site-drafts/<slug>/index.html` + `README.md`, and logs a CRM activity note (`draft site ready: <path>`). |
| `serve.ts` | Tiny loopback-only static file server (`Bun.serve`) for one draft folder. |
| `cli.ts` | `bun scripts/site-draft/cli.ts draft "<lead>" --serve` — works standalone, no dev server needed. This is what Hermes calls. |
| `plugin.ts` | Vite dev-server plugin, mounted at **`/__site-draft/*`** (see "why not `/__operator/websites/draft`" below), exposing `POST /draft` and `GET /status`. Spawns/reuses a per-lead preview server on a deterministic port (4300–4499, hashed from the slug) so repeat requests reuse the same preview. |
| `tool.ts` | The `site_draft` voice-tool schema + a `requestSiteDraft()` client helper, calling the plugin's endpoint. Not wired into the live voice stack — see the hand-off below. |
| `generate.test.ts` | Covers slugify/telHref, template rendering (including "never invents staff/reviews/awards/photos" and "no unresolved `{{TOKEN}}`" checks), and `draftSite`'s file + CRM-note side effects. |

Registered in `vite.config.ts` (2 lines: import + `siteDraftPlugin({ root: __dirname, token: REFRESH_TOKEN })`, same convention as `websiteOSPlugin()` right above it).

Drafts land in **`C:\Users\Nebula PC\source\repos\mu-site-drafts\<slug>\`** — a new, separate repo
directory, deliberately *outside* AgenticOS-v4's git repo and *outside* `MU-Workspace` (which holds
the real client/demo projects — dental, legal, real-estate, marketing — and was never touched by
this build). Nothing here recreates the retired 47-preview Vercel effort: nothing is deployed,
nothing has a public URL, and there is no Vercel/hosting call anywhere in this code.

## Phrasing

- "Jarvis, draft a website for St Clair Dental."
- "Jarvis, make a website for lead 14."
- "Draft a site for the dentist in Mount Druitt with no website." (Jarvis would need to resolve
  this to a lead first via the existing CRM lookup tools — `site_draft` itself takes a name or id.)

The tool never publishes on its own; it always reports a `localhost` preview URL and says nothing
has been sent.

## Why `/__site-draft/*`, not `/__operator/websites/draft`

The brief asked for the endpoint at `/__operator/websites/draft`. `scripts/operator-plugin.ts`
(~2,800 lines) mounts one middleware at `/__operator` that handles every sub-path itself and never
calls `next()` for a path it doesn't recognise — so a second plugin registered afterwards would
never see a request under `/__operator/*` without editing that shared file. Given the brief's own
instruction to keep new code in new files, `/__site-draft/*` is the safer equivalent: same
loopback-only + `X-Claude-OS-Token` guard, same JSON error shape. Folding it into
`/__operator/websites/draft` later is a small, mechanical change inside `operator-plugin.ts` if
someone wants that exact path — see the file's own header comment for the reasoning.

## Router / voice hand-off (not done here — do this yourselves)

`scripts/free-voice.ts`, `scripts/jev-router.ts` / `jev-router-skills.ts`, and
`src/components/operator/voice-companion.tsx` are being actively edited by other engineers, so
this build does not touch them. Everything needed to wire `site_draft` in as a real voice tool is
in `scripts/site-draft/tool.ts`. Exact lines to add:

**1. `scripts/free-voice.ts`** — add the tool to the brain's tool list:
```ts
import { siteDraftTool } from "./site-draft/tool"; // near the other local imports

// inside freeVoiceTools()'s returned array, alongside the other fn(...) entries:
siteDraftTool(),
```

**2. `src/components/operator/voice-companion.tsx`** — dispatch it, right next to the
`control_pc` line in `dispatchTool` (around line 1543):
```ts
import { requestSiteDraft } from "../../../scripts/site-draft/tool"; // adjust relative path to taste

if (name === "control_pc") return controlPc(args, toolSignal);
if (name === "site_draft") return requestSiteDraft(args, { token: /* the page's X-Claude-OS-Token, same source as operatorRequest in src/lib/operator.ts */ "" });
```
`requestSiteDraft` needs the same refresh token `operatorRequest` reads from `GET /__token`; wire
it through however that value is already threaded into `voice-companion.tsx` (it isn't imported
into `tool.ts` directly, to avoid guessing at that file's internals).

**3. Instructions string** (the `INSTRUCTIONS` constant in `scripts/free-voice.ts`) — optionally
add one clause near the `control_pc` sentence: "site_draft drafts a local, unpublished website for
a named CRM lead; always say the preview is local and nothing has been sent."

No other file needs to change. `site_draft` is deliberately not added to `RULE_ONLY_TOOLS` (the
`skill` enum) — it's slower than an instant local skill (it touches the CRM and spawns a preview
server), so it belongs with `control_pc`/`delegate_task` as a normal brain tool.

## Proof run

See the session's report for the lead used, timing, and screenshot paths
(`C:\Users\Nebula PC\Downloads\site-draft-*.png`).

## Known v1 limits

- Services are generic per vertical, not scraped from the lead's own site — nearly every lead
  worth drafting for (opportunity score driven by "no website") has nothing to scrape anyway.
  `mu-site-draft`'s SKILL.md documents how to do a manual follow-up pass for the rare lead that
  does have a current site listing real services.
- One template per vertical, not a redesign of the actual `MU-Workspace` demo codebases (those are
  full Next.js + Postgres apps with booking systems — far more than a first-look draft needs, and
  forking them per lead would require a database per draft). If a lead is won, the real build
  starts from the matching `MU-Workspace` project as usual, by hand.
- No images. Deliberate — it removes any temptation to source a stock photo of a person and pass
  it off as staff.

## v2 — art-directed drafts (24 Sep 2026)

The owner asked for the site-draft flow to look "art-directed, prospect-worthy" rather than a
plain template, and later explicitly raised the bar again mid-build: "the killer websites don't
look crazy good — use all the knowledge into that, use Higgsfield etc, motion, interactive etc."
v2 is a staged pipeline, still under `scripts/site-draft/`, still landing in the same
`mu-site-drafts/<slug>/` folder, still never deploying or contacting anyone:

| Stage | File | What it does |
|---|---|---|
| Evidence | `evidence.ts` | CRM facts (name, suburb, phone, address) plus, if the lead has a website, literal service text scraped from it — robots.txt-checked via the existing `scripts/leads/enrich.ts`, never invented. Every fact carries a source URL and a verified/missing status in `evidence.json`. Vertical compliance notes (e.g. AHPRA for dental) are attached here. |
| Art direction | `direction.ts` | A palette / Google Fonts pairing / layout idea / imagery brief / tone, deterministically seeded from business name + suburb + vertical (same lead always gets the same direction; different leads land on different ones), written to `direction.md` + `direction.json`. Pools are curated per vertical to stay inside that vertical's trust norms. |
| Imagery | `imagery.ts` | Tries Higgsfield first, through the **already-running Agentic OS dev server's** `/__design_higgsfield_account/status` + `/__design_generate` routes (its OAuth connection, not an API key — this file never reads a `.env`). Capped at 2–3 images, with mu-killer-site's ~$3 stop-and-ask rule enforced as a credit ceiling. Falls back to generated SVG/CSS art (gradient field + line motif) at zero cost if the dev server isn't up, Higgsfield isn't connected, or a generation fails. GPT Image via the ChatGPT subscription is checked and reported but not wired in — Hermes' `image_gen` tool isn't callable from a standalone script without a larger integration. Every asset (or the fallback) is logged to `CREDITS.md`. |
| Build | `build.ts` | Spawns the official `claude -p` CLI directly (same npm-shim-avoidance pattern as `scripts/claude-bridge.ts`'s `defaultClaudeBin()`), scoped to `--allowedTools Write Edit Read Glob Grep` with `--permission-mode acceptEdits --permission-prompts none` (auto-accepts file edits in the draft folder, auto-denies everything else) instead of `--dangerously-skip-permissions`, and **never `--bare`**. A wall-clock timeout (9 min default) is the turn/time cap — this CLI build has no `--max-turns` flag. The prompt requires: evidence-only claims, the direction brief, real Google Fonts, GSAP + ScrollTrigger (from cdnjs) for a hero with depth and a few tasteful scroll reveals, a `prefers-reduced-motion` fallback for all of it, a sticky mobile call bar, and exactly one evidence-safe interactive widget per vertical (dental: a services topic explorer; legal: a settlement-steps timeline; real-estate: a suburb snapshot). |
| QA | `qa.ts` | Screenshots at 1440px and 375px, console errors, and an axe accessibility/contrast audit — all via the `agent-browser` CLI already installed on this machine (there's no Playwright dependency in this repo and no existing `chromium.launch()` pattern; `agent-browser` is what `mu-concept-qa`'s own SKILL.md names). Plus a claims-vs-evidence audit (fails on any star rating, price, guarantee, before/after or named staff member not backed by `evidence.json`), a page-weight check, and a motion-performance heuristic (fails motion with no reduced-motion guard, warns on render-blocking scripts or missing `loading="lazy"`) standing in for Lighthouse — **this repo has no Lighthouse CLI installed, so this is explicitly a heuristic, not a measured score.** |
| Orchestration | `orchestrator.ts` | `draftSiteV2(db, ref, opts)` runs all of the above, and on a QA fail does exactly **one** bounded fix pass (mu-art-direction/impeccable's "one inspect, one fix, one confirm" rule) before logging a CRM note with the draft path, QA status and build time. |

`cli.ts draft "<lead>"` runs v2 by default now; `--fast` still gets the old instant template.
`plugin.ts`'s `/__site-draft/draft` endpoint takes the same `fast` flag in its JSON body.

### Higgsfield in practice (24 Sep 2026 proof runs)

One manual test generation succeeded (1.5 credits, an abstract architectural archway image, no
people). Three subsequent generation attempts through the same dev-server route — one during the
first automated proof run, two in isolated debugging — all failed with the same live-provider
error: `"The Higgsfield generation could not be confirmed... this request was not resubmitted."`
This reads as intermittent Higgsfield-side confirmation flakiness, not a bug in this pipeline: the
estimate endpoint and the dev server's OAuth connection both kept working throughout. The pipeline
falls back to the zero-cost SVG/CSS art on any generation failure, which is exactly what happened
in both proof drafts below — they shipped with generated gradient/line-art imagery, not a
Higgsfield photo. Total Higgsfield spend across this whole build-and-test session: 1.5 credits
(one successful manual test image, not used in either shipped draft).

### Bench against the M&U dental flagship and outside references

Read-only comparison against `muv-demo-dental`'s `docs/DESIGN.md` (Lantern Dental) and three
`inspo` MCP references (Belmond, Tavus, a "marquee hero" editorial pattern) — no file in
`MU-Workspace` or `muv-demo-dental` was touched.

- **Where v2 drafts are weaker:** the flagship's hero photography bleeds to the viewport edge and
  is a real, rights-cleared photograph; v2's imagery is either a Higgsfield abstract (when it
  works) or SVG gradients — noticeably less rich. The flagship also earns its hierarchy from a
  five-section rhythm tuned by hand over many rounds; v2's layout, while distinctive per lead, is
  closer to a well-executed "marquee hero + card" pattern than a fully bespoke composition.
- **A genuine tension worth flagging, not silently resolving:** the flagship's own `DESIGN.md`
  explicitly *removed* a fade-and-rise scroll animation across ~30 sections, calling repeated
  identical motion "decoration rather than communication." v2's build prompt asks for 2-3 scroll
  reveals plus a parallax hero specifically because the owner asked for motion on this pass — that
  is more motion than the flagship's own house rule currently allows itself. Both proof drafts
  keep it restrained (opacity/transform reveals, a `prefers-reduced-motion` fallback, no motion
  that gates content), but if the flagship's "motion only where it reports state" rule should also
  bind site-draft v2, that is an explicit product decision for the owner, not one this build made
  unilaterally.
- **Where v2 is already solid:** every claim is evidence-linked (the flagship's own booking
  contract equivalent — sample-only data, nothing invented); the QA claims audit actively fails a
  draft that states an unevidenced price, rating or staff name, which the flagship's own
  acceptance checks don't need to enforce (it has real content, not scraped/CRM-sourced facts).

### What's still not real Lighthouse, real video, or GPT Image

- No Lighthouse CLI is installed in this environment; the "performance" QA check is an explicit
  heuristic (render-blocking scripts, missing `loading="lazy"`, motion-without-reduced-motion,
  page weight), not a measured score. Don't quote it as a Lighthouse number.
- No `ffmpeg` is installed, so `agent-browser record start x.webm` (which needs ffmpeg on PATH)
  wasn't used; the proof below is a sequence of screenshots (including a scrolled mobile state
  showing the sticky call bar and the interactive widget) rather than a video capture of the
  scroll motion.
- GPT Image via the ChatGPT subscription stays a documented gap (see the Imagery row above), not a
  real fallback path in this pass.

## v3: premium drafts by default (24 Sep 2026)

Owner, verbatim: "the design of these websites premium, no AI slop, reference websites, just
interactive, Higgsfield, just crazy good", then "go with the motion, make it crazy good". The
design system itself is in `docs/SITE-DRAFT-DESIGN-SYSTEM.md`. What changed in the pipeline:

| Stage | v3 behaviour |
|---|---|
| Direction | `direction.ts`: 4 art directions per vertical x 3 hero compositions. Seeded per lead, skipping combinations sibling drafts already use; saved `direction.json` is reused so a re-draft never changes its look. |
| Imagery | `imagery.ts`: one Kling 3.0 film (5 s, no sound) + one Soul 2 portrait still per draft through the dev server's `/__design_generate` (its stored key; this code never reads one). Cap: 3 paid attempts per draft; retries only when nothing was billed; a dropped connection is recovered from the saved file, never resubmitted. ffmpeg (FFMPEG_BIN, PATH or the mu-tools copy) makes a seamless crossfade loop, posters and WebP stills. Cached in `assets/imagery.json`. |
| Scaffold | `render.ts`: the premium page every draft starts from, with GSAP + ScrollTrigger + Lenis self-hosted by `vendor.ts`. Written as `index.html` and `scaffold.html`. |
| Refine | `build.ts`: `claude -p` (Max plan, never `--bare`) as art director and copy editor over the scaffold, scoped to file edits in the draft folder. |
| Guards | `orchestrator.ts` `scaffoldGuards`: if the refine drops the banner, sources drawer, tool, tel: link, captions or motion hooks, adds an external host, or trips the claims audit, the scaffold is restored. A failed refine still ships the scaffold. |
| QA | unchanged `qa.ts` (agent-browser screenshots, axe, claims audit), one fix pass. |

`--fast` still gives the v1 instant template. New CLI-free options on `draftSiteV2`:
`skipRefine` (scaffold only, zero LLM) and `imageryOptions`.

### Operational lessons (24 Sep 2026)

- **Editing any file the Vite config imports restarts the Agentic OS dev server** (and rotates its
  session token). `plugin.ts` imports the whole `site-draft` graph, so editing these files while a
  Higgsfield job is in flight drops that job. Two Seedance 2.0 1080p jobs were lost this way
  (request ids in `/__design_higgsfield_requests`, status "accepted"; their output can only be
  fetched from the Higgsfield console now). Don't edit `scripts/site-draft/*` during a draft run.
- The dev server's Node HTTP server closes requests after ~300 s, so long video jobs lose their
  HTTP response even when nothing restarts; `imagery.ts` waits on `/__design_jobs` and picks the
  file up from `~/.claude-os/design/generations/`.
- Kling 3.0 std is 720p and reads soft at full bleed, so the renderer only puts the film in the
  hero when it is at least 1080p; otherwise the sharp 1152 x 2048 still leads and the film plays
  in a full-bleed band. A proven 1080p film model is the next upgrade.

### v3 proof (24 Sep 2026): St Clair Dental, Brander Smith McKnight Lawyers, Wish Real Estate

The design-loop critics (brief: Sonnet, system: Haiku, craft: Opus, blind against Tend, Allens and
BresicWhitney) ran three rounds. Brief critics passed all three drafts on the final round.
System critics passed two; Wish failed because its header call button is white over the film
rather than ink. Craft critics still preferred the references overall. St Clair won the lower page
and, on the round-2 scaffold, the opening too, until the refine pass rewrote the headline. BSM and
Wish lost both pieces: the critics named repeated imagery (one film and one still per draft), the
flat accent slab, and hero controls that read as templated. Mobile Lighthouse (simulated, two runs
each) scored 86, 87 and 82 to 83 for performance and 100 for accessibility, with CLS 0. Screenshots
and scroll recordings are in `Downloads\premium-draft-<slug>-*`.

## v4: image-first Higgsfield, library-free motion, locked copy (24 Sep 2026, evening)

Owner feedback on v3, verbatim: "fix those issues and make them crazy good. Those videos don't
even look good", then "I want to use Higgsfield for crazy-looking websites". Design system:
`docs/SITE-DRAFT-DESIGN-SYSTEM.md` (v4). What changed:

- **Imagery is image-first.** Four sharp stills per draft (Grok Imagine Image 2.0 at 2K: 2816 px
  landscape, 1776 x 2368 portrait), each used once, plus ONE film generated FROM the hero still
  (Grok Imagine Video 1.5, image-to-video, 1080p, 6 s). `higgsfield-api.ts` now sends a single
  reference as the model's first frame when the schema titles it "First-frame image".
- **Motion is the Bianca Brown technique**: a scroll-driven push-in across the hero still that
  match-dissolves into the close still, with inertia (scrub about 1), no GSAP, no Lenis. The film
  replaces the first push on screens 900 px and wider, scrubbed (all-intra H.264). Phones and
  reduced motion never see the film.
- **Locked copy**: `data-lock` on the h1, lede, statement and finale title; the orchestrator
  re-locks them after the refine pass (St Clair's refine had swapped its headline for an address).
- **QA**: every image used once (`auditAssetReuse`); the hero image must be visible in the first
  screen at 1440 and 375; a refine that still fails after its fix pass is replaced by the scaffold.
- **Fonts** are self-hosted per draft (latin woff2 files cached in `~/.cache/mu-site-draft/fonts`).
- **Hero compositions follow the bar**: legal and real estate never get the boxed `frame` hero.

Round-4 spend (Higgsfield API key, dev-server route): 12 Grok stills (from US$0.04 each), 3 Grok
films at 1080p x 6 s (US$0.25/s, about US$1.50 each), plus probes: 1 Grok still, 1 Soul 2 still,
1 Qwen still that timed out client-side (may have billed US$0.04), 1 Qwen and 1 Nano Banana 2
submission that were rejected before a job existed. About US$5.20 to US$5.60 in total. The two
Seedance 1080p films "lost" in v3 did complete (18:08 and 18:09) and were billed; they are unused.

### v4.1: stills from GPT Image (pinned to ChatGPT Plus), vertical-literal imagery (24 Sep 2026, night)

Owner, verbatim: "bro the dental doesn't even have ANY dental photos", then "only use Higgsfield
to make videos or motion; for pictures use GPT Image 2.5, it's free, part of the subscription",
then "run all GPT Image generation on Usman's ChatGPT Plus account (openai-2)".

- **Decision: stills = GPT Image 2 via Hermes' Codex image plugin; Higgsfield = motion only.**
  The label "GPT Image 2.5" is what the owner uses; the Codex images endpoint reports
  `gpt-image-2`. Largest available: the backend ignores `size`/`quality` and returns 1536 x 1024,
  1024 x 1536 or 1024 x 1024 (reported quality `medium`), so heroes are upscaled at most 2x with
  lanczos + mild unsharp. Higgsfield stills remain a fallback only when GPT Image errors.
- **Pinned account, no config change.** `gpt_image_codex.py --pool-label openai-2` loads Hermes'
  `openai-codex` credential pool, takes exactly the entry labelled `openai-2`, verifies its plan
  claim is `plus`, and refuses (exit 4) if the entry is missing, dead, cooling down after a limit,
  or can't refresh. `imagery.ts` stops all stills on a refusal: no silent fallback to the Pro
  accounts (openai-1 M&U, openai-3 Mehroz) or to Higgsfield. Hermes' `config.yaml`/`auth.json`
  are untouched, so no backup was needed; Hermes' own rotation for chat is unchanged. Verified
  with a dry run: `openai-2` resolves; `openai-1` is refused as not-Plus; an unknown label is
  refused.
- **Plus usage check before a batch** (`scripts/ai-usage` `fetchCodexUsage`): 5-hour 0%, weekly 2%
  before; after 11 images (St Clair 4, BSM 6 including two redos, Wish 1) the 5-hour window read
  4% and the weekly window still 2%. Measured cost: roughly 3 images per 1% of the 5-hour window.
- **Vertical-literal scenes** (`direction.ts`): dental = treatment room with chair and overhead
  light, instrument tray and mirror, reception, toothbrush/floss/mint; legal = meeting room,
  document folder, pen, settlement keys, reception; real estate unchanged (streets, homes,
  interiors). Still banned: before/after, result smiles, faces, text, logos, landmarks.
- **Relevance QA** (`relevance.ts`, wired through `qa.extraIssues`): hero wide, hero close and the
  section image are shown to Sonnet via the official `claude -p` (Read only); an image that doesn't
  read as the vertical fails the draft. Cached per file set.
- **Films**: Grok Imagine Video 1.5 at 1080p failed on every job of 4 s or more on 24 Sep night
  (St Clair 3:4 x4, BSM 3:2 x1; status "failed" after acceptance; request ids 5b9e98e1,
  11fe9060, 3132c4b5, 8517b405, d562888d), while 1 s probes at
  480p/720p/1080p completed. Portrait output follows the input (1152 x 1728 at 1080p). Pattern
  points at the Higgsfield account's balance or a per-job limit rather than the prompt; no more
  retries without the owner. Drafts without an approved film run the still push-in everywhere.
- **Redesign framing** (owner, 24 Sep night: the prospects probably already have websites; the
  "no website" flag was missing OpenStreetMap data). Drafts are "Redesign concept by M&U
  Ventures"; the refine prompt forbids copy implying no website. Where the current site was found,
  its first screen is saved as `current-site.png` in the draft folder for a side-by-side.
- **Own-site facts**: `own-site-facts.json` beside a draft holds facts a person read on the
  business's own current site (phone, address, suburb, services, with the page URL) for sites the
  polite fetcher can't parse; `applyOwnSiteFacts` (evidence.ts) merges them with source label
  "Business's own website". Ratings, client counts and years are deliberately not accepted.
  BSM: phone 02 8539 7475 and eight practice areas from bsmlaw.com.au/parramatta-lawyers. Wish:
  Seven Hills office, 1 Boomerang Place, 02 8664 3200, buy/sell/rent/manage from
  wishrealestate.com.au/offices. St Clair: no own site found (directory listings only), so its
  services stay labelled placeholders.
- **Correction (24 Sep 2026 lead-engine data-quality fix)**: "no own site found" above was wrong —
  it inherited the CRM's own bad assumption. OpenStreetMap had no `website` tag for St Clair
  Dental, and the lead engine used to read "no tag" as "no website" (see docs/LEAD-ENGINE.md,
  "Website discovery and exclusions"). St Clair Dental does have a real, current website; this v3
  draft was built on that false "no website" premise, with its services placeholder-labelled
  because nobody had actually looked. `scripts/leads/discovery.ts` now does that look before the
  CRM ever says "no website found", and `scripts/leads/cli.ts rescan` re-checks every lead already
  on file. Anyone redoing St Clair's draft should treat it as a `redesign draft vs their current
  site` (current-site screenshot side-by-side), not a from-scratch build — see the pitch/CRM
  fields for the discovered URL, source and confidence before starting.
- **QA fix**: the image-reuse audit counted a variable font referenced by several `@font-face`
  weights as a reused image (a false FAIL on BSM and Wish); `url()` now counts image files only.
- **Phone LCP budget**: hero phone crops step down (720/q58, 720/q46, 600/q42, 540/q36) until
  under ~90 KB; Wish's jacaranda crop was 199 KB and held mobile performance at 82. The services
  band's fallback colour is ink, so white heading text never sits on a light fallback.
- **Result (24 Sep night, mobile Lighthouse, local 3350)**: St Clair 94 / a11y 100 / CLS 0; BSM
  99 / 100 / 0; Wish 88 / 100 / 0 (SEO 63 everywhere is the intentional noindex). QA PASS on all
  three, relevance check passes on every hero and section image.

## "Generate website" — flagship previews per lead (25 Sep 2026)

The owner asked for a button on each lead that turns the vertical's **flagship** into a preview for
that company at `<slug>.muventures.com.au`. It lives in `scripts/lead-sites/` and the Leads drawer
(`src/components/operator/lead-drawer.tsx`), separate from the v1/v2 drafts above.

- **Templates, built once** (`bun scripts/lead-sites/cli.ts templates`): legal (`templates.ts`) is
  copied from `muv-flagship-legal` (Marden & Rowe, committed static files) and rewritten with Bun's
  HTMLRewriter: invented sections removed, identity fields turned into `{{TOKENS}}`, the services
  list made one repeatable item.
- **Dental and real estate keep their motion** (`next-templates.ts`, 25 Sep 2026, owner: "rebuild
  them so they keep the motion"). Each flagship is copied into `D:\mu-lead-site-builds\<vertical>`
  (dental: its working tree, which is what's deployed; real estate: committed HEAD, which is what's
  deployed — the repos are only read), the overlays in `scripts/lead-sites/overlays/<vertical>/` are
  laid over it and a list of asserted edits applied: identity becomes `{{TOKENS}}` in the *source*
  (`site.ts`), so the HTML, the RSC payload and the JS chunks all carry the same placeholder and
  hydration can't revert anything; staff, listings, fees, sample times, insights and claims are
  removed; booking/API/other routes are deleted; services arrive at runtime from
  `#mu-preview-data`; the banner is a React component (`PreviewBanner.tsx`) so hydration keeps it.
  Then `next build` with `output: "export"` (images through a custom loader + pre-rendered WebP
  widths, since exports have no optimiser), unused public images pruned, and the build refused if
  any flagship identity survives in HTML, RSC or JS, or a token sits in a length-prefixed RSC text
  row. Filling replaces tokens in every HTML/RSC/JS file with values stripped of quotes, braces and
  angle brackets (`exportSafe`). Verified with made-up data: menus open, scroll transforms change, no
  console or hydration errors, mobile Lighthouse performance 91–96 (dental) and 85–88 (real estate)
  behind a gzip server. The earlier script-less snapshot (`snapshot.ts`) is no longer used for them.
  Output: `mu-site-drafts/_templates/<vertical>/`.
- **Generate** (`generate.ts`): evidence from `site-draft/evidence.ts` (CRM row + the business's own
  site, plus `own-site-facts.json` if a founder recorded one) → `fill.ts`. Missing facts become
  "to be confirmed" placeholders. The site-draft claims audit and the residue check run again before
  anything is written to `mu-site-drafts/<slug>/flagship-preview/` (a sub-folder, so a v2 draft in
  `<slug>/` is never overwritten), with `PREVIEW.md` listing every fact and its source.
- **Safeguards**: fixed banner "Preview concept prepared by M&U Ventures for <Business>. Not the
  official <Business> website."; noindex meta + `X-Robots-Tag`; CSP with `form-action 'none'` and
  `connect-src 'self'` (no form posts, nothing third-party, so no tracking) plus forms stamped disabled; a 30-day expiry
  stamped at deploy that replaces the page once passed and shows as "Expired — take it down" in the
  UI; excluded / do-not-contact / won leads refused; at most 5 previews live at once.
- **Deploy** (`deploy.ts` → `vercel.ps1`, Windows PowerShell only): one Vercel project per preview
  (`mu-preview-<slug>`, team nahda), staged in `.operator-data/lead-sites/<slug>/`, any `.env*`
  deleted unread, domain added to the project (the `*.muventures.com.au` wildcard already points at
  Vercel). Only from the drawer's confirm dialog (or the CLI with `--confirm <domain>`); the live
  URL is then checked for 200 + banner + noindex header. Every generate/deploy/take-down is an
  activity note that keeps the lead's follow-up date.
- **Take down**: `vercel project remove` (answered via cmd's echo — PowerShell 5.1's piped BOM reads
  as "no"), then verified with `project inspect`. Afterwards the subdomain falls back to the
  wildcard's own M&U site, not the preview.
- **Routes**: `/__lead-sites/{status,thumb,local/<id>/…,generate,deploy,takedown}` (`plugin.ts`),
  loopback + token only. `thumb` captures a screenshot of the lead's real site with agent-browser.
- Proof, 25 Sep 2026: lead #25 Sydney Compensation Lawyers (legal) →
  https://sydney-compensation-lawyers.muventures.com.au, live check HTTP 200, banner shown, noindex
  header set; left live, expires 25 Oct 2026.
