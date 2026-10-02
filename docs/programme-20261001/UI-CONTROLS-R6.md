# UI controls inventory, round 6

2 Oct 2026. Builder A (interface), branch `r6/ui-20261002`, base `228bd232`. Every row was checked by clicking the control in a real browser (Google Chrome, Playwright) against a private hub on port 8151 started from this worktree with `bun --bun`, PC role, an isolated data folder on D: (synthetic leads, no keys in its environment, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, a synthetic hunt-status file), outside traffic blocked by the browser. The real `.operator-data` was never read.

## How each row was checked

1. **Click pass.** Each visible control inside the page (and the shell) got a fresh page load, one real click, and a record of what changed: address, panels opened, state toggled, requests sent and their status, console and page errors.
2. **Second pass** for controls that showed no change in pass 1: scrolling, focus movement, control state, file chooser, new tab and downloads were also watched.
3. **Failure injection** for every control that sends a write: the request was answered 500 and the page had to say so and survive.
4. **Scenario checks** for the flows that need typing and recovery (lead editing, drawer, deal and plan selection, call logging, decisions, profile, memory save, Find leads): failed save keeps the typed text, retry works, refresh and a later import keep the data.
5. **Rendering** of every route at 1440 and 390 px in populated, loading, failed and empty states, plus awaiting-action screens, with mechanical checks (one h1, no horizontal overflow, no text under 12 px, no error boundary).

Not clicked, and why: controls that leave the OS (external links are present and checked for their target, not followed), controls disabled by design (for example calls closed), and repeats of one component per row (two copies of each were clicked). Controls that spend money or message people were not clicked: no Generate, no Send, no Deploy, no calls, no paid search; Find leads was exercised only against a mocked answer.

Screens are in `screens/r6-ui/` (`<route>-<d|m>-<state>.png`; `d` = 1440 px at half scale, `m` = 390 px) and `screens/r6-ui/leads/` (1440, 768, 390).

## Totals

| | Count |
|---|---|
| Controls listed (desktop, main content and shell) | 868 |
| Clicked in a browser | 679 |
| Worked as designed | 678 |
| Not clicked, with the reason in the row (repeats of one component, disabled by design, external links, controls that appear only with certain data) | 189 |
| Not confirmed after two passes | 1 (Motion library "Choose a local clip": opens the file chooser only with a clip folder) |
| Defects found (rows and flows, table below) | 14 |
| Fixed, with a failing-first or pinning test where practical | 14 |
| Left broken | 0 |

Phone (390 px): 14 routes were crawled again with the same method (the first 35 controls of each): 317 controls, 229 showed a change or took focus as designed, and the rest were already-selected tabs and options, refresh buttons whose data had not changed, and scroll links (re-checked by hand where it mattered: Calls to make, Browse all, Refresh). Nothing on a phone was found broken. The phone-only controls (menu button, Jarvis slot, More) are in the phone shell table.


## Rendered states (1440 and 390 px)

37 routes (every nav route plus Models, System, Settings, Setup, Websites, Workspaces, Vault, Memory map, Knowledge graph, AI usage, Motion, Transitions, Share, Skills, Skill drafts, Coding) x 2 widths x 4 states = 296 renders, plus 21 Leads renders at 1440, 768 and 390. Every one had exactly one h1, no horizontal overflow, no visible text under 12 px and no error boundary.

| State | How it was produced | Renders | Result |
|---|---|---|---|
| Populated | Isolated hub, synthetic data (leads, decisions, coding jobs) | 74 | all pass |
| Loading | Every operator and workspace read held for 15 s | 74 | all pass (skeletons, "Checking...", no blank page) |
| Failed | Every operator and workspace read answered 500 | 74 | all pass (each panel says "Couldn't read" and keeps its own Retry) |
| Empty | A fresh, empty data folder | 74 | all pass (each page says what is missing and what to do) |
| Awaiting action | Home "Needs you", Work decisions and their open form, Leads drawer and its unsaved editor | 6 | `work-<d|m>-awaiting-decision-form.png`, `leads-<d|m>-awaiting-lead-drawer.png`, `leads-<d|m>-editing-unsaved.png` |

## Defects found by clicking, and what was done

