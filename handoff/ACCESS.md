# Dot's access to the running app

Dot reaches AgenticOS only through the reviewed gateway, with its own revocable identity. The raw Ryzen hub stays private
to the tailnet, and native account credentials (models, mail, payments, coding accounts) stay on the hub. Full reference:
`gateway/DOT-ACCESS.md` (enrolment, renewal, revocation, the operating API, the capability matrix, proof steps, switch-over).

## Where things stand (4 Oct 2026, 17:50 AEDT)

| Item | State |
|---|---|
| Access URL | `https://ryzen-pc.tail572fa0.ts.net/` (Tailscale Funnel, port 443). Today it reaches the **staging** pair: a synthetic hub (fake records only) and the gateway in front of it, both revision `09410ed7` of the gateway branch |
| Production | Not reachable through the gateway yet. The switch-over (`gateway/DOT-ACCESS.md` §13) runs after Dot's staging proof passes; the production gateway will listen on 127.0.0.1:8092 |
| Gateway source | Branch `r11/gateway-20261004` in the lead's working repository (on top of production `82d6962d`). It is not in this baseline because it is not in production yet; it is published here with the production release |
| Review | One security review: one blocker (the raw job log exposed founders' words to `ops.read`), fixed in `09410ed7`; 137 gateway tests pass; non-blocking notes are in `gateway/DOT-ACCESS.md` §14 |
| Staging identities | None. Every earlier staging identity, grant and code was revoked before this was published |

## Enrolment (secure route)

1. Dot tells the owner it is ready to sign in (an unused code only absorbs wrong guesses).
2. The owner mints a one-time code on the hub's console (staging: `dot-gateway-staging.ps1 -Action mint-code`; production:
   `bun scripts/gateway/cli.ts enrol-code --by usman --label "Dot"`). Single use, 10 minutes, burned after 20 wrong guesses,
   stored only as a hash.
3. The owner hands the code to Dot directly, out of band. It never appears in this repository, a pull request, a chat log,
   a ticket or a URL query string.
4. Dot redeems it at `/gw/enrol` (browser) or `POST /gw/enrol` with `"mode": "bearer"` (program). The response shows a
   **reconnect key once**: Dot stores it in its own secret store.
5. A new identity can only look (`view`). The owner grants the working set with `grant operate --by usman --hours <n>`.

## Reconnecting in a new task, and renewing

`POST /gw/renew` with the reconnect key (`gateway/DOT-ACCESS.md` §4). Access tokens are short-lived (idle 2 h, absolute
12 h); the reconnect key lasts until the identity expires (30 days by default) or is revoked. `401 "revoked"`: stop and ask
the owner. `401 "expired"` or `"idle"`: renew. Identity expired: the owner enrols Dot again.

## Capabilities

`grant operate` gives: `crm.read`, `crm.write`, `files.read`, `files.write`, `tasks.run`, `memory.read`, `memory.write`,
`coding.start`, `bots.operate`, `ops.read`. Not included: `bots.terminal` (granted separately, the owner's call).

| Feature | State on staging today |
|---|---|
| Sign in, reconnect, renew, logout; identity listed and revocable | working |
| Health, version, OS pages (read-only UI), coding job reads | working (`view`) |
| CRM read and reversible write (drafts only; sending, quotes, invoices, won deals refused) | missing authorisation until granted |
| Files in approved roots (drafts, designs); no delete | missing authorisation until granted |
| Jarvis tasks through Jev, own jobs, Stop own jobs | missing authorisation until granted |
| Diagnostics, release receipts, action log, job log (founders' jobs as shape only) | missing authorisation until granted |
| Memory recall | missing authorisation; memory is off on staging |
| Memory saving | owner action (`MU_MEMORY_WRITES=on`) |
| Coding jobs of its own | owner action (add `dot` to a repository's `allowedPeople`); staging has no repositories |
| Shared bot computers | missing authorisation; staging has no bots, so the honest answer is an empty list |
| Bot terminal | owner action |
| Sending, quotes and invoices, merges, releases, approvals, founders' desktops, mail, finance, receptionist data, accounts | unsupported or owner action, by design |

## What Dot proves, in order

From its own cloud environment, against the staging URL first: the seven steps in `gateway/DOT-ACCESS.md` §11 (push a
harmless branch from this baseline; sign in from its real browser; read and reversibly update a synthetic record; start a
harmless job and read its result; the shared-bot answer; the operations workflow; limits hold and revocation is immediate).
Record method, path, status and a summary for each, never a code, key, token, cookie or body. Then the lead and owner run
the production switch-over and Dot repeats the proof against production.

Access is **not complete** until Dot has signed in from its own browser and the production switch-over is done.
