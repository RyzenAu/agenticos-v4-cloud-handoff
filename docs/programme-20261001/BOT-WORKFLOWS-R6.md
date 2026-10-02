# Bot-computer workflows (round 6, Builder C)

Branch `r6/bots-20261002`, from `228bd232`. Four reusable workflows run on a shared bot computer, each keeps ONE saved result on the hub that opens from the OS, and each returns exactly one result entry and one end entry to the conversation that asked.

Isolation is described the same way everywhere: **separate Linux users, browser profiles and 700 folders on ONE shared Kali environment (one trust domain), not separate machines.** The recommendation stays two desktops.

Evidence labels: **real LAN host** = Ryzen-PC (Windows 11 + WSL2 kali-linux) through the SSH adapter, driven by a separate test hub on this PC (port 8153, synthetic data folder `D:\AgenticOS-r6-data`); **real local computer** = this PC's WSL (not used: Ryzen was reachable); **synthetic** = in-process companion and fake browser in the automated tests. The live hub (8081) and its computers were not touched; it has no bot computers.

## 1. What was built

| Piece | Where |
|---|---|
| Saved results (artifacts): one folder per job on the hub, owner-only, idempotent, sandboxed serving, safe markdown page | `scripts/computers/artifacts.ts`, routes in `scripts/computers/routes.ts` (`GET /__computers/artifacts`, `/artifacts/<jobId>`, `/artifacts/<jobId>/f/<file>`) |
| Research completeness check (the R5 defect) | `scripts/computers/research.ts` (`requestedItems`, `ruleCoverage`, `relatedFacts`, `requiredSources`, gap rounds, "Not found" in the report) |
| Builder workflow | `scripts/computers/workflows/builder.ts` + `companion/linux/build-workspace.ts` |
| Website audit workflow (+ synthetic fixture with planted defects) | `scripts/computers/workflows/audit.ts`, `audit-fixture.ts` + `companion/linux/audit-script.ts` |
| Business preparation workflow | `scripts/computers/workflows/bizprep.ts` |
| Shared workflow plumbing and the one gate every move passes | `scripts/computers/workflows/common.ts`, `index.ts`; hooked into `scripts/computers/service.ts` |
| New typed executors on the computer | `companion/linux/workflow-executors.ts`: `build.component`, `fixture.open`, `page.audit`, `page.links`, `file.chunk` |
| Spoken routing ("audit ...", "build ... component", "prepare a comparison table ...") | `scripts/computers/jarvis.ts` (`planWorkflow`) |
| Conversation: workflow progress lines, "Open saved result" button, **Open job lands on the job** | `scripts/jarvis-command/threads.ts`, `src/lib/thread-events.ts`, `src/components/floating-oracle.tsx`, `src/components/activity/activity-view.tsx`, `src/routes/activity.tsx` |
| Test hub launcher and the real-host driver | `scripts/computers/r6-hub.ps1`, `scripts/computers/journey-r6.ts` |
| Ryzen-PC keep-alive (prepared, validated, NOT applied) | `deploy/computers/windows/Install-WslKeepAlive.ps1` |

`companion/linux/*` is outside the stated scope (`scripts/computers/**`) but the workflows cannot run without these five executors; they are new files plus a small registration in `executors-linux.ts` and no existing executor changed behaviour.

## 2. How a workflow runs

A workflow is a job step the HUB runs (`executor: "builder" | "audit" | "bizprep"`, and `"research"` as before). Every move is a typed executor on the computer, sent through the job's control lease, and each result is the computer's own read-back. One gate runs before every move: stopped, then a person taking over (the move waits at that boundary), then the time budget. A workflow holds no key, sends nothing, publishes nothing and deploys nothing. It ends by keeping one artifact on the hub and appending ONE result entry (`<jobId>:report:1`) to the conversation; the job's own end (`<jobId>:succeeded`, `:failed`, `:cancelled`, `:unknown`) is the one completion and the one spoken line.

Files come back from the computer in pieces of 8 KB (`file.chunk`, because a companion reply is capped at 16 KB), joined on the hub and checked against the computer's SHA-256 of the whole file; a file that does not match is not saved. A bulk pull logs ONE job step, not one per piece.

