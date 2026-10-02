# Shared agent cloud computers: evidence

Programme 1 Oct 2026, Agent F. Real run on this PC, 1 Oct ~18:15 to 18:25 AEST. No secrets, cookies, tokens, pairing codes or
environment values are recorded here or in the evidence file (`D:\prog-scratch\journey\evidence.json`, 33 steps, produced by
`scripts/computers/journey.ts`).

## What ran

| Piece | Real? |
|---|---|
| Hub | the full OS (`vite dev`) from this worktree on `127.0.0.1:8112`, `MU_HUB_ROLE=cloud`, `MU_DATA_DIR=D:\prog-f-data` (fresh), `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, `MU_COMPUTERS_WSL_DISTRO=kali-linux`, person lease 20 s (to show expiry quickly). Not the live 8081 server; not the C: checkout |
| Person | a headless Chrome (throwaway profile) loading the hub page: the hub's first navigation on fresh data is trusted as a **confirmed human session** (`actor: human`, `via: loopback`, person `usman`). Every call below is that session through `/__computers`, with the page token. No bare curl |
| Host | the real WSL2 distro `kali-linux` on this PC, through `wsl.exe -d kali-linux -- bash -s` and `deploy/computers/linux/computer-ctl.sh` |
| Computers | two: `research` (display :101) and `builder` (display :102), each its own folder, session and companion process, paired as `kind: cloud-computer`, `owner: shared` with a one-time code, running the **same companion worker** as a PC (one Node 22 file, run by WSL's own `node`) |
| Connection | through the bridge on the WSL virtual switch address `172.19.48.1:8113` (one interface, seven companion routes only) |
| Jobs | the real job store (`jobs.sqlite`), steps dispatched through the real dispatcher with commandKey `jobId/stepId` |

**What this run did not have: a desktop.** WSL has none of Xvfb, chromium, x11vnc, xdotool. `sudo` needs a password, so nothing was
installed (the exact command for you is in `COMPUTERS-ARCHITECTURE.md` section 9). Both computers therefore ran **headless**
(`desktop: false`): files, commands, leases, takeover, recovery are real; Chromium navigation, the screenshot and the VNC viewer
were **not run for real** (they are proven against in-process fakes; see "Not proven"). The journey script adds the browser steps
automatically once the packages exist.

## The journey

| Time | What | Result |
|---|---|---|
| +0.6 s | Browser session | `authorised`, `actor: human`, person `usman` |
| +9 s | Host check | `ok`; present `node`; missing `Xvfb chromium x11vnc xdotool`; the install command shown; note "runs headless" |
| +12.8 s / +16.0 s | Provision `research`, `builder` | 3564 ms and 3199 ms; each `cloud-computer`, `shared`; both `online` |
| +27 s | Both online, probed inside WSL | companion RSS **73 MB and 74 MB**, one process each, CPU 0 and 11 percent (first sample) |
| +27 s | Isolation inside WSL | `~/mu-computers/research` and `builder`: displays 101 and 102, separate working folders, separate pids (4063, 4195) each the leader of its own session |
| +27 s | **Two agent jobs at once** | both started within 11 ms; at +29.6 s both computers `busy`, each with its own agent (`researcher`, `builder-agent`) and `assigned.by: usman` |
| +33 s | Both finished | wall time **6103 ms** for two jobs of a 6 s wait each: they overlapped. Every step `ok`, `verified`. Each wrote `findings.txt`; `research: "research notes"`, `builder: "builder notes"`: same file name, separate working folders |
| +34.8 s | **Takeover** requested while `research` runs a 7 s wait | answer `pending`: the agent is **not interrupted**; `takeoverPending` set |
| +40.5 s | Agent finishes the wait and stops at the boundary | controller `person:usman`, `paused: researcher`; steps 2 and 3 **not run** (files: `findings.txt`, then `human.txt`) |
| +40.5 s | The person acts | `file.write human.txt`: "Wrote human.txt (39 bytes) and read it back." (input accepted only because the person holds the lease) |
| +40.6 s | Viewer heartbeat | `ok` |
| +40.7 s | **Return to agent** | "resumed the same job". Steps recorded: `paused before step 2`, `control returned to the agent; re-reading the computer`, `refreshed state after the handover: research: headless, no browser installed`, then step 2 and step 3 `ok`. Final files: `after-return-1.txt`, `after-return-2.txt`, `findings.txt`, `human.txt`. Step 1 ran once |
| +41 s to +61.2 s | **Abandoned viewer**: Usman takes idle `builder` and never heartbeats | freed after **20.2 s** (lease 20 s); state `online` |
| +63.4 s | **Stop**: a 60 s wait is cancelled 2 s in | `cancelled` in **13 ms**; step 1 `cancelled`, step 2 `skipped: it was stopped first`; `never.txt` does not exist; `research` back to `online` |
| +85 s | **Crash**: the companion on `builder` is `kill -9`'d while its 40 s step runs | state timeline below |
| +88 s | Crashed job | `unknown`: "Step 1 (wait) may or may not have happened; I did not run it again or run the later steps." Step 2 `skipped`; `after-crash.txt` does **not** exist |
| +88 s | No replay | `builder`'s command ledger before: 4 `done`, 1 `running`; after recovery: 4 `done`, 1 `interrupted`. Same device id, `recoveries: 1` |
| +88.5 s | The recovered computer takes work | a follow-up job `succeeded` |
| +88.9 s to +89.4 s | Teardown through the API | both `destroyed`; `~/mu-computers` held only the shared `bin`, removed |

State timeline for `builder` after the kill (polled every 100 ms):

| After the kill | State | Note |
|---|---|---|
| +0.1 s | `busy` | the hub cannot know yet: a killed process says no goodbye |
| +10.3 s | **`failed`** | "the companion process is not running" (the monitor's next probe); the hub marks the device offline, so the in-flight step becomes uncertain at once |
| +20.3 s | `starting` | automatic recovery (after the short delay; the tick interval is 10 s) |
| +21.9 s | **`online`**, `recoveries: 1` | same pairing, same ledger, same device |

Lifecycle log (from `GET /events`): `failed (the companion process is not running)`, `lease-released`, `recovering (automatic)`,
`recovered (back online with the same pairing)`.

## Defects the real run found, and what was done

1. **A killed companion was noticed only when the step timed out** (the job would have waited 60 s). Fixed: the monitor marks the
   device offline the moment it sees the process gone, so the job settles `unknown` straight away; test added (settles inside 4 s).
2. **Recovery was so quick the `failed` state was nearly invisible** (under a second). Fixed: a recovery delay (default 2 s) and
   a finer poll in the journey; the events log also records `failed` and `recovered`.
3. First journey run aborted on a script bug (a GET with a body); second run stopped on the `failed` condition above. The third
   run (above) is the complete one.

## Teardown

The hub (pid 103624, its `esbuild` and two PowerShell children, and its `sh` parent) was stopped by process id. Checked after:
nothing listening on 8112 or 8113, no journey Chrome left, `~/mu-computers` gone, no `companion.mjs` process in WSL. The live 8081
server, the C: checkout and the owner's own Chrome were never touched. Scratch is on D: only.

## Hub cost measured during the run

Hub process (Windows working set): 635 MB just after start, 1127 MB after the journey; 26 s CPU. The figure is the whole OS as a
dev server, not a production hub.

## Automated tests (all pass)

| Suite | Count | Covers |
|---|---|---|
| `scripts/computers/lease.test.ts` | 9 | one holder, epochs, expiry, takeover, return, withdraw, dead-job cleanup |
| `scripts/computers/computers.test.ts` | 24 | provisioning (real HTTP, real companion worker, one-time code), two concurrent agents, cross-owner refusal before dispatch (display name, device id, bare id), both founders on shared computers, program refused, lease required before queueing, forged lease, no fallback and no "here", revoke and re-pair, takeover, return and no replay, expiry, viewer vanishing, stop, suspend, idle suspend, crash with prompt settle, recovery without replay, auto recovery, destroy, screenshot |
| `scripts/computers/viewer.test.ts` | 4 | the WebSocket viewer: handshake passthrough, input dropped without the lease and forwarded with it, the other founder read-only, unauthenticated, cross-site, program and unknown computer refused |
| `scripts/computers/rfb.test.ts` | 7 | the RFB gate |
| `scripts/computers/bridge.test.ts` | 4 | the bridge: allow-list, header stripping, 404 elsewhere, one interface |
| `scripts/computers/adapters.test.ts` | 12 | wsl-local and vps-ssh command lines (secrets never on a command line), package check, probe, snapshot, bad arguments, the script installs nothing |
| `companion/linux/linux.test.ts` | 12 | URL policy, hub-URL rule, every Linux executor with its read-back, a DevTools-shaped server for the CDP client |
| existing `scripts/devices`, `scripts/identity`, `companion`, `remote-steps`, `screen-goal-remote` | 352 | unchanged behaviour |

## Not proven (honest)

* **Any browser step** (`browser.navigate`, `observe.page`, `input.*`), the **screenshot**, and the **VNC viewer** against a real
  Chromium or `x11vnc`: no desktop packages here. Proven against fakes only.
* **Mehroz's real login**. The rule is proven with simulated Tailscale Serve identity (as Agent B's tests do); the real sign-in
  is broken on this PC (board baseline).
* **A real VM**, `vps-ssh`, the systemd unit and the egress rules: sketched and unit-tested with a fake runner only.
* Whether processes survive a WSL idle shutdown: they survived here because the distro runs systemd; a distro without it may need a keep-alive.

---

# Round 2 (1 Oct, later): Jarvis, the hub-side goal loop, persistence, a real headless browser

Run by `scripts/computers/journey2.ts`: it starts the cloud-role hub itself (port 8112, `MU_DATA_DIR=D:\prog-f-data2`, `MU_COMPUTERS_WSL_DISTRO=kali-linux`), kills it by PID, and restarts it. Headless Chrome with a throwaway profile is the confirmed human session. Evidence file: `D:\prog-scratch\journey2\evidence.json`. Five runs: the first four found bugs (below); the fifth, reported here, was clean. No key, cookie, token or environment value is recorded.

## A real browser in WSL without sudo (item 4)

`sudo` still needs a password, but a **user-level** browser works: `POST /__computers/host/install-browser` runs `npm i playwright-core@1.63.0` and `playwright-core install chromium-headless-shell` into `~/mu-computers/browser` (266 MB on disk; 13 to 17 s here). It runs as the normal user with Chromium's own sandbox on, with no missing libraries. The host check then reads `present: chromium-headless-shell, node`; Xvfb, x11vnc and xdotool are still missing, so there is still **no desktop and no VNC** (`desktop: false`, `browser: true`).

| Time | What | Result |
|---|---|---|
| +31 s | Install the headless browser, no sudo | 16.7 s, `present: [chromium-headless-shell, node]` |
| +35 s / +39 s | Provision research, builder | 4.0 s and 3.7 s; `browser: true`; capabilities now include `browser.navigate`, `observe.page`, `input.click/type/key/scroll` |
| concurrent | Each computer navigates **its own** Chromium to a different public page | research: `example.com`, "the page title reads Example Domain"; builder: `www.wikipedia.org`, "reads Wikipedia"; both `verified`; both jobs in about **2.2 s** wall time |
| | `observe.page` on each | "Page: Example Domain at example.com", "Page: Wikipedia at www.wikipedia.org" |
| | Snapshot (`GET /screenshot`, in memory) | two real JPEGs (17,588 and 49,152 bytes; an earlier run returned identical frames: a wrong-tab bug, fixed, the tab list is most-recent-first) |
| | Resource use, real headless Chromium running, measured inside WSL | **605 MB and 603 MB RSS, 10 processes each** (the companion alone was 73 MB); CPU 0 to 56 percent (a page load) |

## The hub-side goal loop, real Jev, real browser (item 2)

The hub in this run holds a Jev key (reported by `GET /host` as `goalLoop: true`; I never read it). Job on `research`: `browser.navigate example.com`, then the goal "open the Learn more link":

1. `ok browser.navigate: Opened example.com: the page title reads "Example Domain".`
2. `Jev: click link "Learn more" (84% sure; task complete 2%).` (decided on the hub from the computer's `observe.page` controls)
3. `ok input.click: move click link "Learn more": Clicked at 640,451 (sent; not checked).` (the centre of that link, sent to the computer)
4. `ok goal: check: after "click link "Learn more"" the page reads "Example Domains" at www.iana.org` (verified: the page changed, the real title read back)
5. `Jev: the task is complete (78% sure ...)`, then the goal step `ok`; job `succeeded`: "Done on research: 2 steps, each checked."

Earlier runs on the same path: one asked about "Learn more" at 54 then 48 percent and **stopped and asked rather than act** (the 0.6 policy); one stopped "Jev didn't answer, so I stopped rather than guess" after a good first move (a slow answer; a single quick retry was added since). Every decision and move is a job step. Jev sees labels and positions only, and his dictated text as placeholders (a test proves a secret in the goal never appears in any request or step).

The loop's rules are proven by tests with a scripted Jev and a browser model (`goal-loop.test.ts`, 9): it finishes when Jev says done; is refused up front with no key; stops when Jev is unavailable; **never presses a final button** ("Place order"); stops after three moves that change nothing; **cancel** stops it even while Jev is being asked; **a takeover pauses it at a move boundary** and return resumes it after a fresh read without repeating the click; a computer that drops mid-click ends the goal `unknown` with no further decision and no retry.

## Files persist (item 3)

Real (WSL): a job wrote `persist.txt` (27 bytes) into the `research` working folder. Then:

| Restart | Result |
|---|---|
| Computer stopped and started through the API (2.7 s) | `file.read`: "Read persist.txt (27 bytes)"; the restarted computer still drove its browser |
| **Hub killed by PID and started again** (the computers' companions kept running; the hub restored the bridge first) | both computers `online` again with the same device ids, about **11 s after the hub came up**; `file.read` and `file.list` returned the file ("1 file in the working folder") |

Tests (`persistence.test.ts`, 3, real Linux executors over real folders): the file survives stop and start, suspend and resume (a job wakes it), a crash with recovery, and a hub restart on the same data folder and port; another computer never sees it; only `destroy` removes files.

## Jarvis to computers through the one command path (item 1)

Through the real `/__operator/screen/command` route on the real hub, as the confirmed session (typed):

| Said | Result |
|---|---|
| "use the research computer to go to example.com and check the title is Example Domain" | "Started on research: ... It runs there whether or not your PC is on"; a computer job (agent `jarvis`, requester usman): plan, `browser.navigate` verified by title, `screen.goal` ok; `succeeded` |
| "show me the research bot" | "research computer is idle and ready; nobody is using it. Opening it on the Computers page." and `navigate: /computers` |
| "continue that job on its cloud computer" | it had finished: "That job on research finished ... I won't run it again blindly; tell me the next goal" |
| "use the nosuch cloud computer to open example.com" | "There's no shared computer called "nosuch". The shared computers are research, builder. Nothing ran on any other machine." |

Tests (`jarvis.test.ts`, 10) through the real `createCommandService`: both founders may use a shared computer and the job's principal is that founder; a computer that does not exist is refused by name and nothing runs on a founder's own PC; "continue" attaches to a running job, reports an ended or `unknown` one without re-running it, and never attaches to the other founder's job; open-ended goals take the hub loop, typed ones the rule lane; "use my computer", "use the pc" and personal devices are not computer requests (owner rules unchanged). Money or secret words never reach a computer from here.

## Defects found and fixed in round 2

1. The lead's identity rule (a computer token only on the direct local path) rejected the bridge's forwarded Host. Fixed by forwarding the hub's own `127.0.0.1:<port>`; identical to the change now on integration.
2. A restarted hub never heard from its computers again: their companions dial the bridge, which was only started on the next provision. Fixed: the bridge is restored at boot for every stored computer, before the monitor starts.
3. The snapshot showed the wrong (blank) tab; fixed (most recently used tab).
4. A single slow Jev answer ended a goal; one quick retry added.
5. Seen once and not reproduced in three further runs: the first Jarvis job after a hub restart reported "no browser installed" on `research` (the companion decides once, at start, from an environment variable the script sets). The journey now records that variable; not explained.

## Viewer (item 6)

noVNC 1.7.0 (pinned) in a real Chrome against the hub, with a small RFB server behind the proxy (`novnc.test.ts`, 4): it connects, paints the computer's frame (pixel checked), is view-only until "Take control", the click then reaches the computer, and after "Return to agent" it does not. Not run against a real `x11vnc`.

## New tests this round

Goal loop 9, Jarvis 10, persistence 3, noVNC 4, docker adapter 6, RFB gate +1; all pass with the round-1 suites.

## Round 3: viewer and takeover on real desktops

Agent C, 1 Oct 2026. Real run: a cloud-role hub (`vite dev`, port 8096, fresh `MU_DATA_DIR=D:\prog-c2-data`, person lease 30 s, monitor 5 s, `MU_COMPUTERS_DISPLAY_BASE=201`), two computers `c-alpha` (display :201, DevTools 9501) and `c-beta` (:202, 9502) on WSL `kali-linux`, real Xvfb + x11vnc + Chromium 150. Session A is a Chrome profile whose first navigation the hub trusted as a confirmed human (`usman`); session B is a second profile confirmed with a one-time code made by A (a different session of the same person). No tokens, cookies or codes are recorded here.

Setup problems found and fixed first (all invisible until a real desktop existed):
1. WSLg mounts `/tmp/.X11-unix` read-only, so Xvfb died ("failed to create listener for unix"): now `-nolisten unix` (abstract socket) when it is not writable, and readiness waits until the display answers (x11vnc died with "screen size is bogus" otherwise).
2. x11vnc refused ("Wayland display server detected", WSLg exports `WAYLAND_DISPLAY`) and Chromium would have gone to the host desktop: the VNC server and companion now start with `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` unset.
3. The companion looked for the socket file to decide on a headed browser, so it ran headless on a real display: it now also reads `/proc/net/unix`.
4. Another agent's computers used the same display numbers on the same host and the two hubs trampled each other: `MU_COMPUTERS_DISPLAY_BASE`.
5. Found, not fixed (Track A): destroying or starting a computer whose provisioning failed throws "bad computer name" because its record has no adapter handle, so it can never be cleaned up through the API.

| Check | Result |
|---|---|
| Viewer shows the right computer | Two live frames side by side: `c-alpha` shows Chromium on wikipedia.org, `c-beta` shows example.com. Each computer's own CDP page title read from inside WSL: "Wikipedia" and "Example Domain". Screens: `screens/r6-computers-live-d.png` |
| Holder's keyboard and mouse reach the desktop | A took control with the page's button, clicked the search field and typed through noVNC; `c-alpha` CDP `#searchInput.value` = "typed by usman"; `c-beta` unchanged |
| Non-holder cannot act | B (second session, A holding): page shows view-only; API takeover refused ("usman is controlling this computer"), API input refused ("usman holds c-alpha right now"); a writable noVNC client forced against the hub socket connected and sent ZZZ and was dropped by the lease gate; field before and after identical |
| Takeover pauses at a step boundary | Job: wait 9 s, write, write. Request control while the wait ran: `takeoverPending`, the wait finished (not interrupted), then "paused before step 2"; working folder empty while the person held it |
| Return resumes the same job, no replay | After Return: "control returned to the agent; re-reading the computer", observe.page, then steps 2 and 3 ok; step 1 recorded once; both files exist |
| Stop on a busy computer | Job running a 60 s wait; Stop and "Yes, stop it": job `cancelled` after 70 ms, step 2 skipped, the never-written file absent, computer offline, 0 Chromium processes |
| Disconnect and expiry release control | Viewer open 40 s with a 30 s lease: still held (heartbeat). Viewer page left: released 24.8 s later by expiry (not instant: the hub does not release on socket close; Track A could) |
| Restart and reconnect | Start from the page: online and "Screen live" again in about 7 s, no reload |
| Session isolation | Cookie set on `c-alpha` over CDP; `c-beta` cookie list empty and `document.cookie` empty; separate profile folders |
| Not proven | Mehroz's real login (needs Tailscale; the second session here is the same person, which is what the lease checks: person plus session) |

