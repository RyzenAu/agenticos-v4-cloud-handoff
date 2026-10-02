# UI audit, programme C (1 Oct 2026)

Method: each route rendered by headless Chrome from this worktree (Vite on a spare port, HOME and LOCALAPPDATA pointed at an empty synthetic directory, reduced motion on) at 1440x900 and 390x844. Automated per route: horizontal overflow, text under 13px, h1 count, tab-order focus visibility, inert or unlabeled controls. The app reads some machine-level sources outside the data directory (committed approvals fixtures, local usage logs), so screenshots are committed only for routes that showed no real business or personal content. Screens: `docs/programme-20261001/screens/<route>-<d|m>-<before|after>.png` (leads, coding, jarvis, memory, studio, models, settings, inbox, calendar).

Baseline: no horizontal overflow on any route at 390px; one h1 everywhere; 3 to 120 text nodes under 13px per route (sidebar eyebrow, badge counts, Ctrl K, most of /operations); all tab stops had visible focus except the Memory search field.

## Cross-cutting changes
- Type floor 13px: `--text-2xs` 12 to 13; about 1,500 hard-coded sub-13px sizes in CSS and `text-[Npx]` in TSX moved to the scale; `.ds-label` is sentence case. Tiny letter-spaced capitals (eyebrows, kickers, group labels) removed from 22 stylesheet rules and 21 components. Kept: brand wordmark, motion lab, HUD, canvas labels. Guard: `scripts/ui-type-floor.test.ts`.
- One motion module: `src/lib/ui-motion.ts` plus the "Motion language" block in `styles.css` (tokens `--dur-task`, `--move-sm`, `--move-drawer`, keyframes limited to transform and opacity). Used for navigation (path-keyed page enter, gold drill marker), drawers and dialogs (durations from tokens), save confirmation (`SaveStatus`), task start to complete (`TaskBar`/`TaskWord` on Jarvis hand-offs), reconnect state (`ConnectionState` on coding jobs). Reduced motion zeroes durations; a hidden tab pauses all CSS animation (`html[data-doc-hidden]`). Documented in DESIGN-SYSTEM.md.
- `DeviceStatusSlot` ("This PC", label, "No device reported", Offline or "Status not reported" in words) reading optional fields (`deviceId`/`label`/`isThisPc`/`online`, plus `target*` and `device*` spellings) via `deviceFromRecord`. Wired into the jobs step log and the Command scene hand-offs.
- Needs-you text that names a page ("count them on /receptionist") is now a link (`RouteText`) in decision rows on Home and Work.
- Focus: search boxes that wrap a bare input show the ring on `:focus-within`.
- Phone header: at under 480px the idle Jarvis chip is its bars only and the palette trigger steps aside, so long page names (Receptionist, Mission Control, Websites) no longer collide with the controls.

## Routes
| Route | Main task / primary action | Defects found | Changed |
|---|---|---|---|
| Home (/business) | What needs you; Record decision / Open details | Path mentions inert; needs-you skeleton while checking (honest, transient); 7+ badge means an unreadable source (honest) | Route links, type floor, kicker case |
| Leads | Calls to make; Find leads | Headline zeros with no CRM are a read, not a guess (left) | Type floor, header fit |
| Coding | Start a job; Draft the plan | Live status was a bare dot | `ConnectionState` on the job page |
| Jarvis | Ask or hand off; Send request | Hand-off rows had no progress motion | `TaskBar`/`TaskWord` rows |
| Memory | Find and add memory | Search field had no visible focus | Focus ring on the box |
| Receptionist | Sell or fix; Open go-live | Unknown states already honest | Type floor |
| Finance | Import a NAB CSV; Open Finances | Honest unknowns | Type floor |
| Studio | Make an image or video | "Motion library" duplicated sidebar and a second row; "Make in Design" duplicated the primary | Removed duplicate, relabelled widget action "Open Design" |
| Models | Check now; filter routes | Attention showed 0 beside "Stale" with no calls recorded (unknown shown as zero) | Dash when the probe is over 24h old and nothing is recorded |
| System | Fix tools; Open Models | None new | Type floor |
| Settings | Profile and connections | Disabled Save until edited (fine) | Type floor |
| Inbox | Conversations to answer | "No conversations flagged" with no account connected (unknown as empty) | "Nothing to read yet" with next step |
| Calendar | Today and next up; New event | Today 0, Next 7 days 0 and "Nothing on today" with no calendar (unknown as zero) | Dashes and "No calendar connected" unless a source or imported events exist |
| Work | Decisions; Review the decisions | Decision text paths inert | Route links |
| Other (Websites, Dashboard, Activity, Automations, Skills, Usage, Workspaces, Hermes, Claude Code, OpenClaw, Chat, Design) | n/a | Overflow none; Design and /operations carried the most sub-13px text | Type floor |

