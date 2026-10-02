# Jarvis task follow-through — 30 September 2026

## What the user expects

Natural voice instructions should produce a continuous sequence of actions on the intended computer: open, observe, navigate, verify and recover. Jev remains the decision layer. Existing business, memory and coding systems must be preserved. The selected V4.4 adoption does not establish feature parity or a reliable general desktop assistant.

## Confirmed defects addressed

- A generic browser timeout did not match the old connection-error pattern, so Chrome startup could be skipped. The browser skill now checks for available tabs and starts the controllable browser when needed before navigating.
- A new-tab timeout can occur after the action. The adapter compares tab IDs before and after, confirms only one newly created matching destination, and never blindly repeats navigation.
- PC/browser tool outcomes could go back through a model and become a generic acknowledgement. Single-action results are now spoken directly; PC launch wording is no longer prefixed with “Done”.
- Bare completion acknowledgements on direct computer-action requests trigger one tool retry. If that retry produces no action, the reply explicitly says nothing was carried out.
- “Start Claude” now matches an exactly named installed app instead of being excluded as a website alias. The same distinction applies to ChatGPT and Codex. Installed Claude was verified through Start-menu metadata; no account content was inspected.
- An explicit search-and-open-first-result request previously stopped at search. Its successful result now continues through the existing screen-control loop, requiring a matching results page and destination verification. This does not introduce a second decision engine.

## Evidence and limits

- Fresh focused voice/browser/app/routing run: 512 passed, zero failed across nine files, including synthetic search → screen action → result and failed model retry sequences.
- Full scripts run: 9,654 passed, 13 skipped, one failed across 554 files (523 seconds). The new installed-app assertion ran against pc-hands loaded before its edit during that run. A fresh run of the affected nine files passes. The full suite was not rerun after that edit; do not report it as a clean full-suite run.
- Final typecheck passes. Production build is checked separately.
- Actual installed Chrome and agent-browser successfully navigated an isolated local test directory, clicked its link and read the destination title. This used a fresh synthetic headless profile, no personal tabs or provider calls.
- A clean Chrome new-tab probe succeeded; the user's original timeout was not reproduced. The normal local CDP endpoint was unavailable when checked. This does not establish its state at the original failure.
- No physical microphone, user desktop foreground, live Jev decision or arbitrary application workflow is certified by those tests.

## Remaining work, in order

1. Verify cold-start Chrome and launching the intended Claude application visibly through the live OS.
2. Trace speech recognition → route → executor → observed outcome using bounded metadata, without private audio/transcript capture.
3. Replace the restricted combined-command experience with continuation on the existing shared job system. Preserve exact target-device routing, stop/cancel, action approvals and ambiguity handling. Avoid replaying an uncertain previous action.
4. Test realistic flows: open a site and navigate; open an installed app and work within it; refer to “this” or “the next one”; interrupt; recover from slow/loading/missing UI.
5. Continue the separately recorded V4.4 parity gaps: full voice controls, personality controls, dashboard meters, complete motion workflow and consistent memory entry points. Do not replace Jev or import upstream demo data as real data.

Success means observed completion of those journeys. Passing unit tests or changing the reply style alone does not meet it.
