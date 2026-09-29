# Film Jarvis: what shipped (23 Sep 2026)

Research: NotebookLM "Film Jarvis features" (`d0fc2c24-fcc2-4f41-b7b3-bb7ef8d7d5c0`, 42 sources:
the Hermes cron/Telegram/TTS/voice/Home Assistant/Bot Mode docs, Groq and Deepgram STT docs, MDN
`interimResults`, plus builds and papers on proactive assistants, wake words and speculative voice).
The questions on Home Assistant costs and streaming STT behaviour went unanswered (NotebookLM stopped
responding), so §5 is marked unverified.

## What you'll notice

- **7:30 every morning** a Telegram message from Jarvis: unread email count with urgent / today /
  later triage, calendar (or the one-line fix while Google isn't connected), and system health.
- **Silence, unless something breaks**: the watchdog messages you only when the OS stops answering,
  a capability turns broken, or the supervisor had to restart something.
- **Voice notes to Jarvis on Telegram are understood** (Groq Whisper). Send `/voice on` once in
  the chat and he answers voice notes by voice.
- **Voice settings → Act while I speak**: with it on, "show me YouTube", "open my calendar" or
  "open github dot com" happen while you're still talking (about 250 ms after the words settle).
  Anything else waits for you to finish, exactly as before.

## 1. Morning brief + watchdogs

| Job | Schedule | Mode | Delivers to |
|---|---|---|---|
| `morning-brief` (`c60f5ba54ac3`) | `30 7 * * *` (machine time, Sydney) | agent (GPT-6 Sol) + skills `jarvis-capabilities`, `jev-decisions` | `telegram:8550678495` |
| `jarvis-watchdog` (`d9dc2f6b49fb`) | every 15 min | no-agent script `%LOCALAPPDATA%\hermes\scripts\jarvis-watchdog.py` | `telegram:8550678495`, only on change |

- The brief is read-only by instruction: Gmail read tools only, no sends, replies or labels.
- The watchdog is stdlib-only. It keeps its state in `.jarvis-watchdog-state.json` beside the
  script and reports each problem once (and its recovery once).
- The Hermes gateway runs the scheduler, so the watchdog can't see a dead gateway. The supervisor
  restarts it within about 3 minutes, and the next watchdog run reports that restart.
- Manage with `hermes cron list | pause | resume | run <name>`.

Cost: one GPT-6 Sol run a day on the ChatGPT subscription, one `claude -p` Gmail read on the Max
subscription, and one Jev call for ≤15 subjects (TypeSafe, small). The watchdog uses no model.

## 2. Telegram voice notes

- `GROQ_API_KEY` copied into `%LOCALAPPDATA%\hermes\.env` by a script that never printed it.
  Backup: `hermes\backups\.env.bak-20260923-groq`.
- `stt` toolset enabled for Telegram (`hermes tools enable stt --platform telegram`); `stt.provider: groq`.
  The CLI rewrote `config.yaml`: blocks reordered, one comment dropped, and the Telegram preset expanded into an
  explicit toolset list. Backup: `hermes\backups\config.yaml.bak-20260923-stt`.
- Spoken replies: `/voice on` in the chat (voice replies to voice notes only) or `/voice tts` (voice replies to everything).
  TTS provider is Gemini, as configured.

Groq free tier: whisper 2,000 requests/day (see memory note).

## 3. Act while I speak

```
browser SpeechRecognition (interimResults, en-AU) while the VAD is recording
  → text stable for 200 ms (PARTIAL_STABLE_MS)
  → POST /__operator/voice/free/reflex {text}
  → Jev fan-out (lane, page, site, complete, addressed, stakes)
  → speculativeToolCall: navigate / open_url only, when lane ≥0.9, target ≥0.9,
    complete ≥0.8, addressed ≥0.7, stakes <0.2
  → run once for this utterance
final Groq transcript → if it still contains ≥75% of the partial's words (partialStillHolds),
the action is recorded as this turn's tool call and the brain just confirms; otherwise the
brain is told what already ran and does what he actually asked
```

Safety: never control_pc, email, memory or anything with arguments to write. A reflex answer that
arrives after the utterance was handed to the final turn is dropped (`consumedId`), so nothing runs
twice. Off by default because the browser's recogniser sends audio to the browser vendor.

Finding: plain "open YouTube" scores ~0.76 on the lane (Jev can't tell the app from the site), so
it correctly waits; "show me YouTube" scores 1.0.

## 4. Hermes Bot Mode for the founders' group: blocked on the owner

Needs, in order:
1. Create the Telegram group (Usman, Mehroz, @MnUJarvis_bot) and lock it with `TELEGRAM_GROUP_ALLOWED_CHATS`.
2. BotFather: one new bot per specialist (e.g. `@MnUResearch_bot`, `@MnUCreate_bot`). Each Hermes
   profile needs its **own** token (Telegram rejects one token polled by two gateways).
3. Then: `hermes profile create researcher` / `creator`, each with its own gateway and token;
   `exclusive_bot_mentions: true`, `require_mention: true`, `bots_require_mention: true` (loop
   guard); memory writes on the orchestrator only (specialists get memory read-only).
4. Headless install: `message_agent` needs a session titled "Bot Chat" and
   `ui_meta: { hermes-bots: {} }` in each `profile.yaml`.

Limits: 2–6 bots per room, 3 rounds per message, ~60 MB RAM per warm bot, and bots can't interrupt
each other mid-turn.

## 5. Proposals (costs unverified; check current AU prices before buying)

| Option | What you get | Rough cost | Notes |
|---|---|---|---|
| Home Assistant Green hub + Hermes `homeassistant` toolset | lights, plugs, climate, sensors by voice/Telegram; Hermes blocks shell/python service domains by default | hub ~A$160–220 one-off; Zigbee dongle ~A$50; $0/month local | long-lived access token in Hermes env; start read-only (`ha_get_state`), then allowlist devices |
| Camera: OpenClaw Windows Hub or Android node (`camera.snap`, explicit opt-in) | "what's at the door" snapshots through the relay (brief A) | $0 extra with an old phone | privacy-heavy commands need `gateway.nodes.allowCommands`; always ask first |
| Camera: RTSP camera + local vision model | continuous watch, event alerts | camera ~A$60–150; GPU time local | heavier; only after the above proves useful |

## Acceptance (all PASS, 23 Sep)

| Test | Result |
|---|---|
| `proactive.morning-brief` | job active, last run ok to telegram:8550678495, delivered text in shape |
| `proactive.watchdog` | simulated recovery reported, second run silent |
| `voice.telegram-notes` | provider groq, 100% of words heard |
| `voice.early` | 9/9 partials correct (acts only on show-only requests), median 259 ms |
| `voice.routing` (regression) | 8/8 |

Not tested with a real microphone (the owner's spoken test is still on the handover list).
