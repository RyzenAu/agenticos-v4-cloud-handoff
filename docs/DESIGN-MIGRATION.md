# Migrating a page to the design system

Read `docs/DESIGN-SYSTEM.md` first. `/dashboard` and `/business` are the reference migrations —
copy their patterns rather than inventing new ones.

## The checklist (a page is done when every box is true)

**Structure**
- [ ] Starts with `PageHeader` (one h1, sentence case, matches the sidebar label). No kicker,
      hero banner, illustration or background art above it.
- [ ] Sections use `Section` (or the same h2 recipe: `text-lg font-semibold`), separated by `mb-12`.
- [ ] Leads with what the owner acts on; empty or unconnected things come last.
- [ ] No card inside a card. Wells inside a card use `bg-inset`, not another bordered card.

**Colour**
- [ ] No hex/rgb/hsl literals in the page's TSX or CSS except inside `BrandMark`-style logos.
      Every colour is a token utility (`bg-card`, `text-muted-foreground`…) or `var(--token)`.
- [ ] The accent (`brand`) appears only on: the primary action, active/selected state, focus,
      meters in their normal range.
- [ ] Semantic colours only mean state (success/warn/danger/info), each paired with a text label.
- [ ] No gradients, glows (`blur-3xl` halos, coloured `box-shadow`, `text-shadow`), textures,
      starfields, grain, ambient video or per-card tints. The only exception is `.ds-stage`
      behind WebGL/media.
- [ ] Agent and provider identity appears only as a `BrandMark`/logo. No agent-themed palettes.

**Type**
- [ ] Only Inter (`font-sans`) and JetBrains Mono (`font-mono`, for code/IDs/paths/slugs).
      No Fraunces, Courier Prime, Archivo Black, Bebas etc. in app chrome.
- [ ] Nothing below 11px; 11px only for `.ds-label` caps labels and badges; running text ≥ 12px.
- [ ] No `uppercase tracking-[0.2em]` labels outside `.ds-label`; buttons, tabs and badges are
      sentence case.
- [ ] Numbers use `.ds-num` (tabular). Non-money numbers use `fmt*`; money uses `useCurrency()`.

**Components**
- [ ] Buttons are the shadcn `Button` (`accent` once per surface, then `outline`/`ghost`).
- [ ] Status chips are `Badge`/`StatusDot`; KPIs are `StatTile`; tabs/periods are `Segmented`
      (or an ARIA tablist styled like it, as `/business` does).
- [ ] Empty → `EmptyState` (several empties → one `row`); stale/error → `Notice`;
      loading → `Skeleton` in the final shape.

**Behaviour (must not change)**
- [ ] Data wiring, queries, handlers, routes, `aria-*`, keyboard handling and copy that states a
      fact are untouched. Visual/structural changes only.
- [ ] Honesty fixes keep their wording: calendar sync status, lead-hunt failure state,
      value-metric labels, OpenClaw real device status, Hermes real counts.

**Verification**
- [ ] 1440×900 and 390×844: zero console errors, zero hydration warnings, no horizontal overflow
      (`document.documentElement.scrollWidth === clientWidth`).
- [ ] Keyboard: every control reachable, visible focus ring.
- [ ] `bun test scripts` green, `npx tsc --noEmit -p .` introduces no new errors,
      `python scripts/contrast-audit.py` passes if tokens were touched.
- [ ] Before/after screenshots attached to the PR/commit description.
- [ ] Never click consequential controls while verifying (send, connect, generate, delete,
      pair, trigger) — the app is connected to real accounts.

## Ownership (to avoid merge conflicts)

**Frozen — design-system lead only.** Packages must not edit these; if a package needs a token or
primitive change, note it in the package's commit message and the lead lands it.

- `src/styles.css` — except package **P1**, which deletes the named legacy blocks listed below.
- `src/operator.css` above the `.op-page {` rule (token aliases, shell, sidebar, header). Package
  **P3** owns the rest of the file.
- `src/routes/__root.tsx` — except P1 removes the Fraunces/Courier Prime font link.
- `src/components/app-sidebar.tsx`, `src/components/ds/*`, `src/components/ui/*`
- Reference pages: `src/routes/dashboard.tsx`, `src/routes/business.tsx`, `src/routes/business.css`,
  `src/components/business/*`, `src/components/usage-panel.tsx`, `src/components/trends-panel.tsx`,
  `src/components/model-intelligence.tsx`, `src/components/editable-price.tsx`,
  `src/components/operator/business-composer.tsx`
- Shared WebGL: `src/components/memory-graph-3d.tsx`, `src/components/graphify-graph-3d.tsx`,
  `src/components/brain-graph-3d.tsx` (they sit on `.ds-stage`; leave their internals alone).
- `src/components/operator/brand-refinements.css`, `sidebar-profile.css`, `accounts-hub.*`,
  `screen-share-control.tsx` (mounted by the shell).

A file listed under one package is edited by that package only. Read-only use of another
package's file (importing it) is fine.

## The three remaining packages

### P1 — Agents (Hermes, OpenClaw, Claude Code)

Biggest single change: remove the classical Hermes world (teal/cream, Fraunces, Courier Prime,
paper grain, Pantheon art), the red "lobster" OpenClaw wordmark hero and the comic-book Claude
Code hero. Each agent page becomes `PageHeader` with a `BrandMark` beside the title, then
sections. Keep Hermes' real counts and OpenClaw's real device status wording.

