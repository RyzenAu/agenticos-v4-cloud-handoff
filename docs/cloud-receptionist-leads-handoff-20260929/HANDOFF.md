# Receptionist handoffs in the Command scene (cloud/receptionist-leads-handoff-20260929)

From `7780c08` (verified, clean). Synthetic only: no live Retell, Cal.com or Twilio, no customer data, no provider calls. Not merged, not deployed. **The receptionist stays NOT SAFE TO SELL until its recorded go-live gates pass; nothing here changes that.**

## What the OS can and cannot say (the source audit)

Trusted source: MU-Receptionist's agency feed, read server-side, shaped by `scripts/receptionist/dashboard.ts` and served at `/__receptionist/dashboard` (blocks carry `asOf`, `stale`, `partial`). Its default metadata view holds counts per client only: staff alerts pending/failed, call transfers failed, callbacks pending. Per-call rows and follow-up items (with ids) exist only in the "full" feed view, which carries masked caller content and is not what the dashboard reads.

**Missing source, exactly:** nothing links a receptionist call to a CRM lead. `scripts/leads` holds outbound prospects; it has no call id, origin or receptionist field. No per-event alert acknowledgement is exposed either (only cumulative "sent" counts). So a real "call became a saved lead" or "staff was told about call X" event cannot be shown, and is not faked. The scene says: "Setup required. Call to saved lead: not connected."

## What was built

- `src/components/shell/receptionist-handoff.ts`: `receptionistHandoffs(dashboard, now)` turns the feed's counts into staff handoffs with stable ids (`rx:staff-alerts:failed|pending`, `rx:transfers:failed`, `rx:callbacks:pending`), each stamped with the block's own read time and labelled as a count, not a call. Failed staff alerts and transfers are Failed; pending alerts and callbacks are Queued, never Done. A failed or missing read, a block with no read time or older than 30 minutes (or its own tighter window), or a counter the feed didn't send gives one "Not confirmed" row saying why, never a stale "queued" and never a zero. Partial counts say "at least".
- Typed seam `fromSourceEvent(event)` for a future per-event source: `lead-saved` is Done only with a lead id, `staff-alert` only with an ack, `call-transfer` only with a connected status. Confirmed without that evidence is Not confirmed. Ids and times are validated.
- Shared signal (`handoff.ts`): new state "unknown" (Not confirmed), new place "staff" (no scene object, so it lights nothing), new source "receptionist-feed", a `basis` line, feed rows stay only while the feed still says them, and `claimSweep`.
- Scene (`command-scene.tsx/.css`): reads the dashboard when open (same query key as the Receptionist page), lists rows with source, basis and freshness, and shows the lead-link gap line permanently. A sweep plays once per handoff state per browser session (session storage, and it marks itself played on animation end), so refresh, retry, a changed count or reopening the scene never replays it. Reduced motion, reading, editing and speaking stay still (existing rule); failed, unknown and waiting never animate.

No change to Jev, Jarvis, models, memory, device rules, pricing or the receptionist gates.

## Evidence

| Check | Result |
| --- | --- |
| New `scripts/receptionist/scene-handoff.test.ts` | 24 pass: confirmed/failed/queued, evidence rules, stale/missing/partial/unknown, retry and dedup, no phone/email/booking/SMS/lead wording, reduced motion and holds |
| Focused (`scene-handoff`, `nexus-interface`, `integration`) | 40 pass, 0 fail |
| `bun run typecheck` | clean |
| `bun run build` | built, exit 0, no closeBundle warning |
| Full `bun test scripts`, candidate 7780c08 | 9757 pass, 32 fail |
| Full `bun test scripts`, this branch | 9780 pass, 33 fail. 32 are the same names as 7780c08 (all also in the e9366d8 baseline). The 33rd, `cancellation > a running command is cancelled on the companion within a bounded time` (`scripts/devices/companion.test.ts`, a wall-clock bound), passed 3 of 3 alone on this branch and 2 of 2 on unmodified 7780c08 (`scripts/devices` 106 pass 0 fail each time), so it is load timing under the full run, not caused by this change (which touches no device code). Not counted as fixed or as a regression proven either way. |

Browser (vite dev in a throwaway HOME, headless Chromium, `/__receptionist/dashboard` answered by a synthetic mock inside the test browser only): at 1280 px, 390 px and 390 px with reduced motion, no horizontal overflow and no page errors. Live-shaped counts drew Queued and Failed staff rows with source and "Updated 2 min ago"; a 500 drew one Not confirmed row; a 2-hour-old block drew one Not confirmed row, not the count. An `os:handoff` receptionist-to-Leads event swept once on first open and was still on reopen. Screenshots: `docs/cloud-receptionist-leads-handoff-20260929/screenshots/handoffs-*.png`.

## Unresolved

- No call-to-lead link and no per-event staff-alert ack exist, so those handoffs cannot be confirmed yet. Smallest fix in MU-Receptionist/CRM: a per-call handoff record with the call id, a saved-lead id (or alert ack) and a status, exposed in the metadata view without caller content; then map it through `fromSourceEvent`.
- The feed rows are aggregates across clients, so a staff alert count cannot be tied to one call or one client here.
- Only the metadata view was assumed; the "full" view's follow-ups were deliberately not used.

## Windows and live acceptance still required (not cloud-verified)

1. On the PC with the real feed configured, open the scene and the Receptionist page; confirm the counts match the dashboard tiles and the read time is the feed's, not the page's.
2. Force each case: feed unreachable (Not confirmed), an old read (Not confirmed after 30 min), a real failed staff alert (Failed), a pending callback (Queued).
3. Live Retell call on the receptionist number: confirm the transfer and callback counts move, and that nothing in the scene claims a booking or SMS.
4. Cal.com live booking test and Twilio SMS test with recorded results; the scene must still not imply either, since no per-call source exists.
5. Confirm the go-live gates and billing/GST checks are recorded; only then can the receptionist be reconsidered for sale.
6. Windows reduced-motion setting on: no sweep anywhere.
