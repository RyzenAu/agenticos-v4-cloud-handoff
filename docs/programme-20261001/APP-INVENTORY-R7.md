# App inventory and usability pass, round 7 (worker F, 3 Oct 2026)

Branch `r7/f-app-usability-20261003` (base `491b8ee0`). Scope: everything outside Agents (A), Computers (C), Coding (D) and CRM (E), plus
Receptionist as a read-only neighbour (on hold: not touched). Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`).

## Method

- Synthetic hub on port 8126 (`vite dev`, data dir `D:\AgenticOS-r7-data\f`, seeded by `scripts/acceptance/seed-gate-hub.ts --host none`; `AGENTIC_OS_NO_BACKGROUND=1`,
  `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`). Not 8081, not Ryzen, no real data, no `.env` read.
- **Survey:** every route in `src/routes` (38 URLs including the four Home tabs and a 404) at 1440x900 and 390x844, reduced motion, headless Chrome (playwright-core).
  Mechanical checks per page: one h1, horizontal overflow, text under 12 px, unlabelled controls, `href="#"` links, console and page errors. Screenshots:
  `evidence/r7-app/before/` and `evidence/r7-app/after/` (`<route>-d.png` 1440, `<route>-m.png` 390; `survey-*.json` has the numbers).
- **Reading:** each page's text and screenshot was read for the five-second test: what is the main job, what is the next action, is anything said twice, is any
  control or claim empty.
- **Failure injection:** every non-GET request answered 500 on Memory (save), Settings (profile), Goals (add goal), Work (record decision), Calendar (new event):
  the typed text had to stay and the page had to say why. A decision form was also driven for keyboard focus and Escape.
- **Escape and focus:** Go to, Type a request, Find leads, Connect accounts, More, Share screen, Meeting at 1440 and 390: open, Escape, where focus lands.
- **Back and forward:** the tab controls of Home, Settings, Receptionist, Design.
- **Websites (journey I):** templates copied read-only from the drafts folder into the data dir, previews generated for synthetic dental, legal and real-estate leads
  into `D:\AgenticOS-r7-data\f\drafts\`, served by the loopback preview server on 8136 and every URL on the page fetched. Nothing deployed, no network, no client.
- Not done: no live click on any control that spends, sends, deploys or publishes; no Hermes/Claude/Codex-backed page was exercised live (the hub has background
  jobs off, so those pages show their honest unavailable state).

## Mechanical result

| Check | Before | After |
|---|---|---|
| Pages with exactly one h1 (38 x 2 widths) | all | all |
| Horizontal overflow | none | none |
| Text under 12 px | Knowledge graph (8 px glyph badges, both widths), Audience on a phone (icon-only buttons at font-size 0) | Audience fixed (words back, titles added). Knowledge graph: the 9 px glyph in a 14 px "cron" badge on the Hermes session list is a decorative mark with its own title, not text; left |
| Unlabelled controls | Finances tab: the hidden file input behind "Choose NAB CSV" (aria-hidden, tabindex -1: correct) | same, by design |
| Dead `href="#"` links | none | none |
| Console 409 / 503 | the quiet-copy guard and the job store being off on this hub; the pages say so | same (environment, not a defect) |

## Inventory: route, main job, next action, editing and saving, issues, fix status

"Edits" = the page lets you change something and saves it. "Honest" = a failed read or save is explained and nothing false is shown.

| Route | Main job | Next action on the page | Edits and saves | Issues found | Fix status |
|---|---|---|---|---|---|
| `/` `/today` `/workspace` | redirect to Home | n/a | no | none | pinned by `l9-os-continuity` |
| `/business` (Home) | What needs you, then the business at a glance | Record decision / Open details on the first item; Needs attention links | decisions save (see Work); currency chip is per browser | "Command scene" and "Packages & economics" sat on every tab, not only Home | fixed: Home tab only |
| `/business?view=finance` | NAB cash flow import and Stripe | Choose NAB CSV | NAB CSV import with preview | the empty state said "no NAB data" three times (status row, card, fold meta) | fixed: one statement; status row only once data exists |
| `/business?view=progress` (Goals) | Goals against the $100k/month target | Add goal / Save update | goals and weekly update save; failed save keeps the text (tested: 500 injected) | none | none needed |
| `/business?view=audience` | Social numbers by platform | Record numbers | manual entry saves | title said "Audience", then an eyebrow, a second "Your audience." and a sentence; on a phone the two actions were icons only after a big gap | fixed: title only (heading kept for screen readers), words back on phones, `title` on both buttons |
| `/jarvis` | Give Jarvis a task | the request box, Send request, Use voice | request sent as a job | none (request box first, empty states are one line each) | none needed |
| `/chat` | Typed conversations | message box | messages save; failure keeps the tab copy and says so | the storage warning ended in two full stops after the server's own full stop | fixed (`floating-oracle.tsx`) |
| `/hud` | Jarvis at rest: read-only overview | none (read-only) | no | none | none needed |
| `/dashboard` | Mission Control (optional) | open breakdown | no | none | none needed |
| `/work` | Decisions, calls, pipeline, sites | Review the decisions | decisions save (tested: 500 keeps note, says "Decision wasn't saved") | the four counts (Decisions, Calls to make, Open leads, Sites down) were plain text; "6 open leads" under "Open leads 6"; opening a decision form left keyboard focus on the page body and Escape did nothing | fixed: each count links to its items (decisions list, Leads Today, Leads, Websites); the repeat is dropped; focus enters the form, returns to the button on close; Escape closes an untouched form and never discards a typed note |
| `/leads` | Calls to make and the pipeline | open a lead; Find leads | lead edit, call log, deal, do-not-contact (R6: drafts kept, two-step opt-out, Back closes the drawer) | the Find leads dialog lost focus to the page body on close | fixed in the shared dialog (below) |
| `/websites` | Sites, previews, make the next one | Start (make a site) / Ask Jarvis | generate, preview, deploy (human-confirmed) | the four make/ask tiles are the 29 Sep owner decision (pinned, kept). Bianca card: not touched | none needed here; website generation findings are in the next section |
| `/workspaces`, `/workspaces/$id` | Projects by workspace | open a workspace | no | none ("Demo data" is shown on synthetic data) | none needed |
| `/memory` | Find, ask and add to memory | search, or write a note and Save memory | save; failure keeps the text and says so (tested) | none | none needed |
| `/memory/vault` | Curated facts with sources | Remember / Save to vault | writes; with `MU_MEMORY_WRITES=off` the box is disabled and the page says why | none | none needed |
| `/memory-map` | Where each kind of memory lives | none (read-only) | no | none | none needed |
| `/codegraph` | Graph of a code project | pick a project, ask | no | 8 px glyph on the Hermes session badge (decorative) | left, see above |
| `/finance` | Where money stands | Import a NAB CSV / Connect Stripe | links to the import | the headline, "What needs you" and the Bank and Stripe tiles each said "not imported / not connected" | fixed: tiles say only "Unknown" / "Not connected" while the step is listed above |
| `/usage` | AI spend and plan limits | Edit prices | prices save | none | none needed |
| `/operations` | Package economics (Receptionist drilldown) | test a price | edits stay in the view, labelled | none | none needed |
| `/studio` | Make an image, video or proposal | Make an image or video | no | none | none needed |
| `/design` | Generate and browse media | Create | generation (paid: not clicked) | blank "VIDEO" cards where a poster is missing in the synthetic data; the Library tab does not push history | left: posters come from the ledger; tabs are in-page state |
| `/motion`, `/transitions`, `/share` | Motion kit, local clip preview, share card | prompt / choose a clip / copy text | local only | none | none needed |
| `/system` | Models, tools, plan limits | Check now | model check | the provider and tool tiles repeated the sentence of the cards right below them | fixed: tile keeps the state word, the card carries the sentence and the button |
| `/models` | Every model route | Check now, filter | check | none | none needed |
| `/skills`, `/skill-drafts` | Installed skills, drafts to review | none until data exists | approve a draft | none | none needed |
| `/settings` | Profile, connections, AI tools | Save profile | profile saves; failure keeps the form and says "Unsaved changes" (tested) | the tabs replaced history, so Back left Settings; Back to the entry with no tab kept the last tab | fixed: a tab click is one step in history, Back and Forward move between tabs; arrow keys still only move focus |
| `/setup` | First-run guide | Continue | profile fields | none | none needed |
| `/automations` | Scheduled jobs, failing first | read the failing card | pause/resume | a four-column card holds a 12-line failure text (R5 kept it: it is the fix instruction) | left |
| `/activity` | What Jarvis did, newest first | open a job | no | a failed read said only "HTTP 503" although the server sends a reason | fixed: the page shows the server's reason with the status |
| `/inbox`, `/inbox-triage`, `/calendar` | Conversations, triage log, schedule | Connect accounts / New event | calendar events save; failure keeps the form and says why (tested) | none | none needed |
| `/receptionist` | Calls, clients, launch readiness | Open flagged calls | Mark followed up | Back does not move between its tabs | not touched (Receptionist is on hold); proposal below |
| Shell (every page) | Navigation, Go to, Jarvis, Type a request, More, Share screen, Meeting | n/a | n/a | the dialogs opened from page state (Find leads, Connect accounts, and any other plain-state dialog) put focus on the page body when closed | fixed once in `ui/dialog.tsx`: focus returns to the control that opened it, unless the dialog chose another target |
| 404 | Page not found | Go home | no | none | none needed |

Attention counts and where they go: the sidebar badge sits on Home (its page lists every item); Home "Needs you" and "Needs attention" list the items themselves;
Work's four counts now open the items; Receptionist's stat tiles are buttons that open the matching tab. No count was left without a way to the things it counts.

## Websites (journey I)

| Requirement | Result |
|---|---|
| Dental uses the selected room/R15 flagship | Verified. The dental template on disk carries `FlagshipOpening` and `/img/generated/r15/lantern-room-wide.webp`; `generatePreview` refuses any template without them (`assertPreviewDesign`) and the preview built for a synthetic lead passes the design gate. The template is the 24 Sep build from `muv-demo-dental`'s working tree. |
| Only supported business facts | The preview lists each fact with its source in `PREVIEW.md`. **Defect found and fixed:** a lead with no website but an email in the CRM got that email on the page, labelled "Business's own website" with an empty address. An email now needs a website on file (`fill.ts`; test). A second defect: the legal flagship residue check (`/5550/`, `/0188/`) refused any business whose own phone or name contained those digits or "Rowe" (it blocked the synthetic legal lead); the lead's own verified values are now excluded from the check (`templates.ts`, `generate.ts`; tests), stray flagship text still fails. |
| Preview links work from a remote client: relative and origin-correct URLs | All 20 URLs on a generated dental page returned 200 through the preview server; no `localhost`, `127.0.0.1`, `ts.net` or `vercel.app` is baked into any generated file. **Defect found and fixed:** the motion script was `src="_mu/motion.js"` (relative), which resolves to the wrong place on any nested page such as `/property/x` (the full Aldergate structure has them). It is now `/_mu/motion.js`; previews always live at the root of their own origin (loopback host name, the :8445 preview origin behind the hub, or the deployed domain). The :8445 handler itself is covered by `scripts/lead-sites/remote-preview.test.ts` (cookie scoping, identity, read-only, no hub routes served). |
| Domain and deployment errors name the failed step | **Defects found and fixed in `deploy.ts`:** (1) an error that already named its own failure ("domain lookup returned an invalid response") was prefixed with the last earlier STEP line, blaming a step that had succeeded; now only "`<step>` failed" lines carry that step's own output. (2) After upload, a failed live check printed raw values and always advised "check the domain mapping"; it now says which check failed (no answer, HTTP code, banner missing, noindex missing, different build) in a sentence. (3) A failure while staging the files left the preview stuck on "deploying"; it now ends as failed with "Preparing the files to upload failed: ...". |
| Real estate keeps the full Aldergate structure including listings | **Not satisfied by the committed code; owner work in progress.** The committed overlay and spec still remove listings and keep only the home page, and the committed residue list (`Balmain`, `Imogen Marchetti` ...) **refuses** the new template on disk (built 2 Oct from the owner's uncommitted overlay: `about.html: /Balmain/ ...`), so generating a real-estate preview from this branch fails with a "Refusing to write this preview" error. The owner's uncommitted changes in the main checkout (overlay pages, `data/listings.ts`, `design.ts`, `next-templates.ts` with the new residue and `data-mu-property-experience="v2"` check) fix exactly this. I did not touch those files. Landing them together is the lead's merge step; see R7-F-PROPOSALS.md. |

## Verification run

- `bun test src`: 269 pass, 0 fail.
- Page tests: `scripts/l10-format.test.ts`, `l9-os-continuity.test.tsx`, `os-shell`, `r5-ui`, `r6-ui`, `r6-ui-behaviour`, `l1`/`l1b`/`l3`/`l4` layout, `finance/*`, `workspace/*`,
  `activity-open-job`, `operations-truth`, `p1-polish`, `ui-motion`, `command-scene`, `scripts/lead-sites` (104 tests): all pass.
- New: `scripts/r7-app-usability.test.ts` (runs `scripts/r7-behaviour/behaviour.inner.tsx` in its own process: decision form focus, Escape, failed save keeps the note;
  the open-leads tile text) and pins for the structure changes; `lead-sites` tests for the email, the residue, the motion path, the step blame and the live-check wording.
- `bun run typecheck` and `bun run typecheck:scripts`: clean.
- Dialog focus return and Settings Back were checked in a real browser (the DOM harness cannot run Radix dialogs): Find leads and Connect accounts, Escape, focus on the
  opening button at 1440 and 390; Settings: click Connections, Back lands on the first tab, Forward returns.

## Left alone, with the reason

- Websites' four make/ask tiles and the Home "Packages & economics" link: owner decisions pinned by `l4-layout` and `l9-os-continuity`.
- The shared footer link rows (Studio, Finance, System) repeat the sidebar sub-pages: the 2 Oct audit kept them as the in-page drill-down; unchanged.
- Receptionist tabs and Design's Library tab do not push history: Receptionist is on hold; Design's tabs are in-page state inside a 3,000-line route.
- Chat's storage warning quoting the quiet-copy guard text is produced by `scripts/preview-guard.ts` (not mine) and only appears on a preview copy.
- Reconciliation recommendation 4 (soft-404 and wrong-site checks) is `scripts/j2/**`, a path no round-7 worker owns; not started.

## Evidence kept

`evidence/r7-app/before/` and `after/`: screenshots of the pages that changed (Home, Finances, Goals, Audience, Work, Leads, Finance, System, Activity, Settings, Chat) at 1440
(`-d`) and 390 (`-m`); the other routes were surveyed and found unchanged, so only their numbers are kept (`before/survey-before.json`, `survey-before2.json`, `after/survey-after.json`).
The Audience phone shot in `after/` shows the final state. Raw results of the interaction checks (500 injected on every write):

| Flow | Request answered 500 | Typed text afterwards | Message shown |
|---|---|---|---|
| Memory, Save memory | `POST /__operator/memory` | kept | "Injected failure for the test" (the server's own text) |
| Settings, Save profile | `POST /__operator/profile` | kept | the error plus "Unsaved changes" |
| Goals, add goal | `POST /__operator/business/progress` | kept | the error |
| Work, Save decision | `POST /__operator/workspace/decision` | kept | "Decision wasn't saved" plus the reason |
| Calendar, New event | `POST /__operator/calendar` | kept | the error |

| Dialog (1440 and 390) | After Escape | Focus before | Focus after |
|---|---|---|---|
| Go to | closed | trigger | trigger |
| Type a request | closed | trigger | trigger |
| Find leads | closed | page body | the Find leads button |
| Connect accounts | closed | page body | the Connect accounts button |

## Review fixes (3 Oct 2026, after the independent review of 4171b6ad)

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | The residue check erased every occurrence of the lead's own values, so a flagship word equal to the lead's name or suburb ("Marden", "Leichhardt") passed | Counted, not erased: an own value is allowed only as many times as the template places it (`ownPlacements`: template token counts times the value's count in each token's text); phones and emails are masked wherever they appear | `lead-sites.test.ts` "an own value that IS a residue word..." (stray "Call Marden today", a third "Leichhardt", "Ask Rowe" beside "Rowe Legal" fail; legitimate pages pass) |
| 2 | The Activity message dropped the last letter | One helper, `jobsReadMessage`, strips only full stops | `src/components/activity/read-error.test.ts` |
| 3 | Settings tabs pushed history around the router | `useSettingsTab` reads the hash from the router and moves with `router.navigate` (click pushes, arrow keys replace, the current tab adds nothing, an empty or unknown hash is the first tab) | rendered, memory router: Back, Forward, `canGoBack`, entry count. Real browser sequence: `evidence/r7-app/after/settings-seq-1..6` (open, Connections, Jarvis, Back, Back, Forward; the address and selected tab are in `settings-seq` file names' order) |
| 4 | A deploy timeout stored only "timed out" | "timed out after `<last step>`" (or "before any step reported") | `deployment.test.ts` |
| 5 | The staging error was stored unredacted | `redact()` applied | covered by the same path as the other stored errors |
| 6 | Stripe tile blank when status unknown | "Stripe's connection status isn't known yet, so revenue is unknown, not zero." | `r7-app-usability.test.ts` pin on the finance page |
| 7 | Dialog focus return on a hidden opener | `focusReturnTarget`: connected and visible only; otherwise Radix's own fallback runs | `src/components/ui/dialog-focus.test.ts`; Find leads and Connect accounts re-checked in the browser |
| 8 | Source-grep tests | Work count links, decision-form Escape and focus, Settings history are now rendered tests in `scripts/r7-behaviour/behaviour.inner.tsx` | 8 rendered tests |

## Acceptance baseline findings (H-04, H-06, H-07, H-09, H-10)

| # | Fix | Test and evidence |
|---|---|---|
| H-07 | Every background Vercel call runs with `CI=1` (the installed v59 starts its device sign-in when it has no credentials and CI is unset; read from the CLI's own code, never an auth file) and `--non-interactive`. No login: "Vercel isn't signed in on the hub." and nothing else, shown on Websites in one line. The founder-clicked deploy and take-down shells (`deploy.ts`) get `CI=1` too. `pc-control.ts` is not F's: exact patch in R7-F-PROPOSALS.md | `scripts/websites/vercel-background.test.ts`: a stub `vercel.cmd` on PATH records the environment; with the fix removed the stub logs `LOGIN_ATTEMPTED` and the tests fail |
| H-06 | `LogCall` has an in-flight guard and sends `event` (`<lead>:<uuid>`), kept until the call is logged so a retry after a dropped answer reuses it | rendered: two clicks in one tick send one request with an event key (fails without the guard, fails without the key); a retry reuses the key |
| H-04 | A banner on every page and a sidebar link "Confirm this browser" while `hubSession.pending`; both open `/system#system-devices`, which now opens the closed "Plan usage, devices & runtime" section, opens Devices and people and scrolls to it. System's header has "Pair or confirm a browser" for everyone. Panel copy ("in Profile") is G's: proposal written | browser: banner, link, section open and panel in view at 1280 and 390 (`evidence/r7-app/after/pairing-*.png`) |
| H-09 | An offline banner; an in-app link click while offline opens a page already opened in this tab, and otherwise says "You're offline, and X hasn't been opened in this tab yet, so it can't load". The browser's error page came from TanStack's lazy route reloading the document when its code is missing. The error screen now says "You're offline" or "This page couldn't load" with Go back | browser with the network off (`evidence/r7-app/after/offline-nav.png`); `offline-notice.test.ts` |
| H-10 | A text box that takes focus by itself in the first seconds, before any key or click, is released and Tab restarts from the top, so the first Tab is the skip link. `/setup` and `/hud` now have one | browser, first Tab on `/chat`, `/calendar`, `/setup`, `/hud`, `/work`: "Skip to content" each time |

## Audit 2 fixes (3 Oct 2026, candidate 253eaed5)

Screenshots: `evidence/r7-app/audit-fixes/before/` (the audit's own shots of the candidate) and `after/` (this branch, synthetic hub on 8126) at 1440 and 390, plus the header at 1280 and 1366.

| Audit item | What was done | Test |
|---|---|---|
| B2 | `/system` reads the hash from the router (`useOpenOnHash`), opens the section and tells the panel (which listens for `hashchange`) once it is open. Header link and banner link both work on System itself (browser: section open, panel in view) | rendered: a router navigation opens it, another hash does not |
| B1 UI | Record decision and Reopen are disabled with "Confirm this browser first" while the browser is pending; a 403 is explained and the typed note is kept | rendered: disabled with the reason; 403 message and kept text |
| 1 | The Jarvis chip and search pill never shrink (nowrap), the breadcrumb gives way with an ellipsis, labels move to 1400 px. At 1280 and 1366 with "Receptionist > Packages & economics": search 46 px, chip 81 px | `r7-app-usability.test.ts` (CSS) and the browser measurement |
| 2 | A second link click within 450 ms in the sidebar is ignored (`guardDoubleClick`); double-click Work from Home ends on `/work` | `double-click.test.ts`, browser |
| 8 | One list of sites (the "at a glance" copy is gone). Signed out: one notice, blank deploy times, "Checking Vercel" only while a refresh runs. Plain empty states | `l4-layout`, `r7-app-usability` |
| 9 | Home: the crystal banner is one calm notice only while the profile is unfinished; the Pipeline and Receptionist cards that repeated the Home tiles are gone; no gold "Start:" button repeating the first item. Setup: no landscape video, no vendor logos, no Notion links, gold mark. Command scene and the sources lines no longer print endpoint paths | pins, house-rule test |
| 10 | Workflow steps two across (no mid-word breaks at 1440, 834, 390); "Replay an example call"; no endpoint in the sources line | pin, browser check of every step label |
| 13 | Ctrl+K while offline: a one-line notice, the page stays | rendered boundary test, browser |
| 15 | No sample Slack, Outlook or Skool conversations in the inbox; skills and workspaces show an honest empty state instead of sample data (no "Demo data" badge, no command); Share card sits behind the same Settings switch as Mission Control; the copy button explains a refused clipboard | `l4-layout`, pins |
| 16 | Design: serif title from the shared page-title style, no quote, one gold frame instead of the rainbow, "Workspaces" instead of a second "Studio" | pin |
| 18 | "One approval couldn't be read" with "Left out of the list"; no file path | `work-calm` |
| 3 (minimal) | One line "Receptionist launch is on hold."; the gates tile reads "0 of 5 passed". Nothing else on that page changed | pin |
| House rule | `scripts/r7-house-rule.test.ts`: no route or page component prints a script path, a `bun run` command, an endpoint path in prose or an `MU_` name (Inspector blocks and the Hermes prompt text are the documented exceptions) | itself |

Not done, with reasons: P1 (palette rows), P2 and P3 (leads table and board, wording pinned by R6 tests), P4 ("owner to Google" is pinned by 4 call-queue tests), P5, P8 to P10, P12 to P15 (not required by the lead's list), P11 (`scripts/ai-usage`, not F's). Items 4, 5, 6, 7, 11, 12, 14 are G's and 17 is C's.

## Audit 2 polish (3 Oct 2026, candidate 1c8f18a9)

Screenshots in `evidence/r7-app/audit-fixes/` (`polish-*`). P4 skipped (the call-queue wording is pinned by tests and decided by the owner); P11 is a proposal (R7-F-PROPOSALS.md).

| Item | Done |
|---|---|
| P1 | The palette names where a row acts only for device rows ("Opens in this window" is gone from page rows); "Devices and people" and "Pair a browser" are findable (`pair` finds it, and it opens `/system#system-devices`); no owner id after a device name that already carries it |
| P2 | Leads table: the Source column (which pushed Next follow-up off the edge) moves into the company line's tooltip; no horizontal scroll at 1440; "0 days in stage", "5% likely · A$494.40 weighted" |
| P3 | Board: the stage chips repeating the columns show on phones only; Prospects start open (it is capped at 12); "Today" everywhere; "seen on their site" / "directory signal" instead of bracket tags; activity names capitalised |
| P5 | Pause and Disable are explained in one line under Details (Disable moved there, still a real button); no cron wording on Automations |
| P8 | Embedding and reranking models are never chat choices (picker no longer opens on nomic-embed-text); reply action buttons are at least 24 px |
| P9 | The phone drawer fades at its foot (Studio and System are visibly further down) |
| P10 | The Workspace tab's address is `#workspace` (`#preferences` still works); toggles 44x26; the extra sentence under "Make it your workspace." is gone; the missing space after "Check connections again" is margin. The name field already had its "Your name" label |
| P12 | Router task names (bulk.text, review.source ...) are in a tooltip, the row says "used for N tasks"; provider tables were already closed by default |
| P13 | System's three tiles share the row (no empty fourth column) |
| P14 | The Meeting panel opens under its button, top right |
| P15 | Outside-month day numbers at 60% (were 35%, 2.8:1); with nothing connected the calendar card gives its one instruction as the button |
