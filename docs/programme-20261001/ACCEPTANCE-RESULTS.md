# Acceptance results (outcome-based)

Run aacb81 on 2026-10-01T03:58:42.672Z at commit `8237181` (prog/integration-20261001), this PC (Windows 11; WSL2 distro for the shared computers).

Adapted from OSWorld's idea (see REFERENCE-ADOPTION.md): each task is data (instruction, initial state, evaluator), and every check reads the OBSERVED state of the application, file, ledger or receipt. An agent's or driver's own "done" is never evidence. Fixtures are synthetic (`SYNTHETIC-ACCEPT-*`): no real lead, client or number.

**8 pass, 3 partial, 0 fail, 0 blocked, 1 owed.**

Status meaning: PASS = all probes passed and at least one is a REAL run (what is still unproven is in the last column). PARTIAL = passed only at a mocked/synthetic level; the real run is blocked. BLOCKED = nothing could run. OWED = evaluator ready, needs the owner. FAIL = observed state was wrong.

| # | Task | Status | Strongest passing label | Fresh or earlier | What is still not proven / the exact blocker |
|---|---|---|---|---|---|
| 1 | Two bots work independently | PASS | real-local-computer | earlier evidence (2026-09-30 18:24) | not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account |
| 2 | Files survive a desktop restart | PARTIAL | synthetic-integration | run now | a real desktop restart isn't observed: the WSL computers have no desktop (Xvfb, chromium, x11vnc, xdotool are missing and sudo needs the owner's password): run `sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` in the distro, then re-run scripts/computers/journey.ts |
| 3 | Browser sessions stay assigned | PARTIAL | real-local-computer | earlier evidence (2026-09-30 18:24) | unknown: a real browser session per agent (the real run observed computer and job assignment only, not browser tabs). the WSL computers have no desktop (Xvfb, chromium, x11vnc, xdotool are missing and sudo needs the owner's password): run `sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` in the distro, then re-run scripts/computers/journey.ts |
| 4 | Takeover blocks the agent's input | PASS | real-local-computer | earlier evidence (2026-09-30 18:24) | not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account |
| 5 | Return resumes with fresh state | PASS | real-local-computer | earlier evidence (2026-09-30 18:24) | not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account |
| 6 | Cancel stops later actions | PASS | real-local-computer | run now |  |
| 7 | An interrupted action is not replayed | PASS | real-local-computer | run now |  |
| 8 | Ownership is refused before dispatch and at execution | PARTIAL | synthetic-integration | run now | the other founder's real PC isn't here: a real remote-device run needs Mehroz to pair his own PC (docs/programme-20261001/worker-evidence.md, owners proof) |
| 9 | A usable PowerPoint presentation | PASS | real-local-computer | run now |  |
| 10 | A spoken compound command | OWED | - | - | needs the owner's real microphone: say the sentence at the Jarvis page, then save that job's steps and the companion ledger as JSON ({transcript, heardByPipeline, jobSteps[{executor,outcome}], ledger[]}) and run with ACCEPT_SPOKEN_OBSERVATION=<file>. The evaluator (evaluators.ts: spokenCompound) is ready and unit-tested |
| 11 | A real coding job: receipt and output | PASS | live-provider | earlier evidence (2026-09-30 18:04) | no new paid job was run: the recorded job's receipts and its git output were re-read and re-evaluated |
| 12 | A restart preserves jobs without duplicate execution | PASS | real-local-computer | run now |  |

## Labels

| Label | Tasks with a passing probe at this label |
|---|---|
| mocked | none |
| synthetic-integration | 1, 2, 3, 4, 5, 6, 7, 8, 12 |
| real-local-computer | 1, 3, 4, 5, 6, 7, 9, 12 |
| real-cloud-vm | none |
| real-remote-device | none |
| live-provider | 11 |

`real-cloud-vm` is empty by nature: no cloud VM exists yet. `real-remote-device` needs the other founder's own PC.

## Per task

### 1. Two bots work independently: PASS

Blocker / not proven: not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account

- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "two agents run concurrently"
  - ok: a test matching /two jobs overlap in time/ ran and passed
  - ok: a test matching /second job on a busy computer is refused/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: two computers were busy at the same moment, each under its own agent and its own job
  - ok: both jobs ended succeeded, and overlapped (wall time well under running them one after the other)
  - ok: each computer's file holds its OWN text (same file name, different content)
  - ok: separate working folders and separate processes

### 2. Files survive a desktop restart: PARTIAL

Blocker / not proven: a real desktop restart isn't observed: the WSL computers have no desktop (Xvfb, chromium, x11vnc, xdotool are missing and sudo needs the owner's password): run `sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` in the distro, then re-run scripts/computers/journey.ts

