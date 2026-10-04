# Dot gateway: design

Status: **implemented and proven locally on branch `gw/dot-gateway-20261002`; revised 3 Oct 2026 after the independent
security review (section 14). Nothing is deployed or exposed.**

**r11 (4 Oct 2026, branch `r11/gateway-20261004`): superseded in part.** Dot now has its own revocable identity (a reconnect
key renewing short-lived cookie or bearer access) and operating capabilities (CRM, files, tasks, memory, coding, shared bots,
diagnostics) through capability-checked `/__gateway` routes; `/__jobs` moved from `view` to `ops.read`; the dead
`/__operator/coding` and `/__computers` write rules were replaced by `/__gateway/coding` and `/__gateway/bots`. The current
reference for Dot, the capability matrix and the production switch-over is `docs/gateway/DOT-ACCESS.md`. Sections below
describe the reviewed read-only base, which is unchanged where DOT-ACCESS.md does not say otherwise.
Code: `scripts/gateway/**`, `deploy/windows/gateway/**`. Dot's browser checklist: `DOT-GATEWAY-CHECKLIST.md`.

## 1. The problem

Dot is an external collaborator: an AI agent operating a real browser in its own cloud. It cannot join the tailnet, has no
proxy controls and no persistent VPN, cannot use passkeys or hardware keys, but keeps cookies within a browser session and
can be handed a one-time code. The hub (Bun + Vite dev server) runs on Ryzen-PC at `127.0.0.1:8081` with
`MU_HUB_ROLE=server`, reachable only through Tailscale Serve (tailnet only). Dot needs ONE public HTTPS URL that lets it
use the OS, read-only first, with scoped, audited writes later, without weakening anything the founders rely on.

## 2. Recommendation (one)

**A separate gateway process on Ryzen, loopback only, behind Tailscale Funnel on 443, with its own sign-in, its own session,
default-deny capabilities, and a per-request signed assertion to the hub, which maps it to a new non-founder principal.**

```
Dot's browser ──TLS──> Tailscale Funnel :443 ──> 127.0.0.1:8090 gateway ──signed assertion, /__ API only──> 127.0.0.1:8081 hub
                       (staging: 8096 -> 8086)       │
                                                     └── serves the UI ITSELF from a built bundle (exact file manifest)
```

**Dot never reaches the dev server's file serving.** The hub is a Vite dev server: `/@id`, `/@fs`, `/@vite`, `/src`,
`/node_modules` and `?raw`/`?url`/`?import` transform queries can read any file under Vite's allowed folders (the whole
checkout). So the gateway forwards ONLY the allow-listed `/__*` API and stream routes. The UI's pages and files come from
a built client bundle the gateway serves itself (section 4a); every other path is 404 at the gateway, and the hub refuses
any non-`/__` path from the gateway principal as a second line.

Why this shape, after reading the code:

- **The hub's trust model must not move.** Today a Serve-relayed request is trusted because tailscaled stamped
  `Tailscale-User-Login` and the socket's peer is tailscaled (`scripts/identity/serve-peer.ts`). Funnel traffic also
  arrives through tailscaled on loopback. Pointing Funnel at the hub itself would put internet traffic one bug away from
  that trust path. Pointing Funnel at a separate port whose process never speaks Tailscale identity keeps the two apart:
  the hub's 8081 stays tailnet-only and the gateway never fabricates or forwards a Tailscale header.
- **The hub is a dev server with ~140 `/__*` mounts written for two founders.** A separate process can rebuild every
  request from an allow-list (headers, routes, methods) instead of trusting each handler to cope with a third kind of caller.
- **One fixed upstream.** The gateway is started with the hub's loopback address (refused unless it is loopback http with
  no path). No part of a request chooses a destination; it is not a proxy in the open-proxy sense.
- **Defence in depth.** The same capability table is enforced at the gateway AND at the hub's identity gate for the
  principal the assertion names, and the one write route checks the capability a third time.

Challenged and rejected:

- *Funnel straight to the hub with a new auth path in the gate*: one process, but internet traffic would share the
  socket-peer-is-tailscaled path the founders' identity depends on, and every hub route would be internet-facing.
- *Re-using founder pairing for Dot*: Dot is not a founder; `people.json`/`PERSON_IDS` are the two founders and many
  checks treat "a verified person" as full shared access (V7). A new principal that fails every founder check is safer.
- *A fake Tailscale identity for Dot from the gateway*: exactly what a username header attack looks like; banned.

## 3. Identity mapping

| | Founder (unchanged) | Dot (new) |
|---|---|---|
| Proof at the edge | Tailscale identity via Serve + session cookie + console pairing code | one-time founder-minted code at `/gw/enrol`, then a gateway session cookie |
| Proof at the hub | Serve-stamped login, socket peer is tailscaled, `mu_session` | `X-MU-Gateway-Assertion` HMAC verified on a loopback socket, gateway `Via`, no Tailscale header |
| Principal | `{ personId: "usman"/"mehroz", via: "paired-session"/"tailnet-person"/"loopback-owner", ... }` | `{ personId: "dot", via: "gateway", actor: "process", sessionId: "gw:<id>", displayName: "Dot", capabilities, delegatedBy }` |

