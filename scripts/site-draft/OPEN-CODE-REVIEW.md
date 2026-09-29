# Open Code Review — optional pre-launch source review step

Evaluated 2026-09-25 (`memory/session-summaries` / `Downloads/OPEN-CODE-REVIEW-EVAL-2026-09-25.md`
has the full writeup). Verdict: adopt as an **optional** step, not a replacement for anything
already in `client-qa.ts` or the Claude Code slash commands. This file documents how to run it;
it does not wire it into `cli.ts`, and `client-qa.ts` itself is untouched.

## What it adds that `client-qa.ts` doesn't

`client-qa.ts` (this directory) and the `mu-concept-qa` / `web-quality-audit` / `webapp-testing` /
`performance` / `accessibility` skills are all **runtime and content** QA — they look at the
rendered page (claims audit, screenshots, axe, Lighthouse, links). None of them read source code
for security or logic defects. [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
(`ocr`) does that: it reads a diff (or whole files with no git needed), bundles related files, and
runs an LLM with `code_search`/`file_read` tools against each bundle, with a built-in rule set that
also catches house-style issues (hardcoded business strings, `==`/`!=`, nested ternaries, missing
null guards, React Hooks misuse).

In testing against a real client draft and a flagship demo, it found real bugs the existing stack
structurally can't see: unescaped listing data flowing into a generated HTML `style` attribute
(HTML/attribute injection), an admin-panel save/merge keyed on a mutable slug that can silently
duplicate or clobber records, an async race that lets a stale empty state overwrite published data,
and a CSS specificity collision that makes a keyboard focus ring invisible on a navy background.

It will **never** catch a broken hero image, a bad Lighthouse score, or wrong claims on a live
page — keep running `client-qa.ts` and Lighthouse/axe regardless.

## How to run it — Delegation Mode (use this by default)

No LLM API key needed on OCR's side at all — Claude Code performs the actual review using the
existing subscription, OCR only does file selection and rule-matching. Zero marginal cost beyond
tokens already covered by the subscription.

```bash
npm install --prefix <scratch-dir> @alibaba-group/open-code-review   # or npm install -g
cd <target-repo>
ocr delegate preview                       # workspace / range / commit — lists reviewable files
ocr delegate rule <path1> <path2> ...      # rule groups for those files
```

Then, as Claude Code: for each reviewable file, pull its diff with plain `git diff`/`git show`,
read the matching rule group as a checklist, review, and report Critical/High findings always,
Medium with context, and discard Low unless clearly valuable. Full workflow:
https://open-codereview.ai/docs/delegate — or install the bundled slash command:

```bash
mkdir -p .claude/commands
curl -o .claude/commands/delegate-review.md \
  https://raw.githubusercontent.com/alibaba/open-code-review/main/plugins/open-code-review/claude-code/commands/delegate-review.md
```

## How to run it — OCR-managed mode (fallback, needs an LLM key)

Only if you want OCR to call an LLM itself (e.g. unattended in CI, or Claude Code isn't the host).
Point it at OpenRouter with the ephemeral env-var route — **do not** use `ocr config set ...
api_key`, which writes the key in plaintext to `~/.opencodereview/config.json`:

```bash
export OCR_LLM_URL="https://openrouter.ai/api/v1/chat/completions"
export OCR_LLM_TOKEN="$OPENROUTER_API_KEY"
export OCR_LLM_MODEL="xiaomi/mimo-v2.6-flash"     # or whatever's configured
export OCR_LLM_PROTOCOL="openai"
ocr review --concurrency 1 --format json --output result.json   # diff mode, needs a git repo
# or, for a directory with no git history:
ocr scan --path <dirs-or-files> --concurrency 1 --format json --output result.json
```

**`--concurrency 1` is not optional.** At the default (8), both live test runs during the 2026-09-25
eval hit OpenRouter's `402 in_flight_budget_exhausted` and lost most of the review. Dropping
concurrency avoids it (untested at scale, but the failure is clearly concurrency-driven per the
error's own `in_flight_budget` reasoning).

**A partially-failed run still exits 0.** OCR isolates per-file-group failures by design, so any
automated gate must check the JSON output's `"status"` field (`"completed"` /
`"completed_with_errors"` / `"partial"`) and `"warnings"` array — not just the process exit code.

## Where this sits in the pre-launch sequence

1. `client-qa.ts` (`bun scripts/site-draft/cli.ts qa --dir <path>`) — claims, screenshots, axe, links, Lighthouse.
2. Lighthouse + axe standalone, if iterating on one page.
3. **This — Open Code Review, Delegation Mode** — source-level security/logic pass on the diff since the last review.
4. Claude Code `/security-review`.
5. Claude Code `/code-review`.
6. `mu-concept-qa` final visual/UX pass on the rendered build.
