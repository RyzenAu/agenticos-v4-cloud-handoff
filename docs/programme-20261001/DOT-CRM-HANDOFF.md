# Handoff to Dot: CRM development baseline (2 Oct 2026)

**Status of this baseline: DEVELOPMENT CANDIDATE, not a verified release.** It is the Ryzen-migration integration branch. The everyday OS
(main PC, `127.0.0.1:8081`) still serves the older `jarvis-voice` build `6607e4f`; the Ryzen cutover has not happened yet. Build your CRM on
this baseline; Claude integrates your package onto whatever is live after cutover.

## 1. Exact base

| Item | Value |
|---|---|
| Source repository | AgenticOS-v4 (private; the owner's canonical checkout has **no Git remote**, so this package is the delivery route) |
| Branch | `ryzen/migration-20261002` |
| Base commit | the commit that adds this file (its parent is `995c0a40`, code identical apart from these handoff docs) — the package manifest records the full SHA |
| Parent of the migration work | `jarvis-voice` `6607e4f7` (+ everything on `ryzen/migration-20261002`) |
| Not included | the owner's 35 UNCOMMITTED working-tree entries in the canonical checkout (real-estate preview template work under `scripts/lead-sites/overlays/real-estate/**`, a few docs and `skills/*`). They are not CRM files; do not recreate them. If a CRM change needs them, say so in your package. |

## 2. Verification of this baseline (honest, as of packaging)

| Check | Result |
|---|---|
| Full test suite on the server-role branch at `555fca65` (same code as here minus one away-mode fix) | 12,084 pass, 0 fail (builder run) |
| Typecheck (`tsc --noEmit`, `tsc -p tsconfig.scripts.json`) at `555fca65` | clean (builder run) |
| Final serial release gate on `995c0a40` | **running at packaging time**; result recorded in `RYZEN-MIGRATION.md` when done |
| Independent security reviews of the permission changes | 3 rounds; all findings fixed and re-tested; one late should-fix (relay token check per request) fixed in `995c0a40` |
| Real-host acceptance on Ryzen (disposable data) | bot desktops (viewer, lease, takeover, Stop, persistence, sandbox), a real Research task with a cited saved result, remote previews, memory acceptance 31/31, a real coding job (Claude Max 2) — see `RYZEN-MIGRATION.md` |

Known environmental test notes: under PowerShell, `bash` may resolve to WSL bash and fail 5 shell-script tests; put Git's bash first on PATH
(`$env:Path = "C:\Program Files\Git\bin;" + $env:Path`). One microphone-ownership test is timing-sensitive under full-suite load.

## 3. Ownership (in force)

Read `AGENTS-WORKSPACE-OWNERSHIP.md` and `AGENTS-CRM-CONTRACTS.md` (both in this package).
- **Dot:** CRM entities, Leads, contacts, companies, deals, activities, follow-ups, delivery records; `src/components/operator/lead-*.tsx`,
  `leads-*.tsx`, `src/lib/lead-search.ts`, `scripts/leads/**`, new `scripts/crm/**`, new CRM routes/components, `src/lib/crm-ref.ts`, `src/lib/crm-links.ts`.
- **Claude:** Ryzen hosting, the unified Agents workspace (bots, per-bot conversations, computer UI, bot Setup, bot-scoped voice) and **integration
  owner for shared navigation, the layout shell and release integration**. Claude adds the Agents nav entry; propose CRM nav changes in your package.
- **Shared, coordinate:** existing jobs, accounts, identity (`scripts/identity/**` — add only rows for your own new `/__*` mounts), memory, `src/components/ds/*`, `ui/*`, tokens.
- Start independently owned work now. Do not build a competing Agents workspace.
- Brooke / Bianca Brown Realty: separate project, excluded. Receptionist: on hold.

## 4. Known blockers and facts that affect CRM work

- The hub is moving to a headless server role (`MU_HUB_ROLE=server`). New `/__*` routes must be classified in `scripts/identity/routes.ts`
  (deny by default). In server role "only at this PC" checks are replaced by `serverWorkAllowed(...)` (`scripts/identity/operator-sites.ts`):
  CRM writes by a confirmed founder session are server work; outward actions (sending email, publishing) need a B2 approval
  (`scripts/approvals/gated-action.ts` — reuse it).
- `by` on writes must come from the verified principal, never the request body, for remote callers.
- Places/Google: the only spend limit in Find is the fixed `MONTHLY_DETAILS_BUDGET` (900 detail lookups/month). Do not add model spend caps
  (owner decision: no AgenticOS caps on OpenRouter or Jev).
- No real outreach, emails, texts, calls or invitations during development.

## 5. Install and run (synthetic data only)

Prerequisites: Bun 1.4.2 (pinned), Git. Windows or Linux/macOS.

```
# verify and extract (Linux/macOS/Git Bash)
sha256sum -c SHA256SUMS
mkdir agenticos && tar -xzf mu-hub-<sha12>.tar.gz -C agenticos && cd agenticos
# Windows PowerShell: Get-FileHash mu-hub-<sha12>.tar.gz -Algorithm SHA256 ; tar -xzf mu-hub-<sha12>.tar.gz -C agenticos
bun install --frozen-lockfile
```

Run an isolated dev hub on throwaway data (never point it at real data):

```
# bash
MU_DATA_DIR=$PWD/.dev-data HOME=$PWD/.dev-home HINDSIGHT_URL=off MU_MEMORY_WRITES=off AGENTIC_OS_NO_BACKGROUND=1 \
  bun --bun node_modules/vite/bin/vite.js dev --port 8131 --strictPort --host 127.0.0.1
# PowerShell
$env:MU_DATA_DIR="$PWD\.dev-data"; $env:HOME="$PWD\.dev-home"; $env:USERPROFILE=$env:HOME; $env:HINDSIGHT_URL='off'; $env:MU_MEMORY_WRITES='off'; $env:AGENTIC_OS_NO_BACKGROUND='1'
bun --bun node_modules/vite/bin/vite.js dev --port 8131 --strictPort --host 127.0.0.1
```
Drop `AGENTIC_OS_NO_BACKGROUND=1` if you need write routes (it makes the hub read-only); keep a throwaway `MU_DATA_DIR`.
`bun --bun` is required (SQLite FTS5). Configuration names (placeholders only): `DOT-CONFIG-NAMES.md`.

## 6. Tests

```
bun test scripts/leads                    # Leads/CRM engine, evals
bun test scripts/leads/evals              # lead-classification evals (run before changing any classification rule)
bun test scripts/lead-sites scripts/identity scripts/approvals scripts/jobs
bun test scripts src                      # full suite (about 25 min)
bun node_modules/typescript/bin/tsc --noEmit
bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json
```

## 7. What to send back

A package (or PR when a shared remote exists) with: base commit (this one), final commit, file list, migrations with a dry-run report and
rollback, test and typecheck results, screenshots, the contract confirmations/amendments for `AGENTS-CRM-CONTRACTS.md`, and any proposed
shared-file changes listed separately.
