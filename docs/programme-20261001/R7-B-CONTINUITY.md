# Round 7, worker B: conversation, voice and task continuity (3 Oct 2026)

Branch `r7/b-continuity-20261003` from `491b8ee0`. Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Synthetic hub on 8122, data `D:\AgenticOS-r7-data\b`
(seeded with `seed-gate-hub.ts --host none`, plus one synthetic Research conversation for the synthetic founder `usman`). No Ryzen, no 8081, no
production data, no paid route, no client contact.

## 1. "Conversation unavailable while the page otherwise loads": the boundaries

The page used to collapse every failure into "The conversation may be out of date. The conversation could not be read (status 500). It keeps trying in
the background." (and suppressed even that while the bot was offline). Seven different causes sat behind it. Each now names itself and its next move.

| Boundary | What was wrong (HEAD) | Now | Regression test (fails without the fix) |
|---|---|---|---|
| Authentication (unpaired or pending browser, 401/403) | the hub's sentence was shown, but the safety poll kept hitting the 403 for ever | `not-paired`: the hub's own sentence plus "Pair this browser in System, then Devices and people"; no automatic retry, no Try again button | `agent-chat-read.test.ts` (401, 403 kinds); `continuity-r7.test.tsx` (no retry; notice has no Try again) |
| The saved conversations store (missing or corrupt file) | a corrupt `conversations.json` threw a plain `Error`; `/__agents/.../thread` answered a bare 500 "Something went wrong" | typed `ConversationsUnreadable`: 503 with "Saved conversations could not be read. Your history was left untouched." on the thread read, on `GET /bots/:id` and on a bot command (which now starts nothing and says so). A missing file is not a fault (empty thread) | `scripts/agents/continuity-r7.test.ts` (route 503 x2, command refused before anything starts, missing store is fine) |
| The thread read itself (5xx, hang) | no timeout: a hub that accepted the connection and stalled left `inflight` unresolved for ever, so every catch-up reused the hung promise and the page sat on "Loading the conversation" | 15 s timeout on the whole read (headers and body) with kind `timeout`; 5xx `server` with its status; fetch failure `network`; unreadable answer `shape` | `agent-chat-read.test.ts` (eight kinds, both stall shapes) |
| Retry policy | a read error latched while the live stream was healthy (the only retry was the slow poll, which runs only while the stream is down) | bounded automatic retries (2, 5, 12, 30 s) for causes that can clear, none for pairing/missing bot, then "It stopped retrying on its own" and a **Try again** that gives a fresh budget; coming back to the tab also gets a fresh budget | `continuity-r7.test.tsx` (retry while the stream is healthy; exactly 1 + N reads then stop; Try again recovers) |
| The events stream (SSE down, snapshot loops) | nothing said the stream was down; every snapshot started a full re-read from seq 0 (a flapping stream was a read per flap) | "Live updates are paused" (after 8 s down, clears when back; slow check continues); snapshots coalesce to a leading read plus one trailing read per 3 s | `continuity-r7.test.tsx` (12 snapshots cost one read; stream-down says so only after the delay and clears) |
| UI state machine: history announced | a first read that failed, then succeeded on a retry, announced every historical completion as new (`live` was set whether or not the first read worked) | "history" = whatever the first **successful** read returns; announced never; a genuinely new completion afterwards once | `continuity-r7.test.tsx` (history silent, new one notified once) |
| UI state machine: wrong conversation, empty state | an answer for bot A arriving after switching to bot B was folded into B's transcript; a failed read showed "Ask Research for something"; a thread under another id was silently dropped | generation guard drops stale answers; a failed read is an issue, not an empty thread; a different conversation id than the adopted one is an error, not silence; the read notice no longer hides behind the offline notice | `continuity-r7.test.tsx` (switch bots; other conversation; offline plus unreadable shows both) |