| # | Where | What was wrong | Fix and commit | Test |
|---|---|---|---|---|
| 1 | Models, Check now | Answered 415 "JSON required" every time; the page said "Check failed" | The probe POST now declares JSON (`0dccc8d6`) | `scripts/r6-ui.test.ts` |
| 2 | System, Check again | A failed request changed nothing on screen | Shows "The model check didn't run" and the reason (`2822290e`) | r6-ui |
| 3 | Memory, Vault, Sync now | A refused sync (`{ ok: false }`) was ignored; the button looked dead | The refusal is shown (`6c870ed8`) | r6-ui |
| 4 | Settings, Connections and AI tools: Recheck, Check connections again, Detect tools again | Fired a request, changed nothing visible | Show "checked <time>" and "Checking..." (`a17f1599`) | r6-ui |
| 5 | Lead drawer, Edit lead | Escape, the close button or a click outside discarded typed edits | The form is kept per lead and restored with a notice; Save and Cancel editing clear it (`daa7830b`) | r6-ui |
| 6 | Leads, opening a lead | The address did not change, so Back left the page instead of closing the drawer | `?lead=` is in the address; Back closes the drawer; filters, search text and view stay (`af155440`, merged with Dot's list `d8d9b1df`) | r6-ui, leads-workspace |
| 7 | Lead drawer, Call, Do not contact | One click logged a permanent opt-out that the editor cannot undo | A second, deliberate click (Confirm / Cancel) (`a170d71c`) | r6-ui |
| 8 | Home, Needs you, All decisions | Landed at the top of Work, not on the decisions | Links to the decisions block (`bae578ba`) | r6-ui |
| 9 | Every tabbed page (Receptionist, lead drawer, others) | The tab panel is a tab stop but showed no focus ring (`outline-none`) | Focus-visible ring on the shared TabPanel (`a49c5bf0`) | r6-ui |
| 10 | Operations, Setup | A second `<main>` inside the shell's; Operations drew its title in Inter 42 px, not the page-title face and size | One main; shared title style (`9418cf11`) | r6-ui |
| 11 | Memory map, link slider | No accessible name | `aria-label="Link strength"` (`79559429`) | r6-ui |
| 12 | Finance, What needs you, phone | Text squeezed into a sliver beside its button | Action drops under the text (`554a2c0f`) | r6-ui |
| 13 | Home and Work, Calls to make (after Dot's split) | Linked to the leads list; the calls are on the Today workspace | `?view=today`; Home tile, Work panel and the quick action link there; "1 call due" agrees in number (`e2ae1347`) | r6-ui |
| 14 | Leads rows and drawer | "Website not verified, owner to Google" for verified-none, unknown, failed check and listed sites alike | Four different lines; drawer provenance rows only when recorded; the Offer row that repeated the badge removed (`bdcceceb`, `b158885e`, `4d1e15ca`) | call-queue |

## Scenario checks (typing, failing, recovering)

| Flow | Result |
|---|---|
| Lead edit: fail the save | Typed phone and website stay in the form, "Changes weren't saved" and the server message show; Save again works |
| Lead edit: close, reopen | Straight back into the editor with the typed values and a "restored" notice (after fix 5) |
| Lead edit: save, refresh | New phone and website persist; searching the new phone number finds the lead |
| Lead edit: later directory import | A synthetic import over the same place id left the edited phone, website and their `manual` source untouched |
| Drawer: five tabs | Each tab selects; Call and Deal keep typed text while hidden; focus returns to the opener on close |
| Drawer: Back, Forward, Escape, Close | Back closes and keeps filters and search text; Forward reopens; Escape and Close return to `/leads` |
| Deep link `/leads?lead=2` | Opens that lead; closing returns to `/leads` |
| Call log: fail, retry | Note stays, "Could not save the call" shows; retry logs it and the History tab shows the note |
| Do not contact | First click asks; Cancel backs out; only Confirm posts |
| Deal tab, plan selection | Receptionist offer: drafts disabled until a plan is chosen; choosing Professional saves it (survives refresh), the deal value follows (A$13,188 = 12 x A$1,099), the proposal and the deposit invoice name Professional A$1,099.00/month ex GST with 1,000 minutes, GST 10% (A$109.90, A$1,208.90 for one month), the setup fee "not invoiced; proposed, not approved". Catalogue prices 699 / 1,099 / 1,999 unchanged. The A$1,249.00 + A$124.90 = A$1,373.90 figure is Professional at 1,200 minutes (A$1,099 + 200 x A$0.75), covered by `scripts/price-contract.test.ts` |
| Needs you counts | Sidebar badge, Home header, Home list (3 shown plus "N more in Work") and Work "Decisions" agree (7, then 6 after recording one decision). The badge adds emails and agent approvals and shows "+" when a source is unknown or not connected; Work counts decisions only and says so. Home breakdown reads "6 decisions, emails not connected, 0 agent approvals" |
| Needs you links | Emails to `/inbox`; Agent questions to `/jarvis#agent-questions` (section in view); All decisions to `/work#ws-today` (in view); Calls to make to `/leads?view=today` |
| Record decision: fail, cancel, retry | Note kept when the save fails and after Cancel; retry saves; counts fall by one |
| Settings profile: fail, retry | Name stays, "Profile could not be saved" shows, "Unsaved changes" stays; retry says "Profile saved"; survives refresh |
| Settings, Workspace switches | A failed write shows the server message |
| Memory, Add to memory | Saves ("Saved to Business on this computer"), field clears |
| Account connection controls | Mercury and YouTube Recheck now show "checked <time>"; Stripe "Open Stripe" is an external link; Detect tools again shows its time |
| Empty and unconfigured pages | Computers (no host), Receptionist (Retell not configured), Design (Higgsfield not connected), Finance (no bank import, no Stripe), Skills, Inbox triage: each says what is missing and what to do, with the real warning kept |
| Stale and superseded | Work lists "Some approvals were skipped (1)" with the reason and the file to fix; an expired approval is not counted as waiting |
| Keyboard | Skip link, Tab order, command palette (Ctrl K), phone menu (Escape closes) all work; 12 key routes tab through with a visible focus on every stop after fix 9 |

## Leads, with Dot's package reconciled

Dot's package (`r6/dot-leads-20261002`, `17ddd0a2`) was merged into this branch and reconciled by hand; see the report for the conflict list. Everything below was clicked in a real browser against 36 synthetic leads (accents, three phone formats, five website states), at 1440, 768 and 390 px, reduced motion on. Screens: `screens/r6-ui/leads/`.

| Behaviour | Result |
|---|---|
| Multiword search, any order | "smile blacktown" and "blacktown smile" both give 3 leads |
| Accents and case | "cafe dentaire" and "CAFÉ DENTAIRE" find "Café Dentaire Zoë" (4); "muller" finds "Müller & Partners" (4) |
| Phone formats | "0412 345 678", "0412345678", "+61412345678" and "+61 412 345 678" give the same 12 leads (three stored formats x four copies); "(02) 9555 0101" and "02 9555 0101" give the same 4 |
| Exact ID | "#12" gives only lead 12; "#1" gives only lead 1 (not 10 to 19) |
| Email | "contact5@example.test" gives 1 |
| No match | "nonexistent zzz" gives 0 and the empty state offers Clear filters |
| Website shortcuts | "No website, verified" 7, "Needs website check" 14, "All leads" 36 (the counts match the seeded states) |
| Website lines on the rows | Four different lines: "No website (verified; date not recorded)", "Website not verified . owner to Google" (unknown), "Website not verified . check failed . owner to Google", "Website listed . not yet checked" (a saved address is presence, not verification); previously all read "Website not verified . owner to Google" |
| Grouped filters | Four groups (Business; Website and contact; Pipeline and timing; Sources and details), one control area with the search; Industry plus Website presence narrowed 36 to 12 to 2 |
| Clear chips | Each active filter has "Remove filter: ..." and there is "Clear all" (back to 36) |
| Sorting | Best match, Highest score, Newest first, Business A-Z (Aldergate, Aldergate 2, 3, Blacktown ...), Next follow-up; same order in list, table and board views |
| Ranking | Name matches rank before incidental ones; ties are stable across three reloads (same ten rows each time) |
| Pagination through a refresh | 10 rows, "Show 20 more" gives 30; the Refresh button and a 30 s background poll left 30 rows |
| Drawer Back and Close | Back closes and keeps the search text; Escape and Close return to `/leads`; deep link `?lead=2` opens that lead |
| Edit, save, refresh, import | Edited phone found by search after refresh; a later import over the same place id left phone, website and `manual` sources intact |
| Error recovery | Failed edit save keeps typed phone and website; failed Find keeps area and maximum; both retry |
| Find validation | Submit disabled with no area; maximum 0, 31, 2.5 or empty shows "Choose a whole number from 1 to 30" and disables submit |
| Repeated submit | Three rapid clicks sent one request |
| Close and reopen during a search | The window shows "Searching and checking websites..." again, submit stays disabled, still one request; the result then reads "Added 0 new leads ... 12 source results . 9 already saved . 2 with a listed website skipped . 1 more matching candidate was outside this search limit. Website checks could not complete for 1; these remain unverified." (answered by a mock: no live search was run) |
| Concurrent website checks, locality | Server side; covered by Dot's `discovery-concurrency`, `find-quality` and `lead-search` tests, which pass here. Not exercised live (no provider search was run) |
| Overflow, h1, text size | 1440, 768 and 390: one h1, no horizontal overflow, nothing under 12 px on list, no-results, table, board, drawer, Today and Find dialog |
| Calls to make | Home and Work link to `/leads?view=today`, where the calls are (before, they landed on the list) |
| `bun test scripts/leads` | 490 pass, 0 fail on Windows |

SEO audit prerequisite (Dot's one failure): `runSeoAudit` checks that the Python interpreter exists *before* it takes its one-audit-at-a-time lock. Where `D:\jev-seo\venv\Scripts\python.exe` is absent (Dot's Linux export) the first call died with a config error without holding the lock, so the second call was not refused as busy. On this PC the interpreter and `D:\jev-seo\src` exist, so the test passed here; `JEV_SEO_PYTHON=Z:\missing\python.exe bun test scripts/leads/seo-audit.test.ts` reproduced the failure. Fixed in `328c459b`: `runSeoAudit` takes `python` and `src` options, the test injects an interpreter that exists and waits for the first audit to release the lock, and a second test pins that a missing interpreter is a config error that leaves the lock free. No test was skipped.

## Every control, by page

Each table: what it does, does it work, does it save, what happens on failure, how the user recovers. "Nothing to fail (client side)" means the control only changes what is shown. Mutating controls name the request and the result of answering it with a 500.

### Shell: sidebar, header and Jarvis slot (every page, desktop)

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Skip to content | Link | Opens #op-main-content | Keyboard-only; verified with Tab, Enter, Tab | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Agentic OS, Home | Link | Opens /business | Selected state already active (no change expected) | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Collapse sidebar | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Home6+ | Link | Opens /business | Yes: clicked in a browser at 1440 and through the phone menu at 390 (each lands on the right page with its h1) | No (view only) | Nothing to fail (client side) | - |
| Inbox | Link | Opens /inbox | Yes: clicked in a browser at 1440 and through the phone menu at 390 (each lands on the right page with its h1) | No (view only) | Nothing to fail (client side) | - |
| Inbox triage | Link | Opens /inbox-triage | Yes: clicked in a browser at 1440 and through the phone menu at 390 (each lands on the right page with its h1) | No (view only) | Nothing to fail (client side) | - |
| Calendar | Link | Opens /calendar | Yes: clicked in a browser at 1440 and through the phone menu at 390 (each lands on the right page with its h1) | No (view only) | Nothing to fail (client side) | - |
| Audience | Link | Opens /business?view=audience | Yes: clicked in a browser at 1440 and through the phone menu at 390 (each lands on the right page with its h1) | No (view only) | Nothing to fail (client side) | - |
| Jarvis | Link | Opens /jarvis | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Work | Link | Opens /work | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Memory | Link | Opens /memory | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Finance | Link | Opens /finance | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Studio | Link | Opens /studio | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| System | Link | Opens /system | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Usman, signed in | Link | Opens /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Go to… (open the command palette) | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Talk to Jarvis | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Type a request | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Share screen | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Meeting mode | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 0 active jobs | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| More | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |

### Shell on a phone (390 px): menu button, Jarvis slot, More

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Skip to content | Link | Opens #op-main-content | Keyboard-only; verified with Tab, Enter, Tab | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Open navigation | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Talk to Jarvis | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Type a request | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| 0 active jobs | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| More | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |

### Home

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Command scene | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Packages & economics | Link | Opens /operations | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connect accounts | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Home | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Finances | Tab | Goes to /business?view=finance | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Goals | Tab | Goes to /business?view=progress | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Audience | Tab | Goes to /business?view=audience | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Business currency | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Emails | Link | Opens /inbox | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Agent questions (0) | Link | Opens /jarvis#agent-questions | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| All decisions | Link | Opens /work | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Start: Make the 5 receptionist retest calls | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| 4 more in Work | Link | Opens /work | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| UrgentLead hunt failing since 1 Oct: OpenStreetMap's Overpas | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Refresh | Button | Re-reads its data from the hub; scrolls to the section | Yes | No (view only) | The panel shows "Couldn't read" with its own Retry (failed-state render) | Retry button |
| Open Calls to make | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Retry | Button | Re-reads its data from the hub | Yes | No (view only) | The panel shows "Couldn't read" with its own Retry (failed-state render) | Retry button |
| Open Sites up | Link | Opens /websites | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connect the inbox | Link | Opens /inbox | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Open leads | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Continue your setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Goals | Link | Opens /business?view=progress | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Import a NAB CSV on Finance → Import | Link | Opens /finance | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| ClientsBianca Brown Realty | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Who is running these actions | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Edit | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Plan today | Button | Sends POST /__operator/jarvis/protocol | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Calls to make | Button | Sends POST /__operator/quick-actions/log | Yes | Yes: POST answered 200 | Not exercised (state-dependent); sibling controls show the error | Press it again |
| Morning brief | Button | Sends POST /__operator/quick-actions/log | Yes | Yes: POST answered 200 | Not exercised (state-dependent); sibling controls show the error | Press it again |
| Find phones for new leadsAsks first | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Generate preview for lead…Asks first | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Inbox: anything important? | Button | Sends POST /__operator/quick-actions/log | Yes | Yes: POST answered 200 | Not exercised (state-dependent); sibling controls show the error | Press it again |
| SEO audit for lead…Asks first | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Weekly receptionist report | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Daily review | Button | Sends POST /__operator/quick-actions/log | Yes | Yes: POST answered 200 | Not exercised (state-dependent); sibling controls show the error | Press it again |
| Recent runs | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Business detail | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Weather for Sydney: Checking…. Change city | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Codex or Claude | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Connect | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Open the calendar | Link | Opens /calendar | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connect now | Link | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Choose sources | Link | Opens /settings#connections | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Calendar | Link | Opens /calendar | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| YouTube Add API key | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Instagram Link profile | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| TikTok Link profile | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| LinkedIn Link profile | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Skool Link profile | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connect accounts | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Where these numbers come from | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Business advice | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open prompt input | Button | Changes what is shown on the page | Yes: swaps to the prompt box (inside the collapsed Business advice) | No (view only) | Nothing to fail (client side) | - |
| Select model. Current: Choose model | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Use voice input | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |

### Work

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review the decisions | Link | Opens #ws-today | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Calls & leads | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Websites | Link | Opens /websites | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Assign coding work | Link | Opens /coding | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Refresh Owner approvals | Button | Re-reads its data from the hub | Yes | No (view only) | The panel shows "Couldn't read" with its own Retry (failed-state render) | Retry button |
| Operations | Link | Opens /operations | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Record decision | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Open details | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Show all 7 | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Some approvals were skipped (1)Fix approvals.json | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Calls, pipeline & site status | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Refresh Calls to make | Button | Changes what is shown on the page | Yes: re-reads that source (GET ...?fresh=1); sits inside the collapsed status section | No (view only) | Nothing to fail (client side) | - |
| Leads | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Refresh Leads & pipeline | Button | Changes what is shown on the page | Yes: re-reads that source (GET ...?fresh=1); sits inside the collapsed status section | No (view only) | Nothing to fail (client side) | - |
| Leads | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Refresh Websites | Button | Changes what is shown on the page | Yes: re-reads that source (GET ...?fresh=1); sits inside the collapsed status section | No (view only) | Nothing to fail (client side) | - |
| Websites | Link | Opens /websites | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| 7 answering normallyStatus and speed | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Leads | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Websites | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Goals | Link | Opens /business?view=progress | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Workspaces | Link | Opens /workspaces | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Coding | Link | Opens /coding | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Jarvis

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Describe the task. Include the project or app you want to us | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Send request | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Use voice | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Daily status & shortcuts | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Workflow previews | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| How this is tracked | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| How this is tracked | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Replay a synthetic call | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Chat | Link | Opens /chat | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Hermes | Link | Opens /agents/hermes | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Claude Code | Link | Opens /agents/claude-code | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Automations | Link | Opens /automations | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Activity | Link | Opens /activity | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Computers

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Leads

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Usman | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Mehroz | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Find leads | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Refresh leads | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Your leads | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Today | Button | Goes to /leads?view=today | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| List | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Table | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Board | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| All leads | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| No website, verified 7 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Needs website check 14 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Business, suburb, phone, email or #ID | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Best matchHighest scoreNewest firstBusiness A–ZNext follow-u | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| FiltersNarrow your list | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Café Dentaire Zoë 4 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Blacktown Family Dental 3 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Penrith Property Group 2 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Parramatta Smiles | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Smile Bright Dental 4 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Müller & Partners Conveyancing 3 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Hartley Legal 2 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Aldergate Estate Agents | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Druitt Dental Care 3 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Open Café Dentaire Zoë 3 | Button | Appears only for certain data or sits inside a collapsed section | Yes: opens the drawer at ?lead=<id>; Back, Escape and Close verified (scenario checks) | No (view only) | Nothing to fail (client side) | - |
| Show 20 more | Button | Appears only for certain data or sits inside a collapsed section | Yes: 10 rows to 30; kept through Refresh and a background poll | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Receptionist

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Refresh | Button | Sends POST /__receptionist/dashboard/refresh | Yes | Yes: POST answered 200 | Says so: Refresh failed | Press it again |
| Open go-live | Button | Goes to /receptionist#golive | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Safe to sell?Unknown (Status unknown)0 of 7 met | Button | Goes to /receptionist#golive | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Calls today—Unknown · calls unread | Button | Goes to /receptionist#calls | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Flagged—Unknown · calls unread | Button | Goes to /receptionist#calls | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Go-live gates0/5Passed | Button | Goes to /receptionist#golive | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Goes to /receptionist#overview | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Calls | Tab | Goes to /receptionist#calls | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Go-live5 | Tab | Goes to /receptionist#golive | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Clients | Tab | Goes to /receptionist#clients | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Economics | Tab | Goes to /receptionist#economics | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Health | Tab | Goes to /receptionist#health | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Packages & economics | Link | Opens /operations | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |

### Memory

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Open shared vault | Link | Opens /memory/vault | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Find a memory | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Open prompt input | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Select model. Current: Choose model | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Use voice input | Button | Goes to /chat | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| New memory text or link | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Attach files or photos | Button | Changes what is shown on the page; opens the file chooser | Yes | No (view only) | Nothing to fail (client side) | - |
| Memory destination | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| More memory options | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Save memory | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Saved on this computer | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & visual map | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Image memories | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Saved memories0 items | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Search memory | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Filter source type | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Open trash | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Search this computer | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Saved on this computerWorks with Obsidian | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Finance

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Import a NAB CSV | Link | Opens /business?view=finance#nab-csv-import | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connect Stripe | Link | Opens /business?view=finance | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI usage & spend | Link | Opens /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Open the economics workbench | Link | Opens /operations | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| See the margin numbersMinutes, high-usage case and the metho | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Margins by basis (this month)Usage unknownUsage unknown | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Finances | Link | Opens /business?view=finance | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI usage & spend | Link | Opens /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Operations (Packages and economics)

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Back to Receptionist | Link | Opens /receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Packages & margins | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| NAB ledger | Tab | Goes to /operations?section=nab | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Execution receipts | Tab | Goes to /operations?section=receipts | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Delivery checks | Tab | Goes to /operations?section=delivery | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Booking Receptionist · EssentialBooking Receptionist · Profe | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Pricing recommendation for review | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| 699 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 990 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 400 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 0.8 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 5 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 60 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 60 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 480 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| on | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Low usage | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Base usage | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| High usage | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 128 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 150 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 80 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 0 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 70 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Download draft proposal | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| View draft details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Cost calculation breakdown | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Rates, FX and tax assumptions | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| RBA | Link | Opens https://www.rba.gov.au/statistics/freque outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| 0.7019 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 3 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 2.4 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 0.30 | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Stripe | Link | Opens https://stripe.com/au/pricing outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| GST credits require eligibility. | Link | Opens https://www.ato.gov.au/businesses-and-or outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Opens https://www.retellai.com/pricing outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tie | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tie | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Official source | Link | Opens https://www.twilio.com/en-us/sip-trunkin outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Twilio Elastic SIP origination, AU mobile rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio Elastic SIP origination, AU mobile GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Twilio AU mobile number rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio AU mobile number GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Twilio AU outbound SMS rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio AU outbound SMS GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Twilio Elastic SIP termination to AU mobile (cold-transfer l | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio Elastic SIP termination to AU mobile (cold-transfer l | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Twilio SIP origination continuing after a cold transfer rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio SIP origination continuing after a cold transfer GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Vercel function invocations (webhooks, tool calls, retries,  | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Vercel function invocations (webhooks, tool calls, retries,  | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Vercel Pro base (1 seat) rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Vercel Pro base (1 seat) GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Neon Postgres usage (Launch plan) rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Neon Postgres usage (Launch plan) GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Vercel usage beyond the US$20 credit and extra seats rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Vercel usage beyond the US$20 credit and extra seats GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| AU carrier fees on SMS rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| AU carrier fees on SMS GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Twilio trunk call recording (if switched on) rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Twilio trunk call recording (if switched on) GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Staff alert email rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Staff alert email GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Official source | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Retell concurrency above 20 free slots rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Retell concurrency above 20 free slots GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Other tools and subscriptions allocation rate | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Other tools and subscriptions allocation GST | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| on | Field | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Package scope and approval requirements | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Design

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Create | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Library | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Insights | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Studio | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open connections | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Fullscreen this room | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Use Higgsfield | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Use Kie.ai | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Use OpenRouter | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Use OpenAI | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Use fal | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Use Replicate | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Connections and pricing | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Higgsfield API | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Higgsfield Account | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Choose model. Current model: none | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Connect Higgsfield API to createVerify an API key in Connect | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |

### Settings, Personal profile

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Personal profile | Tab | Goes to /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connections | Tab | Goes to /settings#connections | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI tools | Tab | Goes to /settings#ai-tools | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Workspace | Tab | Goes to /settings#preferences | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Jarvis | Tab | Goes to /settings#jarvis | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Upload profile photo | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| First name | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Share a little about your life. How do you like to work toge | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Your time & preferences USD · Australia/Sydney | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Your timezone | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| USDGBPEURAEDCADAUDINRSGDCHFJPYBRLZAR | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Hourly value slider | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Not set | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Social profiles & website Optional | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Website, LinkedIn… | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| https://… | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Add to profile | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Find links in a saved memory | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Save profile | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Setup

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Agentic OS | Link | Opens /business | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Setup guide | Link | Opens /community-guide.html | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| OS dark mode | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Preferences | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Save & exit | Button | Goes to /business | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| About you | Button | Sends POST /__operator/profile | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Connections | Button | Sends POST /__operator/profile | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Goals | Button | Sends POST /__operator/profile | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| One thing to finish | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Your next milestone | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| The bigger ambition | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Back | Button | Sends POST /__operator/profile | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Build my OS | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |

### Studio

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Make an image or video | Link | Opens /design | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Draft a client proposal | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Open the ledger | Link | Opens /design | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Brand kit & asset records | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| M&U kit | Link | Opens /motion?tab=kit | Link into Leads / Motion; verified by direct navigation (covered by an overlay in the crawl) | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Transition lab | Link | Opens /transitions | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Design | Link | Opens /design | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Motion Library | Link | Opens /motion | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Transition lab | Link | Opens /transitions | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Share card | Link | Opens /share | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### System

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Open Models | Link | Opens /models | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| See the tools | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| AI usage & spend | Link | Opens /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Check again | Button | Sends POST /__operator/models/refresh | Was broken: A failed request changed nothing on screen. Fixed: shows "The model check didn't run" with the reason. | Yes: POST answered 200 | Said nothing before the fix | Press it again |
| 3 more tools need a look | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Plan usage, devices & runtime | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Devices and people | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Models | Link | Opens /models | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Computers | Link | Opens /computers | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Skills | Link | Opens /skills | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Skill drafts | Link | Opens /skill-drafts | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Settings | Link | Opens /settings | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Models

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Check now | Button | Sends POST /__operator/model-router/probe | Was broken: Answered 415 "JSON required" every time; the page said "Check failed". Fixed: the probe POST now declares JSON (0dccc8d6). | Yes: POST answered 415 | Says so: Check failed: Synthetic failure (failure check) Checks read free model li | Press it again |
| All | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Free | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Subscription | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Metered | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Needing attention | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Search model, provider or task | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Open Groq (free plan) | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Cline free models6 models, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Claude Max 20x (subscription)10 models, none used in the las | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| ChatGPT/Codex pool (subscription, 3 accounts)10 models, none | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Hermes agent gatewayGateway only: its models are listed unde | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Google Gemini API (free tier)12 models, none used in the las | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| OpenRouter33 models, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| TypeSafe Jev1 model, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| ElevenLabs3 models, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| On-device models (Ollama / LM Studio)4 models, none used in  | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| DeepSeek direct (prepaid)Gateway only: its models are listed | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Higgsfield (media)1 model, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| OpenAI API11 models, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| kie.ai images1 model, none used in the last 30 days. | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Anthropic API (key, via Hermes)4 models, none used in the la | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| xAI API (key, via Hermes)3 models, none used in the last 30  | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| xAI via X/SuperGrok plan (OAuth, via Hermes)3 models, none u | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| MiniMax API (key, via Hermes)1 model, none used in the last  | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sakana Fugu (via Hermes)2 models, none used in the last 30 d | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Mistral API (key, via Hermes)2 models, none used in the last | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Cohere API (key, via Hermes)1 model, none used in the last 3 | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Websites

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Usman | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Mehroz | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Connect a local site | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Take 4 missing screenshots | Button | Sends POST /__websites/thumbs | Yes | Yes: POST answered 200 | not exercised: locator.click: Timeout 4000ms exceeded. | Press it again |
| Refresh | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Start | Link | Opens #make-site | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Ask Jarvis | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Open the kit | Link | Opens /motion?tab=kit | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| See your skills | Link | Opens /skills | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| bianca.muventures.com.au | Link | Opens https://bianca.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| bianca-preview.muventures.com.au | Link | Opens https://bianca-preview.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Opens https://bianca.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| aldergate.muventures.com.au | Link | Opens https://aldergate.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| aldergate-demo.vercel.app | Link | Opens https://aldergate-demo.vercel.app outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Opens https://aldergate.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| mardenrowe.muventures.com.au | Link | Opens https://mardenrowe.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| muv-flagship-legal.vercel.app | Link | Opens https://muv-flagship-legal.vercel.app outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| muv-demo-dental.vercel.app | Link | Opens https://muv-demo-dental.vercel.app outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| A lead | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| One of our sites | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Just a brief | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Search leads by name or suburb | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Dental | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Legal | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Real estate | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Trades | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Another | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Top-tier set | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Choose skills | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Calm and premium. Same-week appointments front and centre. N | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Create coding draft | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Ask Jarvis instead | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Open Bianca Brown Realty | Link | Opens https://bianca.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| bianca.muventures.com.au | Link | Opens https://bianca.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| bianca-preview.muventures.com.au | Link | Opens https://bianca-preview.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live site | Link | Opens https://bianca.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open Aldergate | Link | Opens https://aldergate.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Open Marden & Rowe | Link | Opens https://mardenrowe.muventures.com.au outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Open Lantern Dental | Link | Opens https://muv-demo-dental.vercel.app outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Open live | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Open Leads | Link | Opens /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| InspirationOther studios' sites in motion, for when a design | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Previous website previews | Button | Changes what is shown on the page | Appears only when there are more previews than fit; absent on a fresh load | No (view only) | Nothing to fail (client side) | - |
| Play website previews | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Next website previews | Button | Changes what is shown on the page | Appears only when there are more previews than fit; absent on a fresh load | No (view only) | Nothing to fail (client side) | - |
| View Apple on Refero | Link | Opens https://styles.refero.design/style/aecac outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Origin Financial on Refero | Link | Opens https://styles.refero.design/style/c60f0 outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Dala on Refero | Link | Opens https://styles.refero.design/style/e5f5f outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View ThoughtLab on Refero | Link | Opens https://styles.refero.design/style/82d52 outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Hyer Aviation on Refero | Link | Opens https://styles.refero.design/style/f61cf outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Superpower on Refero | Link | Opens https://styles.refero.design/style/5d345 outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Ui on Refero | Link | Opens https://styles.refero.design/style/0fd67 outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Duolingo on Refero | Link | Opens https://styles.refero.design/style/7088d outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| View Vivid+Co on Refero | Link | Opens https://styles.refero.design/style/8875b outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Via Refero | Link | Opens https://styles.refero.design/ outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Inbox

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Connect accounts | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Overview | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Gmail | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Slack | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| OOutlook | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Skool | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Question about your inbox | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Ask about your inbox | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| OEmail library0 emails indexed locally | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Calendar

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Connect calendar | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| New event | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Calendar | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Booking links | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Availability | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Import .ics | Button | Changes what is shown on the page; opens the file chooser | Yes | No (view only) | Nothing to fail (client side) | - |
| Month | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Agenda | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Check Codex | Button | Sends POST /__operator/calendar/native/check | Yes | Yes: POST answered ? | not exercised: locator.click: Timeout 4000ms exceeded. | Press it again |
| Today | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Previous month | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Next month | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| 28 September 2026, 0 events | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 29 September 2026, 0 events | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 30 September 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 1 October 2026, 0 events | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 2 October 2026, 0 events | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 3 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 4 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 5 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 6 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 7 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 8 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 9 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 10 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 11 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 12 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 13 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 14 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 15 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 16 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 17 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 18 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 19 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 20 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 21 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 22 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 23 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 24 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 25 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 26 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 27 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 28 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 29 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 30 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 31 October 2026, 0 events | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| 1 November 2026, 0 events | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Prompt | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Select model. Current: gpt-6.1-sol | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Use voice input | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Prepare for my next meeting | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| What does my week look like? | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Check for scheduling clashes | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Automations

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Refresh | Button | Changes what is shown on the page | Yes: GET /__operator/automations | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Run now | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Paused and test copies · 2 | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Resume | Button | Sends POST /__operator/triggers/resume | Yes | Yes: POST answered 200 | not exercised: locator.click: Timeout 4000ms exceeded. | Press it again |
| Disable | Button | Sends POST /__operator/triggers/disable | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Resume | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |
| Disable | Button | Sends POST /__operator/triggers/disable | Yes | Yes: POST answered 200 | Says so: Synthetic failure (failure check) | Press it again |
| Details | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Disable | Button | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |

### Workspaces

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| M&U VenturesThe business itself: the OS, agents, knowledge a | Link | Opens /workspaces/mu-ventures | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| ReceptionistThe AI receptionist: calls, packages, delivery a | Link | Opens /workspaces/receptionist | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| WebsitesM&U's site, client sites, flagships, demos and films | Link | Opens /workspaces/websites | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| How folders are placed | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### AI usage

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Refresh | Button | Sends POST /__ai_usage/refresh | Yes | Yes: POST answered 200 | Says so: Refresh failed | Press it again |
| See the plans | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Edit prices | Button | Goes to /usage#prices | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| See the keys | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| OpenRouterInfoNo OpenRouter key configured— | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| TwilioUnavailableNot linked: Twilio credentials aren't in th | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Claude tokens | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Data freshness | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Edit Prices | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Skills

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|

### Skill drafts

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|

### Activity

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Open AI usage | Link | Opens /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |

### Chat

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Hide conversations | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| General | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| New chat | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Workspace context | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Hermes memory | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Gmail | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Outlook | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Codex memory | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Claude memory | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Personal context | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Granola meetings | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Dock chat | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Close history | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| New chat | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Search conversations | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Plan my day | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Find something in my memory | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Work through an idea | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Prompt | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Select model. Current: gpt-6.1-sol | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Reasoning effort: Medium | Button | Opens a panel or menu | Yes | No (view only) | Nothing to fail (client side) | - |
| Attach files | Button | Changes what is shown on the page; opens the file chooser | Yes | No (view only) | Nothing to fail (client side) | - |
| Use voice input | Button | Appears only for certain data or sits inside a collapsed section | Not re-clicked (moves with data) | No (view only) | Nothing to fail (client side) | - |

### Mission Control (dashboard)

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Today | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 7 days | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 28 days | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| AI spendA$688.06October 2026 so far · fixed + metered, AUD · | Button | Goes to /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Subscriptions | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Tokens · API-equivalent | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| EstimatesAssumed, not measured | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| EstimatesAssumed, not measured | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Leads to call today | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Away mode | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Plan limits & spend | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Trends | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Dream review | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Strategy missions | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Your skills | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Your memory | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Example graph | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Scheduled tasks | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Model intelligence | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |

### Share

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Copy share text | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| How to save as PNG | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |

### Motion

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Describe the idea. Drop in a logo, an image, a video or a li | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Add a file or a link | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| 5 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Auto-enhance | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Open inClaude · Opus 5.5 | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Write prompt | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Styles103 | Tab | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| M&U kit11 | Tab | Goes to /motion?tab=kit | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Scene plan | Tab | Goes to /motion?tab=scenes | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Made in this video12 | Tab | Goes to /motion?tab=made | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Inspiration12 | Tab | Goes to /motion?tab=inspiration | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Search | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| All familiesField Notes · 3Paint & Draw · 13Data & Diagrams  | Choice list | Choice list | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Add Field Notes · Sketch to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Field Notes · Sketch prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Field Notes · Sketch | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Field Notes · Sketch prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Field Notes · Chart to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Field Notes · Chart prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Field Notes · Chart | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Field Notes · Chart prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Field Notes · Mark to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Field Notes · Mark prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Field Notes · Mark | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Field Notes · Mark prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Sumi Ink Bloom to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Sumi Ink Bloom prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Sumi Ink Bloom | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Sumi Ink Bloom prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Charcoal Caliper to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Charcoal Caliper prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Charcoal Caliper | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Charcoal Caliper prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Pixel Lo-fi Rain to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Pixel Lo-fi Rain prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Pixel Lo-fi Rain | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Pixel Lo-fi Rain prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Blueprint Draw-on to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Blueprint Draw-on prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Blueprint Draw-on | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Blueprint Draw-on prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Add Paper-cut Layers to your prompt | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Show the Paper-cut Layers prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Preview Paper-cut Layers | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |
| Copy the Paper-cut Layers prompt | Button | Changes what is shown on the page | Motion Library tile control; sampled (first 45 of 425 controls), same component per tile | No (view only) | Nothing to fail (client side) | - |

### Transitions

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Choose a local clip | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Choose a local clip | Button | Changes what is shown on the page | Hidden or data-dependent when re-clicked | No (view only) | Nothing to fail (client side) | - |

### Memory, Vault

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Sync now | Button | Sends POST /__memory/sync | Was broken: A refused sync ({ ok: false }) was ignored. Fixed: the refusal is shown. | Yes: POST answered 500 | Said nothing before the fix | Press it again |
| Processing logwhat Hindsight did with recent saves | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| One short fact worth keeping… | Field | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Remember | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Save to vault | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| What do we know about… | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Search | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| All | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Vault notes | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Vault facts | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Hindsight memories | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| on | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Sync now | Button | Sends POST /__memory/sync | Was broken: A refused sync ({ ok: false }) was ignored. Fixed: the refusal is shown. | Yes: POST answered 500 | Said nothing before the fix | Press it again |
| Vault | Link | Opens /memory/vault | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Memory map | Link | Opens /memory-map | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Knowledge graph | Link | Opens /codegraph | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |

### Memory map

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Open the vault | Link | Opens /memory/vault | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Hermes | Link | Opens /agents/hermes | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| All | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Obsidian | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Local Claude | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Enter the Brain | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Macro | Button | Changes what is shown on the page; scrolls to the section | Yes | No (view only) | Nothing to fail (client side) | - |
| Mid | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Micro | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Full | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Flow | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Lite | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Full | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Link strength | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Filter recent memory activity | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Search the knowledge base | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| All topics | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| agents5 notes41 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| context2 notes11 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| caching2 notes11 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| tools2 notes2 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| retrieval2 notes2 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Knowledge graph

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Add a projectgraph a repo, no cost | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Full | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Core | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Pause | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| What does this project do? | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| How do I run it? | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Give me a quick tour | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Is anything broken or risky? | Button | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Details | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Hermes | Link | Opens /agents/hermes | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| 1.Design Principles for Codified Slide Generation17 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 2.Components15 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| 3.brand-style.md12 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Show 5 more | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Connect with HermesPaste one prompt into your own Hermes to  | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Connect Hermes to chat with your graphsHermes Agent isn't se | Link | Opens /agents/hermes | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |

### Hermes

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Copy | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Or — preview with sample data | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |

### Claude Code

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Give it a coding job | Link | Opens /coding | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Open Chat | Link | Opens /chat | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Coding agent — interrupted (Claude Max): Review the SMS cons | Link | Opens /coding/24cd0126-5c20-4162-a0b1-e3942a1cda10 | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Coding agent — interrupted (Claude Max): Group receptionist  | Link | Opens /coding/78312413-eb44-46a2-a0b2-32598fb9b103 | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Coding agent — plan ready, waiting to start: Tidy the dashbo | Link | Opens /coding/9e944b5e-2320-48c5-bd9f-61ca2cad8820 | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| All coding jobs | Link | Opens /coding | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Long-term missionsSame missions as Hermes | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### OpenClaw

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| How to pair or reconnect your phone | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| What it is, and what it isn't | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |

### Inbox triage

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|

### Settings, Connections

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Personal profile | Tab | Goes to /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connections | Tab | Changes what is shown on the page | The selected tab: clicking it changes nothing; switching to it verified | No (view only) | Nothing to fail (client side) | - |
| AI tools | Tab | Goes to /settings#ai-tools | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Workspace | Tab | Goes to /settings#preferences | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Jarvis | Tab | Goes to /settings#jarvis | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Money & audience | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Inbox & calendar | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Recheck | Button | Changes what is shown on the page | Was broken: Fired a request, changed nothing visible. Fixed: shows "checked <time>". | No (view only) | Nothing to fail (client side) | - |
| Open Stripe | Link | Opens https://dashboard.stripe.com/apikeys outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| youtube.com/@yourchannel | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Connect & load videos | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Check connections again | Button | Changes what is shown on the page; scrolls to the section | Was broken: Same. Fixed: shows "Checking..." then "Still not connected, checked <time>". | No (view only) | Nothing to fail (client side) | - |
| Add numbers | Link | Opens /business?view=audience&platform=skool&record=1 | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Add numbers | Link | Opens /business?view=audience&platform=linkedin&record=1 | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Add numbers | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Add numbers | Link | Same control as the rows above, one per item | Same component; two copies clicked | No (view only) | Nothing to fail (client side) | - |
| Already connected in Claude or ChatGPT? | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Open Memory | Link | Opens /memory | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Settings, AI tools

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Personal profile | Tab | Goes to /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connections | Tab | Goes to /settings#connections | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI tools | Tab | Changes what is shown on the page | The selected tab: clicking it changes nothing; switching to it verified | No (view only) | Nothing to fail (client side) | - |
| Workspace | Tab | Goes to /settings#preferences | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Jarvis | Tab | Goes to /settings#jarvis | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Detect tools again | Button | Changes what is shown on the page | Was broken: Same. Fixed: the heading line shows "checked <time>". | No (view only) | Nothing to fail (client side) | - |
| See all supported tools | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| Apps through Codex Not checked | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Choose existing connections | Button | Changes what is shown on the page | Shown only once tools are detected | No (view only) | Nothing to fail (client side) | - |
| Check now | Button | Changes what is shown on the page | Shown only once tools are detected | No (view only) | Nothing to fail (client side) | - |
| Open Chat | Link | Opens /chat | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Settings, Workspace

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Personal profile | Tab | Goes to /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connections | Tab | Goes to /settings#connections | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI tools | Tab | Goes to /settings#ai-tools | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Workspace | Tab | Changes what is shown on the page | The selected tab: clicking it changes nothing; switching to it verified | No (view only) | Nothing to fail (client side) | - |
| Jarvis | Tab | Goes to /settings#jarvis | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Mission Control | Button | Sends POST /__operator/settings | Yes | Yes: POST answered 200 | not exercised: locator.click: Timeout 4000ms exceeded. | Press it again |
| OpenClaw | Button | Sends POST /__operator/settings | Yes | Yes: POST answered 200 | not exercised: locator.click: Timeout 4000ms exceeded. | Press it again |
| Mission Control ↗ | Link | Opens /dashboard | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI usage & spend ↗ | Link | Opens /usage | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Skills ↗ | Link | Opens /skills | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Knowledge graph ↗ | Link | Opens /codegraph | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Settings, Jarvis

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Review setup | Link | Opens /setup | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Personal profile | Tab | Goes to /settings#personal-profile | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Connections | Tab | Goes to /settings#connections | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| AI tools | Tab | Goes to /settings#ai-tools | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Workspace | Tab | Goes to /settings#preferences | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Jarvis | Tab | Changes what is shown on the page | The selected tab: clicking it changes nothing; switching to it verified | No (view only) | Nothing to fail (client side) | - |
| At your service, sir. | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Add shorthand | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Add a person | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Save Jarvis settings | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Sources & details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |

### Lead drawer, Overview tab

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Close | Button | Goes to /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Call | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Deal | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Research | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| History | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Prepare call | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Edit lead | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| +61 2 9555 0202 | Link | Opens tel:+61295550202 outside the OS | Link target verified present; not followed (no external traffic) | No (view only) | Nothing to fail (client side) | - |
| Copy phone: +61 2 9555 0202 | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Copy email: contact2@example.test | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |

### Lead drawer, Call tab

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Close | Button | Goes to /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Call | Tab | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Deal | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Research | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| History | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Start call (meeting mode) | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Call script | Button | Sends POST /__operator/leads/generate-script | Yes | Yes: POST answered ? | Not exercised (state-dependent); sibling controls show the error | Press it again |
| No answer | Button | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Voicemail | Button | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Call back | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Interested | Button | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Not interested | Button | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Do not contact | Button | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) (Now a two-step control (confirm). Verified with a mocked POST.) | No (view only) | Nothing to fail (client side) | - |
| (unnamed) | Field | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Note (optional) | Field | Drawer control that re-renders with the lead | Yes: clicked and verified in the scenario checks (call logging, Do not contact, edit, deal) | No (view only) | Nothing to fail (client side) | - |
| Edit contact notes | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| How they like to be contacted | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Save | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |

### Lead drawer, Deal tab

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Close | Button | Goes to /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Call | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Deal | Tab | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| Research | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| History | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Price breakdown | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| From the pitch (Website) | Button | Switches the selected option or section | Yes | No (view only) | Nothing to fail (client side) | - |
| 1500 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 0 | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| 25 (stage) | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| (unnamed) | Field | Text, number or date entry | Yes | Held until the form's Save control | Typed value kept on a failed save (checked on Leads, Work, Settings, Home) | Fix and save again |
| Save deal | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Stage history | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Pipeline details | Disclosure | Shows or hides a section | Yes | No (view only) | Nothing to fail (client side) | - |
| Draft proposal | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |
| Draft deposit invoice | Button | Disabled until its condition is met (for example calls closed) | Disabled as designed (reason shown on the card) | No (view only) | Nothing to fail (client side) | - |

### Lead drawer, Research tab

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Close | Button | Goes to /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Call | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Deal | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Research | Tab | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |
| History | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Generate website | Button | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |

### Lead drawer, History tab

| Control | Kind | What it does | Works | Saves | If it fails | Recovery |
|---|---|---|---|---|---|---|
| Close | Button | Goes to /leads | Yes | No (view only) | Route load only; the page shows its failed state | Back / retry |
| Overview | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Call | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Deal | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| Research | Tab | Changes what is shown on the page | Yes | No (view only) | Nothing to fail (client side) | - |
| History | Tab | Changes what is shown on the page | Selected state already active (no change expected) | No (view only) | Nothing to fail (client side) | - |

## Independent review fixes (2 Oct 2026, after the Opus review)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | Restoring an edit draft sent the old whole form with the fresh version, so a later Save overwrote a call-back, status or the other founder's correction; the changed-since notice was rewritten by an effect | A draft holds only the changed fields, laid over the fresh record; only those fields are sent; the notice is fixed when the editor opens and the base is never rewritten; opening a lead always rereads it | `scripts/r6-behaviour/behaviour.inner.tsx` (render, edit, close, change the record, reopen, save: request is `{lead, phone, version: v2, by}` only), failing against the old code; browser on 8151: typed phone kept, status `call_back` kept, "changed after you started" shown |
| 2 | Short digit runs matched phones ("smith 12", "2770", "12") | Phone digits are searched only for terms of six digits or more | `lead-search.test.ts` (3 failed before) |
| 3 | A double-click armed and confirmed Do not contact | Confirm is a separate button in a separate panel; clicks in the first 500 ms are ignored; focus goes to Cancel | rendered test with real clicks |
| 4 | Tests that only matched source text | Rendered or observed tests: editor draft, two-step confirm, Back closes the drawer / Forward / deep link / `?view=today` (memory router), polling pauses when hidden (react-query in its own process), Models POST headers; footer pinned to the one shipped wording | `scripts/r6-behaviour/` (13 rendered tests, run in their own process by `scripts/r6-ui-behaviour.test.ts`) |
| 5 | Any Hermes JSON counted as a search answer, so a lead could become "verified none" | Hermes no longer counts; a verified absence needs a real engine (SearXNG or DuckDuckGo) to have answered | `discovery-concurrency.test.ts` (returned "none" before) |
| 6 | Overdue filter included closed and do-not-contact leads; search box unbounded; filter options recomputed | Excluded from overdue; `maxLength` 200; memoised | `lead-search.test.ts` |
| extra | `?lead=abc` reached the drawer (the router merges raw parent search) | `useLeadsRoute` re-checks the number | behavioural test |

Display currency: two different settings. The Home chip is this browser's display currency (`claude-os.currency`, default AUD). Settings holds the workspace profile currency, saved on the server; with nothing saved it follows the timezone (Australia, UTC or unknown gives AUD). The "USD" seen in my screenshots came from a profile saved in the synthetic data from an earlier round, not from a wrong default. Saving Settings updates the chip.

Decisions from `approvals.json`: this is the designed local store (a hand-kept, git-tracked list of owner decisions, with answers in `.operator-data/workspace-decisions.json`), not a fixture leaking. The shipped list is M&U's own, so a fresh community install would show those items; that is a packaging question, not a product defect.

## Round 6b

**Creative URL.** `/mu-creative-20261001/` answered 307 to `/mu-creative-20261001`, which is not a route and 404s; the router's trailing-slash rule runs before any static handling, so only `/index.html` worked. `scripts/public-dir-index.ts` (a dev-server middleware ahead of the router) now redirects `/dir` to `/dir/` and serves that directory's `index.html`, for any `public/` directory that has one; APIs, SPA routes and files are untouched (server-level test, `scripts/public-dir-index.test.ts`). Browser at both URLs: the page renders and all nine videos (both films, three heroes, the loop) play from `/mu-creative-20261001/assets/...` with no 4xx. Production: `bun run build` copies the page to `dist/client/mu-creative-20261001/`; static hosting serves directory indexes itself, so this fix is for the dev server (the live hub); I could not exercise a deployed host.

**Concurrent website checks (stubbed).** The per-lead website check has no button; it runs inside Find (four at once) and the re-audit job. I drove it from Find with a local Overpass stub and a local SearXNG stub (`OVERPASS_URLS` accepts loopback http, `MU_SEARXNG_URL`; both unset by default), outside https blocked. Four leads with different delays finished in the opposite order to the list: each landed on its own lead (ids in finishing order), in the list while Find was still running, in the drawer (switched between leads, list re-sorted, Find dialog closed and reopened mid-flight) and after refresh, at 1440 and 390. Defect: a lead found by Find read "Website not verified, owner to Google" whether its search found nothing, failed or could not run; now "Search found no site (date), not yet verified", "Website check couldn't complete" and "Search unavailable, so the website was not checked". Search unavailable was shown with SearXNG pointed at a dead port.

**Real Find (Mount Druitt, dental, max 5).** Free routes only: Overpass and the local SearXNG; Find sends `source: osm`, so no Google Places or paid provider was reachable. Empty area, max 0 and 31 disable submit; three rapid clicks sent one POST; close and reopen mid-flight kept it busy with one POST. Run 1 took 38 s: 3 source results, 2 added (St Clair Dental, with a site found by domain guess, and St Clair Family Dental), 1 with a listed website skipped; both carry source `osm`, the OpenStreetMap attribution and the business's own locality (St Clair NSW 2759). After I corrected St Clair Family Dental's phone and website, run 2 (3 s) added 0, "2 already saved", count still 2, correction and `manual` sources intact. Two real Overpass queries in all. No Overpass failure occurred; with a stub answering 504 the dialog said "Overpass 504: Gateway Timeout (after 3 attempts)" and kept the typed area.

**Round 6b review fixes.** The public-folder middleware now leaves any name that is also an app route to the router (derived from `src/routes`), so `/transitions` loads the app page on refresh; the retired static `public/transitions/index.html` (its route comments say it was replaced) was removed with `git rm`. `Location` is built from the normalised path (always one leading slash); traversal classes (encoded dots, `%5c`, double encoding, drive letters, UNC, `::$DATA`, NUL, sibling `public-evil`) and dot-folders/files are refused. Leads now store an explicit website-check outcome (`found`, `none-verified`, `check-failed`, `search-unavailable`, `not-checked`) written by Find and rescan where the result is known; legacy rows migrate conservatively (a website is `found`, anything else `not-checked`, never `none-verified`); wording and "No website, verified" come only from that field, and the issues pass no longer turns a bare check date into a verified absence.

## Left with a reason

- Controls that leave the OS (33 external links): the link target is present and correct; not followed so no outside traffic happens.
- 18 controls disabled by design (calls closed, no lead selected, nothing to refresh); the reason is on the card.
- Spend and send controls were not clicked at all (Generate website, Capture screenshot, Find phone, SEO audit, Deploy, Start call, Send, paid generation): the owner or a human session must press those. Their disabled and confirm states were read, not their effects.
- Coding page and its controls belong to Builder B; Computers conversation logic to Builder C; polling, lazy loading and bundling to Builder D. The Computers page here was crawled only for its own empty and unconfigured states.
- Home and Work decisions still come from the committed `scripts/workspace/approvals.json` plus the decisions file (known since round 2).
