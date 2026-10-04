# Ownership proposal: Agents workspace (lead) and CRM/Leads (Dot)

Status: **in force (owner decision, 2 Oct 2026).** Each side works on its own files immediately. Shared files follow the rules below; the
**integration owner for shared navigation, the layout shell and release integration is Claude**. Dot proposes CRM navigation changes in the
CRM package; Claude applies them. Contracts between the two areas: `AGENTS-CRM-CONTRACTS.md`.

## Who owns what

| Area | Owner | Files |
|---|---|---|
| CRM / Leads | **Dot** | `src/components/operator/lead-*.tsx`, `src/components/operator/leads-*.tsx`, `src/lib/lead-search.ts`, `scripts/leads/**` (except identity rows below), the Leads widget on the Work page |
| Agents workspace | **Lead (Claude)** | new `src/routes/agents.workspace*.tsx`, `src/components/agents/**`, new `src/lib/agent-*.ts`, `scripts/agents/**` (new), per-bot conversation code in `scripts/jarvis-command/**` and `scripts/conversations.ts`, `src/components/computers/**`, `src/lib/computers-client.ts`, `src/lib/agent-workspace.ts` |

## Shared files and the rule for each

| File | Proposed rule |
|---|---|
| `src/components/shell/destinations.ts` | Lead adds ONE drilldown, "Agents", under the existing **Jarvis** destination (no ninth destination; the 8-label test stays). No other line changes. Dot keeps Leads where it is. |
| `src/routeTree.gen.ts` | Generated. Whoever merges second regenerates it; never hand-edit. |
| `src/routes/__root.tsx`, `src/components/app-sidebar.tsx`, `shell/shell.css`, `operator/sidebar-nav.css` | No changes by the lead. |
| `src/components/ds/*`, `src/components/ui/*`, `src/styles.css`, `src/operator.css`, `docs/DESIGN-SYSTEM.md` | No changes by either side without telling the other first. New primitives the workspace needs live in `src/components/agents/`. |
| Command palette, `src/lib/commands/registry.ts`, `voice-actions.ts` | No edits; they read `destinations.ts` automatically. |
| `scripts/identity/routes.ts`, `docs/IDENTITY-ROUTES.md` | Each side adds only rows for its own new `/__*` mounts, in its own block, with the route test passing. |
| `src/components/shell/pages/work-page.tsx`, `today-page.tsx` | No edits by the lead. |

## How we avoid collisions

- Each side works on its own branch; the lead rebases onto Dot's latest package before touching a shared file.
- A change to a shared file is announced first (file + intent), and is the smallest possible diff.
- Brooke's website and Bianca Brown Realty remain entirely with Dot; the lead does not open them.

## What Dot needs to do

Build against the source baseline package Claude provides (recorded base commit + hashes) and `AGENTS-CRM-CONTRACTS.md`. Name any row
here or contract there that should change in the CRM package's handoff; until then these rules apply.
