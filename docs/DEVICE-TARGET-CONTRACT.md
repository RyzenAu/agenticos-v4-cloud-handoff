# Device target contract: Mehroz's enrolled PC

What must be true for "open PowerPoint here" from Mehroz to run on Mehroz's own Windows PC, and nowhere else.
Code: `scripts/devices/route.ts` (resolveTarget), `scripts/devices/dispatch.ts` (Dispatcher),
`scripts/identity/principal.ts` (who is asking), `companion/executors.ts` (what the PC allows),
`scripts/jarvis-command/service.ts` (the one command path).

## The shape

- Separate logins. Usman and Mehroz each sign in as themselves. The business workspace (leads, jobs, memory, the OS pages) is shared.
- Devices are per person. Usman's PC is the hub (`kind: "hub"`, owner `usman`). Mehroz's PC is a companion (`kind: "companion"`, owner `mehroz`).
- Mehroz's PC is enrolled by Mehroz's own paired session: he creates a pairing code from his own signed-in browser and redeems it on his PC with `mu-companion pair`. Usman cannot enrol a device for him, and the code binds to the person who issued it.
- A device has an id, an owner, a label ("Mehroz's PC") and aliases (`pc`, `computer`, `desktop`). Aliases only help pick among the caller's OWN devices.

## What authorises control of a device

All of these, together:

1. A verified principal from `resolvePrincipal` (loopback owner at the hub, a paired session, or a Serve-verified Tailscale login listed in `people.json`). The service reads `principal.personId`; nothing in the request body is read for identity.
2. `device.owner === principal.personId`. `resolveTarget` filters to the caller's own devices first.
3. For a companion, its bearer token AND the Tailscale login it arrives with both match the device's owner (`identifyCompanion`). A revoked or expired pairing is not a device.
4. The companion re-checks locally: the command's `personId` must equal the PC's owner, the executor must be on its allow-list (`gate`), and a risky action needs an approval naming this owner.

## What never authorises control

- A display name, the `mu_name` cookie, or "showing as Usman". These are personalisation only.
- `spokenTarget` naming a person or a device ("on Usman's PC", a device id). Naming someone else's device is refused, and a name that matches only someone else's device is refused.
- Body fields: `personId`, `deviceId`, `originDeviceId` in a request body are ignored. The service derives the origin itself (hub at loopback, the companion's own device, or the person's mic-owner companion). An origin that is not the caller's device is refused.
- Being on the same tailnet, or the hub being online.

## "here", "this pc", "this computer"

The device the request came from (its origin), else that person's own primary or only device. Never another person's, never the hub for a non-owner. Several online devices with no primary: Jarvis asks which.

## Offline and failure

- The chosen device offline (no heartbeat inside 30 s, or it said goodbye): the command fails with "device offline", is spoken as such, and nothing runs on any other machine. There is no fallback and no later replay.
- A command queued when the device drops fails at once. A command that arrives after the companion decided it is offline never runs.
- Stop cancels a queued or running command through the job service; the result is "cancelled", never a late success.
- A result counts as done only when the executor's own check passed (`verified: true`); otherwise Jarvis says it could not confirm.

## Risky actions

Send, pay, delete, publish need an approval from the same person's spoken yes (under two minutes old). It is checked at the dispatcher and again on the PC. A click, a typed box or a model's text is not a spoken yes. The default companion allow-list has no such executor, so they are refused outright today.

## No duplicate actions

`Dispatcher.submit` takes an optional `commandKey`. The same key from the same person with the same executor and args, while queued or running, or finished OK within 5 s, returns the same command's result and queues nothing. Failed or cancelled commands are retried. The command service also attaches an identical utterance from the same person within 5 s to the job that is running or just finished OK, instead of starting another. Answers to a question (yes, no) and payment turns are never merged.

## Synthetic vs real

| Piece | Status in cloud |
|---|---|
| Routing, ownership, "here", offline, cancel, dedupe, approval rules | Proven with in-process fixtures (`scripts/devices/synthetic.ts`, ids and labels say SYNTHETIC) and the real Dispatcher, resolveTarget, gate, command service and job store |
| Pairing over HTTP, heartbeat, long-poll | Proven only against a loopback hub with fake Tailscale headers (`scripts/devices/companion*.test.ts`) |
| Windows executors (`app.open`, `deck.blank`) | Registered and gated; run only against fake desktop dependencies |
| A real Mehroz PC, Tailscale, PowerPoint, licence, the companion service surviving reboot | NOT proven. Use `docs/WINDOWS-DEVICE-CHECKLIST.md` |

Known real-world blocker from 28 Sep: PowerPoint on Usman's PC was an unlicensed product and refused to create a presentation. "Open PowerPoint" (`app.open`) only launches and checks for a window; a new deck (`deck.blank`) needs a licensed Office.