Real-hub evidence (screenshots in `evidence/r7-continuity/`, all `after-*`; the "before" text above is quoted from the HEAD source, not re-shot, because
re-running the old code would have needed a second worktree):
`after-1` real 503 from a corrupt store on the synthetic hub; `after-2` the same page recovered by the bounded automatic retry once the file was
restored; `after-3` not-paired (403 with the hub's own sentence, **simulated at the browser**: a loopback browser is always the owner, so a real unpaired
403 needs a tailnet browser, and the server side of that 403 is covered by the existing `scripts/agents/routes.test.ts`); `after-4`/`after-5` a network
failure (simulated at the browser) retried then given up after exactly five reads (`window.__threadReads === 5`); `after-6` Try again recovers;
`after-7`/`after-8` a send whose answer was lost.

## 2. Sends that time out after the hub may have accepted them

HEAD: a timed-out POST resolved as "Not done: I couldn't reach the command service", the bot chat showed "That did not start" with **Send again**, and
Send again minted a **new** event id, so a command the hub had in fact accepted could run twice. Now:

- `runJarvisCommand` marks a transport failure and any 5xx `outcome: "unverified"`; `api.send` passes `unconfirmed`; the acknowledgement says "Not
  confirmed ... sending again is safe, it will not run twice" and offers **Check now** (re-reads the thread; the hub's own request/acknowledgement lines
  settle it) and **Send again**, which reuses the SAME event id. A refusal the hub made is definite and Send again is a new command.
- The hub's dedupe was in memory (lost on restart and after 30 minutes). A bot turn now first looks for `<eventId>:request` in the durable conversation
  (`threads.priorCommand`): found with a reply, the reply is returned (`numbers.replayed`); found without one (the hub died between the two writes), nothing
  runs and the answer says it cannot confirm the outcome. Nothing in that path can start a job.
- A fault after a job started is reported as "Jarvis started it but hit a fault afterwards" (unverified), never as a failed start.
- Tests: `scripts/agents/continuity-r7.test.ts`, `src/lib/agent-chat-read.test.ts`, `continuity-r7.test.tsx` (hub accepted but answer lost: one job, one request line, one
  acknowledgement, no failure line; hub never got it: same id on resend; throw: "could not confirm", never "did not send"; double press sends once).

## 3. Continuity checks that already held (verified, no change needed)

Existing suites already prove: typed and spoken requests land in the verified person's `agent:<person>:<bot>` conversation and never the other founder's
(`routing.test.ts`, `continuity-r6.test.ts`); progress and completion once across live, catch-up and snapshot, and not again after a restart
(`routing.test.ts`, `continuity-r6.test.ts`, `bot-chat.test.tsx`); announced once per job per browser and not for history (`bot-chat.test.tsx`, now also after
a failed first read). New in this round: **journey J** (`scripts/agents/routine-journey-r7.test.ts`): a routine linked to Research by Mehroz, the same trigger
event delivered twice at once, again later, and again after the trigger service restarts over the same store: one task on the computer, one job of each
kind, one `:succeeded` entry and one live append notification per job, all in Mehroz's conversation; an unlinked routine starts nothing on the computer.

## 4. Reconciliation recommendation 2: "what needs me?" includes coding

`scripts/workspace/needs-you-voice.ts` takes `coding` (drafts and decisions) read from the coding store with the coding page's own needs-you set plus drafts
and plans waiting for Start (`codingWaiting`); `scripts/operator-plugin.ts` supplies it (a store that cannot be read says so, never zero). Said as its own
sentence, so Jarvis and Home do not disagree on the number, and "Nothing needs you" is never followed by waiting coding work.
Tests: `scripts/workspace/needs-you-voice-coding.test.ts` (real `CodingStore`) and the unchanged `scripts/j4` suite. Home's own count does not include coding
yet: see `R7-B-PROPOSALS.md`.

## 5. Voice

