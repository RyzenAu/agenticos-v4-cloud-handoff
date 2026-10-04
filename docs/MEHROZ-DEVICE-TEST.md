# Mehroz's PC: device test (Track 2, 28 Sep 2026)

This is the test script for Jarvis acting on **Mehroz's own PC** through the companion, using
Mehroz's own browser. Follow the steps in order. Every step lists the expected result and where
to find the evidence.

**What has actually been tested so far**

| What | Where | Label |
|---|---|---|
| All companion routing, cancel, offline and mic logic: an in-process hub, two companions (Mehroz's PC and Usman's laptop), fake Tailscale headers and a fake desktop (`scripts/devices/companion-executors.test.ts`, `companion/companion.test.ts`, `scripts/executors/windows.test.ts`) | Usman's PC | SYNTHETIC |
| `notepad.type` for real: its own new Untitled Notepad window, the line "M&U Track 2 test line synthetic" typed, read back through UI Automation and matched exactly, never saved (11.6 s) | Usman's PC | REAL |
| `open-url https://example.com` for real: verified by a Chrome window titled "Example Domain - Google Chrome" (18.3 s) | Usman's PC | REAL |
| `deck.blank` for real: **failed**. PowerPoint on Usman's PC is an *Unlicensed Product* and refuses `Presentations.Add` (`Exception from HRESULT: 0x80048240`). The executor reports that plainly. | Usman's PC | REAL (blocked by licence) |
| The hub path end to end (command service → Job → Jarvis entry → the same executors): `bun scripts/jarvis-command/real-device-check.ts --run` — Notepad line typed and read back (44 chars) ✔, example.com in the app-owned browser ✔, new PowerPoint ✘ (Unlicensed Product) | Usman's PC | REAL |
| Anything on Mehroz's PC, over a real tailnet | none | **NOT TESTED** |

Steps marked **(SYNTHETIC only)** have only been run with the simulated hub. Nothing in this
document has run on Mehroz's PC yet.

---

## Part A. Before Mehroz can test: owner actions on the hub (Usman)

**Read-only diagnosis, 28 Sep 2026 ~13:00 AEST** (nothing was changed):

- `tailscale status` printed *"unexpected state: NoState"*, *"Tailscale is starting"* and
  *"Unable to connect to the Tailscale coordination server"*. The tray app (`tailscale-ipn`)
  wasn't running.
- `tailscale serve status` printed *"No serve config"*, so `:8443` (the OS for Mehroz) and
  `:8444` (the OpenClaw bridge for the iPhone) are both unreachable.
- Cloudflare WARP is **connected**: the `CloudflareWARP` service ("Cloudflare One Client") is
  Running/Automatic, `warp-cli status` says *"Connected, Network: healthy"*, and the
  `CloudflareWARP` adapter is Up. `WindscribeService` and `TunnelBearMaintenance` are also
  running. The TunnelBear adapter is disconnected. WARP capturing traffic to Tailscale's
  coordination server is the likely conflict.
- Listeners: only `127.0.0.1:8081` (the OS). Nothing is on `127.0.0.1:18789`, so the OpenClaw
  relay is down.
- The services audit (`MU-Workspace/memory/master-v3/AUDIT-A4-SERVICES.md`, risks 4 and 8)
  found the same thing.

Run these in **PowerShell** on the hub. They change network settings, so Usman does them himself.

1. **Take WARP out of Tailscale's way.** For today's test, click the Cloudflare One tray icon
   and choose Disconnect, or run `warp-cli disconnect`. For a lasting fix, in Cloudflare Zero
   Trust add split-tunnel **Exclude** entries for `100.64.0.0/10`, `fd7a:115c:a1e0::/48` and
   the host `*.tailscale.com`, and leave Windscribe/TunnelBear disconnected while testing.
   *Verify:* `warp-cli status` says Disconnected, or the excludes appear under
   `warp-cli settings`.
