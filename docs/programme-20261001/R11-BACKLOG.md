# R11 backlog (UI-CORE), one line each

- Home: "Set it up", "Goals", "Calendar" and the audience "Link profile" links are 21–28 px tall (pass WCAG 2.2 AA 24 px, not the 44 px target); give them 44 px hit areas in business.tsx / audience components.
- Jarvis page: plain answers to typed requests aren't in the person's conversation, so they don't show on /jarvis (only the companion panel). Needs the companion (voice-companion.tsx, reliability's file) to note typed request + reply into the default thread, or broadcast its turns; the page already renders any user/oracle message in that thread.
- Companion: use the composer's `requestId` (already in the operator:voice-text detail, command-eventId shaped) as the command eventId in launchText → execute, so the identity holds end to end at the hub.
- `src/lib/deferred-overlays.tsx` duplicates shell/late.tsx's capture/replay and seems unused; delete or give it the same cancel (late:cancel-queued) support.
- Coding job page: "Computer: Not reported" row shows on every finished job with no device; hide when nothing was reported.
- Agents header: bot pills + New bot + Show archived + Recent work stack four rows above the bot name on tablet; fold New bot / Show archived into one menu.
- (reliability, staging flows 1–2) /jarvis: "Sent to Jarvis" local echoes from earlier failed sends (jarvis-sent.ts unshownSent) stay pinned at the bottom of the thread, below newer server-saved exchanges, after a reload; they should drop once the server has the request (by requestId) or sort by time.
- (reliability) Staging flows 3–5 need owner setup to run as specified: a long-running job type on a synthetic server hub (Research computer on a local WSL host, or the coding harness), a slow/keyed Jev to Stop "while routing", a second founder identity (Tailscale-only on a server hub), and a signed-in claude:max-2 CLI home for the synthetic hub (its CLI-home guard gives it empty homes).
- (reliability, final review) Stopped event ids are memory-only: a resend after a hub restart runs the command.
- (reliability, final review) Resume doesn't mark the coding job started (voice.ts resume replies carry no `started`), so a resumed job isn't linked as the conversation's running job.
- (reliability, final review) ownJob picks the newest coding job of the person even when it has finished while an older one is still running.
- (reliability, final review) Paused or queue-full companion leaves the /jarvis composer on "Still connecting" with Send disabled.
- (reliability, final review) /voice/free/turn retries carry no request id: a 504 after a server-side coding draft could make a second draft.
- (reliability, final review) appendMessage drops typed messages past 500 in a thread, and save() re-inserts typed messages the person deleted.
- (reliability, final review) A spoken "stop" handled by the server rules (not the jarvis_command tool) doesn't empty the companion's typed queue.
- (reliability, final review) With no recorded owner after a restart, the earliest linker of a job gets its report.
