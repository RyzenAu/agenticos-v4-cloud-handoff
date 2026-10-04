# WSL localhost forwarding vs protected hub routes (lead check, 1 Oct 2026)

Question: Track A documented that WSL2 localhost forwarding makes each bot computer's x11vnc and CDP ports reachable from
Windows loopback. Does anything let WSL (a bot computer, its Chromium or a page it loads) reach the hub's protected routes?

Probe (`/mnt/d/prog-slice/probe.sh`, run inside kali-linux with working curl, internet confirmed 200):

| Target from inside WSL | /__version | /__token | /__operator/state | /__devices/me | /__computers |
|---|---|---|---|---|---|
| 127.0.0.1:8081 | unreachable | unreachable | unreachable | unreachable | unreachable |
| localhost:8081 | unreachable | unreachable | unreachable | unreachable | unreachable |
| 172.19.48.1:8081 (Windows host gateway) | unreachable | unreachable | unreachable | unreachable | unreachable |

- WSL runs in NAT mode (no `.wslconfig` networking override); the hub binds 127.0.0.1 on Windows only, so WSL cannot reach it.
- The only WSL→hub path is the computer bridge (listens on the WSL-facing interface only while a computer hub runs; forwards
  only the seven `/__devices/companion/*` routes; strips Tailscale/forwarding/cookie/page-token headers; refuses `0.0.0.0`).
  A computer token is accepted only on the direct local path (ee28c40). Covered by `scripts/computers/bridge.test.ts` and
  `computers.test.ts` ("only on the hub's own host").
- The forwarding Track A documented is the other direction (Windows → WSL ports): a process running as the owner on Windows can
  reach a bot computer's VNC/CDP. That gives nothing a same-user Windows process doesn't already have (it can drive the owner's
  own desktop), so it is a residual, not an escalation. Owner opt-out: `localhostForwarding=false` in `%UserProfile%\.wslconfig`
  (untested; the hub reaches computers through the bridge/companion, so verify the viewer still works before relying on it).
- If the owner ever switches WSL to `networkingMode=mirrored`, WSL processes WOULD reach Windows loopback: re-run this probe
  first, and the identity gate's loopback-owner rule must then not trust WSL-originated requests.
