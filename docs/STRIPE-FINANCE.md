# Stripe — read-only

Reads your Stripe account's balance, payouts, invoices, charges, customers and subscriptions.
It is **read-only end to end**: nothing in this integration can refund a charge, create an
invoice, cancel a subscription or move money. That guarantee is enforced in code, not just by
convention — see "Why this is safe to connect", below.

## Your steps

1. **In the Stripe Dashboard**, go to **Developers → API keys → Create restricted key**. Give
   it **Read** access to at least: Balance, Balance transactions, Payouts, Invoices, Charges,
   Customers, Subscriptions. Leave every other resource at **None**. Stripe will show you a key
   starting `rk_live_…` (or `rk_test_…` for a test-mode key) — this restricted key is what makes
   the connection genuinely read-only on Stripe's side, independent of anything this app does.
2. **Add it** to `~/.config/agentic-os.env`:
   ```
   STRIPE_RESTRICTED_KEY=rk_live_your_key_here
   ```
   A full secret key (starting `sk_…`) is refused outright — see below.
3. **Rescan** the dashboard's Setup → Finances step (or Business → Finance directly, once its
   Stripe card is wired up). It reads the key, confirms it's a restricted key, and starts a
   sync — no OAuth flow, no browser redirect, because a restricted key is entered directly.

## Why this is safe to connect

- **The key itself is read-only.** A restricted key created with only "Read" permissions
  cannot call any Stripe write endpoint, no matter what this app (or a bug in it) asks Stripe to
  do — Stripe's API rejects the request before it does anything.
- **This app never asks for more than GET.** `scripts/finance/stripe.ts`'s client
  (`createStripeClient`) has exactly one function that calls `fetch`, and it hardcodes
  `method: "GET"` — there is no parameter, option or code path that could turn it into a POST,
  PUT or DELETE. The object it returns has no `create*`/`update*`/`delete*`/`refund*` method at
  all. `scripts/finance/stripe.test.ts` asserts both of these directly (the exact method list,
  and that every mocked request comes through as `"GET"`).
- **A full secret key is refused before any request is made.** If `STRIPE_RESTRICTED_KEY`
  starts with `sk_` (a full secret key, which *can* write), the client throws
  `"Use a restricted read-only key (rk_…)"` instead of connecting — belt-and-braces on top of
  the key's own Stripe-side permissions.

## What's read, and how it avoids double-counting

- **Balance, balance transactions, payouts, invoices, charges, customers, subscriptions** — one
  read-only GET per resource, paginated (bounded to 20 pages of 100 rows each — a misbehaving
  cursor can't loop forever), landing in their own tables in `.operator-data/finance.sqlite`:
  `stripe_balance`, `stripe_balance_transactions`, `stripe_payouts`, `stripe_invoices`,
  `stripe_charges`, `stripe_customers`, `stripe_subscriptions`. These are separate from the
  `accounts`/`transactions` tables the NAB (Basiq/CSV) sync owns (see `docs/FINANCE-NAB.md`) —
  Stripe data doesn't need to look like a bank feed to be useful, and keeping it in its own
  tables means the Stripe sync can never collide with a bank sync running at the same time.
- **Payouts are internal transfers, not income.** A Stripe payout is Stripe moving money it
  already collected into your bank account — the revenue was already counted when the
  underlying charge landed. Every synced payout is flagged `is_internal_transfer = 1`, and
  `reconcilePayoutsWithBank` links it (by amount + a 5-day date window) to the matching bank
  deposit once your NAB sync has that deposit too. Linking never sums both sides — it just
  records which bank-side row a payout became, so a summary reading both sources knows not to
  add the payout amount on top of the bank credit it produced. Nothing here writes back to the
  bank-side `transactions` table.
- **Revenue this month** is computed from succeeded, non-refunded **charges** in the current UTC
  month — not from payouts (see above) and not from invoices (an invoice can be raised and paid
  in different months to when the underlying charge succeeded).
- **MRR** sums every `active`/`trialing` subscription's price, normalised to a monthly figure
  regardless of billing interval (yearly ÷ 12, weekly × 52/12, etc.). `null` when there are no
  subscriptions, never `0`, so the UI can tell "no subscription revenue" from "not read yet".

## What's stored, and where

- `~/.config/agentic-os.env` — your `STRIPE_RESTRICTED_KEY`. Never logged, never printed, never
  sent anywhere except to `api.stripe.com` with each request.
- `.operator-data/finance.sqlite` — synced balance, payouts, invoices, charges, customers and
  subscriptions, in the `stripe_*` tables described above. Stays on this computer; not
  committed to git, not sent anywhere except back into the dashboard's own finance record.

## Current status: UI pending

The sync engine (`scripts/finance/stripe.ts`), its tests and this doc are done. The Business →
Finance card, the dashboard's income area and the "Stripe connected (read-only)" state on the
connections panel are **not wired up yet** — those are shared files another engineer is
mid-edit on for the NAB CSV importer (`scripts/finance/store.ts`, `scripts/finance/sync.ts`,
`scripts/finance/csv-import.ts`). Once that work lands (a commit in `git log` and a clean
`git status` on those files), wiring the UI is: call `createStripeSync(root).summary()` from
whatever loads the finance page's data, and render its fields the same way the NAB summary
already renders `incomeMonth`/`runwayDays`/etc.