2. **Bring Tailscale up.** Start "Tailscale" from the Start menu (the tray app), or run
   `tailscale up`, and sign in as the owner account.
   *Verify:* `tailscale status` lists peers with no health warning, `tailscale ip -4` prints a
   `100.x` address, and `(tailscale status --json | ConvertFrom-Json).BackendState` is `Running`.
3. **Re-apply the OS on :8443 (tailnet only; never 443 or Funnel).**
   `tailscale serve --bg --https=8443 http://127.0.0.1:8081`
   *Verify:* `tailscale serve status` shows
   `https://desktop-d8qctmg.tailnet-name.ts.net:8443 (tailnet only)` proxying to
   `http://127.0.0.1:8081`. Use your own `Self.DNSName` from `tailscale status --json` if it
   differs. Then open that address on your phone over Tailscale: the OS loads.
4. **(Only for the iPhone bridge; Mehroz's test doesn't need it.) OpenClaw relay and :8444.**
   From `C:\Users\Nebula PC\source\repos\AgenticOS-v4`, run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\openclaw-relay.ps1`
   then `tailscale serve --bg --https=8444 http://127.0.0.1:18789`.
   To start it at sign-in, put a shortcut to `scripts\windows\openclaw-relay.vbs` in
   `shell:startup`.
   *Verify:* `Get-NetTCPConnection -LocalPort 18789 -State Listen` shows `127.0.0.1`, and
   `tailscale serve status` lists `:8444`. After the next sign-in, check the listener again.
5. **Mehroz on the tailnet and in people.json.** Invite him in the Tailscale admin console
   (Users → Invite). Add his Tailscale login to his `tailscale` list in
   `.operator-data/people.json` on the hub.
   *Verify:* his PC appears in `tailscale status`. Remember that a peer showing RxBytes ≈ 0 is
   a client-side problem, as it was with the iPhone.
6. **Run the build that contains Track 2** (branch `f/t2-jarvis-20260928` once the lead has
   merged and wired it). Deploying it is Usman's call.
   *Verify:* `GET /__version` on 8081 shows the merged commit.

---

## Part B. Mehroz's one-time setup (on HIS PC)

**Prerequisites:** Tailscale installed and signed in as **himself**, with Usman's PC listed in
`tailscale status`; his login in the hub's `people.json` (A5); a checkout of the AgenticOS repo
on the branch the lead names; and Bun (`powershell -c "irm bun.sh/install.ps1 | iex"`, or
`npm i -g bun`), then `bun install` in the checkout. `bun build --compile companion/main.ts
--outfile mu-companion.exe` also works if he'd rather not keep a checkout.

1. **Pair his browser (remembered 30 days).** Open `https://<hub>.ts.net:8443/`, go to
   **/system → Devices and people**, type a device name (e.g. "Mehroz's PC") and click **Pair
   this device**. Under *Who's using this device?*, pick Mehroz.
   *Expected:* *This device* shows a session expiring in about 30 days.
   *Evidence:* the Browsers list under Paired devices.
2. **Check it survives a browser restart.** Close every browser window (check Task Manager
   shows no browser left), reopen the same address and go to /system.
   *Expected:* still signed in as Mehroz with the same session. No new pairing is asked for.
3. **Make a companion code.** In **Pair another device**, click **Code for a companion**. The
   code is valid for 10 minutes. Treat it as a credential: don't paste it in chat.
4. **Pair the companion.** In PowerShell, in the repo checkout, run:
   `bun companion/main.ts pair --hub https://<hub>.ts.net:8443 --code ABCD-EFGH --label "Mehroz's PC" --alias pc --alias desktop`
   Add `--root D:\Some\Folder` to authorise a different folder. The default is
   `%USERPROFILE%\Documents\MU-Jarvis`, which pairing creates.
   *Expected:* `Paired "Mehroz's PC" (mehroz-…) for mehroz. Valid until …`, followed by the
   folder list.
5. **Run it.** `bun companion/main.ts run`
   *Expected:* `Companion for mehroz starting. Files it may open: …`, then
   `online as mehroz-… (mehroz)`. `bun companion/main.ts status` (in a second window) shows
   the days left, the folders, and "Microphone held by pid …".
