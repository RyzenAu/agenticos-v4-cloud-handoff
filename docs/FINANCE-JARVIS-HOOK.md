# Wiring NAB/Basiq finance questions into Jarvis

`scripts/finance/jarvis-intent.ts` is a small, standalone, fully-tested module that answers
four spoken questions from the locally-synced NAB (via Basiq) figures:

- "How much came in today?" / "what's today's revenue" → `income-today`
- "How much came in this week?" → `income-week`
- "What's my balance?" / "check my bank balance" → `balance`
- "Who's paid?" / "which invoices have been paid" → `paid-invoices`

It is deliberately **not** wired into `scripts/free-voice.ts`, `scripts/jev-router.ts`,
`scripts/jev-router-skills.ts` or `scripts/jarvis-skills/*` — those are owned by another
engineer. This doc is the handoff: the lines below are everything needed to plug it in.

## The module's surface

```ts
import { matchFinanceIntent, answerFinanceIntent } from "./finance/jarvis-intent";
import { createFinanceSync } from "./finance/sync";

const intent = matchFinanceIntent(userText); // FinanceIntent | undefined, pure text match
if (intent) {
  const finance = createFinanceSync(root); // cheap; safe to create per-call or hold one instance
  const spoken = await answerFinanceIntent(intent, finance); // string, ready to speak/print
}
```

- `matchFinanceIntent` is pure — no I/O, safe to call on every turn before other routing.
- `answerFinanceIntent` reads only what's already synced locally (`finance.summary()` and
  `finance.invoiceMatches()` never call Basiq); it never blocks on a network request. It does
  check `finance.configured()` / `finance.status()` first and returns a plain-English "not
  connected yet" sentence rather than throwing, so it's safe to call unconditionally.

## Suggested hook points

Wherever the existing rules-first router (mentioned in the AGENTS/session notes as
"rules → Jev-first router → brain") checks its own pattern list before falling through to the
brain, add one check near the top, since this only ever returns a result when the text
actually matches one of the four finance patterns:

```ts
// In the rules pass, before falling through to Jev/the brain:
const financeIntent = matchFinanceIntent(text);
if (financeIntent) return { handled: true, reply: await answerFinanceIntent(financeIntent, financeSync) };
```

If `scripts/jarvis-skills/index.ts` uses a skills-array pattern (see `weather.ts` for the
shape this codebase already uses for a similarly small, single-purpose skill), a `finance.ts`
skill file wrapping the same two functions would fit that pattern directly — copy
`weather.ts`'s shape and swap in `matchFinanceIntent`/`answerFinanceIntent`.

## Nothing here changes state

Both functions are read-only against locally-synced data. There is no risk of this hook
accidentally triggering a sync, a Basiq call, or any write — `finance.sync()` and
`finance.connect()` are never called from this module.
