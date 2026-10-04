# Dot gateway: staging proof on a synthetic hub (r11)

Run: 2026-10-04T07:54:00.375Z by `bun scripts/gateway/staging-local.ts proof` against a SYNTHETIC hub (127.0.0.1:8194, server role, MU_GATEWAY_TRUST=1, MU_SYNTHETIC_HUB=1, memory off, no Jev key) and the gateway (127.0.0.1:8195, API only, no UI bundle). Branch r11/gateway-20261004. Nothing was exposed: both listen on loopback; no Tailscale command was run.

Every request below went through the gateway as Dot's program would send it (bearer mode). The enrolment code was synthetic, minted in-process against the synthetic data folder. Summaries only: no code, reconnect key, access token, cookie or request body is recorded (the script refuses to write the file if one would be).

### 1. The public surface: the gateway only

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 1 | `GET /gw/health` | 200 | {"ok":true} (4 ms) |
| 2 | `GET /__version` | 401 | anonymous: Sign in first.; renew path /gw/renew (0 ms) |
| 3 | `GET /src/main.tsx` | 401 | anonymous: Sign in first. (1 ms) |

### 2. Enrol with a synthetic one-time code (bearer mode, as Dot's program); reconnect key shown once

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 4 | console: `bun scripts/gateway/cli.ts enrol-code --by usman --label "Dot (staging proof)" --minutes 5 --identity-days 1` | exit 0 | a one-time code was printed (not recorded here) |
| 5 | `POST /gw/enrol` | 401 | error: That code is not valid. Codes work once and expire within minutes. (256 ms) |
| 6 | `POST /gw/enrol` | 200 | identity ad11b7c9a86a0a2b "Dot (staging proof)", enrolled by usman; reconnect key: returned once (not recorded); access: bearer, idle 120 min (2 ms) |
| 7 | `POST /gw/enrol` | 401 | the same code again: That code is not valid. Codes work once and expire within minutes. (252 ms) |
| 8 | `GET /gw/me` | 200 | person dot; session mode bearer; capabilities view (1 ms) |
| 9 | console: `bun scripts/gateway/cli.ts identities` | exit 0 | ad11b7c9a86a0a2b active "Dot (staging proof)" enrolled 04/10/2026, 6:53:59 pm by usman expires 05/10/2026, 6:53:59 pm active sessions 1 renewed 0x last seen 04/ |

### 3. Deny by default, then a founder grants the operating set

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 10 | `GET /__gateway/capabilities` | 200 | view: working; crm.read: missing-authorisation; crm.write: missing-authorisation; finance.read: missing-authorisation; finance.write: missing-authorisation; mail.read: missing-authorisation; mail.draft: missing-authorisation; release.request: owner-action; files.read: missing-authorisation; files.wr (5 ms) |
| 11 | `POST /__gateway/crm/ops` | 403 | error: That needs the crm.write capability, which a founder has not granted. (1 ms) |
| 12 | console: `bun scripts/gateway/cli.ts grant operate --by usman --until-identity` | exit 0 | 15 capabilities granted until the identity ends |
| 13 | `GET /gw/me` | 200 | identity ends 2026-10-05T07:53:59.537Z; 15 grants with expiry; renewSoon true (4 ms) |
| 14 | `GET /__gateway/capabilities` | 200 | view: working; crm.read: working; crm.write: working; finance.read: working; finance.write: working; mail.read: working; mail.draft: working; release.request: owner-action; files.read: working; files.write: working; tasks.run: working; memory.read: working; memory.write: working; coding.start: owner (4 ms) |

