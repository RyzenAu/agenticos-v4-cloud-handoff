# Dot gateway: staging, the temporary Funnel, and the emergency switch (Ryzen-PC)

Design: `docs/programme-20261001/DOT-GATEWAY-DESIGN.md`. Dot's browser checklist: `docs/programme-20261001/DOT-GATEWAY-CHECKLIST.md`.

**Nothing here has been run on Ryzen.** The lead runs these, in this order, after the design passes independent review.
Staging uses **synthetic data only**: a new, empty folder seeded with obviously fake records. Never production, never a copy
of it, never the CRM rehearsal instance (that one was restored from a production backup).

| Script | What it does | Exposes anything? |
|---|---|---|
| `dot-gateway-staging.ps1 -Action export -Revision <commit>` | `git archive` of the reviewed commit into `C:\mu-hub\dot-gateway-staging\app-<sha>`, its own `bun install --frozen-lockfile` (**needs network access**; production's node_modules is never linked or written), UI built (`scripts/gateway/build-ui.ts`); never the working tree | no (outbound package download only) |
| `dot-gateway-staging.ps1 -Action seed` | creates and seeds `C:\mu-hub\data\dot-gateway-staging-synthetic` (refuses a non-empty folder) | no |
| `dot-gateway-staging.ps1 -Action start -PublicOrigin https://ryzen-pc.tailnet-name.ts.net` | staging hub `127.0.0.1:8086` run from the export (`MU_HUB_ROLE=server`, `MU_GATEWAY_TRUST=1`, no background work) + gateway `127.0.0.1:8096` serving the export's built UI and forwarding only `/__` API routes to that hub; refuses unless the export is clean (only the commit's files, no backups) and the data folder passes the synthetic check. Both processes get a SCRUBBED environment (an allow-list of names; a name matching KEY, TOKEN, SECRET or PASSWORD refuses the start; names are printed, never values) | no (loopback only) |
| `dot-gateway-staging.ps1 -Action mint-code [-By mehroz]` | one-time sign-in code for Dot, with short staging expiry (idle 2 min, absolute 10 min; `-IdleMinutes`, `-SessionMinutes`) | no |
| `dot-gateway-funnel.ps1 -Action on` | `tailscale funnel --bg --https=443 http://127.0.0.1:8096` after checking the port's only loopback listener is the gateway PID recorded at start, running `scripts/gateway/main.ts` (never 8081/8085/8086/8443/8445) | **yes: public 443 -> staging gateway only** |
| `dot-gateway-funnel.ps1 -Action off` | `tailscale funnel --https=443 off` | removes it |
| `dot-gateway-emergency-disable.ps1` | KILL switch file in every gateway data folder, Funnel off, gateway processes stopped | removes everything |
| `dot-gateway-staging.ps1 -Action stop` | stops the staging pair (does not touch the Funnel) | no |
| `mu-gateway-supervisor.ps1` | for later (production): restart loop for the gateway, like `..\mu-hub-supervisor.ps1`. Not installed by anything | no |

## Run order (lead)

1. Fetch the reviewed commit into `C:\mu-hub\AgenticOS-v4` (or pass `-SourceRepo`); do not check it out over production.
2. `dot-gateway-staging.ps1 -Action export -Revision <commit>`, then `-Action seed`, then
   `-Action start -PublicOrigin https://ryzen-pc.tailnet-name.ts.net`.
3. `dot-gateway-staging.ps1 -Action status`: the gateway answers `{"ok":true}`, the staging hub answers.
4. Check the Funnel syntax on this Tailscale version: `tailscale funnel --help`. Then `dot-gateway-funnel.ps1 -Action on`.
   From a phone off the tailnet: `https://ryzen-pc.tailnet-name.ts.net/gw/health` answers `{"ok":true}`, and
   `https://ryzen-pc.tailnet-name.ts.net:8443/` (the production hub) still does NOT answer off the tailnet.
5. When Dot is ready (not before): `dot-gateway-staging.ps1 -Action mint-code`; send Dot the link over a private channel and
   have it sign in at once. 20 wrong guesses from anyone burn an outstanding code; if that happens, mint another. Dot runs the checklist (stage 1, read-only).
6. Stage 2 (writes, synthetic records only), when the owner says so: `bun scripts/gateway/cli.ts grant crm.write --by usman --hours 1`
   with `MU_DATA_DIR=C:\mu-hub\data\dot-gateway-staging-synthetic` set in that shell.
7. When done: `dot-gateway-funnel.ps1 -Action off`, then `dot-gateway-staging.ps1 -Action stop`.

## The founder's console (any time)

Set `MU_DATA_DIR` to the data folder first (staging: `C:\mu-hub\data\dot-gateway-staging-synthetic`), then from the repo:

    bun scripts/gateway/cli.ts status
    bun scripts/gateway/cli.ts sessions
    bun scripts/gateway/cli.ts revoke-session <id>        (or --all: every session and every unused code)
    bun scripts/gateway/cli.ts grant crm.write --by usman --hours 1
    bun scripts/gateway/cli.ts revoke-grant crm.write
    bun scripts/gateway/cli.ts kill on | kill off
    bun scripts/gateway/cli.ts audit --tail 40

## Emergency

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\mu-hub\AgenticOS-v4\deploy\windows\gateway\dot-gateway-emergency-disable.ps1

Then check `tailscale funnel status` shows nothing on 443. If the script cannot run: `tailscale funnel --https=443 off`, and
create an empty file named `KILL` in `<data folder>\gateway\`. Either one alone cuts Dot off.

## Rollback

The gateway is additive. To remove it from a hub: stop the gateway, Funnel off, and start the hub without `MU_GATEWAY_TRUST=1`
(it then refuses every gateway assertion). Reverting the branch removes `/__gateway` and the gateway principal; founders'
sign-in, pairing and the local-owner proof never depended on it.
