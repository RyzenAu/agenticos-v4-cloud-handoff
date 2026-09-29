# Hermes config.yaml proposal (Stage E2): free-only fallbacks

Status: REJECTED by the owner (28 Sep 2026, chat: "can run paid deepseek, mimo and via cline models, i dont care about data, its all my data"). The lead applied it at 03:13, then reverted it on the owner's instruction: config.yaml was restored byte-identical from `config.yaml.bak-stage-e2-20260928-031334`, so the fallback is OpenRouter MiMo flash, then pro, again. Kept for the record only. Its premise (data retention and training as a constraint) no longer applies.

File: `%LOCALAPPDATA%\hermes\config.yaml` (`~/.hermes` is a junction to it). Read on 28 Sep 2026 (config version 45). No key values were read; `GROQ_API_KEY` was confirmed present in Hermes' `.env` by name only.

## Why (the risk today)

1. **Hermes can spend money silently.** `fallback_providers` is two PAID OpenRouter models (`xiaomi/mimo-v2.6-flash`, then `xiaomi/mimo-v2.6-pro`). When the Codex pool is limited (one account is at 100% weekly), every Telegram/voice/agent turn falls over to the funded OpenRouter key. V7: paid models fall back to FREE ones automatically, never the reverse, and nothing metered runs unless explicitly selected. These entries also carry no OpenRouter data policy, so private conversations could reach an endpoint that keeps or trains on them.
2. **MoA "ministry" includes a paid reference** (`openrouter` `deepseek/deepseek-v4-pro`) on every ministry turn, and two Cline free references (`deepseek-v4.1-flash`, `muse-spark-1.3`) that may train on prompts. Ministry turns are the owner's own conversation (private), so the Cline references break the owner rule "private or business data never goes to a model that trains on prompts". From Stage E2, the `/__cline` bridge refuses requests that don't declare public/synthetic data, so those two references would fail anyway (MoA then runs with the remaining references).
3. **`cline-free` default is `pixel-canary`**, which the catalogue marks EXCLUDED (stealth model, unverified); `space-bunny-alpha` is excluded too.
4. **TTS is `gemini` with no model set**, so Hermes uses its built-in default `gemini-2.5-flash-preview-tts` (superseded; the catalogue's current Gemini TTS is `gemini-3.8-flash-lite-tts`). Separately, Gemini's free tier may train on prompts, and Hermes' TTS input is its private reply text.

## The free fallback, and why only Groq

| Candidate | Free? | Trains on prompts? | Verdict for Hermes (private conversations, needs tools) |
|---|---|---|---|
| Groq `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | Yes (free plan, verified) | No | **Use.** Tool calling supported. |
| OpenRouter `:free` models (nemotron, qwen, gemma) | Yes at `max_price 0` | May train | Not for private turns. Public-only work could use them via the OS router, not Hermes' agent. |
| Cline free models | Yes (promotional) | May train; no tools | No. |
| Gemini free tier | Yes | Trains | No (private data). |
| Anything unverified-free | Unknown | Unknown | No. |

Honest limit: Groq's free tier allows 8,000 tokens a minute per model, and Hermes' agent prompt (system prompt, toolsets, history) is often larger than that. When it is, Groq answers 413/429 and the turn fails with Groq's reason. That is the intended V7 behaviour (exhaustion surfaces as a failure, never as spend). It does not make Hermes work through a Codex outage for large turns; it stops the silent spend. Short turns (most Telegram replies) fit.

## Exact diff

```diff
--- config.yaml (current)
+++ config.yaml (proposed)
@@ providers:
   cline-free:
     name: Cline free models (via the Cline CLI)
     api: http://127.0.0.1:8081/__cline/v1
     transport: chat_completions
-    default_model: pixel-canary
+    default_model: deepseek-v4.1-flash
     models:
-      pixel-canary:
-        context_length: 20000
-      space-bunny-alpha:
-        context_length: 20000
       deepseek-v4.1-flash:
         context_length: 20000
       gemini-3.8-flash:
         context_length: 20000
       mimo-v2.6-flash:
         context_length: 20000
       muse-spark-1.3:
         context_length: 20000
+  groq-free:
+    name: Groq free tier (no training; free plan limits)
+    api: https://api.groq.com/openai/v1
+    transport: chat_completions
+    key_env: GROQ_API_KEY
+    default_model: openai/gpt-oss-120b
+    models:
+      openai/gpt-oss-120b:
+        context_length: 131072
+      openai/gpt-oss-20b:
+        context_length: 131072
 fallback_providers:
-  - provider: openrouter
-    model: xiaomi/mimo-v2.6-flash
-  - provider: openrouter
-    model: xiaomi/mimo-v2.6-pro
+  - provider: groq-free
+    model: openai/gpt-oss-120b
+  - provider: groq-free
+    model: openai/gpt-oss-20b
@@ tts:
   provider: gemini
+  gemini:
+    model: gemini-3.8-flash-lite-tts
@@ moa:
   presets:
     ministry:
       reference_models:
         - provider: claude-sub
           model: claude-opus-5-5
-        - provider: openrouter
-          model: deepseek/deepseek-v4-pro
         - provider: openai-codex
           model: gpt-6-sol
-        - provider: cline-free
-          model: deepseek-v4.1-flash
-        - provider: cline-free
-          model: muse-spark-1.3
+        - provider: groq-free
+          model: openai/gpt-oss-120b
       aggregator:
         provider: openai-codex
         model: gpt-6-astra
```

Unchanged on purpose: `model.default: gpt-6-sol` on `openai-codex` (the Codex pool stays primary), `claude-sub` (subscription bridge), `auxiliary.approval` (Jev via `/__jev`, the configured guardian), `stt.provider: groq` (free, no training).

Notes on each change:
- `groq-free` is a named custom provider (`api`, `transport`, `key_env` are the fields Hermes' custom-provider resolver reads: `hermes_cli/runtime_provider_custom.py`). The key stays in Hermes' `.env` and is read by name.
- MoA: the paid DeepSeek V4 Pro reference goes (a metered model on every ministry turn, never explicitly selected per call). The two Cline references go because ministry turns are private and Cline models may train. Groq gpt-oss-120b replaces them as a free, non-training reference. If the owner wants Cline in the ministry for public-only research, that needs a separate public preset, not the default.
- TTS: `gemini-3.8-flash-lite-tts` fixes the superseded default. It does NOT fix the privacy point (Gemini free may train on the reply text). The privacy-correct choice is an on-device engine Hermes already supports (`piper`, `kittentts` or `neutts`), or ElevenLabs (metered, explicit). Decide separately; this diff only makes the model current.

## Alignment with V7 and the catalogue

- V7 3.5: paid -> FREE automatic fallback; never free -> paid; no metered model unless explicitly selected; no in-app caps. The proposed chain has no metered entry. Exhaustion is Groq's own 413/429.
- Owner rule: private data never to a model that trains. Groq is `no-training` in `scripts/model-router/catalogue.json`; Cline, Gemini free and OpenRouter `:free` are `may-train` and are removed from Hermes' private paths.
- Catalogue parity: this is the `agent.hermes` task (`codex/gpt-6-sol` -> `groq/gpt-oss-120b` -> `groq/gpt-oss-20b`). `cline/pixel-canary` and `cline/space-bunny-alpha` are `excluded` there.
- Receipts: Hermes' own model calls still produce no router receipt (Hermes is a separate process). Its `agent.log` records the model per turn; the Models page shows the Hermes route from the catalogue.

## How to apply (no Telegram disruption)

`fallback_providers` hot-reloads: the gateway re-reads it on the next agent create/reuse (`gateway/run_config_loaders.py`, `_refresh_fallback_model`, Hermes issue #60955), and a torn read keeps the last known-good chain. A session currently running ON a fallback keeps it until its cooldown ends. No gateway restart is needed for the fallback change.

1. Back up: `Copy-Item "$env:LOCALAPPDATA\hermes\config.yaml" "$env:LOCALAPPDATA\hermes\config.yaml.bak-stage-e2-$(Get-Date -Format yyyyMMdd-HHmmss)"`
2. Write the edited file to `config.yaml.new` in the same folder, check it parses (`& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -c "import yaml,sys; yaml.safe_load(open(sys.argv[1],encoding='utf-8'))" config.yaml.new`), then swap it in atomically: `Move-Item -Force config.yaml.new config.yaml` (a same-folder rename, never an in-place partial write).
3. Verify: `hermes fallback list` shows `groq-free / openai/gpt-oss-120b` then `groq-free / openai/gpt-oss-20b`, and nothing on `openrouter`.
4. The MoA, `cline-free` and TTS sections are read when those features next load their config. If `hermes config` / the next ministry turn still shows the old references, restart only the gateway through the existing supervisor during a quiet minute (Telegram reconnects in seconds and queued messages are kept in `pending_messages`). Don't restart the OS server on 8081.
5. Check `%LOCALAPPDATA%\hermes\logs\agent.log` on the next Codex-limited turn: the fallback line should name `groq-free`, never `openrouter`.

## Rollback

`Copy-Item -Force "$env:LOCALAPPDATA\hermes\config.yaml.bak-stage-e2-<timestamp>" "$env:LOCALAPPDATA\hermes\config.yaml"`. The fallback chain reverts on the next agent create/reuse; restart the gateway only if the MoA/TTS sections must revert immediately.
