# Provider fallback order, by job

One page: for each job this OS actually does, what runs first, what it falls to, what happens once
that's exhausted, and one command to check each link is alive. Every command below is a plain,
unauthenticated ping — none of them send or print a key. Run dates are 26 Sep 2026, from this
worktree; re-run them yourself before trusting a stale result.

None of these commands modify anything or spend a paid call — they're chosen specifically to be
safe to run any time, including repeatedly. (`claude -p "..."` is deliberately **not** used as a
health check here — see the "Claude probe usage leak" note below.)

## 1. Coding agent

**Primary — Claude Code** (Claude Max 20x subscription). **Fallback — Codex via Hermes' pooled
ChatGPT accounts** (3 pooled accounts, currently on `gpt-6-sol` — see
`scripts/hermes-api.ts`/`scripts/jev-hermes.ts`). **Last resort — DeepSeek** (API key, metered).

- At usage limits: Codex's 5-hour/weekly window is read the same way `/usage` reads it
  (`GET chatgpt.com/backend-api/wham/usage` per pooled account — see `docs/AI-USAGE.md`). Hermes
  rotates across its 3 pooled accounts before it needs DeepSeek at all; DeepSeek only comes in once
  every pooled account is genuinely exhausted.
- Claude Max itself has no code-level fallback — Claude Code is a separate tool the operator drives
  directly, not something this OS calls out to and retries.

**Health checks:**
```
claude --version                              # Claude Code CLI present and runnable
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8642/health   # Hermes gateway (Codex path) warm
```
Run 26 Sep 2026: `claude --version` → `2.1.278 (Claude Code)` (alive). Hermes health → `200` (warm).

## 2. Image gen

**Primary — GPT Image 2 via Hermes' pinned Codex account** (`scripts/site-draft/gpt_image_codex.py`,
pinned to one named pool entry, `openai-2`/Usman's ChatGPT Plus — never the rotation; refuses with
exit 4 rather than silently using a different account). **Fallback — kie.ai** (`scripts/gen-image.ts`,
API key, default model `nano-banana-2`). **Last resort — kie.ai's other models**
(`gpt-image-2`, `flux-max` on the same kie.ai key, for when `nano-banana-2` itself is degraded).

- At usage limits: the pinned-account script refuses outright (exit 4) rather than falling back to
  another pool account or another provider on its own — a human/Jarvis decides whether to wait out
  the Codex 5-hour window (seen live 25 Sep 2026) or switch the call to kie.ai.

**Health checks:**
```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8642/health          # Hermes gateway (GPT Image path)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.kie.ai/api/v1/jobs/createTask -H "Content-Type: application/json" -d "{}"   # kie.ai reachable
```
Run 26 Sep 2026: Hermes health → `200`. kie.ai `createTask` (no key sent, deliberately) → `200`
(endpoint reachable).

## 3. Video understanding

**Primary — direct Gemini** (`gemini-flash-latest`, free — `scripts/llm/gemini.ts`). **Fallback —
OpenRouter** (`google/gemini-2.5-flash-lite`, pinned to the `google-ai-studio` provider for YouTube
links — Vertex AI rejects them). **Last resort — none automated**: `watchVideo` only supports
YouTube; a non-YouTube source needs `yt-dlp` locally first, which isn't installed and isn't wired up
(documented in `watchVideo`'s own comment, not implemented).

- At usage limits: a 503 ("high demand"/`UNAVAILABLE`) or 429 from the direct API is now retried
  with backoff (10s, 20s, 40s — `HIGH_DEMAND_RETRY_DELAYS_MS`) before falling over to the paid
  OpenRouter path, since the direct call is free and the retry is cheap. A 404 (retired model) or a
  `RESOURCE_EXHAUSTED` quota body falls over immediately, unretried — those aren't "busy", they're
  broken or actually out of quota.
- `watchVideo`'s default `maxOutputTokens` is 8192 (was 1024 — Gemini's "thinking" tokens count
  against the same budget, so a whole-video answer routinely got cut off before any visible text
  came out).