Torn down by PID at the end of the run (hub, computers via the API, my Chrome profiles are scratch).


# Round 3: real desktops (1 Oct, Track A)

Run by `scripts/computers/journey3.ts` (new): it starts a **cloud-role hub** itself (port 8112, `MU_DATA_DIR=D:\prog-f-data3`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`), pairs through a real Chrome session (confirmed human, loopback), provisions **two computers concurrently through the existing API and adapter**, observes the real processes inside WSL, measures, and tears everything down by PID. Evidence: `COMPUTERS-ROUND3-evidence.json` (full log of the measured run), `D:\prog-scratch\journey3\samples.json` (every sample), screenshots `screens/computers-r3-vnc-*.png`. No cookie, token, pairing code, key or environment value is recorded: the only per-process environment read is `MU_COMPUTER_DIR` and `DISPLAY`, and `computer.json` is read through an allow-list (never the token). Nine runs: the first seven found the defects below; the eighth is the measured one; the ninth re-ran the whole path after merging Track C's fixes from integration (clean: two computers provisioned in 3.1 s, both VNC frames painted, navigate p50 957 to 976 ms, stop/start in 0.9 s, torn down).

## Packages (item 2)

Apt sources on kali-linux were checked first: one line, `http://http.kali.org/kali kali-last-snapshot main contrib non-free non-free-firmware` (the official Kali mirror; no `sources.list.d`, no third-party repository). Installed as root through the owner-authorised route (`wsl -d kali-linux -u root`): `apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation`.

| Package | Version |
|---|---|
| xvfb | 2:21.1.24-1 |
| chromium | 150.0.7871.181-1 |
| x11vnc | 0.9.17-3 |
| xdotool | 1:3.20160805.1-5.1+b2 |
| fonts-liberation | 1:2.1.5-3 |

Marker for Track C: `D:\prog-scratch\r3-desktop-packages-ready.txt`. The packages stay installed. Observed gap: no CJK or Arabic-shaping font, so Wikipedia's language names render as boxes; add `fonts-noto-cjk` if page screenshots must read those.

## Two real desktops, concurrently (item 3)

`POST /__computers` for `a-research` and `a-builder` at the same moment: **both 200 in 2.9 s wall** (folders, pairing, Xvfb, x11vnc, companion, first start), both `desktop: true`, `viewer: {snapshot: true, vnc: true}`, 15 capabilities each. Observed inside WSL after provisioning (this hub's home `~/mu-computers-a`, displays from 401):

| | a-research | a-builder |
|---|---|---|
| Xvfb display | `:401`, 1280x800x24, `-nolisten tcp` | `:402` |
| Companion identity | its own device `computer-a-research-xvn17g` | `computer-a-builder-5fxoaw` |
| Companion process | own pid, `MU_COMPUTER_DIR=.../a-research`, `DISPLAY=:401` | own pid, `.../a-builder`, `DISPLAY=:402` |
| Chromium | own process tree, `--user-data-dir=.../a-research/profile`, `--ozone-platform=x11`, **not** headless | own, `.../a-builder/profile` |
| DevTools port | `127.0.0.1:9701` | `127.0.0.1:9702` |
| VNC | `x11vnc -localhost -rfbport 6301` | `6302` |
| Working folder | `.../a-research/work` (`notes.txt`: "research working file") | `.../a-builder/work` ("builder working file") |

Each computer drove its own browser: research to `example.com` (verified title "Example Domain"), builder to `www.wikipedia.org` (verified "Wikipedia"), both jobs in about 1.3 and 2.2 s. The titles were **then read back from each Chromium's own DevTools port** (`/json/list` on 9701 and 9702): `Example Domain` at `https://example.com/` and `Wikipedia` at `https://www.wikipedia.org/`, never crossed. The real screen: noVNC in the real Chrome through the hub's authenticated WebSocket to each computer's x11vnc, 1280x800 canvas each: `screens/computers-r3-vnc-a-research.png` shows Chromium on example.com and `screens/computers-r3-vnc-a-builder.png` shows Wikipedia, each in its own window with its own tab strip. Hub snapshot route: two JPEGs (16.7 KB and 40.8 KB), in memory only.

**Working files survive stop/start**: `a-builder` stopped through the API (state offline, its Xvfb, x11vnc, companion and Chromium gone), started again: online in **0.9 s**, `file.read notes.txt` returned the 20 bytes written before the stop, and the browser navigated to Wikipedia again, verified.

**Listening sockets** (`ss -ltnp`, this hub's ports only): `127.0.0.1:6301`, `:6302` (x11vnc, also `[::1]`), `127.0.0.1:9701`, `:9702` (chromium), and the displays only as **abstract unix sockets** `@/tmp/.X11-unix/X401`, `X402` (Xvfb runs `-nolisten tcp`). Nothing on `0.0.0.0` and nothing on the WSL network address. The hub reaches VNC through a `wsl.exe` byte pipe and the companions reach the hub through the bridge (gateway address, seven routes).

**One honest exception: WSL2's localhost forwarding.** A TCP connect from a Windows process to `127.0.0.1:6301`, `:6302`, `:9701`, `:9702` **succeeds** (so would any WSL loopback port), because WSL2 relays WSL loopback listeners to Windows loopback. The hub's authenticated proxy is therefore not the *only* way in on this PC: any process running on the owner's Windows account can reach each computer's x11vnc (no password) and Chromium DevTools. It is loopback-only (nothing on the network), and Chromium ignores `--remote-debugging-address`, so DevTools cannot be moved off 127.0.0.1 from our side; binding x11vnc to `127.0.0.2` does avoid the relay (tested with a Python listener) but DevTools stays exposed, so I did not change the contract for half the problem. Owner option if this matters: `[wsl2] localhostForwarding=false` in `%USERPROFILE%\.wslconfig`, then `wsl --shutdown` (not tested by me; my reading is that the adapter does not use the relay, since it goes through `wsl.exe` pipes and the gateway address, but anything else you reach in WSL from Windows by `localhost` would stop working). A real VM has no such relay.

## Defects found by running it for real, and fixed (each with a test)

| # | Defect | Fix | Test |
|---|---|---|---|
| 1 | Provisioning two computers at once: both callers started the WSL bridge, the second got "port in use" (500) | `WslLocalAdapter.hubUrl()` shares one in-flight start | `realdesktop.test.ts` (2) |
| 2 | WSLg mounts `/tmp/.X11-unix` **read-only**, so Xvfb can never create its socket file and only has the abstract one; the script and the companion both looked for the file, so every start said "display did not start" and every browser fell back to **headless** behind a black VNC screen | `display_ready` (script, testable through two fixture variables) and `displayReady` (companion, injectable) accept the file **or** the abstract socket in `/proc/net/unix`. Track C fixed the same thing independently; merged into one implementation each | `realdesktop.test.ts`, `linux.test.ts` |
| 3 | WSLg exports `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE=wayland`: x11vnc exits ("Wayland display server detected") and a browser could draw on the **owner's** desktop | every process of a computer is launched with those two variables removed; Chromium gets `--ozone-platform=x11` | `realdesktop.test.ts`, `linux.test.ts` |
| 4 | Display numbers are host-wide but each hub counted from 101: Track C's hub and mine on one distro collided (`Xvfb :101` "server already running"), and the script then **started the computer on the other computer's screen** | the script refuses a display something else already holds (`display :N is already in use by another X server`, exit 6); `MU_COMPUTERS_DISPLAY_BASE` (Track C's env-based version is the one kept) gives a hub its own range (I used 401; `MU_COMPUTERS_HOME` plus `WSLENV` gave my hub its own folder) | `realdesktop.test.ts` (2) |
| 5 | One page opened per navigation and never closed: a computer's Chromium grew **0.6 to 1.45 GB, 20 to 54 processes in three minutes** | keep the newest 4 pages (`MAX_OPEN_TABS`, `trimTabs`), never the page just opened; their sessions are dropped | `linux.test.ts` |
| 6 | The hub's per-computer resource view summed RSS, counting Chromium's shared pages several times (4,975 MB reported for about 0.9 GB) | the probe reads PSS (`smaps_rollup`), RSS only as fallback; live: the hub's view now reads 608 MB for a computer the sampler measured at 565 to 674 | `realdesktop.test.ts` (text) |
| 7 | A mangled edit of mine wrote `$` into every pid file for one run: stop and destroy then killed nothing and the computers showed `failed`. Never shipped (caught by the live run); now pinned | `echo $$ >"$0"` asserted in a test | `realdesktop.test.ts` |
| 8 | (From Track C, via the lead) a computer whose provisioning failed part-way had an empty stored handle, so **destroy and start threw "bad computer name"** and it could not be cleaned up through the API | `handleOf(record)` rebuilds the handle (name, display, VNC port, resolution) from the record whenever the adapter never returned one | `realdesktop.test.ts` (1) |
| 9 | (From Track C, via the lead) closing the viewer socket released nothing: the person kept control until the 90 s lease expired | **Decision:** a person's viewer socket is their presence. When the **last** socket they have open on a computer closes, they get 5 s (`viewerCloseGraceMs`) to come back; then their control is released exactly like "Return to agent" (a paused job resumes after a fresh read, otherwise the computer is free) and a pending takeover is withdrawn. Kept if a socket reopened, or if a lease heartbeat arrived after the close (a page still open and holding the lease the snapshot way). A person who never opened a socket is unaffected (only expiry applies), and expiry stays as the fallback for a close the hub never saw. Another person closing a watch-only socket never releases someone else's control | `viewer.test.ts` (4) |

Track C's other host edits (`computer-ctl.sh` `-nolisten unix` and the wait until the screen answers, `store.ts` env base, `novnc.ts` `?bare=1` and the `refresh` message) were reviewed and kept as they are; the `novnc.ts` change keeps the same-origin check on the message listener and only hides the frame's own header. Also fixed in the sampler tooling, not the product: Windows process-tree sampling was too slow (now cached), and RSS overstated Chromium (PSS now).

## Measured capacity (item 4)

This PC: AMD Ryzen 7 9700X, 16 threads, 31 GB RAM, the WSL2 VM sees 15.5 GB. Hub = the whole OS as a Vite dev server on Windows (cloud role), **23 processes**. Each phase sampled every 2 s for 28 to 46 s, memory as **PSS inside WSL** and CPU from `/proc` ticks. Load = a continuous loop per computer of navigate (verified by title) to four public pages, a screenshot over the hub, and `observe.page`. **Caveat:** Track C's two computers (c-alpha, c-beta, idle desktops) were running in the same VM throughout, so VM-wide figures include them; every per-computer figure is mine only (found through its own pid files).

| Phase | Hub (Windows) mean RSS / CPU | Per computer: companion + Xvfb + x11vnc + Chromium (mean MB) | Chromium CPU (% of one core) | WSL VM used (mean, incl. Track C) |
|---|---|---|---|---|
| **0 computers**, 28 s | 1,140 MB / 2 % | n/a | n/a | 1,200 MB |
| **2 active**, under load, 45 s | 1,142 MB / 13 % | 38+14+10+**352** = 414 and 43+14+10+**357** = 424 | 13.5 and 14.3 (companion 1.7 to 1.9) | 1,887 MB (peak 1,951) |
| **2, pages loaded, idle**, 28 s | 1,139 MB / 7 % | 44+14+10+**398** = 466 and 48+14+10+**359** = 431 | 20.8 and 7.4 | 1,942 MB |
| **1 active**, under load, 44 s | 1,123 MB / 6 % | 49+15+10+**454** = 528 (Chromium peak 515) | 8.6 | 1,598 MB |
| **1, page loaded, idle**, 28 s | 1,116 MB / 4 % | 81+16+12+**565** = 674 (peak 583; the stopped computer had just come back) | 1.3 | 1,261 MB |

Chromium is 12 to 13 processes per computer; the other three parts together are about 65 MB. Roughly **0.45 to 0.55 GB and 0.1 to 0.3 of a core per desktop computer**; a headless computer without a display is about 0.05 GB. The run before defect 5 was fixed grew to 1.4 GB per computer in three minutes (`D:\prog-scratch\journey3\run7-before-tab-fix.log`): the table above is after the fix.

| Responsiveness (ms) | 1 active | 2 active (each) |
|---|---|---|
| Navigate round trip (job queued, page opened, title verified steady), p50 / p95 | 957 / 1,515 | 957 / 1,720 and 957 / 1,705 |
| Screenshot over the hub, p50 / p95 | 412 / 741 | 362 / 478 and 381 / 1,057 |
| `observe.page` job, p50 / p95 | 121 / 145 | 121 / 160 and 122 / 140 |
| Provision two concurrently | n/a | 2,901 (wall) |
| Stop then start one computer to online | 886 to 957 | n/a |

No measurable slowdown from one to two active computers (the navigate median is the same, 957 ms), and all 21 to 22 navigations per computer per phase succeeded.

**Capacity recommendation for this PC (SUPERSEDED by Round 3b below: the 6-computer limit here was an extrapolation and the 4-computer measurement degraded).** Memory is the first limit, not CPU: about 0.5 GB per desktop computer plus the hub's 1.1 to 1.4 GB. I measured only 0, 1 and 2, so anything beyond 2 is a straight-line extrapolation: with the WSL VM's 15.5 GB and the owner's own Windows load, **run up to 6 desktop computers at once as the working limit (about 3 GB, under 2 cores when all browse continuously, far less at an agent's real duty cycle)**, treat 8 as the ceiling without re-measuring, and use headless computers for API and coding steps (about 0.05 GB each). The planning figure for the proposed 8 GB cloud VM in `COMPUTERS-ARCHITECTURE.md` section 8 (4 to 6 desktops) is consistent with these numbers.

## Docker (item 5)

Facts only; nothing was started or changed. Docker Desktop 29.8.0 **is installed** per-user (`%LOCALAPPDATA%\Programs\DockerDesktop`, not under Program Files) and **is running** (GUI and `com.docker.backend` since 03:35 today). `docker` is **not on PATH** (the CLI is at `...\DockerDesktop\resources\bin\docker.exe`). The `docker-desktop` WSL distro shows `Stopped` in `wsl -l -v`, yet the engine answers read-only queries on the `desktop-linux` context (named pipe): server 29.8.0, kernel `6.6.87.2-microsoft-standard-WSL2`, 16 CPUs, 15.2 GiB, **0 containers, 0 images**. Inside kali-linux there is no `docker` binary and no socket. So Docker is a usable runtime on this PC but empty, with its engine on the same WSL2 kernel as kali; the existing Docker adapter (`docker.ts`, 6 tests) has never run against it. **Keep WSL**: the real desktops above need no image, run on the same kernel, and Docker has not shown an improvement (it would add an image pull, a CLI not on PATH and Docker Desktop as a dependency). Revisit only if per-computer filesystem or network isolation becomes a requirement a container gives and a distro folder does not.

## Teardown (item 6)

Computers destroyed through the API (folders and processes gone), the hub killed by PID, the data folder removed; `pgrep` for `mu-computers-a` and `ls ~/mu-computers-a` show only the shared `bin/`. The apt packages stay installed. Track C's `c-*` computers and `~/mu-computers` were not touched (by name and by display range). The Tailscale diagnosis is in `TAILSCALE-DIAGNOSIS.md`: the daemon is wedged in `NoState` (not logged out, network fine), the one owner step is `Restart-Service Tailscale` from an elevated PowerShell.

## Tests and gates

`bun test scripts/computers companion/linux`: 123 pass (14 files; the new ones are 8 in `realdesktop.test.ts`, 4 in `viewer.test.ts`, 3 in `linux.test.ts` for `browserEnv`, `displayReady` and `trimTabs`). After merging integration, `bun run typecheck` and `bun run typecheck:scripts` both report 0 errors.


# Round 3b: host allocator, owned cleanup, and what could be measured (1 Oct, Track A)

## 1. One allocator for the whole host (replaces the per-hub display offset)

`deploy/computers/linux/computer-ctl.sh` now carries a host-level allocator (python3, standard library only, `flock` through `fcntl`). One registry, `~/mu-computers/alloc.json` beside `alloc.lock` (`MU_ALLOC_DIR` overrides it for tests), shared by **every hub on the host** whatever its `MU_COMPUTERS_HOME`:

| Action | What it does, under the lock |
|---|---|
| `alloc <name>` | gives the computer a **display, a VNC port and a DevTools port** that no computer of any hub has, and that nothing on the host is using (X socket file, abstract socket, `/tmp/.X<n>-lock` with a live pid, TCP listeners in `/proc/net/tcp*`). Idempotent per (hub id, computer name). Entry records owner hub id, computer name, folder, creation time, later the device id and pids |
| `alloc-record <name>` | records the pids (with start times) and the device id after a start |
| `alloc-bridge` | gives the **hub** a bridge port: stable per hub id (so running companions still find it after a hub restart), never another hub's, skipping ports the PC refused (`MU_AVOID_PORTS`) |
| destroy | releases the entry |
| reclaim (before every allocation) | an entry is dropped **only if** its folder is gone **and** every recorded process is provably dead (pid gone or start time changed) **and** nothing on the host uses its display or ports **and** (it recorded pids, or it is older than 10 minutes). A stopped computer whose folder exists keeps its numbers; one just allocated is not reclaimed |

The adapter asks the allocator first (before the pairing code is spent), passes the numbers to `provision`, and returns them in the handle; `MU_COMPUTERS_DISPLAY_BASE` is now only where the search starts. The hub id is a hash of the hub's data folder (`plugin.ts`); the companion takes `--browser-port`. Arguments are validated before anything is allocated. The WSL bridge's port comes from the allocator unless `MU_COMPUTERS_BRIDGE_PORT` pins it (the old default, hub port + 1, collided when two hubs sat on adjacent ports).

**Race test (real host, `allocator.test.ts`):** two separate child processes, one per hub id, each fire 10 simultaneous allocations at the same registry: 20 results, 20 distinct displays, 20 distinct VNC ports, 20 distinct DevTools ports, registry holds exactly 10 per hub; asking again returns the same numbers, and the same computer name under a third hub gets a different display.

## 2. Cleanup only ever stops what the computer owns

Every process of a computer (Xvfb, x11vnc, the companion, and the Chromium the companion starts, which inherits it) is launched with `MU_COMPUTER_KEY=<hub>.<name>.<random nonce>` in its environment. The nonce is made at provision (`cfg/owner.key`, mode 0600) and never leaves the host. A process is this computer's **only if its environment carries that exact line**:

* `stop`, `recover` and `destroy` send TERM to those processes, wait, then KILL what is left (re-reading each time). **There is no `pkill` or `pgrep` by name any more**, and no kill by a pid file alone.
* `alive` (and so the probe) needs the pid file's start time **and** the marker, so a recycled pid is never mistaken for the computer's companion.
* Journey scripts and test teardowns go through the API or the script's `destroy`, never by name.

Real-host tests: **(a)** a foreign Xvfb on the neighbouring display survives our `destroy`, while ours (Xvfb and x11vnc) are gone and the folder removed; **(b)** a pid file pointing at a stranger's live process with the correct pid and start time, and another with a wrong start time, are both left running by `stop`, a process that carries the marker but has no pid file (an orphaned browser) is stopped, and the probe does not count the stranger as the computer's companion. Also: the allocator skips a display another X server holds; reclaim leaves a live-pid entry, a stopped computer and a fresh allocation alone and reclaims a dead one whose folder is gone; the bridge port is per hub, stable, and moves when told a port is busy. 6 real-host tests, 3 more adapter-level tests updated.

## 3. Capacity: measured at 2 (round 3), 4 was measured and degraded, 6 was NOT run

The 4-then-6 run was cancelled by the lead while it ran because `C:` was nearly full (the WSL disk lives on `C:`). What it produced before that:

**4 computers, realistic workload, 190 s** (navigate real pages with images and scripts: Wikipedia, MDN, BBC, Hacker News; scroll; screenshot over the hub; read the page back; pauses of 1.5 to 3 s; one noVNC viewer open through the hub proxy on the first computer). The owner's normal apps were running and untouched (ChatGPT 2.9 GB, Chrome 2.7 GB, Claude 2.0 GB, Discord, Docker Desktop, Defender and others):

| Measure | 4 computers (190 s, 63 samples) | Round 3, 2 computers (for comparison) |
|---|---|---|
| **Windows free memory** | **minimum 937 MB, mean 1,692 MB** of 31,912 MB | not recorded then |
| Windows CPU load | mean 74.5 %, **peak 97 %** | not recorded |
| WSL VM memory used | mean 3.6 GB, peak 4.3 GB | 1.9 GB |
| WSL VM CPU | 15.4 % of all 16 threads | 7 to 10 % |
| Per computer, all four processes (PSS) | **718 MB mean** (680 to 772; Chromium 611 to 698, peak about 1 GB) | 414 to 528 MB |
| Per computer CPU | about 22 to 37 % of one core (103 % for all four) | 9 to 29 % |
| Hub (Windows) | 1,055 MB mean, 9.4 % of a core | 1,140 MB |
| Navigate round trip, p50 / p95 | **1,706 / 3,332 ms** (102 navigations) | **957 / 1,515 to 1,720 ms** |
| Screenshot over the hub, p50 / p95 | 412 / 777 ms | 362 to 412 / 478 to 741 ms |
| `observe.page`, p50 / p95 | 117 / 157 ms | 121 / 145 to 160 ms |
| Failed steps | **298** (see below) | 0 |

**What the numbers say.** At 4 computers the PC is at its limit: navigation took 1.8 times as long (p50 1.7 s against 0.96 s), the p95 doubled, per-computer memory rose from about 0.45 GB to 0.72 GB (heavier pages than the example sites used at 2: a real workload costs more than my first estimate), Windows had under 1 GB free at its lowest and the CPU touched 97 %. That is degradation, and it is under the owner's normal load. **Measured limit on this PC: 2 concurrent desktop computers run cleanly; 4 run but degrade and put the host near memory exhaustion. 3 was not measured. 6 was not run** (the two extra computers were provisioned concurrently in 2.7 s and came online, which exercised the allocator for six, but no workload was run on six).

**The 298 failed steps are not explained.** Almost every `input.scroll` step failed (the scroll latency column is empty) and some navigations did too; I did not get to diagnose it (the run was stopped), and the 4-computer latencies above are for the steps that succeeded (102 navigations, 102 screenshots, the page read-backs). Treat the failure count as an open defect in my workload or the scroll executor, not as a finding about capacity.

**Supersedes** the round 3 recommendation of 6 as a working limit, which was a straight-line **estimate** from 0, 1 and 2 computers and was wrong by a wide margin once real pages and a viewer were added. Anything beyond 4 is an estimate and should be read as "do not". Capacity cannot be measured further on this PC until the WSL disk moves off `C:` (owner action, in progress) and the owner's other apps are accounted for.

## 4. Teardown, including a forced one

* On the lead's stop the journey driver had already ended and the hub (port 8112) was gone; the six `a-load` computers were still running inside WSL (about 150 processes). I destroyed all six through the script's `destroy` (the owned-cleanup path: processes found by their marker, folder removed, allocator entry released): `{"ok":true}` six times, zero processes of mine left, no `Xvfb`/`x11vnc` of mine, and the allocator held only the hub's bridge entry.
* Then, inside WSL, **only what this work created**: `~/mu-computers-a` (68 KB left after the destroys: the companion bundle), my `/tmp/mu-alloc-test-*`, `/tmp/dbgown`, `/tmp/mu-live-run-*` and two debug scripts, and `apt-get clean` as root (the apt archive went from 174 MB to 40 KB). `C:` free: **9.81 GB** when I measured, after this cleanup (the lead saw 1.7 GB earlier; my WSL deletions inside the VHDX only free space on `C:` after the disk is compacted or moved, which is the lead's step).
* The lead will then terminate the distro and move it to `D:`. Anything still running in it dies at that point (a **forced** teardown; I believe nothing of mine is left). After the move, the owned-cleanup path should be run once to confirm no stale allocator or pid entries remain; the allocator reclaims only provably-dead entries, so a stale one for a computer whose folder is gone is dropped on the next allocation and one whose folder exists is kept.
* No WSL command was run after the lead's second message. The two checks that need WSL (the real-host tests and the done gate's `bun test scripts/computers companion/linux`, which includes them) are therefore **pending until WSL is back**; before that message the suite passed (129 tests, 15 files) and both typechecks were clean.


## Round 3b follow-up (after the WSL disk moved to `D:\WSL\kali-linux`)

**Stale-state check.** After the forced shutdown: no Xvfb, x11vnc, companion or Chromium of any computer of mine, `~/mu-computers-a` absent, and the allocator holds one entry, the dead hub's **bridge** entry (`bridge:<hub id>`, a port reservation with no process or folder, harmless and reused if that hub returns). Nothing needed reclaiming. The real-host allocator and owned-cleanup tests were then re-run: **130 pass, 0 fail** (`bun test scripts/computers companion/linux`, 15 files); both typechecks report 0 errors.

**The 298 failed steps: a real defect, fixed at its cause.** Reproduced with one computer (16 failed steps in 40 s, scroll latency empty): every `input.scroll` returned `ok` with `verified: null` ("Scrolled down (sent; not checked)"), and a job step counts as `ok` only when it is verified true, so an unchecked step is `unknown` and the whole job `failed`. **No job that scrolled once could ever succeed.** `input.scroll` is now checked by what the page did (scroll position before and after, over the computer's own DevTools): moved the way asked, or already at that edge, is verified true; a page that does not move is `ok:false`. The check waits up to 1.5 s for smooth scrolling to settle. Test in `linux.test.ts` (moved, at the bottom, at the top, stuck, and a backend without scroll state keeps the old unchecked behaviour). Live, one computer: scroll p50 326 ms then 220 ms, steps verified.

**What is still failing, and why that is correct.** About 4 of 10 scrolls in the workload still report "The page did not scroll down" (3 of the first 3 failure samples in every run): some of the pages used (the BBC pages in particular) scroll an inner container, not the window, so the wheel at a fixed point does not move the document. That is now an honest `not verified` rather than a silent job failure. The failure counts below are these steps (the printed samples were all scrolls; I did not break the rest down), and they do not affect navigation, screenshot or read-back figures.

**Re-measured, 3 then 4 computers, 190 s each, same workload** (real pages, scrolling, screenshots, one viewer open through the hub; owner's apps running and untouched; `C:` stayed above 21 GB):

| Measure | 3 computers | 4 computers | (earlier: 2 computers, round 3, lighter pages) |
|---|---|---|---|
| Per computer, all processes (PSS, mean) | 743 MB (677 to 804) | 765 MB (650 to 839) | 414 to 528 MB |
| Per computer CPU | about 24 % of one core (71 % for three) | about 19 % (74 % for four) | 9 to 29 % |
| Navigate p50 / p95 | 1,512 / 3,078 ms (69) | 1,411 / 2,853 ms (89) | 957 / 1,515 to 1,720 ms |
| Screenshot over the hub p50 / p95 | 374 / 594 ms | 428 / 797 ms | 362 to 412 / 478 to 741 ms |
| `observe.page` p50 / p95 | 115 / 222 ms | 117 / 175 ms | 121 / 145 to 160 ms |
| Scroll p50 / p95 (verified) | 220 / 1,594 ms | 222 / 1,603 ms | n/a |
| Hub (Windows) mean / peak | 1,364 / 1,670 MB | 1,509 / 1,786 MB | 1,140 MB |
| WSL VM used, mean / peak | 2.8 / 3.4 GB | 3.7 / 4.3 GB | 1.9 GB |
| WSL VM CPU | 10 % of all threads | 13 % | 7 to 10 % |
| **Windows free memory, minimum / mean** | **1,608 / 2,755 MB** | **435 / 1,418 MB** | not recorded |
| Windows CPU load, mean / peak | 65 % / 93 % | 71 % / 100 % | not recorded |
| Failed steps (unscrollable pages, above) | 29 | 37 | 0 |

**Reading it.** Per-computer memory is about 0.75 GB under a real page workload (the 0.45 GB of round 3 was for two very light example pages). Navigation is steady at about 1.4 to 1.5 s from 3 to 4 (it was 0.96 s on light pages with 2); screenshots and reads stay fast. The limit is the **host**: at 4 computers Windows free memory fell to **435 MB** and the CPU touched **100 %** under the owner's normal apps; at 3 it bottomed at 1.6 GB and 93 %. **Measured: 3 computers run with headroom; 4 run but with the PC at its memory and CPU limit (do not do this while the owner is working); 2 is the comfortable number.** 6 was never run: anything above 4 is an **estimate**, and the estimate is no.

**Teardown.** Each run destroyed its computers through the API, which runs the owned-cleanup path; afterwards `~/mu-computers-a` held only `bin/`, no process of mine remained and the allocator held no `a-load` entries. `C:` free at the end: **21.75 GB**.
