# NAB via Basiq — read-only

Connects your NAB business account to the dashboard through [Basiq](https://api.basiq.io), an
Australian Consumer Data Right (Open Banking) aggregator. It is **read-only**: this OS cannot
initiate a payment, move money, or write anything back to NAB. You never enter your NAB
credentials into this app — you consent on Basiq's and NAB's own hosted screens.

## NAB CSV: use the Finance page (the one importer)

The CSV fallback that used to live here (`csv-import.ts` into `finance.sqlite`, the "NAB (Basiq)"
card drop and the Downloads-folder scan) is **retired**. Import a NAB CSV on the **Finance** page
instead. It goes into the authoritative `finance-manual.sqlite`, with a preview, per-row
validation, dedupe of overlapping exports, and corrections. See [FINANCE-NAB-CSV.md](FINANCE-NAB-CSV.md),
which also covers the one-way migration of any rows the old path left in `finance.sqlite`.

## What lights up

Once connected and synced, real numbers replace "No bank connected" in:
- The dashboard's **Income today** tile (and the 7-day figure next to it).
- The business overview's **Cash on hand**, **Monthly income** and revenue-target cards.
- Setup → Finances, as **NAB (Basiq)** alongside Mercury, PayPal and Stripe.

## Your steps

1. **Sign up at [api.basiq.io](https://api.basiq.io)** and create an app in the Basiq dashboard
   to get an API key. Basiq's sandbox is free to try; a live NAB connection needs a paid plan
   (see Cost, below). **This OS never creates the Basiq account for you** — that's a step only
   you can take.
2. **Add the key** to `~/.config/agentic-os.env`:
   ```
   BASIQ_API_KEY=your-key-here
   ```
3. **Rescan** the dashboard's Setup → Finances step. A "NAB (Basiq)" card appears once the key
   is found.
4. **Press Connect**, enter the email or mobile number Basiq should identify you by, and press
   **Connect NAB**. This opens Basiq's hosted consent page (`consent.basiq.io`) in your normal
   browser.
5. **Pick NAB and consent** on Basiq's and NAB's own screens. Nothing you type there ever
   passes through this app.
6. **Come back and rescan.** The dashboard pulls your accounts and the last 90 days of
   transactions into a local SQLite file and starts showing real numbers. It refreshes itself
   every few hours after that, or press Refresh any time.

## What's stored, and where

- `~/.config/agentic-os.env` — your `BASIQ_API_KEY`. Never logged, never printed, never sent
  anywhere except to `au-api.basiq.io` with each request.
- `.operator-data/finance.json` — your Basiq user id and consent bookkeeping. No credentials.
- `.operator-data/finance.sqlite` — synced account balances and transactions. This stays on
  this computer; it is not committed to git and is not sent anywhere except back into the
  dashboard's own finance record.

## Cost

Basiq bills **per unique user you create**, not per bank connection — so this one NAB
connection is one billed user regardless of how many NAB accounts it has. As published on
[basiq.io/pricing](https://www.basiq.io/pricing.html) at the time of writing: the Data tier is
around **$0.50 per user per month** plus a platform access fee, with a minimum 12-month
plan. There is no published free production tier, but the sandbox is free to build and test
against before you connect a real account. Confirm current pricing with Basiq directly before
connecting — this OS has no visibility into your Basiq bill.

## Revoking access

Either of these fully revokes the connection; NAB stops sharing data with Basiq and Basiq
stops sharing it with this OS:

- **In your NAB app or NAB Internet Banking:** Profile → Data sharing (or search "Data
  sharing" in the app) → find Basiq → Stop sharing.
- **In Basiq:** ask Basiq support to delete the connection/user, or use the Basiq dashboard's
  consent management if your plan exposes it.

After revoking, this OS's local balances and transactions stay in `.operator-data/finance.sqlite`
until you delete that file yourself — revoking consent stops new data arriving, it does not
retroactively delete what was already synced here.

## Safety notes

- Read-only scopes only. No payment-initiation or write endpoint is ever called.
- Bank credentials never reach this app — you type them only on NAB's own screens, inside
  Basiq's hosted consent flow.
- This OS never creates a Basiq account on your behalf.
- Nothing in this feature suggests interest-bearing products, loans, or other financial
  products — it only reports what NAB already reports to you.

## Invoice matching

If a local `.operator-data/invoices.json` file exists (a simple array of
`{ id, reference, amount, issuedAt, dueAt }` objects — there is no invoicing feature built into
this OS yet), incoming NAB credits are matched against it by amount, reference text, and a
date window, each match carrying a confidence value. Matches are recorded locally
(`invoice_matches` in `finance.sqlite`) and never written back to NAB, Basiq, or any external
invoicing system.

## Ask Jarvis

Once connected, Jarvis can answer "how much came in today", "how much came in this week",
"what's my balance", and "who's paid" from the locally-synced figures — no extra Basiq calls
per question. See `docs/FINANCE-JARVIS-HOOK.md` for how that's wired in.
