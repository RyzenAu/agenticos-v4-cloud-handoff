# NAB CSV import: the one path into Finance

Stage F (V6 §8, TARGET-ARCHITECTURE §2). Finance's transaction store is
`.operator-data/finance-manual.sqlite`. It is authoritative. It is filled only by a NAB CSV export
that one of the founders drops or picks on the Finance page. It is **not a live bank feed**, and the
page never presents it as one.

## One import path

| Path | Status |
|---|---|
| Finance → "Import a NAB CSV" → `/__finance_manual/preview` then `/import` → `finance-manual.sqlite` | **The only importer** |
| Legacy `/business/finance/import-csv` → `finance.sqlite` (`csv-import.ts`) | **Retired.** It answers `410 nab_csv_moved` whatever any authorisation says. `csv-import.ts` is deleted. |
| Legacy Downloads-folder scan (`importCsvFromDownloads`, schedule tick) | **Retired.** Nothing scans Downloads. |
| Ephemeral `nab-manual-v1` JSON import (Operations → NAB connection) | **Retired.** `scripts/nab/manual-import.ts` is deleted. The view now links to Finance. |
| Legacy Basiq sync (`sync.ts`, `finance.sqlite`) | Unchanged. It stays fail-closed (`legacy-admission.ts`) and is deferred by the owner. |

The parser (`scripts/finance/manual-nab-csv.ts`) accepts three shapes:

- the NAB Internet Banking header (with Processed On, so it knows about pending rows);
- the NAB Connect header without Processed On;
- the older headerless `Date, Amount, [Account], Details, Balance` export that the retired importer read.

## Validation, per row

Every problem is reported with its line, its column and a plain-English reason. A cell value is
never shown. Any error rejects the whole file, so nothing is imported by halves. The checks cover:

- headers;
- Australian dates, day first (`27 Sep 26`, `27/09/2026`; US order and impossible dates are rejected);
- amounts and balances (plain decimals, parsed exactly as integer cents);
- column counts, quoting, cell length and control characters.

The **running balance** is checked per account, in either file order. A row that doesn't follow
from the one before it is a *warning*: the export may be missing a row, or it was edited. The
preview shows the warning, and the import only goes ahead after an explicit "Import anyway". The
audit records that the warning was accepted.

## Dedupe: re-importing overlapping exports never double-counts

A posted row is recognised again, in this order:

1. by its salted id;
2. by its **strong key**: account + date + amount + running balance + how many times that combination
   has appeared in the file so far. This survives NAB re-wording the details or re-categorising
   between exports. Two identical coffees on one day have different balances, so they stay two rows.
   A charge, its reversal and a re-charge on one day (same amount, same resulting balance) are three
   rows too: the occurrence index tells them apart. NAB exports whole days, so the index is stable
   across overlapping files;
3. by its **text key**, which leaves out the balance. This catches NAB re-ordering a day's rows.
   It is only used when the stored row isn't already accounted for by its strong key, and the stored
   row takes the new key.

A pending row is settled by the posted row NAB writes later (same account and amount, within
−1 to +7 days). A re-worded pending row is the same row. A *loose* row (no balance: an older
export, or a row migrated from the legacy store) is replaced by the first strong row with the
same account, date and amount.

An export **without account numbers** (the older 4-column shape) can't be matched against exports
with them, because every key includes the account. Mixing the two is refused with a plain
reason (`ACCOUNTLESS_MIX`), both ways round, in the preview and the import.

