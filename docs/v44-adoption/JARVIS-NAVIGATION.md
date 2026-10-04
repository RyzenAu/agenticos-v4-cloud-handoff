# Jarvis navigation and V4.4 voice controls — 30 September 2026

## Scope

Continue the owner's existing Windows Jarvis work without replacing Jev, the job system, memory, provider settings or previous Claude/Codex work. Sequential implementation in D:/AgenticOS-v44-adoption, based on 23db378. The owner's standing finish-and-merge instruction authorises local integration. No agents or external deployment.

## Changes

- Distinct controls with identical labels remain separate Jev candidates. Duplicate accessibility nodes occupying the same rectangle still collapse. Repeated labels include their occurrence in reading order.
- Click/key verification observes delayed changes for up to 2.3 additional seconds without repeating the action. Cancellation ends observation before another decision/action.
- Browser/Electron snapshots include at most 20 visible headings and status/alert/live-region texts. These are read-only Text nodes, never click targets. Existing private/instruction-like label filtering applies before Jev receives them; there is no full-page scrape.
- Jev can choose a bounded wait step while a page is loading. It consumes the existing loop budget and performs no input.
- Existing free-pipeline Voice settings now has collapsed customisation: humour, an editable tone description, and speech speed 0.85–1.15×. Old reply-style preferences and the default persona remain compatible. Preferences are local to this browser; failed saves keep the previous selection.
- Typed and spoken free-pipeline turns carry the same bounded tone preference. The description is quoted and marked as tone only; tool/approval/outcome rules remain in their existing executors.
- Speech speed applies to decoded clips and streamed PCM. Streaming schedules each block using its duration divided by the playback rate. This adjusts playback pitch as well as rate; the default stays 1×. Changes apply to subsequent clips/blocks without reconnecting.

## Verification completed before the full gate

- 212 focused tests passed across the voice/client/personality/control group; 78 passed across control/hardening after adding status evidence.
- Regression proof: the delayed-page test and repeated-button Chrome fixture fail against the previous source and pass with these changes. Temporary baseline substitution was isolated and restored in finally blocks.
- Real fresh Chrome, fabricated loopback page, scripted typed decisions: selects the second of two Open buttons, observes Loading, waits three times and sees Beta opened. Five scripted decisions, one action, zero first-row actions and zero provider calls. This verifies the integration, not live Jev inference.
- Interactive component at desktop/mobile widths 1280/360: keyboard controls, persistence/reload, reset, collapsed customisation and failed-storage handling pass; no horizontal overflow. Both black/gold screenshots reviewed.
- Actual Chrome Web Audio with a generated silent fixture and synthetic input stream: decoded clip at 1.1× and four contiguous PCM blocks at 1.1× pass. No physical microphone, recorded audio, STT/model request or paid voice generation.
- Live runtime readiness endpoint reports configured free voice with Groq, Gemini and ElevenLabs available and ElevenLabs selected for TTS. This is configuration evidence, not a live provider call.

## Still open

Physical microphone/recognition and open-ended live Jev inference are not certified by synthetic tests. Cold native startup, remote-device journeys and arbitrary desktop workflows also remain open. Other V4.4 gaps: full provider voice experience, main dashboard plan meters, full Reels studio, unified memory source/relationship presentation, and installed voice-to-coding acceptance. Customisation currently applies to the existing free voice pipeline, not all provider engines. No claim that the entire OS or arbitrary computer assistant is finished.

References used for the existing typed integration: https://docs.typesafe.ai/api , https://docs.typesafe.ai/confidence , https://docs.typesafe.ai/cookbooks/function_calling .

## Release gate and local integration

The first broad run had 9,672 pass, 13 skip and one failure: the synthetic AudioBufferSource mock lacked the standard playbackRate AudioParam. Typecheck and build passed. The mock now implements that property and checks default rates plus a speed change between two replies without reconnecting. The affected lifecycle/client/personality group passes 83/83. Production code was unchanged after that first gate. A fresh full gate is required below; do not call the initial run clean.

Frozen-source full scripts gate: 9674 pass; 13 skip; 0 fail; Ran 9687 tests across 557 files. [583.23s]. Typecheck and production build exit 0. Local integration is authorised; this report does not assert live provider or microphone acceptance.
