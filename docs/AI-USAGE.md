# AI usage & spend (`/usage`)

One page for every AI subscription and API key: this month's spend in AUD (fixed plans + metered
API use), a month-end projection, each plan's live share of its limit with reset times, and where
every number came from. Mission Control's "Plan limits & spend" and Business → Finance → AI show
the same snapshot in compact form.

Code: `scripts/ai-usage/` (server), `src/components/ai-usage/` + `src/lib/ai-usage.ts` (page).
API: `GET /__ai_usage`, `POST /__ai_usage/refresh`, `POST /__ai_usage/settings` (token),
`GET /__ai_usage/ask?q=…` (Jarvis). Loopback only.

## What was wrong before (24 Sep 2026)

- **Wrong plans and prices.** The "AI spend" tile added Claude US$200 + "ChatGPT Plus" US$20 and
  converted that at render time. Claude Max 20x is billed at A$340 incl. GST in Australia. The
  ChatGPT figure came from `~/.codex/auth.json` only, which is the **M&U account on the US$100 Pro
  tier** (token plan `prolite`, which the old code didn't recognise and so fell back to "Plus,
  US$20"). Usman's Plus and Mehroz's Pro, both pooled by Hermes, were missing. No GST anywhere.
- **Mixed-up Codex windows.** The ChatGPT row's percentages came from the newest Codex session
  log (Usman's Plus account at the time) under M&U's plan name.
- **Invented Claude caps.** "289 / 900 msgs" and "1,586 / 5,000" were fixed message caps the OS
  made up; the real server percentages were in the data but the reset times were hard-coded "—".
- **API-equivalent inflated.** Every transcript line was counted, but one API response is written
  as several lines that share a message id and request id. Opus 5 and Sonnet 5 were priced at the
  old Opus 4 / Sonnet 4 rates (US$15/75 and US$3/15). Fable was priced at US$0, and 1-hour cache
  writes at the 5-minute rate. Result: "US$30,519 in 30 days". This month's figure after the fixes
  is about US$6,400 (est.).
- **Missing providers.** There was nothing for ElevenLabs, Retell, DeepSeek, Groq, Gemini, Pinecone,
  Higgsfield or two of the three OpenRouter keys.
- **No Hermes cost ledger.** There is no `ledger.jsonl` under `%LOCALAPPDATA%\hermes`. Hermes'
  `state.db` marks Codex sessions `cost_status: included` at $0 and doesn't record which pooled
  account served them. `cron/usage_audit.jsonl` holds token counts for cron jobs only.

## Sources

| Item | Source | Verified / est. |
|---|---|---|
| Codex × 3 (5-hour/weekly %, resets, credits) | `GET chatgpt.com/backend-api/wham/usage` per account, with the token in Hermes' pool (`auth.json → credential_pool.openai-codex`). This is the endpoint behind Codex's `/status` and Hermes' `/usage`. Tokens are never refreshed here | Provider figure |
| Account → owner | Pool label + token claims: M&U = muventures.com.au, Usman = the Plus account, Mehroz = the other. Can be overridden in `.operator-data/ai-usage.json → owners` | Rule |
| Claude Max 20x (session/weekly/per-model %) | `GET api.anthropic.com/api/oauth/usage` (what Claude Code's `/usage` shows) | Provider figure |
| Claude tokens by model | `~/.claude/projects/**/*.jsonl`, reading only the usage, model, id and timestamp fields. Deduplicated by message id + request id | Local, this PC only |
| API-equivalent value | Anthropic list prices (`scripts/ai-usage/prices.ts`) | **est.** Not a bill |
| OpenRouter (each distinct key) | `GET /api/v1/key` (`usage_monthly`, limit) + `/api/v1/credits` | Provider figure |
| ElevenLabs | `GET /v1/usage/character-stats`. The key lacks `user_read`, so the plan and limit can't be read | Provider figure; plan fee must be entered |
| Retell | `POST /v2/list-calls` → `call_cost.combined_cost` (US cents). Transcripts are dropped unread | Provider figure |
| DeepSeek | `GET /user/balance` (prepaid; no month-spend API) | Provider figure (balance) |
| Groq, Gemini, TypeSafe/Jev, Google Places | This OS's own calls, counted by a fetch wrapper (host + path only, plus Groq's `x-ratelimit-*` headers) into `.operator-data/ai-usage-calls.json` | **est.** Floors: Hermes' calls aren't seen |
| Pinecone | Index list + vector count; Starter (free) plan assumed | **est.** A$0 |
| Higgsfield | Credits from the design ledger (Higgsfield's live quote per generation). No balance API | Provider quote; plan fee must be entered |
| Twilio | Not linked: no Twilio credentials in the OS config yet | — |
| USD→AUD | `open.er-api.com` daily rate, cached 12 h; last good rate kept (marked stale) | Reference rate |
| MiMo bulk (Xiaomi MiMo-V2.6, OpenRouter) | `scripts/llm/mimo.ts` prices every call from the response's own token usage and appends it to `.operator-data/mimo/ledger.jsonl`; `/usage` reads that ledger for a per-task breakdown (added 25 Sep 2026, see `MIMO-EVAL-2026-09-25.md`). The dollars are already inside the OpenRouter row above — this is a breakdown, not extra spend. Gate: `MIMO_BULK=1` | Local ledger (own calls only) |

Cache: each provider read lasts 15 minutes; Refresh re-reads only the local sources until a
cache expires. A failed source shows "unavailable" with its reason, never a zero.

## Prices (editable on /usage → Prices)

Defaults (24 Sep 2026): Claude Max 20x A$340.00 incl. GST, from the AU checkout (A$309.09 + A$30.91 GST). ChatGPT is billed in USD
with 10% GST added: Plus US$20, Pro US$100 (`prolite`), Pro US$200 (`pro`), Go US$8. ElevenLabs
and Higgsfield plan fees start as "not set"; until they're entered they're listed under "Not in the total". Edits are
saved in `.operator-data/ai-usage.json`.

## Jarvis: router hook lines (for the owner of `scripts/jarvis-skills/*` and `scripts/jev*.ts`)

The intent is self-contained in `scripts/ai-usage/jarvis-intent.ts` (anchored patterns, no model
call) and is served over HTTP at `GET /__ai_usage/ask?q=<utterance>` →
`{ matched, intent, said }`. To wire it into the rules stage, in `scripts/jarvis-skills/index.ts`:

```ts
// imports
import { aiUsageIntent, type AiUsageRequest } from "../ai-usage/jarvis-intent";
import { answerAiUsageQuestion } from "../ai-usage/plugin";

// SkillRequest union
  | AiUsageRequest

// SKILL_NAMES: add "ai_usage"; REMOTE_SAFE: add "ai_usage" (read-only)

// skillIntent(): before the other skill parsers
  aiUsageIntent(utterance) ??

// run(): new case (shape the return to run()'s SkillResult as the other cases do)
    case "ai_usage": {
      const said = (await answerAiUsageQuestion(utterance)) ?? "I couldn't read the usage figures.";
      // → { ok: true, said, skill: "ai_usage", ms }
    }
```

Covered phrasings (see `scripts/ai-usage/snapshot.test.ts`): "how much have I spent on AI this month",
"what's my AI spend", "how much are the AIs costing us", "which Codex account is nearly out",
"which ChatGPT account is closest to its limit", "how much Claude have I got left".
For voice navigation, `src/lib/voice-actions.ts` can also get
`{ path: "/usage", label: "AI usage", match: /\bai usage\b|\bai spend\b|\busage page\b/i }`.
