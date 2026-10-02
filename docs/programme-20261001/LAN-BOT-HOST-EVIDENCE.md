# LAN bot host: real-host evidence (2 Oct 2026)

All evidence below is labelled **real LAN host (Ryzen-PC WSL)** unless it says otherwise. The hub was a real hub from `D:/AgenticOS-r5-lan-bots` (branch `r5/lan-bots-20261001`) on this PC,
port 8140, `MU_HUB_ROLE=cloud`, a temporary `MU_DATA_DIR`, with `MU_COMPUTERS_SSH_ALIAS=ryzen-bots MU_COMPUTERS_SSH_WSL_DISTRO=kali-linux MU_COMPUTERS_SSH_RUN_AS_PREFIX=mu-
MU_COMPUTERS_SSH_COMPUTERS_HOME=/var/lib/mu-computers`. The live hub (8081) and its computers were not touched. No key, token, cookie value or environment value appears here.
The driver is `scripts/computers/journey-lan.ts` (phases `up`, `after`, `tunnelloss`, `capacity`, `teardown`); raw JSON evidence and the screenshots were produced on this PC under `D:/prog-r5-lan/out`
(the four pictures are copied to `docs/programme-20261001/lan-evidence/`).

Host: Ryzen-PC, Windows 11 26200, 6 CPUs, 16 GB (WSL VM 12 GB), GTX 1070 Ti, WSL 3.0.1 kali-linux, mirrored networking, kernel 6.18 WSL2. Installed on Kali (official repos only):
`xvfb chromium x11vnc xdotool nodejs fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji`. Nothing on Ryzen's Windows side was changed.

## Result per item