### 4. Business records: read and reversibly update a synthetic CRM record

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 15 | `POST /__gateway/crm/ops` | 200 | ok true; company company-5a9bfe4a-f687-47a0-ad47-1f74e8746d7f v1, locality Mount Druitt (8 ms) |
| 16 | `POST /__gateway/crm/read` | 200 | ok true; read back: "Synthetic Staging Dental Co" (2 ms) |
| 17 | `POST /__gateway/crm/ops` | 200 | ok true; locality now Rooty Hill (v2) (6 ms) |
| 18 | `POST /__gateway/crm/ops` | 200 | ok true; reverted: locality Mount Druitt (v3) (6 ms) |
| 19 | `POST /__gateway/crm/ops` | 409 | ok false; a draft note, recorded as Dot's (3 ms) |
| 20 | `POST /__gateway/crm/ops` | 403 | An activity saying a message was queued, sent or received records outbound contact without the provider's evidence or the founder's approval of the send. (outbound stays the owner's) (2 ms) |
| 21 | `POST /__gateway/crm/ops` | 403 | A document marked issued or accepted says it went to the client: issuing is a send, and sends need the founder's approval. Nothing changed. (2 ms) |
| 22 | `POST /__gateway/crm/ops` | 403 | Allowing contact (email permission on, do-not-contact off, not excluded) authorises future outbound messages, which consent and the Spam Act 2003 require a foun (1 ms) |
| 23 | `POST /__gateway/crm/ops` | 200 | ok true; deal deal-ebd16f93-b567-4331-9462-6e6f0c0d9932 (6 ms) |
| 24 | `POST /__gateway/crm/ops` | 200 | ok true; document status draft; total 165000 c; Invoice draft saved. It was not issued or sent, and no payment was requested. (5 ms) |
| 25 | `POST /__gateway/crm/ops` | 200 | ok true; CSV export prepared. (3 ms) |
| 26 | `POST /__gateway/crm/read` | 200 | ok true; 6 rules (2 ms) |

### 4b. Business finance and authorised mailboxes

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 27 | `GET /__gateway/finance/summary?period=all` | 200 | scope business; 0 business rows; Business rows only; personal and unreviewed rows are not included. (2 ms) |
| 28 | `GET /__gateway/finance/stripe` | 200 | The hub's last synced Stripe snapshot (read-only). The gateway never calls Stripe and cannot refund, charge or issue. (3 ms) |
| 29 | `GET /__gateway/mail/threads?mailbox=hello@synthetic.example` | 200 | before authorising: listed (1 ms) |
| 30 | console: `bun scripts/gateway/cli.ts authorise-mailbox hello@synthetic.example --by usman` | exit 0 | a synthetic mailbox authorised |
| 31 | `GET /__gateway/mail/mailboxes` | 200 | 1 authorised mailboxes (6 ms) |
| 32 | `GET /__gateway/mail/threads?mailbox=hello@synthetic.example` | 200 | 0 threads (the synthetic archive is empty) (1 ms) |
| 33 | `GET /__gateway/release` | 503 | The release workflow is not available on this hub. (1 ms) |

### 5. Files in the approved roots

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 34 | `GET /__gateway/files/roots` | 200 | drafts (rw, ready), designs (rw, ready) (1 ms) |
| 35 | `GET /__gateway/files/read?root=designs&path=synthetic-dental/index.html` | 200 | 88 bytes, utf8, sha256 3e6dbba8e23f (2 ms) |
| 36 | `POST /__gateway/files/write` | 409 | created undefined; sha256 undefined (3 ms) |
| 37 | `POST /__gateway/files/write` | 200 | previous f4a08ddc4d35 -> f4a08ddc4d35 (5 ms) |
| 38 | `GET /__gateway/files/read?root=drafts&path=../../control.json` | 400 | error: Use plain names: letters, digits, spaces, dots, hyphens and underscores, not starting with a dot. (2 ms) |

### 6. A harmless Jarvis task through the Jev-led command path, and its result

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 39 | `POST /__gateway/tasks` | 200 | job 210407b5-3541-402a-876f-fb3b47ba477b; ok true; kind navigate; said: Opening Leads. (6 ms) |
| 40 | `GET /__gateway/jobs/210407b5-3541-402a-876f-fb3b47ba477b` | 200 | state succeeded; owner {"personId":"dot","via":"gateway","actor":"process"}; 1 steps; last step: navigate: /leads; note: Opening Leads. (1 ms) |
| 41 | `POST /__gateway/tasks` | 200 | ok false; said: Not done: the gateway has no devices of its own; it reaches a shared cloud computer only, by name. Nothing ran on any other machine. (4 ms) |
| 42 | `GET /__gateway/jobs?limit=5` | 200 | 4 of Dot's jobs, owners: dot (2 ms) |

### 7. Shared bot computers (this synthetic hub has none)

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 43 | `GET /__gateway/bots` | 200 | 0 bots; No shared bot computers exist on this hub. (1 ms) |
| 44 | `POST /__gateway/bots/research/takeover` | 404 | No shared bot computer called "research". (1 ms) |

### 8. Memory (ON on this synthetic hub (--memory on; Hindsight off))

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 45 | `POST /__gateway/memory/remember` | 200 | saved mem-ad0230ec3a (3 ms) |
| 46 | `POST /__gateway/memory/recall` | 200 | 1 facts (withheld 0);  (2 ms) |

### 9. Coding (needs the owner to list dot on a repository)

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 47 | `POST /__gateway/coding/draft` | 200 | refused No code repositories are set up for coding jobs yet (.operator-data/coding/repos.json). (2 ms) |

### 10. Diagnostics and operations

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 48 | `GET /__health` | 200 | status degraded; role server; failed: searxng (14 ms) |
| 49 | `GET /__version` | 200 | version 3.6.1, a122eb6 (2 ms) |
| 50 | `GET /__gateway/diagnostics` | 200 | health ok; a122eb6; kill switch false; components: dataDir=ok stores=ok jobsWorker=ok hindsight=ok companions=ok sessionStore=ok host=ok (5 ms) |
| 51 | `GET /__gateway/diagnostics/releases` | 200 | configured true; release-20261004T090000.json -> 82d6962d (rollback rollback/synthetic-staging) (2 ms) |
| 52 | `GET /__gateway/diagnostics/jobs?limit=3` | 200 | 3 jobs from the job log (founders' as shape only) (1 ms) |
| 53 | `GET /__gateway/diagnostics/actions?tail=200` | 200 | 40 actions recorded, all by dot (2 ms) |

### 11. Final actions and private surfaces stay closed with everything granted

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 54 | `POST /__approvals/abc/decide` | 403 | error: That is not available through the gateway. (0 ms) |
| 55 | `POST /__operator/screen/command` | 403 | error: That is not available through the gateway. (1 ms) |
| 56 | `POST /__crm/ops` | 403 | error: That is not available through the gateway. (0 ms) |
| 57 | `GET /__devices/me` | 403 | error: That is not available through the gateway. (0 ms) |
| 58 | `GET /__gateway/admin/access` | 403 | error: That is not available through the gateway. (1 ms) |
| 59 | `GET /__operator/coding/accounts` | 403 | error: That is not available through the gateway. (0 ms) |
| 60 | `POST /__memory/remember` | 403 | error: That is not available through the gateway. (1 ms) |
| 61 | `GET /@fs/C:/Windows/win.ini` | 400 | error: Colons aren't allowed in paths. (0 ms) |

### 12. Reconnect in a new task, then revoke

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 62 | `POST /gw/renew` | 200 | new access for identity ad11b7c9a86a0a2b: a new bearer token (not recorded) (1 ms) |
| 63 | `GET /gw/me` | 200 | person dot; a different session true (0 ms) |
| 64 | console: `bun scripts/gateway/cli.ts renew --by usman --days 30` | exit 0 | Identity ad11b7c9a86a0a2b now lasts until 03/11/2026, 6:53:59 pm. |
| 65 | `GET /gw/me` | 200 | after renewal: identity ends 2026-11-03T07:53:59.990Z; renewSoon false (4 ms) |
| 66 | console: `bun scripts/gateway/cli.ts revoke-identity ad11b7c9a86a0a2b` | exit 0 | Revoked identity ad11b7c9a86a0a2b. Its reconnect key no longer works and every access session it holds is refused from the next request. |
| 67 | `GET /__version` | 401 | This access was revoked by a founder. (reason revoked) (5 ms) |
| 68 | `GET /__version` | 401 | This access was revoked by a founder. (reason revoked) (1 ms) |
| 69 | `POST /gw/renew` | 401 | error: That reconnect key is not valid. It may have expired or been revoked; ask a founder for a new sign-in code. (253 ms) |
| 70 | console: `bun scripts/gateway/cli.ts revoke-grant --all` | exit 0 | grants cleared after the proof |

### 13. The kill switch

| # | Request | Status | What came back (summary) |
|---|---|---|---|
| 71 | console: `bun scripts/gateway/cli.ts kill on` | exit 0 | |
| 72 | `GET /gw/health` | 503 | {"ok":false,"disabled":true} (0 ms) |
| 73 | console: `bun scripts/gateway/cli.ts kill off` | exit 0 | |
| 74 | `GET /gw/health` | 200 | {"ok":true} (0 ms) |
