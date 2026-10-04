# Tailscale on this PC: diagnosis (1 Oct 2026, ~09:45 AEST, Track A round 3)

Non-secret status only. No node key, auth key, login email or tailnet name was read or is recorded here. Nothing was changed: no `tailscale up`,
no prefs, no exit node, no ACL, no Serve/Funnel config, no log-out, no service restart, no elevation attempt.

## Verdict

**The daemon is wedged, not logged out and not offline.** The Windows service `Tailscale` has been running since 30 Sep 8:47 PM and has never
finished starting its backend. Everything around it is healthy. Restarting the service fixes this class of fault, and that needs Administrator.
**One exact owner step is below.**

## Evidence

| Check | Result |
|---|---|
| `tailscale version` | 1.102.4 (client and daemon the same build) |
| `Get-Service Tailscale` | Running, StartType Automatic |
| `tailscale status --json` | `BackendState: NoState`; `Self.Online: false`; `TUN: true`; `HaveNodeKey: true`; `CurrentTailnet: null`; one peer entry with no online state, OS or exit-node data; no `AuthURL` |
| `Health` | "Unable to connect to the Tailscale coordination server to synchronize the state of your tailnet. Peer reachability might degrade over time." and "Tailscale is starting. Please wait." |
| `tailscale debug prefs` (booleans and the control host only) | `WantRunning: true`, `LoggedOut: false`, control host `controlplane.tailscale.com` (the default, not a custom server) |
| Network path to the coordination server | `Test-NetConnection controlplane.tailscale.com:443` succeeded; `tailscale netcheck`: UDP true, IPv6 yes, captive portal false, nearest DERP Sydney 6.3 ms, UPnP port mapping available. The network is fine. |
| Network adapter | The `Tailscale` adapter is **Up** (the wintun device exists) |
| Windows event log | No `Tailscale` provider is registered in the Application log; Service Control Manager shows no recent Tailscale start or stop events (the service has not restarted in the window checked) |
| `%LOCALAPPDATA%\Tailscale` logs | `tailscale-ipn.log*.txt` are 0 bytes (last touched 30 Sep 2:02 PM); no GUI log activity. `C:\ProgramData\Tailscale` is not readable from a non-elevated shell. |
| Elevation | This shell is **not** elevated (`IsInRole(Administrator)` false) |

Reading it: the node has a key and wants to run, the machine reaches the control plane and DERP, yet the IPN backend is stuck in `NoState`
("starting") for 13 hours. The Go-level goroutine dump shows `startIPNServer` and the policy-reload watcher, with no `controlclient` loop,
which fits a backend that never got its start request: normally the GUI (or an unattended-mode flag) sends it.

## The two `tailscaled` processes

| PID | Parent | Session | Started | Role |
|---|---|---|---|---|
| 6420 | 1752 (`services.exe`) | 0 (services) | 30 Sep 8:47:28 PM | the **Windows service** (`Tailscale`), the supervisor |
| 9136 | 6420 | 0 | 30 Sep 8:47:28 PM (same second) | the **worker** the service launches as its own child: this is how `tailscaled.exe` runs as a Windows service; the real daemon |

Two processes is **normal**, not a duplicate daemon: one is the service wrapper and the other its child. Neither was spawned by a GUI. **There
is no `tailscale-ipn.exe` (GUI) process running at all**, and the executable path is not readable without elevation.

## The one owner step (needs Administrator; I did not try)

In an **elevated** PowerShell (right-click, Run as administrator):

```
Restart-Service Tailscale
```

Then check, from any shell: `tailscale status --json | ConvertFrom-Json | Select BackendState` should read `Running` within about 10 seconds.

* If it comes back `NeedsLogin`, run `tailscale up` once (no flags) and open the link it prints: that is a sign-in only the owner can do.
* If it still reads `NoState`, start the GUI once (Start menu, Tailscale); the GUI sends the missing start request and leaves the daemon running
  unattended afterwards. Nothing in the OS depends on the GUI staying open once `WantRunning` is true.

Everything that was waiting on this (Mehroz's real "view and take over" login, tailnet-only `:8443`, Tailscale Serve identity) is unchanged and
still unverified until the backend reads `Running`.

## What was ruled out

* Not a network or DNS fault (control plane and DERP reachable).
* Not a log-out or expired key (`LoggedOut: false`, node key present, no sign-in URL).
* Not a duplicate daemon (parent and child of one service).
* Not a custom control server (default host).
