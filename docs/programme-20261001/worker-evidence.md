# Worker evidence: real local proof on Usman's PC (Agent B, 1 Oct 2026)

What this shows: a companion process on this PC is the executing device for a hub it does not share a process with.
A Jarvis instruction on the hub becomes a job with steps, each step is dispatched to the requester's own device,
executed and verified on this PC, with honest outcomes, cancellation, expiry and no blind replay.

## Setup (all isolated; nothing of the live OS was touched)

- Hub: `bun scripts/devices/local-hub.ts --port 8095 --data D:\agent-scratch\prog-b\proof`, a separate process from THIS
  worktree (branch `prog/b-worker-20261001`). It is not the full Vite OS; it mounts the real pieces the cloud hub uses for this
  path: `createDevicesService` (pairing, companion long-poll, registry, dispatcher), `commandRoute` + `createCommandService`
  (the one Jarvis command path) and a real `JobService` (SQLite). `MU_HUB_ROLE=cloud` and `MU_DATA_DIR` = a temp folder on D:
  (set for that process only), so the hub is NOT a device and there is no PC fallback. It refuses port 8081 and any
  `.operator-data` folder. Loopback only. The live 8081 server and the C: checkout were not touched.
- Companion: a second, real process, `bun companion/main.ts run --config D:\agent-scratch\prog-b\proof\companion-cfg`, paired as
  `usman` over loopback with a one-time code, with its own config, ledger and authorised folder under the same scratch folder, using
  the REAL default executors (real Windows window enumeration, real Chrome, real agent-browser).
- Driver: `bun scripts/devices/real-local-proof.ts <a|b|c1|c2|d>` talks to the hub's real `/__operator/screen/command` route.
  It prints no tokens, cookies or window titles other than windows it opened itself.
- Commit under test: `a33ddf8` (on top of the merge of `prog/integration-20261001`). The proof ran against the final code.

The device record as the hub reports it (UI wording hook and worker facts), from every run's first line:

```
hubRole cloud, hubIsDevice false; device usman-vmg0ivsq "Usman's PC": online, displayLabel "This PC",
workerVersion 0.2.0, interactive true (unlocked desktop), 11 capabilities
(app.focus app.open browser.navigate deck.blank echo file.open notepad.type notify observe.window open-url wait)
```

## Results (raw driver output; `at` is seconds since that driver started)

```
=== a
{"at":"+1.7s","label":"done","ms":1459,"ok":true,"said":"Opened Chrome.","verified":true,"target":"usman-vmg0ivsq","op":"app.open"}
{"at":"+1.7s","label":"job","state":"succeeded","note":"Opened Chrome.","steps":["companion/app.open:ok"]}
{"at":"+1.7s","label":"companion-ledger","key":"1f09524e-3a86-454c-9cf9-787a0348bc53/s1","state":"done","evidence":"a new chrome window appeared: \"Google Chrome\"","handle":853824,"title":"Google Chrome"}
{"at":"+2.1s","label":"independent-check","handle":853824,"result":"visible=True process=chrome wasListedBefore=false"}
{"at":"+4.3s","label":"closed","handle":853824,"stillVisible":"False"}
=== b
{"at":"+1.6s","label":"done","ms":1599,"ok":true,"said":"example.com is open in the browser: \"Example Domain\".","verified":true,"target":"usman-vmg0ivsq"}
{"at":"+1.6s","label":"job","state":"succeeded","note":"example.com is open in the browser: \"Example Domain\".","steps":["companion/browser.navigate:ok"]}
{"at":"+1.6s","label":"companion-ledger","key":"2812f1f4-73b0-41b8-b2cc-862f2b1e59b8/s1","state":"done","evidence":"tab C02A0E64 is at https://example.com/ titled \"Example Domain\"; it is a new tab","data":{"url":"https://example.com/","finalUrl":"https://example.com/","title":"Example Domain","targetId":"C02A0E642C977B81ECFAA2DAC2479848","newTab":true,"where":"new-tab"}}
{"at":"+1.6s","label":"independent-check","tabs":[{"title":"Example Domain","url":"https://example.com/"},{"title":"about:blank","url":"about:blank"}]}
=== c1
{"at":"+1.5s","label":"done","ok":false,"stopped":true,"said":"Stopped."}
{"at":"+1.5s","label":"job","state":"cancelled","note":"Stopped on request.","steps":["companion/observe.window:ok","companion/wait:skipped","companion/echo:skipped"]}
{"at":"+1.5s","label":"companion-ledger","entries":["observe.window:done"],"stepIds":["s1"]}
{"at":"+1.5s","label":"hub-commands","forThisJob":["s1:observe.window:done"]}
=== c2
{"at":"+0.0s","label":"cancel","ms":1,"response":{"ok":true,"state":"cancelled","by":"usman"}}
{"at":"+1.5s","label":"done","ok":false,"stopped":true,"said":"Stopped."}
{"at":"+1.5s","label":"job","state":"cancelled","note":"Stopped on request.","steps":["companion/echo:ok","companion/wait:cancelled","companion/echo:skipped"]}
{"at":"+1.5s","label":"companion-ledger","entries":["s1:echo:done","s2:wait:cancelled"]}
=== d
{"at":"+1.4s","label":"kill","companionPids":[69644],"step":"s2"}
{"at":"+31.5s","label":"done","afterKillMs":29836,"ok":false,"outcome":"uncertain","verified":null,"said":"Usman's PC went offline while step 2 (wait) was running, so I can't say whether it happened. I haven't tried it again or run the later steps, and nothing ran anywhere else."}
{"at":"+31.5s","label":"job","state":"failed","note":"Usman's PC went offline while step 2 (wait) was running, so I can't say whether it happened. I haven't tried it again or run the later steps, and nothing ran anywhere else.","steps":["companion/echo:ok","companion/wait:unknown","companion/echo:skipped"]}
{"at":"+31.5s","label":"hub-commands","forThisJob":["s1:echo:done","s2:wait:uncertain"]}
{"at":"+31.5s","label":"ledger-after-kill","entries":["s1:echo:done","s2:wait:running"]}
{"at":"+33.3s","label":"after-restart","hubSays":"s2:uncertain, the companion says: interrupted","ledger":["s1:echo:done","s2:wait:interrupted"],"jobStateNow":"failed","stepsRunAgain":0}
```

### Reading it

- **(a) open Chrome and verify the window.** The words "open Chrome" went through the real rules to one typed step
  (`app.open`), were dispatched to the companion and confirmed there: "a new chrome window appeared", handle read back. An
  independent check (not through the executor) confirmed that handle is a visible chrome window that was not listed before.
  1.5 s end to end. Only that window was then closed (WM_CLOSE to its handle); the user's own Chrome window was left alone.