No voice or model journey was run. A synthetic WAV (Windows speech synthesis, "Ask Research to find the licence classes ...") was posted to the synthetic
hub's `/__operator/voice/free/stt`; the hub, correctly started with `AGENTIC_OS_NO_BACKGROUND=1`, refused with 409 ("a quiet read-only copy"). Enabling it
would have meant weakening the quiet-copy guard on a hub that cannot run the command that follows, so it was left off. This is **not** a microphone pass and
not a synthetic-audio pass either; it is "tried, refused by design". Spoken routing is covered by the existing server tests (`source: "voice"`, "Spoken
request." stored instead of the words) and `src/lib/voice-scope.ts` tests.

## 6. Reconciliation recommendation 3: Sydney date and email-draft parser (optional, done as pure code)

`src/lib/sydney-when.ts` and `src/lib/spoken-requests.ts` are the historical `scripts/flows/when.ts` and `parse.ts` from `refs/dot/hist/cloud/f1-flows-wip`
(commit `1e32908a`), ported unchanged apart from the import path and a provenance header. **Licence check:** that branch's `LICENSE` blob is byte-identical
to this repository's own (Claude OS, Personal & Commercial Use License with Attribution), so the code is covered by the licence it already ships under;
no third-party code. Not ported: the flows service, live ports and store. New on top: `calendarDraftFromWords(utterance, now)`, which returns the
`ChatCalendarDraft` the existing review card already takes (or one question, never a guess; null when it is not a calendar ask). Tests:
`src/lib/spoken-requests.test.ts` (19: Sydney offsets across both clock changes, day-before-month, weekday rules, durations, email asks, the card's own
`parseCalendarDraft` accepting the draft, the owner's day when the machine's clock is elsewhere).

**Not wired into the card's call sites**: those are `floating-oracle.tsx` and `voice-companion.tsx`, which B was told not to edit. The exact patch is in
`R7-B-PROPOSALS.md`. Until F applies it, nothing in the product calls the parser.

## 7. Review fixes (Opus review of 17cc437e)

1. **A failed command is never replayed as a success.** The hub's saved reply now records `ok`, `stopped` and `unverified` (conversations.ts, `threads.note`); a replay returns the original verdict (`ok` falls back to "no blocker" only for older entries without the field), and the browser prefers the hub's `ok` over its own (an unconfirmed line is settled by the hub's verdict, so a failure keeps its Send again).
2. **A request that never ran can be retried.** A run that throws now writes a failure reply (`ok:false`, `unverified` only when a job or receipt may exist). A request with no reply is "unverified" only if a `started` receipt after it, or a job for that bot created since, exists; otherwise a Send again with the same event id runs it once, and its real reply replaces the failure one (`replace`, a new seq, which the browser takes as newer).
3. **Device requests typed in a bot chat** are not bot turns and have only the hub's in-memory window (30 minutes, lost on restart). Rather than promise more, the unconfirmed-line copy no longer says "will not run twice": it says the same request is sent and the hub recognises it if it already has it.
4. **Durable dedupe is bounded**: a conversation keeps its last 300 entries (conversations.ts), which is roughly the last 100 commands per bot (a request, a receipt and a reply each). An older event id is no longer known and is run as new.
5. **Overlapping reads**: a read from 0 (snapshot, trailing, Reconnect) that arrives while an incremental read is in flight now schedules one more read from the lowest seq asked for, run when the first settles.
6. The coding read for "what needs me?" has the same 14 s bound as its neighbours; the parser file headers now say what differs from the original.

## 8. Screen truth, shared results (lead's C-proposals)

- **Readiness** (`scripts/agents/readiness.ts`, `mount.ts`): an online computer is ready only if its screen works. `screen.applicable && !ok && !checking` (or, on an older hub, `usable === false`) is needs-you with the screen's own reason and `nextLabel` and a way to the computer; a screen still being checked is ready with a note that clears by itself.
- **Files** (`service.ts` `botArtifacts`): results are listed by the job's `bot` first, wherever they ran (a bot moved to another computer keeps its history, and another bot's results on the same computer name never join it); a result a bot made is visible to BOTH founders (bots work on shared computers); a result that records no bot follows the existing oldest-bot rule and stays its owner's. **Open link:** `/__computers/artifacts/<id>` is still per person (C's file), so the other founder sees a shared result in the list but opening it is refused until C lets a bot-made artifact open for both founders (proposed in `R7-B-PROPOSALS.md`).
- **Second session of the same person**: not fixed from the data side: the lease and `viewerState` are C's, the status text A's. The exact patch is in `R7-B-PROPOSALS.md`.
