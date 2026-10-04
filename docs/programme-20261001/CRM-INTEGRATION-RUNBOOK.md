# CRM integration runbook (Claude integrates Dot's CRM package)

Owner: Claude (integration owner). Source of truth for ownership/contracts: `AGENTS-WORKSPACE-OWNERSHIP.md`, `AGENTS-CRM-CONTRACTS.md`.
Receptionist on hold; Brooke/Bianca excluded. Unavailable live-provider checks stay explicitly UNVERIFIED — never activate a provider to pass a test.

## 1. Intake (when the PR/package arrives)

1. Base must be handoff commit `e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa` in `RyzenAu/agenticos-v4-cloud-handoff` (`git merge-base --is-ancestor e9ad7c2 <pr-head>`). Anything else: stop and ask Dot to rebase.
2. Diff = `e9ad7c2..<pr-head>`. Map it back onto our source: the handoff tree equals `ryzen/migration-20261002` @ `317c5e6a` (code) plus `HANDOFF-PACKAGE/` and the packager's two release files. Produce the CRM delta as a patch (`git diff e9ad7c2 <pr-head> -- . ':!HANDOFF-PACKAGE' ':!RELEASE-MANIFEST.json' ':!RELEASE_SHA'`) and apply it with `git apply --3way` on a NEW branch `crm/integration-<date>` from the then-current migration/workspace branch — never copy Dot's snapshot over our tree, never touch the canonical checkout's 35 uncommitted owner files.
3. Ownership check: every changed path is Dot-owned (CRM/Leads, `scripts/crm/**`, `scripts/leads/**`, lead/CRM components, `src/lib/crm-*.ts`) or listed as a proposed shared change. Shared-file changes (navigation, shell, ds/ui, tokens, identity rows) are applied by Claude after review, smallest diff.
4. Contracts check: `crm-ref.ts`, `crm-links.ts`, `crm.activity.add` (idempotent `eventId`), typed ops registry `scripts/crm/ops.ts`, `crm` events topic, job `subjects` — against what B1 built for the Agents side.

## 2. Review

Independent reviewer (fresh, not the builder): migrations (idempotent, versioned, dry-run, rollback), duplicate-event handling, identity (server role: writes = confirmed founder session; outward actions = B2 approval; `by` from the principal), Places/OSM source-storage rules, no new scheduler/job engine/ledger, GST/AUD, opt-out preservation, no outreach.

## 3. Migration rehearsal on Ryzen (isolated, inert)

`deploy/windows/crm-rehearsal.ps1` (below) creates an isolated instance from the latest verified nightly backup:
port 8084, data `C:\mu-hub\data\crm-rehearsal`, own HOME, `AGENTIC_OS_NO_BACKGROUND=1`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`,
`MU_TRIGGERS=off`, no Hermes, no Serve port (loopback only; browser checks via an SSH tunnel or a temporary tailnet-only port that is
removed afterwards). The production hub is never touched. Checks: dry-run report; apply; counts before/after; relationships; manual-edit
preservation; opt-outs; website-check states; re-run = no-op (repeatability); duplicate events = one record; rollback restores the exact
pre-migration counts (restore the backup into a fresh folder and compare manifests).

## 4. Checks Dot cannot run

Rendered UI (Playwright + browser pane at 1440/834/390): search, editing, multiple contacts/deals, pipeline board/table, follow-ups,
documents, delivery, CSV import preview/conflicts, error recovery, keyboard. Broad provider tests: run what works offline; mark live
providers (Gmail, calendar, Places) UNVERIFIED with the exact connection requirement.

## 5. CRM ↔ Agents continuity

Select a company/deal → "Ask Research…" with `subjects=[crm:deal:<id>]` → follow progress in the bot conversation → saved result →
`crm.activity.add(eventId=<jobId>:result)` twice → one activity on the deal timeline whose link opens the artifact. Jarvis uses the same
`crm.*` operations as the buttons (receipt + link).

## 6. Release

Fresh verified backup (nightly task output + an on-demand one) → one serial release gate (PowerShell, Git bash first on PATH) → apply on
Ryzen checkout (fast-forward) → supervisor restart → migrations run → production verification → report build, journeys, owner-only checks.
Rollback: stop hub → restore the pre-release backup into a fresh folder → point `MU_DATA_DIR` back → previous build.