| # | Item (lead's list) | Result |
|---|---|---|
| 1 | Own hub, free port, temp data dir, ssh alias envs | PASS |
| 2 | Tunnel up via marker round trip; 127.0.0.1 only on Ryzen; LAN connects fail | PASS (bindings re-measured with a job running in section 12; the LAN timeouts are firewall-explained, not proof) |
| 3 | Two separate desktops: displays, profiles, home/files, cookie, file | PASS |
| 4 | Viewer (noVNC through the hub, `ssh -W`) for each desktop | PASS |
| 5 | Control: lease holds input, takeover pauses at a step boundary, holder-only input, return, Stop (force) | PASS (one defect found and fixed, below) |
| 6 | Hub restart recovery; kill the tunnel ssh alone | PASS |
| 7 | File persistence across Stop/Start and hub restart; cookie persistence | PASS |
| 8 | Capacity with 2, then 3 and 4 as bounded steps | measured: 2 comfortable, 3 and 4 still had headroom (limit not reached) |
| 9 | Fix real-host defects with tests | five fixed (below) |
| Acceptance (owner's ten) | see the second table | 10 PASS (the model-driven research run finished as an honest PARTIAL report, section 9) |

### The owner's ten acceptance points

| # | Point | Result |
|---|---|---|
| 1 | Correct screen each; separate profiles and working files | PASS |
| 2 | A real bounded task creates an observable result | PASS: Builder ran the goal loop; Research ran the model-driven `research` goal (section 9): saved `report-20261001T155806.md` with citations and delivered it to the Jarvis thread; the outcome was **partial** (3 cited facts from 2 sources; it hit the 40 model-call limit after several pages did not finish loading) and the report says so |
| 3 | Concurrent, no cross-talk of tab, files or input | PASS |
| 4 | Viewer through the authenticated hub | PASS |
| 5 | Only the control holder's input is accepted | PASS |
| 6 | Takeover pauses the agent, return resumes safely (same job, page re-read first) | PASS |
| 7 | Stop prevents later actions, no replay | PASS |
| 8 | Hub restart and tunnel loss: honest state, safe recovery | PASS |
| 9 | Working files survive restart | PASS |
| 10 | 18091, 60xx and 94xx refuse connections from this PC's LAN address | PASS (all time out; nothing listens on the LAN address) |

## 1-2. Hub, host check, tunnel, ports (real LAN host (Ryzen-PC WSL))

```
host check: [{"kind":"vps-ssh","ok":true,"host":"Ryzen-PC","present":["Xvfb","chromium","x11vnc","xdotool","node","fonts"],"missing":[], ...}]
provision two computers on Ryzen: wallMs 12034 (includes building and pushing the bundle), both status 200, adapter "vps-ssh", desktop true, browser true
```

On Ryzen (Windows), `netstat -ano | Select-String ':18091'` while the tunnel was up (listener is sshd's `-R` forward; the ESTABLISHED lines are the companions inside WSL connecting over loopback):

```
TCP    127.0.0.1:18091        0.0.0.0:0              LISTENING       1492
TCP    127.0.0.1:18091        127.0.0.1:53573        ESTABLISHED     1492
TCP    127.0.0.1:18091        127.0.0.1:53585        ESTABLISHED     1492
```

Inside Ryzen's WSL, listening TCP sockets while two computers ran: `127.0.0.1:6001 127.0.0.1:6002` (VNC, loopback only) plus WSL's own DNS stub and `[::1]:5900`, which I first mislabelled as unrelated: it was `x11vnc`'s IPv6 listener (section 12(c)); the 94xx DevTools ports were not yet listening here because Chromium had not started (section 12(a) re-measures with a job running); X11 only as unix/abstract sockets (`@/tmp/.X11-unix/X101`, `X102`).

From this PC (192.168.1.130), explicit TCP connects to 192.168.1.120 (1.5 s timeout):

```
hub/bridge   : 192.168.1.120:18091 -> timeout (no answer)
VNC          : 192.168.1.120:6001, :6002 -> timeout (no answer)
browser-debug: 192.168.1.120:9401, :9402 -> timeout (no answer)
```

These timeouts do **not** prove the bindings: Ryzen's firewall allows only TCP 22 from this PC, so every connect would time out whatever the sockets were (section 12(b)). The bindings are shown by `ss -ltnp` and `netstat` (section 12(a)). On the hub PC the bridge is a loopback
listener (`127.0.0.1:<random>`), never `0.0.0.0`.

## 3. Isolation (real LAN host (Ryzen-PC WSL))

```
research: display :101, vnc 6001, devtools 9401, dir /var/lib/mu-computers/research, user mu-research uid 1000, mode 700
builder : display :102, vnc 6002, devtools 9402, dir /var/lib/mu-computers/builder,  user mu-builder  uid 1001, mode 700
other computer's folder read as research's user: ls: cannot access '/var/lib/mu-computers/builder/work': Permission denied
HOME per computer: /var/lib/mu-computers/<name>/home ; DISPLAY :101 / :102 ; MU_COMPUTER_DIR own folder only
```

- **Sandbox on, not root**: `chromium main processes` run as `mu-research` / `mu-builder`; `--no-sandbox flags anywhere: 0`; renderers show `NoNewPrivs: 1  Seccomp: 2`.
- **Cookie**: set `mu_lan_test` for `example.com` in research's browser through its own DevTools port. Research's browser lists it; builder's browser lists none (`"cookies":[]`).
- **Files**: `research: only-in-research.txt`; `builder: only-in-builder.txt`. Builder trying to read research's file: `failed file.read: only-in-research.txt isn't in this computer's working folder.`
- **No cross-talk while running together** (the concurrent tasks below): research's tabs are `Canberra - Wikipedia`, `Example Domain`; builder's are `Example Domains (iana.org/help/example-domains)`, `Example Domain (example.org)`; work folders `report-canberra.md, only-in-research.txt` vs `built.txt, only-in-builder.txt`.

Wording: this is separate browser profiles, Linux users and 700 folders on ONE shared WSL VM. Direct file access is blocked; the loopback services (browser debugging, VNC, X, the bridge) are shared, so the computers on a host are one trust domain. It is not machine isolation (sections 12 and `LAN-BOT-HOST.md`).

## 2/3. Bounded tasks, concurrent (real LAN host (Ryzen-PC WSL))

Wall time 6.4 s for both at once:

```
Research (typed steps; agent "research-agent"):
  ok browser.navigate: Opened en.wikipedia.org: the page title reads "Canberra - Wikipedia".
  ok page.text: Read 6000 of [number] characters of "Canberra - Wikipedia" at en.wikipedia.org.
  ok file.write: Wrote report-canberra.md (102 bytes) and read it back.
Builder (goal loop on the hub, Jev decides, the computer acts; agent "builder-agent"):
  ok browser.navigate: Opened example.com ...
  note goal: Jev: click link "Learn more" (70% sure; task complete 2%).
  ok input.click: move click link "Learn more": Clicked at 640,403 (sent; not checked).
  ok goal: check: after "click link "Learn more"" the page reads "Example Domains" at www.iana.org
  ok goal: goal done after 1 move: Done on www.iana.org after 1 move: Example Domains.
  ok file.write: Wrote built.txt ...
```

The first run of the model-driven `research` executor failed honestly because SearXNG on this PC was broken (its venv was orphaned by a Python upgrade). The lead rebuilt it; section 9 is the proper run.

## 4. Viewer (real LAN host (Ryzen-PC WSL))

noVNC loaded from the hub (`/__computers/<name>/viewer`), WebSocket through the hub, `ssh -W 127.0.0.1:<vncPort> ryzen-bots` to Ryzen's x11vnc; canvas 1280x800 for each.
Pictures: `docs/programme-20261001/lan-evidence/lan-vnc-research.png` (Wikipedia, text readable), `lan-vnc-builder.png` (IANA page, text readable), `lan-vnc-after-restart.png` (after the hub restart).
Hub-route snapshot: `lan-snap-research-full.jpg` (106,363 bytes, complete JPEG, text readable).

## 5-7. Control, takeover, Stop (real LAN host (Ryzen-PC WSL))

```
input without the lease: 409 "Take control of research first."
takeover requested mid-step: 200 "pending" (agent is NOT interrupted; it finishes its 8 s wait)
timeline: agent:researcher running -> takeoverPending -> person:usman holds it, automation paused at the step boundary
person acted while holding the lease: file.write human.txt -> 200
files while the person holds it: ["human.txt","only-in-research.txt","report-canberra.md"]  (the agent's later steps had NOT run)
returned to agent: resumedSameJob true; the job re-read the page first ("observe.page: refreshed state after the handover") then ran its steps 2 and 3
input after return: 409 (holder-only)
STOP (force) on a running 60 s job: 200 after 0.9 s, job "cancelled", never.txt never written, input to the stopped computer 409, 0 processes of it left in WSL
builder started again: online in 1.3 s
```

Defect found and fixed here: a forced Stop sometimes read `failed` because a monitor probe landed in the second the ssh call took to stop the processes (the companion was dead while the intent was still
"running"). The hub now records the intent before stopping and clears the failure afterwards (regression test `lan-service.test.ts`, "a deliberate Stop").

## 6. Hub restart and tunnel loss (real LAN host (Ryzen-PC WSL))

**Hub killed and restarted (14 s outage)**: the tunnel ssh disappeared with the hub (0 ssh processes after 6 s: the remote `cat` ended when its stdin closed); inside WSL the companions sat in `SYN_SENT` to 127.0.0.1:18091.
After the new hub came up the tunnel came back, both computers were `online`, same device ids, `recoveries 0`, process counts identical before and after (`companion 2, xvfb 2, x11vnc 2, browser 1`), file and cookie intact, viewer working.

**Hub down for 2 minutes**: WSL idled out (no keep-alive once the tunnel was gone), killing every computer process. The hub's own report on restart was honest and recovered by itself:

```
+7.6s  research:failed(the companion process is not running) builder:failed(the companion process is not running)
+15.2s research:starting(...)                                builder:starting(...)
+16.8s research:online                                       builder:online      (recoveries 1 each, same devices)
file read after: human.txt present; browser answers; cookie mu_lan_test still present (profile on disk)
```

This is why `LAN-BOT-HOST.md` asks for the owner-side keep-alive on Ryzen (a logon task running `wsl.exe -d kali-linux -u root --exec sleep infinity`); not installed (it changes Ryzen's Windows side).

**Tunnel ssh killed alone** (`taskkill` on the pid in the pid file): back within about 1 s each time, a new ssh each time; killed four times in a row (backoff grows 1, 2, 5, 10 s): computers stayed `online`
(outage shorter than the presence window) and the host check said `the SSH tunnel to the hub is backoff ...`, then `starting`, then cleared. Killed six times (backoff reaching 30 s): during the 30 s waits the computers read
`starting` then `offline` (honest: nothing heard from them), then `online` again with `failure: null`, process counts unchanged, Research still held `report-canberra.md` and took a job.

## 7. Persistence (real LAN host (Ryzen-PC WSL))

- Builder: force Stop, Start (1.3 s): `file.read only-in-builder.txt` -> `Read only-in-builder.txt (13 bytes)`.
- Research: cookie `mu_lan_test` flushed (35 s wait), force Stop, Start, navigate: cookie still listed. After a hub restart and after the 2 minute outage and WSL idle-out: still listed; `human.txt`, `report-canberra.md` still readable.

## 8. Capacity (real LAN host (Ryzen-PC WSL))

Workload: each computer loops navigate (example.com, wikipedia.org, example.org, a Wikipedia article) + a hub snapshot, about 45 s per level, no failures at any level. Memory is PSS read from `/proc` inside WSL;
Windows figures come from read-only PowerShell counters over ssh. Per-process CPU of Chromium is not trusted (its process tree churns); the VM-wide figures are.

| Level | WSL VM used (mean / peak, of 11,965 MB) | WSL VM CPU (of 6 threads) | Ryzen Windows CPU (mean / peak) | Windows free RAM (min) | `vmmem` | nav p50 / p95 (ms) |
|---|---|---|---|---|---|---|
| 2 idle (page loaded) | 866 / 869 MB | 4.9% | 16.7% / 31% | 9,593 MB | 1,963 MB | n/a |
| 2 active | 1,283 / 1,385 MB | 17.5% | 25.5% / 38% | 9,018 MB | 2,417 MB | 1,582 / 2,970 and 5,037 |
| 3 active | 1,704 / 1,798 MB | 24.2% | 33.4% / 55% | 8,438 MB | 3,003 MB | 1,585-1,612 / 2,121-5,385 |
| 4 active | 2,093 / 2,219 MB | 29.1% | 40.8% / 69% | 8,007 MB | 3,085 MB | 1,571-1,592 / 2,113-7,401 |

Per computer (mean PSS): companion about 50-65 MB, Xvfb about 15 MB, x11vnc about 8-11 MB, Chromium about 300-510 MB (the first page loaded is the largest). The GTX 1070 Ti is irrelevant: WSL exposes no `/dev/dri`,
Chromium renders in software, and the Windows GPU engine counters read 0 at every level.

**Verdict: comfortable 2, headroom 3 and 4, limit not found.** Four desktops used about 2.1 GB of the WSL VM's 12 GB, 41% mean Windows CPU, and kept about 8 GB free, with navigation p50 unchanged (about 1.6 s).
Occasional 5-7 s navigations appeared on one computer at 3 and 4 (network, not CPU). Per the brief the ramp stopped at 4; a higher number is not measured and should not be quoted.

**Disk (read-only, reported separately):** Windows physical disk on Ryzen: `C: used 52.4 GB, free 412.3 GB of 464.7 GB` before and `free 412.2 GB` after the 4-desktop run; the Kali VHDX file on disk: 3.11 GB before, 3.17 GB after.
Inside WSL `df` shows `/dev/sdd 1007G size, 954G avail`: that is the ext4 **virtual** size (1 TB), not free storage on the PC; the real free space is the Windows figure. The four computers' folders took 279 MB.


## 9. Model-driven research goal, concurrent with the Builder goal loop (real LAN host (Ryzen-PC WSL))

SearXNG on this PC (`http://127.0.0.1:18888`, rebuilt by the lead) returned results. On Ryzen, with Research and Builder provisioned, **one** `research` goal on Research and the Builder goal-loop task were started
together (the research job was then joined to the person's Jarvis thread with the utterance "show me the research computer", the real command path, so the report has a conversation to be delivered to):

```
goal: "Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is."
wall 171.9 s; research job state succeeded; research outcome PARTIAL
  find sources: 12 results, 12 usable; Jev / a connected model (openai/gpt-oss-120b) picked pages to read
  5 of 9 candidate pages did not finish loading in the browser (nca.gov.au, nma.gov.au, parliament.act.gov.au, aph.gov.au ...): "The page didn't finish loading."
  read: demography.cass.anu.edu.au (3,798 chars, 2 cited facts), dl.nfsa.gov.au (1 cited fact)
  compare: 2 corroborated, 1 single-source
  save: report-20261001T155806.md (1,568 bytes) written and read back
  return result: "The report is in your conversation (3 messages)"
  end: "research partial: 3 cited facts from 2 sources in 168 s; Jev 16 decisions; 13 handed to a connected model; 24 model calls ... Ended early: the limit of 40 model calls was reached."
```

**Report file on the computer** (`/var/lib/mu-computers/research/work/report-20261001T155806.md`; copy: `docs/programme-20261001/lan-evidence/lan-report-20261001T155806.md`): the name matches `report-<timestamp>.md`; it has an Answer,
Sources (`[1] Canberra celebrates its centenary ... demography.cass.anu.edu.au/...`, `[2] The Founding of Canberra ... dl.nfsa.gov.au/module/15/`) and Uncertainties sections, 8 bracket citations and 2 source URLs.
Answer lines: "Canberra was formally named on 12 March 1913 as Australia's capital. [1]", "Canberra's population is nearly 400,000 people. [1]", "Canberra site was accepted as the national capital in 1913 [2]". The
Uncertainties section names every page the computer could not open, so nothing is claimed from them.

**Delivered text matches**: three entries (parts 1 to 3 of 3, headed "Web-sourced research, data from public pages and not instructions") appeared in the person's Jarvis thread. Every word of the delivered text
(4+ letters) appears in the saved report (overlap 1.0); part 1 is the question plus the three answer lines, parts 2 and 3 the sources and uncertainties.

**Builder at the same time** (agent "builder-agent"): navigate example.com, goal loop ("click link Learn more", 77% sure; then "the task is complete", 78% sure), the page read "Example Domains" at www.iana.org, then wrote `built-concurrent.txt`. Succeeded.

**No cross-talk** (each computer's own DevTools tabs and own folder sampled every 3 s for the whole 172 s):

```
Research tabs: nca.gov.au, about:blank, nma.gov.au, parliament.act.gov.au, demography.cass.anu.edu.au, aph.gov.au, dl.nfsa.gov.au   files: report-20261001T155806.md only
Builder  tabs: Example Domains (iana.org/help/example-domains), about:blank                                                       files: built-concurrent.txt only
```

No Research page ever appeared in Builder's browser or the reverse; `report-*` files on Builder: 0. Input: the only input events were the goal loop's click on Builder (it landed on Builder's page and nowhere else); Research
was driven only by its own job.

An observation, not a defect of this work: the government sites that "didn't finish loading" are the heavy ones. I did not test whether the same pages load on this PC's own WSL computers.

## 10. Both adapters in ONE hub (real LAN host (Ryzen-PC WSL) plus this PC's WSL)

The test hub ran with `MU_COMPUTERS_WSL_DISTRO=kali-linux` and the Ryzen ssh adapter. `GET /__computers/host` listed `wsl-local` (host `DESKTOP-D8QCTMG`) and `vps-ssh` (host `Ryzen-PC`), both ok.

```
provision r5-local-check on wsl-local; Research on vps-ssh (the Ryzen one provisioned earlier) -> both online, desktop true, viewer snapshot+vnc true
host of r5-local-check: hostname DESKTOP-D8QCTMG, computers folder ~/mu-computers (this PC's WSL): alloc.json alloc.lock bin r5-local-check
host of research:       hostname Ryzen-PC, /var/lib/mu-computers: bin builder research
a job on each (navigate + file.write who.txt): both succeeded; who.txt "local computer on this PC" exists ONLY on this PC's WSL, "research computer on Ryzen" ONLY on Ryzen
viewer (noVNC through the hub): r5-local-check canvas 1280x800 (via wsl.exe), research canvas 1280x800 (via ssh -W); snapshots 200 image/jpeg for both
```

Pictures: `lan-evidence/lan-both-local.png`, `lan-both-ryzen.png`.

**Allocations do not collide.** First run: each host's allocator gave display 101 / VNC 6001 (the same numbers on two different hosts is fine; they are per host). Second run, with a **stand-in foreign hub** entry already on this PC's WSL
(hub id `standin-other-hub`, computer `foreign-x`, display 101, a folder with a marker file, created with the same script): this hub's local computer was given **display 102 / VNC 6002**, the foreign entry kept 101; Ryzen's
research kept 101/6001 from its own allocator. After this hub destroyed its computers, this PC's allocator still listed only `standin-other-hub / foreign-x`, and the foreign folder and its marker file were intact. I then removed that
stand-in with the script (`destroy`, hub id `standin-other-hub`).

**The live hub (8081) before and after** (`GET /__computers/`, read only): `{"computers":[]}` both times, identical. The live hub currently owns **no** computers, so "left untouched" is shown by the foreign stand-in
test above rather than by real live computers; cleanup is by `MU_COMPUTER_KEY`, which carries the hub id, so it cannot match another hub's processes.
One shared-host effect to know: the companion bundle (`~/mu-computers/bin/companion.mjs` on this PC's WSL) is one file per host, so provisioning from this branch's hub installed this branch's bundle there; the live hub installs its own at its next provision.
A bridge reservation for this test hub's id (port 8202) also remains in this PC's allocator file (harmless; bridges are reserved per hub).


## 11. Page loading on Ryzen: diagnosis, fix, and the Canberra goal rerun (real LAN host (Ryzen-PC WSL) and this PC's WSL for comparison)

**Timings** from inside each computer's own Chromium over its DevTools port (`pl.js`: `Page.navigate`, then `domContentEventFired`, `loadEventFired`, `responseReceived`, 45 s cap, cache off), the same URLs on both hosts, run at the same time:

| URL | Ryzen DOMContentLoaded / load | HTTP | requests still pending at the end (of total) | this PC DOMContentLoaded / load | HTTP |
|---|---|---|---|---|---|
| nca.gov.au/education/canberras-history/siting-and-naming-canberra | 758 ms / **never** (45 s) | 200 | 3 of 45 | 8,118 / 8,119 ms | **403** (this PC's address is refused by NCA: a different problem, 2 requests) |
| nma.gov.au/defining-moments/resources/founding-of-canberra | 4,329 / **never** | 200 | 8 of 75 | 3,838 / 4,775 ms | 200 |
| parliament.act.gov.au/.../fs/establishing-the-nations-capital | 2,590 / **never** | 200 | 2 of 37 | 1,995 / 2,412 ms | 200 |
| aph.gov.au/25th_Anniversary_Chronology/Creating_the_national_capital | 793 / **never** | 200 | 6 of 105 | 1,258 / 1,866 ms | 200 |
| control: example.com | 84 / 85 ms | 200 | 0 | 98 / 98 ms | 200 |
| control: en.wikipedia.org/wiki/Canberra | 3,721 / 6,123 ms | 200 | 0 | 1,197 / 2,379 ms | 200 |

Final URLs equal the requested ones on both hosts (no redirects). On Ryzen the pending requests at 25 s and at 45 s were, every time, tracker requests: `google-analytics.com/analytics.js` and `/g/collect`, `ad.doubleclick.net`, `stats.g.doubleclick.net`, `facebook.com/tr/`, a reCAPTCHA frame (`pendingAt25s` / `ryzenPendingEnd` in `lan-pageload.json`). The controls are fine, so this is not general slowness (Wikipedia is slower on Ryzen because Ryzen's route to its mirror has 350 ms connect time against 140 ms here).

**What `browser.navigate` waited for (before the fix):** `document.readyState === "complete"` (the `load` event), a non-empty title, and the same `ready|url|title` on two reads 400 ms apart, within 25 s (`pageTimeoutMs`). A page whose `load` never fires failed with "The page didn't finish loading" although its DOM was ready.

**Suspects checked (inside Ryzen's WSL, then Windows read-only):**

| Suspect | Result |
|---|---|
| IPv6 under mirrored networking | There is no IPv6 default route on Ryzen or on this PC; `curl -6` fails at once (0.0 s) to every host on both; `curl -4` works. Not a stall. |
| DNS (`resolv.conf`) | Both use the WSL stub 10.255.255.254. Ryzen's real DNS server is the router, 192.168.1.1 (`Get-DnsClientServerAddress`). The page hosts resolve and answer in 10 to 60 ms from Ryzen. **The tracker hosts do not**: see next row. |
| **DNS sinkhole (the cause)** | From Ryzen's WSL: `www.google-analytics.com` and `stats.g.doubleclick.net` answer **127.0.0.1** through the WSL resolver **and when the query is sent straight to 8.8.8.8 and to 1.1.1.1**; this PC gets real addresses (142.251.x.x, 172.217.x.x) from all three. On Ryzen's Windows side `Resolve-DnsName www.google-analytics.com` answers 127.0.0.1 and `-Server 8.8.8.8` answers 127.0.0.1 too; the hosts file has no entries and no DNS-filter process is running. So the interception is below Windows, on the network path (router or ISP tracker blocking), and affects Windows as much as WSL. `www.facebook.com` and `www.google.com` resolve normally (their requests are the slower ones to finish, not sunk). |
| MTU | 1500 on Ryzen's eth0 (this PC's is 1280). Not a cause. |
| Headless / automation blocking, curl vs a normal UA | curl's default UA gets 403 from nma.gov.au and aph.gov.au; a Chrome UA gets 200 and 302 (identical on both hosts). The computers' Chromium is headed (Xvfb) with a normal Chrome UA and reaches DOMContentLoaded with HTTP 200 on all four. Not a cause on Ryzen. |
| Readiness waits for `load`, which never fires on pages with unsettled requests | **Yes.** Four of four gov pages never fired `load` in 45 s on Ryzen while their DOM was ready in 0.8 to 4.3 s; with the sinkhole answered by 127.0.0.1 the tracker requests never complete (curl to that address is refused at once, but Chromium's requests stay pending: probably its QUIC/UDP attempt or a dropped rather than refused connection; I did not isolate which). |

Why it does not hit this PC: here the tracker hosts resolve to real addresses, so the requests complete or abort quickly and `load` fires.

**Fix at the cause (what "opened" means):** `browser.navigate` (`companion/linux/executors-linux.ts`) now treats a page as opened when `readyState` is `interactive` or `complete`, the title is non-empty, and `ready|url|title` has been unchanged for `interactiveStableMs` (2 s; 25 s cap unchanged). If `load` never fired the result says: "The page was still loading background requests, such as
analytics, that never finished; its text is there." and carries `data.stillLoading: true`. A page with no title, still `loading`, or still changing is not opened (test: `companion/linux/linux.test.ts`). The sinkhole itself is the owner's network and was left alone; nothing was changed on Ryzen's Windows side.

**After the fix, through our `browser.navigate` on Ryzen** (whole job time): nca 5.5 s, nma 4.2 s, parliament.act 3.4 s, aph 4.4 s, each `succeeded` with the title ("The Siting and Naming of Canberra | National Capital Authority", "Founding of Canberra | National Museum of Australia", "Establishing the nation's capital - ACT Legislative Assembly", "Creating the national capital, 1912-1953 - Parliament of Australia") and the "still loading background requests" note. (Before: all four "didn't finish loading" after the 25 s cap.)

**The SAME Canberra goal, rerun on Ryzen** (goal: "Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is."; Builder's goal-loop task running at the same time each time; `research.ts` unchanged):

| Run | Wall time | Executor outcome | Facts / sources | Model calls | Pages that failed to load |
|---|---|---|---|---|---|
| Before the fix (section 9) | 172 s | **partial** ("limit of 40 model calls reached") | 3 facts, 2 sources (demography.cass.anu.edu.au, dl.nfsa.gov.au) | 40 | 5 of 9 |
| After, run 1 | 13.9 s | complete | 5 facts, 1 source (parliament.act.gov.au) | 3 | 0 |
| After, run 2 | 19.1 s | complete | 6 facts, 2 pages, both on nca.gov.au | 5 | 0 |
| After, run 3 (clean evidence run) | 19.7 s | **complete** | **6 cited facts from 2 sources (nca.gov.au, parliament.act.gov.au)** | 4 | 0 |

Run 3's report is `report-20261001T162304.md` (copy: `lan-evidence/lan-report-20261001T162304.md`): Answer lines "Source 1 states Canberra was officially named on 12 March 1913. [1]" and "Source 2 notes the city's name was announced in 1913. [2]", `Not found: population information.`, Sources `[1]` nca.gov.au and `[2]` parliament.act.gov.au with full URLs, an Uncertainties line ("6 of 6 facts rest on a single source"), and six supporting quotes, 10 bracket citations. It was delivered to the Jarvis thread
as 2 messages for that job, and every 4+ letter word of the delivered text is in the saved report (overlap 1.0). Builder ran concurrently and succeeded each time; the tab and folder sampling again showed Research only on its sources and Builder only on the IANA page, no `report-*` on Builder.

**Complete or partial?** The executor now reports **complete** (about 14 to 20 s instead of 172 s, 3 to 5 model calls instead of 40). Against the goal's wording it is not a full answer: the two sources agree on the naming (1913) but **no run found a population figure** (the report says "Not found: population information"), and in run 1 only one source was read. The executor's own sufficiency rule decides "complete"; I did not change it (not mine to edit).

## 12. Re-verification after the review fixes (real LAN host (Ryzen-PC WSL))

Corrections to earlier sections of this file, each re-measured on the host with the hardened script (`verify` phase; two computers on Ryzen, a job running):

- **(a) Browser-debugging ports checked while Chromium runs.** `ss -ltnp` inside Ryzen's WSL during a running job: `LISTEN 127.0.0.1:9401 users:(("chromium",pid=943))`, `LISTEN 127.0.0.1:6001 users:(("x11vnc",pid=485))`, `LISTEN 127.0.0.1:6002 users:(("x11vnc",pid=810))`. 94xx is bound to 127.0.0.1 only (the earlier 94xx check in section 1-2 was made before Chromium had started, so it proved nothing about 94xx; this replaces it). Windows `netstat -ano` on Ryzen at the same time lists only `127.0.0.1:18091` (the tunnel, `LISTENING` and `ESTABLISHED`): mirrored networking does not show WSL's loopback listeners in Windows' table, so the WSL `ss` is the authority for 60xx and 94xx.
- **(b) The LAN connects prove nothing about binding.** From this PC, TCP connects to 192.168.1.120 on 18091, 6001, 6002, 9401 and 9402 all time out, but Ryzen's firewall allows only TCP 22 from 192.168.1.130, so every one would time out whatever the bindings were. The firewall evidence (read-only): `MU hub SSH (192.168.1.130 only) | profile Any | proto TCP port 22 | remote 192.168.1.130`, an `sshd` Public-profile rule (TCP and UDP, any port, any remote; the Windows OpenSSH installer's own rule, on the Public profile only), and `default inbound action per profile: Domain=NotConfigured Private=NotConfigured Public=NotConfigured`. Treat the `ss`/`netstat` lines in (a) as the proof of binding and the firewall as a second layer; the `sshd` Public rule is worth the owner's review.
- **(c) The IPv6 listeners.** The raw socket line earlier contained `[::1]:5900 [::1]:6001 [::1]:6002`; I had dropped it. `[::1]:5900` belonged to `x11vnc` (the first one started binds it; later ones find it taken), not to anything else: `ss -ltnp` showed `[::1]:5900 users:(("x11vnc",pid=...))`. `-no6` removed 6001/6002 on IPv6 but not 5900 and `-noipv6` alone did not either (isolated test with no other x11vnc running: `-localhost`, `-no6`, `-noipv6`, `-noipv6 -no6` all bound `[::1]:5900`; adding `-rfbportv6 0` or `-rfbportv6 -1` did not). The script now runs `x11vnc -norc ... -noipv6 -rfbportv6 -1`; after it, `ss -ltnp` shows only `127.0.0.1:6001` and `127.0.0.1:6002` for x11vnc and `[::1]:600x listeners now: 0`, with no `[::1]:5900`.
- **(d) The sandbox, measured rather than inferred.** `chrome://sandbox` in Research's own Chromium: "Layer 1 Sandbox: Namespace; PID namespaces Yes; Network namespaces Yes; Seccomp-BPF sandbox Yes; Seccomp-BPF sandbox supports TSYNC Yes; Ptrace Protection with Yama LSM (Broker) Yes ... You are adequately sandboxed." Renderers (user `mu-research`): `NoNewPrivs: 1  Seccomp: 2`, own user namespace `user:[4026532375]` against the init namespace `user:[4026531837]`, own PID namespace (`pid:[4026532377]` against init `pid:[4026532224]`); `lsns -t user` lists a zygote per computer, each owned by its own user.
- **(e) Stop, three times in a row**, each on a running 60 s job: status 200, job `cancelled`, computer `offline`, and per run `procs=0 xvfb=0 vnc=0 chromium=0 never=no` (no process of that computer's user, no Xvfb, no x11vnc, no Chromium, and the step after the wait never wrote its file), then Start brought it back online. (Run three times in each of two verification passes with the same result.)
- **(f)** The stale "research executor not run" rows are corrected in `LAN-BOT-HOST.md` and above (section 9 and 11).
- **Trust domain, measured** (supports the corrected wording): as `mu-builder`, `curl http://127.0.0.1:9401/json/version` -> 200, a connection to 127.0.0.1:6001 returned an RFB banner (`RFB 003.008`), and `DISPLAY=:101 xdotool getdisplaygeometry` -> `1280 800`, while `ls /var/lib/mu-computers/research` -> `Permission denied`. Files are separated; loopback services are shared.
- **Review fixes covered by tests**: root never writes into a computer's folder (pid files, owner key and hub id are in `/var/lib/mu-computers/.ctl/<name>`; logs opened after the privilege drop; config validated, with a real shell test that a display such as `1; touch /tmp/pwned` is refused with exit 2); host-wide user names (home must be exactly the computer's), prefix needs a trailing dash, fail-closed ownership, `destroy` reports an undeletable user, `shot` as the computer's user, pairing code through the environment, the owner's Stop wins over a monitor probe that is in flight and over a recovery that is restarting the processes (`lan-service.test.ts`).

## Defects found on the real host and fixed (all with regression tests)

1. **Chromium would not start as root.** `wsl.exe -u root` meant every browser failed ("Chromium didn't start"). Not fixed by turning the sandbox off: each computer now runs as its own Linux user (`setpriv`), sandbox on, folder 700
   (`MU_COMPUTERS_SSH_RUN_AS_PREFIX`); the host check warns when the script runs as root without it.
2. **Page text drew as boxes** on a bare Kali (no sans-serif font, and example.com answered in its first language). Fonts are now a checked prerequisite (reported with the install command), and computers run with an English locale.
3. **Snapshots were cut at 64 KiB of base64** through ssh (a half-drawn screen with a dotted lower half). The companion's `shot` now waits for its write to finish before exiting, and the adapter refuses a frame that does not end in a complete JPEG/PNG. Verified on the host afterwards: 106,363 bytes, complete.
4. **A forced Stop could read `failed`** (race with the monitor), described above.
5. **A destroyed computer left files behind** (a browser helper recreated the profile after the folder was removed, owned by the deleted user): `destroy` now kills the computer's user's remaining processes before removing the folder.
6. **Pages with unsettled tracker requests never counted as opened** (the Ryzen network sinkholes tracker DNS to 127.0.0.1): readiness no longer waits for the `load` event (section 11).
7. **Review hardening** (root writing into a computer's folder, host-wide user names, owner Stop races, `x11vnc` IPv6 on 5900): section 12 and the tests listed there.
Also: `Git Bash` rewrote `/var/lib/...` in an environment value (documented), and the sampler's directory is now configurable (`MU_SAMPLER_BASE`).

Not defects: `dd` stdin EOF, cat-marker latency (the tunnel was up about 1 s after start) and PATH under `--exec` all worked without changes.

## Tests (code)

`bun test scripts/computers scripts/devices scripts/identity`: 0 fail; `bun run typecheck` and `bun run typecheck:scripts`: exit 0; done gate clean.

## What remains on Ryzen after this run

Only the installed packages (listed above) and apt's package lists. Removed (mine): all computers and their `mu-*` users, `/var/lib/mu-computers`, `/root/mu-computers` (allocator and bundle), Chromium temp folders in `/tmp`,
X lock files. Verified afterwards inside WSL: 0 `mu-` users, 0 Xvfb/x11vnc/companion/Chromium processes, no listener on 18091, 60xx or 94xx; on this PC 0 `ssh.exe` processes and nothing listening on 8140.
The owner-side keep-alive is **not** installed. Nothing on Ryzen's Windows side was changed (read-only `netstat`, `Get-Counter`, `Get-PSDrive`, `wsl -l --running`, a file listing for the VHDX size).

## Still unproven

- A COMPLETE research report on Ryzen: the one run was partial (slow page loads and the 40-call limit); whether the same pages load on this PC's WSL was not compared.
- Behaviour above 4 desktops, or with heavier pages (video, large web apps).
- The owner-side keep-alive on Ryzen (documented, not installed).
- A GPU-backed browser (not available in WSL here).
