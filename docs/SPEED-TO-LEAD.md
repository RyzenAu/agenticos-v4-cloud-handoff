# Speed-to-lead

When someone enquires on the M&U marketing site (muventures.com.au), they get an honest
acknowledgement immediately, and Usman/Mehroz get a Telegram alert within about a minute with a
link to the lead in the OS — plus a lead record in the CRM with a response-time clock. This page
is how it works, what's live after the marketing deploy, what still needs the owner's yes, and
how to roll it back.

## The pieces

```
muv-marketing (Vercel)                 AgenticOS (this repo)
────────────────────────               ──────────────────────────────────────────
ContactForm.tsx                        (nothing reads the enquiry directly —
  │ POST /api/enquiry                   the watcher only ever sees the internal
  ▼                                      notification email's metadata)
src/app/api/enquiry/route.ts
  │
  ├─ 1. internal notification email     scripts/inbox-triage (existing) logs its
  │     Resend → ENQUIRY_TO_EMAIL         sender/subject/received-at metadata
  │     Subject: "[M&U enquiry]                     │
  │              <topic> · ref:<ref>                ▼
  │              — <name>"               scripts/speed-to-lead/run.ts (cron —
  │                                        see "Patch for lead" below)
  └─ 2. acknowledgement email               │  reads scripts/inbox-triage/store.ts
        Resend → the enquirer,                (readonly, since/limit only)
        same env, same provider              │
                                             ▼
                                       scripts/speed-to-lead/watcher.ts
                                         detectNewEnquiries(): sender + subject
                                         match only → { ref, topic, receivedAt }
                                             │
                                             ▼
                                       scripts/speed-to-lead/clock.ts
                                         startClock(): business-hours-aware
                                         (reuses scripts/workspace/calling-window.ts
                                         → scripts/leads/outreach.ts's NO_CALL_HOLIDAYS)
                                             │
                                             ▼
                                       scripts/speed-to-lead/store.ts
                                         openEnquiryStore(): its own `enquiries`
                                         table inside .operator-data/crm.sqlite
                                         (the same CRM crm.ts already opens —
                                         kept out of the `leads` table, which is
                                         place_id-keyed cold-outreach prospects
                                         with its own Places-compliance rules)
                                             │
                                             ▼
                                       scripts/speed-to-lead/notify.ts
                                         alertMessage(): name-free Telegram text
                                         + a link into the OS
                                             │
                                             ▼
                                       scripts/inbox-triage/alerts.ts's
                                       hermesTelegram() (existing, reused as-is)
                                         → `hermes send` → the owner's Telegram
                                             │
                                             ▼
                                       scripts/speed-to-lead/panel.ts
                                         projectSpeedToLead(): metadata-only
                                         Today-panel data (open enquiries,
                                         minutes since/due, overdue)
                                             │
                                             ▼
                                       src/components/workspace/
                                         speed-to-lead-panel.tsx (presentational
                                         only — see "What's not wired up" below)
```

## Never reads the body

The watcher (`scripts/speed-to-lead/watcher.ts`, driven by `run.ts`) only ever looks at three
things about an email: **sender**, **subject**, and **received-at**. It reads them from
`scripts/inbox-triage/store.ts`'s existing sqlite log — the same log the Workspace "email" panel
already reads (`scripts/workspace/sources.ts` → `/__operator/inbox/triage`) — rather than opening
any mailbox itself. It never touches that log's `summary` field, and there is a test proving it
(`watcher.test.ts`'s "never touches a summary/body field" case).

Because the watcher can never see the enquiry's actual body — the visitor's name, phone, email and
message stay in the real inbox, exactly as they are today — the **subject line of the internal
notification email is the only channel** carrying what the watcher needs. That's why
`buildInternalSubject()` (muv-marketing's `src/app/api/enquiry/route.ts`) packs the topic and a
short dedupe `ref` into a stable, machine-readable prefix:

```
[M&U enquiry] <topic> · ref:<ref> — <name>
```

`scripts/speed-to-lead/subject.ts`'s `parseEnquirySubject()` is the other half of that contract.
The two repos can't share code, so keeping the prefix and regex in sync is a documented convention
(comments on both sides point at each other) — a mismatch only ever fails closed (nothing
detected), never open.

## The response-time clock

`scripts/speed-to-lead/clock.ts` reuses the calling window Usman's cold-outreach calls already
respect (`scripts/workspace/calling-window.ts`, backed by `scripts/leads/outreach.ts`'s
`NO_CALL_HOLIDAYS` — Mon–Fri 9am–8pm, Sat 9am–5pm, never Sunday or an NSW/national public
holiday) rather than inventing a second definition of "business hours":

- An enquiry that lands **inside** the window starts its 60-minute clock immediately.
- An enquiry that lands **outside** it still gets its Telegram alert straight away (the owner rule
  is the alert is never delayed) — but the clock itself starts at the next business hour, and the
  60 minutes are counted only in business time (`addBusinessMinutes()` skips nights, weekends and
  holidays), so a quiet overnight stretch can't quietly burn the reply window.

## What's live once this deploys

- **muv-marketing** (`design/premium-20260927` → once merged and deployed): the acknowledgement
  email and the tagged internal subject. This is a normal part of the enquiry flow — no extra
  configuration beyond the three env vars the route already needed
  (`RESEND_API_KEY`, `ENQUIRY_TO_EMAIL`, `ENQUIRY_FROM_EMAIL`).
- **AgenticOS** (`w2/leads-20260927`): the module exists, is tested, and `scripts/speed-to-lead/run.ts`
  runs correctly against a real `.operator-data` root — but **nothing calls it yet**. It is not
  registered as a cron job, a server route, or anywhere else. See "Patch for lead" below.

## What's not wired up (needs the os-shell track)

`src/components/workspace/speed-to-lead-panel.tsx` and `scripts/speed-to-lead/panel.ts` are ready
to drop in, but this task's brief is scoped to `scripts/leads/**` and `scripts/speed-to-lead/**` —
not the shell files that register a new Workspace panel
(`scripts/workspace/sources.ts`'s `SOURCES` map, `src/components/workspace/api.ts`'s `PanelKey`
union, `src/components/workspace/workspace-page.tsx`'s panel list). Wiring it in is:

1. Add an `enquiries` entry to `sources.ts`'s per-source fetch (reading
   `openEnquiryStore(openCrm(crmPath(root))).listOpen()`, feeding it through `projectSpeedToLead()`).
2. Add `"enquiries"` to `api.ts`'s `PanelKey`/`SOURCE_ROUTE`/`REFRESH_MS` maps.
3. Render `<SpeedToLeadPanel panel={data} />` from `workspace-page.tsx`'s panel list, wrapped in
   the same `PanelShell` the other panels use.
4. The Telegram link's convention is `${osBaseUrl}/today?enquiry=<ref>` (see `notify.ts`'s
   `osLeadUrl()`) — the shell track should either route that query param to scroll/highlight the
   matching row, or this doc's convention should change to match whatever it actually builds.

## Patch for lead (needs the owner's yes — not applied)

Nothing above is registered to actually run. Two things would need the owner's sign-off:

**1. AgenticOS env** — add to `~/.config/agentic-os.env` (never committed):
```
SPEED_TO_LEAD_FROM_EMAIL=enquiries@muventures.com.au
```
This must match muv-marketing's `ENQUIRY_FROM_EMAIL` (the address, not necessarily the display
name — `run.ts`'s `enquiryFromAddress()` and `watcher.ts`'s `normalizeAddress()` compare on the
bare address only).

