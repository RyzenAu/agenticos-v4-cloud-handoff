# Site-draft design system (v4, 24 Sep 2026)

The design system every prospect draft is built from. Code: `scripts/site-draft/direction.ts`
(directions and seeding), `render.ts` (components and motion runtime), `imagery.ts` (Higgsfield
film and still), `build.ts` (the Claude refine prompt). Owner's bar: "premium, no AI slop,
reference websites, just interactive, Higgsfield, just crazy good".

## Reference bars (teardown, 24 Sep 2026)

| Vertical | Bar | Mechanisms we take (checkable by looking) |
|---|---|---|
| Dental | Tend, hellotend.com | Headline ~5x body in two lines; both actions (book + phone) inside the first viewport; one shape language (pills and arch masks) used everywhere; the action colour appears only on booking. |
| Legal | Allens, allens.com.au | Full-bleed abstract place imagery, never people; a calm institutional palette with a single accent; the hero does a job (search), not just decoration. |
| Real estate | BresicWhitney, bresicwhitney.com.au | The masthead is the hero: huge condensed type; sense of place from bleed photography; black/white/grey with hairline rules, type doing the work. |

What we refuse (frontend-design / impeccable craft floor): cream + terracotta, eyebrow labels,
all-caps labels, `01/02/03` numbering, identical icon cards, gradient text, blobs, the same
fade-up on every section, and any photo of a person.

## Seeding

`buildDirection(lead, history)`: FNV-1a hash of name + suburb + vertical seeds a walk over every
direction x hero combination (4 x 3 = 12 per vertical). The orchestrator passes the directions
sibling drafts already use, so a lead gets the first unused combination in its seeded order and
the least-used hero composition; ten leads in a vertical get ten different-feeling sites. A saved
`direction.json` is reused, so re-drafting a lead never changes its look.

## Directions

| Vertical | Direction | Palette | Type (display / body) | Imagery brief | Material signature |
|---|---|---|---|---|---|
| dental | **Stone Clinic** | light: paper `#e9e6e1`, ink `#1b1d21`, accent `#2d43b8` | Bricolage Grotesque / Figtree | Curved limestone and plaster, moving morning light. The place a visit feels like, never the chair. | Arched and pill-rounded forms echoing the arches in the imagery; one lapis-blue action colour. |
| dental | **Dusk Room** | dark: paper `#14171c`, ink `#ece8e1`, accent `#b9c8ff` | Newsreader / Inter Tight | The last blue light in a calm room, glass and water, slow reflections. | A literary serif glowing on blue-black; periwinkle only on the call to action. |
| dental | **Fresh Linen** | light: paper `#fafaf7`, ink `#10243a`, accent `#ff6a3d` | Familjen Grotesk / Instrument Sans | White linen, clean water, fresh daylight. | Linen whites, navy type, a single coral action colour. |
| dental | **Sydney Sandstone** | light: paper `#ebe1d2`, ink `#2b2118`, accent `#7a2331` | Young Serif / Onest | Sydney sandstone, afternoon sun, eucalypt shade. Of Western Sydney, not a showroom. | Warm sandstone ground, oxblood action colour, an old-style serif voice. |
| legal | **Chambers** | dark: paper `#0f1a16`, ink `#ebe6da`, accent `#c8a96a` | Cormorant Garamond / Source Sans 3 | Timber, stone and afternoon light in an empty library-like room. No scales, no gavels. | A sharp Garamond on bottle green; brass reserved for the one action. |
| legal | **Paper Trail** | light: paper `#f3f2ee`, ink `#121417`, accent `#1c3faa` | Libre Caslon Display / Instrument Sans | Heavy paper, light and shadow, a fountain pen. No readable documents. | A document-grade Caslon; Oxford blue only for actions. |
| legal | **Graphite Grid** | light: paper `#e7e8e6`, ink `#0c0d0e`, accent `#c8281a` | Archivo (condensed) / Archivo | Concrete, glass and shadow in strong geometry, abstracted to planes. | Condensed uppercase on a strict grid; signal red once per screen. |
| legal | **Harbour Slate** | dark: paper `#1b2129`, ink `#e9edf1`, accent `#8fb3d9` | Spectral / IBM Plex Sans | River light, slate, rain on glass. | A light screen serif on slate; harbour blue only for actions. |
| real estate | **Golden Hour** | light: paper `#f2ede6`, ink `#1f1b17`, accent `#22523b` | Gloock / Figtree | Late sun across timber floors in an empty room. Home, never a listing. | High-contrast display serif over warm plaster; bottle green for actions. |
| real estate | **Brick and Jacaranda** | light: paper `#eeeaf1`, ink `#231c2b`, accent `#6d4fc0` | Bricolage Grotesque / Albert Sans | Jacaranda blossom, red brick, wide sky. Local texture, no identifiable street. | A bold suburban grotesk; jacaranda purple as the single action colour. |
| real estate | **Streetfront** | light: paper `#ffffff`, ink `#111111`, accent `#f2c230` | Big Shoulders Display / Public Sans | Rooflines, eaves and sky in clean geometry. | A tall condensed masthead in black and white; signal yellow once per screen. |
| real estate | **Evening Lamps** | dark: paper `#17140f`, ink `#f1e9dc`, accent `#e9a14b` | DM Serif Display / DM Sans | Lamplight through windows at blue hour, a porch light. | A warm display serif on night brown; amber lamplight for actions. |

