# R11 shared UI system (v1)

Owner: UI-CORE (`r11/ui-core-20261004`). UI-PAGES merges this and uses it; it does not edit these files. APIs below are stable from v1: later versions add props or components, never rename or remove.

Import everything from `@/components/ds`. Tokens live in `src/styles.css` (`:root` / `.dark`); the older rules in `docs/DESIGN-SYSTEM.md` still apply.

## Rules (the owner's, condensed)

- **Five-second test.** Each page: one plain headline, one obvious primary action, what needs attention first.
- **Gold is for the one primary action** (`Button variant="accent"`). Everything else is `outline` or `ghost`.
- **Red only for a real failure** (`StatusLabel state="failed"`). Interrupted, unknown, stopped and waiting are not red.
- **No card inside a card.** A list inside a card is a `DataList`/`DataTable` in ONE container, not a card per row inside a card.
- **One status per thing.** Show a record's state once (a `StatusLabel`), not as a chip plus a sentence plus a coloured dot.
- **Technical facts go in `Details`** (Jev decisions, model/route receipts, request ids, config names). Fold them, never delete them.
- **No "what this page does" paragraphs.** The page title and the primary action say it. Empty states say what's missing and give the next step.
- **Respect motion settings.** Decoration stops under reduced motion and the "Still" setting; only real work (a spinner, a filling bar) moves.
- Desktop (1440), tablet (768) and phone (390) must all work with no sideways page scroll.

## Tokens added in v1

| Token | Value | Use |
|---|---|---|
| `--page-max` | 1680px | Content is centred and capped on very wide screens (applied to `main > *`). |
| `--page-gutter` | 1rem / 1.5rem | Phone / md+ side padding (main already uses `p-4 md:p-6`). |
| `--control-h` | 40px | Buttons, inputs, search, segmented controls. |
| `--row-min-h` | 56px | List and table rows. |
| `--drawer-w` | 34rem | `DetailDrawer` default width. |

Type, colour, radius, spacing and motion tokens are unchanged (see the comments in `styles.css`).

## Components

### PageHeader — one primary action

```tsx
<PageHeader
  title="Coding"
  description="Assign work and see what each job is waiting on."   // one line, optional
  actions={<Button variant="outline">Export</Button>}              // quiet, optional
  primaryAction={<Button variant="accent">Assign work</Button>}    // the ONE gold button, always last
/>
```

### Toolbar — search, filter, advanced filters, actions

```tsx
<Toolbar
  search={{ value: q, onChange: setQ, placeholder: "Search leads" }}
  filters={<Segmented ariaLabel="Stage" value={stage} onChange={setStage} options={…} />}
  advanced={<>{/* selects, date range */}</>}
  advancedActive={activeCount}            // shown on the button so a hidden filter is never a surprise
  onClearAdvanced={reset}
  summary={`${rows.length} leads`}
  actions={<Button variant="outline" size="sm">Export</Button>}
/>
```

### DataTable / DataList / DataRow — tables and lists

```tsx
<DataTable
  caption="Coding jobs"
  columns={[
    { key: "title", header: "Job", cell: (j) => j.title },
    { key: "state", header: "Status", cell: (j) => <StatusLabel state={stateOf(j)} size="sm" />, width: "11rem" },
    { key: "repo", header: "Repo", cell: (j) => j.repo, hideBelow: "lg" },
    { key: "age", header: "Updated", cell: (j) => fmtRelative(j.updatedAt), align: "right", width: "8rem" },
  ]}
  rows={jobs}
  rowKey={(j) => j.id}
  onRowClick={(j) => setSelected(j)}       // opens a DetailDrawer; Enter/Space work too
  rowLabel={(j) => `Open ${j.title}`}
  empty={<EmptyState title="No jobs yet" action={<Button variant="accent">Assign work</Button>} />}
/>
```

A real table from 640px up; stacked rows on a phone (first column is the title, the rest become label/value lines; `phone: false` drops a column there).
`DataList` + `DataRow` is the column-less version: title, one meta line, a status on the right, an optional trailing action.

### DetailDrawer — a record's detail

```tsx
<DetailDrawer
  open={!!sel}
  onOpenChange={(o) => !o && setSel(null)}
  title={sel?.title}
  status={<StatusLabel state="pending" label="Waiting for review" />}
  actions={<><Button variant="outline">Retry</Button><Button variant="accent">Approve</Button></>}
>
  …facts…
  <Details items={receipts} />
</DetailDrawer>
```

Right-side sheet (34rem, `size="lg"` 52rem); full width on a phone. Focus trap, Escape and focus return come from Radix.

### Tabs — unchanged

