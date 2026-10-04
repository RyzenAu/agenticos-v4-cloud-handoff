# LAN bot host: shared bot computers on a second Windows PC

Status (2 Oct 2026): built, tested with fakes, **and run for real against Ryzen-PC** (192.168.1.120, WSL2 kali-linux): see `LAN-BOT-HOST-EVIDENCE.md`.

## Topology

```
 hub PC (192.168.1.130)                                    Ryzen-PC (192.168.1.120, Windows 11, WSL2 kali-linux, mirrored networking)
 ┌──────────────────────────────┐   ssh (key only)        ┌───────────────────────────────────────────┐
 │ hub  127.0.0.1:<hubPort>     │ ─────────────────────▶  │ Windows OpenSSH Server (firewall: only .130)│
 │  └ bridge 127.0.0.1:<random> │   ssh -R tunnel (1)     │  127.0.0.1:18091 ◀── shared with WSL        │
 │     (companion routes only)  │ ◀═══════════════════    │ WSL kali: computers bot1, bot2 ...          │
 │ VpsSshAdapter "vps-ssh"      │   ssh -W (viewer)       │  each: Xvfb + x11vnc(127.0.0.1) + Chromium  │
 │ WslLocalAdapter "wsl-local"  │ ─────────────────────▶  │        + companion -> http://127.0.0.1:18091│
 └──────────────────────────────┘                         └───────────────────────────────────────────┘
```

- The hub runs both adapters at once. A computer's record keeps its `adapter` field (`wsl-local` on this PC, `vps-ssh` on Ryzen);
  provisioning picks by it (`POST /__computers {"adapter":"vps-ssh"}`; default is the first configured).
- **Control**: every action is `ssh ryzen-bots wsl.exe -d kali-linux -u root --exec bash -s -- <action> <args>` with
  `computer-ctl.sh` plus the environment header on stdin (pairing codes never ride a command line). Windows sshd's shell is cmd, which is why `wsl.exe --exec` is
  the entry point. Arguments stay in the script's fixed alphabet, which contains no cmd metacharacter.
