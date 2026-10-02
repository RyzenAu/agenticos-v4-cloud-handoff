# Jarvis voice turn-taking (Agent G, 1 Oct 2026)

Branch `prog/g-voice-20261001` (from `prog/integration-20261001`). Scope: the existing free pipeline (Groq/Gemini brain, ElevenLabs TTS, browser capture). Selected voices, engines, humour/tone/speed settings and provider configuration are untouched.

Reference: LiveKit Agents, `https://github.com/livekit/agents`, read at commit `d251b89e61fe5f8ba78e0b39b501d91b0856a2d0` (30 Sep 2026), licence **Apache-2.0** (verified via the GitHub licence endpoint), plus the turns documentation page. Patterns adapted only; no code copied, no framework installed. The docs page states no numeric defaults for delays or timeouts, so every number below is our own choice.

## 1. Pipeline map (before this work)

| Stage | Where | Behaviour |
|---|---|---|
| Capture | `src/lib/free-voice-client.ts` `startFreeVoice`, AudioWorklet `capture-processor` | one `getUserMedia` (echo cancel, noise suppress, AGC); 20 ms frames, downsampled to 16 kHz; 300 ms pre-roll |
| VAD / endpointing | `createVad` | RMS energy; start after 150 ms; **ends after 800 ms silence**; <350 ms speech discarded; 30 s cap; while Jarvis speaks the bar is 2.5x and 250 ms (barge-in guard) |
| Interrupt | `interrupt()` | at 350 ms voiced, **or at VAD end**, the whole turn was invalidated: playback stopped, queued TTS aborted, **and the running tool/job aborted** |
| STT | `options.stt` to `/voice/free/stt` (Groq) | whole utterance as WAV; noise phrases dropped; optional browser partials feed the "reflex" (act while speaking) |
| Turn decision | `handleUtterance` | a bare stop phrase was silently dropped; echo check; otherwise straight to the brain. No duplicate guard. |
| Command / job | `runModelLoop` to `onTool` to `jarvisCommand` to `/screen/command` (`scripts/jarvis-command/service.ts`) | typed and spoken share it; service dedupes the same words for 5 s (`DEDUPE_MS`); `STOP_WORDS` cancels via the job service |
| TTS playback | `speak`, `playPcmStream`, `playBuffer` | first sentence streamed (ElevenLabs), rest prefetched; token + generation guard |
| Mic | one stream for the session | a device change or permission blip ended capture silently |