**2. A schedule to actually run `scripts/speed-to-lead/run.ts`** — same pattern as the existing
`jarvis-watchdog` Hermes cron job (`docs/FALLBACK-ORDER.md` / `scripts/capability-registry.ts`'s
`cronCapability()`): no LLM, just a script, every run idempotent. Exact command for whoever sets
up the cron job:
```
bun --bun run "<repo>/scripts/speed-to-lead/run.ts"
```
Suggested interval: every 1 minute, matching the "alert within about a minute" outcome. This is a
live scheduler registration (Hermes cron), which is exactly the kind of change AGENT-RULES.md
reserves for the owner — it is deliberately not done as part of this task.

## Rollback

Nothing here is destructive and nothing has been registered to run, so "rollback" is just "stop
doing the new thing":

- **Marketing acknowledgement / subject tag**: revert `src/app/api/enquiry/route.ts` to the
  previous commit, or set `ENQUIRY_FROM_EMAIL` unset to fall back to the existing 503 behaviour for
  both emails (there is no separate flag — the ack reuses the same three env vars).
- **AgenticOS watcher**: if the cron job in "Patch for lead" above is ever created, remove/pause
  it (`hermes cron remove speed-to-lead` or equivalent). Until that job exists, `run.ts` only ever
  runs when someone runs it by hand — there is nothing scheduled to disable.
- **Data**: the `enquiries` table lives inside `.operator-data/crm.sqlite`, alongside the existing
  `leads` table, and is additive only (its own `CREATE TABLE IF NOT EXISTS`, no change to any
  existing table). Dropping it (`DROP TABLE enquiries;`) removes only speed-to-lead's own records.

## Tests

- `scripts/speed-to-lead/subject.test.ts` — the subject pattern (parses the real format, rejects
  everything else, strips trailing human text).
- `scripts/speed-to-lead/clock.test.ts` — business-hours-aware clock start/due, including rolling
  a Friday-evening enquiry over the weekend onto Saturday's shorter window.
- `scripts/speed-to-lead/store.test.ts` — the CRM table: idempotent upsert, notify-once, respond-closes.
- `scripts/speed-to-lead/watcher.test.ts` — detection: right sender + right subject only, and a
  test that proves a `summary`/body-shaped field on the input can't leak through.
- `scripts/speed-to-lead/panel.test.ts` — the Today-panel projection: since/due minutes, overdue,
  sort order, responded enquiries dropped.
- `scripts/speed-to-lead/run.test.ts` — the wired-together entry point, with the triage store, CRM
  and Telegram notifier all injected: a new enquiry is stored/clocked/notified once; a re-detected
  one is never re-notified; a notify failure leaves `notifiedAt` null for a later retry; rows from
  the wrong sender or an unrecognised subject are ignored.

Every test above exercises either a pure function with synthetic timestamps or an in-memory
sqlite database (`new Database(":memory:")`) — nothing here opens a real mailbox, sends a real
Telegram message, or touches the real `.operator-data` CRM.
On the muv-marketing side, `src/app/api/enquiry/route.test.ts` mocks `fetch` for every test — the
Resend provider never receives a real request from the test suite.

Run: `bun --no-env-file test scripts/speed-to-lead` (AgenticOS) and `npm test` (muv-marketing).
