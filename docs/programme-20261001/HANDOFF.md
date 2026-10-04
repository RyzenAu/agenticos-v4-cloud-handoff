# Round 6b addendum (2 Oct 2026)

**Live:** `/__version` = `ea2c4f8` (gate `2d998a85`: 11,804 pass, 0 fail). Rollback tag `rollback/pre-r6b-20261002` (= `166313ec`). Backup of live data taken before the restart and verified: `D:/AgenticOS-backups/backup-20261002T005024Z` (5,608 files).

| Owner request | Result | Evidence |
|---|---|---|
| Fix the creative URL | Live: `/mu-creative-20261001` and `/mu-creative-20261001/` both 200; `/transitions` still the app page | live GETs |
| Concurrent website checks | Each result lands on its own lead in list, drawer and after refresh, under drawer switching, re-sort and close/reopen | real browser on a test hub, search stubbed to force finishing order |
| Real Find search | Mount Druitt dentists: 2 leads added with OpenStreetMap source and locality; a repeat added 0 and kept a manual correction; one POST per submit | 2 live Overpass queries + local SearXNG, isolated test hub, no paid route |
| Seeded test hub; Activity and Computers | Open job lands on the job; missing job says so; Create makes exactly two; viewer view-only until control; holder-only input; takeover, hand-back, Stop | real clicks; computers on this PC's WSL because **Ryzen-PC did not answer ping or SSH** |
| Remaining receptionist launch prep | 32-item status (23 done-tested, 3 done-needs-review, 1 owner decision, 5 live-only); live session sheet; intake validator; failure drills; merge notes | `r6/launch-20261002` at `d8a6d15`, 2,137 tests, 50/50 evals, two reviews fixed; **not merged, NOT SAFE TO SELL** |

**Expected change on Leads:** every lead now stores an explicit website-check result. Old "verified no website" labels could not be proven, so "No website, verified" now shows 0 and "Needs website check" 151 until those leads are re-checked (Find or rescan). No existing value was changed.

**Owner decisions:** (1) mid-month go-live: full fee (Professional A$1,208.90 incl. GST) or days live (A$604.45 for 15 of 30), and whether included minutes halve; (2) live-test validity: until settings change or a failure (current), or also a 90-day re-test.

**Other session's work in the canonical checkout:** uncommitted Aldergate preview listings work under `scripts/lead-sites/` and `docs/v44-adoption/ALDERGATE-PREVIEW-LISTINGS-FIX-20261002.md` appeared after round 6 went live. It is not round 6's; it was preserved untouched and is being served by the live hub.

---

# AgenticOS programme handoff (2 Oct 2026, round 6)

Round 6 is live on the everyday OS. This is not "the OS is finished": everything under sections 2 and 3 is still unverified from your own signed-in session. The round-5 report follows below, unchanged.

**Brooke's website: in progress with Dot.** Nothing of it was opened or touched; her two archives were left unread.

## 1. Live and verified (127.0.0.1:8081)

`/__version` reported `d771c80` after the restart (code `eac77968` plus the gate record). Rollback tag: `rollback/pre-r6-20261002` (= `228bd232`). The owner's 11 uncommitted entries are unchanged by hash. Gate: GATE-RESULT.md.

