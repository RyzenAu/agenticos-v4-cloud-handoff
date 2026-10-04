# Shared agent cloud computers: architecture, permissions, cost

Programme 1 Oct 2026, Agent F. Status: **built, tested (72 new tests in 7 files: 9 lease, 24 end-to-end service, 4 viewer, 7 RFB gate, 4 bridge, 12 adapter, 12 Linux
executor; 352 existing devices, identity and companion tests unchanged), and run for real on a WSL2 host without a desktop** (`COMPUTERS-EVIDENCE.md`). Nothing
is deployed, bought or signed in. The real desktop (Chromium, screen, VNC) needs one owner command (section 9).

## 1. Decision in one paragraph

A shared cloud computer is an isolated Linux desktop (own X display, own Chromium profile, own working folder) that runs the
**same companion worker every PC runs**, paired as a device of kind `cloud-computer` and owner `shared`, in the **one** device
registry. Every command to one is gated by a **control lease** (one controller at a time, enforced where the command is
queued). A provisioning **adapter** (first `wsl-local`, second `vps-ssh`) creates and runs the desktop; everything above the
adapter is identical on a WSL distro and on a Sydney VM. The hub is the brain and holds every key; a computer is hands and holds
only its own pairing token.

## 2. Who may control what

| Target | Usman | Mehroz |
|---|---|---|
| Usman's PC | allowed | denied |
| Mehroz's PC | denied | allowed |
| Shared cloud computers | control + takeover | control + takeover |

