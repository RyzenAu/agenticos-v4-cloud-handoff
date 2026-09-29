# NAB connection — manual fallback and synthetic adapter

**CURRENT CHECKPOINT — owner stopped work before legacy admission implementation.** Manual import and the synthetic adapter remain frozen, uncommitted, with the last completed checks recorded below. The newly assigned legacy-route guard work is **unfinished: source inspection only, no edits to `scripts/operator-plugin.ts`, no `scripts/nab/legacy-admission.test.ts` created, and no new test commands run on that assignment**. Other specialists' existing operator-plugin changes are preserved. No further work or provider calls will run until reassignment.

Inspection established that the legacy operator plugin eagerly constructs `createFinanceSync(root)` (which opens the finance store), calls `financeSync.schedule()` during configureServer, and admits status/connect/sync/summary/import-csv through configuration checks rather than reviewed provider/consent/real-data authorisation. The next specialist must guard these paths before configuration, private state, database, provider or file access, remove or fail-close the legacy NAB construction/background schedule, and correct the misleading read-only/no-write comments (user creation and connection refresh exist). Preserve Stripe/Mercury and the local Operations manual fallback. Use only code-owned admission; no environment/request boolean bypass. Test the actual admission middleware over loopback HTTP with synthetic home/fixtures and provider spies, without broad production boot. Implementation and independent review are still pending; no blocker is claimed fixed.

Last completed verification remains the file-import pass: 46 tests / 310 assertions / zero failures; focused and checkout typechecks exit 0; isolated 43-module UI build; generated synthetic native-file-picker import/repeat/clear browser journey. These are dated prior-pass results, not a new verification of the untouched legacy guard assignment. No owned processes are running: replacement previews 45024 and 80199 were stopped; temporary browser tabs closed and viewport reset; generated synthetic temp statement removed. Inherited preview 35839/4188 was left untouched, with current running state not inspected. No voice samples were generated or inspected, no provider usage/cost receipts produced, and no paid request was made by this specialist. Exact current-turn changed path: this report only.

27 September 2026. Current bounded specialist report; uncommitted and frozen for independent lead review after the checks below. Repository: C:/Users/Nebula PC/source/repos/AgenticOS-v4, branch jarvis-voice. Owner confirms NAB BUSINESS account type only. No live consent or real-data permission was exercised.

## Current implementation

The UI now has a genuine **Manual statement import · local only** interface. It accepts one owner-selected JSON file under a separate scope checkbox and a matching local account alias. It does not require a named canned fixture. The fixed documented `nab-manual-v1` schema validates decimal strings, real dates, AUD currency, stable IDs, classifications and bounded input. It imports into a separate owner/account-scoped in-memory ledger, rejects atomic conflicts/overflow, supports idempotent repeats and pending settlement, and clears on permission removal, account/owner change or leaving the view. Construction imports nothing. There are no external calls, uploads, browser/server persistence or default saved copies.

This is a **manual statement import fallback, not live NAB sync**. It is an interchange JSON format; native NAB CSV/JSON export compatibility and automatic conversion are not claimed. No balance, profit, GST or invoice payment is inferred. Only generated synthetic files were used in verification; no real statement or bank/client data was selected or read.

The independent synthetic demonstration remains available: sample permissions, built-in imports, idempotency, insights, expiry invalidation and explicit in-memory scheduler start/stop. Its ledger cannot mix with manual files. The scheduler imports canned fixtures only and never installs an OS job. The closed Basiq synthetic adapter exercises the actual wrapper against in-memory transport; live activation always rejects.

Inherited transport fixes remain: checked HTTPS/origin/user transaction endpoint before authenticated dispatch, redirect prohibition, malformed/repeated/page-cap pagination rejection, identity-only account mapping, exact decimal APIs and lossless numeric rejection. Replacement work also rejects malformed legacy account/connection lists. Root must still enforce admission on legacy user-create/refresh endpoints, which are outside this specialist's route scope.

## Manual interface and integration

[Exact file schema, limits, owner workflow and service contract](NAB-MANUAL-IMPORT-SCHEMA-20260927.md).

UI imports remain `import { NabConnection } from '@/components/finance/nab-connection'`. A shared application should pass `<NabConnection ownerContext={trustedOwnerContext} />`, derived from its authenticated session. Default owner context is the isolated preview principal. Each view owns its manual ledger; owner changes remount/clear it. The module consumes trusted ownership and does not authenticate callers itself. No server import route, durable database or data-to-model dispatch was added.

Manual helper `importOwnerSelectedStatement` checks permission, owner, generation, extension and size before reading `File.text()`, then rechecks the generation before ingest. Clear/unmount/re-grant during the asynchronous read prevents old selection ingestion. Files, paths, names and raw rows never appear in errors or audit output. Manual service has no raw-payload log or audit persistence.

## Verification and evidence boundaries