### Research
Given a business or topic, it searches (the hub's SearXNG), opens and reads real pages in the computer's own Chromium, extracts cited facts (a fact is kept only if its quote is on the page), compares, writes a concise cited report, saves `report.md` and `evidence.json` as the artifact, and returns the report to the conversation.

**Completeness (the fix).** "Complete" used to be the executor's own sufficiency rule. Now the request is split into the things it asks for (a model lists them, with a rule fallback; instructions about method such as "compare" or "cite" are never items), each item is checked against the cited facts (a model judges, and a numeric item needs a fact with a number), a goal that asks for "two reliable sources" is checked for two sources that gave cited facts, and an item no fact covers triggers up to two targeted searches. If it is still missing the run is **partial**, the report says `Not found: <item>` in the answer, in the uncertainties and in a "What was asked for" list, and a related fact the model would not accept as the answer is shown beside it as "Closest match, not the answer asked for", never counted as found.

### Builder
Makes or updates ONE small website component on the Builder computer, in an **isolated git worktree** (`repo/` is the base site on `main`; each job gets `wt-<id>` on branch `job/<id>`). A connected model writes the component (validated here: plain names, small, no remote loads, no network or dynamic-code calls); with none, a fixed template does (and an "update the pricing card" request changes the existing card). The computer commits it, runs the checks (tags balance, images have alt, nothing loaded from elsewhere, scripts parse, no whitespace errors, clean tree), makes the diff and a self-contained preview page, and photographs the preview at 1280 and 390 wide. The artifact is `builder.md` (readable change summary and verification table), `preview.html` (sandboxed, no network), `change.diff`, the component files, `checks.json` and the screenshots. Nothing is merged, pushed or deployed.

### Website audit
Read-only. Authorised targets only: the exact host names the hub is configured with (default `dental-care-plus.muventures.com.au`, M&U's own public demo site) or the built-in local fixture (a synthetic clinic site with planted defects, written into the computer's own folder). Anything else, including any host containing `brooke`, is refused before a computer is touched. It opens the home page, measures and photographs it at 1280x800 and 390x844 (mobile emulation), checks the home page's same-site links with read-only GETs, and reads the contact or service pages a visitor would go to at phone width. Findings are prioritised (P1 blocks or misleads a visitor, P2 makes them work harder, P3 minor), each with its evidence and screenshot; the report lists what was NOT checked (contrast, keyboard order, speed, anything behind a login). Forms are counted, never filled or submitted.

### Business preparation
A comparison table or draft proposal from SYNTHETIC information (the request's own options, or the built-in synthetic clinic packages), saved as `comparison.md` or `proposal.md`, `comparison.csv` and `data.json`, and written into the computer's own folder and read back. Every dollar figure is computed here and recomputed against the information before saving (GST is 10% of the ex-GST price); a mismatch ends the work instead of saving. A model may only write the short framing paragraph, without numbers. A spreadsheet formula in a CSV cell is defused.

## 3. Safety rules kept

Never read or print `.env*`, environment variables, keys or tokens (none was). Brooke's website was not opened, audited or touched, and the audit refuses it by name. No deploy, no messages, no purchases, no cloud. The SSH key was never read; the host key presented by Ryzen-PC was checked against the expected `SHA256:FPJlvT3Ow9+feqIyVBE+xAA6p/oLzCEHPoRxHrhatwk` before anything connected (it matched; `ssh-keygen -lf` of a fresh `ssh-keyscan`). No change was made to Ryzen's sshd, firewall or WSL configuration.

## 3b. Security review fixes (after the first report)

An independent review accepted these findings; each was fixed with a test that failed first (`scripts/computers/workflows-security.test.ts`, 15 tests):

1. **Audit allow-list.** A link the page called "same site" was opened unchecked; `https://dental-care-plus.muventures.com.au.evil.example/contact` was navigated and reported under the allowed host. Now the page script compares `URL.origin`, and the hub re-runs the allow-list (exact host AND port, https, no credentials, the audited host only) before EVERY page it opens or link it checks, and ignores the page's own "same site" flag. The port must be the standard one. A page is never labelled with a host it was not on.
2. **In-page analysis is data.** It is rebuilt field by field (types, clamped numbers, cleaned and capped strings and lists, no control characters, markdown link, table or heading characters), and its address is asserted on every read: a late redirect ends the audit of that page as "left the authorised site" (the home page fails the audit; a journey page is skipped with a note). Page-controlled text never appears in the conversation entry (a broken link is announced as "Broken link", its text stays inside the artifact, cleaned).
3. **Builder "nothing loaded from elsewhere".** Attributes are parsed (quoted, single-quoted and unquoted), and meta refresh, object, embed, srcset, external script, stylesheet, style and `@import` are refused; script is refused if it can reach the network or navigate (`Image`, `sendBeacon`, `location`, `fetch`, element building, `import()`, and similar). The bot-side preview and fixture pages are opened with the network blocked BEFORE the page loads (offline emulation plus a block on http, https, ws, wss and ftp), so the rule is enforced and not only pattern-matched.
4. **Research cannot call an uncited item covered.** Rule coverage now needs the item's OWN words (the capitalised subject such as "Canberra" does not count, so a fact about the naming of Canberra no longer covers "the population of Canberra"); the model's list of items can never be shorter than what the rules found; a rule-only fallback therefore cannot make a run complete without a specific citation for every item.
5. **Link checks follow redirects by hand** (`redirect: manual`), each hop checked against the same public-address rules before it is fetched; a redirect to a private, tailnet or metadata address is never requested.
6. Minor: a path that cannot be resolved is refused (fail closed); a malformed percent-escape in a link cannot throw past the audit's single exit; a page-supplied "Saved result:" line is neutralised by the hub and the conversation's button needs the hub's own line as the last line before the job id; the loosened research assertion in `workflows.test.ts` is restored to every item (the third item is the "two reliable sources" requirement).
7. Keep-alive installer: no `-u root`, `-Remove` stops a running instance, exact distro match (validated on this PC with `-WhatIf`, `-Remove -WhatIf` and a refused `-Distro kali`).

After these fixes one real-host re-run of all five workflows on Ryzen-PC through the test hub passed (research complete, builder complete with preview screenshots taken from the network-blocked page, both audits complete, business preparation complete; then torn down and tidied as before).

## 4. What ran, where, how long (real LAN host unless stated)

Test hub: this PC, `127.0.0.1:8153`, `MU_HUB_ROLE=cloud`, synthetic data folder `D:\AgenticOS-r6-data\data`, SSH adapter to `ryzen-bots` (reverse-tunnel remote port 18153), X displays 60 and 61 (VNC 5960/5961, DevTools 9360/9361). Two computers, `research` and `builder`, as separate Linux users with 700 folders on ONE shared Kali environment. The companion bundle Ryzen ran carried the new executors (checked: none missing). Every artifact is on the hub at `<data>/computers/artifacts/<jobId>/` and opens from `/__computers/artifacts/<jobId>`; curated copies are in `docs/programme-20261001/r6-evidence/`.

| Workflow (spoken phrase) | Host label | Duration | Result | Evidence |
|---|---|---|---|---|
| Research: "Use the Research computer to research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is." (the R5 goal) | real LAN host | 22 to 38 s over four runs | **complete**: 4 of 4 asked-for items found and cited (founded, named, population, two sources). The first run, before the item fixes, was honestly **partial** | `artifact-research-canberra-complete.md` |
| Research with an item that is not on the web: "...: Find the exact number of pigeons that landed on the Sydney Harbour Bridge on 14 March 2019, and the Australian Museum's opening hours." | real LAN host | 102 s | **partial**: opening hours found and cited ("Open daily 10am-5pm (closed Christmas Day)"); the pigeon count reported as `Not found`; "What was asked for" says NOT FOUND | `artifact-research-partial-not-found.md` |
| Builder: "...build an opening hours component for the clinic site" (and "update the pricing card to show the price including GST") | real LAN host | 9 s | **complete**: model-written component, isolated worktree `job/<id>`, 9 of 9 checks run by the computer, diff, preview, desktop and phone screenshots; base `main` untouched | `artifact-builder.md`, `artifact-builder-change.diff`, `ryzen-builder-preview-desktop.jpg`, `r6-artifact-builder-1440.png` |
| Website audit of M&U's own demo site: "...audit https://dental-care-plus.muventures.com.au" | real LAN host | 10 s | **complete**: 6 findings (0 P1, 6 P2: small tap targets and small text on three pages), 4 screenshots, 9 links checked (0 broken) | `artifact-audit-dental.md`, `ryzen-audit-dental-home-*.jpg` |
| Website audit of the local fixture: "...audit the demo clinic fixture" | real LAN host | 5 s | **complete**: 7 findings (2 P1: no mobile viewport setting, a broken "Book a visit" link; plus the planted tap-target, alt-text and unlabelled-form problems), 4 screenshots | `artifact-audit-fixture.md`, `ryzen-audit-fixture-home-phone.jpg` |
| Business preparation: "...prepare a comparison table of three website packages" | real LAN host, synthetic data | 1 s | **complete**: Starter $690, Standard $1,090, Plus $1,990 ex GST with GST and inc-GST recomputed and matched; saved in the computer's folder and as an artifact | `artifact-bizprep-comparison.md`, `r6-artifact-bizprep-1440.png` |
| Refusals | n/a | instant | `audit https://example.com` and `audit https://brooke.muventures.com.au` answered "not on the list ... Nothing was opened"; no job was made | `evidence-workflows.json` |

Each of the five job runs wrote ONE `report` entry offering the saved result and ONE end entry in the asking conversation (`evidence-workflows.json`, "completion": 1 each). Model use: the existing router's free text routes (OpenRouter and Groq) for extraction, component writing and framing, and Jev for decisions (catalogue price US$0.042 per million input tokens: about 7 decisions of a few hundred tokens a run, an estimate of well under US$0.001 a run). No other paid use.

## 5. Proven on the real host through the test hub

| Item | Result | Detail |
|---|---|---|
| Research and Builder concurrently, no cross-talk | PASS | A real research job and a builder job ran together for 72 s. Research's tabs and files: only its own pages and `report-*.md`; Builder's: only `repo`, `wt-*`, `preview-*`, `change-*` and its own screenshots. No `wt-`, `repo` or `preview-` on Research, no audit or research files on Builder. One result entry and one end entry for each job (`evidence-concurrent.json`). |
| Takeover and hand-back | PASS | Input without the lease: 409 "agent holds research right now; take control first". Takeover during an audit: 200 `pending`, the person held the computer 1.1 s later at a step boundary; the job stayed `running`, no step ran in the next 6 s (9 steps before and after); the person's `file.write` was accepted; the conversation said "Paused: usman is taking control ... does not run until control is returned". After "return" the job re-read the page first ("refreshed state after the handover"), finished, saved its artifact, and wrote one result and one end entry. |
| Stop | PASS | "stop that task" cancelled a running audit (the move in flight finished first: 8.6 s to settle); no artifact, one "Stopped: ... Nothing further ran." entry, no step after the stop. A forced Stop of the Builder computer took 1.2 s, the job was `cancelled`, input to the stopped computer was refused (409), that computer's processes were gone (companions 2 to 1), and it started again. |
| Reconnect after a tunnel drop | PASS | The supervised tunnel's ssh was killed during an audit, and again during a real research job (five attempts in 19 s, of which two landed on the live ssh; the others met the already-restarted one). Both jobs finished `succeeded` with their artifacts and one completion each: the tunnel came back in about a second each time (backoff 1, 2, 5 s), inside the companion's retry window, so no step was lost. A fresh job after the drops ran and was saved; the 28 earlier artifacts still opened. |
| Hub restart mid-job | PASS | The hub was killed (process tree) while an audit was at step 2, and started again. The job's status afterwards: `unknown`, "Interrupted by a restart: the outcome is unknown and it was not re-run" (8 steps, nothing replayed). The conversation carries ONE "Ended without a confirmed outcome" entry and no result entry. Both computers were online again at once (the companions had kept running), artifacts 29 before and 29 after (the 3 sampled still opened, 200), and a new job after the restart ran and saved in 1.3 s. |
| Artifacts persist | PASS | 29 artifacts before and after the hub restart; each is a folder on the hub, independent of the computer. |
| Isolation | as measured | Displays 60 and 61, separate VNC and DevTools ports, separate work folders; Chromium on Ryzen ran as each computer's own user. One shared WSL VM: a trust domain, not two machines. |
| Teardown | done | Both computers destroyed through the hub (0 `mu-` users, 0 Xvfb, x11vnc, companion or Chromium processes, nothing listening on 18153, 59xx or 93xx), the hub stopped, the tunnel ssh gone, and the one folder this round created on Ryzen (`/var/lib/mu-computers`, holding only the companion bundle and the allocator state) removed with non-recursive `rm` and `rmdir` of files this round wrote. Ryzen's WSL was `Stopped` when the round began and is left to idle out. |

## 6. Conversation continuity checklist

Automated: `scripts/jarvis-command/continuity-r6.test.ts` (17 tests: 14 on synthetic computers behind the real command, thread and gate code, 3 on the real computers hub with an in-process companion), plus the round-5 suites that still pass. Rendered: `journey-r6.ts --phase rendered` on the test hub at 1440 and 390 wide, headless Chrome, with a marker proving the page was never reloaded.

| # | Requirement | Result | Where |
|---|---|---|---|
| 1 | Progress appears without refresh | PASS | Test: "each workflow's progress, result and completion arrive once" (all four kinds). Rendered: "Started" and "Website audit, step 1 of 5" appeared mid-run at 390 wide with `pageNeverReloaded: true` (`r6-chat-m-2-progress.png`). |
| 2 | Results are durable and waiting when the user returns | PASS | Test: "a person who was away finds the result waiting" (the store and a new stream replay in order, no second spoken line). Rendered: a new page load showed all earlier results with 29 "Open saved result" buttons (`r6-chat-return.png`). |
| 3 | No duplicate jobs or completions across reconnect, restart, duplicate events | PASS | Tests: the same event id is one command (another person's same id is theirs); a completion delivered twice is one entry; a hub restart mid-job backfills steps once and speaks the end once; a job running when the hub died ends `unknown` once and is never re-run. Real host: the restart and tunnel runs above. |
| 4 | Correct failure and cancellation messages | PASS | Tests: "Failed: ... reason" with no result entry and no "finished"; "stop that task" gives "Stopped: ... Nothing further ran." and no artifact. Rendered at both widths: `r6-chat-d-5-stopped.png`, `r6-chat-d-6-failed.png` (a stopped audit and a failed job). |
| 5 | Speech respects mute, quiet mode and interruption (synthetic audio only) | PASS | Tests: quiet mode writes the end but speaks nothing (the gate holds it for the HUD); `canAnnounce` is false when muted, while he is talking, mid-turn or while speaking; the queue waits, drops a stale line and never queues a duplicate; one spoken line per ending, none for a replay. No real audio was used. Not rendered: speech has no screen. |
| 6 | Two conversations each receive only their own result | PASS (automated only) | Test: two people, two jobs, two streams; each thread and stream holds only its own; a delivery into the other's job is refused; artifacts open only for their owner (the real-hub test checks the 404). The test hub has one browser session (Usman), so this was not rendered. |
| 7 | Personal-device ownership stays owner-specific | PASS (automated only) | Test on the real computers hub: the other founder cannot assign a workflow to a personal PC (404) or see it as a target; nothing ran on it; his own shared-computer job and artifact are his alone. |
| 8 | Shared bots have one control holder at a time | PASS | Test: while one founder holds the computer the other's takeover is not granted and his input is refused (409). Real host: only one founder session exists, so the rule was shown with one person against the agent (input refused without the lease, takeover waits for the boundary, only the holder's input accepted). |

## 7. Defects fixed this round

1. **Research "complete" was the executor's own rule** (known R5 defect): every asked-for item is now checked against the cited facts; a missing one is searched for, and if still missing the run is partial and says `Not found`.
2. **"Open job" went to the Activity list**: it now opens `/activity#job-<id>` on that job (state, steps, saved result), also for a job older than the list.
3. Found on the real host: method words ("compare", "cite", "two reliable sources") were counted as asked-for items and made a finished run partial; the first colon (not the last) started the item list; a multi-part request with one unfindable part ended `failed` because the source picker judged results against the whole task and rule extraction looked only at the first 10 goal words. Each is fixed with a test.
4. The model's "related fact" is no longer silently dropped or counted as found: it is shown beside `Not found` as "Closest match, not the answer asked for" (the real Canberra run's ACT population figure).
5. Smaller: artifact page italics and the builder's preview frame, the Activity selected-job scroll margin, "claim was dropped" grammar.

## 8. Still only test-hub evidence

- Everything above ran on a SEPARATE hub from this PC. The live hub (8081, `228bd23`) has no bot computers; creating them is the owner's click, and the workflows have not run from the live OS.
- One founder session only on the real host: two-conversation separation, personal-device ownership and the second founder's refusal are automated tests, not real-host runs.
- Speech: synthetic sessions only; no microphone, no audio.
- Hub restart: the companions kept running through the 4-second outage (WSL stayed awake), so "computers back" was immediate. A long outage lets WSL idle out and the computers auto-recover (round 5's 2-minute test); that was not repeated here. This is what the keep-alive below removes.
- The audit measures what the page reports (sizes, alt text, labels, overflow); contrast, keyboard order and speed are not measured and the report says so. Findings on `dental-care-plus.muventures.com.au` are a point-in-time read of a public demo page.
- A research request whose pages the model's extraction cannot read still ends `failed` ("nothing saved"), not partial. The one real run of that kind (an unfindable item) now ends partial, but extraction by a free model is not deterministic.

## 9. Ryzen-PC keep-alive: ONE owner step (prepared, validated as far as possible, NOT applied)

On Ryzen-PC, signed in as `mkhan`: copy `deploy/computers/windows/Install-WslKeepAlive.ps1` (one file) there and run

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-WslKeepAlive.ps1 -StartNow
```

It registers a per-user logon task named "WSL keep-alive (kali-linux)" that runs, hidden, exactly `wsl.exe -d kali-linux --exec sleep infinity` (no `-u root`: keeping the distro awake needs no privilege; limited rights, no time limit, restarted if it ends), and falls back to a hidden script in that user's Startup folder if the task cannot be registered. Nothing else is touched (no firewall, sshd or `.wslconfig`). `-WhatIf` shows the plan; `-Remove` takes it out and also stops a keep-alive instance that is running; the distro name is matched exactly (a line of `wsl -l -q`, so `kali` does not match `kali-linux`). It starts at the next logon, or now with `-StartNow`.

Validated on this PC without applying: the script parses (0 errors); `-WhatIf` prints the plan and every cmdlet parameter is accepted (the task objects are built in memory), registering nothing; the exact command (with `sleep 6`), run hidden through the Startup-fallback mechanism, started a hidden `wsl` process, showed `sleep` running inside the distro, and exited cleanly. Read-only checks on Ryzen: user `mkhan`, PowerShell 5.1, Task Scheduler running, `wsl.exe` present, no existing keep-alive task, Startup folder present and empty, distro `kali-linux` present. NOT validated: the task actually registering and firing under `mkhan` at a real logon (that needs the owner's run), and whether Ryzen logs on by itself after a reboot (the keep-alive starts at logon; with no logon the distro idles out as before).

## 10. Re-running it

`powershell -File scripts\computers\r6-hub.ps1 start` (also `stop`, `kill`), then `bun scripts/computers/journey-r6.ts --phase up|workflows|research|concurrent|control|reconnect|restart|rendered|teardown`. The driver needs the same `ryzen-bots` alias and the confirmed browser session; it prints no key, token or environment value.

## 11. Round 6b: the observability gate (Activity and Computers, driven for real)

Evidence labels: **real LAN host** (Ryzen-PC), **real local computer** (this PC's WSL, kali-linux, real Xvfb/x11vnc/companion), **synthetic** (seeded fake data on an isolated hub). Screenshots (synthetic data only) are in `docs/programme-20261001/screens/r6b/computers/`, with the evidence JSON. Browser: headless Chrome via Playwright, real clicks and keys, at 1440 and 390 px. Hub on 8153 with its own data folder; the live hub (8081) was never touched.

Seed (an EMPTY isolated folder only; it refuses `.operator-data` and any non-empty folder; only non-secret host values):

```
bun scripts/acceptance/seed-gate-hub.ts --data D:\AgenticOS-r6-data\gate --host none|local-wsl|ryzen
powershell -File scripts\computers\r6-hub.ps1 start -DataDir D:\AgenticOS-r6-data\gate -HostFile D:\AgenticOS-r6-data\gate\gate-host.json
bun scripts/acceptance/seed-gate-hub.ts --data D:\AgenticOS-r6-data\gate --host none --phase live   # running + awaiting-approval jobs, made after the hub is up
bun scripts/acceptance/r6b-gate-drive.ts --scenario activity | computers-none | computers-unreachable | computers-ryzen [--size d|m --activate keyboard] | computers-controls | teardown
```

The live phase is separate because a hub restart turns a running job into unknown and a waiting one into interrupted.

**Activity (synthetic).** Every "Open job" link in the conversation (succeeded x3, failed, stopped, unknown, interrupted, awaiting approval) lands on `/activity#job-<id>`, the job panel is in view (top at 80 px) with aria-label "Job xxxxxxxx", and its row is marked. A running job's only conversation entry is "started", which by design offers no link (the live chip carries it). A job id that does not exist says "Job 0b1c2d3e isn't in the job history". The three result entries open their saved artifact (`/__computers/artifacts/<id>`) in a new tab. Keyboard: Tab reaches "Open job", the focus ring is visible, Enter navigates.

**Computers, host = none (synthetic).** "No computer host is configured on this hub, so there is nowhere to add one."; no create button; API create gives 409 with the same words.

**Computers, host unreachable (real LAN host, Ryzen-PC was OFFLINE: ping and TCP/22 time out; see the "not observable" note).** The host reads "Linux host over SSH. Not available: The host didn't answer: ssh: connect to host ... port 22: Connection timed out."; no pair button; API create gives 409 "This host can't run a computer: the host did not answer ...". Nothing is created.

**Computers, host = local-wsl (real local computer).** Picker: "This PC (WSL), Ready: Xvfb, chromium, x11vnc, xdotool, node, fonts". One click offers "Create Research and Builder on This PC (WSL)". A real double click (mouse, 1440) and a keyboard double Enter (390) each created exactly two computers (research, builder), never four; the button is disabled while creating and the notice says so. After creation:
- Viewer: "Open computer" shows the screen live, view-only, before taking control (390 shows the same card).
- Input: without the lease a person's input gets 409 "Take control of research first."; after "Take control" the card says "You" and the holder's input is accepted (200); a program principal is refused 403.
- "Return to agent" frees the computer. With an agent job running, "Request control" pauses it at a step boundary (steps stop advancing for 8 s), the person holds, "Return to agent" resumes the same job to success, no step replayed.
- "Stop" asks "Stop this computer?" with "Yes, stop it" / "Keep it"; confirming cancels the job, later steps do not run (the file never appears), input to it gets 409; "Start" brings it back online. Keep it, by keyboard, leaves it online.
- Delete: not offered on the page (destroy is API-only); destroy was used at teardown.
- Isolation sentence as shown: "Shared computers on one host have separate Linux users and files but share that host; they are not separate machines." It matches the adapter (separate Linux users, one shared host).
- Keyboard: Tab walks every control (pair button, Assign work, Open/Hide computer, Take control, Stop, Keep it, Work and result, Agent/model/routines) and each shows a visible focus ring.

**Defects found and fixed (failing first where a test could hold it).**
1. A host that did not answer was labelled with its technical key ("vps-ssh") and said to be "missing xvfb, chromium, ..." (packages it was never asked about). Now "Linux host over SSH" and "The host didn't answer: ...". `script-adapter.ts`, `computers-client.ts`, `add-computer.tsx` (tests added).
2. A ready host did not say it was ready; now "Ready: ...". With no SSH host ready, this PC's WSL gets the same one-click pair.
3. The job chip masked "https://..." as a file path ("audit http<file 1>"). `maskGoal` PATH pattern fixed (test failed first).
4. A real bug found by the hand-back run: after "Return to agent" the job failed with "No page is open on this computer" because the re-read used `observe.page` only. It now falls back to `computer.info`/`echo`. `service.ts`; test "a computer with no page open is still re-read after a hand-back" failed first.
5. With a long job label in the header chip, the breadcrumb ran 60 px (1440) and 30 px (768) under the chip. Measured by `r6b-header-probe.ts` (overlap 60/30 before, 0 after); the chip now shrinks instead.

**Not observable, and why.** Ryzen-PC was offline for the whole round (no ping, TCP/22 timed out), so creation, viewer and control on the real LAN host could not be re-driven; the full flow above is on the real local computer instead, and the real host contributes the unreachable wording only. A second founder's session and typing through the VNC canvas were not driven (the input path was exercised through the lease-checked input API). The Ryzen-offline screenshots are left out because they show the LAN address. The local WSL `~/mu-computers` was restored from backup after the run.
