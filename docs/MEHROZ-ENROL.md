# Enrolling Mehroz's PC (step by step)

Background and the long troubleshooting list: `docs/MEHROZ-SETUP.md`. This page is the whole path for the day, in order.

**Status (3 Oct 2026): the hub is Ryzen-PC (server role) at `https://ryzen-pc.tailnet-name.ts.net:8443`. Tested with simulated companions and a synthetic second person. Nothing
has run on Mehroz's PC, and no remote acceptance is claimed.** The first real run is the first time anyone can say it works from his machine.

## The rule that keeps it safe

Tailscale proves **who you are**. Pairing proves **this device is yours**. A companion code binds to the person who made it, so
Usman cannot create Mehroz's code and Mehroz cannot create Usman's. After that:

| Thing | Who sees / controls it |
|---|---|
| "my PC", "here", "this computer" in a Jarvis request | **Your own paired PC only.** Mehroz's words never reach Usman's PC and Usman's never reach Mehroz's. |
| Mehroz's PC offline | The request fails with "offline". It is never sent to the other PC. |
| Device list (Profile, Paired devices) | Mehroz sees his PC as **This PC** (or **Offline**); Usman sees it by its label. |
| Business information: jobs, approvals, leads, receptionist, finance summaries | **Shared. Both of you see it.** (Older routes `/__jobs` and `/__approvals` show both founders every job, by design.) |
| Personal Jarvis desktop commands | Person-scoped. The live activity stream is per person. |

## Part 1: Usman (nothing is sent until he says so)

1. **Tailscale first.** Nothing below works until `tailscale status` on Ryzen-PC (the hub) and on Usman's PC lists peers, including `ryzen-pc`.
2. **Invite Mehroz to the tailnet:** Tailscale admin console, Users, Invite users ("Invite external users" if his email is not on
   `muventures.com.au`). Invites expire if unused.
3. **Add his Tailscale login to `people.json`** on Ryzen-PC (`"tailscale": ["<his login>"]` under Mehroz). Until then the OS says
   "Local host required" to him.
4. **The program.** Build it from the AgenticOS repo on any PC with Bun; the hash Usman reads out is the line in `mu-companion.exe.sha256`:
   ```powershell
   bun companion\build-exe.ts --out <folder>        # writes <folder>\mu-companion.exe and .sha256, prints both
   ```
   Rebuild after any companion change and read out the new hash, not an old one. About 83 MB, unsigned (SmartScreen will warn), no keys
   inside. The app-browser library is left out on purpose: apps, windows, files, PowerPoint and the screen loop are inside; goals that need
   the app browser say so.
5. **Hand the exe over yourself** (for example `tailscale file cp mu-companion.exe <mehroz-pc>:`, or a USB stick) and read the SHA-256
   to Mehroz **separately, by voice**. Do not send the hash in the same channel as the file.
6. Also copy `companion\install-autostart.ps1` and `uninstall-autostart.ps1` next to the exe if he wants it to start at sign-in.

## Part 2: Mehroz, on his own PC

### 1. Join the tailnet
1. Accept the invite email. Install Tailscale for Windows from tailscale.com/download. Sign in with **the account the invite went to**
   (never Usman's).
2. In PowerShell: `tailscale status`. `ryzen-pc` (the hub) must be in the list. If it is not, stop and tell Usman; do not try other settings.

### 2. Pair your browser (30 days)
1. Open `https://ryzen-pc.tailnet-name.ts.net:8443/`. Go to **Profile**. It must say
   "Tailscale says this is **Mehroz**". If it says anyone else, stop.
2. Name the device ("Mehroz's PC") and click **Pair this device**. It waits to be confirmed. Either Usman makes a console code **on Ryzen**
   (over ssh: `bun scripts/identity/pair-code.ts --for mehroz --port 8081`) and reads it to you to type in, or a browser that is already
   confirmed approves yours from Profile.
3. Under **Who's using this device?** pick **Mehroz**.

### 3. Make your own companion code
System › Devices, or Profile, **Pair another device**, **Code for a companion**. It is one-use and expires in 10 minutes. Make it only when you are ready to
type the next step. It must be made in **your** browser: that is what makes the PC yours.

### 4. Check the program, then pair and run
```powershell
certutil -hashfile .\mu-companion.exe SHA256        # must equal the hash Usman read out. If not, delete the file and tell Usman.
.\mu-companion.exe pair --hub https://ryzen-pc.tailnet-name.ts.net:8443 --code ABCD-EFGH --label "Mehroz's PC" --alias pc --alias desktop
.\mu-companion.exe run
```
Leave it running (Ctrl+C stops it and the OS marks the PC offline straight away). Optional start-at-sign-in (this user only, no admin):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Exe "C:\Users\<you>\mu\mu-companion.exe" -DryRun   # see what it does
powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Exe "C:\Users\<you>\mu\mu-companion.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-autostart.ps1 -Stop                                            # remove
```

### 5. Verify it is yours and only yours
1. **Profile, Paired devices:** "Mehroz's PC ... online", shown to you as **This PC**. Stop the companion: it must turn **Offline**.
2. Ask Jarvis "open Notepad on my PC". Notepad opens on **your** screen, not Usman's. (Usman should see nothing happen on his.)
3. Usman asks "open Notepad on my PC": it opens on his, not yours.
4. With your companion stopped, ask again: it must say the PC is offline, not run anywhere else.
5. Jobs, approvals and the receptionist/leads pages show the same shared business information Usman sees.
Report each of the five as seen or not seen. Until Usman has all five, this stays "not proven".

## What his PC will do

Only what he asks, on his own PC: open or focus an app, open a page, open a file from `Documents\MU-Jarvis`, start a blank PowerPoint, type a
line into a new Notepad, say which window is in front, and work out a compound goal with the same screen loop Usman's PC uses. Send, pay,
delete, publish, money and secrets are refused. Microphone, wake word and Tailscale behaviour on his machine are not proven.

## What Mehroz must NOT do

- Do not sign in to Tailscale with Usman's account, and do not accept anyone else's pairing code or give yours to anyone. Never paste a
  code, cookie or key into a chat.
- Do not pick **Usman** under "Who's using this device?". Picking another name only changes greetings and gives shared data only; it
  never unlocks Usman's PC.
- Do not change Tailscale settings: no `tailscale up` with flags, no exit node, no subnet routes, no Funnel, no ACL or admin-console edits.
- Do not run the program as Administrator, install it machine-wide, open a firewall port or forward a router port. It only connects out.
- Do not run an exe whose SHA-256 does not match, or one that arrived by the same channel as its hash.
- Do not use `.\mu-companion.exe forget` without also revoking the device in the OS (Profile, Paired devices).
- Do not run the companion on a shared or borrowed PC.

## If something is off

`.\mu-companion.exe status` shows the pairing and worker version; the log is `%LOCALAPPDATA%\mu-companion\companion.log` when started by the
sign-in entry. A revoked or expired pairing stops the companion for good (exit code 3): make a new code and pair again. A companion that was
paired against Usman's main PC before the 2 Oct cutover must be re-paired once against Ryzen-PC; the old pairing does not carry over.