Files:
- `src/routes/agents.hermes.tsx`, `src/routes/agents.openclaw.tsx`, `src/routes/agents.claude-code.tsx`
- `src/components/hermes-mission-control.tsx`, `hermes-documents-gallery.tsx`, `hermes-mind-3d.tsx`,
  `hermes-mnemosyne.tsx`, `hermes-status-pill.tsx`, `home-command.tsx`, `intelligence-portal.tsx`,
  `model-logos.tsx` (P2 imports it read-only)
- `scripts/check-contrast.mjs` (its cream-on-teal constants follow `home-command.tsx`)
- In `src/styles.css`, delete only these legacy blocks once nothing references them:
  `.hermes-skin*`, `@keyframes hermes-marquee`, `.pantheon-glitch`, `kg-*` (aurora/statue/
  constellation/twinkle), `ministry-*`, `.hc-*`.
- In `src/routes/__root.tsx`, remove the Fraunces/Courier Prime stylesheet link (last user).
- Assets that become unused: `src/assets/hermes-art/*`, `src/assets/openclaw.png` (keep the files
  unless the owner approves deletion).

### P2 — Insights and tools

Skills (manga hero art), Share, Activity, Workspaces, Knowledge graph, Memory map, Transition
lab, Design and Website. Replace heroes with `PageHeader`; stat rows with `StatTile`; category
filters with `Segmented`/`Badge`; replace the legacy `page-header.tsx`/`stat-card.tsx`/
`status-pill.tsx` with the ds primitives and delete them when unused. Also fix the pre-existing
type error at `codegraph.tsx:236` (`Project.path`).

Files:
- `src/routes/skills.tsx`, `share.tsx`, `activity.tsx`, `workspaces.index.tsx`,
  `workspaces.$id.tsx`, `codegraph.tsx`, `memory-map.tsx`, `transitions.tsx`, `design.tsx`,
  `websites.tsx`
- `src/components/page-header.tsx`, `stat-card.tsx`, `status-pill.tsx`, `memory-brain.tsx`,
  `knowledge-explorer.tsx`, `memory-graph-loader.tsx`, `design-brands.tsx`, `stage-cosmos.tsx`,
  `stage-aurora.tsx`
- `src/components/operator/higgsfield-account.tsx`, `refero-previews.tsx`, `refero-showcase.css`
- `src/lib/workspace-covers.ts` (cover art → neutral placeholders or real project thumbnails)
- Read-only: `agents.hermes.tsx` (codegraph imports from it), `model-logos.tsx`,
  `memory-graph-3d.tsx`, `graphify-graph-3d.tsx`.

Note `design.tsx` owns its render-tile animation (`design-*` keyframes in styles.css); keep the
generation tile but restyle the surrounding page. Ask the lead before removing those keyframes.

### P3 — Workspace (daily-use pages and the assistant)

Inbox, Calendar, Memory, Settings, Setup, Chat/floating oracle, Leads, Automations and the HUD.
Most of these already sit on `--op-*` (now DS tokens), so the work is mostly type floor, badges,
buttons, empty states and removing the remaining one-off palettes (inbox "white" mode, memory
atmospheres, voice visuals). Keep calendar sync status and lead-hunt failure wording exactly.
`setup.tsx` imports `Home` from `dashboard.tsx` — read-only.

Files:
- `src/routes/inbox.tsx`, `calendar.tsx`, `memory.tsx`, `settings.tsx`, `setup.tsx`, `chat.tsx`,
  `leads.tsx`, `automations.tsx`, `hud.tsx`
- `src/components/floating-oracle.tsx`, `chat-md.tsx`, `brain-converse.tsx`,
  `memory-constellation.tsx`, `memory-graph-mini.tsx`, `oracle-*.tsx`, `agent-core-3d.tsx`,
  `dream-replay.tsx`, `context-breakdown.tsx`, `currency-picker.tsx`, `operator-jobs.tsx`,
  `theme-toggle.tsx`, `version-pill.tsx`
- `src/components/operator/*` **except** the frozen shell files above and P2's
  `higgsfield-account.tsx`, `refero-*`
- `src/operator.css` from the `.op-page {` rule to the end (page rules for inbox, memory, chat,
  settings…)

## Lead follow-ups (not in any package)

- Business onboarding (`business-setup.tsx`, `operator/setup-welcome.tsx`) still uses the
  ambient portal video and a caps eyebrow — restyle when onboarding is next touched.
- `operator.css` still carries page rules that packages will orphan; the lead removes dead
  selectors after P1–P3 land.
- Pre-existing `tsc` errors outside the design work: `vite.config.ts:5331/5342`
  (`child.stdout/stderr` possibly null).

## Suggested order inside each package

1. Replace the page top with `PageHeader`; delete hero art/backgrounds.
2. Swap themed containers for `Surface`/`Section`; remove gradients and glows.
3. Swap chips/buttons/tabs/KPIs for `Badge`/`Button`/`Segmented`/`StatTile`.
4. Rewrite empty/loading/error states with `EmptyState`/`Skeleton`/`Notice`.
5. Sweep type sizes (≥ 11px) and uppercase labels; remove font-family overrides.
6. Verify (checklist above), screenshot, commit only your package's files.