Every palette also defines `surface`, `muted` (AA on paper, tested), `line`, `accentSoft` and
`accentInk` (AA on the accent, tested in `direction.test.ts`). Accent rule: the accent is for
actions only (primary buttons); the header call button is ink, and the finale is a dark band, never
an accent flood. Each direction also sets a shape language (button radius, media radius, arch or
not). Condensed display widths (Bricolage 75, Archivo 62) come from the variable width axis.

## Hero compositions

The hero is always ONE pinned scene (2.6 screens tall on desktop, 2 on phones). Which
compositions a vertical may use follows its reference bar; ties go to the best fit first.

| Hero | Verticals | Layout |
|---|---|---|
| `frame` | dental (first choice) | 7/5 split: headline block left, a tall frame of image bleeding off the right edge (arch-topped when the shape says so). |
| `cinema` | all | Full-bleed image; headline and actions anchored bottom-left over a scrim; the header sits transparent over it (ink call button with a light ring). |
| `window` | all (real estate first) | Masthead: an oversized condensed headline with the lede and a hairline control beside it, then a full-bleed band of image filling the rest of the screen. |

Phones: every composition becomes the full-bleed version with the copy over the image, so the
headline, the lede and the primary action are all in the first screen.

## Motion (library-free, owner-approved technique)

Scrolling drives one slow, eased camera push-in across the hero-wide still (scale 1 to 1.3), which
match-dissolves into the hero-close still drifting forward (1 to 1.05): the Bianca Brown technique.
On screens 900 px and wider, the push-in is the Higgsfield film instead, scrubbed by scroll
(all-intra H.264, so every seek is instant), handing over to the close still at the end. The
scroll is followed with inertia (time constant 0.3 s, about GSAP `scrub: 1`) by a ~9 KB runtime in
`assets/site.js`: no GSAP, no Lenis. Elsewhere: the statement fills word by word as it crosses the
screen, images drift inside their frames, rows and panels arrive once, the finale address rises
line by line, the footer wordmark rises, and calls to action are magnetic on fine pointers. Only
transform and opacity move. `prefers-reduced-motion` (or no JavaScript) gets the first still,
static, and nothing hidden.

## Components

| Component | Contract |
|---|---|
| Draft chrome | "INTERNAL DRAFT — not for distribution" banner with a Sources button opening a `<dialog>` of every fact, its value, status and public source. |
| Header | Wordmark in the display face; three anchors; the ink call button (short "Call" label on phones), or "Get directions" when no phone is known. Hides going down, returns going up. |
| Hero | The pinned scene above. `<h1>`, lede, then one primary action and a quiet directions link (dental), or a hairline control that drives the tool below (legal: matter type; real estate: settlement month). |
| Statement | One sentence in the display face beside the detail image, which bleeds off the right edge. |
| Services | A full-bleed band of the section image with the heading set huge over it, then the intro and the index list. Evidenced services link their source; otherwise rows stay in full ink with a small outlined "Placeholder" tag. |
| Interactive tool | One per vertical, below. |
| Finale | Dark band: "Call <name>", the phone number set huge as the tap target, the address line by line, open in maps. With no phone, the address is the headline. |
| Footer | Facts, the M&U concept disclosure, and the name as a huge wordmark. |
| Mobile call bar | Fixed Call + Directions pill after the hero on phones (Directions + Find the office when there is no phone); steps aside when the tool or finale has its own action. |

Locked copy: the `<h1>`, lede, statement and finale title carry `data-lock`. The Claude refine pass
may polish around them but the orchestrator puts the art-directed text back (`relockCopy`), and a
refine that deletes one is discarded for the scaffold.