- **Companion to hub**: the adapter keeps ONE supervised reverse tunnel. The hub opens **no LAN port**: its bridge binds `127.0.0.1` on a random port
  (`bridge.ts` forwards only the seven `/__devices/companion/*` routes, rewrites Host to the hub's loopback, strips tailnet/forwarding headers).
  Inside WSL (mirrored networking shares loopback with Windows) the companion uses `http://127.0.0.1:<remotePort>`.
- **Viewer**: `ssh -W 127.0.0.1:<vncPort> ryzen-bots` (stdio forwarding), the same hub-authenticated WebSocket as wsl-local. No VNC port on the LAN.
- **Allocator**: `alloc.json` lives on each host (`~/mu-computers` inside that host's WSL), so displays, VNC and CDP ports are allocated per host and cannot collide across
  the two hosts. (The same computer name may exist on both hosts; names are unique per hub because the record store is the hub's.)
- **Lifecycle** (lease, takeover, Stop, recover, suspend/resume, destroy) is the shared ScriptAdapter code, unchanged.

## Environment (names only; none is a secret)

| Variable | Meaning | Default |
|---|---|---|
| `MU_COMPUTERS_SSH_ALIAS` | `Host` block in the hub's `~/.ssh/config` (`ryzen-bots`). Enables the adapter. | unset (off) |
| `MU_COMPUTERS_SSH_WSL_DISTRO` | Host is Windows: run the script in this WSL distro. Unset = plain Linux host (`bash -s --` as for a VPS). | unset |
| `MU_COMPUTERS_SSH_REMOTE_PORT` | Loopback port ON the host that the reverse tunnel points at the hub's bridge. Two hubs must use different ports. | 18091 |
| `MU_COMPUTERS_SSH_TUNNEL=off` | Hub runs on the host itself: companions use the hub's loopback, no tunnel. | on |
| `MU_COMPUTERS_SSH_RUN_AS_PREFIX` | One Linux user per computer, named `<prefix><name>` (e.g. `mu-`); the browser keeps its sandbox. Needs the script to run as root (`-u root`). | unset (everything as the control user) |
| `MU_COMPUTERS_SSH_COMPUTERS_HOME` | Where computers live on the host (must be readable by those users, so not `/root`). | `~/mu-computers` of the control user |
| `MU_COMPUTERS_SSH_WSL_USER` | The WSL user the control calls run as. | `root` |
| `MU_COMPUTERS_SSH_BIN` | The ssh program. | `C:/Windows/System32/OpenSSH/ssh.exe` on Windows, else `ssh` |

Why the explicit default: on this PC `ssh` resolves (Git Bash and PowerShell PATH alike, and `Bun.which`) to **Git's bundled `ssh.exe`**, not Windows OpenSSH.
Both read `~/.ssh/config`, but the adapter pins the Windows one for predictable behaviour. Set `MU_COMPUTERS_SSH_BIN` to override.

Hub `~/.ssh/config` (owner-managed; this code never reads the key):

```
Host ryzen-bots
  HostName 192.168.1.120
  User mkhan
  IdentityFile ~/.ssh/mu_bots_ed25519
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
```

Start the hub with both hosts:

```
MU_COMPUTERS_WSL_DISTRO=kali-linux MU_COMPUTERS_SSH_ALIAS=ryzen-bots MU_COMPUTERS_SSH_WSL_DISTRO=kali-linux ...
```

## The tunnel

`ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:18091:127.0.0.1:<bridgePort> ryzen-bots wsl.exe -d kali-linux -u root --exec cat`

- **Remote command is `cat`, not `-N`/`sleep infinity`.** `-N` would run no remote command. The hub writes a marker line to ssh's stdin and the tunnel counts as **up only when `cat` echoes it
  back** (auth, session and, with `ExitOnForwardFailure`, the forward all worked); a 2 s "still alive" timer was shorter than `ConnectTimeout` and proved nothing. A silent ssh is killed after 20 s and retried.
  `cat` ends when the hub's end closes, so a hub that dies takes its remote session (and nearly always its ssh) with it. While connected, it also keeps the WSL distro awake.
- Supervised by `ssh-tunnel.ts`: restarts with backoff 1, 2, 5, 10, 30 s (then 30 s). The backoff returns to its first step only after the tunnel has stayed up 60 s, so a flapping tunnel keeps backing off.
  `hubUrl()` waits for "up" (20 s) and rejects if it never comes, while the supervisor keeps retrying; **a provisioning request that hits that failure marks the computer failed (502) so it can be destroyed and its name reused**;
  `GET /__computers/host` notes a tunnel that is down.
- Brought up on hub start for existing records (`configure()` calls `hubUrl()`), killed on hub close. The ssh pid is kept in `<data dir>/computers/ssh-tunnel-<alias>.pid`; after a hard kill the next start stops the orphan
  **only if that pid's command line contains `-R 127.0.0.1:<remotePort>:` and the alias** (an image-name check alone could kill an unrelated `ssh.exe` after pid reuse).
- **Hub-side trust**: every request the bridge forwards carries `x-mu-bridge: 1` (the bridge strips any incoming copy first). The hub treats such a request as a bridge client: it accepts **only a cloud computer's
  one-time code and token** (a person's pairing code, or a personal companion's token, is refused), and wrong codes count in a separate `bridge` lockout bucket, never the shared `hub` one the owner pairs from.
  This matters because anything running on Ryzen's 127.0.0.1:18091 reaches the bridge. It applies to wsl-local's bridge too.

## Desktops only live while WSL is awake

Computers are processes inside Ryzen's WSL distro. WSL shuts the distro down when nothing is running in it; while this hub's tunnel is connected, its remote `cat` holds the distro open, but if the hub is off or the tunnel is down
for long, WSL idles out, the computers stop, and the monitor shows them failed (`GET /__computers/host` says so). Automatic recovery restarts them once the host is reachable again; the automatic-recovery allowance (3) is restored
after a recovered computer has stayed healthy for 2 minutes (`recoveryHealthyMs`), so repeated hub restarts do not leave Ryzen computers failed for good. (`recoveries` stays the lifetime count.)

**Durable fix, owner-side, user-level, on Ryzen (not done remotely):** a keep-alive that does not depend on the hub, e.g. a Startup-folder shortcut or a logon scheduled task for the user `mkhan` running
`wsl.exe -d kali-linux --exec sleep infinity` (hidden window; no `-u root` needed). With it WSL stays up across hub restarts and tunnel drops.
A ready, validated (not applied) installer for it is `deploy/computers/windows/Install-WslKeepAlive.ps1` (round 6; see `BOT-WORKFLOWS-R6.md` section 9).

## Bundle install

`installBundle()` stages the companion under the host user's computers folder, not `/tmp` (a fixed name in a world-writable folder is a symlink/TOCTOU risk for a root process): `<computers home>/bundle-<hubId>.mjs.new` (default `/root/mu-computers`; `/var/lib/mu-computers` with per-computer users; `$HOME/mu-computers` on a plain Linux host). The bytes (not a utf8 string) go through ssh stdin into `wsl.exe --exec dd of=... bs=65536 iflag=fullblock,count_bytes count=<size>` (no shell, no quoting; dd reads exactly the byte
count, so a stdin without EOF cannot hang it), then `sha256sum` on the host is compared with the local file, the file is moved into place and `computer-ctl.sh install-bundle bundle-<hubId>.mjs` copies it to
`~/mu-computers/bin/companion.mjs` (a relative name resolves inside the computers home; `..` is refused). Whatever the outcome, the staged files are removed. A damaged copy is refused before install. scp was rejected: into
WSL it needs `\\wsl$` or a Windows staging folder and a second tool; `sh -c 'cat > x'` was rejected because cmd and sh quote differently.

## Isolation: what it is and is not

**The true boundary: separate Linux users and 700 folders on ONE shared WSL VM.** Each computer has its own X display, browser profile, working folder, Linux user (`mu-<name>`, created by
`computer-ctl.sh provision`, removed by `destroy`), its own VNC and DevTools ports and its own control lease. The folder is mode 700 and owned by that user, so **direct file access between computers is blocked**
(verified: `Permission denied` reading the other computer's folder), and Chromium **keeps its sandbox** (checked on the host, see the evidence file: `chrome://sandbox` says "You are adequately sandboxed", renderers have
a seccomp filter, `NoNewPrivs`, and their own user and PID namespaces).

**What is shared**: the kernel, the WSL VM, the network and the disk, and every **loopback service**: the browser's debugging port (127.0.0.1:94xx, no authentication), VNC (127.0.0.1:60xx, `-nopw`), the X display and the
hub bridge (127.0.0.1:18091). Measured: as the other computer's Linux user, `curl 127.0.0.1:9401/json/version` answered 200, a VNC connection returned an RFB banner and `xdotool` read the display's geometry. So one bot's
user could drive the other's browser (and read what that browser can read, such as `file://` pages of its own folder), and root on the VM sees everything. **The two bot computers on a host are one trust domain.** This is
**not machine isolation**; do not describe it as a sandboxed machine per bot, and do not put a computer with different trust (a customer's account, say) on the same host as another.

- `MU_COMPUTERS_SSH_RUN_AS_PREFIX=mu-` turns the per-user setup on (the control account, `wsl.exe -u root`, creates the users and drops privileges with `setpriv`). The prefix must end with a dash (a bare `r` + `oot` must never be
  root). Without it the script runs everything as the control user, and as root Chromium cannot start with its sandbox on (the host check says so, and also says when a prefix is set but the script is not root). `computer-ctl.sh` never switches the sandbox off.
- Computers live under `MU_COMPUTERS_SSH_COMPUTERS_HOME` (`/var/lib/mu-computers`), because root's home is not readable by the per-computer users.
- **Root never writes into a computer's own folder.** Pid files, the owner key and the hub id live in a root-owned sibling (`/var/lib/mu-computers/.ctl/<name>`, mode 700); logs are opened by the inner shell after privileges drop;
  the pairing code reaches the companion through its environment, not its command line (other users can read command lines); `computer.json` (written by the computer's user) is validated by the root script before its display, port or
  resolution is used; `x11vnc` runs with `-norc -noipv6 -rfbportv6 -1` (no rc file, no IPv6 listener: `-noipv6` alone still left `[::1]:5900`, found on the real host); `shot` runs as the computer's user.
- **User names are host-wide.** `provision` refuses to adopt, and `destroy` and `stop` refuse to kill or delete, a user that already exists unless its home is exactly this computer's `<computers home>/<name>/home`.
  As root, a computer folder owned by a non-root user is always run as that user, even if the prefix setting is missing (fail closed). `destroy` reports a user it could not delete (it never returns ok), kills the user's remaining
  processes first and removes the user's Chromium folders in `/tmp`. A name longer than 32 characters is shortened and given a hash of the whole name.
- Fonts matter: with only `fonts-liberation` a bare Kali has no sans-serif default and Chromium drew page text as empty boxes. The host check now reports `fonts` as missing (and also when `fc-match` is not installed, so it cannot be checked);
  the install command includes `fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji`. The computers' processes also run with `LC_ALL=C.UTF-8 LANGUAGE=en_AU:en`, so multilingual pages answer in English.

**Recorded next hardening (not done):** give each browser a DevTools pipe (`--remote-debugging-pipe`) or a unix socket owned by its user instead of a loopback TCP port; run `x11vnc` with `-rfbauth` (a per-computer password file in the 700 folder)
or `-unixsock` instead of `-nopw` on a TCP port; start each Xvfb with `-auth` and a per-computer cookie in the 700 folder (the X display accepted another user's `xdotool` in the measurement above); put the bridge behind a
per-host token. Each is a change to how the hub reaches the computer (DevTools and VNC are what the hub's viewer and snapshots use), so none was started.

## Page loading on Ryzen (diagnosed 2 Oct 2026)

**Symptom:** research pages `nca.gov.au`, `nma.gov.au`, `parliament.act.gov.au`, `aph.gov.au` ended "The page didn't finish loading" on Ryzen (not on a plain curl, and not on this PC).

**Cause (measured, see the evidence file):** Ryzen's network answers `127.0.0.1` for the Google tracker hosts (`www.google-analytics.com`, `stats.g.doubleclick.net`), **even when Ryzen asks 8.8.8.8 or 1.1.1.1 directly**, and even Windows itself
gets `127.0.0.1` (hosts file empty, no DNS-filter process): a DNS sinkhole on the network path (router or ISP), not WSL, mirrored networking, MTU or IPv6. Those requests then stay pending for ever in Chromium. Our `browser.navigate`
waited for `document.readyState === "complete"` (the `load` event, which needs every subresource) within 25 s, so a page full of analytics never counted as opened although its DOM was ready within 0.8 to 4.3 s. IPv6 is not it
(there is no IPv6 route on either host and `curl -6` fails at once on both), DNS for the sites themselves is fine (the page hosts resolve and answer in 10 ms), the MTU is 1500 on Ryzen, and a browser User-Agent changes nothing for Chromium (curl's own UA gets 403 from nma and aph; a Chrome UA gets 200 and 302).

**Fix (at the cause: what "opened" means):** `browser.navigate` now counts a page as opened when its DOM is ready (`interactive`) with a real title that has not changed for 2 s, even if `load` never fires, and the result says so: "The page was still
loading background requests, such as analytics, that never finished; its text is there." (`data.stillLoading: true`). A page that never reaches `interactive`, has no title, or whose title keeps changing is still not opened. No change to Ryzen's Windows
side or to its DNS (the sinkhole is the owner's tracker blocking and is left alone).

## Owner-side prerequisites on Ryzen (done by the lead / owner, not by this code)

OpenSSH Server running, key-only, firewall allowing only 192.168.1.130; `.wslconfig` `networkingMode=mirrored`; WSL kali-linux with Node (Kali's own `nodejs` 24), python3, `setpriv`/`useradd` (util-linux and passwd, preinstalled) and the
desktop packages (`xvfb chromium x11vnc xdotool` plus the fonts above; the exact command is shown by `GET /__computers/host`); host key accepted once by hand (`ssh ryzen-bots true`). All three ssh invocations pin
`StrictHostKeyChecking=yes` (the control calls, the tunnel and the viewer's `-W`, each with `ConnectTimeout=10`).

Checks (all run and passed in the real-host phase; see `LAN-BOT-HOST-EVIDENCE.md`):

- `netstat -ano | findstr 18091` on Ryzen shows the listener on **127.0.0.1 only** (`GatewayPorts` default `no`); from the hub PC a TCP connect to 192.168.1.120 on 18091, the VNC ports (60xx) and the browser-debugging ports (94xx) all fail.
- sshd's default shell is **cmd**. Anything with a pipe or quoting must go through stdin (`bash -s`, `powershell -Command -`): `ssh ryzen-bots "wsl.exe ... bash -c 'a | b'"` is parsed by cmd, not by the shell you meant.
- `wsl.exe --exec` finds `node`, `python3`, `Xvfb`, `chromium`, `x11vnc` and `xdotool` on its default PATH (confirmed).
- On the hub side, do not pass `MU_COMPUTERS_SSH_COMPUTERS_HOME=/var/lib/...` from Git Bash without `MSYS_NO_PATHCONV=1`: Git Bash rewrites it into `C:/Program Files/Git/var/lib/...` and the adapter refuses it ("bad computers home").

## Setting these values for the live hub (Git Bash path-rewrite hazard)

**Hazard.** From Git Bash, any value that starts with `/` is rewritten as a Windows path. `MU_COMPUTERS_SSH_COMPUTERS_HOME=/var/lib/mu-computers bun ...` arrives in the process as
`C:/Program Files/Git/var/lib/mu-computers` (measured: `MU_X=/var/lib/mu bun x.ts` printed exactly that), and the adapter refuses it at startup ("bad computers home"), so **no `vps-ssh` adapter is created**
and provisioning answers "No computer host is configured on this hub." The same applies to `MU_COMPUTERS_SSH_BIN` if it were given as a POSIX path.

**Safe ways** (the value is `/var/lib/mu-computers`, a path inside Ryzen's WSL, never a Windows path):

- In **PowerShell**, no rewriting happens: `$env:MU_COMPUTERS_SSH_COMPUTERS_HOME = '/var/lib/mu-computers'`. Persistent for the user (survives logoff, read by processes started afterwards):
  `[Environment]::SetEnvironmentVariable('MU_COMPUTERS_SSH_COMPUTERS_HOME', '/var/lib/mu-computers', 'User')`; set the other values the same way
  (`MU_COMPUTERS_SSH_ALIAS=ryzen-bots`, `MU_COMPUTERS_SSH_WSL_DISTRO=kali-linux`, `MU_COMPUTERS_SSH_RUN_AS_PREFIX=mu-`). Only the hub process and tasks started after the change see user variables, so restart the hub (and the supervisor's task) after setting them.
- In **Git Bash** only with `MSYS_NO_PATHCONV=1` in front (or `MSYS2_ARG_CONV_EXCL='*'`): `MSYS_NO_PATHCONV=1 MU_COMPUTERS_SSH_COMPUTERS_HOME=/var/lib/mu-computers bun ...`.

**Confirmed to survive the supervisor's start path.** `scripts/windows/agentic-os-supervisor.ps1` starts the hub with PowerShell's `Start-Process -FilePath <bun.exe> ... -WindowStyle Hidden`, which inherits the supervisor's
environment unchanged. Checked on this PC: with `$env:MU_COMPUTERS_SSH_COMPUTERS_HOME = '/var/lib/mu-computers'` set in PowerShell, a `Start-Process`-started `bun.exe` wrote `/var/lib/mu-computers` (not a `C:/Program Files/Git/...` path);
a `cmd /c`-started child also kept `/var/lib/x`. After restarting the live hub, confirm with `GET /__computers/host`: a `vps-ssh` entry with `host: "Ryzen-PC"` means the values were accepted (if the list lacks it, the hub log shows `Error: bad computers home`).


## What is real and what is synthetic

Everything under "real" ran on the real LAN host (Ryzen-PC WSL) with a real hub on this PC; details and outputs are in `LAN-BOT-HOST-EVIDENCE.md`.

| Piece | Status |
|---|---|
| Control through `ssh ryzen-bots wsl.exe -d kali-linux -u root --exec bash -s`, bundle push (`dd` + sha256), tunnel marker round trip, supervised restart, orphan reaping | real, plus fake-runner/fake-ssh unit tests |
| Two separate desktops (own display, profile, folder, Linux user, sandbox on; one shared VM and trust domain), viewer through the hub (`ssh -W`), lease / takeover / return / Stop, no cross-talk | real |
| Hub kill and restart (recovery, no duplicates), tunnel loss, WSL idling out during a long hub outage | real |
| File and browser-cookie persistence across Stop/Start and hub restart | real |
| Capacity at 2, 3 and 4 desktops with a real browse load | real (measured; the ramp stopped at 4 by design, not at a limit) |
| Bridge trust (`x-mu-bridge`: computer codes and tokens only) | real HTTP against the hub's device service (`bridge-guard.test.ts`) |
| The model-driven `research` executor (SearXNG rebuilt by the lead) | real: after the page-load fix the same Canberra goal finished in 14 to 20 s (3 to 5 model calls) and the executor reported complete with 5 to 6 cited facts from 1 to 2 sources; it found no population figure (see the evidence file, sections 9 and 11) |
| A non-Windows host, a VPS, GPU use | not applicable / not exercised (WSL exposes no `/dev/dri`, so Chromium renders in software; Windows GPU engine counters read 0 throughout) |

Files: `scripts/computers/{vps-ssh,ssh-tunnel,plugin,journey-lan}.ts`, `deploy/computers/linux/computer-ctl.sh`, tests in `scripts/computers/{lan-host,lan-service,bridge-guard}.test.ts`.
