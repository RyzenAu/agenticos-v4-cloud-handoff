# Shared cloud computers: references (round 2)

Programme 1 Oct 2026, Agent F. Earlier reference work: `OPENMAUSBOT-ADOPTION.md`. Rows for the programme table are appended to `REFERENCE-ADOPTION.md`.

## 1. Kasm image vs our own Linux desktop

Reference: <https://github.com/kasmtech/workspaces-images>. Licence of the repository source: **MIT** (Kasm Technologies Inc, 2022; it covers only the
repository's own files, not what the Dockerfiles pull in: browsers, KasmVNC, the base OS). Compared image: **`kasmweb/chrome:1.19.0@sha256:25389cc8eafa94981f7177bf2195f930bc1f761bedfe566b40f238154f33f965`**
(Docker Hub: 1,410,948,831 bytes compressed, updated 2026-06-11; a rolling daily tag for the same line moved on 30 Sep, so pin the digest, never a tag).

**Not run.** Docker Desktop is not installed on this PC and is not to be. Everything about Kasm below is from its README and Docker Hub, not from running it.

| Requirement | Ours (Xvfb + Chromium + x11vnc + our companion, `computer-ctl.sh`) | Kasm standalone image |
|---|---|---|
| Separate browser session | Its own `--user-data-dir` per computer; proven (two real headless Chromiums, different pages, same hub) | One container per session, own profile; by design |
| Lightweight desktop | Xvfb, no window manager. Measured with a real headless Chromium: **572 to 597 MB RSS, 10 processes** per computer | XFCE-class desktop; the image is 1.4 GB compressed; memory not measured here |
| Own companion | Built in (same worker as a PC) | **Not there.** We would derive an image to add Node 22 and our companion: we maintain a derived image anyway |
| Persistent assigned files | Per-computer working folder; survives computer and hub restarts (proven, real) | A container volume we would add ourselves |
| Resource limits | `systemd` or `docker run` flags (docker adapter built) | Docker flags (`--shm-size=512m` is in their own example) |
| Health and lifecycle | Our monitor: probe, failed, recover, idle suspend (proven) | Docker restart policy and container state; no equivalent of our lease, job pause or no-replay recovery |
| Authenticated viewer | The hub's own WebSocket: signed-in person, same-origin, then an RFB filter that allows input only for the lease holder. **No network port exists** | KasmVNC serves its own web client and its own login on **HTTPS port 6901** (`docker run -p 6901:6901 -e VNC_PW=...`). A published port with a password, outside our hub auth and lease |
| **File transfer** | Jobs write and read the working folder (`file.write`, `file.read`); the owner can copy files out of the volume. No drag-and-drop | **Not in standalone.** Kasm's README: "audio, uploads, downloads, and microphone pass-through are only available within the Kasm platform" |
| **Clipboard** | RFB ClientCutText, passed only while the viewer holds the lease (gate test); needs x11vnc on the computer | KasmVNC's clipboard in its own web client; standalone, gated only by its password |
| **Audio** | None (not built) | **Not in standalone** (platform feature) |