6. **What the OS shows.** In /system → Devices and people:
   - *Who's online:* Mehroz online, `1/1 machines up`.
   - *Paired devices → Machines Jarvis can act on:* "Mehroz's PC · … · online · mic held here".
   *(Mic reporting: SYNTHETIC only. The heartbeat carries `micOwned`, and
   `registry.micOwner("mehroz")` follows claim and release.)*
7. **Test file.** Put a harmless file in the authorised folder, e.g.
   `Documents\MU-Jarvis\mehroz-test-note.txt`. Add no other file with that name.

---

## Part C. The tests (typed or spoken from HIS browser)

Type each line into the Jarvis command box, or say it. Both use the same entry,
`POST /__operator/screen/command`. **Evidence** for every step:
- **/work**: the job log. Open the job and check *target device* = his `mehroz-…` id, the
  decision, the step `companion <executor> (<id>): <line>` and its verification.
- **`/__jobs?limit=5`** in the same browser: `targetDeviceId`, `state`, and each step's
  `verification` (`method: "companion-check"`, `ok: true|false|null`).
- The companion window, which logs refusals and cancellations.

| # | He types or says | Expected | Evidence | Tested |
|---|---|---|---|---|
| C1 | `open Notepad and type 'hello from Mehroz'` | A **new** Notepad window opens on HIS PC. The line is typed and read back. Jarvis says *"Typed it into a new Notepad document and read it back. It isn't saved."* Nothing is saved. His other Notepad tabs are untouched. | Job `succeeded`, target `mehroz-…`, step verification `ok: true`, evidence "UIA read-back matched 17 chars exactly" | SYNTHETIC over the wire. The executor is REAL on Usman's PC |
| C2 | `open a new PowerPoint with the title 'Mehroz test'` | A new, unsaved presentation with one title slide saying "Mehroz test". Jarvis names it (e.g. Presentation1). If his Office is unlicensed he gets that exact reason instead. | Job verification `ok: true`, evidence "PowerPoint reads back 1 slide, title layout, title matches, not saved" | SYNTHETIC. REAL is blocked on Usman's PC by the Unlicensed PowerPoint |
| C3 | `open https://example.com` | His **default** browser opens example.com. It's verified only if a browser window titled "Example Domain" appears. Otherwise Jarvis says it couldn't confirm it, and never claims it is showing. | Verification `ok: true` (or `null` with "can't confirm") | SYNTHETIC over the wire. The executor is REAL on Usman's PC |
| C4 | `open Notepad` | A new Notepad window, confirmed by its window appearing. | Verification `ok: true`, evidence "a new Notepad window appeared" | SYNTHETIC |
| C5 | `open the file mehroz-test-note.txt` | It opens in its default app, confirmed by a window titled with its name. A second file with the same name makes Jarvis ask "Which one?". `setup.exe`, `*.ps1` or `.env` are refused. Anything outside `Documents\MU-Jarvis` isn't found. | Verification `ok: true`, evidence names the window | SYNTHETIC (the `file.open` rule is in `plan.ts` since 4a7365c) |
| C6 | `open Notepad on Usman's PC` | **Refused.** *"Not done: that device belongs to usman; you can only run commands on your own devices. Nothing ran on any other machine."* Nothing opens on either PC. | Job `failed`/refused, decision `device.choose`, no companion step | SYNTHETIC |
| C7 | While Usman, at the hub, runs `open Notepad and type 'hello from Usman'`, Mehroz runs C1 at the same time | Both finish, each on their own machine: Usman's line only on Usman's PC, Mehroz's only on Mehroz's. Neither waits for or sees the other. | Two jobs, targets `usman-pc` and `mehroz-…` | SYNTHETIC (two companions in flight at once, no cross-talk) |
| C8 | Start C2 with PowerPoint closed (a cold start takes 10 s or more), then press **Stop** (or say "stop") as soon as the pill says "On Mehroz's PC: starting a new PowerPoint…" | Jarvis says *"Stopped."* The companion logs `cancelling …`. No success is reported. PowerPoint may still show a blank, unsaved presentation if its own COM call was already under way. That's harmless: close it without saving. | Job `cancelled`, step outcome `cancelled` | SYNTHETIC (cancel through the job's signal stops the PowerShell/COM run in under 2 s) |
| C9 | Start C2 again, then **stop Tailscale on his PC** (tray → Disconnect) mid-command | The companion goes offline and stops the running command itself (fail closed). The hub notices about 30 s later, and Jarvis says *"Mehroz's PC went offline, so it didn't finish there. Nothing ran anywhere else."* It never runs on Usman's PC. Reconnect Tailscale: the companion comes back online on its own (backoff 10/20/30 s) and **nothing from before runs**. | Job `failed` with reason `device offline`, naming his device; no hub step | SYNTHETIC |
| C10 | Usman or Mehroz: /system → Paired devices → **Revoke** "Mehroz's PC" | The companion prints *"This PC's pairing was revoked or has expired. Stopped."* and exits (code 3). A new command from Mehroz is refused with "no device registered" or "device offline", and is never routed to the hub. | Paired devices shows it revoked. `bun companion/main.ts run` exits at once | SYNTHETIC |