| Check | Fresh observed result | What it proves |
|---|---|---|
| `bun test scripts/nab.test.ts scripts/nab/lifecycle.test.ts scripts/nab/manual-import.test.ts scripts/finance/basiq.test.ts` | 46 pass, 0 fail, 310 assertions; exit 0 | Actual parser/service, generated File reads, mounted React input/lifecycle, closed provider transport and wrapper policy checks |
| `bun node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext --moduleResolution bundler scripts/nab/manual-import.ts scripts/nab/service.ts scripts/nab/basiq-adapter.ts scripts/nab/lifecycle.ts src/types/bun-sqlite.d.ts` | Exit 0 | Focused source typecheck |
| `bun node_modules/typescript/bin/tsc --noEmit -p .` | Exit 0 | Checkout typecheck at observed concurrent snapshot; not all-track acceptance |
| `bun scripts/nab/preview.ts --build-only` | Exit 0; 43 modules, 3 in-memory assets | Final isolated UI compilation; no app plugins, env files, seeding or bank requests |
| `bun scripts/nab/preview.ts --port=4190` | Compiled 43-module isolated preview reviewed | Actual loopback browser UI and native file chooser journey |
| Impeccable `detect --json src/components/finance/nab-connection.tsx` | `[]`; exit 0 | Mechanical UI source check only |
| Owned-path `git diff --check` | Exit 0 | Tracked whitespace check; Git does not inspect untracked files here |

Source/File tests cover exact cents; bad schema/unknown fields; invalid dates, amounts, IDs and size/row limits; duplicate imports; pending settlement; conflicting settled IDs; account/owner isolation; disabled/oversize/type gates before file read; revocation/re-grant during asynchronous read; overflow rollback; pending/transfers/refunds; actual mounted input permission and owner-switch clearing. Existing mounted tests cover expiry/focus/visibility and synthetic scheduler due/stop/revoke/unmount. These tests use generated synthetic data, React/linkedom and fake clocks. They are not live-bank acceptance or elapsed-day physical-browser observation.

Compiled browser evidence: default file picker disabled and no imported data; explicit checkbox enabled it without importing. Native picker selected only the generated synthetic temp JSON. Import displayed **A$12.34**, one entry and **Manual import / not connected**. Repeat selection displayed **0 changed entries** with unchanged amount. Clear displayed **No statement imported**, **Not shared** and disabled picker. Requested desktop 1440x1000 and mobile 390x844: document client/scroll widths matched, 1425/1425 and 375/375. Screenshots observed in tool output; no persisted screenshot artifact claimed. Schema disclosure opened after resolving its browser semantic selector.

Provider evidence is the actual Basiq wrapper with a closed in-memory fetch implementation, not real provider HTTP. Browser UI assets used real loopback HTTP only. No banking/provider network calls, credentials, consent or account changes occurred. Neither mocks nor health checks establish a live connection.

No final test/type/build failure. One browser disclosure click used a button role that the DOM exposed as a generic summary; resolved with observed text, then inspected. Earlier tooling errors and pre-fix findings are retained in the historical report. No provider acceptance was attempted.

## Exact owned candidate paths

Paths below are relative to the repository named above; no other track's source is owned or changed by this specialist.

- scripts/nab/normalise.ts
- scripts/nab/fixtures.ts
- scripts/nab/insights.ts
- scripts/nab/service.ts
- scripts/nab/basiq-adapter.ts
- scripts/nab/lifecycle.ts
- scripts/nab/lifecycle.test.ts
- scripts/nab/manual-import.ts
- scripts/nab/manual-import.test.ts
- scripts/nab/preview.ts
- scripts/nab/preview.tsx
- scripts/nab/preview.html
- scripts/nab.test.ts
- scripts/finance/basiq.ts
- scripts/finance/basiq.test.ts
- src/components/finance/nab-connection.tsx
- docs/NAB-CONNECTION-20260927.md
- docs/NAB-CONNECTION-HISTORY-20260927.md
- docs/NAB-MANUAL-IMPORT-SCHEMA-20260927.md

The file-import follow-up changed only manual-import.ts, manual-import.test.ts, lifecycle.test.ts, nab-connection.tsx and these three documents. Other listed paths are the preserved inherited candidate/prior replacement repairs. Economics source and concurrent tracks untouched. `docs/NAB-INDEPENDENT-REVIEW-20260927.md` is preserved unchanged as independent pre-fix evidence, not a claim of final independent acceptance.

## Remaining external dependencies

- Lead's independent review, combined Operations route check, trusted ownerContext binding where applicable, legacy route admission guards and any separately authorised path-scoped commit. No commit performed.
- For a future live connection only: provider/principal acceptance, verified specific NAB Business product and nominated-representative eligibility, written costs/cap, agreed processor/retention terms, secure durable token/data lifecycle, bank-hosted owner consent and separately authorised live data/transport acceptance. No production schedule installed.

Basiq remains a conditional proposed route based on the earlier dated official-source review; no new public/provider verification was performed in the file-import pass. The manual fallback itself requires neither a provider account nor live consent and is locally verified with synthetic files only.

## Historical evidence and process state

[Earlier reports, dated official-source assessment and STOP checkpoint](NAB-CONNECTION-HISTORY-20260927.md) are explicitly historical and superseded for implementation/current-status claims by this report. [Independent pre-fix review](NAB-INDEPENDENT-REVIEW-20260927.md) remains intact.

Replacement-owned final preview session 80199 on port 4190 stopped after review. Browser-created tab closed and viewport override reset. The generated synthetic temp JSON was removed by its exact known path after testing. Inherited preview session 35839/4188 was untouched and may still serve the pre-repair build. No private/production process inspected or stopped.

Frozen, uncommitted, for independent lead review. No sends/calls, agents, deployment, merge, purchases, account changes, new external destinations, private files, real bank/client data or economics source work. This is reviewed-by-builder local implementation evidence, not independent acceptance, live NAB sync or whole-project completion.
