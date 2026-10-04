# Wiring Stripe questions into Jarvis

`scripts/finance/stripe-jarvis-intent.ts` is a small, standalone, fully-tested module that
answers three spoken questions from the locally-synced Stripe figures:

- "Who owes me?" / "who hasn't paid" / "which invoices are outstanding" → `outstanding-invoices`
- "What's overdue?" / "which invoices are overdue" → `overdue-invoices`
- "When's my next payout?" / "when do I get paid next" → `next-payout`

It is deliberately **not** wired into `scripts/free-voice.ts`, `scripts/jev-router.ts`,
`scripts/jev-router-skills.ts` or `scripts/jarvis-skills/*` — those are owned by another
engineer (and had unrelated uncommitted changes in flight when this file was written). This doc
is the handoff: the lines below are everything needed to plug it in. It follows the exact same
shape as `docs/FINANCE-JARVIS-HOOK.md` (the NAB/Basiq equivalent) — if that one is already
wired in, adding this one is the same four edits again.

## The module's surface

```ts
import { matchStripeIntent, answerStripeIntent } from "./finance/stripe-jarvis-intent";
import { createStripeSync } from "./finance/stripe";

const intent = matchStripeIntent(userText); // StripeIntent | undefined, pure text match
if (intent) {
  const stripe = createStripeSync(root); // cheap; safe to create per-call or hold one instance
  const spoken = await answerStripeIntent(intent, stripe); // string, ready to speak/print
}
```

- `matchStripeIntent` is pure — no I/O, safe to call on every turn before other routing.
- `answerStripeIntent` reads only what's already synced locally (`stripe.summary()` never calls
  Stripe); it never blocks on a network request. It checks `stripe.configured()` /
  `stripe.keyStatus()` first and returns a plain-English "not connected" or "wrong kind of key"
  sentence rather than throwing, so it's safe to call unconditionally.

## Suggested hook points

Wherever the existing rules-first router checks its own pattern list before falling through to
the brain (the same spot `docs/FINANCE-JARVIS-HOOK.md` names for the NAB intent), add one more
check next to it:

```ts
// In the rules pass, before falling through to Jev/the brain:
const stripeIntent = matchStripeIntent(text);
if (stripeIntent) return { handled: true, reply: await answerStripeIntent(stripeIntent, stripeSync) };
```

If `scripts/jarvis-skills/index.ts` uses a skills-array pattern (see `scripts/jarvis-skills/weather.ts`
for the shape this codebase already uses for a similarly small, single-purpose skill), a
`stripe.ts` skill file wrapping the same two functions would fit that pattern directly — copy
`weather.ts`'s shape and swap in `matchStripeIntent`/`answerStripeIntent`. The NAB finance
module's own hook doc suggests the same thing for `matchFinanceIntent`/`answerFinanceIntent`;
if both land at once, a single `finance.ts` skill file that tries the Stripe matcher then the
NAB matcher (order doesn't matter — their patterns don't overlap) covers both with one skill
registration.

## Nothing here changes state

Both functions are read-only against locally-synced data. There is no risk of this hook
accidentally triggering a sync, a Stripe call, or any write — `stripe.sync()` is never called
from this module.