- **synthetic-integration**, run now: scripts/acceptance/synthetic-computers.ts (real computer service + store; fake host)
  - ok: the file existed before the restart with the expected text
  - ok: the desktop/session was really restarted (a new session id or a new start time)
  - ok: the same file is read back after the restart with the same text

### 3. Browser sessions stay assigned: PARTIAL

Blocker / not proven: unknown: a real browser session per agent (the real run observed computer and job assignment only, not browser tabs). the WSL computers have no desktop (Xvfb, chromium, x11vnc, xdotool are missing and sudo needs the owner's password): run `sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` in the distro, then re-run scripts/computers/journey.ts

- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "takeover and return"
  - ok: a test matching /a person takes control mid-job/ ran and passed
  - ok: a test matching /viewer that vanishes while an agent is paused gives the computer back to that same job/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: each computer was assigned to its own agent, by the person who started it
  - ok: through takeover the controller went agent -> person and the paused job stayed the assigned agent's
  - ok: on return the SAME job went back to the same agent and finished

### 4. Takeover blocks the agent's input: PASS

Blocker / not proven: not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account

- **synthetic-integration**, run now: bun test scripts/computers/lease.test.ts
  - ok: a test matching /the agent holds until it hands over; only then does the person hold/ ran and passed
  - ok: a test matching /stale epoch is refused/ ran and passed
  - ok: no test in that run failed
- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "a program with no confirmed session cannot take a computer over"
  - ok: a test matching /program with no confirmed session cannot take a computer over or send it input/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: the takeover request did not interrupt the agent's running step (it waited for the step boundary)
  - ok: while the person held control, the agent's later files did not exist and the person's file did
  - ok: the person's own input was accepted and read back
  - ok: the job recorded that it paused before its next step

### 5. Return resumes with fresh state: PASS

Blocker / not proven: not shown on a real cloud VM: no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account

- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "takeover and return"
  - ok: a test matching /return resumes the same job after a fresh read/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: return resumed the SAME job
  - ok: the agent re-read the computer before its next step (fresh state after the handover)
  - ok: the remaining steps then ran in order and the job ended succeeded
  - ok: the first step ran exactly once, and the person's file is still there beside the agent's

### 6. Cancel stops later actions: PASS

- **synthetic-integration**, run now: bun test scripts/devices/companion-executors.test.ts -t "cancel through submit"
  - ok: a test matching /job's stop cancels the command on the companion and PowerPoint's run is killed/ ran and passed
  - ok: a test matching /already-stopped job sends nothing/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: the stopped job ended cancelled, quickly, with its later step skipped
  - ok: the file the skipped step would have written does not exist
  - ok: the computer is free again afterwards
- **real-local-computer**, run now: scripts/devices/real-local-proof.ts c1 and c2 against an isolated hub and a real companion
  - ok: real PC companion: stopped right after step 1, only step 1 ever reached its ledger
  - ok: the job stopped after step 1 is not a success
  - ok: real PC companion: stopped during step 2, step 2 is cancelled in its ledger
  - ok: step 3 never reached the companion's ledger after the stop
  - ok: the job stopped during step 2 is not a success

### 7. An interrupted action is not replayed: PASS

- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "lifecycle and recovery"
  - ok: a test matching /dead companion shows failed, recover restarts it with the same pairing, and the step that was in flight is not replayed/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, earlier evidence written 2026-09-30T18:24:19.526Z: scripts/computers/journey.ts (real WSL computers on this PC): D:\prog-scratch\journey\evidence.json
  - ok: the job whose computer died ended 'unknown' (not succeeded, not failed-and-retried)
  - ok: the later step never ran and its file does not exist
  - ok: the recovered computer's ledger moved running -> interrupted and the count of finished steps did not change
  - ok: it came back as the same device and took new work
- **real-local-computer**, run now: scripts/devices/real-local-proof.ts d (real companion killed mid-step, restarted)
  - ok: real PC companion killed mid-step: the job did not end succeeded
  - ok: the step that was running is 'interrupted' in the companion's own ledger after it restarted
  - ok: after the restart nothing was delivered again and the later step never ran

### 8. Ownership is refused before dispatch and at execution: PARTIAL

Blocker / not proven: the other founder's real PC isn't here: a real remote-device run needs Mehroz to pair his own PC (docs/programme-20261001/worker-evidence.md, owners proof)

- **synthetic-integration**, run now: bun test scripts/devices/target-contract.test.ts -t "device ownership"
  - ok: a test matching /not by name, id, spokenTarget, originDeviceId or a person's display name/ ran and passed
  - ok: a test matching /companion's own gate refuses a command signed for someone else/ ran and passed
  - ok: no test in that run failed
- **synthetic-integration**, run now: bun test scripts/computers/computers.test.ts -t "ownership"
  - ok: a test matching /never reach the other founder's PC: refused BEFORE dispatch/ ran and passed
  - ok: a test matching /command to a shared computer without a live lease is refused before it is queued/ ran and passed
  - ok: no test in that run failed
- **synthetic-integration**, run now: bun test scripts/devices/companion.test.ts -t "local permission boundaries"
  - ok: a test matching /non-allow-listed executors are refused on the PC even if the hub sends them/ ran and passed
  - ok: no test in that run failed

### 9. A usable PowerPoint presentation: PASS

- **real-local-computer**, run now: the real deck.blank executor (PowerPoint COM), then PowerPoint read back independently
  - ok: PowerPoint has the presentation open (found by its own object model, not by a window title)
  - ok: it has at least 1 slide(s) (read from PowerPoint)
  - ok: the first slide's title text is the requested title (read from PowerPoint)
  - note: executor said: {"name":"SYNTHETIC M\u0026U Acceptance Deck aacb81","slides":1,"layout":1,"path":"","title64":"U1lOVEhFVElDIE0mVSBBY2NlcHRhbmNlIERlY2sgYWFjYjgx"}

### 10. A spoken compound command: OWED

Blocker / not proven: needs the owner's real microphone: say the sentence at the Jarvis page, then save that job's steps and the companion ledger as JSON ({transcript, heardByPipeline, jobSteps[{executor,outcome}], ledger[]}) and run with ACCEPT_SPOKEN_OBSERVATION=<file>. The evaluator (evaluators.ts: spokenCompound) is ready and unit-tested

No probe ran.


### 11. A real coding job: receipt and output: PASS

Blocker / not proven: no new paid job was run: the recorded job's receipts and its git output were re-read and re-evaluated

- **live-provider**, earlier evidence written 2026-09-30T18:04:04.741Z: job receipts (D:\AgenticOS-prog-int\docs\programme-20261001\coding-job-result.json) and the repo in git (D:\prog-scratch\job2)
  - ok: a receipt exists for the builder and for the reviewer
  - ok: both ran on a named second account slot, not the default
  - ok: requested and reported models agree and differ between builder and reviewer
  - ok: the CLI version and execution location are recorded
  - ok: the OUTPUT exists in git: the job branch has the function and exactly one commit; the base branch is untouched
  - ok: tests at the head passed and the review verdict is for that same head

### 12. A restart preserves jobs without duplicate execution: PASS

- **synthetic-integration**, run now: bun test scripts/coding/orchestrator.test.ts -t "restart and resume"
  - ok: a test matching /a restart interrupts the build; nothing replays; an explicit resume continues the SAME native session/ ran and passed
  - ok: no test in that run failed
- **synthetic-integration**, run now: bun test scripts/devices/target-contract.test.ts -t "no duplicate dispatch"
  - ok: a test matching /same key from the same person while it runs is one command/ ran and passed
  - ok: a test matching /finished one is reused within the window/ ran and passed
  - ok: no test in that run failed
- **real-local-computer**, run now: an isolated hub process killed and started again on the same data, with a real companion
  - ok: every job that existed before the restart is still there after it
  - ok: a job that was running when the hub died is now uncertain ('unknown' or 'interrupted'), never still 'running' and never 'succeeded' on its own
  - ok: nothing was executed a second time by the restart (execution count unchanged, nothing resumed on its own)
  - ok: finished steps are kept exactly
  - note: Found by this probe on its first run: the isolated hub (scripts/devices/local-hub.ts) never ran the startup recovery the real OS runs (JobService.recover via scripts/jobs/runtime.ts), so a job killed mid-step stayed 'running' forever. Fixed there (it now recovers: running becomes unknown, never re-run); the real OS was not affected.

## Cleanup

- removed: close the acceptance presentation (and PowerPoint, if this run started it and it is now empty)
- removed: isolated hub and its companion
- removed: scratch folder D:\prog-scratch\acceptance-aacb81

Cleanup touches only what this run created: its scratch folder, the isolated hub and companion it started, and the one presentation it opened (closed by its unique title). Nothing of the owner's, the live 8081 server, the WSL computers of another run, or any other presentation is touched.

## Re-run

```
bun scripts/acceptance/run.ts            # all twelve
bun scripts/acceptance/run.ts --only 9   # one task
```
