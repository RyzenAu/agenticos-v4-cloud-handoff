# OpenClaw for Jarvis: decision (23 Sep 2026)

**Decision: pilot, narrowly.** Keep OpenClaw only as a **device relay**: a loopback gateway
that other devices pair to as nodes. Hermes stays the single brain. OpenClaw's own agent,
channels (Telegram/WhatsApp), ClawHub skills and HTTP tool API stay unused.

## Why

| Question | Finding | Evidence |
|---|---|---|
| What does it add that Hermes lacks? | **Nodes**: phones and other PCs as paired peripherals. Android: device status, notifications, location, camera, SMS, contacts, calendar, Talk. Windows Hub: screen/camera/canvas, notify, TTS/STT, `system.run`. Headless node host: `system.run` / `system.which` only. | OpenClaw docs `nodes/index.md`, `platforms/windows.md`; notebook Q1 |
| Can Hermes drive a node without OpenClaw's model? | **Yes, for non-shell commands**: `openclaw nodes invoke` is a direct RPC. **No, for shell**: `system.run` is refused by `nodes invoke` ("reserved for shell execution"), and `exec` and `nodes` are on the default deny list of HTTP `/tools/invoke`, which also skips approvals. | Tested 23 Sep; `gateway/tools-invoke-http-api.md` |
| Where are approvals enforced? | On the device itself (`exec-approvals.json` on the node host / companion app). With no operator UI connected, `askFallback` defaults to **deny**. | `nodes/index.md`, `tools/exec-approvals.md`; notebook Q2 |
| Security record | 15,200 control panels exposed because older defaults bound 0.0.0.0; CVE-2026-25253 (1-click RCE), CVE-2026-22176 (Windows scheduled-task injection, fixed 2026.2.25); ~20% of ClawHub skills found malicious in audits. | notebook Q5 (SecurityScorecard, Snyk/CrowdStrike/Cisco via secondary sources) |
| Windows problems | Node version (ours: system Node 23.5 lacks `StatementSync.columns()`, which caused the `doctor` crash); orphaned node.exe holding :18789; WSL sleep/idle bugs; `cmd /c` wrappers always need approval. | Reproduced + notebook Q4 |
| Cost traps | Default heartbeats and top-tier models produced $140–178/week bills for some users. The relay configuration has no model credentials and runs no agent turns. | notebook Q5 |

**Where sources disagree:** the notebook said `/tools/invoke` can run `exec` on a node. The
installed docs list `exec` and `nodes` as denied over HTTP by default, and say approvals are not
enforced on that endpoint. We follow the primary docs and never enable it.

## What was built

- **Root-cause fix**: OpenClaw runs on Hermes' Node 22.23 (`openclawNode()` in
  `scripts/capability-registry.ts`; `scripts/windows/openclaw-relay.ps1`). The state DB was never
  corrupt. Backup of the untouched state: `~/.openclaw-backup-20260923`.
- **Gateway config**: `gateway.mode=local`, `bind=loopback`, `auth.mode=token` (token generated
  by `openclaw doctor --generate-gateway-token`, stored only in `~/.openclaw/openclaw.json`).
- **Relay script**: `scripts/windows/openclaw-relay.ps1` (start / `-Stop`; refuses to start
  unless loopback + token). Not auto-started: turn it on when a real device is paired.
- **Capability** `devices.openclaw-nodes` (replaces `gateway.openclaw`): setup-required until a
  node is connected; lists connected devices and their command counts.
- **Hermes skill** `openclaw-nodes` (`%LOCALAPPDATA%\hermes\skills\devops\openclaw-nodes`):
  read-only commands free, privacy/sending commands and anything on Mehroz's device need a yes,
  never approves pairings, never uses `openclaw agent` or `/tools/invoke`.
- **Acceptance** group `openclaw nodes`: Jarvis → skill → `nodes invoke system.which` on a paired
  node, compared with a direct lookup.

## Pilot result

