# Receptionist readiness: what we can honestly sell (27 Sep 2026, evening; SMS and retention refreshed 28 Sep)

Sources: `D:/MU-Receptionist-wt-prompt` (branch `fix/prompt-truth-20260927`) `docs/BOOKING-DEMO-ENABLEMENT.md` and `docs/SMS-ENABLEMENT.md` STATUS sections; `C:/Users/Nebula PC/Downloads/HANDOFF-2026-09-27-FINAL.md`; `receptionist-prompt/v3-live-2026-09-27.md`. Re-check both STATUS sections on the morning of any demo: another agent is finishing booking and SMS now.

**Per-prospect demo:** a separate agent is building a per-prospect demo (a demonstration
receptionist generated from a prospect's own public website) at
`D:/MU-Receptionist-wt-prompt/docs/PROSPECT-DEMO.md`. It did not exist as of 27 Sep 2026 evening —
check that doc, not this one, before offering the per-prospect demo close (`05-demo-path.md` §"Per-
prospect demo close", `02-call-script.md` §6). Until it says the steps are live and retested, use
the generic demo (Mode A/B below) instead.

## 1. Capability states

| Capability | State | Evidence | What unlocks it |
|---|---|---|---|
| Answers; says it's automated and the call is recorded | **Live** on +61 485 011 208 (Retell draft agent, prompt v3, applied 27 Sep with owner approval) | `receptionist-prompt/v3-live-2026-09-27.md` | — |
| Takes a structured message | **Live** | same | — |
| 000 line first on urgent wording | **Live** in the prompt | same; audit 27 Sep lists missed danger phrases to fix in QA and prompt | Danger-phrase fixes (engineering) |
| Books into a calendar with a reference | **At go-live**: code committed (`4b8f483`): inbound booking token, demo-calendar confirmation, max 2 bookings/call, change-of-mind | `docs/BOOKING-DEMO-ENABLEMENT.md` | Tests for the new paths; owner yes: deploy + 4 migrations, demo org, Retell booking tools + inbound webhook; 5 retest calls |
| Staff email alert on each booking | **At go-live**: `NEW_BOOKING` alert, idempotent | same | Alert email channel configured in production (owner yes) |
| SMS confirmation / reminder / callback text with STOP | **At go-live**: built and tested (send functions for all three purposes, STOP webhook, reminder cron; 85 tests); **dry-run by default, nothing sent, not deployed** | `docs/SMS-ENABLEMENT.md` STATUS (27 Sep) | Owner yes: sending number +61 485 011 208, Twilio messaging webhook, live env, 5-text test to own mobile (`docs/GO-LIVE-CHECKLIST.md` steps 9–12) |
| Weekly proof report + call QA | **At go-live**: built, synthetic data only | `docs/delivery/ADD-ONS.md` | Real calls after go-live |
| Calendars supported | Google Calendar, Cal.com | `src/lib/calendar/*` | Client grants access at onboarding |
| Practice software (Dentally, Core Practice, Cliniko) | **Not built** | no adapter in `src/lib/calendar` | Not on the roadmap for this pack |
| Live transfer to a person | **Not offered** | `TRANSFER_EXECUTION_ENABLED` defaults false; the 27 Sep audit found a branch announcing transfers that never happened | Build, test, separate owner decision |
| Reschedule / cancel an earlier booking | **Message only** (needs a second-factor channel) | `src/lib/calendar/index.ts` capabilities | Later |

## 2. What a prospect hears today if they ring the demo line
1. The greeting with the recording notice and AI disclosure.
2. It takes a message: name, number, reason, preferred time.
3. It **does not book**. It says the team will call back.
4. Urgent wording: the 000 line first.

**So:** sell booking **at go-live**, and never hand out the number as a booking demo until go-live is approved and retested (`05-demo-path.md`, Mode A vs B).

## 3. Known engineering issues (from `AUDIT-20260927.md`; not for prospects, but they gate go-live)
- Raw Retell webhook payloads were retained indefinitely (CRITICAL, audit B-C1): **fixed in code**. The retention sweep (`src/lib/retention/sweep.ts`) now redacts webhook payloads with the transcripts after each organisation's `retentionDays` (default 90); Retell gets the same window. Confirm the sweep is scheduled in production at go-live.
- Danger-phrase gaps ("isn't breathing", "heart attack", "overdose").
- Sign-in rate limit switched off on the prompt branch.

## 4. Go-live checklist the owner signs once (from the handoff)
Deploy; Vercel Pro; `TRUST_PROXY_HEADERS=true`; alert email env; SMS sender and Twilio messaging config; booking tools and prompt on the Retell agent; the owner's 5 retest calls; 5-text SMS test. **Each item needs the owner's explicit yes.** Nothing in this pack changes any of it.
