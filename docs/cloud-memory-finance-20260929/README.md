# Cloud workstream: memory and NAB CSV finance (29 Sep 2026)

Branch `cloud/memory-finance-20260929`, from `e9366d8`. Synthetic fixtures only: no real memory bank, credentials, private notes, bank data or provider calls. `MU_MEMORY_WRITES` was never turned on outside the in-process fake Hindsight the tests start.

## What already existed (verified, not rebuilt)

Memory: one shared `mu-shared` pool, Obsidian wiki as the editable source, durable outbox with retract-first sync, stable note ids with rename detection by content hash, unindex / memory / full forget with server-held single-use approvals, tombstones against resurrection, a mass-removal hold, and a per-save `processed_by` record read from Hindsight's own receipt. Agent-requested forgets stay behind the verified OS approval path; direct owner UI actions follow the established rule. No code in `scripts/memory` or `src/components/memory` names a single processing model.

Finance: the one CSV importer (`finance-manual.sqlite`), three NAB header shapes, exact-cents parsing, running-balance checks, dedupe keys, coverage states (full / partial / none), corrections that survive re-import, and sourced summaries with "as of" and "not live". Legacy importers stay retired.

## What this branch added

Memory (`scripts/memory/vault.ts`, `connector.ts`, `api.ts`, `types.ts`):

1. **A copied note no longer duplicates.** Notes with the same words, or the same frontmatter `id`, count once. The established note keeps the identity, the copy is listed as skipped with "duplicate of <path>", and if the original is later deleted the copy takes over the same id and document. Notes that declare different ids stay separate on purpose.
2. **Rename plus edit keeps the note's identity.** Before, a note moved and edited between two scans got a new id. That leaked a note the owner had removed from search back into recall, and re-processed it. Now a word-overlap signature (32-value MinHash, stored per note) matches the vanished note when the best match is at least 0.6 and clearly ahead of the runner-up. Otherwise it is a new note, never a guess.
3. **Recall carries provenance.** Each recalled fact now has `origin`, `actor` (null when unknown, for example a hand edit in Obsidian), `indexed` (whether this exact version is confirmed) and `processed_by` (the route Hindsight's receipt names, null when none was found). Source path, Obsidian link, version and date were already there.
4. `src/components/memory/synthetic-client.ts` fills the new fields so the preview client type-checks. No UI rendering was changed.

Finance (`scripts/finance/manual-receptionist.ts`, one route in `manual-plugin.ts`):

5. **Package payment candidates.** `GET /__finance_manual/receptionist-payments?period=` counts posted credits equal to an approved monthly package price from `src/lib/receptionist-packages.ts` (ex GST or plus 10%). Only `pricing.status === "approved"` is used. Setup fees (still `proposed`), overage and SMS are never matched. Own-account transfers, refunds and pending rows are excluded. A period no import covers returns `candidates: null` (unknown, never zero); a partly covered one carries the coverage note. The reply always says: NAB CSV, as of the last row, not live, possible rather than confirmed, and no payer name is kept. It returns counts and totals per package, no rows. No price value was changed.

## Synthetic end-to-end slices

Memory (`vault-propagation.test.ts`): sync a synthetic vault, edit a note (new text recalled, old never), copy it, rename and edit it, remove it from search then rename and edit it (stays out, note untouched, nothing tombstoned), add a credential-shaped line (retracted), add a frontmatter opt-out (retracted), delete it (retracted, no pending work), restore it (same id, one document), and read provenance on a recalled vault fact and a Jarvis memory.

Finance (`manual-receptionist.test.ts`): a fake NAB CSV through preview then explicit import into the shared ledger, then the handler route. Covers ex-GST and inc-GST matches, a setup-fee-sized credit, an own-account pair, a refund, an unrelated deposit, a pending premium credit, re-import without double counting, an uncovered month, an empty ledger, and that nothing identifying leaves the route.

## Exact results

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| `bun test ./scripts/memory/` | 391 pass, 1 fail (below) |
| `bun test ./scripts/finance/` plus `business-memory`, `jarvis-skills/finance`, `business-economics` | all pass; 680 tests across 53 files including the memory dir, 1 fail (below) |
| new tests | `vault-propagation.test.ts` 8, `manual-receptionist.test.ts` 10 |
| `bun run build` | Vite reports "built", then exits 1 with `database is locked` in `mail-archive.ts` `closeBundle`. **Same on the untouched `e9366d8` tree**, so it is a baseline limitation here, not from this branch. |

The one failing test, `j5-secrets.test.ts` "scan length is bounded … under 100 ms at 200 KB", takes about 0.7 s in this Linux container both before and after this branch. It is a timing assertion, not a behaviour one, and the code it exercises is untouched.

## Integration seams

Finance page: render `/receptionist-payments` next to the summary cards. `receptionistCandidatesText` gives the one-line wording for Jarvis. Wiring either into `src/components/shell` or Jarvis routing belongs to the other tracks. Memory page: `RecalledFact.origin/actor/indexed/processed_by` are available to show under each recalled item. `FactsUsedPanel` was not changed.

## Not done and not claimed

No live Hindsight, no real vault, no Windows run, no browser check of the Memory or Finance pages, no paid model call. The signature match runs on the first scan after upgrade only for notes that are re-scanned; existing `notes.json` entries have no signature until their note changes or is re-saved, so a rename plus edit of a note untouched since the upgrade still falls back to a new id. `bun test` for whole `scripts` was not run.

## Windows and live-data acceptance (later, on the PC)

1. With writes off, run a sync against a copy of the real vault and read the Memory status: skipped list should show any `duplicate of …` notes for owner review before anything is indexed.
2. With the proxy and `MU_MEMORY_WRITES=on` on a disposable bank, rename and edit a note in Obsidian within one minute; confirm one Hindsight document, same id, new path, and that a previously unindexed note stays out of recall.
3. Save through Jarvis and confirm `processed_by` names whichever route actually ran; a missing receipt must show as unknown.
4. Import a real NAB CSV export on the Finance page and check the `receptionist-payments` counts against actual invoices for the same month. Amounts can coincide, so treat every match as a lead.