End to end on a local test node ("Jarvis-PC-pilot", a headless node host on this PC with its
own identity in `~/.openclaw-node-pilot`):

```
PASS  devices.openclaw-nodes  node "Jarvis-PC-pilot": Jarvis said "C:\Program Files\Git\cmd\git.exe"
      via openclaw nodes invoke; direct lookup C:\Program Files\Git\cmd\git.exe; 52 s
```

Each CLI call costs ~10–15 s of start-up, so a device round trip through Jarvis is ~50 s.
That's acceptable for "check my phone" but not for real-time voice.

Not yet proven: a **second physical device**. That needs the owner (below). The test node's
pairing is kept (disconnected) so the acceptance test can be re-run locally.

## Status, 23 Sep (night): steps 1–3 done

- Updated to **2026.9.5**. It needs Node >=24.16 <25, so a portable Node 24.21.0 (SHA-256 checked
  against nodejs.org) lives in `~\.openclaw-node\node24` for OpenClaw only. Not under
  `AppData\Local`: the Claude desktop app is MSIX-packaged, and new folders it creates there are
  redirected into its private package cache, invisible to other programs.
- The update switched on a heartbeat and memory "dreaming". Both are now off
  (`agents.defaults.heartbeat.every=0m`, `plugins.entries.memory-core.config.dreaming.enabled=false`).
  A system-owned weekly "Skill collection review" job can't be disabled. It can't run anyway:
  OpenClaw has no model credentials.
- Tailnet-only **Tailscale Serve on :8444** → 127.0.0.1:18789, with `gateway.trustedProxies=["127.0.0.1"]`
  (the "externally managed Serve" path). OpenClaw's own managed Serve can't take a custom port in
  this release. It tried 443, where the WhatsApp Funnel lives, and failed closed. Keep
  `gateway.tailscale.mode=off`.
- `plugins.entries.device-pair.config.publicUrl = wss://desktop-d8qctmg.tail572fa0.ts.net:8444`.
- Relay running (start takes ~70 s). Launched through `openclaw-relay.vbs` so it survives the
  session that started it.
- **Pairing:** run `scripts\windows\openclaw-pair-phone.ps1` yourself. It shows the setup QR (a
  credential, so it's shown only in your terminal), then approves your phone.

## Owner steps (in order)

1. Say yes to updating OpenClaw 2026.6.35 → 2026.9.5 (security fixes) before pairing anything
   real: `& "$env:LOCALAPPDATA\hermes\node\node.exe" "$env:APPDATA\npm\node_modules\openclaw\openclaw.mjs" update`.
2. Choose how the device reaches the gateway. Recommended: Tailscale Serve on a **new** port
   (e.g. `tailscale serve --https=8444 http://127.0.0.1:18789`), tailnet-only. Never 443 or
   8443 (those are the WhatsApp webhook and the OS).
3. Start the relay: `scripts\windows\openclaw-relay.ps1`.
4. Phone: install the OpenClaw Android/iOS app, connect it to the gateway URL, then on this PC
   run `openclaw devices list` and `openclaw devices approve <id>` (and `openclaw nodes approve`
   for the command surface). Mehroz's PC: install Windows Hub, choose Connections → remote
   gateway.
5. Run `bun scripts/capability-acceptance.ts --only "openclaw nodes"` to record the real device.

Keep off, always: `gateway.nodes.pairing.autoApproveCidrs`, `tools.exec.security=full`,
OpenClaw channels, ClawHub installs, `/tools/invoke` exposure.

## Research

NotebookLM notebook "OpenClaw for Jarvis" (`8016dcf7-5292-4ed2-8e1f-ab01148e7dc4`), 50 sources
(the notebook limit): the 11 installed doc pages, the GitHub repo and docs.openclaw.ai pages,
YouTube builds (mobile setup, Talk Mode, phone calls), Windows install reviews, security
coverage, Hermes-vs-OpenClaw comparisons. One irrelevant auto-imported source (a 1997 video
game) was ignored.
