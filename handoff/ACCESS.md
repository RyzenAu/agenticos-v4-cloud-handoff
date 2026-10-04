# Dot's access to the running app

Dot reaches AgenticOS only through the reviewed gateway, with its own revocable identity. The raw Ryzen hub stays private
to the tailnet, and native account credentials (models, mail, payments, coding accounts) stay on the hub. Full reference:
`gateway/DOT-ACCESS.md` (enrolment, renewal, revocation, the operating API, the capability matrix, proof steps, switch-over).

## Where things stand (4 Oct 2026, 19:35 AEDT)

| Item | State |
|---|---|
| Access URL | `https://ryzen-pc.tail572fa0.ts.net/` (Tailscale Funnel, port 443). Today it reaches the **staging** pair: a synthetic hub (fake records only) and the gateway in front of it, both revision `971ee78a` of the gateway branch (staging export `C:\mu-hub\dot-gateway-staging\app-971ee78a1341`, started with `-Operate -Memory`) |
| Production | Not reachable through the gateway yet. The switch-over (`gateway/DOT-ACCESS.md` §13) runs after Dot's staging proof passes; the production gateway will listen on 127.0.0.1:8092 |
| Gateway source | Branch `r11/gateway-20261004` in the lead's working repository (on top of production `82d6962d`). It is not in this baseline because it is not in production yet; it is published here with the production release |
| Review | Two security reviews. Blockers fixed: the raw job log exposed founders' words (`09410ed7`); a release request wrote Dot's bundle into the live repository before approval (`971ee78a`). 161 gateway tests pass. Notes in `gateway/DOT-ACCESS.md` §14 |
| Staging identity | Dot enrolled by Usman at 18:34 (identity `2e41160d…`, expires 3 Nov); signed in from its own browser |

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

`grant operate --by usman --until-identity` gives, for as long as the identity lasts (30 days max; renew with `cli renew --by
usman` or the **Renew 30 days** button in System › Devices and people; `/gw/me` shows `renewSoon` 7 days ahead):
`crm.read`, `crm.write`, `finance.read`, `finance.write`, `mail.read`, `mail.draft`, `files.read`, `files.write`, `tasks.run`,
`memory.read`, `memory.write`, `coding.start`, `bots.operate`, `ops.read`, `release.request`. Not included: `bots.terminal`
(the R9-OPS isolation condition, a VM or own loopback per bot, is not met today). The full matrix with one reason per
restriction is `gateway/DOT-ACCESS.md` §10.

Still founders' only, each for one stated reason: issuing a document to a client (a send); recording a message as sent
(only the provider can attest it); loosening contact permissions (it authorises future outbound contact: consent and the Spam
Act); statement imports and vendor rules (they reach personal finance rows); approvals; founders' devices; coding accounts.
Genuinely absent from the hub: creating a draft inside Gmail itself (drafts are saved in the OS), finance notes and single
manual records, recording an invoice match (suggestions only).

Releases: Dot sends a bundle and commit to `POST /__gateway/release`; nothing touches the live checkout until Usman approves
by Telegram code or spoken yes; then the backed-up release runs with automatic rollback (`gateway/DOT-ACCESS.md` §9). Needs
`MU_GATEWAY_RELEASES=1` on the production hub; off on staging.

## What Dot proves, in order

From its own cloud environment, against the staging URL first: the seven steps in `gateway/DOT-ACCESS.md` §11 (push a
harmless branch from this baseline; sign in from its real browser; read and reversibly update a synthetic record; start a
harmless job and read its result; the shared-bot answer; the operations workflow; limits hold and revocation is immediate).
Record method, path, status and a summary for each, never a code, key, token, cookie or body. Then the lead and owner run
the production switch-over and Dot repeats the proof against production.

Access is **not complete** until Dot has signed in from its own browser and the production switch-over is done.
