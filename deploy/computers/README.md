# Shared agent cloud computers: host runbook

Code: `scripts/computers/` (hub side), `companion/linux/` (the computer's companion), this folder (the host side).
Design and numbers: `docs/programme-20261001/COMPUTERS-ARCHITECTURE.md`. Proof: `COMPUTERS-EVIDENCE.md`.

A shared cloud computer is an isolated Linux desktop (own X display, own Chromium profile, own working folder) running the
same companion worker every PC runs. Two hosts are supported; both run the **same script** (`linux/computer-ctl.sh`).

| Host | Adapter | State |
|---|---|---|
| WSL2 distro on this PC (stand-in for a VM) | `wsl-local` | built, run for real (evidence file) |
| Linux host over SSH: a Sydney VPS, or the LAN Windows PC via WSL (`docs/programme-20261001/LAN-BOT-HOST.md`) | `vps-ssh` | tested through fakes; real-host run pending |

## 1. The WSL stand-in (this PC, no cost)

Needs: a running WSL2 distro with Node 22 (Kali here has it). For the desktop the distro also needs these packages (116
packages, about 164 MiB, from the distro's own repository; checked with `apt-get --simulate`). This code never installs
anything and never asks for a password, so the owner runs it once, in a terminal:

```
wsl -d kali-linux -- sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation
```

Without them a computer still runs, **headless**: files and commands, no browser, no screen. `GET /__computers/host` says which
packages are missing and shows that exact command.

Start a hub that knows the host (environment names only; none is a secret):

```
MU_HUB_ROLE=cloud MU_DATA_DIR=D:\prog-f-data HINDSIGHT_URL=off MU_MEMORY_WRITES=off ^
MU_COMPUTERS_WSL_DISTRO=kali-linux  bun --bun node_modules/vite/bin/vite.js dev --port 8112 --host 127.0.0.1 --strictPort
```

What happens when a founder provisions a computer (`POST /__computers {"name":"research"}`, a confirmed browser session):

1. the hub checks the host, builds the companion to one Node file (`build-companion.ts`) and copies it into the distro;
2. it makes a one-time pairing code bound to the name (10 minutes, single use) and starts the **bridge** (below);
3. `computer-ctl.sh provision` creates `~/mu-computers/<name>/{cfg,profile,work,run,logs}` and the companion pairs with the code;
4. `computer-ctl.sh start` launches Xvfb (if installed), x11vnc (if installed, loopback only) and the companion, each in its own session.

**The bridge.** A WSL2 distro sits on a NAT network and cannot reach the hub's loopback. The hub listens on the WSL virtual
switch address (one interface, never `0.0.0.0`) and forwards ONLY the seven companion routes to its own loopback port, with a
the hub's own loopback Host (the hub accepts a computer's token only on its direct local path: no Serve login, local Host; a computer token is an identity on those seven routes and nowhere else). It strips Tailscale,
forwarding, cookie and page-token headers. Every other path answers 404 at the bridge.

**Stop and clean up.** `POST /__computers/<name>/action {"action":"destroy"}` stops the processes, revokes the pairing and deletes
the computer's folder. Nothing is deleted automatically. `rm -rf ~/mu-computers` inside the distro removes the shared bundle.

**The real journey.** `bun scripts/computers/journey.ts --hub http://127.0.0.1:8112 --out D:\prog-scratch\journey` provisions two
computers, runs two agent jobs at once, a takeover and return, an abandoned viewer, a stop and a crash with recovery, then tears
everything down. With the desktop packages installed it also navigates each computer's Chromium to a different public page,
checks the title and takes a snapshot.

## 2. A Sydney VPS (sketch; nothing here has been run or bought)

Recommendation from `CLOUD-ARCHITECTURE.md`: BinaryLane Professional (4 vCPU, 8 GB, about A$39.20 a month ex GST, checked 1 Oct).
The hub and its computers share the VM, so a computer reaches the hub over **loopback** (`http://127.0.0.1:<port>`); no bridge,
no public port.

1. **Owner creates the VM and an SSH key** (owner-only account steps; this code never sees a key or password).
2. **Host key by hand, once**: `ssh mu-computers true` from the hub, so the host key is accepted on the owner's terms.
   `~/.ssh/config` on the hub: `Host mu-computers` / `HostName <ip>` / `User mu` / `IdentityFile ~/.ssh/id_ed25519` /
   `ServerAliveInterval 15`. The adapter passes `-o BatchMode=yes`: it never prompts.
3. **Packages** (as root, once): the same `apt-get install` line as above, plus **Node 22** for the companion (Debian 13 and
   Ubuntu 24.04 ship older Node; Node 22 from NodeSource, or Bun, is an owner decision because it adds a third-party repository).
4. **Egress rule** for the computers' user: `vps/egress.nft` (public web and the hub's loopback port only).
5. `scp` the built companion (`bun deploy/computers/build-companion.ts`) to the VM once; the script itself is streamed on stdin.
6. Set `MU_COMPUTERS_SSH_ALIAS=mu-computers` on the hub. Provisioning then runs `ssh mu-computers bash -s -- provision ...` with the
   script on stdin. Optional: `systemd/mu-computer@.service` to start each computer at boot.

The VNC server binds 127.0.0.1 **inside** the computer. The hub reaches it with `ssh -W 127.0.0.1:<port>` (stdio forwarding), so
there is never a VNC port on the VM's public address. The viewer is the hub's authenticated WebSocket (`/__computers/<name>/vnc`).

## 3. What each file does

| File | Role |
|---|---|
| `linux/computer-ctl.sh` | The one script: check, install-bundle, provision, start, stop, probe, shot, destroy. No root, no installs. |
| `build-companion.ts` | Builds `companion/linux/main.ts` to one Node file (stubs out the Windows-only executors). |
| `stubs/pc-only.ts` | What replaces the Windows executors in that build. |
| `systemd/mu-computer@.service` | VPS unit template (not installed). |
| `vps/egress.nft` | VPS egress rules for the computers' user (not applied). |
