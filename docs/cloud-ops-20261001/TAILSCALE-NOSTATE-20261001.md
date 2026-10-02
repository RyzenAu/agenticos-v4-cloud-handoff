# Tailscale on this PC: NoState diagnosis (1 Oct 2026, 16:10 AEST, round 4 cloud track)

Follows `docs/programme-20261001/TAILSCALE-DIAGNOSIS.md` (09:45, first diagnosis). Non-elevated shell. Read-only: no `tailscale up`, no log-out, no
prefs, ACL or node change, nothing uploaded, no bugreport sent. No key, login or tailnet name read or recorded.

## Verdict

**Best-supported hypothesis: the `tailscaled` service cannot complete its own HTTPS dial to the coordination server, so its backend never leaves
`NoState`. The network, DNS, time and proxy are all fine from a normal user session; the fault is inside the SYSTEM service's dial path, and
Cloudflare WARP (full-tunnel, running beside it) is the only interfering product found.** Not proven, because the service's own log is
unreadable without admin. A service restart is the cheapest fix; the permanent hardening is a WARP host exclusion. Both need an elevated shell.

## What changed since the 09:45 diagnosis

The earlier goroutine dump showed no control loop. **Now it does**: `controlclient.(*Auto).authRoutine` is running `TryLogin`, blocked in
`loadServerPubKeys` (the first call: fetch the control server's public key), with `dnscache.(*dialer).DialContext` and `LookupIP` goroutines
runnable and churning. `controlclient_map_requests` is 0. So the backend is not "never asked to start" any more; it is trying and failing to
reach `controlplane.tailscale.com`, matching the health text "Unable to connect to the Tailscale coordination server". Prefs from the earlier
check: WantRunning true, LoggedOut false, so it is not a login problem.

## Evidence

| Check | Result |
|---|---|
| `tailscale status` | `unexpected state: NoState`; Health: cannot reach coordination server + "Tailscale is starting" |
| Service | `Tailscale` Running, Automatic, LocalSystem; v1.102.4 |
| DNS (user session) | `controlplane.tailscale.com`, `login.tailscale.com`, `derp1.tailscale.com` all resolve |
| TCP 443 (user session) | all three reachable; `curl https://controlplane.tailscale.com/key?v=130` returned HTTP 200 |
| Proxy | WinHTTP direct; IE/HKCU proxy off, no PAC; no `HTTPS_PROXY`-type variables |
| Clock | Windows time source `time.windows.com`, last sync 10:07 AEST today, zone AUS Eastern; not skewed |
| `tailscale netcheck` | UDP true, IPv6 yes, **IPv4 "no addr found"**, captive portal false, nearest DERP Sydney 5.7 ms, UPnP present. (Its own first line: "No DERP map from tailscaled", expected while the daemon is stuck.) |
| tailscaled log | `C:\ProgramData\Tailscale` access denied (non-admin); GUI log files are empty; no `tailscale-ipn.exe` running |
| Interfering products | **Cloudflare WARP: service Running, interface Up, "Connected, network healthy"**. Routes to the control plane (IPv4 and IPv6) both go via the `CloudflareWARP` adapter, and every adapter's DNS is WARP's local proxy (`127.0.2.2`). WARP is in Exclude mode and already excludes `100.64.0.0/10` (Tailscale addresses) but excludes **no hosts**, so Tailscale's control traffic goes through WARP. TunnelBear adapter present, Disconnected. Defender is the only AV; firewall on all profiles (no Tailscale block found, cannot read rules' effect for SYSTEM). |
| Timing | `tailscaled` service and `warp-svc` both started 30 Sep 8:47:28 PM (same boot). So they raced at start-up; that is why the timing alone proves nothing. |

Reading it: from my user session the control plane answers (through WARP). From the SYSTEM service it never completes. The two differ in
account, in DNS path (service resolver through WARP's `127.0.2.2` proxy vs user), and in when they tried (the service dialled once at boot, while
WARP was still bringing its tunnel and DNS up). A wedged first dial that never recovers is a known failure shape for a long-running service;
a restart makes it dial again against the now-stable WARP. I could not test the SYSTEM path directly, hence "hypothesis".

## The one elevated block for the owner

Run in **PowerShell as Administrator** (right-click, Run as administrator):

```powershell
Restart-Service Tailscale
Start-Sleep 20
& "C:\Program Files\Tailscale\tailscale.exe" status
# Expected: your devices listed. If it says NeedsLogin, run: tailscale up   (no flags) and sign in in the browser.
# If it is STILL "NoState" after the restart, do these two (WARP stays connected; this only exempts Tailscale's control hosts):
#   & "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe" tunnel host add controlplane.tailscale.com
#   & "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe" tunnel host add login.tailscale.com
#   Restart-Service Tailscale; Start-Sleep 20; & "C:\Program Files\Tailscale\tailscale.exe" status
```

If you would rather keep WARP out of the picture entirely while testing, `warp-cli disconnect` first, restart the service, then
`warp-cli connect`. Do not log out of Tailscale.

## After it is fixed

`tailscale status` lists peers; then Mehroz's invite and `docs/MEHROZ-ENROL.md` proceed. If the restart worked without the WARP exclusion,
still add the two host exclusions: the same race can recur at the next reboot.