**Health checks:**
```
curl -s -o /dev/null -w "%{http_code}\n" https://generativelanguage.googleapis.com/v1beta/models   # Gemini direct API
curl -s -o /dev/null -w "%{http_code}\n" https://openrouter.ai/api/v1/models                        # OpenRouter
```
Run 26 Sep 2026: Gemini direct → `403` (reachable; needs a key — a `000`/timeout would mean the
service itself is down, not this). OpenRouter → `200` (alive, public endpoint).

## 4. Bulk text (lead summaries, Hindsight retain/reflect)

**Primary — MiMo Flash** (`xiaomi/mimo-v2.6-flash` via OpenRouter, gated `MIMO_BULK=1` —
`scripts/llm/mimo.ts`). **Fallback — MiMo Pro** (`xiaomi/mimo-v2.6-pro`, same key, pricier).
**Last resort — rule-based, no model** (e.g. `issues.ts`'s own rule-built hook when MiMo is off,
capped, or its reply is rejected as ungrounded).

- At usage limits: an OpenRouter key with **zero purchased credit** (confirmed live: an account
  with a real US$9.99 balance but a $0 key cap) fails every completion with a 402 (or a 403 whose
  body mentions credits). This is now detected once per process and remembered — every later bulk
  call in the same run skips OpenRouter outright instead of re-trying and re-failing it per lead
  (`scripts/provider-config.ts`'s `openRouterCreditsExhausted`/`noteOpenRouterFailure`, shared by
  `gemini.ts` and `mimo.ts`).
- Each task also has its own hard USD spend cap read from a local ledger
  (`ISSUES_SPEND_CAP_USD` = US$1 for lead-issue targeting) — reached independently of the credits
  check above.

**Health check:**
```
curl -s -o /dev/null -w "%{http_code}\n" https://openrouter.ai/api/v1/models
```
Run 26 Sep 2026: `200` (alive). This does not confirm the *key* has credit — see the note above;
that's only known once a real completion is attempted.

## 5. Critique (design/copy review loop)

**Primary — Claude, via the local subscription bridge** (`/__claude` runs `claude -p` for Hermes,
provider `claude-sub`, pinned Claude Code 2.1.280 — advisor only, never `--bare`). **Fallback —
MiMo Pro** (OpenRouter, for an automated second opinion when the Claude bridge is down). **Last
resort — a plain rule-based checklist**, same conservative "never invent, just say less" fallback
pattern as bulk text above.

This one is inferred from the Claude subscription bridge and the design-loop skill's
builder-plus-critics pattern (`design-loop`), not a single dedicated `scripts/` module the way the
other five jobs are — there's no standalone "critique.ts" to point at.

- At usage limits: the bridge is advisor-only specifically so a Claude Max session limit never
  blocks an actual build — the coding agent itself keeps working; only the "second opinion" step
  loses its primary and drops to MiMo Pro (or the rule-based checklist if that's also capped).

**Health check:** same as coding agent's Hermes gateway check (`/__claude` rides the same warm
gateway) — `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8642/health` → `200` (26 Sep
2026, same run as above).

## 6. Voice brain (Jarvis)

**Primary — Groq** (chat models, free tier: 8k tok/min + 1k req/day). **Fallback — Gemini** (same
direct-then-OpenRouter chain as job 3 above). **Last resort — Jev's fast-path rules/cache** (a
cached or rule-matched reply with no model call at all, when both are down).

- At usage limits: Groq's free tier is small (1k req/day) and Orpheus TTS specifically is capped at
  100/day — both tracked via Groq's own `x-ratelimit-*` response headers (see `docs/AI-USAGE.md`).
  Once the daily cap is hit, voice turns fall to Gemini for the rest of the day.

**Health check:**
```
curl -s -o /dev/null -w "%{http_code}\n" https://api.groq.com/openai/v1/models
```
Run 26 Sep 2026: `401` (reachable; needs a key, as expected for an unauthenticated ping).

## Why `claude -p` isn't one of the checks above

25 Sep 2026: an automatic capability probe (`claude -p "Reply: ok"`) got re-run on every page
reload instead of once, stacking to roughly 130 calls/hour and driving the Claude Max plan from 23%
to 68% before it was caught (fixed with a 6-hour cache and a single timer — see
`claude-probe-usage-leak.md`). None of the checks in this document call `claude -p` or any other
metered completion for that reason — they ping a health/models endpoint instead, which tells you
the service is reachable without spending a real turn.
