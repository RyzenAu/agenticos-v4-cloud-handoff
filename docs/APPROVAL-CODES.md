# Approval codes (B2 approval service, Track 6, 28 Sep 2026)

There are two one-time code formats. Anything that relies on them (away mode, away payments, memory
forgets, coding applies) uses exactly these. They are defined in `scripts/approvals/service.ts`.

| Code | Format | What it answers | Where it's typed | Where it's checked |
|---|---|---|---|---|
| **Away code** (`awayCode`) | 4 characters, letters and digits, at least one digit: `K7PQ` | away mode: `away.run`, `away.payment` (the payments track relies on this format) | "approve K7PQ" / "deny K7PQ" in the owner's own Telegram DM, or on his OS card for a request he made himself | away mode (`scripts/away-mode/runner.ts`) and B2 `decide`: 3 wrong codes per approval reject it |
| **Telegram code** (`telegramCode`) | 8 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, written with a dash: `K7PQ-M4XZ`. The alphabet has no 0/O, 1/I/L or U (about 8.5 × 10^11 codes) | any request a PROCESS made: a memory forget from Claude Code or Hermes, a coding apply | "approve K7PQ-M4XZ" / "deny K7PQ-M4XZ" in the **requester's** own Telegram DM. Case, and a space instead of the dash, are fine; the separator is required | B2 `claimCode` via `scripts/approvals/telegram-codes.ts`, then B2 `decide` |

A code is sent only to the right person's own Telegram DM (people.json), through `hermes send`, and is
never returned to the program that asked. It is stored only as an HMAC under a key held in memory, so a
restart makes every outstanding code unusable. Asking again sends a fresh one, and a spoken yes still
works.

## Brute-force limits (REVIEW-T6 findings 1 and R2)

Every Telegram-format reply is answered by the approval service and never goes on to away mode.
- **Nothing pending:** if the sender has no pending approval that holds a code, the reply is "Nothing is
  waiting for a code from you", and it is not a miss. Codes sent while nothing is pending can't be
  guesses at anything, so they can't pre-trip the owner's lockout.
- **Per requester:** a code that matches none of the sender's pending approvals is a miss. 3 misses within
  15 minutes void every live Telegram code of that person's pending approvals and lock further guesses
  until the window passes. The approvals stay pending; either founder's spoken yes can still answer them,
  and asking again sends a new code.
- **The person is told:** when a miss starts a lockout, the person whose codes are paused gets a line in
  their own Telegram DM (through `hermes send`, never to whoever posted), and the Memory page shows the
  lockout until it ends. Before, only the poster saw "paused", and the poster may be the program guessing.
- **Per approval:** every miss also counts against each of the sender's pending code approvals. A code
  dies after 3, and 3 wrong codes through `decide` reject the approval.
- **Relay rate limit:** `/__away/telegram` accepts at most 30 messages a minute per Telegram sender, and at
  most 5 code-shaped replies (either format). Beyond that the reply is "paused for a minute", and nothing
  runs. Eviction is fair: the limiter tracks 1,000 senders. Idle entries go first, then the oldest
  unknown sender, and a person listed in people.json is never evicted, so posting as 1,001 fake senders
  can't reset the owner's counter.
- Ordinary text is never a code: "approve payments" or "yes everyone" has no separator, so it isn't
  counted.
- **Delivery:** a program's code shows as "sending" until `hermes send` finishes, then "sent" or
  "not-sent".
- **Binding:** an approved-but-unused approval can only be used by the person who approved it.

## Deploying the new format

The installer puts the **T6-only variant** of the away-mode plugin into Hermes
(`scripts/away-mode/hermes-plugin-installed/`): the plugin installed on 28 Sep (pre-S2, f334ab7) plus the
3-line pattern that relays `approve XXXX-XXXX` as a command. S2's money pre-check
(`scripts/away-mode/hermes-plugin/`) stays out of the installed plugin; the owner declined it. Until the
variant is installed, an 8-character reply goes to the Hermes agent as chat, and a program's approvals
use a spoken yes. The commands, the backup and the rollback are in `docs/t6-memory/WRITER-CAPABILITY.md`,
step 1b.