**Verdict: keep our own environment; do not adopt Kasm now.** Least maintenance is not the smallest image. Kasm's image saves us Chromium and desktop
patching, but its three real conveniences (file transfer, audio, microphone) need the Kasm platform, which is a separate product with its own servers,
licence terms and upgrade path (a new thing to run and keep current, larger than what it saves); standalone it gives us a desktop and a password-protected
HTTPS port. We would still have to derive an image to add our companion, and we would either expose that port (breaking "viewer only behind hub auth,
never a public port") or tunnel it and re-implement our lease gate around KasmVNC's own protocol. Ours is a handful of `apt` packages that
the distro patches, one script that is identical on WSL, a VPS and inside a container, and it already has the lease, recovery and no-replay behaviour. Revisit
Kasm if the business needs full desktop apps, audio or microphone for agents, and then adopt the **platform**, not a standalone image.

**The docker adapter (built for the owner's spare laptop, not run).** `scripts/computers/docker.ts`, image recipe `deploy/computers/docker/Dockerfile`.
One container per computer; the same `computer-ctl.sh` runs inside it through `docker exec -i`; **no published port**; `--cap-drop ALL`,
`no-new-privileges`, memory, CPU and pids limits; one named volume per computer for its whole home (files survive stop, suspend and recreate; only `destroy`
removes it); the image must be pinned by digest (a tag is refused); the pairing code goes through stdin, never a `docker` command line (it would persist in
`docker inspect`). Proven only against a fake `docker` CLI (6 tests). For a laptop the companion reaches the hub through the bridge on the docker gateway address,
as on WSL. On a real VM the same image is the stronger boundary than `wsl-local`.

## 2. noVNC (MPL-2.0), pinned, through the hub's proxy

<https://github.com/novnc/noVNC>. `@novnc/novnc` **1.7.0**, exact in `package.json` (licence MPL-2.0: file-level copyleft, so we use it as an
unmodified npm dependency served by the hub from `node_modules`, and never copy its files into our tree). Only `core/**.js` and `vendor/**.js` are served,
to signed-in founders, with no traversal.

Path: Computers page, iframe of `/__computers/<name>/viewer`, noVNC, the hub's authenticated WebSocket `/__computers/<name>/vnc`, the RFB gate, a stdio
tunnel to the computer's loopback-only VNC server. **Control arbitration is ours, not the viewer's**: noVNC is set view-only unless the hub says this person
holds the lease, but the decision that matters is made on the hub per message (`rfb.ts`), so a modified page cannot type into a computer it does not hold.
The gate now also knows what noVNC adds (Fence passes; a resize and QEMU's extended key count as input).

**Contract for Agent C** (also in `scripts/computers/novnc.ts`):

* Embed: `<iframe src="/__computers/<name>/viewer" title="<name> computer">`. Same origin; `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`.
* The page shows the screen, "Take control" / "Return to agent", and heartbeats the lease (every 20 s) while the person holds it.
* To parent, same origin only: `{ source: "mu-computer-viewer", name, connected, canControl, state, controller: {kind, who}, takeoverPending, paused }`.
* From parent: `{ target: "mu-computer-viewer", type: "takeover" | "return" }`.
* For a custom component: `GET /__computers/<name>/viewer-state` returns `{ view, canControl, me }`; connect `new RFB(el, "ws(s)://<host>/__computers/<name>/vnc", { shared: true })`
  with `rfb.viewOnly = !canControl`; import from `/__computers/assets/novnc/core/rfb.js`.
* A computer with no VNC server (no Xvfb and x11vnc): `view.viewer.vnc` is false; use `GET /__computers/<name>/screenshot` (works whenever a browser is installed,
  even headless, `view.viewer.snapshot`).

**Proof.** `novnc.test.ts` runs a real Chrome with the real noVNC client against the hub with a small but proper RFB server behind the proxy: it connects, paints the
computer's frame (pixel checked), is view-only until "Take control", the click then reaches the computer, and after "Return to agent" the same click does not.
It is **not** yet run against a real `x11vnc` (not installed here).

## 3. E2B Desktop (assessment only; nothing was created or run)

Sources: <https://github.com/e2b-dev/desktop>, <https://docs.e2b.dev/sandbox/persistence>, <https://e2b.dev/pricing>. **Where the SDK lives now:** the `e2b-dev/desktop` repo
says the SDK source moved to the E2B monorepo and the repo itself keeps "the sandbox template and the examples"; the SDK is `e2b-dev/E2B` `packages/desktop-js`
(`npm install @e2b/desktop`) and `packages/desktop-python` (`pip install e2b-desktop`), confirmed by fetching that path. Licence: Apache-2.0 per the repository page (the package's own
LICENSE file was not read).

| | E2B Desktop | Ours |
|---|---|---|
| Provision and stop | `Sandbox.create()` with an `E2B_API_KEY` (an account); `pause()`, `connect()`, `kill()` | Our adapters; no third-party account |
| Viewing and control | `desktop.stream.getUrl()` and `getAuthKey()` (`requireAuth`, optionally one window); control by SDK calls (`screenshot`, `left_click`, ...). Linux with Xfce | Hub WebSocket plus noVNC; control through the lease; typed job steps and the hub-side goal loop |
| Persistence | `pause` keeps the **filesystem and memory** ("exact state"), kept indefinitely until killed; pause about 4 s per GiB of RAM, resume about 1 s; services are unreachable while paused | Files (disk); processes restart; no memory snapshot |
| Limits | 1 to 8 vCPU, 1 to 8 GiB (standard 2 vCPU / 4 GiB); continuous runtime 1 hour on Hobby and 24 hours on Pro before a pause; 20 concurrent sandboxes on Hobby, 100 on Pro | Our own hardware or VM |
| Cost and account | Hobby: free plan with a one-time US$100 credit; Pro: US$150 a month plus usage, US$0.000014 per vCPU-second and US$0.0000045 per GiB-second. A standard 2 vCPU / 4 GiB sandbox is about **US$0.166 an hour, about US$121 a month if always on** | The VM already proposed (A$39.20 a month ex GST) hosts several desktops |
| Data and region | The pricing page says nothing about data residency or an Australian region | Sydney VM, or this PC |
| Where the agent runs | The agent calls the sandbox API from outside; E2B's agent (`envd`) is the hands, not our companion | Our companion and ledger: verification, cancel, observe-before-retry, no replay |

Differences that matter to us: (1) a third-party cloud means a card, a key to keep, and our pages and logins inside their infrastructure; (2) its one real advantage is the
**memory-preserving pause** (resume mid-task), which our design does not have; (3) our lease, job pause, takeover and no-replay recovery would have to wrap the SDK calls
(an adapter could hold them, but the ledger-based "observe, never repeat" guarantee would need their commands to be idempotent, which we cannot see); (4) cost per always-on desktop is several times a share
of our VM. **Decision: deferred.** Worth a trial only if a desktop must resume exactly mid-page; that needs the owner's account and card (not done). An adapter stub was
not written: it would not be evidence.