**The two edge cases the finance review left open (R2 #1 and #3) are now handled**
(`manual-edge-cases.test.ts`):

- **NAB re-orders a day and re-words it in the same later export.** Both the strong key (the
  balance moved) and the text key (the details changed) miss. A last-resort match then takes a
  stored posted row with the same account, date and amount, provided no other row in the file
  accounts for it by its strong or text key. NAB exports whole days, and same-day rows with the same
  amount are interchangeable, so the count per day is right. The stored row takes the new keys.
  Three rows stay three (the review saw five); a mid-day export followed by the whole day, re-ordered
  and re-worded, adds only the new rows. The residual risk: if a bank ever dropped a row from a day
  it had already exported and a new row with the same amount appeared that day, the new row would be
  taken as the old one.
- **NAB renames an unknown merchant.** A vendor rule applies to every spelling in the same merchant
  family: the id with trailing corporate suffixes (`PTY LTD`, `INC`, `AUSTRALIA`…), store numbers and
  a leading "the" removed (`m-officeworks-pty-ltd` → `m-officeworks`). A rule set on the exact id wins
  over one from the family. When an overlapping export shows the same transaction under a wholly new
  name, the old name's rule is copied to the new name (never over a rule the new name already has)
  and the edit log records it as `carried`. Row corrections are unaffected and still win.

## Coverage: unknown is never zero

Each import records the date range it covered for every account in the file. That range is the
file's first to last date, because NAB exports a date range, not just the days with rows. A
period's coverage is the union of those ranges:

- **none**: no account covers any day of it. Every figure is unknown. The page shows "Unknown",
  Jarvis says it has no data, and memory records "no data" (`totals: null`).
- **partial**: there is a gap between imports inside it, or an account whose exports stopped doesn't
  reach it. The figures show with "may be incomplete" and the covered dates.
- **full**: every account imported so far covers every day.

## Import speed

Every per-row lookup is an index seek. On synthetic data, 20,000 rows import in about 1.5 s. That
drops to about 2.5 s when every row has the same amount, and a summary takes about 0.2 s. The review
had measured 189 s and 257 s. The preview runs the same code.

## Classification, and corrections that survive re-imports

- **Vendors:** the built-in M&U rules live in `manual-vendors.ts`. **Vendor rules** that the founders
  can edit (`/vendor-rule`) set label, category, business/personal and type for every row of a
  vendor, now and in later imports.
- **Transfers:** outgoing transfer debits are transfers. An incoming credit that mirrors an outgoing
  transfer from another of the founders' accounts within a day is an **own-account pair**. Stripe
  payouts are reported with transfers, because Stripe revenue already counts them.
- **Refunds** are matched to the original charge: the same vendor and account, a charge at least as
  large, on or before the refund and within 120 days. An exact amount is preferred, then the most
  recent charge. A founder can also link a refund by hand (`refundOf`).
- **Fees:** NAB account fees and international (FX) fees are separated. Each FX fee is attributed to
  the charge it was levied on.
- **Business vs personal:** known M&U vendors default to business. Everything else is "not decided"
  until a founder marks it.
- **Corrections** (`/correct`: type, category, scope, refund link) live in their own table. Each one
  records who made it, when, and the value it replaced (the append-only `edit_log`). Re-imports never
  touch them. When a row is superseded (pending → posted, loose → strong), its corrections move
  to the new row and the edit log records the move. A row's own correction wins over a vendor rule.

## Access

The verified principal comes from the one identity contract (`scripts/identity/principal.ts`,
Stage B1). A relay header (`x-forwarded-*`, `forwarded`, `tailscale-*`) on a loopback request is
nobody. Its request can't read Finance or be recorded as "imported by" anyone.

- Changes need the caller's page token.
- Row-level reads (`/transactions`, `/edits`) need the page token too.
- A local process holding only a principal gets period totals, never rows.

**Clear all** is the one irreversible action, so it takes a full backup first, to
`.operator-data/backups/finance-manual.pre-clear-<time>.sqlite`.

## One shared ledger (V7)

Both founders see and correct the same data: the ledger is `shared`. The verified person on each
request (resolved by the identity layer) is recorded as provenance only: "imported by",
"corrected by". It never scopes access. Opening the store folds any per-person ledgers from the w2
design (`usman`, `mehroz`) into `shared`, once, after a full `VACUUM INTO` backup to
`.operator-data/backups/finance-manual.pre-shared-ledger-<time>.sqlite`. A row already in the
shared ledger is never duplicated, and each old import keeps its person as the audit actor.

## Migrating the legacy finance.sqlite rows

`scripts/finance/legacy-migration.ts` does this once, one way, from the finance page ("Bring its NAB
rows in") or from the command line:

```
bun scripts/finance/legacy-migration.ts --root "<AgenticOS folder>"          # dry run: counts only
bun scripts/finance/legacy-migration.ts --root "<AgenticOS folder>" --apply  # migrate
```

1. **Backup first** (`--apply` only; a dry run reads a temporary copy and writes nothing). `finance.sqlite` and its `-wal`/`-shm` files are copied to
   `.operator-data/backups/finance-legacy-<time>/`, and the manual store is copied beside them. If
   a backup fails, nothing is migrated. The backups are byte copies that are never opened.
2. **Only a temporary working copy is read.** The original `finance.sqlite` is never opened, changed or
   deleted. It also holds the Stripe tables, which stay where they are.
3. NAB rows (`source` `nab-csv` and `basiq`) are converted with the same classifier and salted
   account aliases. Description text stays behind. They land in the shared ledger as **loose** rows
   tagged `legacy-csv` or `legacy-basiq`. The first NAB CSV that covers them completes each one in
   place, carrying any correction across, so no money is counted twice. Re-running the migration
   changes nothing. A re-run is refused (`409 ALREADY_MIGRATED` from the API; `--force` on the command line).
   Even when forced it brings nothing in twice, including rows a CSV has since completed, because
   the store remembers every legacy row it has migrated.
4. The output is counts only.

The Finance page only offers the migration when the legacy store still holds NAB rows (a
read-only count).

**State on 28 Sep 2026.** A sandbox copy of the live `finance.sqlite` holds **0** NAB rows (and 0
Stripe rows), so there is nothing to migrate and the page offers nothing. No `finance-manual.sqlite`
exists yet in the live tree, so there are no per-person rows to fold either. Both steps are safe
no-ops there.

## What leaves Finance

Jarvis and memory get **sourced summaries** only (`manual-sourced.ts`). These are period totals
(cash in and out, net operating, transfers, refunds, fees, tools, business/personal spend, pending
count) with the source ("NAB CSV imported, as of 26 Sep 2026", `finance-manual.sqlite`, not live)
and the period's coverage. A period that no import covers is `totals: null`, spoken as "I don't
know", and never zero. No transaction, vendor line, account alias, balance or bank text leaves
Finance.

`scripts/business-memory.ts` used to index account names, balances and income as searchable memory
rows. It now writes one "Finance summary (sourced)" document. Observed balances (Mercury) are
acknowledged by source and date only, and the old balances document is retracted.

## Finance page truth

- The source badge and each import-history line say "NAB CSV imported, as of <date>".
- "Live bank feed: not connected" is a separate badge and a separate card.
- A period with no imported data shows **Unknown**, not $0.00.
- Nothing is imported without a preview and an explicit click.
- No trades or transfers: the page moves no money.
