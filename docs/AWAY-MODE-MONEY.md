# Money requests and chat (S2d, 29 Sep 2026)

## The owner's two rules

1. Money **requests** are fine.
   - "Pay the invoice", "what did I spend" and "transfer to savings" go to the normal Jarvis routing (rules, Jev, the brain) by voice and typed.
   - Nothing refuses the words themselves.
2. Payment **execution** stays off.
   - Every OS executor still refuses to move money, trade or bet: control_pc, screen_act, the browser's final-button, money-button and money-context gate, the app browser's money hosts, and away mode with away.payment off.

## The one exception: Telegram free text

**The gap.** Free text in Telegram goes to the Hermes agent. Hermes's Telegram session has the `browser` toolset (Jarvis Chrome, where he is signed in) and `computer_use` (his screen). Neither passes through the OS's gates. The only thing standing between a chat message and a pressed "Place order" would be the model's own judgement and a typed chat yes, which could come from anyone in the chat.

**The fix.** `scripts/away-mode/runner.ts` (`telegram()`) refuses money **orders** in code before Hermes, from anyone's chat. It uses `chatMoneyOrder` in `scripts/jarvis-execution/spoken-money.ts`.

| Refused before Hermes (orders) | Still reaches Hermes |
|---|---|
| "buy 1 bitcoin" | "what did I spend" |
| "place a bet" | "how do I pay a BPAY bill" |
| "settle the AGL invoice" | "remind me to pay the bill Friday" |
| "buy the AirPods on Amazon and pay with my saved card" | "draft an invoice for Bianca" |

**It only takes effect once the plugin is installed.** The runner's check is reached only when the Hermes gateway plugin sends free text to the OS.

> **Until the updated plugin is installed, Telegram free text reaches Hermes with only the SOUL prompt guarding payments.** The plugin that is live now (25 Sep) relays commands only. It does **not** relay the 8-character approval codes (XXXX-XXXX) either, so those codes typed in Telegram go to Hermes, not the OS. Check with `--verify` (below).

### The installed variant (`scripts/away-mode/hermes-plugin-installed/`, S2d and S2e, not yet installed)

What it does, message by message:
- **Commands and approval codes** ("/away on", "approve K7PQ-M4XZ") are relayed exactly as before.
- **Free text with no money words** goes straight to Hermes. Nothing is sent anywhere and there is no added wait.
- **Free text with money words** is put to the OS (1 s timeout), and the OS's shared classifier (`chatMoneyOrder`) decides:
  - an **order** is refused: "I don't pay, buy, trade or bet from a chat message…";
  - a **question or reminder** comes back not handled and goes to Hermes.
- **If the OS can't be reached** (down, hung, an error or not set up), money-worded text is refused ("I can't do payments or trades from chat.") unless it is a question, a reminder, writing or a line addressed to one of the people in the chat ("Mehroz, can you buy milk…"). Only real names count: the installer writes the first names from `.operator-data/people.json` into `relay.json`, and the OS uses the same list. "Quick, buy 1 bitcoin now", "Urgent: pay the Telstra bill" and "Listen, place a bet" are orders. Other text still goes to Hermes. An unreachable OS is remembered for 30 s.
- **The tool guard (S2e).** A two-turn chat ("shall I place the order?", then "yes") passes any per-message check, so the plugin also registers Hermes' `pre_tool_call` hook.
  - Before every `browser_*` or `computer_use` action that isn't just reading, it asks the OS (`POST /__away/tool-guard`, the relay's bearer token).
  - The OS answers with the same checks its own executors use (`scripts/away-mode/tool-guard.ts`): money buttons, the money-page context, money windows and pages, money hosts, and card numbers typed anywhere.
  - For browser input it reads the tab the tool acts on: the plugin sends the address Hermes' own browser session is on, and the OS reads the one Jarvis Chrome tab at that address. Without an address it reads the one visible tab. If it can't tell which tab (no match, two tabs at one address, two windows showing), the action is blocked.
  - Hermes gets a block message instead of the action.
  - If the OS can't be reached, browser and screen **input** is blocked (fail closed). Reading, and every other tool, carries on.

Its tests: `python -m unittest test_installed_variant`, run from that folder. `scripts/away-mode/install-hermes-plugin.test.ts` also runs them.

### Install and roll back (the owner decides; run from a normal shell in the AgenticOS-v4 folder)

1. **Install.** This copies the plugin into `%LOCALAPPDATA%\hermes\plugins\away-mode`. It first backs up whatever is there to `.operator-data\away-mode\plugin-backups\<timestamp>\` and prints that folder.

   ```
   bun scripts/away-mode/install-hermes-plugin.ts --port 8081
   ```

2. **Restart the gateway.** Run `hermes plugins enable away-mode` first if the plugin isn't enabled yet (it is on this PC).

   ```
   hermes gateway restart
   ```

3. **Check what is installed** (changes nothing). It reports whether the plugin relays approval codes (XXXX-XXXX), relays money orders, has the tool guard, and matches the repo. The install prints the same check.

   ```
   bun scripts/away-mode/install-hermes-plugin.ts --verify
   ```

4. **Roll back** to exactly what was installed before, using the backup folder the install printed, then restart the gateway again.

   ```
   bun scripts/away-mode/install-hermes-plugin.ts --restore "<backup folder>"
   hermes gateway restart
   ```

The older, broader pre-check is `scripts/away-mode/hermes-plugin/`. It refuses on a money word list while the OS is down and is not what the installer installs. It stays in the repo with its tests.

## Still open

The tool guard (above) covers only Hermes' `browser_*` and `computer_use` tools. It is not a sandbox. Known ways around it, listed as follow-ups:
- **Terminal and code execution can bypass the guard.** Hermes' `terminal` and `code_execution` tools can drive Jarvis Chrome directly over CDP on 127.0.0.1:9222 (a script that clicks "Place order"), or drive his screen (keyboard and mouse automation). Neither goes through `browser_*` or `computer_use`, so the guard never sees them. They can also call payment or exchange APIs directly. Follow-up: a `pre_tool_call` check on `terminal` and `code_execution`, or keep Jarvis Chrome's CDP port and his screen out of reach of those tools.
- **The relay token can be read (pre-existing).** Hermes' file tools and `terminal` can read the relay token file (`.operator-data/away-mode/relay.token`), and with it call the relay directly. Follow-up: keep the token where Hermes' tools can't read it, or bind it to the plugin process.

Once a `terminal` / `code_execution` check is added as well, the free-text order refusal above could be relaxed to match voice.