## Known remaining
- Hex colours in older route stylesheets (operator.css, business CSS) are not yet all moved to tokens; sizes are.
- `/operations` and `/design` dense tools stay dense at 13px; not redesigned.
- The segmented controls scroll sideways on phones (Inbox, Coding jobs) instead of wrapping.
- Palette button hidden under 480px; reachable via Ctrl K and the navigation drawer.
- DeviceStatusSlot shows real device status only once Agent B's fields arrive; until then it shows the id or "No device reported".
- Coding jobs carry no device field yet, so the slot is absent from the coding job header.

## Round 2: isolated render and data leaks

Hub started with `MU_DATA_DIR=<empty dir on D:>`, `MU_HUB_ROLE=cloud`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, plus HOME/USERPROFILE pointed at an empty folder. Design images, leads and previews now come only from the synthetic data dir (500 fictional leads, 250 fictional previews). Readers that still show real machine data:

| What appeared | Reader | Note |
|---|---|---|
| Owner decisions on Home and Work (receptionist retests, Vercel, a named reply draft) | `scripts/workspace/approvals.json` read at `scripts/workspace/decisions.ts:26`, `scripts/workspace/plugin.ts:98` and `:131` | Repo-committed fixture joined to `root`, not the data dir. Screens replace decision text with "Synthetic decision N". |
| A$341.10 AI spend and plan prices on Finance and Mission Control | `DEFAULT_PRICES` in `scripts/ai-usage/prices.ts:26-30` (the owner's real plan prices, compiled in) | Not usage; a price table. Shown as is. |
| "Owed A$825" on Leads and the CRM overview | `LOCAL_RECEIVABLES` at `scripts/finance/receivables.ts:22`, used by `scripts/leads/deals.ts:568-610` | Compiled-in constant, ignores MU_DATA_DIR. |
| Receptionist demo number in go-live copy | `scripts/receptionist/plugin.ts:44`, `src/lib/receptionist-packages.ts:137`, `src/lib/business-economics.ts:48` | Business line, compiled in. Screens redact it. |
| Claude transcripts and logins, Hermes, key names | `scripts/ai-usage/plugin.ts:53` and `scripts/ai-usage/snapshot.ts:271` (`homedir()`), `scripts/ai-usage/sources.ts:73,132,292,302`; leads also read `homedir()` at `scripts/leads/hunt.ts:69`, `places.ts:74`, `watch.ts:28`, `cli.ts:516` | Bun on Windows ignores `HOME`/`USERPROFILE` for `os.homedir()`, so the real profile was read even with the override. |

Changed: in the cloud role `scripts/ai-usage/plugin.ts` now reads an empty folder under the data dir instead of the home directory, so a VM never reports the owner's PC usage or logins; those are "on your PC". The PC role is untouched. The other readers above are listed, not changed (shared territory).

Screens for Home, Work, Receptionist, Finance, System and Design, plus Computers and Jarvis: `screens/r2-<route>-<d|m>.png`, synthetic data only (decision text masked, phone numbers and the owner name redacted).

### Round 2 changes
- Idle polling cut (see PERF-BASELINE.md). Hidden tabs pause every poll.
- Jarvis page header shows `DeviceStatusSlot` fed by `/__devices/devices` (your paired PC as "This PC", else the primary or first worker, Offline in words, or "No device reported").
- Phone navigation: `Tabs` and `Segmented` with four or more options render a native select under 640px (Inbox, Settings, Receptionist, Coding jobs, Models); the pill row returns from 640px.
- New System page Computers (`/computers`): your paired PCs from the registry and shared agent computers from `/__computers` (typed client; "Not available yet" until that API exists; unknown cost and resource use read "not reported"; Preview, Take control, Return to agent and Stop appear only when the state allows them).
- Receptionist Commercial: a blocked charge reads "Billing blocked — reason: message", and the Setup fees tile says setup fees are not approved yet.
- Ambient motion is held while Jarvis is speaking and while approvals (decision forms, agent questions) are open, on top of the existing reading, editing and dialog holds.

## Round 3 (1 Oct 2026): page audit and the real viewer

Method: hub with a fresh synthetic `MU_DATA_DIR` on D: (6 fictional leads, 9 synthetic coding jobs from `scripts/coding/dev-seed.ts`), cloud role, HOME pointed at an empty folder, Chrome via playwright at 1440 and 390, reduced motion emulated, 18 Tab presses per route. Fifteen pages checked: Home, Work, Leads, Coding, Jarvis, Memory, Receptionist, Finance, Studio, Models, System, Settings, Computers, Inbox, Calendar (Design: type-floor result only, one 12px text node, no screen). Results: no horizontal overflow at 390, one h1 each, body 15px, no text under 13px except that one Design node, "Skip to content" is the first tab stop everywhere.

Still shows real machine data (not removable from the UI, listed so nobody mistakes it for fixtures): Home/Work decisions (committed `scripts/workspace/approvals.json`), the Leads lead-hunt banner, System plan usage and local tools. The committed `r6-*` screens mask decision text, names, the demo number and hunt text; System has no committed screen.

| Finding | Fix |
|---|---|
| Arrival animation (`mo-enter`, drawer, pop) started at opacity 0: a throttled or hidden window left the page dim | Keyframes animate transform only; checked with every animation frozen at t=0 (main opacity 1). Test in `ui-motion.test.tsx` |
| Unfinished text lost on navigating away or reloading (Coding request, Jarvis request, memory note) | `src/lib/use-draft.ts`; cleared after a real send/start; a failed save keeps it |
| Home: the setup video banner sat above Needs you; tiny-caps kicker | Moved below Needs you, sentence case |
| Calendar: four tiles all saying "No calendar connected" plus a banner saying it again; Inbox: four identical "Not connected" tiles | Tiles appear only once a source exists; the banner and the tabs carry the message once |
| Leads: a long hunt-failure paragraph under the notice | "What to do" disclosure |
| Models search (label-wrapped bare input) had no focus ring | One rule: `label:has(> input.outline-none:focus-visible)` |
| Checked and fine: "Record decision" opens the decision form, drafts survive, reduced motion leaves 0 running animations, focus rings on Memory/Settings (border change) | none |

Not done: Design stays dense; the Leads header refresh icon wraps alone on 390; "Open details" on Home decisions is a link, not a dialog.

### Computers page (rebuilt on real desktops)
Each shared computer card now leads with who controls it, what job it is doing and whether the screen is live (chip: connecting, live view-only, live you can act, reconnecting, disconnected), then the actions, then a large live screen (opens by itself when the computer is online with a desktop), with Can/Use under Details. A dropped screen retries 5 times with a growing pause, then offers Reconnect. A stopped computer says so instead of "desktop packages not installed". The list refreshes every 4 s. The frame hides its own header (`?bare=1`) and re-reads the lease on a `refresh` message. Evidence: `COMPUTERS-EVIDENCE.md`, "Round 3". Screens: `screens/r6-computers-live-d.png`, `-m.png`.