Gaps this exposed: a pause inside one sentence (800 ms) sent half of it, and a continuation then **discarded the first half** (the second utterance's audio replaced it); any 350 ms noise killed a reply *and* cancelled a running job before a word was transcribed; "stop" while a job ran was dropped without cancelling; a dead mic was never recovered; no duplicate guard on the brain path.

## 2. Measured behaviour (existing instrumentation)

`scripts/voice-latency.ts` logs speech-end, route-decided, action-started and action-done per command to `.operator-data/voice-latency.jsonl`; `scripts/voice-latency-report.ts` gives p50/p90 by route. **The live jsonl was not read** (it is private live data on the 8081 app). Committed bench results (`docs/jev-bench/voice-latency-*.json`, 24 Sep, 5 questions, reply to first audio): brain plus grouped TTS median 1928 ms; first sentence alone 1608 ms; streamed first sentence 1009 ms; with early brain 1004 ms. That is brain-to-audio only. The endpointing floor sits in front of it: 800 ms of silence plus STT before any of that, which is what the change below trims.

Synthetic timing from the new tests (100 ms PCM frames, fake Web Audio): barge-in pause at the 3rd frame (300 ms of speech, bound 250 ms + one frame); cancel of playback and every TTS fetch by frame 8 (under 0.9 s); a complete command reaches the brain within 300 ms of the transcript (no hold).

## 3. Gap table (LiveKit turn patterns)

| LiveKit pattern | Ours before | Decision | Now |
|---|---|---|---|
| min/max endpointing delay | one fixed 800 ms | **Adopt**, text-aware | VAD min 650 ms (150 ms faster on a genuine end); after STT a hold of up to 1.5 s for a trailing filler/connector ("um", "and", "then"), 1.3 s for a dangling "go to / search for" with no end punctuation, 0.8 s after a comma; hard cap 2.6 s from end of speech |
| Turn detector model (audio+text) | none | **Adapt, heuristic only**; a model is a new dependency and owner-mic evidence is needed first | `endpointHoldMs` over the transcript |
| Continuing after a false end of turn | lost the first half | **Adopt** | an unsubmitted utterance merges into the next one (audio joined, STT re-run) |
| Interruption (min duration) | cancel at 350 ms voiced, task killed too | **Adopt** | pause at barge-in start (250 ms, 2.5x bar); confirm at 500 ms voiced cancels speech and every queued/in-flight TTS chunk; **the task is not touched** until the words say so |
| False-interruption resume | none | **Adopt** | noise, empty/hallucinated transcript, echo of his own voice, or a blip under minimum speech resumes playback exactly where it stopped (AudioContext suspend/resume); 2 s window |
| min_words | n/a | Skipped: the transcript check (noise/echo/stop) plays that role | |
| Preemptive generation | "reflex" (show-only actions from partials) | **Not extended.** Speculative brain calls would double model spend and risk side effects on tool turns; existing reflex already covers the safe case | unchanged |
| Session resilience (reconnect) | none | **Adopt** | `createMicReconnector`: ended track, 3 s mute, or devicechange; up to five tries (0, 0.4, 1, 2, 4 s); permission denial stops at once; session, history and tasks untouched |
| Duplicate turns | none on brain path | **Adopt** | `createDuplicateGuard` (5 s, shared by typed and spoken); failed turn forgotten; answers and one-word commands exempt. The command service's own 5 s dedupe stays the authority for commands |
| Stop semantics | drop | **Own design** | see table 4 |

## 4. "Stop" rules (`classifyStop`)

| Said | Jarvis speaking | Task running | Result |
|---|---|---|---|
| quiet / shut up / shush / enough / wait | any | any | stop speaking only |
| stop / cancel / never mind | yes | no | stop speaking |
| stop / cancel / never mind | no | yes | cancel the task (existing abort path, then "Stopped.") |
| stop / cancel / never mind | yes | yes | stop speaking, ask "Stop the task too?"; yes cancels, no carries on, anything else is a new request (15 s) |
| stop that task / cancel the job | any | yes | cancel the task |
| stop that task | any | no | "Nothing is running." |
| stop | no | no | nothing |

Cancel goes through `invalidateCurrentTurn`, which aborts the tool signal and so the existing `/screen/command` cancel path (server `STOP_WORDS`/job service). `scripts/jarvis-command/**` is **not edited**. Typed "stop" still goes to the server's `STOP_WORDS`.

## 5. Files changed

- New: `src/lib/voice-turns.ts` (pure rules), `scripts/voice-turns.test.ts` (24 tests), `scripts/jarvis-execution/voice-turns-client.test.ts` (22 tests, synthetic PCM + fake Web Audio), this doc.
- Edited: `src/lib/free-voice-client.ts` (the turn state machine), `src/components/operator/voice-companion.tsx` (+6 lines: `onMicStatus` notes; no visual change), `scripts/jarvis-execution/voice-lifecycle.test.ts` (scripted STT now returns distinct text per turn, because identical text inside 5 s is now correctly one command).
- Not touched: voices, engines, provider settings, `scripts/jarvis-command/**`, wake word, `companion/mic-lock.ts` (process-level mic ownership, unrelated to in-browser stream recovery).

## 6. Evidence and limits

Synthetic only: generated PCM, a fake AudioContext/worklet, scripted transcripts. Mutation check: disabling the merge and the pause makes 5 of the new tests fail. **A physical microphone test is still owed by the owner.** Unverified until then: real Chrome `AudioContext.suspend()/resume()` feel, the 650 ms and hold values against his real speech and room, echo behaviour on his speakers, real device unplug. The fake does not prove browser suspend semantics.

## 7. Owner 5-minute microphone test

Setup: Chrome, the OS app, Jarvis panel, speakers (not headphones, to exercise echo). Note the time of each step; latency lines are in `.operator-data/voice-latency.jsonl` (`bun scripts/voice-latency-report.ts`).

1. **Cold start (30 s).** Reload the page, press Voice, allow the mic. Expect: greeting, phase goes listening. Look at the orb and the activity note "Jarvis is listening".
2. **Wake/activate.** Say "Hey Jarvis" (or press the orb). Expect a chime, then listening.
3. **Natural compound command (1 min).** Say, pausing naturally where you would: "Open a new Chrome tab, go to YouTube and search for Sydney weather." Expect: one request (not two), no cut at the commas, answer starts within about a second of your last word. Fail if it acts on only the first clause, or acts twice.
4. **Fast end.** Say "What time is it in Sydney?" and stop. Expect an answer clearly faster than before (about 150 ms less waiting). Say "Open a new tab and..." and trail off for a second before finishing: expect it to wait and join the halves.
5. **Interruption mid-reply (1 min).** Ask "Tell me about the history of the Sydney Harbour Bridge." While it speaks, say "Actually, what's the weather?" Expect: the reply stops within about a second, the new question is answered, no leftover audio from the old reply. Then cough or tap the desk mid-reply: expect a brief hold and the reply **resumes** where it stopped.
6. **Stop speech.** During a long reply say "quiet". Expect silence, no task cancelled, no new answer.
7. **Stop that task (1 min).** Start a slow job (for example "research halal brokers in Australia" or any coding delegation). While it runs and Jarvis is silent say "stop that task". Expect "Stopped." and the job shown cancelled in Tasks. Repeat, but say plain "stop" while Jarvis is speaking its "On it." acknowledgement: expect it to stop talking and ask "Stop the task too?"; answer "yes" (cancels) or "no" (keeps running).
8. **Mic reconnect (30 s).** Unplug/replug the headset or switch the input device in Windows sound settings while Jarvis is listening. Expect the note "Microphone lost, reconnecting" then "Microphone reconnected" within a few seconds, no new session, next command works. If it says the microphone isn't available, that is the failure path: report the device.
9. **Duplicate.** Type "open the operations page" and immediately say the same. Expect a single navigation.

Where to look: orb phase, the activity notes, Tasks for job status, the latency report, and the browser console for errors. Report: any step's failure, and any moment it cut you off or talked over you.