The refine pass may not edit `assets/site.js` (restored after it runs) or the hero stage, and QA
fails a page whose hero image covers less than 20% of the first screen at 1440 px or 375 px. If the
refined page still fails QA after its one fix pass, the tested scaffold ships instead.

Each image is used once: QA (`auditAssetReuse`) fails a page that shows any image, or the film,
more than once (renditions of one image count as one; a logo is exempt).

## Interactive element per vertical (evidence-only)

The tools never state a fact about the business. They help the visitor prepare and route to the
evidenced phone or address.

- **Dental: "Know what to say before you call."** Tap what applies (check-up, something hurting,
  new patient, child, nervous, costs); it writes a short script to read on the phone, with Copy
  and Call buttons.
- **Legal: "Walk into the first meeting prepared."** Choose what it's about; get what to bring
  and three questions to ask (fees in writing, who handles it, what happens next). Labelled
  general preparation, not legal advice.
- **Real estate: "Plan the sale backwards from moving day."** Pick a settlement month; it works
  back through appraisal, preparation, campaign, exchange and settlement (NSW: commonly 42 days
  after exchange). Labelled a general guide.

## Imagery (stills: GPT Image; motion: Higgsfield)

Stills (owner, 24 Sep 2026: "only use Higgsfield to make videos or motion; for pictures use GPT
Image") come from GPT Image 2 on the ChatGPT subscription, through Hermes' own Codex image plugin
(`scripts/site-draft/gpt_image_codex.py`, run by Hermes' venv Python). The call is **pinned to one
pool entry, `openai-2` (Usman's ChatGPT Plus)**: the script picks that entry by label, checks its
plan claim is `plus`, refreshes only that entry if its token is expiring, and refuses (exit 4) if
it is missing, dead or at its usage limit. `imagery.ts` treats a refusal as "stop all stills": no
move to the Pro accounts, no Higgsfield fallback. Hermes' config and its chat rotation are
untouched; nothing is printed. Higgsfield (Grok Imagine Image 2.0, 2K) is the stills fallback only
when GPT Image errors for another reason.

The Codex images backend ignores the requested size and returns 1536 x 1024, 1024 x 1536 or
1024 x 1024, so GPT stills are lanczos-upscaled (at most 2x, mild unsharp) for their largest
rendition. Usage cost on 24 Sep: 4 images moved Plus's 5-hour window from 0% to 1% (weekly 2%
unchanged).

| Asset | Model | Output | Where it is used (once) |
|---|---|---|---|
| hero wide | GPT Image 2 (ChatGPT openai-2) | 1536 x 1024 or 1024 x 1536 (frame hero), upscaled to 2400 / 2048 | hero, first frame |
| hero close | same | same aspect | hero, dissolve target |
| section | same | 1536 x 1024 | the services band |
| detail | same | 1024 x 1536 | beside the statement |
| film | xAI Grok Imagine Video 1.5, image-to-video FROM the hero-wide still, 1080p, 6 s | 1920 x 1088 or 1248 x 1664 | hero on wide screens, scrubbed |

Every hero and section image must read as its vertical at a glance (dental: treatment room and
chair, instrument tray, reception, toothbrush/floss; legal: meeting room, documents, pen,
settlement keys; real estate: homes, streets, interiors). `relevance.ts` asks Sonnet through the
official `claude -p` (Read tool only, cached in `assets/relevance.json`) and a mismatch is a QA
fail. Still banned: before/after, result smiles, faces presented as staff or patients, text/logos,
recognisable landmarks (a GPT hero drew a London skyline for a NSW firm; the prompt now asks for
low-rise suburban treetops).

Why these (Higgsfield history): Nano Banana 2 at 4K (account route) failed every submission on 24 Sep; Qwen Image 3 2K
returned HTTP 400; Soul 2 tops out at 2048 px; the only image-to-video models the route lists are
Grok Imagine Video 1.5 (first-frame input, up to 1080p) and Cinema Studio 4.0 (720p). Prompts are
subject + lens + light + a positive "empty of people, no text" block; the film prompt is one camera
move with "stable geometry: nothing morphs". A film under 1080 px on its short side or under 4 s is
rejected automatically and the still push-in runs everywhere instead; `qa/film-sheet.png` is kept
for a human look. Stills become WebP at 960/1600/2400 (heroes, plus a 9:16 phone crop) or 720/1200.
Fonts are self-hosted from Google Fonts' latin files. Cap: 7 paid attempts per draft (4 stills, 1
film, 2 retries), stop above US$3; cached in `assets/imagery.json` (version 2).