- `scripts/gateway/hub.ts` `createGatewayTrust().screen(req)` runs FIRST in the identity gate. No assertion header: returns
  null and nothing changes (founders, pairing, the local-owner proof and every existing test are untouched; the 282
  identity tests pass unchanged except the two rows added for the new `/__gateway` route). An assertion header that does
  not verify, or trust that is off, or the KILL file: refused outright (401/503), never falls through to another identity.
- A verified assertion marks the request (a WeakMap in `principal.ts`, like the existing `markLoopbackUnproven`):
  `identifyRequest` returns the gateway principal and nothing else. The gateway always sends `Via: 1.1 mu-dot-gateway`,
  which is a relay header, so a gateway request is never "at this PC" in any role.
- **Never a founder, never owner, never at-hub**: `"dot"` is deliberately not a `PersonId`; it rides the founder-typed
  field so every `isPersonId`, `=== "usman"`, `=== "mehroz"` check fails closed. `isAtHub` false, `requestAtHub` false,
  `refuseUnlessAtThisPc` 403, `isHumanSession` false (actor `process`, so B2 approvals can never be decided by Dot even if a
  table were wrong), `isPrincipal` (B2) false, `devicesPrincipal` null (no devices, pairing or computers identity).
  `isBrowserPrincipal` is true so the UI's read APIs answer, which is safe only because the gate has already held the
  request to the capability table.
- **Trust is opt-in on the hub**: `MU_GATEWAY_TRUST=1`. A hub started without it refuses every assertion.
- **Founder sign-in and pairing are untouched**: no change to `serve-peer.ts`, `remote-access.ts`, `devices/service.ts`,
  `server-role.ts`, `local-owner-token.ts` or the pairing page. Dot cannot reach `/__devices` or `/__token` at all.

### Gateway to hub trust

- Key: `MU_DATA_DIR/gateway/hub-assertion.key`, 32 random bytes, created by whichever of the hub and the gateway starts
  first with the local-owner token's protection (`writeProtectedSecret`/`tokenFileProtected`: the hub's account, SYSTEM,
  Administrators; re-verified whenever the file changes). Never logged, printed or returned.
- Assertion: `v1.<base64url(claims)>.<HMAC-SHA256>` over `{ m: method, p: path+query exactly as sent, sid: gateway session
  id, sub: "dot", caps, ts, n: 128-bit nonce, by: delegating founder }`. Hub checks: loopback socket, gateway `Via`, no
  `tailscale-*` header, signature, method and target equal the actual request, |now - ts| <= 30 s, nonce unseen (bounded
  cache, fails closed when full), every capability known. Then the capability table, then the route class must be
  `shared`. The assertion, cookies, `Authorization` and any browser-sent `X-Claude-OS-Token` are removed; a write is
  handed Dot's own derived page token (`pageTokenFor`, never the internal token).
- WebSocket upgrades never pass the connect gate, so `screenUpgrade(req)` is exported for an upgrade handler to call.

## 4. Capabilities and the route table

`scripts/gateway/policy.ts` (one table, used by both sides). Default deny; exact, case-sensitive paths; `*` = one plain
segment, `/**` = the route and anything below it (plain segments only). `view` is every valid session's; the rest need a
founder's grant (always with an expiry, default 8 h, max 30 days). Every `/__*` rule must name a route that
`scripts/identity/routes.ts` classes `shared` for that method (`policy.test.ts` enforces it).