After C10, finish the rollback in Part D.

---

## Part D. Rollback

1. On Mehroz's PC: stop the companion (Ctrl+C, which says goodbye so the OS marks it offline at
   once), then run `bun companion/main.ts forget`. This deletes
   `%LOCALAPPDATA%\mu-companion\companion.json`.
2. In the OS: revoke "Mehroz's PC" under Paired devices (if not done in C10). Optionally
   revoke his browser session under Browsers.
3. Close the Notepad windows and the PowerPoint presentation the tests opened **without
   saving**. Delete `Documents\MU-Jarvis\mehroz-test-note.txt` if he wants.
4. Hub, if Usman wants it: `tailscale serve --https=8443 off` takes the OS off the tailnet.
   Reconnect WARP only after deciding on the split-tunnel excludes in A1.

## Safety notes (in code, whatever is said)

- The companion runs only what's on its allow-list (`echo`, `notify`, `wait`, `open-url`, and on
  Windows also `app.open`, `file.open`, `deck.blank` and `notepad.type`). It runs one command at
  a time, and only commands addressed to Mehroz.
- `app.open`: only Notepad, Calculator, PowerPoint, Excel, Word, Chrome, Edge, File Explorer,
  VS Code and Paint.
- `notepad.type` never saves. It refuses text that names secrets, keys, passwords, money
  movement or banks, text with six or more digits in a row, and text over 200 characters.
- `open-url`: plain http(s) only. It refuses links with a login or a token-like parameter, and
  bank, broker, exchange and payment sites.
- Nothing is saved, sent, paid, deleted or published by any of these executors.

## Backlog (lead decisions, 28 Sep, REVIEW-T2)

- **Device commands from a program stay allowed** (REVIEW-T2 #7): a local program at the hub (loopback, no
  browser session, e.g. Hermes) can start a device command on Usman's PC, and a tailnet request with no
  session (Mehroz's own scripts) can start one on Mehroz's companion. This matches `/screen/act` and
  `/__devices/commands` and the owner's "no routine prompts" rule. Revisit only if the owner wants no
  device action without a human session (gate the device lanes on `isHumanSession`).
- **Cancel may stop any job** (REVIEW-T2 #8): `/screen/command/cancel` reaches any job id, as
  `/__jobs/<id>/cancel` does, per the shared workspace (V7). The job log records who stopped it.
- **Open:** a yes to a final-button question asked by a TYPED command has no typed confirm path yet
  (spoken yes works through the screen gate); thresholds' `act` value is still read from
  `JEV_CONTROL_ACT` inside `routeDesktopCommand` (latent while both are 0.6); the companion's open-url
  title check re-fetches the page (skip it for loopback/private hosts).
