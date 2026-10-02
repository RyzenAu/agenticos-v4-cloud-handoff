# Migration and rollback

Schema v1 is additive in the existing `crm.sqlite`. It creates related company/contact/deal/task/activity/project/document/pipeline tables, joins, immutable document versions/status history, import receipts and automation receipts. Existing Leads tables and rows remain intact. Original IDs, source references, manual provenance, restrictions, histories, commercial values, follow-ups and duplicate relationships are bridged explicitly.

## Before production integration

1. Confirm the Ryzen cutover and current integration base with Claude. Stop writes before the planned upgrade and take the existing whole-workspace backup, including source evidence/documents.
2. Use a disposable copy first. Never point development tests at the live file.
3. Run a read-only dry run:

   `bun scripts/crm/migrate.ts --db /absolute/path/to/copy/crm.sqlite`

4. Review counts, missing independent Google fields, unknown owners, invalid dates, unstructured kickoffs and all orphan/duplicate-target findings. The migration refuses orphan relationships. It does not silently invent a name, a verified website absence or a valid due date.
5. Apply to that copy with a NEW backup destination:

   `bun scripts/crm/migrate.ts --db /absolute/path/to/copy/crm.sqlite --apply --backup /absolute/path/to/new-pre-crm.sqlite`

`VACUUM INTO` creates a consistent SQLite backup and `PRAGMA integrity_check` verifies it. Existing backup destinations are refused. Runtime upgrades also make a uniquely named, integrity-checked pre-v1 backup before opening/upgrading legacy schema; a failed backup aborts. The migration report records its path.

## Reconciliation and concurrency

- Migration obtains an immediate write transaction and rechecks the schema version/counts inside that lock. Concurrent and repeated requests create one schema and do not duplicate rows.
- Before/after originals are hashed, source counts reconciled, and CRM foreign keys checked. A failure rolls back the entire migration.
- Original lead IDs resolve through canonical duplicate chains, including forward-pointing pre-existing merges. Late old-API activities, follow-ups and kickoffs reach the keeper. Cycles or missing targets require review.
- New CRM edits write relevant legacy fields through existing correction semantics; baseline fingerprints prevent repeated reads from undoing explicit CRM changes. Legacy economics remain ex GST and are converted when the CRM deal is inclusive. Unsupported no-GST changes to legacy deals are refused.
- Opt-outs propagate monotonically across matching addresses/numbers, merged companies and existing child contacts. Imported outreach follow-ups cancel on suppression; genuine delivery promises remain.
- Transient Google directory fields are omitted unless independent provenance exists. Empty, failed, unchecked and verified-absent website states remain distinct. Source evidence and preview/draft files are retained at their original locations and accessed through the legacy lead link, not duplicated into CRM.

`migration-example.json` is an actual disposable in-memory dry-run/apply/repeat/rollback report. Original records were unchanged, the second apply was a no-op, and rollback returned schema version 0. Focused tests also reopen SQLite/Jobs and verify backup restoration.

## Rollback

For a disposable verification copy only:

`bun scripts/crm/migrate.ts --db /absolute/path/to/disposable.sqlite --rollback --disposable --acknowledge-data-loss`

This drops the explicitly owned CRM tables, preserving legacy tables. It is not a live rollback procedure and discards new CRM-only records in that disposable copy.

For a live integration rollback: stop the hub; preserve the current CRM database together with its WAL/SHM siblings for recovery; restore the verified pre-upgrade backup to `crm.sqlite` with no stale WAL/SHM siblings; restore the previous reviewed source; verify SQLite integrity and original record counts before restarting. Any CRM-only records created after the backup must be reconciled separately before restoring. Do not delete the retained current copy or overwrite new data merely to make the old build start.
