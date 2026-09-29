# AgenticOS UX audit — 27 Sep 2026

Scope: every sidebar section at 1440×900 and 390×844 against the live app (`http://127.0.0.1:8081`,
branch `jarvis-voice`). Read-only browsing: pages were loaded, never clicked — the only control
pressed was "Open navigation" at 390 for `after/nav-drawer-390.webp`. Private content is blurred in
every kept screenshot: inbox, calendar, chat, memory, receptionist and settings text; money, emails,
phone numbers, key fragments and number inputs everywhere; the Business brief's priorities.

- Before: `before/<section>-<width>.webp` (+ `before/metrics.json`: h1/h2, overflow, sub-11px text,
  console errors, page height). `usage-*` and `operations-*` before-shots were re-taken with stronger
  blurring after the sidebar change, so their sidebar already shows the new grouping.
  Mission Control (`dashboard-*`) quotes client names and away-mode commands, so it was re-shot with
  full-text blurring; its before and after files are the same capture (the page itself was not changed).
- After: `after/<section>-<width>.webp` (+ `after/metrics.json`).
- Screenshots are WebP (quality 82), capped at 5,000px tall.

Measure used for "impact": how often the owner is on the page (Business, Leads, Receptionist, Inbox,
Websites, Agents first) × how much the problem slows a decision or hides something.

---

## Ranked findings