| Capability | Methods | Routes |
|---|---|---|
| view | GET, HEAD | the UI (section 4a: exact files of the built bundle, the shell for the app's own routes; served by the gateway, never the hub); `/__events`, `/__events/snapshot`, `/__version`, `/__app_version`, `/__health`, `/__workspace/pipeline`, `/__workspace/websites`, `/__workspace/groups` (exact panels, no wildcard), `/__agents/**`, `/__jobs/**`, `/__operator/leads/**`, `/__operator/coding/{jobs, jobs/*, jobs/*/events, repos, artefacts/*/*}` (never `accounts`), `/__operator/capabilities`, `/__gateway/**` |
| crm.write | POST / DELETE | `/__gateway/crm/activity`, `/__gateway/crm/activity/*` |
| coding.start | POST | `/__operator/coding/shape`, `/__operator/coding/jobs`, `/__operator/coding/jobs/*/cancel` |
| bots.operate | POST | `/__computers/*/takeover`, `/*/lease/renew`, `/*/return`, `/*/input`. **Refused at the hub today** (its handlers give Dot no identity); listed only so the capability has a shape. No `/__computers` read rule and no WebSocket rule exist: the viewer and bot reads are not available to Dot at all |

**Workspace panels Dot can read: `pipeline` (CRM pipeline summary), `websites` (uptime checks), `groups` (the saved
workspace grouping).** Not readable, at both layers: `email`, `receptionist`, `enquiries`, `call-queue` (mail, calls and
customer enquiries: in the NEVER list), the bare `/__workspace` (every panel at once), `today` and `needs-you` (founders'
approvals and decisions, receptionist gates, mail-derived counts).

**Never, for any capability** (the `NEVER` list, tested with every capability granted, at both layers): founders'
personal desktop control (`/__operator/screen|pc|browser/act`, `open-url`, `screen/command`), every local-owner and
console-only route, identity and pairing (`/__devices/**`, `/__token` upstream, `/__away`), account and credential routes
(`/__operator/connections`, `/setup/connections`, `/__openrouter_key`, `/__design_providers`, key routes), approval
decisions and job release, memory writes and deletion, publishing (`/__design_publish`, `/__lead-sites/*`), hub agents
(`/__claude_chat`, `/__hermes_chat`), the founders' mail, calendars, transcripts and vaults, provisioning or destroying a
computer, setting up a bot. Also not in `view` by default (owner decision, section 16): finance, receptionist call data,
approvals list, shared memory, the dashboard machine scan (`/__live-data`), command palette device names, design studio.

**What a capability opens today (honest):**
- `view`: proven end to end against the real gate. `/__events` gives Dot shared-scope CODING job events only (section 6).
  The `/__operator/coding/{jobs, jobs/*, jobs/*/events, repos, artefacts/*/*}` (never `accounts`) and `/__operator/leads/**` read handlers have not been audited line by line for what they
  return to a non-founder (a production item, section 15).
- `crm.write`: proven end to end (section 8).
- `coding.start`, `bots.operate`: enforced at both gates, but the handlers refuse a process actor
  (`hasVerifiedUiSession` in `scripts/coding/routes.ts`; `needPerson`/`devices.identify` in `scripts/computers/routes.ts`).
  Those modules are being changed in parallel and were not touched. Making them accept Dot is a follow-up for their
  owners, after an owner decision.

## 4a. The UI: a built bundle served by the gateway

- `bun scripts/gateway/build-ui.ts` runs the production build with `MU_GATEWAY_SPA_BUILD=1` (`vite.config.ts`: TanStack
  Start's SPA mode, no Cloudflare worker) with `MU_DATA_DIR` pointed at a throwaway folder (the shell prerender opens the
  app's stores once), and writes `dist/client/gateway-ui-manifest.json`: every file with its size, SHA-256 and type, the
  SPA shell (`/_shell.html`), the revision, and the app's route list (TanStack's `fullPaths` from `src/routeTree.gen.ts`).
  Source maps and dot files are never listed (the build produces no maps; default off).
- The gateway (`MU_GATEWAY_UI_DIR`) loads the manifest at start and checks every listed file exists inside the folder with
  the listed size, or refuses to start. Then, for a non-`/__` path, after sign-in: an exact manifest key gets that file
  (`/assets/*` cached `private, max-age=31536000, immutable`, everything else `private, no-cache`); a path naming one of
  the app's routes (a `$param` is one plain segment) gets the shell; everything else is **404**, including `/@id`, `/@fs`,
  `/@vite`, `/src`, `/node_modules`, `/scripts`, maps, the manifest itself, files on disk that the manifest does not list,
  any path with a Vite transform query (`raw`, `url`, `import`, `inline`, `worker`, `sharedworker`, `direct`,
  `html-proxy`, `t`, `v`), and every non-GET/HEAD and WebSocket request to a non-`/__` path.
- Excluded from the bundle by default (`UI_EXCLUDED_PREFIXES` in `scripts/gateway/ui.ts`, a short list with reasons):
  `/mu-creative-20261001` (unapproved films and the creative brief, which also names a local path).
- At start `loadUi` refuses the whole bundle unless every listed file is a plain file reached through plain folders
  (lstat and realpath: no symlink, junction or other reparse point), with the listed size AND SHA-256.
- Proven locally with the REAL built bundle (`scripts/gateway/ui.e2e.test.ts`, real spawned gateway): the shell loads at
  `/` and for every app route, every manifest file is served byte for byte, the shell's references are root-relative and
  same-origin, the bundle's literal request targets are root-relative (`/__token`, `/__events`, ...). And in a real
  browser (Claude's browser pane, against the rig hub): sign-in, then the SPA boots from the shell, client-side routing
  works (`/` -> `/business`, a deep link to `/leads` renders the Leads page), 140+ assets load from the gateway, and the
  client calls `/__*` on the same origin (allowed reads 200, everything outside `view` 403).
- What does NOT work for Dot through the gateway, by design or by the bundle: in-browser voice (the bundle calls a voice
  sidecar at `http://localhost:8099` on the viewer's own machine) and the wake word (`/ort/` is a dev-server route, not in
  the bundle); hot reload (no dev server); pages whose data is outside `view` render errors or empty states (with the rig
  hub, the Business home showed an error panel; Leads rendered). The real hub's behaviour per page is a staging check.

## 5. Browser model: cookie, CSRF, origin

- **One cookie**: `__Host-mu_gw=<32 random bytes>; Path=/; HttpOnly; Secure; SameSite=Strict`, no Domain, a browser-session
  cookie (server-side expiry decides). Only its SHA-256 is stored. The hub's own `Set-Cookie` is **never** passed through
  (dropped), and no cookie is sent to the hub: the browser holds exactly one cookie for this origin.
- **Rotation on privilege change**: when the effective capability set differs from the one the cookie was issued for, the
  next response sets a new cookie; the old value works 15 s more (requests in flight), then never. Logout, revocation
  and expiry end the session server-side.
- **Origin/Host allowlist**: the `Host` header and the request URL's host must equal the configured public host; any
  `Origin` must equal the public origin; `Sec-Fetch-Site` must be `same-origin` (or `none` for a GET navigation). Every
  non-GET additionally REQUIRES `Origin` equal to the public origin.
- **CSRF**: every non-GET needs `X-Claude-OS-Token` (the header the OS UI already sends) equal to
  HMAC(key, session id + current cookie hash). The gateway answers `GET /__token` itself with that value, so the
  unmodified UI works; the hub's page token never reaches the browser. Sign-in POST needs `Origin` plus the custom header
  `X-MU-Gateway-Enrol: 1` and JSON (a cross-site form cannot send it).
- **Headers**: requests are rebuilt from an allow-list (`accept`, `accept-language`, `content-type`, `last-event-id`,
  `cache-control`, `pragma`, `if-none-match`, `if-modified-since`, `range`, `user-agent`, `sec-fetch-dest`,
  `sec-fetch-mode`) plus `Via` and the assertion. Everything else (cookies, `Authorization`, `Tailscale-*`,
  `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `X-MU-*`, `Origin`, `Referer`) is dropped. Responses drop `Set-Cookie`,
  `Server`, `X-Powered-By`, CORS, `X-MU-*` and hop-by-hop headers, and gain HSTS, `nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: same-origin`, `Permissions-Policy` (no camera, microphone, geolocation, payment, USB), COOP/CORP,
  `X-Robots-Tag: noindex`, and a minimal CSP when the hub sent none (the Vite dev app needs inline scripts, so no
  script restriction is added there; the gateway's own pages have a strict nonce CSP).
- **Redirects**: a `Location` on the hub's origin (or any loopback alias of its port) becomes a path; anything else is
  refused with 502. Response bodies are not rewritten.
- **Targets** (`policy.ts nonCanonical`, applied by the gateway to every request AND by the hub to every gateway request):
  everything the hub gate refuses (`//`, `.`/`..` segments, backslashes, encoded `%2e %2f %5c %25 %00`) plus what Windows
  reads differently from how it is written: any `:` in the path (NTFS alternate data streams such as `x.json::$DATA` or
  `x:stream`, drive letters) or `%3a`, a NUL or `%00` anywhere in the target, a segment that ends in `.` or a space once
  decoded (Windows strips them), control characters, and a segment that does not decode. The query may hold `:` (event
  ids are `epoch:n`). The hub's own `nonCanonicalTarget` for founders is unchanged: founders' dev tooling uses `/@fs/C:/...`
  and virtual module ids with colons, and founders are fully trusted on the tailnet already. Bun builds the request URL from `Host`, so an
  absolute-form target becomes its plain path at the one upstream (tested: `GET http://example.com/` is the hub's `/`).
  Methods other than GET, HEAD, POST, PUT, PATCH, DELETE get 405.

## 6. Streams and WebSockets

- **SSE** (`/__events` and the coding job events stream): authenticated like any request; the response is pumped by hand
  so the gateway can end it. `Last-Event-ID` and `?last=` pass through unchanged, so the hub's own resume (an epoch:n id;
  replay from its ring, or a fresh snapshot) works and nothing is sent twice (tested: resume after 2 events returns
  exactly the 2 missed ones). **Dot's topic allow-list** (`scripts/gateway/events.ts`, applied in the hub's stream to the
  live events, the replay and the snapshot): `job` events for jobs of kind `coding`, and nothing else. Not memory or
  trigger jobs, not approvals (merge, deploy, provider and trigger reviews), not computers, leases, devices, agent
  messages, Jarvis or conversation threads, and never a founder's own-scope events. Every open stream is re-checked every second
  (`LIMITS.recheckMs`) for revocation, expiry (idle and absolute), the capability and the kill switch, and closed from the
  gateway's side, which also releases the hub's stream. Max 8 streams per session; no idle timeout on a stream.
- **WebSocket**: there is no WebSocket for Dot. The policy has no WebSocket rule, so the gateway refuses every upgrade
  (403 on a `/__` path, 404 elsewhere) before the hub is asked; the proxying code stays, unused, for when `bots.operate`
  is real. The UI's only WebSocket besides Vite's HMR is the bot viewer `/__computers/<name>/vnc` (noVNC, RFB). On the hub
  the REAL viewer (`scripts/computers/viewer.ts`) now runs the gateway check (`screenUpgrade`) before `devices.identify`:
  an assertion that does not verify is 401, and a verified gateway principal is refused 403, because `bots.operate` is
  out of scope on the hub for now (the viewer and lease code identify people through the devices module, which gives Dot
  no identity). (`viewer.e2e.test.ts`: the real viewer, directly and behind a real gateway.) An
  upgrade's assertion carries `u: 1` and is never accepted for an ordinary request, or the reverse. The
  upgrade is authenticated before anything is opened: session, `Origin` required and equal to the public origin,
  capability, then the gateway connects to the hub with the assertion and only then accepts the browser's upgrade. Open
  sockets are re-checked every second and closed (1008) on revocation, capability loss, expiry or the kill switch. Max 4
  per session. There is no HMR socket (no dev server). **Production item: per-message size and rate caps** on WebSocket
  traffic (today: Bun's 1 MiB payload cap and the hub's RFB filter only).

## 7. Expiry, rate limits, logout, revocation, kill switch

- Enrolment code: 20 characters from a 30-letter alphabet (~98 bits), single use (spent on disk before the cookie is
  issued), default 10 min, max 60. Shown once by the CLI; stored as a hash; delivered in the link's `#fragment` so it is
  never in a URL that leaves the browser.
- Session: idle 2 h and absolute 12 h by default (per code: `--idle-minutes`, `--session-hours`/`--session-minutes`, max
  7 days; staging uses 2 min / 10 min so expiry can be watched).
- Rate limits: 1,200 requests/min per client address, 600/min per session, 60 writes/min per session; sign-in 30
  attempts/min per address.
- **Sign-in can be denied by an attacker, by design of the limits** (it cannot be broken into): 20 wrong guesses burn
  every outstanding unused code, and the 30 attempts/min limit is gateway-wide behind Funnel. So: mint the code only when
  Dot is ready, have Dot redeem it immediately, and mint again if it was burned (`cli audit` shows `code-burned`).
- Wrong sign-in codes: **per code**, every wrong guess counts against every unused code, and a code that has absorbed 20
  wrong guesses since it was made is burned (cannot be used from any address; persisted; audited `code-burned:<id>`); a
  founder makes a new one. **Per address**, 5 wrong codes lock that address out for 15 min, but only when the address is
  meaningful (a direct peer, or `MU_GATEWAY_FORWARDED_FOR=1`). **Globally**, 50 wrong codes in 15 min raise an ALERT (console
  line and audit `global-alert`); nothing hard-locks the gateway, so an attacker cannot lock Dot out wholesale.
- **Client address**: `X-Forwarded-For` is NOT trusted by default (`MU_GATEWAY_FORWARDED_FOR` unset or `0`). What Tailscale
  Funnel puts in that header is **UNVERIFIED**; behind Funnel every client then shares 127.0.0.1, so the per-address limits
  act gateway-wide and the per-code limit carries the sign-in protection. Turn it on only after verifying Funnel's
  behaviour on Ryzen. Bodies over 1 MiB: 413. Hub header timeout 30 s, whole response 120 s (streams
  excepted).
- Logout: `POST /gw/logout` (Origin + CSRF) ends the session and closes its streams and sockets.
- Revocation: `cli revoke-session <id>` / `--all` (also voids unused codes), `cli revoke-grant <cap>`; checked on every
  request and within ~1 s for open streams and sockets. Survives restarts (two files, one writer each: `control.json`
  from the CLI, `sessions.json` from the gateway).
- Kill switch: the `KILL` file (`cli kill on`, or `dot-gateway-emergency-disable.ps1`). The gateway answers 503 to
  everything including sign-in and health, closes everything open within ~1 s, and the hub refuses any assertion while the
  file exists. The emergency script also turns the Funnel off and stops the gateway.

## 8. crm.write end to end

`scripts/crm/ops.ts` (Dot's `crm.activity.add`, `AGENTS-CRM-CONTRACTS.md` section 4) is **not on this branch**. So
`/__gateway/crm/activity` implements the contract's input and receipt (`{ ref, eventId, kind, title }` ->
`{ ok, activityId, href }`, idempotent on `eventId`) against a **clearly-marked test store**
(`MU_DATA_DIR/gateway/crm-test-activities.json`, every row `test: true, store: "gateway-test"`), with `DELETE` to undo.
It is not the CRM database. The handler takes a `CrmOps` seam: when Dot's ops land, pass its `crm.activity.add` and the
route, capability and audit stay as they are. Records are attributed `by: { agent: "dot", session, delegatedBy }`, never a
founder. The reversible test update (create, verify, create again = no duplicate, remove, verify gone) is a page at
`/gw/test-update` and is automated in `gateway.e2e.test.ts`.

## 9. Audit and log redaction

- `MU_DATA_DIR/gateway/audit-YYYY-MM-DD.jsonl`, append-only, one line per request and per gateway event (sign-in,
  failed sign-in, logout, rotation, stream or socket closed, kill switch). Closed field list:
  `at, event, person ("dot" or null, never a founder), session (public id), ip, method, route (the policy TEMPLATE, never
  the URL), capability, status, outcome, reason (a fixed word), recordIds (from the hub's X-MU-Record-Ids, writes only),
  delegatedBy (the founder who granted the capability), ms`. Anonymous lines capped at 120/min.
- Never written anywhere (tested by scanning process output, audit, `control.json`, `sessions.json`): cookies, codes, CSRF
  tokens, assertions, the key, query strings, request bodies, the hub's cookies. Process output is a fixed set of lines.
- The hub's own records attribute Dot's actions to Dot: the principal's `personId` is `"dot"`, so anything a handler
  stores from it says Dot; the test store records `by.agent: "dot"`.

## 10. Hosting and cost

| | Tailscale Funnel (recommended) | Cloudflare Tunnel + Access |
|---|---|---|
| Recurring cost | none (included in the current Tailscale plan; already installed) | Tunnel free; Access free up to 50 users; needs a domain whose DNS is on Cloudflare (none today: about A$15-30/year for a new one, or moving a zone) |
| TLS | terminated on Ryzen by tailscaled; Tailscale relays only see ciphertext | terminated at Cloudflare (Cloudflare sees plaintext) |
| Hostname | fixed `ryzen-pc.tailnet-name.ts.net` (already public in certificate logs) | your own subdomain |
| Extra identity layer | none (the gateway's own sign-in is the boundary) | Access can require an identity (email one-time PIN) before the gateway, defence in depth |
| Edge protection | Tailscale's relays, no WAF; bandwidth limits apply to Funnel | WAF, DDoS protection, edge rate limiting |
| Moving parts | one command, reversible in one command | `cloudflared` service, DNS, Access policy, another vendor account |

Funnel is recommended for staging and a first production step: zero cost, nothing new to install, one-command off, no new
vendor holding plaintext. Revisit Cloudflare if Dot's traffic grows, if the owner wants an identity layer in front, or if
edge DDoS protection becomes a requirement. Funnel's exact limits and syntax are to be confirmed on Ryzen
(`tailscale funnel --help`).

## 11. Deployment, rollback, emergency (nothing has been run)

Staging only, synthetic data only (owner, 2 Oct): `deploy/windows/gateway/README.md` has the run order. In short:
`dot-gateway-staging.ps1 -Action export -Revision <reviewed commit>` (a `git archive` of that commit into a fresh folder,
its OWN `bun install --frozen-lockfile` (needs network access on Ryzen; chosen over linking production's node_modules so
no staging build or dev-server cache is ever written into production's dependencies; Vite's cache is also pointed inside
the staging root), then the UI build; never the working tree), `-Action seed` (new empty data folder, fake records,
refuses a production backup or restore marker or any other folder), `-Action start -PublicOrigin
https://ryzen-pc.tailnet-name.ts.net` (refuses unless the export holds only the revision's files plus node_modules and the
build output, with no backup files, and the data folder passes the synthetic check; staging hub 8086 with
`MU_GATEWAY_TRUST=1` run from the export, gateway 8096 serving the export's built UI, `X-Forwarded-For` not trusted; both
start with a SCRUBBED environment: an explicit allow-list of variable names (system basics plus the inert staging
settings), nothing inherited, and a refusal naming any variable that matches KEY|TOKEN|SECRET|PASSWORD),
`dot-gateway-funnel.ps1 -Action on` (443 -> 8096 only; refuses unless the port's only loopback listener is the gateway PID
recorded at start running `scripts/gateway/main.ts`, and never 8081, 8085, 8086, 8443 or 8445), `-Action mint-code`
(short expiry), Dot runs the checklist, then `dot-gateway-funnel.ps1 -Action off` and `-Action stop`.

Production (a separate, later owner decision): gateway on 8090 under `mu-gateway-supervisor.ps1`, the production hub
restarted with `MU_GATEWAY_TRUST=1`, Funnel 443 -> 8090.

Rollback: Funnel off, stop the gateway, restart the hub without `MU_GATEWAY_TRUST`. Reverting the branch removes the
principal and `/__gateway`; nothing founders use depends on them.

Emergency: `dot-gateway-emergency-disable.ps1` (KILL files, Funnel off, gateway stopped). By hand: `tailscale funnel
--https=443 off`, or create `<data>\gateway\KILL`. Either alone cuts Dot off.

## 12. Shared files touched (and why)

| File | Change |
|---|---|
| `scripts/identity/principal.ts` | `PrincipalVia` gains `"gateway"`; optional `capabilities`, `delegatedBy` on `Principal`; `markGatewayPrincipal` and a 2-line early return in `identifyRequest`; `isBrowserPrincipal` includes `gateway` |
| `scripts/identity/gate.ts` | `GateOptions.gateway`; `gateway.screen(req)` as the first step of `principalGate` (4 lines) |
| `scripts/identity/routes.ts` | the `/__gateway` entry (shared) |
| `docs/IDENTITY-ROUTES.md` | the `/__gateway` row; shared count 41 -> 42 |
| `scripts/identity/fixtures/legacy-route-decisions.json` | `GET`/`POST /__gateway` rows, the same decisions as every other shared route (the fixture must cover every ROUTES entry) |
| `vite.config.ts` | import and mount `dotGatewayHubPlugin` right after the identity gate |
| `scripts/devices/identity.ts` | `devicesPrincipal` returns null for `gateway` (no device identity) |
| `scripts/events/plugin.ts` | the stream admits the gateway principal: shared scope, and only Dot's topic allow-list |
| `scripts/events/stream.ts` | a stream principal may carry `allow` (per-entry filter) and `snapshot` (its own snapshot); unset for founders, so their stream is unchanged |
| `scripts/events/bus.ts`, `scripts/events/sources.ts` | an entry may carry a `tag` (never on the wire); job events are tagged with the job's kind |
| `scripts/approvals/principal.ts` | `"gateway"` in the `PrincipalVia` TYPE only (not in `VIAS`, so B2's `isPrincipal` refuses it) |
| `vite.config.ts` (again) | `MU_GATEWAY_SPA_BUILD=1` switches the build to TanStack Start SPA mode without the Cloudflare worker (the gateway's UI bundle). Unset: every other build and dev unchanged |
| `scripts/computers/viewer.ts` | `ViewerOptions.gateway`; an upgrade carrying a gateway assertion is decided first (`screenUpgrade`): 401 when it does not verify, 403 when it does (bots.operate out of scope on the hub) |
| `scripts/computers/plugin.ts` | passes the gateway trust to `attachViewer` (inert unless `MU_GATEWAY_TRUST=1`) |
| `scripts/computers/test-harness.ts` | an optional `gateway` passed to `attachViewer` (test support, for `viewer.e2e.test.ts`) |

Not touched: `scripts/agents/**`, `scripts/coding/**`, `scripts/jarvis-command/**`, `src/components/agents/**`, CRM code,
receptionist code, `serve-peer.ts`, `remote-access.ts`, `server-role.ts`, `local-owner-token.ts`, `devices/service.ts`.

## 13. Residual risks and what could not be proven locally

- **Not proven locally**: Dot's real cloud browser against the real OS UI on the real hub (the built UI was proven in a
  local browser against the test hub only: which pages render with real data, which panels show errors for denied reads
  such as `/__devices/me`); Funnel itself (Host preservation, the client address in `X-Forwarded-For`,
  limits); the real hub under `MU_GATEWAY_TRUST=1` (the tests use the real gate and real routes, not the whole Vite hub);
  the bot viewer and coding writes for Dot (blocked at their handlers, section 4). The checklist covers the first three.
- `view` serves the built, minified client bundle (no source maps), which includes whatever committed data the UI imports
  statically (for example `src/data/model-intel.json`, `src/data/graphs/*`). The dev server's files are not reachable.
- Hub handlers were written for two founders. Dot's reads go to handlers that think of any non-owner as "co-founder"
  for labels (e.g. `/__operator`'s `remote.role`). The allow-list keeps Dot to a small set of reads for that reason.
- The assertion does not cover the body (loopback hop on one machine). The hub's nonce cache is in memory: after a hub
  restart an assertion captured on loopback could be replayed within its 30 s window, by something already able to read
  loopback traffic. Anyone who can read the key file (hub account, SYSTEM, Administrators) can act as Dot, the same trust
  as the local-owner token. Anyone who can write `MU_DATA_DIR/gateway/control.json` can grant capabilities, the same
  trust as every other hub store.
- `X-Forwarded-For` is not trusted by default (Funnel's behaviour is unverified), so behind Funnel the per-address limits
  are gateway-wide: an attacker can slow Dot's sign-in (30 attempts/min shared) and burn unused codes with wrong guesses
  (a founder mints a new one). If it is turned on, a local process could spoof it to dodge the per-address limit.
- The staging export check (`Assert-CleanExport`), the Funnel PID check and the build inside an export were written and
  parse-checked but NOT run (they target Ryzen's `C:\mu-hub` layout). A build may create an ignored folder such as
  `.wrangler` in the export, which the clean check would refuse: if so, rebuild in a fresh export after checking why.
- WebSocket per-message size and rate caps are a production item (section 6).
- Rotation leaves the old cookie usable for 15 s. Response bodies are not rewritten (they could mention 127.0.0.1).
- Audit files grow by day with no pruning yet.

## 14. Security review fixes (3 Oct 2026)

| Review item | Fix | Proof |
|---|---|---|
| 1. NTFS stream suffix (`::$DATA`, `:stream`) bypassed the deny rules, gateway and hub | strict target rule in both: no `:` or `%3a` in the path, no NUL/`%00`, no segment ending in `.` or space | `policy.test.ts`, `hub.test.ts`, `gateway.e2e.test.ts` and `ui.e2e.test.ts` bypass lists |
| 2. `/@id/**` + `?raw` read any file in Vite's allowed folders | the gateway never forwards a non-`/__` path; the UI is a built bundle; the hub refuses non-`/__` from the gateway | 60+ bypass paths 403/404 through a real gateway, none reaches the hub |
| 3. app surface too broad (node_modules dot dirs, media anywhere, extensionless files, `/src`) | exact manifest of built files; the shell only for the app's own route list | same tests; files on disk but not listed are 404 |
| 4. staging ran vite dev from the real checkout | staging runs from a `git archive` export of a reviewed commit and refuses an export with any other file | script only (not run) |
| 5. `screenUpgrade` was only called by the test rig | wired into the real `viewer.ts` before `devices.identify`; gateway viewing refused (403) | `viewer.e2e.test.ts` against the real viewer, direct and through a real gateway |
| 6. WebSocket per-message caps | documented as a production item | - |
| 7. enrolment lockout | per-code burn; per-address only with a meaningful address; global = alert; `X-Forwarded-For` off by default (UNVERIFIED for Funnel) | `policy.test.ts`, `gateway.e2e.test.ts`, `ui.e2e.test.ts` |
| 8. caching | `Cache-Control: private, no-store` on authenticated hub answers that set none; UI files `private` | e2e |
| 9. Funnel script | requires the port's listener PID = the gateway PID in the state file, running `scripts/gateway/main.ts`, loopback only; never 8081/8085/8086/8443/8445 | script only (not run) |

Re-review (3 Oct, second round):

| Item | Fix | Proof |
|---|---|---|
| MUST: `/__workspace/**` exposed the mail, call and enquiry panels | exact panels only (`pipeline`, `websites`, `groups`); the rest in NEVER or unlisted; both layers | `policy.test.ts`, `hub.test.ts`, `gateway.e2e.test.ts` (none reaches the hub) |
| a. staging hub environment | scrubbed allow-list of names, refusal on KEY/TOKEN/SECRET/PASSWORD names | the launcher functions were exercised locally with a stand-in command; the full script was not run |
| b. creative material in the bundle | excluded by default (`UI_EXCLUDED_PREFIXES`) | `policy.test.ts`, `ui.e2e.test.ts` |
| c. bundle integrity | lstat/realpath (no links), SHA-256 and size at load, refuse on mismatch | `policy.test.ts` (tamper, junction) |
| d. dead rules | WebSocket rule and `/__computers` read rule removed | `policy.test.ts`, `gateway.e2e.test.ts`, `viewer.e2e.test.ts` |
| e. caches | the export runs its own `bun install --frozen-lockfile` (needs network); production's node_modules is never linked | script only (not run) |
| f. event topics | Dot gets coding job events only, in the live stream, the replay and the snapshot | `policy.test.ts`, `gateway.e2e.test.ts` |
| g, h | sign-in denial of service and the production list documented | sections 7 and 15 |

## 15. Before production (not needed for the staging Funnel)

- A real Content-Security-Policy with `script-src` on the shell (today the UI gets only `frame-ancestors`, `base-uri`,
  `form-action`, `object-src`; the shell has inline scripts, so this needs nonces or hashes from the build).
- The client address behind Funnel verified, then `MU_GATEWAY_FORWARDED_FOR=1` (or left off for good).
- Finish the read audit of `/__operator/coding/{jobs, jobs/*, jobs/*/events, repos, artefacts/*/*}` (never `accounts`) and `/__operator/leads/**` for what they return to a non-founder.
- Per-message size and rate caps on WebSocket traffic, before any WebSocket rule is added.
- A separate signing key per environment (staging and production must never share `hub-assertion.key`; they do not
  today because each data folder has its own, but production should also rotate on a schedule).
- Never an internet path to a hub running as a dev server other than this gateway's `/__` allow-list; ideally the
  production hub behind the gateway is not a dev server at all.

## 16. Owner decisions needed before ANY internet endpoint exists

1. Approve this design after independent review (the staging Funnel approval is conditional on it).
2. The edge: Funnel (recommended) or Cloudflare Tunnel + Access.
3. The staging Funnel window: how long it stays on, and who watches the audit while it is on.
4. The `view` read list (section 4), including the default exclusions: finance, receptionist call data, the approvals
   list, shared memory, `/__live-data`, the design studio. And accepting that `view` shows the app's source code.
5. Session lifetimes for production (proposed: idle 2 h, absolute 12 h, new code each day) and who mints codes and over
   which private channel they reach Dot.
6. Whether and when the production hub gets `MU_GATEWAY_TRUST=1` and a production gateway on 8090 (separate decision).
7. `crm.write`: stay on the test store until Dot's `scripts/crm/ops.ts` lands, then which record kinds and operations.
8. Whether Dot should ever have `coding.start` or `bots.operate` (needs the coding and computers owners to accept the
   gateway principal in their handlers).
9. Audit retention period.