| Area | What is live | Checked on the live OS by the lead |
|---|---|---|
| Leads (Dot's improvements, reconciled) | compact list, one search box, grouped filters, "No website, verified" and "Needs website check" views | page loads with 841 leads; "dental sydney" 217 matches, "12" 47 (no longer every lead), "#5" 1 |
| Films | `/mu-creative-20261001/index.html`, linked from Studio as "Promotional films" | page and both film files return 200 |
| Health | `/__health` lists SearXNG, Hindsight, companions and model routes | status ok; `bun scripts/ops/check-search.ts` PASS 5 of 5 |
| Everything else in the round (coding, bot workflows, interface fixes, polling) | merged and served | routes return 200; journeys were verified on test hubs, not here |

## 2. Done, awaiting your acceptance

- **Films:** watch both with sound. Not checked by ear. No music bed; end cards use a typeset wordmark; the lead film's "Sun 7:20 pm" stamp sits on a daylight clip.
- **Bot workflows** (Research, Builder, Website audit, Business preparation): proven on the real Ryzen-PC through a test hub only (BOT-WORKFLOWS-R6.md). The live hub still has no bot computers.
- **Coding:** 14 behaviours tested; 3 real jobs on a throwaway repo on `claude:max-2` (CODING-RELIABILITY-R6.md). Voice path, approve/cancel and Codex were not run live.
- **Interface:** 679 controls clicked on a test hub, 14 broken ones fixed (UI-CONTROLS-R6.md).
- **Receptionist:** branch `r6/launch-20261002` at `1d74a4b` in `D:/MU-Receptionist-wt-r6`, 2,061 tests, 50/50 evals, reviewed. **Not merged. NOT SAFE TO SELL** until the live session.
- **Disk:** DISK-R6.md is report only. Nothing was deleted. C: has about 14 GB free.

## 3. Blocked, with the exact prerequisite

| Item | Prerequisite |
|---|---|
| Film spend figure | The Higgsfield API console (four clips were generated on 1 Oct, before this round). The ElevenLabs key cannot read quota or billing; 1,865 characters were used |
| Bot computers on the live OS | Your signed-in click on Create (human-only by design) |
| Ryzen-PC staying awake | Run `deploy/computers/windows/Install-WslKeepAlive.ps1` on Ryzen-PC (unvalidated at a real logon) |
| Receptionist live acceptance | Real calls and provider access, with `docs/LIVE-RUNBOOK-20261002.md` |
| Physical microphone; Mehroz's device | You speaking; Mehroz running the companion |
| Disk cleanup | Your yes on DISK-R6.md, including its criterion "ancestor of live and clean tree" |

## 4. Smallest owner actions

1. Watch the two films with sound.
2. Read the 1 Oct charges in the Higgsfield API console.
3. Computers → Create Research and Builder on Ryzen-PC, then try a research task, takeover and Stop.
4. Decide whether to merge the receptionist branch, and book the live session.
5. Say yes or no to the disk cleanup list.
6. Still open from round 5: Ryzen firewall rule removal, microphone test, Mehroz's companion, Tailscale "Run unattended", mark job `674f4376` superseded.

## Known defects carried forward

- Research on free models still ends "failed" when the model cannot extract a page (it should be partial).
- The production bundle size is unchanged and the hub cannot serve a production build.
- `memory/j5-secrets.test.ts` has a 100 ms timing bound that fails only under full-suite load.
- `approvals.json` ships M&U's own decision list, which a community install would show.
- Round-5 items not addressed: memory screen false positives, `/__jobs` and `/__approvals` not person-scoped, bot hardening (debugging pipe, viewer and display authentication).

---

# AgenticOS programme handoff (2 Oct 2026, round 5 morning report)

One record for Usman and Mehroz. BOARD.md is the tracker and GATE-RESULT.md holds the gate records. This is not "the OS is finished": the real journeys listed under sections 3 and 4 remain unverified.

**Brooke's website: in progress with Dot.** It was excluded from this round entirely; nothing of it was touched.

## 1. Live and verified (everyday OS, 127.0.0.1:8081)

**Revision:** see live `/__version`. Tested code is `ce0e5bb2`. The rollback tag is `rollback/pre-r5-20261002` (= af45e77).

| Area | What is live | How it was verified |
|---|---|---|
| Ryzen-PC as a bot host | The live hub reports host `Ryzen-PC` with everything present (Xvfb, Chromium, x11vnc, xdotool, Node, fonts). Settings are in a git-ignored `.env.local` beside the OS (four non-secret values). | live GET `/__computers/host` |
| Computers page | An "Add a shared computer" control with a host picker, a one-click "Create Research and Builder on Ryzen-PC", honest creating and refusal states, and the true isolation sentence. | rendered at 1440 and 390 on a test hub; the live page loads |
| Coding page | New layout: one muted action line per card, an "Assign work" button, "Mark superseded" and "Unmark" for stale jobs (human-only, recorded), test counts in "Done so far". | live page read |
| Conversation loop | Bot-computer jobs post progress and one web-sourced result into the asker's conversation live, with one spoken completion and honest stopped, failed and unknown endings. Notifications cannot start work. | synthetic and own-hub rendered; not yet run from the live OS (needs your session) |
| Memory screen | Rebuilt from the previous screen under a "never looser" rule: 36 more secret shapes are refused, and ordinary URLs with paths and queries now save. | reviewer's 314-string probe re-run by the lead |
| Interface | 36 routes audited, with repeated buttons and status lines removed on nine pages. Finance puts "What needs you" first and has a real Connect Stripe action. | rendered; independent review |
| SearXNG (search for research and lead discovery) | Repaired. Its Python environment had been orphaned by the Python 3.13→3.14 upgrade. | live search returns results |

**Gate:** see GATE-RESULT.md (full suite, both typechecks, build, clean frozen copy, rendered routes). The owner's 11 files were unchanged by hash.

## 2. Verified on Ryzen-PC (real machine, separate test hub; evidence in LAN-BOT-HOST-EVIDENCE.md)

- **Connection:**
  - Host key `SHA256:FPJlvT3O…hatwk` was matched before first trust.
  - Login is key-only; a password attempt is refused.
  - Our rule allows port 22 from 192.168.1.130 only (but see owner action 2).
- **Environment:** Kali on WSL with 12 GB, 6 threads, mirrored networking.
- **Two desktops (Research and Builder):**
  - Separate screens, browser profiles, cookies, working folders and Linux users.
  - Chromium runs unprivileged with its sandbox on (`chrome://sandbox` "adequately sandboxed").
  - Real fonts render.
- **Real tasks:**
  - Research completed a model-driven research goal in 14–20 s and saved a cited report.
  - Builder produced a file concurrently.
  - No cross-talk of tabs, files or input.
- **Viewer and control:**
  - The viewer works through the hub.
  - Only the lease holder's input is accepted.
  - Takeover pauses at a step boundary, and return resumes without replay.
  - Stop takes about 0.9 s with nothing run afterwards, and left 0 processes behind in 3 of 3 runs.
- **Recovery:** covers hub restart, tunnel kill and a 2-minute outage. Files and cookies survive.
- **Ports:** the bridge, VNC and browser-debugging ports listen on 127.0.0.1 only.
- **Both hosts in one hub:** this PC's WSL and Ryzen-PC ran together, with no allocation collisions.
- **Capacity (measured):**

  | Desktops | Rating | Mean CPU | Free RAM |
  |---|---|---|---|
  | 2 | comfortable | 25% | 9.0 GB |
  | 3 | headroom | — | — |
  | 4 | headroom | 41% | 8.0 GB |

  Not measured above 4. Recommended operating count: 2, with 3 when needed.
- **Disk:** Windows physical disk is 412 GB free of 465 GB. WSL's 1 TB figure is virtual.
- **True isolation boundary:** separate Linux users and private folders on ONE shared VM. Loopback services (browser debugging, viewer, display) are shared, so Research and Builder are one trust domain, not separate machines. Next hardening is recorded in LAN-BOT-HOST.md.

## 3. Finished but not live or not yet exercised from the live OS

- **Research and Builder on the live hub:** not created. Creating a bot computer is human-only by design, so it is owner action 1.
- **Live checks:** viewer, takeover, Stop and "task returns without refresh" are proven on the test hub against the real Ryzen-PC, not yet from the live OS.
- **Receptionist:** branch `r5/readiness-20261002` in `D:/MU-Receptionist-wt-prog-20261001`.
  - 1,991 tests and 50 of 50 evals pass.
  - Professional at 1,200 minutes = A$1,249.00 + A$124.90 GST = A$1,373.90, with no setup line.
  - The single runbook is `docs/LIVE-RUNBOOK-20261002.md`.
  - **NOT SAFE TO SELL** until the live session passes.
- **Creative:**
  - Two silent graphics tracks (90 s and 78 s), captions, edit lists, clip prompts and an assembly script are prepared.
  - The films are not rendered: 0 of 4 clips, narration not recorded, US$0 known spend.
- **Memory acceptance:** 31 of 31 on the real engine with a disposable bank (since deleted). The owner's own bank and vault were never touched.
- **OpenShell:** unmerged pilot branch. **context-mode:** off by default.

## 4. Still blocked or unverified, with the exact reason

| Item | Reason |
|---|---|
| Physical microphone acceptance | Needs you speaking (VOICE-TURNS.md). All voice evidence is synthetic. |
| Mehroz's PC and voice control | Needs Mehroz to run the companion (docs/MEHROZ-ENROL.md). Tailscale is working again. |
| Receptionist live acceptance | Needs real calls and provider access; nothing live was changed. |
| Films | Need footage and narration (paid generation), and the Higgsfield API ledger is unverified. |
| Ryzen-PC survives hub restarts without re-recovery | Needs an owner-side keep-alive on Ryzen-PC (action 3). Without it, WSL idles out and computers auto-recover. |
| Cloud server | Declined by the owner; not purchased. |

## 5. Smallest owner actions

1. **Create the two bot computers:** open Computers in your signed-in OS and press **Create Research and Builder on Ryzen-PC**. Then try: "Jarvis, use the research computer to research …", watch it, take over, hand back, Stop.
2. **Ryzen-PC firewall (admin PowerShell on Ryzen-PC):** two extra rules named `sshd` allow SSH from any device on that network. A Windows prompt created them, not our script. Remove them: `Get-NetFirewallRule -DisplayName sshd | Remove-NetFirewallRule`. Login is key-only either way.
3. **Ryzen-PC keep-alive (on Ryzen-PC, user level):** add a logon task or Startup shortcut running `wsl.exe -d kali-linux -u root --exec sleep infinity`, so desktops survive hub restarts.
4. **Coding:** on the creative job (`674f4376`), press **Mark superseded**; its work is live at `/mu-creative-20261001/`.
5. **Microphone:** the 5-minute test in VOICE-TURNS.md.
6. **Mehroz:** run `D:/prog-scratch/dist/mu-companion.exe` per docs/MEHROZ-ENROL.md.
7. **Receptionist:** one live session with `docs/LIVE-RUNBOOK-20261002.md`.
8. **Films:** approve or decline generating the four clips and the Scotty narration (within the US$25 total). Also turn on Tailscale "Run unattended" if you haven't yet.

## Remaining defects (known, with next action)

- **Memory screen:** still refuses a few ordinary texts ("…runbook is docs/runbooks/key-rotation.md", "the access token is refreshed … cached for 6 hours"). Pre-existing secret-shape gaps are listed in MEMORY-ACCEPTANCE-R5.md.
- **Research completeness:** "complete" is the executor's own sufficiency rule. The Canberra goal never found a population figure, and the report says so.
- **Ryzen-PC network:** its network path blackholes ad-tracker hosts. Pages now open on DOM-ready and stable, with a "still loading background requests" note.
- **Report job link:** the "Open job" link goes to the Activity list, not a specific job.
- **Older routes:** `/__jobs` and `/__approvals` are still not person-scoped.
- **Adoption records:** NEXUS has no record; the V4.4 archive's licence is unconfirmed; the board's OSWorld and OpenShell rows are corrected in ADOPTION-RECONCILIATION-R5.md.