| # | Impact | Where | Finding | Status |
|---|---|---|---|---|
| 1 | High | Leads | The List view rendered **every** lead: 962 cards, a **180,875px** page at 1440 (263,923px at 390), re-rendered every second by the page clock. Scrolling and the call queue both suffered. | **Fixed** — pages of 25 with "Show 50 more" and an honest "Showing 25 of 962" line (7,737px). |
| 2 | High | Sidebar (all pages) | 26 items in five groups (Workspace/Sales/Agents/Insights/Tools) that don't match how the owner sorts work. At 900px the nav overflowed: Insights and Tools were below the fold with no cue, and the active page could be off-screen. "THINK BIGGER." tagline and 9px caps "PERSONAL PROFILE" broke the design system's copy and type floor. | **Fixed** — Today (Workspace, Inbox, Calendar, Chat) pinned, then the six buckets + Operations as folding groups with counts; folds remembered; the group holding the current page always opens and the active link is scrolled into view; tagline removed; sentence-case profile caption; Inbox badge caps at 99+. |
| 3 | High | Header (390) | Nine controls in a 390px bar (menu, dot, chat, voice, share, meeting, HUD, jobs, sky toggle) — icons only, crammed, the theme pill eating a quarter of the width. The drawer already mirrors share/meeting/HUD/theme. | **Fixed** — below `md` the header keeps menu, Chat, Voice and jobs; the rest live in the drawer. |
| 4 | High | Business, AI usage | Hydration error on every Business load (`QuickActions` portalled its toast region only on the client), so React threw away and rebuilt the page's tree — a visible flash and wasted work on the home page. | **Fixed** — portal mounts after hydration. Also `/usage` logged invalid nesting (a `Badge` is a `<div>` inside a `<p>`): `Badge` now renders a `<span>`. 0 console errors on Business, Operations, Inbox and AI usage after. |
| 5 | High | Leads | Header broke the page pattern: bare "Leads" h1, then straight into "Call queue"; owner switch/Search/Find leads/refresh floated as a toolbar below the queue; on 390 the refresh icon wrapped onto its own line. "Verified only" / "Show excluded" switches rendered as 40px grey discs (the page's 40px touch-target rule also caught `role=switch`). | **Fixed** — PageHeader with purpose line, "962 open · 0 warm · 1 won" status and the controls as actions (Find leads is the one accent); icon-only Search below `sm`; switches excluded from the touch-target rule. |
| 6 | Medium | Automations | 14 identical rows with two outline buttons each; the one failing job sat sixth; its long "what to do" line pushed its buttons under the text. No at-a-glance status. | **Fixed** — header meta "1 failing · 11 healthy · 2 paused · 14 jobs"; failing then paused then healthy; actions keep their own column; Pause/Resume demoted to ghost; skeleton while loading. |
| 7 | Medium | Inbox, Calendar, Automations | First paint was a lone 15px spinner in an empty page (privacy-mode resolution / job load). | **Fixed** — new `PageSkeleton` primitive (`@/components/ds`) in the page's shape, announced once. |
| 8 | Medium | Inbox | The inbox sits in its own 28px-padded panel: title 28px right of every other page, and 56px of reading width lost at 390. Description was a slogan ("A little more clarity. A lot less switching."). | **Fixed** — dark inbox theme aligns with the shell gutter; the light panel keeps a slimmer 14px frame on mobile; factual one-liner. |
| 9 | Medium | Skills, Knowledge graph, Workspaces, Memory map, local site workspace, graph loaders | 9–10.5px text (36 instances on Skills, 64 on Knowledge graph, 16 on Workspaces). | **Fixed** — raised to the 11px floor in owned files. Remaining: `design.tsx` (98), `home-command.tsx` (36), the 3D graph labels — see follow-ups. |
| 10 | Medium | Memory, Business | Marketing voice inside the app: "Build your AI brain.", "Chat with your memory.", "Your business advisor." | **Fixed** — "Add to memory", "Ask your memory", "Ask your business advisor". Business footer "YOUR BUSINESS WORKSPACE · Built around the way you work." remains (in `business.tsx`, see below). |
| 11 | Low | Motion Library, Claude Code | Motion page h1 "Unlimited motion styles" (gradient text) didn't match its nav label. Claude Code showed "Mission control" then "Mission Control" (section wrapped a panel that has its own heading). | **Fixed** — h1 "Motion Library"; duplicate heading removed. |
| 12 | Medium | Business (390) | "Packages, margins & NAB" renders as borderless floating text above "Connect accounts"; currency select defaults to USD for an AUD business; quick-action tiles are two-up with truncated labels ("Generate preview for lead…"). | Open — `routes/business.tsx` carries another session's edits. |
| 13 | Medium | Hermes | 4,417px (1440) / 11,652px (390) page; JetBrains Mono used for body copy and stat tiles; 34 sub-11px texts at 390; four blocks of skeletons on load; long CLI cheat-sheet and "Take Hermes anywhere" prompts dominate below the fold. | Open — P1 package (`agents.hermes.tsx`, `home-command.tsx`). |
| 14 | Medium | Receptionist | Strongest page structurally (verdict first, gates, calls, follow-ups, commercial). Loading skeleton in shape. Only nit: six status tiles at 1440 wrap to 2-up at 390 with 11px caps labels. | Keep. |
| 15 | Medium | Mission Control (`/dashboard`) | h1 "Good afternoon." (doesn't match the nav label), 9,674px / 17,062px tall, 4 elements overflow at 390, 11–15 sub-11px texts. Behind a settings toggle, so low traffic. | Open. |
| 16 | Medium | Design (390) | 51 console errors, 1,179 buttons, 14,061px tall at 390; 98 sub-11px classes. | Open — P2 package. |
| 17 | Low | Chat | No h1 (the page is the chat host); the send button is a pink→orange gradient and the calendar composer's mic is blue — both off the one-accent rule (`chat-refinements.css`, `ai-chat-input.tsx`). | Open. |
| 18 | Low | Memory (390) | 28 console errors on load at 390; hero art and the 3D cortex push capture below the fold on mobile. | Open. |
| 19 | Low | Activity, Skill drafts, Transition lab | Near-empty pages that only show a header — each should use an `EmptyState` naming what fills it and the next step. | Open. |

No page had document-level horizontal overflow at 390 before or after (`scrollWidth === clientWidth`).
Note the shell's `<main>` has `overflow-x: hidden`, which can mask inner overflow; the capture script
also checked element edges inside `main` (Mission Control and Knowledge graph had inner overflow).

---

## Per section

Order follows the new sidebar.

### Today

**Workspace** (`/workspace`, new, owned by the workspace-hub agent) — morning command centre. Linked
from the brand mark and the top of the sidebar. Not audited (in progress by its owner).

**Inbox** — purpose: triage every channel; primary action: reply to what needs you. Confusing: two
theme controls (OS sky toggle + inbox light/dark toggle); "Your conversations, at a glance." h2 reads
as marketing. Hierarchy: header → email library → provider tabs → overview is good. Spacing: extra
28px panel padding (fixed). States: spinner on first load (fixed → skeleton). Mobile: provider tabs
scroll sideways (deliberate) but the cut-off "O…" gives no scroll cue.

**Calendar** — purpose: schedule and prep; primary: New event (accent — correct). Confusing:
"Refreshing…" button and "Stop syncing" sit side by side with equal weight. Components: composer mic
is blue (info colour as an accent). States: spinner on first load (fixed). Mobile: fine.

**Chat** — full-height chat host, no h1. Send button gradient breaks the one-accent rule.

### Business

**Business** — purpose: today's brief then numbers; primary: work the brief. Confusing: two header
buttons ("Packages, margins & NAB" and a logo-stack "Connect accounts") compete; USD default.
Hierarchy good (quick actions → brief → AI today → connect row → advisor). Components: priority tiles
number themselves 01/02/03 (DS says don't). States: stale-brief warning is exemplary. Errors:
hydration mismatch (fixed). Mobile: header buttons stack awkwardly.

**Leads** — purpose: call queue then pipeline; primary: call / Find leads. Findings 1 and 5 (fixed).
Remaining: each pipeline card spends a full line on "Open lead"; the overview's display-size sentence
("Calling hours are closed: 20 calls…") is heavier than the h1.

**Receptionist** — purpose: is it safe to sell, what needs follow-up; primary: Mark followed up /
Sign off. Best-structured page; keep as the reference for "status first".

**Websites** — purpose: live sites, flagships, previews, drafts; primary: Open live / Review and
deploy. Strong visual page; header meta shows freshness. Minor: two accent buttons per preview card
("Open local preview" + "Open live").

**M&U operations** — purpose: package economics, NAB, receipts, delivery; primary: test a price.
Dense but calm. "Back to Business" link in the header is redundant with the sidebar. Owned by another
agent (`mu-operations.tsx`), not changed.

### Finance

**Finances** (Business → Finances tab) and **AI usage & spend** — usage page is clear: totals →
fixed vs metered → subscriptions with meters → API keys table → prices. Two console errors on load.

### Deen & goals

**Goals & progress** (Business → Progress tab). There is no deen-specific page yet; this bucket is
honest about that by holding only the goals view.

### Research

**Knowledge graph** — 64 sub-11px texts (fixed); two elements overflow at 390. **Memory map** — same
type-floor fix.

### Personal

**Memory** — 3D cortex + capture + photos + chat. Marketing headings fixed. 28 console errors at 390.

### Files

**Workspaces** (16 sub-11px, fixed), **Design** (heavy, see #16), **Motion Library** (#11),
**Transition lab**, **Share card** — low traffic; left as they are apart from the title fix.

### Operations

**Hermes** (#13), **Claude Code** (#11), **OpenClaw** (clean, real device status wording kept),
**Automations** (#6), **Skills** (type floor fixed; manga hero art still P2), **Skill drafts** (#19),
**Mission Control** (#15), **Activity** (#19).

**Settings** — personal context and connections; fine at both widths.

---

## Follow-ups not done here (and why)

- `src/routes/business.tsx` — header button pair, USD default, 01/02/03 numbering, footer slogan.
  The file carries another session's uncommitted edits and is a DS reference page.
- `src/routes/design.tsx`, `src/components/home-command.tsx` — remaining sub-11px text; both are P1/P2
  package files with large bespoke layouts.
- Chat send-button gradient and blue mic → `--brand` (touches the shared prompt used by Hermes too).
- Mission Control h1 and 390 overflow; Memory and Design console errors at 390.
- Empty states for Activity, Skill drafts and Transition lab.
