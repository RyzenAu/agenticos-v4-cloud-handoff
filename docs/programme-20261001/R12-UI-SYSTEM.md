# R12 UI system: page anatomy, departments, status language, hand-off steps

Builds on `R11-UI-SYSTEM.md` (tokens, three button styles, PageHeader, Toolbar, DataTable/DataList, DetailDrawer, StatusLabel, Details, EmptyState); nothing there is renamed or removed. R12 set these patterns on three surfaces (Home, Jarvis, Departments) so they can be applied across the OS next. Import from `@/components/ds` unless noted.

## 1. Page anatomy

Every page, top to bottom:

1. **PageHeader**: the page name, at most one line of description, quiet `actions` (outline/ghost), and ONE `primaryAction` (accent), last. Home: *Ask Jarvis*. Department: *Assign work to <agent>*. Departments index: *Ask Jarvis*.
2. **Optional sub-navigation** right under it (`spacing="tight"`): Tabs for views of one thing (Home / Finances / Goals / Audience), or a row of links for siblings (the department switcher). Never both.
3. **Above the fold: work, not decoration.** At most three sections, each a heading (`text-base`/`text-sm` semibold + a muted count) and ONE list container. Home: *Needs your attention*, *Active work*, *Recent results*. Department: *Needs attention* (only when there is any), *Work queue*, then journeys and *Saved results*; agents and hand-offs in a right-hand aside.
4. **Below the fold**: signals, summaries, quick actions, then folded detail (`Details` / the existing folds). Nothing useful is deleted; it is put in order.

Rules carried from R11 and tightened:
- One status per thing (`StatusLabel`/`WorkStatus`), never a chip plus a sentence plus a dot.
- No card per row: rows live in one hairline list (`WorkList`, `DataList`, `DataTable`).
- A record opens in a `DetailDrawer`, and the open record is **in the URL** (`?task=<id>`) so Back closes it, a link can open it, and navigating away and back keeps context. Drafts already persist through `useDraft`.
- Long names wrap (`[overflow-wrap:anywhere]` on page roots); meta lines clamp to two lines; never a sideways page scroll at 390 px.
- Motion only for feedback: the running spinner, the drawer slide, the More chevron. All stop under reduced motion.

## 2. Status language (one vocabulary for work)

`workStatus(state)` in `src/lib/departments.ts`, rendered by `WorkStatus` (`src/components/departments/parts.tsx`) on top of `StatusLabel`:

| Work state | Word | StatusLabel look |
|---|---|---|
| working / running | Running | spinner, blue |
| queued | Queued | clock, amber |
| needs-you / waiting | Needs you (or the precise word: "Needs your yes", "Decide") | hand, amber |
| failed | Failed | cross, red: the only red |
| finished / completed | Completed (only with a result to show; otherwise "Outcome unknown") | check, green ink |
| stopped | Stopped | grey |
| interrupted / unknown | Interrupted / Outcome unknown | grey circle |

Running, waiting/blocked, failed and completed differ in word, icon and colour, so they read in greyscale. Exceptions on Home use `failed`→"Urgent" only for a real failure, `blocked`→"Check" otherwise.

## 3. Work rows — `WorkList` + `WorkRow`

```tsx
<WorkList label="Active work">
  <WorkRow title={t.title} meta="Research · started 4 min ago" status={<WorkStatus state="working" />}
    to="/departments/$dept" params={{ dept: "research" }} search={{ task: t.id }} />
</WorkList>
```

Title (wraps), one meta line (clamped to two), status on the right, a chevron when the row opens something. Opens with the router (`to`/`params`/`search`), a drawer (`onClick`), or a hub page in a new tab (`href`). Use it for any list of work, decisions or results. Use `DataTable` instead when the rows have real columns (the department work queue).

## 4. Hand-off step — `HandoffStep`

```tsx
<HandoffStep from="Research" to="Design (Designer)" label="make a homepage concept"
  status={{ state: "running", label: "Running" }} basis="Journey step" action={<button>Open task</button>} />
```

Reads as a sentence: **From → To: what was asked**, then the receiving side's state. `basis` says what it rests on when it isn't an explicit record ("Inferred: same client record, the earlier work had finished"). Never a log line, never an id in the main text (ids go in `Details`).

A **journey** (`JourneySteps`) is a list of hand-off steps under the journey's title, "Step 2 of 4: …" and its own state; each step shows its output links, its failure reason or its question. Contract: `R12-DEPARTMENTS-CONTRACT.md`.

## 5. Department layout

```
PageHeader  [name] [one-line purpose]             [Open CRM]  [Assign work to <agent>]
Switcher    All · Sales & CRM · Design & Websites · Engineering · Finance · Research · Operations
┌──────────────────────────────────────────┐ ┌───────────────────────┐
│ Needs attention (needs-you + failed)     │ │ Agents: name, what it │
│ Work queue  1 needs you · 1 running …    │ │ is for, Open          │
│   DataTable: Task | State | Owner | Upd. │ │ conversation          │
│ Journeys this department is part of      │ │ Hand-offs in          │
│ Saved results                            │ │ Hand-offs out         │
└──────────────────────────────────────────┘ └───────────────────────┘
```

Phone: one column in that order (attention, queue, journeys, results, then agents and hand-offs); the switcher scrolls inside its own row. A queue row opens the task drawer: blocker first, owner, times, progress, CRM records by name, the hand-off into it, ids folded; actions *Open job*, and the one accent: *Open result* when there is one, else *Talk to <agent>* (intervene).

Departments are a frontend mapping (`DEPARTMENTS`, `BOT_DEPARTMENT` in `src/lib/departments.ts`); an empty department says what is missing and offers *Open Agents*.

## 6. Jarvis: progress inline

The thread's server entries for one job fold into one **work card** at the place the job started (`groupThread` in `src/components/shell/pages/jarvis-work.tsx`): the hand-off step ("Jarvis → Research: …", or "Research → Design: …" when Design's job continues Research's on the same client record), one state, the real step count from `/__jobs`, *Now: …* while running, the result text and *Open the result*, or the failure / question, then *Stop* while it runs and the updates folded. A journey renders in place of its jobs' cards. The computer pane is unchanged (optional, resizable by drag and keyboard, hidden with one control).

## 7. Navigation

Nine destinations; the sidebar shows Home, Jarvis, **Departments**, Receptionist, Work, Finance, and folds Memory, Studio and System under **More** (the one you are inside always shows in place; the icon rail shows all). Commands and voice reach Departments through the same `DESTINATIONS` table.

## 8. Verify a page

- Seed: `bun scripts/acceptance/r7/hub.ts seed|start --role pc --port 81xx --data D:\AgenticOS-r12-data\<run>` then `bun scripts/r12-ui-seed.ts 81xx <data>`. (`--role pc`, not `server`: a server-role hub serves a loopback browser only with the local-owner secret, which a screenshot browser must not be handed. Hindsight, memory writes and triggers are off either way.)
- Screenshots: `bun scripts/r12-ui-shots.ts <before|after> 81xx` (1440×900 and 390×844, dark, reduced motion).
- Interactions: `bun scripts/r12-ui-verify.ts 81xx` (send on Jarvis, computer pane open/resize/hide, department + drawer by keyboard, visible focus, long names at 390).
