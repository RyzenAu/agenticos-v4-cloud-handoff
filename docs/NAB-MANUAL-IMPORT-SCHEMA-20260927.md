# Manual statement import schema

Local manual fallback, not a live NAB connection. JSON only; this is an explicit interchange schema, not a promise to accept native NAB CSV/JSON exports. The owner must prepare a matching file outside the app. No automatic bank-export conversion, filesystem scanning, upload or provider call occurs.

## Owner workflow

1. Set a local account alias, such as `business-1`; do not use an account number.
2. Tick the separate local file-processing permission checkbox.
3. Select one `.json` file in the native picker. Construction, permission enablement and opening the picker do not import anything.
4. The selected file is validated and imported locally. Read the changed-entry count and cash movement. Re-selecting an identical file changes zero entries.
5. Clear the import/permission or leave the view to discard the ledger. Changing account alias or host owner context also clears it. No browser storage, server storage or default persistence exists.

The implementation was verified using generated synthetic files only. The specialist did not select or inspect any real statement or account data.

## Exact schema

```json
{
  "schema": "nab-manual-v1",
  "accountId": "business-1",
  "currency": "AUD",
  "transactions": [
    {
      "id": "entry-1",
      "date": "2026-09-27",
      "amount": "10.25",
      "direction": "credit",
      "status": "posted",
      "kind": "ordinary"
    }
  ]
}
```

All fields shown are required; additional fields are rejected. No descriptions, bank account numbers, credentials, client details, vendor names or arbitrary nested payloads are accepted. `accountId` and transaction `id` are stable aliases, 1–80 ASCII letters/numbers/underscores/hyphens, starting with a letter or number. File accountId must equal the alias granted in this view; ownership is never derived from the file.

`amount` is a nonnegative decimal **string**, with no sign, exponent, whitespace, thousands separators or leading zeroes (except `0`). At most two fractional places; integer amounts are accepted. AUD cents are parsed with BigInt and bounded to safe integers. JSON numeric amounts are rejected. `date` must be a real calendar date in exact `YYYY-MM-DD` form. `direction` is `credit` or `debit`, `status` is `posted` or `pending`, and `kind` is `ordinary`, `transfer` or `refund`. Classification is supplied explicitly by the owner, not inferred.

Maximum file: 256 KiB UTF-8; 1–2,000 rows per file; 5,000 retained unique rows per view. Both file metadata and decoded text size are checked. Invalid schema, dates, money, conflicts and aggregate overflow reject the whole import without changing prior totals. Error messages contain no filename, row IDs, values or parser excerpts.

## Reconciliation and boundaries

Identical account/transaction identity is idempotent. Pending → posted updates one entry. A stale pending row cannot downgrade a posted row. Conflicting settled IDs and conflicting duplicate IDs within one file are rejected; this fallback does not guess whether they represent corrections or reversals. IDs changing between pending and posted require owner reconciliation.

Cash flow excludes pending and transfers; refunds are separate. No account balance, GST, accounting profit, invoice payment or subscription is inferred. Manual records are held in a separate ledger from canned synthetic fixtures and the synthetic scheduler. There is no automatic manual refresh. Last import time means local processing time, not bank verification or bank freshness.

## Service contract

`scripts/nab/manual-import.ts` exports:

- `parseManualStatement(text)`: pure bounded fixed-schema parser; no file/path/network access.
- `createNabManualImportService(ownerContext, { now? })`: memory-only owner-bound service. `status`, `enable`, `clear`, `importText` check the bound tenant/owner. `enable` requires `{ acknowledgement: 'manual-local-only', accountId }`; `importText` requires `{ text, ownerInitiated: true, generation }`. Clearing increments generation and invalidates queued reads. Account selection cannot come from an untrusted request body.
- `importOwnerSelectedStatement(service, ctx, file, generation)`: checks owner, grant, file size and extension before `file.text()`, then rechecks generation on ingest. Revoking/replacing the grant or unmounting during the read prevents ingest. It never enumerates files or opens a supplied path.

UI host: `<NabConnection ownerContext={trustedOwnerContext} />`. The host must derive this context from its authenticated session when integrating a shared owner application. Default context is explicitly the isolated preview principal. Each view owns its own manual service; owner changes remount and clear the old instance. No authenticated server import route is delivered or required for this local file interface. No manual records are sent to Jarvis or the model fleet.