- **(b) navigate to https://example.com and verify the title.** `browser.navigate` started a separate Jarvis Chrome (own profile
  under the scratch folder, port 9333), opened a new tab and confirmed the tab at `https://example.com/` with the live title
  "Example Domain", steady on two reads, new tab. An independent read of the browser's own DevTools list agrees. The first
  attempt of this scenario wrongly accepted the loading placeholder "example.com" as the title (agent-browser's tab list keeps a
  stale title); that is fixed (live `read()`, placeholder rejected, steady on two reads) and covered by tests. The Jarvis Chrome and
  its profile were then closed and deleted.
- **(c1) a 3-step job cancelled after step 1.** Steps: `observe.window`, `wait`, `echo`. The cancel fires the moment step 1's
  result is recorded (synchronously, from the hub harness, so it is not a race). The job is `cancelled`; steps 2 and 3 are recorded
  `skipped`; the hub has a command record only for s1; the companion's ledger has only s1. Steps 2 and 3 were never dispatched or run.
- **(c2) cancelled through the real cancel endpoint while step 2 runs.** The companion aborted the running `wait`
  (`s2:wait:cancelled`); step 3 was never dispatched.
- **(d) the companion process is killed mid-job.** `Stop-Process` on the companion while step 2 (`wait`) was running. About 30 s
  later (the hub's presence TTL) the job ends `ok:false`, `outcome: "uncertain"`, `verified: null`: "Usman's PC went offline
  while step 2 (wait) was running, so I can't say whether it happened. I haven't tried it again or run the later steps, and nothing
  ran anywhere else." Step outcomes `ok, unknown, skipped`. The hub's command record for s2 is `uncertain`. The companion's ledger,
  written before the step began, said `running`. After the companion was restarted (same pairing and ledger) the hub asked what
  became of s2 and it answered `interrupted` (it does not claim it never ran, and it does not rerun it); the hub record stayed
  `uncertain`; no step ran again.

## Autostart: written and dry-run only (NOT registered)

`companion\install-autostart.ps1 -DryRun` prints the launcher (`run-companion.cmd`: restart on crash, stop on exit 3 = revoked
pairing, log rotated at 1 MB) and the hidden per-user Startup entry (`MU Companion.vbs`) and writes nothing; the resolved `bun.exe`
is the real exe, not the npm shim. The generated launcher was run once from a scratch folder to confirm it starts the companion (it
logged "Not paired yet" because that scratch config was unpaired), then killed and deleted. `companion/autostart.test.ts` installs to
and uninstalls from temp folders only. Nothing was written to this PC's real Startup folder or `%LOCALAPPDATA%\mu-companion`.

## Tests

`bun test scripts/devices companion scripts/jarvis-command scripts/executors`: **417 pass, 0 fail** (24 files, 2368 expects).
`bun test scripts/commands scripts/identity scripts/cloud`: 212 pass. `bun run typecheck`: clean.
New test files: `companion/wire.test.ts` (17), `companion/autostart.test.ts` (4), `scripts/devices/wire-contract.test.ts` (18),
`scripts/executors/desktop.test.ts` (25), `scripts/jarvis-command/remote-steps.test.ts` (14).

## Not proven

- Mehroz's real PC; Tailscale / Serve transport (everything here is loopback); a reboot or real logon start of the autostart entry
  (dry-run and temp-folder install only); a real lock screen (the `LogonUI` check is unit-tested with fakes and returned "unlocked"
  live, but the PC was never actually locked).
- The full Vite OS was not used: this hub is the real devices/command/jobs code in a small server, not the whole app. A multi-step
  plan reaches the service through `CommandBody.steps` (a typed plan, e.g. from Jev), not new rule parsing of "do X then Y"; the
  existing rules still refuse "X then Y" in one breath, unchanged.
- `app.focus` is unit-tested with a fake desktop and was not run live (the live proof used `app.open`; focusing a window the user
  already had open was deliberately avoided).
- Job state: an uncertain job ends in state `failed` with the note "... can't say whether it happened ..." and a step outcome
  `unknown`; the job service cannot settle a finished run as `unknown` (`scripts/jobs/service.ts` `Execution.settle` only allows
  `awaiting-approval` or `handed-off`). One line there would make it `unknown`; left for the lead because that file is outside this scope.
- The UI does not show the new fields yet (Agent C).

---

# Part 2: screen.goal, owner isolation, Mehroz package (1 Oct 2026, later)

Commit under test: `318f89b` (merged on top of `prog/integration-20261001`). Same constraints as part 1: isolated hubs on spare ports
with data on D:, nothing of the live 8081 OS touched, no keys or tokens printed.

## What screen.goal is

A companion executor that runs, on the PC itself, the same Jarvis entry and screen hands the PC hub runs for `/screen/command` (Jev's
route, the deterministic lanes, the Jev-first screen loop, the app browser). No decision logic was added. The companion streams each run-log
step to the hub as it happens (`POST /__devices/companion/progress`), and the hub records each as a job step (intent, executor, outcome,
verification). Jev's key is found the way the hub finds it (`providerKey`: environment, `.env.local`, `~/.config/agentic-os.env`); nothing is
printed. The hub sends unrecognised and compound goals there instead of refusing, only to a companion that reports `screen.goal`; money,
bank and secret goals are still refused at the hub first; a bare "yes" with nothing waiting is not a goal. A question the loop asks
("Shall I press Send?") returns as data, the job goes to `awaiting-approval`, a typed yes cannot approve it, and a spoken yes (redeemed on the
hub's own voice ledger) resumes on the SAME device: that PC records it on its own ledger and re-runs its screen gate, which applies its own
page/control binding and no-replay rule. Cancel aborts the goal's signal; a dropped companion ends the job `unknown` with no replay.

## Real proof against the FULL hub (Vite, `MU_HUB_ROLE=cloud`, isolated `MU_DATA_DIR`, port 8111)

The companion is a separate real process (own config, own `MU_DATA_DIR` for its browser profile). Pairing used a one-time code made with
`DeviceStore` in that isolated data dir before the hub started (a confirmed browser session cannot be scripted). Driver output
(`scripts/devices/real-goal-proof.ts`), condensed:

```
=== yt   "open a new Chrome tab, go to YouTube and search for Sydney weather"
done ms=5029 ok=true verified=true said="Searched YouTube for \"Sydney weather\": 12 videos listed."
job  route: Jev: hermes 85% (screen) | Lane: browser (YouTube or a video: the app-owned browser) | act: Searching YouTube for Sydney weather.
     ok|playwright|check: Searched YouTube for "Sydney weather": 12 videos listed.|v=true
     ok|companion|companion screen.goal: ...|v=true
independent-windows: "Sydney weather - YouTube - Google Chrome for Testing"  (the app browser's own window, not the user's Chrome)
=== cancel   (goal: ... search for Sydney weather and open the first video; stop sent once its first action step was in the job)
cancel-sent stepsBefore=6   done cancelToDoneMs=3 ok=false stopped=true said="Stopped."
job  state=cancelled; the only step after the stop is "cancelled|companion|screen.goal: Cancelled."; "open the first video" never ran
=== kill     (companion process killed after the first action step)
done afterKillMs=31472 ok=false outcome=uncertain verified=null said="Usman's PC went offline while it was doing that, so I can't say
     whether it happened. I haven't tried it again, and nothing ran anywhere else."
job  state=unknown (the lead's settle "unknown"); last step "unknown|companion|screen.goal: device offline"; after the companion restarted: still unknown, 7 steps, no replay
=== ppt      "open PowerPoint and create a blank presentation"
done ms=1625 ok=true verified=true said="Started a new blank presentation. It isn't saved."
independent-windows: "Presentation1 - PowerPoint" (a real window, not the splash)
=== stop     (goal running, then the command "stop that task")
stop-said="Stopped it." stopped=true; the goal's job state=cancelled, last step "cancelled|companion|screen.goal: Cancelled."
```

Notes:
- The YouTube goal goes through the YouTube lane (the app-owned Playwright browser, separate profile under the companion's data dir) exactly as
  the PC hub does today; it does not drive the user's own Chrome window. Only what this run opened was closed (the app browser, killed by its
  profile path; PowerPoint, quit with its unsaved Presentation1, and it had not been running before). The user's own Chrome window (pid 30120)
  was untouched throughout.
- "switch back to the website we were using" is NOT handled by the existing loop: Jev reads it as "website 44%, unsure" and the entry asks
  "Say it another way?" (recorded as an `asked` step, nothing pressed). Making it work needs a referent-based window or tab switch that the entry
  does not have; screen.goal faithfully reproduces what the PC hub does. "switch to the YouTube window" just reopens youtube.com. Left as a gap:
  it is new logic, not routing.
- "stop that task" was not a stop word before (only "stop", "stop it/that", "cancel that/it/the command" ...). `STOP_WORDS` now accepts
  stop, cancel or abort followed by it/that/this/the/my/now and task/job/command/goal/request/one. "stop everything" and "cancel my 3pm meeting"
  are still new requests.

## Office splash and blank presentation

`app.open` for PowerPoint, Word and Excel ignores a splash window (title "Opening -", "Loading", blank, class MsoSplash) and waits, bounded, for
the real window; if only the splash ever shows it reports "still starting ... can't confirm it opened" (`ok:true, verified:null`). `deck.blank`
with no title requested leaves the title placeholder empty (read back as empty) and says "Started a new blank presentation. It isn't saved."; a
requested title is still said and verified. The planner no longer invents a "Title". Tests: `scripts/executors/office.test.ts`.

## Cross-owner refusal on the real command path (`scripts/devices/real-owners-proof.ts`)

Isolated mini hub (`local-hub.ts --simulate-serve`, port 8112; real devices service, command service and job store). Usman's companion is a real
process. Mehroz's is a synthetic second companion: a real `CompanionWorker` paired as `mehroz` through the simulated Serve identity (Tailscale
cannot be used here, and the real hub refuses a non-loopback identity without the tailscaled socket check), with harmless fake executors so nothing
synthetic can act on this PC, plus a real paired session cookie for Mehroz's browser.

```
usman-names-mehroz-pc                 ok=false refused  "that device belongs to mehroz ... Nothing ran on any other machine."  newCommandRows=0 otherDeviceCalls=0
usman-names-mehroz-computer (typed plan + spokenTarget)   same, newCommandRows=0
usman-body-smuggle (deviceId/targetDeviceId/personId/displayName = mehroz's)   ran on usman's own device; mehroz device calls 0
mehroz-names-usman-pc / -computer     ok=false refused  "that device belongs to usman ..."  newCommandRows=0
mehroz-body-smuggle                   ran on mehroz's own device, not usman's
here                                  usman "here" = usman's device; mehroz "this pc" = mehroz's device
revoked mehroz-blgpvz2d               worker state: unpaired
after-revoke-usman-names-mehroz       still refused, newCommandRows=0
after-revoke-mehroz-here              "no device registered for mehroz. Nothing ran on any other machine."
after-revoke-usman-unaffected         usman's device, ok
re-paired (new device id)             usman naming it: refused, newCommandRows=0; mehroz "here" = his new device
```
("otherDeviceCalls: 2" on the after-revoke line is Mehroz's own two earlier legitimate calls to his old device, not cross-owner.)
The same rules are a committed test: `scripts/jarvis-command/remote-steps.test.ts` ("owners: ..."), using `dispatcher.recent()` as the command table.

## Mehroz enrolment package (built, NOT sent)

`bun companion/build-exe.ts` produced `D:\prog-scratch\dist\mu-companion.exe` (83.1 MB) and `mu-companion.exe.sha256`:
`10d461bc6c2798d331d6f9530117fac251b9b8aadc3440c553843026a452b315 *mu-companion.exe` (a rebuild after later commits changes the hash; the file
is unsigned, holds no keys, and omits the Playwright app browser). Smoke test of the exe against the isolated hub: it paired, came online as worker
0.2.0 reporting 12 capabilities including `screen.goal`, ran `observe.window` through the compiled binary, and ran a `screen.goal` end to end (Jev
routing worked inside the exe; it answered honestly that a screen question goes to vision). Docs: `docs/MEHROZ-ENROL.md` (new, one page) and
updates to `docs/MEHROZ-SETUP.md`; `install-autostart.ps1 -Exe <path>` runs the exe at logon without Bun or a checkout.

## Tests (part 2)

`bun test scripts/devices companion scripts/jarvis-command scripts/executors`: 451 tests, 0 fail; `bun run typecheck` clean. New:
`scripts/executors/screen-goal.test.ts` (14), `scripts/executors/office.test.ts` (8), `scripts/jarvis-command/screen-goal-remote.test.ts` (9), the
owner test in `remote-steps.test.ts`, and progress tests in `wire.test.ts` / `wire-contract.test.ts`.

## Not proven (part 2)

- Mehroz's real PC, Tailscale, and the exe on another machine; SmartScreen behaviour; a reboot or logon start.
- Approval resume ("Shall I press Send?" then a spoken yes) on a REAL final button: proven with fakes and the real hub/companion wiring in tests; no
  real Send button was pressed, by design.
- A real lock screen; the app-browser lane inside the packaged exe (excluded on purpose); "switch back to the website we were using" (gap above).
- `/__devices/pair/code` with a confirmed browser session (the scripted pairing used the store in an isolated dir).

---

# Part 3: "switch back to ..." (1 Oct 2026, round 3)

Commit under test: `1911122` (on top of the round-2 merge).

## What was built

- `scripts/jarvis-command/recent-targets.ts`: a sibling of `context.ts` for what is on a device (same rules: a deictic phrase names a kind,
  exactly one candidate resolves, several ask, none says so). `context.ts` itself resolves OS-page items from a client-sent PageContext, so it
  could not hold device targets; this reuses its shape and stays deterministic.
- Memory: fed only by VERIFIED remote steps the hub already records (`browser.navigate`, `app.open`, `app.focus`, `screen.goal` with a url):
  url, title, app, window handle, tab id from the step's own data. Kept per person AND device (never another person's or device's), 30 minutes.
- Resolution: "switch back to / go back to / back to <the website|that page|the X tab|the window|an app>" (songs, slides and steps are not ours).
  The hub first asks the PC what is in front (read-only `observe.window`), drops anything that is in front now, then takes the most recent match.
  Two distinct recent sites the words do not separate: one short question, `Which one: "A" or "B"?`, nothing focused. A word that names one picks it.
- Focus: new companion executor `target.focus`: a site's tab is activated by id (agent-browser) when known, then the browser window showing its
  title is focused and the FOREGROUND window (process, handle, title) is read back; an app uses the same verified focus as `app.focus`.
  A failed focus is reported as not done. A companion that does not report `target.focus` leaves the normal path unchanged.

## Real proof (full Vite hub on 8111, cloud role, isolated data dir; real companion process)

```
1-navigate   browser.navigate https://example.com/  ok verified  "example.com is open in the browser: \"Example Domain\"."   (Jarvis Chrome, own profile)
2-powerpoint "open PowerPoint and create a blank presentation"  ok verified  "Started a new blank presentation. It isn't saved."
2b-focus     app.focus powerpoint  ok verified;   front-before: PowerPoint is the foreground window
3-switch-back "switch back to the website we were using"  ms=149 ok=true verified=true  "Switched back to Example Domain."
   job steps: ok|companion|switch back: POWERPNT is in front|v=true ; ok|companion|companion target.focus: Switched back to Example Domain.|v=true
independent-foreground (Win32 GetForegroundWindow, not through the executor): "Example Domain - Google Chrome"
"back to PowerPoint"  ok=true verified=true  "Brought PowerPoint to the front."  (job: chrome is in front -> target.focus)
```
The example.com and PowerPoint setup steps were typed executors (verified results feed the memory); the phrase itself is plain words through the
command service. A first attempt sent the driver's own flag text as a goal by mistake; it went to the PC's screen loop, which only asked a
question ("this next bit is your call") and pressed nothing.
Cleanup: Jarvis Chrome and its profile closed/deleted, PowerPoint quit (it was not running before; unsaved Presentation1 discarded), the user's own
Chrome window untouched, hub and companion stopped, scratch deleted.

## Tests

`bun test scripts/devices companion scripts/jarvis-command scripts/executors`: 467 pass, 0 fail; `bun run typecheck` clean. New:
`scripts/jarvis-command/switch-back.test.ts` (12: phrase parsing, resolution, memory isolation, expiry, the service path incl. ambiguity, other
person, failed focus, no capability) and `target.focus` cases in `scripts/executors/desktop.test.ts` (4).

## Not proven

- The memory is in the hub's process (lost on a hub restart); targets from the user's OWN everyday Chrome tabs are not tracked (only what a verified
  step opened), so "the website we were using" means one Jarvis opened or focused.
- Mehroz's PC / Tailscale; a site whose tab is in a window whose title differs from the recorded page title (title drift after navigation).

---

# Part 4: Cua Driver comparison and agent-browser strict binding (1 Oct 2026, round 4)

Table of decisions: `REFERENCE-ADOPTION.md`. Commits: `4520b57` (code) on top of the round-3 merge.

## Cua Driver on this PC (scratch copy, v0.31.0, telemetry off, no install)

Windows is supported per Cua's platform page, so I ran it: zip from the GitHub release to `D:\agent-scratch\prog-b\cua`, a scratch daemon on its own named pipe,
telemetry disabled by environment, no PATH/registry/autostart change (the installer would have used fixed folders on C:, edited the User PATH and registered a
highest-privilege autostart task). Same Notepad tasks through our executors and through Cua, run by `scripts/devices/cua-compare.ts` (raw output, last run):

```
﻿{"at":"+0.4s","label":"start","foreground":"1772370|Notepad"}
{"at":"+2.3s","label":"ours.app.open","ms":1523,"ok":true,"verified":true,"evidence":"a new Notepad window appeared: \"Untitled - Notepad\"","handle":1182182,"foregroundAfter":"1182182|Notepad"}
{"at":"+14.3s","label":"cua.launch_app","ms":11500,"code":0,"pid":109356,"windowId":855902,"active":false,"foregroundAfter":"855902|Notepad","note":"window reported with no focus steal; no post-action check of its own"}
{"at":"+14.4s","label":"windows","ours":[855902,1182182,1772370,3672410,2362258,396294,7081216,1051846,2362750],"cua":[855902,1182182,1772370,3672410,2362258,396294,7081216,1051846,2362750],"cuaListMs":153}
{"at":"+17.8s","label":"ours.notepad.type","ms":2947,"ok":true,"verified":true,"evidence":"UIA read-back matched 16 chars exactly","foregroundBefore":"855902|Notepad","foregroundAfter":"987120|Notepad","handle":987120}
{"at":"+18.7s","label":"cua.ctrl+t","backgroundFailure":"hotkey on a modern XAML / UWP target (pid 109356, hwnd 855902) could not find a UIA AcceleratorKey or `(Ctrl+X)`-style name hint matching `ctrl+t` (scanned 46 element(s)). PostMessage WM_KEYDOWN/UP is","
{"at":"+19.9s","label":"cua.new-tab+observe","hotkeyMs":91,"hotkeyCode":1,"stateMs":421,"documentValueLength":0,"hasToken":true}
{"at":"+27.5s","label":"cua.type_text","ms":1138,"code":0,"readBackMatches":true,"readBackLength":16,"foregroundBefore":"987120|Notepad","foregroundAfter":"987120|Notepad","foregroundUnchanged":true,"verifyStateCode":0,"verifyState":"{ \"elapsed_ms\": 5092, \"
{"at":"+27.5s","label":"cua.failure(click bogus pid)","code":1,"ms":44,"text":"{ \"candidates\": [], \"code\": \"window_target_not_found\", \"effect\": \"refused\", \"pid\": 99999999 }"}
{"at":"+27.5s","label":"ours.failure(unknown app)","ok":false,"verified":false,"said":"I only open the apps on my list (notepad, calculator, powerpoint, excel, word, chrome, edge, explorer, vs code, paint), so nothing was opene","structured":["ok","verified","
{"at":"+28.0s","label":"cua.freshness","stateMs":431,"capture_id":"present (an id per capture)"}
{"at":"+28.0s","label":"ours.freshness","readMs":24,"readBackLength":16}
{"at":"+29.3s","label":"done","foreground":"855902|Notepad"}
```

Reading it: window enumeration is identical; Cua's launch is 5-8 times slower and Notepad was the foreground window afterwards despite `active:false`; background
`type_text` through UIA worked (1.1 s, exact read-back, foreground unchanged) but only with a session label and a fresh element token, `ctrl+t` could not be delivered to
modern Notepad in the background, `verify_state` said `unknown (untrusted_source)`; Cua's refusals are better structured than ours (`window_target_not_found`,
`stale_element_token`, `browser_tab_not_found`), which I adapted as `data.recovery` codes. Cua's browser tools did bind exactly (an unknown `tab_id` was refused), but
its isolated browser wrote a 60 MB profile under `%LOCALAPPDATA%\CuaDriver` on C: regardless of the home override; I removed that folder (created by this run) and
everything else I opened (all Notepad windows were mine; "cua compare line" was cleared by `set_value` before the processes were stopped). **Decision: deferred.** The pre-existing
`cua-driver 0.28.2` and its daemon were not touched.

## agent-browser

Installed 0.37.1, latest 0.38.1 (Apache-2.0). Probe (`scripts/devices/agent-browser-probe.ts`, own headless Chrome on a spare port, throwaway profile, both versions):

```
tab <closed id>          -> success:false, "No tab with target id ..." (0.38.1: "No tab with label ...")   clean refusal
open after the failed bind -> success:true and it navigated the NEIGHBOURING tab (example.org -> example.net), in both versions
```
So a clean refusal is not enough: a caller that carries on acts on the wrong tab. Fix in our code: `browser.navigate {tabId}` and `target.focus {targetId}` are strict:
the id must be in the live tab list, must activate, and must be the active tab after activation, otherwise nothing is done and the result is
`data.recovery: "tab-closed" | "tab-not-active"` ("That tab was closed, so I didn't open anything in another one."). `target.focus` no longer falls back to a window with a
similar title when it has a tab id. The hub forgets a closed tab's target. Per-companion browser: session `companion-<deviceId>` (real `agent-browser session list` shows it),
`browser.profileDir` must be absolute and outside this checkout (cookies never sit next to code that gets committed), `browser.port`; nothing prints the profile path.

## Real journeys on this PC (full hub on 8111, cloud role; real companion; Jarvis Chrome on its own profile and port; `real-goal-proof.ts journeys`)

```
1-fresh-tab-example     ok verified  "example.com is open in the browser: \"Example Domain\"."        tabs: Example Domain | example.com, about:blank
2-navigate-and-search   ok verified  "duckduckgo.com is open in the browser: \"sydney weather at DuckDuckGo\"."   (expectTitle "sydney weather")
3-return-to-recent-site "go back to the example page" -> "Switched back to Example Domain." (job: chrome is in front -> target.focus, both verified); the browser's own tab list now has Example Domain first
4-companion restarted   process killed and started again, same pairing: Jarvis Chrome and all tabs still open; session + profile the same
  "go back to the duckduckgo page" -> ok verified "Switched back to sydney weather at DuckDuckGo."   (the hub still remembered the tab ids; the new companion process found the same tabs)
  (my first phrase "go back to the search page" correctly found no page called "search": "I don't have a recent page or app like that on this PC to go back to.")
5-tab closed by hand (DevTools)   5b navigate bound to the closed tab's id -> not done: "That tab was closed, so I didn't open anything in another one." tabs unchanged
                                  5c "go back to the example page" -> not done: "That tab was closed, so I can't switch back to \"Example Domain\"."
6-cancel mid plan       [navigate example.net, wait 20 s, navigate example.org]: step 1 ok verified; cancel during the wait -> job cancelled; wait "Cancelled."; step 3 "not run: it was stopped first"; example.org never opened
```
Cleanup: the agent-browser session closed, Jarvis Chrome (own profile, port 9336) killed and its profile deleted, hub and companion stopped, scratch deleted; your Chrome window untouched.

## Tests

`bun test scripts/devices companion scripts/jarvis-command scripts/executors`, `bun run typecheck`: see the final report for counts. New: 6 strict-binding cases in `desktop.test.ts`,
`companion/browser-config.test.ts` (3), a closed-tab case in `switch-back.test.ts`.

## Not proven

Mehroz's PC; agent-browser 0.38.1 as the live version (only probed); Cua on an elevated window, WPF/WinUI apps other than Notepad, or over MCP (CLI calls only, with session labels);
the exe package's browser lane (excluded).

---

# Round 3: Jarvis context, familiar compound requests, reconnection, voice (Track B, 1 Oct 2026)

Commit under test: `861b798` (on top of the integration merge `e586622`) plus one small follow-up (CRM-miss wording). Stack: a full Vite hub from this worktree on
`127.0.0.1:8111` (`MU_HUB_ROLE=cloud`, `MU_DATA_DIR` on D:, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`), a real companion process, and the real Jarvis client
(`src/lib/jarvis-command.ts`, `src/lib/page-context.ts`) running **in a real browser session** (the in-app browser pane, loopback owner session, `import('/src/lib/jarvis-command.ts')`),
so the typed and spoken commands below used the app's own client and page token. The pairing code came from `POST /__devices/pair/code` made by that browser session (a first browser on an empty
data dir is auto-confirmed; the `confirm-browser` terminal guard was not needed and not bypassed). The companion paired as "Usman's PC" (`displayLabel` "This PC").

## 1. Typed and spoken are one path; context is passed and used

Trace: palette `runTypedEntry` (src/lib/commands/client.ts) and voice `jarvisCommand()` (voice-companion.tsx) both call `runJarvisCommand` (src/lib/jarvis-command.ts), which builds one `CommandBody
{utterance, source, spokenTarget, pageContext, spokenYes}` and POSTs `/__operator/screen/command`; the one `createCommandService.run` makes the job. Only `source` differs ("typed" or "voice"); the job's
`kind` records the surface ("command" or "voice") and nothing else differs. Page context is read from Track 1's `readPageContext()` and parsed by `parsePageContext`; spoken commands may reuse the
person's last page for 45 s, typed never.

`scripts/jarvis-command/round3-context.test.ts` (12 tests; real client, real service, real job store, synthetic device) proves it: the same words and page typed in one rig and spoken in another post
the same body to the same single path and leave the same job steps; a typed echo of a spoken command is the same job and dispatches once; and:

| Request | What the page supplied | What happened |
|---|---|---|
| "open this lead's website" (lead page) | selected lead id | **gap fixed.** It used to navigate to the lead's OS page. Now the lead id comes from the page, the address from the CRM by id (`leadSite` delegate over `/leads/detail`, never from the page's words: a page-supplied `website` is ignored), a public http(s) check, then `browser.navigate` on his own device. No website: "X has no website on file". Not in the CRM: "I can't find X in the CRM". Private or non-http addresses refused. |
| "explain this margin" (finance) | selected package, shown figures and data source from the client's real snapshot | same figures, source and caveat typed and spoken |
| "continue that job" (job page) | the job the page shows | **gap fixed.** It used to attach to "this person's latest computer job". Now it reports THAT job by state (running: left alone; waiting: asks for his spoken yes; finished; ended unknown/failed/cancelled: says how and "I won't run it again blindly") and never re-runs. Not in the log: asks which. |

UI hook (listed, small): `src/components/operator/lead-drawer.tsx` now publishes the open lead (`usePageContext("leads:drawer", { selection: kind lead, id, label })`). Not exercised in a rendered
lead drawer (the isolated CRM was empty); proven through the client's page-context API and the in-process service.

## 2. Real journeys (real companion, hub in cloud role, observed outcomes)

Each line was sent by the app's client in the browser session; "observed" is an independent check (Win32, CDP, PowerPoint's object model), not the executor's own report.

| Journey | Said | Observed |
|---|---|---|
| "open Chrome and create a new tab" | "Opened Chrome with a new tab." (first), "Opened a new tab in Chrome." (second) | **gap fixed.** Before: Jev read it as `open_app`, dropped "create a new tab", and said "Opened Google Chrome." while Chrome showed its profile chooser. Now a typed `browser.navigate {blank:true}`: Jarvis Chrome (own profile, port 9340), verified from the browser's own tab list. CDP: 1 tab after the first (the fresh browser's own blank tab, not two), 2 after the second. |
| "open YouTube and search for Sydney weather" | `Searched YouTube for "Sydney weather": 12 videos listed.` (8.3 s) | window "Sydney weather - YouTube - Google Chrome for Testing" (the app browser, not Jarvis Chrome) |
| "open PowerPoint and create a blank presentation" | "Started a new blank presentation. It isn't saved." | object model: a new `Presentation2`, `Slides.Count` 1, title layout, 2 shapes, `Saved` false, `ReadOnly` false, `Path` empty, a window; a text write to the title placeholder read back (editable). Not the splash. |
| "go back to the website we were using" (PowerPoint in front; example.com and YouTube recent) | `Which one: "Example Domain" or "youtube.com"?` | asked, nothing focused. "go back to the youtube page" says "Switched back to youtube.com." and Win32 foreground = "Sydney weather - YouTube - Google Chrome for Testing" (**gap fixed**: the site was recorded by address and its page calls itself "... - YouTube"; matching now also uses the host's first label). "go back to the example page": Win32 foreground = "Example Domain - Google Chrome". |
| "assign this fix to Claude Max 2" | first asks the repo (now `ask:true`); then the planner asked which fix; then with a concrete fix: "Draft ready in muv-marketing on Claude Max 2: Opus builds, Sonnet reviews. Start it?" (78 chars) | **gap fixed.** The planner turn ignored the named account and used `claude:max` (refused: "stopped before the limit", 100% weekly). It now runs on `claude:max-2`. Coding jobs: state `awaiting_confirmation`, builder and reviewer on `claude:max-2`, **not started** (two drafts, both still awaiting at teardown). Drafting costs a real planner turn on max-2. |
| "use the research computer to open example.com" | `There's no shared computer called "research". There are none yet. Nothing ran anywhere else.` | none is provisioned here and none was. **gap fixed**: an unknown name used to fall through to other lanes (the coding delegate even answered it as its pending repo question); a command verb naming a machine that isn't there is now refused by name. No job record (a refusal; nothing ran). |
| Closed tab | after the tab was closed over CDP: `Not done on Usman's PC: That tab was closed, so I can't switch back to "Example Domain".` | no fallback to another tab (a second example.com tab elsewhere was not used) |
| Slow page (my own 25 s delayed local page) | `Not done on Usman's PC: 127.0.0.1 didn't finish loading, so I can't say it's showing.` (12.4 s) | not "done". A page whose title is a placeholder ("Loading") and becomes "Late Title Page" after 2.5 s now verifies on the real title (`realTitle` ignores loading / please wait / just a moment placeholders). |
| Changed focus: PowerPoint forced to the front every 120 ms while Notepad is typed into | `Not done on Usman's PC: Typing in Notepad didn't work: The window changed under me, so I stopped.` | nothing leaked into the PowerPoint deck (title placeholder unchanged); the half-opened Notepad was closed by PID. (An earlier run where the steal began after the typing had finished reported the line verified, and UI Automation read the same text back.) |

## 3. Cold start and reconnection (`scripts/devices/real-r3-reconnect.ts`; it starts everything itself and kills it by PID; real hub, real companion)

```
cold               companion started BEFORE the hub; hub healthy at +4.5 s; companion registered 5 s later (another run: ~19 s; its offline backoff is capped at 30 s); same device id;
                   first command ok, verified, on the same device
hub-restart        companion idle; hub killed and restarted; companion online 1.8 to 6 s after the hub was healthy; same device id, pairing and 33 jobs kept; next command ok on the same device
companion-restart  goal [wait 25 s, open example.net]; companion killed at 4 s and started again at once.
                   Before: the hub waited out the 60 s timeout (56 s) then said "Timed out ... may or may not have run".
                   Now (gap fixed, dispatcher.reviewIdle): 11 s, "The companion was restarted while it had this command, so it may or may not have run. I haven't tried it again or run
                   the later steps." Job state unknown; step 2 "skipped: the step before it is uncertain"; the companion's own ledger: wait = interrupted; example.net never opened (CDP).
sleep              same goal; companion suspended with NtSuspendProcess for 45 s (no heartbeats, no progress). Hub at +45 s: device "Offline", job settled uncertain: "Usman's PC went offline while
                   step 1 (wait) was running, so I can't say whether it happened. I haven't tried it again or run the later steps, and nothing ran anywhere else." After resume: online again at the
                   next heartbeat, same device id; the resumed wait finished on the PC (ledger wait = done) but the hub had already settled it, so the job stays unknown, step 2 never ran,
                   example.org never opened; the next command ran ok on the same device.
```

Dispatcher change (scripts/devices/dispatch.ts + service.ts, 5 new tests in wire-contract.test.ts): a heartbeat that reports `busy:false` while a command was delivered more than 15 s ago asks the companion to
observe it (done: adopted; unknown: nothing ran; interrupted: uncertain; running: left alone). Never re-sent.

## 4. Voice without the microphone

Kept and rerun: the 22-test synthetic turn-taking suite (natural pauses and continuations, speech over Jarvis, false-interruption resume, "quiet" vs "stop the task", mic reconnect, duplicate guard) in
`scripts/jarvis-execution/voice-turns-client.test.ts`.

New: `scripts/jarvis-execution/voice-e2e-synthetic.test.ts`, one end-to-end test with **generated speech**: Windows SAPI text-to-speech (no recording) is fed as 100 ms PCM frames to the real
`startFreeVoice` (VAD, endpointing, WAV capture, duplicate guard, tool loop); the client's own captured WAV is transcribed by an offline SAPI recogniser with a command grammar (standing in for Groq STT); a
scripted brain asks for `jarvis_command` the way the real one does; the tool glue (the same `voiceRouteFor` and `runJarvisCommand` that voice-companion.tsx uses) posts to the real command service and a synthetic
device. It asserts the JOB: kind `voice`, state succeeded, device = his own PC, one companion step (`deck.blank`), one dispatch, one short spoken line (under 110 characters, equal to the job's note), and a second
identical utterance is not a second action. Also: "open this lead's website" on a lead page (the CRM address is opened), "open Chrome and create a new tab" (a typed blank-tab step), and a negative control
(speech that isn't a known command is heard as nothing: no tool call, no job, no dispatch, so the transcript really comes from the audio). Skipped, not faked, where Windows speech is missing.

**Still OWED to the owner: the physical microphone test** (VOICE-TURNS.md section 7): a real room, speakers' echo, a real unplug, real Chrome `AudioContext.suspend/resume`, and the 650 ms and hold values against his
speech.

## 5. Spoken strings audited and trimmed

Routine lines were already short ("Opened a new tab in Chrome.", "Switched back to Example Domain.", "Started a new blank presentation. It isn't saved."). Trimmed: the coding draft for the VOICE (was a 450-character
receipt with snapshot SHA, routes and reasons; now "Draft ready in muv-marketing on Claude Max 2: Opus builds, Sonnet reviews. Start it?", with the full text kept in `numbers.fullSummary` and shown typed);
the unknown-computer refusal; the slow-page failure. A clarifying question from the coding entry is now `ask:true`.

## Files changed outside my directories (all small, listed for the lead)

`scripts/coding/planner.ts`, `scripts/coding/plugin.ts` (the planner turn runs on the Claude account the owner named: `claudeSlot(utterance)` with `claudeSlotFromWords`), `scripts/computers/jarvis.ts` and
`jarvis.test.ts` (a command verb naming an unknown shared computer is refused by name; the existing test that expected a fall-through was updated; wording trimmed), `src/components/operator/lead-drawer.tsx`
(page-context publish). Everything else is under scripts/jarvis-command, scripts/executors, scripts/devices, scripts/jarvis-execution (new test) and the docs.

## Not proven / gaps left

- The physical microphone (owed). Mehroz's PC and Tailscale. A rendered lead drawer publishing its context in the real UI. A real shared cloud computer (none exists; Track A's).
- "this fix" with no concrete fix: the planner (correctly) asks which fix; there is no page-supplied "fix" item yet.
- The coding delegate keeps a pending question per person, and answered an unrelated phrase once ("Sorry, which one") before the computer refusal was fixed. Track D's.
- Recent-target memory ("go back to ...") lives in the hub process and is lost on a hub restart. `deck.blank` verifies PowerPoint's new window but does not bring it to the front.
- A companion started before the hub can take up to 30 s to appear (offline backoff cap). "continue that job" on a job page reads the Jarvis job log only (coding jobs have their own page).
- Housekeeping disclosure: I printed the throwaway companion config once (it contained the companion token of my disposable hub, whose data dir is deleted). No other token, key or env value was printed. The coding drafts created
  six detached planner worktrees under `_coding-worktrees/muv-marketing`; all were mine and were removed with `git worktree remove`.

Teardown (by PID or by the scratch path): hub (Vite tree), companion, slow-page server, Jarvis Chrome on 9340 and the app browser, the agent-browser session `companion-usman-er5aowyh`, PowerPoint (it was not running before;
the unsaved probe decks discarded), the Notepad windows the focus test opened, scratch folders on D:. Your own Chrome, windows and profile were never touched. 8081 and the C: checkout untouched.

# Open Dot V: voice and background work (builder V, 1 Oct 2026)

Outcome: speak (or type) to Jarvis -> one identifiable job on the one command path -> it keeps going after the voice session ends -> the result is in the SAME conversation when the person comes back. Design, decisions and limits: `OPEN-DOT-ADOPTION.md`, "Voice and background work".

## Setup (all isolated; the live 8081, the C: checkout and the owner's windows/Chrome were not touched)

- Hub: a full Vite hub from this worktree on `127.0.0.1:8111`, `MU_HUB_ROLE=cloud`, `MU_DATA_DIR=D:\prog-open-dot-v-data`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, `CODING_DATA_DIR` inside that folder with a registry naming ONLY a throwaway repo (`D:/prog-scratch/open-dot-v-repo`). The coding account map was copied byte for byte from the live one (never read or printed here).
- Computer: ONE shared computer `v-research`, provisioned through the existing computers API (WSL host allocator; display 441, own folder `mu-computers-v`). Destroyed at the end through the API (`POST /__computers/v-research/action {destroy}`, status 200); the hub stopped by its own PID tree; `~/mu-computers-v` removed; display :441 gone; other builders' computers (`:601`, `mu-computers-od`) untouched.
- Client: a headless Chrome profile of its own that the driver closes and reopens (a new browser, the same signed-in profile). Driver and raw log: `scripts/jarvis-command/open-dot-v-journeys.ts`, `D:\prog-scratch\open-dot-v\evidence.log`. No cookie, token, key, env value or recording was printed or used; C: free space stayed about 21 GB.

## Results (raw driver lines, trimmed)

```
a  voice: "open example.org and confirm that the title is Example Domain, on the v-research computer"
   ack  "Started on v-research: open example.org and confirm that the title is Example Domain. Job a289bb6a."   (one stream event: done)
   job right after the ack: running; context step: request "..."; page /leads; selected lead "Example Domains Pty Ltd"; device V research
   client CLOSED; ~2 s later a NEW client opened the conversation:
     oracle[job:a289bb6a]: Started: open example.org and confirm that the title is... (job a289bb6a).
     oracle[job:a289bb6a]: Finished: open example.org and confirm that the title is... Done on v-research: 1 step, each checked. (job a289bb6a)
   job record: succeeded; "ok companion: act: browser.navigate: Opened example.org: the page title reads "Example Domain""
a2 voice: "research Example Domains Pty Ltd by opening example.com and clicking the Learn more link, on the v-research computer"  (hub goal loop, Jev)
   same shape; the entry is honest: "Failed: ... I'm not sure what to do next on example.org (51% sure), so I stopped. Tell me the next step. (job ddd71841)"
   (an earlier try before a start page existed: "I couldn't read the computer: No page is open on this computer." also landed as Failed)
   the interjection gate holds a short "<title> is finished." / "... failed." line per job for the voice client to say at a pause

b  typed: "assign a builder on Claude Max 2 to add an exported farewell function ... one Sonnet builder and an Opus reviewer"
   -> asks the repo -> "Draft ready: throwaway - ... builder-1: claude-sonnet-5-5 on Claude account 2; reviewer: claude-opus-5-5 on Claude account 2 ... Start it?"
   -> "start it" -> "Started." (coding job bbf44035 linked to the thread, state preparing); client closed; reopened ~40 s later:
   conversation entry (earlier text format): "Finished: Add an exported farewell(name) function to src/... (job bbf44035; details in the job view) Ran on Claude Max 2 (claude-opus-5-5)."
   receipts: coding.build  account claude:max-2  requested claude-sonnet-5-5  providerModel claude-sonnet-5-5  mismatch false  succeeded
             coding.review account claude:max-2  requested claude-opus-5-5   providerModel claude-opus-5-5    mismatch false  succeeded
   job state completed; the throwaway repo's canonical checkout is unchanged (work is on the job branch); nothing merged or pushed. ONE real job (planner + builder + reviewer), no repeat.

c  voice: same utterance event id sent, the client closed and reopened, then the SAME event sent twice more
   first=95f91c6a  replay=95f91c6a  replay2=95f91c6a  said identical; jobs in the hub's job log for that utterance since the start: 1

d  a computer job running (a 25 s wait step then a page step); "show me the v-research computer" brings it into the thread ("Job 9566be7b.")
   "how's that going?"               -> "journey-long on v-research is running, 1 step in. Latest: ..."  (jobId 9566be7b)
   "how's the v-research job going?" -> same job
   "also confirm the title says Example Domain" -> "Added to the journey-long on v-research job."  (same job, no second job; context step on the job; thread link context recorded)
   "stop that task" -> "Stopped it. Nothing further will run."

f  the same long job (20 s wait, then browser.navigate example.net): "stop that task"
   -> cancelled, settled in 48 ms; steps: "cancelled companion wait: Cancelled." / "skipped companion: step 2 browser.navigate not run: it was stopped first";
      25 s later nothing else had run (laterStepsThatRan 0); thread: "Started: ..." then "Stopped: journey-long on v-research. Nothing further ran. (job 95608395)"
   (a "stop that task" sent after a job had already ended answered "Nothing of yours was running.", not a stop of something else)
```

e) Interrupting speech without cancelling work: the client turn-taking suite (synthetic PCM, the existing 22 tests plus 2 new) shows "quiet"/"shut up" stop speech only and leave the task running, and closing the client mid-job (a, c) did not stop any job: the work is the server's, not the stream's.

## Tests

`bun test scripts/jarvis-command/open-dot-v.test.ts` (24), `scripts/jarvis-execution/voice-turns-client.test.ts` (24, 2 new), `scripts/conversations.test.ts` and `scripts/voice-transcript.test.ts` (unchanged, green), `scripts/computers/goal-loop.test.ts` (green).

## Not proven

Physical microphone (owed). Two jobs running at once on the real hub (one computer, one coding run allowed); proven in the service-level test with the real job service. A second real coding run with the final text format. Open-ended research quality (Jev goal loop). See `OPEN-DOT-ADOPTION.md` limits.

## Files changed outside my directories (all small, for the lead)

- `scripts/operator-plugin.ts`: creates `createJobThreads` with the existing conversation store, job service and a coding reader; `onEntry` submits the short line to the existing interjection gate; passes `threads` into the live command service.
- `scripts/computers/goal-loop.ts` and `scripts/computers/service.ts`: `extraContext` hook so context added by voice reaches the running goal loop.
- `scripts/conversations.ts` (store extension, mine by brief); `scripts/jobs/**`: **no edits** (only the existing `subscribe`, `create`, `step`, `cancel`, `get`).
- `src/components/operator/voice-companion.tsx`: passes `eventId`, `backgroundStop`, `hasBackgroundWork`.

## For builder S (activity stream)

Everything is on existing mechanisms: (1) `GET /__operator/screen/command/thread?conversation=<id>&after=<seq>` returns `{ conversationId, entries: [{ seq, key, at, jobId, state, text, speak?, afterMessages }] }` for the verified person's thread (reads only; someone else's thread is 403; an unknown thread is empty); the default thread id is `jarvisThreadId(personId)` in `scripts/conversations.ts`. (2) Step-level progress stays `JobService.subscribe` / `src/lib/job-events.ts`. (3) `GET /__operator/conversations` already lists the thread with job entries merged in (`via: "job:<jobId>:<state>"`); `jobs[]` on it links job ids with their latest state. (4) Server-side hook: `jarvisThreads.onEntry(({ personId, conversationId, entry }) => ...)` in `operator-plugin.ts`.
