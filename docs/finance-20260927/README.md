# Finance: NAB CSV manual import (27 Sep 2026)

Owner decision: NAB is connected by owner-initiated CSV export for now. The live Basiq connection is
**not connected**. It is waiting on Basiq production enablement and the owner's consent, and neither is authorised.

## Owner workflow
1. NAB Internet Banking → Accounts → Transaction history → account + dates → Export → CSV.
2. Drop the file on the Finance page (or use **Choose file**). Nothing is read until you do. Nothing watches a folder.
3. Re-importing the same or an overlapping export changes zero rows. When a pending row posts, it becomes one posted row.
4. **Clear all** deletes every imported row for you. SQLite `secure_delete` and `VACUUM` are used, so the deleted data does not stay in the file.

## What is stored (`.operator-data/finance-manual.sqlite`, separate from legacy `finance.sqlite`)
- Per owner (`usman` by default; other owners are isolated). Each row holds a salted row id and a salted account alias (never the account number), plus the date, posting date, status and integer cents. It also keeps the kind (ordinary/transfer/refund/fx-fee/bank-fee), a vendor/merchant label and a category.
- Not stored: the account number, the Transaction Details text, the balance, and payer/payee names on transfers.
- Audit log: counts and codes only (no file names or values).

## Parser (strict)
- Accepts only this header: `Date,Amount,Account Number,,Transaction Type,Transaction Details,Balance,Category,Merchant Name,Processed On`.
- Dates look like `27 Sep 26`. Amounts are signed decimal strings, converted to cents with BigInt. A blank `Processed On` means pending.
- `NAB INTNL TRAN FEE` rows are FX fees, attributed to the adjacent foreign charge (about 3%).
- One bad row rejects the whole file. Errors show a code and a line number, never a value. Limits are 4 MiB and 20,000 rows.

## Aggregates: `summary(owner, period)` in `scripts/finance/manual-summary.ts`
- Returns `source: "nab-csv-manual"`, with `asOf` set to the latest posting date. The data counts as stale when `asOf` is more than 7 days old.
- Shows cash in and cash out, by category and by vendor.
- Tool and subscription costs include attributed FX fees, net of refunds.
- Transfers, refunds and pending rows are shown separately. An own-account transfer pair counts as a transfer, not income.
- This is cash flow, not accounting profit: `accountingProfit: null` and `gst: "not-inferred"`.
- Vendor rules are held as data in `scripts/finance/manual-vendors.ts`. They cover Retell, Twilio, Vercel, Neon, Higgsfield, ElevenLabs, OpenAI, Anthropic and Stripe payouts.

## Basiq live adapter (`scripts/nab/basiq-live.ts`)
A skeleton only. `BASIQ_LIVE_ADMISSION = null` in code, so every method throws before it touches the secret, the transport or the store. The file documents what live access needs:
- a token held by secure reference;
- idempotent sync;
- stale/error phases;
- revocation.

Legacy NAB routes stay fail-closed, and `activateLiveNab()` still throws.

## Screenshots (synthetic data only, isolated preview on port 4303)
The screenshots are `finance-synthetic-1440.png`, `finance-synthetic-390.png`, `finance-empty-1440.png`, `finance-empty-390.png` and `finance-rejected-1440.png`.
Reproduce them with `bun --no-env-file scripts/finance/manual-preview.ts --port=4303 [--seed]`. The preview uses an in-memory store.

## Patch for lead (not applied by this track)
In `vite.config.ts`, add the import beside the other plugin imports:
```ts
import { manualFinancePlugin } from "./scripts/finance/manual-plugin";
```
Then add this to the plugins array, next to `aiUsagePlugin(...)`:
```ts
      manualFinancePlugin({ root: __dirname, token: REFRESH_TOKEN }),
```
The os-shell Finance destination should mount the page like this:
```tsx
import { FinanceDestination } from "@/components/finance/manual-finance";
<FinanceDestination />
```
For the Jarvis router (Jev track), call `matchManualFinanceQuestion(text)` and `answerManualFinanceQuestion(intent, summary(owner, intent.period))` from `scripts/finance/manual-jarvis.ts`. Alternatively, call `GET /__finance_manual/ask?q=…`.