An agent gets exactly the targets of the founder who started it (`by`), never more. One rule, enforced in one place:
`scripts/devices/route.ts resolveTarget` (every command, from any entry, is resolved from the **verified** person; a display
name, a device id, `personId`/`deviceId` in a body or `computer:<id>` naming someone else's PC resolves to nothing).

* Personal devices: owner only (unchanged). A device's `owner` is a person id; the new value `shared` is **never** a person id, so
  every existing `device.owner === person` check fails closed for a computer, and only code that means to allow it does.
* Shared computers: reachable by name ("the research computer") or exactly by `computer:<device id>`, for either founder. Never
  "here", never a default, never a bare "computer" (that means the person's own PC). No fallback: an offline computer fails with
  "nothing ran" and is never replaced by another machine.
* Cross-owner refusal happens **before dispatch**: `Dispatcher.submit` resolves first; a refusal queues nothing (asserted:
  `dispatcher.recent()` is empty after seven cross-owner attempts including a device id and a display name).
* `scripts/computers/permissions.ts` answers the same table for the API (`mayControl`, `permittedTargets`, `mayTakeOver`).

## 3. The control lease

One record per computer (`scripts/computers/lease.ts`, pure, injected clock): holder (an agent job or a person session),
**fencing epoch**, expiry, a pending takeover, and the paused job.

| Rule | How |
|---|---|
| One controller at a time | `acquireAgent` refuses a held computer (with who holds it). A second job is refused, nothing is queued behind it. |
| Enforced at dispatch | `Dispatcher.guard` (set by the service) checks `lease {holder, epoch}` before anything is queued. No lease, a wrong holder or a stale epoch: refused, `notRun`. A forged lease is refused. |
| Expiry frees it | Agent lease 60 s, renewed per step and on a timer; person lease 90 s, renewed by the viewer heartbeat. Not renewed: free. An abandoned viewer freed a computer in 20.2 s with a 20 s lease (evidence). |
| Takeover pauses at a safe boundary | A person asks; the agent finishes its **current** step (never interrupted), then `handOver` passes the lease (new epoch). Steps after it have not run. |
| Return resumes the same job | `returnToAgent` gives the lease back to the paused job under a new epoch. The job first **re-reads the computer** (`observe.page`, else `computer.info`), records it, then continues. A step that completed is never replayed (commandKey `jobId/stepId`, and the companion's ledger). |
| Viewer vanishes while paused | Lease expiry hands the computer back to that job (it re-reads and continues). |
| Stale holders | After a takeover the paused agent's old epoch is dead: its late command is refused even if it arrives. |
| Stop | `cancel` aborts the running step on the computer, records later steps as skipped, releases the lease before the job's terminal state is written. |

The lease is in memory on purpose (as in OpenMausBot's control record): a restarted hub starts with every computer free, and
`jobs.recover()` has already marked an interrupted job; nothing is replayed.

## 4. Lifecycle and states

States: `starting`, `online` (idle), `busy` (a lease is held, by an agent job or a person), `asleep` (suspended on purpose),
`offline` (stopped on purpose, or not heard from), `failed` (a process died or a start failed). Busy comes from the lease
(instant), not the companion's heartbeat flag (which lags by a heartbeat).

Adapter interface (`scripts/computers/types.ts`): `check`, `provision`, `start`, `stop`, `suspend`, `resume`, `recover`,
`destroy`, `probe` (resource use), `snapshot`, `openVnc`. Actions: start, stop, suspend, resume, recover, destroy; stop and
suspend refuse a computer a job holds unless `force` (which cancels the job first).

* **Monitor** (every 10 s, configurable): probes each running computer. A dead companion on a computer that was online: `failed`,
  and the hub immediately marks the device offline so whatever it had been handed becomes `uncertain` **at once** (a killed
  process says no goodbye; without this the job would wait out its step timeout), then restarts it after a short delay
  (`recoverDelayMs`, 2 s; at most 3 automatic recoveries). Recovery is the same pairing, profile and command ledger: the step that
  was in flight is asked about (`observe`), the ledger says `interrupted`, and **it is not replayed**.
* **Idle suspend**: `MU_COMPUTERS_IDLE_SUSPEND_MS` (default off). Nothing holds it and nothing has touched it for that long:
  `suspend`; a job wakes it (`resume`).
* **Sleep** for `wsl-local` and `vps-ssh` = stop the processes, keep the disk (profile, working folder, ledger, pairing). It
  frees RAM and CPU, **not money** on a VPS: a stopped VM normally still bills for its reserved CPU and disk (check at purchase;
  a provider snapshot and power-off is the stronger option and is a provider API call this code deliberately does not make).
* Cloud jobs keep running with both PCs off: a computer is paired to the hub, not to a PC.

## 5. What runs on a computer

The companion (`companion/linux/main.ts`, one Node 22 file, `deploy/computers/build-companion.ts`). Executors, each returning
its **own** read-back as `verified`:

| Executor | Verification |
|---|---|
| `echo`, `wait`, `notify` | connectivity, cancel |
| `computer.info` | what this computer is (desktop or headless, browser installed) |
| `file.write` / `file.read` / `file.list` | its own working folder only (jailed names, 256 KB cap); write is verified by reading the file back |
| `browser.navigate {url, expectTitle?}` | public http(s) page in **its own** Chromium profile; verified by the page's real title, steady on two reads, complete, same host; a redirect into a private address is closed and refused |
| `observe.page` | title, address, and a frame's size and hash kept **in memory only** |
| `input.click`, `input.type`, `input.key` | sent; verified only if the step names `expectTitle`/`expectUrl` (then read back) |
| `app.open {name:"chromium"}` | DevTools port answers |
| `screen.goal {goal}` | the same contract as a PC's (goal, sub-step progress, verified result), limited to goals a rule can plan ("go to X and check the title is Y"). An open-ended goal is **refused, not guessed** |

Not included, on purpose: a shell, send, pay, delete, publish, or any executor that can reach a private address. Risky names
are refused at the hub (`isRisky`) and have no approval path for a shared computer (an approval names a person, never `shared`).

**Jarvis and `screen.goal`.** Agent B's Windows `screen.goal` runs Jev's model loop on the PC with that PC's keys. A cloud
computer must not hold provider keys (its browser visits the open web), so the open-ended loop stays a hub-side job: the hub's
model plans, the computer executes typed steps. The seam is `ComputersService.startJob` (typed steps) and the Linux
`screen.goal` executor (rule-planned goals). Until a hub-side planner exists, `resolveTarget` resolves "on the research
computer" but the Jarvis command service answers that a computer runs as a computer job (one line in
`scripts/jarvis-command/service.ts`), rather than running a Windows step on a Linux box.

## 6. The viewer

* **Live (full desktop)**: a WebSocket on the hub, `/__computers/<name>/vnc`, carrying RFB between a noVNC client in the page and
  the computer's own `x11vnc`, which binds **127.0.0.1 inside the computer**. The hub reaches it through a stdio tunnel the
  adapter opens (`wsl.exe ... /dev/tcp`, `ssh -W`): **no network port exists**, public or on the hub's own address. Gates, all
  before a byte moves: a confirmed person (not a program or a bare Tailscale login), same-origin (no cross-site WebSocket
  hijack), then `RfbGate` filters the stream: framebuffer requests always pass; key, pointer and clipboard only while that
  viewer **holds the lease**, re-checked on every message (a lease taken back stops input at once); a viewer that pipelines input
  before the handshake finishes gets it dropped; unknown messages close the stream; a server that needs a VNC password is refused.
* **Snapshot (fallback, and the cheap one)**: `GET /__computers/<name>/screenshot`, one JPEG of the browser taken over the
  browser's own DevTools port, in memory, read-only for either founder.

Why both: noVNC is the only thing that shows the real desktop and lets a person act with a mouse, and it is what OpenMausBot
ships. A JPEG poll needs nothing installed beyond Chromium and is enough to watch an agent, but not to drive one. The live viewer
was proven with synthetic RFB (handshake, gating, refusals); it has not been run against a real `x11vnc` because the packages are
not installed here (section 9). The noVNC client (MPL-2.0) is Agent C's page concern: use it as an npm dependency, do not copy its files.

## 7. Security

| Risk | Control |
|---|---|
| A public VNC/DevTools port | None exists. VNC on 127.0.0.1 inside the computer; DevTools on 127.0.0.1 inside it; the hub reaches VNC by stdio tunnel. The bridge listens on one private interface and refuses `0.0.0.0`. |
| A computer posing as a person | Its token is valid only on `/__devices/companion/*`; everywhere else it is refused (`principal.ts`). It arrives on a loopback socket (same host) or through the bridge, which strips Tailscale, cookie, forwarding and page-token headers and presents the hub's own loopback Host (the hub accepts a computer's token only on its direct local path, the lead's 1 Oct rule; the bridge passes only the seven companion routes, where that token is the whole identity). |
| A browser aimed at the hub or the network | `urlpolicy.ts`: http(s) only, no credentials, no localhost or `.local`/`.internal`, every resolved address public (private, loopback, CGNAT/tailnet, link-local and metadata all refused, numeric tricks decoded), re-checked on the page it landed on. The VPS rule `vps/egress.nft` closes the rebinding gap at the network. |
| A takeover by a script | Lifecycle, takeover, return, input and the viewer need a **person** (confirmed browser session or paired device); any local program holds the page token, so a program is refused. Starting an agent job is allowed to a verified process and inherits that founder. |
| Secrets on a computer | No provider keys, no `.env`; the token is in `computer.json` (0600), never printed or returned; pairing codes are single-use, 10 minutes, bound to the name. |
| Screenshots | In memory only; never written to disk by a computer or the hub. |
| Isolation strength | `wsl-local` shares the owner's PC (kernel, disk, Windows interop): it proves the code, it is not a security boundary. A VM is. Each computer has its own folder, display, profile and session; on a VPS give each its own Unix user (`systemd` unit template). |

## 8. Resource and cost

**Measured here** (Windows 11, WSL2 Kali, 1 Oct; `COMPUTERS-EVIDENCE.md`):

| Item | Measured |
|---|---|
| Hub, the whole OS as a Vite dev server, cloud role | 635 MB right after start, **1127 MB** after the journey (Windows working set); 26 s CPU over 5 minutes, mostly start-up |
| One computer's companion (Node 22), idle, headless | **71 to 77 MB RSS**, 0 to 3 percent of a core, one process |
| Provisioning one computer | 3.2 to 4.1 s (folders, pairing, start) after the one-off companion build and copy |
| Companion file | 56 KB (one Node file) |
| Detect a killed companion | up to the monitor interval (10 s measured: failed at +10.3 s); back online 11.6 s after that (+21.9 s) |
| Lease takeover to pause | the agent's current step (5.7 s for a 7 s wait that was 1.3 s in); hand-back to resumed step under 0.3 s |
| Abandoned viewer | freed at 20.2 s with a 20 s lease |

**Not measured here (no Xvfb or Chromium installed)**: the desktop. Planning figures, to be replaced by the first real probe
(`GET /__computers` shows `resource.rssMb` and `cpuPct` per computer): Xvfb about 25 MB; x11vnc about 15 MB; **Chromium with one
ordinary page 300 to 500 MB**, near idle CPU, a full core for a few seconds while a page loads. So a **desktop computer is about 0.4
to 0.6 GB and a headless computer (API and coding steps) about 0.08 GB**. Lightweight API and coding tasks need no desktop.

**Hub cost vs agent-desktop cost.** The hub is the fixed cost and is already proposed (`CLOUD-ARCHITECTURE.md` section 8:
BinaryLane Professional, Sydney, 4 vCPU / 8 GB / 100 GB, **A$39.20 a month ex GST**, A$43.12 incl GST, billed hourly, checked
1 Oct). Agent desktops are RAM: on that VM, after the OS (about 0.5 GB), the hub (about 0.7 GB in production, less than the dev
server measured above) and Hindsight with Postgres (about 1.5 GB, only once it moves to the VM), roughly **5 GB is free: 8 to 10
desktops at rest, but CPU is the limit** at 4 vCPUs, so about **4 to 6 desktops actively browsing at once**, or dozens of
headless computers. Two concurrent agents (the requirement) cost **no extra VM**: they fit in the proposed one.

| Plan | Fits | Monthly, ex GST |
|---|---|---|
| Hub + Hindsight + 2 to 6 desktop computers on the proposed 8 GB VM | the requirement, with headroom | A$39.20 (already proposed; **A$0 extra**) |
| A separate 4 GB "computers" VM (Advanced, 2 vCPU / 4 GB / 60 GB) if agents grow past about 6 | 4 to 6 more desktops; isolates the browsers from the hub | A$19.60 each |
| Sleep a computer | frees RAM and CPU; **does not reduce the VM bill** | A$0 saved |

Prices are the lead's 1 Oct check; confirm at purchase. Backups are extra (A$0.05 per GB per backup).

## 9. What the owner has to do (nothing has been done for you)

1. **The real desktop on this PC (free, about 164 MiB, one command, asks for your password):**
   ```
   wsl -d kali-linux -- sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation
   ```
   Then say so, and re-run `bun scripts/computers/journey.ts` (it adds the Chromium page steps, the title checks, and the snapshot).
   I did not run it: a password is required and this code never asks for one.
2. **A real VM, only if you want computers that do not live on this PC:** approve the VM already proposed (BinaryLane Sydney,
   A$39.20 a month ex GST, or the A$19.60 4 GB plan for computers alone); create it and an SSH key yourself; accept its host key
   once (`ssh <alias> true`); run the same `apt-get` line as root there; decide on **Node 22** (a NodeSource repository or Bun:
   Debian and Ubuntu's own Node is older); tell me the SSH alias. Steps: `deploy/computers/README.md` section 2.
3. **Mehroz's side of "view and take over" on the real hub** needs the Tailscale sign-in that is currently broken on this PC
   (board baseline). The rule is proven in tests with simulated Tailscale Serve identity; it is not proven with his real login.

## 10. The API the Computers page uses (for Agent C)

All under `/__computers`, JSON, same auth as `/__devices` (signed-in founder; writes need the page token). Lifecycle, takeover,
return, input and the viewer additionally need a person (confirmed browser session).

| Call | Returns |
|---|---|
| `GET /` | `{ computers: ComputerView[], targets }` |
| `GET /targets` | `{ targets: [{id,label,kind,owner,online,shared}] }`: what this founder and their agents may target (own PC plus every shared computer) |
| `GET /host` | `{ adapters: [{kind, check:{ok, host, present, missing, installCommand, notes}}] }` |
| `GET /events` | recent lifecycle and lease log (no secrets) |
| `POST /` `{name, adapter?, resolution?, label?}` | provisions; `{computer}` |
| `POST /:name/action` `{action: start|stop|suspend|resume|recover|destroy, force?}` | `{computer}`. **`recover` (the UI's "Restart display") on a healthy computer whose display or VNC is down restarts only those layers** (what is running, the companion and its browser included, is left alone, and no crash recovery is counted); on a computer whose process died it is the full restart, whoever holds it; otherwise a full restart. On a healthy computer a job or a person holds it is refused (409, naming who) unless `force`. Round 7 |
| `POST /:name/jobs` `{agent?, title?, steps:[{executor,args?,timeoutMs?}], wake?}` | `{jobId}` (409 + who holds it when busy) |
| `GET /jobs/:id` / `POST /jobs/:id/cancel` | job, steps, `paused` / cancel |
| `POST /:name/takeover` | `{state:"held"|"pending", view}` |
| `POST /:name/lease/renew` | viewer heartbeat, `{ok, view}` (send every 20 to 30 s while the viewer is open) |
| `POST /:name/return` | "Return to agent": `{resumed: jobId|null, view}` |
| `POST /:name/input` `{executor, args}` | only while this person holds the lease |
| `GET /:name/screenshot` | `image/jpeg`, or 404 "no desktop" |
| `WS /:name/vnc` | RFB for noVNC; needs the session cookie; same-origin only |

`ComputerView`: `name`, `id`, `label`, `kind:"cloud-computer"`, `owner:"shared"`, `adapter`, `state`, `desired`, `desktop`,
`capabilities[]`, `assigned:{agent,jobId,by,title}|null`, `controller:{kind:"agent"|"person"|null, who, jobId, expiresAt, epoch}`,
`takeoverPending:{by,requestedAt}|null`, `paused:{jobId,agent}|null`, `resource:{rssMb,cpuPct,procs,sampledAt}|null`,
`lastSeen`, `failure:{at,reason}|null`, `recoveries`, `createdBy`, `createdAt`, `viewer:{snapshot,vnc}`.
UI wording hooks: `state` drives the chip (busy with `controller.kind` says "agent X" or "Usman"); `takeoverPending` is "pausing
at the next safe step"; `paused` with a person controller is the "Return to agent" button; `viewer.vnc` chooses noVNC over
snapshot polling.

## 11. Files touched outside `scripts/computers`, `companion/linux`, `deploy/computers` (for Agent B and the lead)

Every hunk is additive or a type widening; the existing suites (devices, identity, companion, jarvis-command) pass unchanged.

| File | Hunk |
|---|---|
| `scripts/devices/types.ts` | `TargetKind` adds `"cloud-computer"`; `SHARED_OWNER`, `DeviceOwner`, `isSharedComputer`; `TargetDevice.owner` and `ResolveResult.owner` widen to `DeviceOwner` |
| `scripts/devices/route.ts` | `sharedComputerFor` (a computer by name, never "here", never a bare "computer"), the `computer:<id>` exact form (shared computers only), and the "isn't yours" clause skips shared |
| `scripts/devices/dispatch.ts` | optional `Dispatcher.guard`, optional `CommandInput.lease`, `CommandRecord.by`, `WireCommand.personId` widens, `cancel` lets either founder cancel a shared computer's command; `approvalValid` takes `DeviceOwner` |
| `scripts/devices/store.ts` | `"computer"` code purpose, `createComputerCode`, `registerComputer`, `ComputerMeta`, `redeemCode` returns the meta, the read filter admits `shared` |
| `scripts/devices/service.ts` | the computer branch in `/companion/pair` (before the tailnet check), either founder may revoke a shared computer, returned object adds `identify` and `browserWriteBlocked` |
| `scripts/devices/identity.ts` | `identifyCompanion`: a computer's token needs only a loopback socket |
| `scripts/devices/permissions.ts` | the `device` resource allows `shared` |
| `scripts/identity/principal.ts` | a computer's token is refused as an identity everywhere |
| `scripts/identity/routes.ts`, `docs/IDENTITY-ROUTES.md`, `scripts/identity/route-matrix.test.ts` | `/__computers` classified shared; excluded from the stand-in matrix (its real handler needs a person) |
| `scripts/jarvis-command/service.ts` | a resolved shared computer is refused with the reason (2 lines) |
| `companion/worker.ts`, `companion/executors.ts` | type only: `owner` accepts `shared` |
| `scripts/operator-plugin.ts` | one line: `mountComputers(...)` after the devices mount |

## 12. Known gaps (stated, not hidden)

* The desktop (Chromium, Xvfb, x11vnc) is unmeasured and unproven until the packages are installed; the snapshot, the browser
  executors and the VNC path are proven only against in-process fakes and a DevTools-shaped test server.
* Mehroz's real login is not exercised (section 9, item 3).
* `vps-ssh` and the systemd unit are sketches (fake runner only).
* No hub-side planner for open-ended goals on a computer (section 5). No queue of jobs for a busy computer (refused with who holds it).
* Detecting a dead computer takes up to one monitor interval (10 s); a probe per second while a lease is held would make it near-instant.
* The bridge relays RFC1918 traffic by design (WSL's NAT), unlike OpenMausBot's public-HTTPS/`.ts.net`-only rule; it is one
  interface, seven routes, headers stripped.

## 13. Round 2 additions

* **Jarvis to computers** (`scripts/computers/jarvis.ts`, hooked as `Delegates.computers` in `scripts/jarvis-command/service.ts` before page-context resolution): "use the research computer to ...", "show me the research bot", "continue that job on its cloud computer". The verified principal is the requester; both founders may; a named computer that does not exist is refused by name; never a fallback to another machine; money or secret words never reach it. "Continue" attaches to a running or paused job and reports an ended or unknown one without re-running it.
* **Hub-side goal loop** (`scripts/computers/goal-loop.ts`, step `{executor:"goal", args:{goal}}`): observe (`observe.page {elements:true}`), Jev decides on the hub, act (`input.*`), verify (the page changed), each a job step. It reuses the PC screen loop's decision code (`goalSlots`, `buildControlRequest`, `parseControlAnswers`, `decisionConfidence`, `confidencePolicy`) over a page-as-snapshot. Bounded (12 moves, 3 stalls), never a final button or a password field, stops when Jev is unavailable, cancel and takeover honoured at move boundaries, unknown on a drop, no replay. The key stays on the hub.
* **A browser without sudo**: `POST /__computers/host/install-browser` (only when asked) installs Playwright's chromium-headless-shell into `~/mu-computers/browser`; the companion finds it through `MU_CHROMIUM`. A headless computer with a browser can navigate, observe, take snapshots and run the goal loop (`view.browser`, `view.viewer.snapshot`). Measured: about 605 MB per computer with a page loaded.
* **Working files persist**: a computer's working folder survives computer stop and start, suspend and resume, crash recovery and a hub restart (proven in WSL and in tests); only `destroy` removes it. The bridge is restored at hub boot for stored computers.
* **Viewer**: noVNC 1.7.0 (pinned), `/__computers/<name>/viewer` (iframe), contract in `scripts/computers/novnc.ts` and `COMPUTERS-REFERENCES.md`; control stays in the lease.
* **Docker adapter**, the Kasm comparison and the E2B assessment: `COMPUTERS-REFERENCES.md`.
* Resource note: a computer with a real headless Chromium measured 603 to 605 MB (10 processes), above the planning figure in section 8.
* The bridge listens on the one WSL-facing interface only (it refuses `0.0.0.0` and `::`), forwards only the seven `/__devices/companion/*` routes (404 for everything else), strips Tailscale, forwarding, cookie and page-token headers, and presents the hub's own loopback Host, which the lead's rule requires. Merged with the identical change from integration.

## 14. Round 3 additions (real desktops, Track A)

* The desktop packages are installed on this PC (xvfb 21.1.24, chromium 150, x11vnc 0.9.17, xdotool, fonts-liberation, from the official Kali mirror) and two computers ran for real: own Xvfb display, own Chromium profile and DevTools port, own x11vnc, own companion identity and working folder, each showing its own page in a real noVNC frame (`COMPUTERS-EVIDENCE.md`, "Round 3: real desktops"). Section 8's planning figures are now **measured**: about 0.45 to 0.55 GB and 0.1 to 0.3 of a core per desktop computer (Chromium 350 to 450 MB of it, PSS), 0.05 GB headless; navigate round trip p50 about 0.96 s, screenshot about 0.4 s, no slowdown from one to two active. Working limit on this PC: **2 desktop computers run cleanly; 4 degrade** (round 3b: navigate p50 1.7 s, Windows free memory under 1 GB, CPU peak 97 percent, with the owner's apps open); 6 was not run. The earlier "6" was an extrapolation and is withdrawn.
* Section 9 item 1 is done. WSLg specifics now handled in code: the read-only `/tmp/.X11-unix` (Xvfb has only the abstract socket; the script and companion accept either), `WAYLAND_DISPLAY` stripped from every computer process (x11vnc and a browser on the owner's desktop), a display already held by another X server refused instead of shared, a hub's own display range (`MU_COMPUTERS_DISPLAY_BASE`) and folder (`MU_COMPUTERS_HOME` through `WSLENV`).
* A computer keeps at most 4 open pages (a page per navigation, never closed, leaked 0.8 GB in three minutes); its resource figure is PSS, not RSS.
* A computer whose provisioning failed can be destroyed and started through the API (the handle is rebuilt from the record).
* **Leaving the viewer returns the computer**: when a person's last viewer socket closes they have 5 s to reconnect, then their control is released like "Return to agent" (a paused job resumes after a fresh read). A page still sending lease heartbeats keeps it; expiry stays as the fallback. Rule and reasons: `service.ts`, `viewerClosed`.
* Known limit, section 7 amended: on WSL2 a loopback port inside the distro is also reachable from Windows loopback (WSL's localhost forwarding), so the authenticated hub route is not the only way to a computer's x11vnc or DevTools from a process on the owner's own Windows account. A VM has no such relay; the owner option is `localhostForwarding=false` in `.wslconfig`.

* **Round 3b:** a host-level allocator (`alloc.json` under flock) hands out display, VNC port, DevTools port (and a stable per-hub bridge port) uniquely across every hub on a host, and reclaims only provably-dead entries; every computer process carries a private `MU_COMPUTER_KEY`, and stop/destroy kill only processes that carry it (no `pkill` by name; a recycled pid or another hub's Xvfb is never touched). Details and tests: `COMPUTERS-EVIDENCE.md`, "Round 3b".