`Tabs` + `TabPanel` (existing): ARIA tablist of rounded pills; more than three tabs become a native select on a phone.

### StatusLabel — the one status vocabulary

| state | word | look |
|---|---|---|
| `draft`, `unsent` | Draft / Not sent | hollow, dashed outline, grey |
| `pending` | Waiting | clock, amber wash |
| `running` | Running | spinner, blue wash |
| `needs-you` | Needs you | hand, amber wash |
| `blocked` | Blocked | triangle, amber wash |
| `sent` | Sent | paper plane, neutral |
| `done` | Done | check, green ink, neutral wash |
| `verified` | Verified | double check, green wash |
| `failed` | Failed | cross, red — the only red |
| `stopped`, `paused`, `unknown`, `idle` | … | quiet grey |

```tsx
<StatusLabel state="verified" label="Done and verified" />   // word override, look stays
<StatusLabel state="failed" size="sm" bare />                 // icon + word, no pill (dense cells)
```

Unsent, pending, failed and verified differ in icon AND colour, so they read correctly in greyscale. The older `Badge`/`StatusDot` stay for existing pages; new work uses `StatusLabel`.

### EmptyState — with a next action

Existing `EmptyState` (`block` or `row`). Always pass `action` when there is something the owner can do; say what's missing in `title`, why in one short `body`.

### Details — expandable technical facts

```tsx
<Details items={[
  { label: "Decided by", value: "Jev (0.93)" },
  { label: "Route", value: "codex:gpt-6-sol", mono: true },
  { label: "Request", value: requestId, mono: true },
]} />
<Details summary="Why Jev chose this">{text}</Details>
```

Folded by default; the panel stays in the DOM (inert while closed). One per card or row, at the end; never nested.

## Shell changes in v1 (affect every page)

- The sidebar no longer repeats "Confirm this browser" (the banner at the top already links to it); the banner is one short line on a phone.
- Top-bar buttons (Type a request, Share screen, Meeting, More) are icons with labels only from 1536px; the page's own primary action wins attention.
- On a top-level page the breadcrumb no longer repeats the h1 beside the sidebar (still read by screen readers).
- Page header spacing is tighter (`mb-8`).

## v1.1 (additive, for UI-PAGES' requests)

- **`ActionBar`** — the shared page toolbar: quiet `outline`/`ghost` buttons first, the one accent action last (`primary`); wraps on a phone. `align="start" | "end" | "between"`, `label` names the group.

  ```tsx
  <PageHeader title="Websites" spacing="tight" />
  <ActionBar label="Website actions" primary={<Button variant="accent">New site</Button>}>
    <Button variant="outline">Import</Button>
  </ActionBar>
  ```
- **`PageHeader spacing`** — `"default"` (mb-8), `"tight"` (mb-4, a Toolbar/ActionBar right under it; no more `-mt-4`), `"none"`.
- **List row + drawer pattern (Leads, CRM)** — `DataList` of `DataRow`s with `onClick={() => setOpen(row.id)}` and the new `selected` prop on the open row (raised, `aria-current`), plus one `DetailDrawer` for the open record. Use `DataTable` + `onRowClick` + `selectedKey` instead when the list has real columns.

  ```tsx
  <DataList label="Leads">
    {leads.map((l) => (
      <DataRow key={l.id} title={l.name} meta={`${l.suburb} · ${l.stage}`} status={<StatusLabel state={stateOf(l)} size="sm" />}
        onClick={() => setOpenId(l.id)} selected={openId === l.id} />
    ))}
  </DataList>
  <DetailDrawer open={!!open} onOpenChange={(o) => !o && setOpenId(null)} title={open?.name} actions={…}>…</DetailDrawer>
  ```

## v2 visual simplification (tokens; inherited by every page)

- **Surfaces (dark):** softer charcoal instead of near-black — page `0.19`, card `0.222`, raised `0.255`, wells `0.168`, sidebar `0.165` (oklch lightness). Hairlines are calmer (`--border` 0.30). All text/surface pairs still pass AA (`scripts/r9-contrast.test.ts`).
- **Buttons: three styles.** `accent` = the one gold primary. `default`, `outline` and `secondary` are now the same quiet secondary (hairline, raised or transparent). `ghost` = ghost. No shadows. Don't introduce another style; `destructive` only inside a confirm dialog.
- **Page header:** compact — title 24–28 px, description 15 px, `mb-6`, actions centred on the title row.
- **Cards:** one hairline, no shadow; widget title icons are plain (no circle).
- **In-page link rows (`DrilldownList`)** show only where the sidebar is a drawer (below `lg`); beside the sidebar they were a second copy of it.
- **Empty states:** one line + one action (`EmptyState` row/block, no dashed boxes).
