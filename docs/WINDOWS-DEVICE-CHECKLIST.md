# Windows real-device checklist: Mehroz's PC

Manual steps, run by Mehroz on his own PC with Usman available on the hub. Nothing here has been run on a real Mehroz PC. Extends `docs/MEHROZ-DEVICE-TEST.md` (network setup) and follows `docs/DEVICE-TARGET-CONTRACT.md`. Use no real customer data. Capture evidence as you go (screenshots and the job log).

Before you start: Tailscale is up on the hub and on Mehroz's PC, the OS is reachable at the hub's `:8443` address, Mehroz can sign in as himself, and PowerPoint is installed on his PC (licensed, if you also want a new deck).

## 1. Pair and enrol

1. On Mehroz's PC, open the OS in his browser and sign in as Mehroz. Profile, Pair a companion, create a code.
2. In PowerShell: `mu-companion pair --hub https://<hub>.ts.net:8443 --code <CODE> --label "Mehroz's PC" --alias pc --alias desktop`.
3. `mu-companion status`, then `mu-companion run`.
   Expect: pairing succeeds; status shows owner `mehroz`; the OS device list shows "Mehroz's PC" under Mehroz only.
   Evidence: screenshot of the device list on Mehroz's login; a look at Usman's login showing it is not controllable by him.

## 2. Heartbeat

Leave `run` going for a minute.
Expect: "Mehroz's PC" online in the OS. Close the window (or `Ctrl+C`): it turns offline within about 30 s.
Evidence: two screenshots, online and offline, with times.

## 3. "Open PowerPoint here"

Signed in as Mehroz on his PC, say or type: "open PowerPoint here".
Expect: PowerPoint opens on Mehroz's PC only; Jarvis says it opened it and confirmed a window; the job shows target "Mehroz's PC" and a passed check. Usman's PC does nothing.
Evidence: screenshot of PowerPoint on his PC, the job log entry, and Usman's screen unchanged. Repeat once by voice and once typed.
Optional: "open a new PowerPoint and add a title slide Q3 plan" (needs a licensed Office).

## 4. Wrong-person refusal

- As Mehroz: "open PowerPoint on Usman's PC". Expect a refusal ("that device belongs to usman"); nothing opens on either PC.
- As Mehroz, in the OS Profile, set the shown name to Usman, then "open Notepad here". Expect it still runs on Mehroz's PC, not Usman's.
- As Usman at the hub: "open PowerPoint on Mehroz's PC". Expect a refusal.
Evidence: the spoken/typed refusal text and both screens.

## 5. Offline refusal

Stop the companion (or disable the network on his PC), wait 35 s, then as Mehroz say "open PowerPoint here".
Expect: "Mehroz's PC is offline, so nothing ran. I never send your commands to another machine." Nothing opens on the hub or anywhere.
Evidence: the spoken line, the job log (state failed, target Mehroz's PC), Usman's PC untouched. Restart the companion and confirm the same command works again.

## 6. Stop mid-command

Start something slow (a new deck on a cold PowerPoint start, or "open Notepad and type" a long line) and say "stop" immediately.
Expect: the job shows stopped or cancelled; no later success is announced. If the action had already finished, Jarvis says so plainly.
Evidence: the job log with the stop time and the final state.

## 7. No duplicates

Say "open PowerPoint here" and type the same words within 5 s.
Expect: one PowerPoint window and one job.

## What was NOT proven in cloud

- Any of the above on a real Windows PC, real Tailscale, or a real PowerPoint (the cloud run used in-process synthetic devices and fake desktop dependencies).
- That `mu-companion` survives sleep, reboot, sign-out or a Windows update; that it starts at logon.
- That Windows security prompts (UAC, SmartScreen, Office first-run dialogs, an unlicensed banner) do not block `app.open`.
- Real latency, and that the window check picks the right PowerPoint window when several are open.
- Voice end to end from Mehroz's microphone (mic ownership with a real companion).
