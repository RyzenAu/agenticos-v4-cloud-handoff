# Mehroz: using Agentic OS from your own PC

**Status (27 Sep 2026): Mehroz's machine has NOT been tested.** Everything below was tested on
Usman's PC only: the real `/__devices` handler, two simulated companions on loopback, and a
simulated Tailscale login. Nothing has run on Mehroz's PC, no Tailscale invite has been sent,
and no Tailscale settings have been changed. The first real test happens when Mehroz connects.

## How it works

- The OS runs on Usman's PC. It is reachable only inside the private Tailscale network, at
  `https://<usman-pc>.<tailnet>.ts.net:8443`. Nothing is on the public internet.
- Tailscale proves **who** you are. Pairing a device once proves the device is **yours**. A
  paired browser stays signed in for 30 days. After that you pair it again, and you can revoke
  it any time before then.
- Picking a name on the Profile page only changes names and greetings. It never unlocks
  anything. If you pick a name that isn't yours, you get shared business data only.
- When you ask Jarvis to do something on a computer, the command goes to **your own** paired
  PC. It never runs on Usman's PC, and Usman's commands never run on yours. If your PC is
  offline, the command fails with "device offline". It is never sent anywhere else.

## Before you start (Usman's steps, needs his yes)

1. **Invite Mehroz to the tailnet:** Tailscale admin console → Users → Invite users (use
   "Invite external users" if his email is not on `muventures.com.au`). Invites expire if not
   used.
2. **Add Mehroz's Tailscale login to `.operator-data/people.json`** on Usman's PC, in Mehroz's
   `tailscale` list, e.g. `"tailscale": ["mehroz@example.com"]`. Until this is done, the OS
   refuses his requests with "Local host required".
3. **Integrate the devices track.** Make sure the `/__devices` route and the Profile page are
   in the running OS (lead patch, below). Without them, the pairing screens don't exist.
4. **Build the companion** from the merged AgenticOS repo on Usman's PC (short version: `docs/MEHROZ-ENROL.md`):
   ```powershell
   bun companion\build-exe.ts        # D:\prog-scratch\dist\mu-companion.exe + mu-companion.exe.sha256
   ```
   This makes one self-contained file of about 83 MB, so Mehroz doesn't need Bun, and a SHA-256 to read out to him. Copy it to
   Mehroz's PC, for example with `tailscale file cp mu-companion.exe <mehroz-pc>:`. The file
   is unsigned, so Windows SmartScreen will warn about it.

## Mehroz: one-time setup

### 1. Join Tailscale
1. Open the invite email and accept it. Sign in with the account it was sent to.
2. Install Tailscale for Windows from https://tailscale.com/download and sign in with that
   same account.
3. Check it works. In PowerShell, run `tailscale status`. Usman's PC should appear in the list.

### 2. Pair your browser (30 days)
1. Open `https://<usman-pc>.<tailnet>.ts.net:8443/` (Usman sends you the exact address).
2. Go to **Profile**. It says *"Tailscale says this is Mehroz"*.
3. Type a name for this device (e.g. "Mehroz's PC"), then click **Pair this device**.
4. Under **Who's using this device?**, pick **Mehroz**.

To pair another browser, like your phone: on a device that's already paired, go to
**Profile → Pair another device → Code for a browser**. Then, on the new device, go to
**Profile → With a one-time code**. The code works once and expires after 10 minutes.

### 3. Install the companion (only needed for actions on your PC)
1. On a paired browser, go to **Profile → Pair another device → Code for a companion**.
2. In PowerShell, in the folder that contains `mu-companion.exe`, run:
   ```powershell
   .\mu-companion.exe pair --hub https://<usman-pc>.<tailnet>.ts.net:8443 --code ABCD-EFGH --label "Mehroz's PC" --alias pc --alias desktop
   .\mu-companion.exe run
   ```
3. In the OS, go to **Profile → Paired devices**. It should show *"Mehroz's PC · Mehroz's
   machine · online · mic held here"*.
4. Optional: to start the companion at sign-in, use `companion\install-autostart.ps1 -Exe <path to mu-companion.exe>`
   (per user, no admin; `-DryRun` first; remove with `uninstall-autostart.ps1`).

Other companion commands:
- `.\mu-companion.exe status` shows the pairing and the days left.
- `.\mu-companion.exe forget` deletes the pairing from this PC. Revoke it in the OS as well.
- **Ctrl+C** stops the companion. The OS marks your PC offline straight away.

The companion only connects **out** to the OS over Tailscale. It opens no ports on your PC. It
refuses any address that is not a `*.ts.net` HTTPS address, a Tailscale `100.x` address, or
this PC. It saves its pairing in `%LOCALAPPDATA%\mu-companion\companion.json`, which only your
Windows account can read.

## What you can do where

| | Browser only (any paired device) | Needs the companion on your PC |
|---|---|---|
| Shared business: workspace, projects, leads, receptionist, shared memory | Yes | — |
| Your own private memory | Yes (not Usman's) | — |
| Usman's finance | No, unless Usman shares it (Profile/policy, his PC only) | — |
| Manage your sessions and devices, see who's online | Yes | — |
| Jarvis acting on **your** PC (open a link, show a notice) | — | Yes |
| Jarvis controlling **Usman's** PC | Never | Never |
| Send, pay, delete or publish | Needs **your own spoken yes** through Jarvis. A button click is not enough. | No such action is on the companion's allow-list yet |

What the companion runs (`companion/executors.ts`, all with a post-action check): `app.open`, `app.focus`, `open-url`,
`browser.navigate`, `file.open` (only `Documents\MU-Jarvis`), `deck.blank`, `notepad.type`, `observe.window` (read-only),
`screen.goal` (a compound or open-ended goal run by the same Jarvis screen loop as Usman's PC; it asks for your spoken yes
before any final button) and `echo`, `notify`, `wait`. The packaged exe has no app browser. Details: `docs/programme-20261001/worker-companion.md`.

Microphone: the companion claims this PC's microphone lock
(`%LOCALAPPDATA%\mu-companion\mic.lock`) so only one Jarvis voice process uses it. Audio never
leaves your PC. Wake-word and voice capture on the companion are **not built yet**. The lock
only makes sure your PC's mic is never controlled from Usman's PC.

## Every 30 days, and when something goes wrong

- **Session ended (30 days):** open the OS and pair again. For the companion, get a new
  companion code and run `pair` again. You'll see "pairing no longer valid" in its log.
- **Lost a device:** on another paired device, go to Profile → Paired devices → Revoke. Tick
  "require a pairing code for the next new device". Also remove the device in the Tailscale
  admin console. Removing it from Tailscale is what actually cuts off network access.
- **"device offline":** the companion isn't running, or Tailscale is disconnected. Start
  `mu-companion.exe run` and check `tailscale status`.
- **"Local host required":** your Tailscale login isn't in `people.json` yet (Usman's step 2).
- **"That code was made for someone else" / "wrong, used or expired":** make a new code. After
  five wrong codes, pairing is locked for 10 minutes.

## Not yet verified (these need Mehroz's real PC)

- Tailscale Serve adding `Tailscale-User-Login` to Mehroz's requests. This is expected for a
  user-owned device on the same tailnet. It is not guaranteed for a *tagged* device or a node
  shared in from another tailnet.
- SmartScreen/antivirus accepting the unsigned `mu-companion.exe`.
- `open-url` opening his default browser on Windows (tested only with a stubbed opener).
- Latency of the long-poll through Serve (tested only on loopback).
