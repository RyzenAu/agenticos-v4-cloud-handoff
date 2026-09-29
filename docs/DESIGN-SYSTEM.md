# Agentic OS design system

One visual language for every page: a dark, neutral workspace with **one accent**, plain
sans-serif type at a comfortable reading size, tabular numbers and honest states. The owner's
brief (29 Sep 2026): "nice, easy to read, cool on the eyes, smooth, coherent and circular". Agents (Hermes, OpenClaw, Claude Code,
Codex) appear as small brand marks — never as page themes.

- Tokens: `src/styles.css` (the `@theme inline`, `:root` and `.dark` blocks). This document is
  their prose twin; change one, change the other.
- Primitives: `src/components/ds/` — import from `@/components/ds`.
- Reference pages: `/dashboard` (Mission Control) and `/business`.
- Migrating a page: `docs/DESIGN-MIGRATION.md`.

---

## 1. The language in five rules

1. **Neutral ground, one accent (M&U black and gold, 28 Sep 2026).** Surfaces are M&U black
   (#080808 stepping up to #111 / #181818, warm hue ~85, almost no chroma) with ivory ink (#f3efe6);
   light mode is the ivory editorial variant. The only brand colour is **gold** (`--brand`, #c7a35a;
   a deeper gold on ivory for AA). It marks the active nav item (a thin gold rule), the one primary
   action on a surface, focus, selection and the "normal" state of a meter. Nothing else is gold.
2. **Colour means state.** Green/copper/red/blue are `success`/`warn`/`danger`/`info` — used for
   status, never decoration. No per-card tints, per-provider glows or rainbow headers.
3. **One sans, one mono, one display face.** Fraunces (the M&U display serif) for page titles and the
   wordmark only. Inter for everything you read; JetBrains Mono for code, file paths,
   IDs, model slugs, commands and dense numeric table cells. No other display serifs, no Courier, no
   decorative faces.
4. **Hierarchy from size and weight, not decoration.** One h1 per page (28px on a phone, up to
   36px wide), section titles 20px, body 15px with a 1.6 line height. No kickers/eyebrows above
   headings, no gradient text, no glows.
5. **Honest emptiness.** Missing data shows `—` and a sentence saying why and what to do next.
   Several empty things collapse into one compact row. Never a zero, a fake chart or sample
   numbers standing in for real ones.

---

## 2. Tokens

Use the Tailwind utility (left) or the CSS variable (right). Never a hex value in a component.

### Colour roles

| Role | Utility | Variable | Dark | Use |
|---|---|---|---|---|
| Page | `bg-background` | `--background` | `#080807` | The page itself |
| Inset | `bg-inset` | `--inset` | `#0d0d0b` | Wells inside a card: rows, code, segmented track |
| Card | `bg-card` | `--card` | `#121110` | The one card surface |
| Raised | `bg-surface-raised` | `--surface-raised` | `#191816` | Hover on cards, selected segment, popovers |
| Popover | `bg-popover` | `--popover` | `#191816` | Menus, tooltips, floating panels |
| Text | `text-foreground` | `--foreground` | `#eae6dd` | Body and headings. Softer than full ivory (less glare on black) |
| Secondary text | `text-muted-foreground` | `--muted-foreground` | ≈`#a29e96` | Descriptions, meta, labels. Calm, still AA on every surface (≥ 6.6:1) |
| Border | `border-border` | `--border` | `#2e2b24` | Card edges, dividers |
| Strong border | `border-border-strong` | `--border-strong` | `#3d372c` | Hover edges, dashed empty states |
| Input | `border-input` | `--input` | — | Field boundaries (3:1) |
| **Accent** | `bg-brand` `text-brand` | `--brand` | `#c7a35a` gold | See rule 1 |
| Accent wash | `bg-brand-soft` | `--brand-soft` | `#271e0a` | Active nav row, accent badge |
| On accent | `text-brand-foreground` | `--brand-foreground` | page colour | Text on `bg-brand` |
| Success | `text-success` `bg-success-soft` | `--success(-soft)` | mint `#71d29d` | Live, connected, OK, saved |
| Warn | `text-warn` `bg-warn-soft` | `--warn(-soft)` | soft copper `#e7b280` | Stale, needs attention, 70%+ of a limit |
| Danger | `text-danger` `bg-danger-soft` | `--danger(-soft)` | soft coral `#e79a8f` | A real verdict: failed, disconnected, 90%+ of a limit, urgent |
| Info | `text-info` `bg-info-soft` | `--info(-soft)` | sky `#90bff1` | Neutral notices |

Warn and danger are deliberately low-chroma (29 Sep 2026) so a red line reads as a verdict, not an
alarm; keep red for real verdicts and urgent items, and prefer warn or neutral for everything else.
Light mode (ivory `#f3efe6`, ink `#171512`) uses the same roles with deeper tones for AA.
| Charts | `var(--chart-1…5)` | | accent first | Categorical series, in order |
| Stage | `.ds-stage` | | `oklch(0.13…)` | Dark ground for 3D graphs and media, both themes |

Light theme exists (`html:not(.dark)`) with the same roles; elevation there is white + shadow.
`scripts/contrast-audit.py` checks every reading pair in both themes — run it after any change.

Legacy names still resolve: `--op-*` (operator.css) alias these tokens. New code uses the names
above.

### Elevation, radius, spacing

| Token | Value | Use |
|---|---|---|
| `shadow-sm` / `--elev-1` | subtle | Cards |
| `shadow-md` / `--elev-2` | | Raised overlays |
| `shadow-lg` / `--elev-3` | | Menus, popovers, dialogs |
| `rounded-md` | 8px | Small controls |
| `rounded-lg` | 10px | Buttons, inputs, menu rows |
| `rounded-xl` | 14px | List rows, notices, inner panels |
| `rounded-2xl` | 18px | **Cards** (`Surface`, `StatTile`, `--card-radius`) |
| `rounded-full` | | Badges, pills, segmented controls, dots, avatars, progress rings |

`--radius` is 10px (was 8px); the steps above derive from it.

Spacing is a 4px scale (`--space-1…14`, Tailwind `1…14`). Inside a card: `gap-3`–`gap-5`,
padding `p-5 sm:p-6` (`Surface` `md`; `--card-padding`). Between cards in a grid: `gap-4`–`gap-5`.
Between sections: `mb-14`. Page padding comes from the shell (36px 44px on a laptop, 16px sides on a
phone) — don't add your own outer padding.

### Type

Raised 29 Sep 2026 (owner: "overall it's small and not good on the eyes"): every step went up,
and each carries its own line height (`--text-*--line-height`), so `text-sm` alone gives a
comfortable 15px / 1.6 paragraph.

| Step | Size / line | Weight | Use |
|---|---|---|---|
| `text-3xl` | 40 / 1.1 | 600 | Hero figures only |
| `text-2xl` | 32 / 1.15 | 600, tracking −0.02em | Large headings inside a page; the h1 uses `.ds-page-title` (Fraunces, 28–36px) |
| `text-xl` | 24 / 1.25 | 600 | Stat values, the lead headline inside a hero card |
| `text-lg` | 20 / 1.35 | 600, tracking −0.01em | Section title (h2) |
| `text-base` | 17 / 1.55 | 500–600 | Card titles, lead copy, page descriptions |
| `text-sm` | 15 / 1.6 | 400 | Body (the shell's base size) |
| `text-xs` | 13 / 1.5 | 400–500 | Meta, captions, header controls, buttons in dense UI |
| `.ds-label` / `text-2xs` | 12, caps, 0.12em | 500 | Stat labels, badges and table headers only |

Floor: **12px**, and only for caps labels and badges. Running text never below 13px. Body measure
≤ 70ch. Numbers use `.ds-num` (tabular figures). Fonts: `font-sans` (Inter), `font-mono`
(JetBrains Mono).

Note: `text-sm`, `text-base`, `text-xl`… are overridden to the steps above, so the Tailwind
utility *is* the design-system step. Don't write `text-[13px]` or a `px` font size in CSS: a
hard-coded size doesn't follow the scale, which is why pages written that way still look small.

### Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover, press, colour |
| `--dur-base` | 180ms | Disclosure, tab switch |
| `--dur-slow` | 280ms | Panel enter |
| `--ease-out-quart` | `cubic-bezier(.25,1,.5,1)` | Entrances |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` | State changes |

Nothing loops unless it reports live work (a spinner, a pulsing "live" dot). No ambient video,
drifting auroras, starfields, sheens or shimmer. `prefers-reduced-motion` is honoured globally.

### Focus

One ring everywhere: `--focus-ring` (2px page-colour gap + 2px accent). `.ds-interactive` applies
it plus the standard transitions. The global `:focus-visible` outline is the floor. Never remove a
focus style without replacing it.

---

## 3. Primitives (`@/components/ds`)

| Component | What it is | Do | Don't |
|---|---|---|---|
| `PageHeader` | h1 + description + meta row + actions | One per page; put freshness/status in `meta`, the period/view control in `actions` | Add a kicker above the title; use a hero image |
| `Section` | h2 + optional description/actions + children | Separate sections with space | Wrap every section in a card; number sections 01/02/03 |
| `Surface` | The card: `default` / `inset` / `interactive` / `dashed` | `as="section"`/`"button"` for semantics | Nest a card in a card; add gradients/glows |
| `StatTile` | Label → value → hint (+delta, icon, real trend); rounded-2xl, `p-5 sm:p-6` | `value={null}` for missing data (renders `—`); `onClick` + `active` for expandable tiles | Invent a trend line; colour the value unless it's a state |
| `Sparkline` | Quiet trend in `currentColor` | Real series only | Synthesised curves |
| `Badge` | 24px round state chip (12px text), tones `neutral/accent/success/warn/danger/info` | Sentence case: "Live", "Not connected", "Demo" | Uppercase tracking; decorative colour |
| `StatusDot` | 8px dot + required label | `pulse` only while work is running | Colour-only status |
| `EmptyState` | `block` or compact `row` | Say what's missing, why, and one next step; use `row` when several things are empty | Grids of "No numbers yet" cards |
| `Notice` | Tinted inline message | Stale data, failed sync; name the recovery | Coloured side stripes |
| `KeyValueList` | Label/value rows | `mono` for IDs, paths, timestamps | Two-column cards for three facts |
| `Segmented` | Pill-shaped radio-group control (arrow keys) | Period/view switches, 2–4 options | Uppercase tabs; accent fill for the selected segment |
| `BrandMark` | Agent logo at 14–24px, optional label chip | Page headers, list rows, "written by" lines | Agent colours, fonts or art as page themes |
| `Button` (shadcn) | `accent` · `default` · `outline` · `ghost` · `link`; sizes `xs/sm/default/lg/icon/icon-sm` | **One** `accent` per surface for the primary action; `outline` for secondary; `ghost` for tertiary/close | Custom-styled `<button>`s with ad-hoc colours; uppercase labels |
| `Skeleton` | Loading placeholder | Match the final layout's shape | Spinners for layout-sized loads |
| `VerdictCard` | The page's answer: round tone mark + headline, one-sentence why, neutral fact pills, ring, ONE primary + ≤2 secondary, disclosures | Top of a decision page ("Not safe to sell"); the tone mark is the page's only strong colour | Tinted card backgrounds; side stripes; more than one accent action |
| `ProgressRing` | "N of M" ring, gold arc on a quiet track, count in the centre | Real progress (requirements met, gates passed); `value={null}` shows "—" | Decoration; a ring with no count behind it |
| `Disclosure` | Button row that folds its detail (aria-expanded/controls; closed panel stays in the DOM but `inert`) | Evidence, meta and long lists, collapsed by default; controls go in `aside` | Nesting buttons in the trigger; hiding facts that decide something |
| `ChecklistRow` | Condition row: icon + words + status word (Met / Not met / Unknown / Info) | Requirement lists; "Not met" is a calm open circle | Red pills for every unmet line |
| `AttentionCard` | One item needing the owner: one severity dot + word, one-line summary, meta, actions, folded details | Flagged calls, incidents; danger only for `urgent` | Several coloured tags per item |
| `fmt*` | `fmtCount`, `fmtCompact`, `fmtPercent`, `fmtDate`, `fmtRelative` | Everything non-monetary | `toLocaleString()` without a locale |

Money always goes through `useCurrency()` (`@/lib/currency`).

---

## 4. Page anatomy

```
PageHeader           title · description · meta (status, freshness) · actions (period/view)
  └ key numbers      grid of StatTile (1 col mobile, 3–4 desktop, gap-3)
Section              h2 · actions (link "Open …", Segmented)
  └ content          Surface / list / table / chart
Section …
EmptyState row       everything still unconnected, in one line, with the actions
```

- Lead with what the owner acts on today (brief, next actions, alerts), then numbers, then
  exploration. Empty numbers never come first.
- Grids: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3/4`, `gap-4`. Nothing may scroll horizontally
  at 390px except a deliberate table container (`overflow-x-auto` on the table wrapper only).
- A page is `max-w` of the shell content; don't set page-level backgrounds, textures or images.
- Section links read "Open graph ↗", "All skills ↗" — `text-xs font-medium text-muted-foreground
  hover:text-foreground` with `ArrowUpRight`.

---

## 5. States

| State | Pattern |
|---|---|
| Loading | `Skeleton` in the final shape; text "Loading memory graph…" in `text-xs text-muted-foreground` for canvases |
| Empty (one thing) | `EmptyState` block inside the section |
| Empty (several things) | One `EmptyState variant="row"` listing what's missing, with per-item chips and the one primary action |
| Missing number | `StatTile value={null}` → "—" plus hint ("No bank connected") |
| Stale | `Notice tone="warn"` naming the age and the refresh action |
| Error | `Notice tone="danger"`: what failed + how to recover ("Mercury read failed — Refresh income") |
| Success/confirmation | `Notice tone="success"` or a `Badge tone="success"`; never confetti on routine actions |
| Live | `StatusDot tone="success" pulse` + "Live" — only when the data is actually live |
| Demo / sample | `Badge tone="warn">Demo</Badge>`; sample data only behind `?dev=1` |

Keep the honesty fixes: calendar sync status, lead-hunt failure state, value-metric labels,
OpenClaw's real device status and Hermes' real counts must keep their wording when restyled.

---

## 6. Data and numbers

- Locale **en-AU**: "24 Sept", "1,234", "12.5%". Money via `useCurrency()`; foreign currency is
  named (`USD 1,200`), never assumed to be AUD.
- Tabular figures (`.ds-num`) for every number that can change or be compared.
- Units after the value in `text-xs text-muted-foreground` ("241,817 turns").
- Deltas: arrow + value; green/red only when up/down is unambiguously good/bad, otherwise muted.
- Percentages of a limit: meter in `--brand`, 70%+ `--warn`, 90%+ `--danger`.
- Estimates say so ("AI-estimated", "assumed") next to the number, not in a tooltip only.
- Large counts: exact below 10,000, compact above (`fmtCompact`).
- Time: relative for < 7 days ("3 h ago"), date after.

---

## 7. Copy

- Australian English: organise, colour, realise, licence (noun).
- Sentence case everywhere — headings, buttons, badges, tabs. Caps only via `.ds-label`.
- Controls name the action ("Connect accounts", "Refresh income"), not the object ("Mercury").
- Errors name the problem and the recovery. Empty states name what's missing and the next step.
- No marketing voice inside the app ("Room to grow.", "THINK BIGGER." belong on the website);
  page titles match the sidebar label.
- No invented precision: "—" beats a guess.

---

## 8. Agents as brand marks

Hermes, OpenClaw, Claude Code and Codex keep their logos via `BrandMark`. They do **not** keep:
page-wide colour (teal/cream Hermes, red OpenClaw), fonts (Fraunces, Courier Prime), textures,
illustrations or hero art as backgrounds. An agent page uses the same `PageHeader`, sections,
cards and states as every other page; its identity is the mark beside the title and the words.
Provider logos (Claude, OpenAI, Gemini…) likewise appear only as marks inside neutral tiles.

---

## 9. Shell and workspaces

- **Sidebar:** 256px (232px under 1150px; a 76px icon rail when collapsed). Eight destinations,
  44px rows with 20px icons and 15px labels; the current one has a gold wash and a 3px gold rule;
  its drilldowns open beneath it as 38px rows, the current one marked with a gold dot.
- **Top bar:** 68px (60px on a phone). Pill-shaped 36px controls with labels from `lg`/`xl`: Go
  to… (Ctrl K), the Jarvis chip, Chat, Share screen, Meeting, background jobs and **More**. More
  holds the view toggles as labelled rows (Jarvis HUD, ambient motion, Inspector, dark mode) and
  shows the Inspector's warning count on its button. Anything that reports live state (Jarvis,
  sharing, meeting mode, jobs) stays in the bar itself.
- **Workspaces:** three, M&U Ventures, Receptionist and Websites (`/workspaces`, under Work). Each shows its
  projects; worktrees fold into their repo and never get a card (`scripts/workspace/three-workspaces.ts`).

## Widget grid (L-wave, 29 Sep 2026)

Every page is: one h1, one plain headline sentence (plus tab pills if the page has sections),
then a `WidgetGrid` of equal-height widgets that fills the page frame, then one `PageFoot` line.

- `WidgetGrid`: 4 across ≥1280px, 2 across ≥768px, 1 at phone width (`mobile={2}` for small value
  widgets). Gutters 16px, 24px from `lg`. Rows stretch, so widgets in a row are equal height.
- `Widget`: icon + short title, ONE big value (or one piece of content), one short line, one action.
  `value={null}` shows an honest dash. `badge` is a short state word ("Not connected"), never a sentence.
- `WidgetList` + `WidgetRow`: lists, feeds and queues; span 2 by default (`span` 1–4).
- `PageFoot`: freshness and sources, once, at the page foot. No "Updated just now" chips or (i)
  icons on cards, no progress rings unless the ring IS the information (e.g. 0/5 gates).
- Lead with what the page DOES (Today: what needs you; Inbox: conversations to answer; Leads: calls
  to make; Receptionist: sell or fix; Work: decisions waiting). System health belongs under System.
- L3 helpers (src/components/shell/widgets.tsx): SignalWidget is a Widget that keeps every honest state (Unknown, Couldn't read, Setup required, Stale, Estimate) and never shows a number or success tone it hasn't earned; WidgetDeck / DeckSection are summary widgets whose Open reveals the detail as a full-width panel under their row (grid-flow-dense), remembered per browser and opened by a #id link; MeterBar is the slim limit bar. Use a bar, not a ring, for a limit. A provider error goes in one calm sentence with the next step (i-usage/key-state.ts), the provider's own words in the row's detail.
