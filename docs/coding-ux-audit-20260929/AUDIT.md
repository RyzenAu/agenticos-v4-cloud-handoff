# Coding UX cleanup and eight-destination audit (29 Sep 2026)

Branch `codex/coding-ux-audit-20260929`, based on 7780c08 (draft 7763336 reviewed, kept and revised). Not merged, not deployed, no live provider, no private data, no `.env` read. Receptionist is still NOT SAFE TO SELL until the recorded go-live gates pass; nothing here changes that.

## What changed in Coding

The 7763336 draft was sound in direction and is kept: the composer leads, the separate "Needs you" and "Running" tiles and the duplicate "Waiting on you" card are gone, the jobs list is ordered decisions first, then running work, then most recent, and setup (agents, repos, rules) sits in one disclosure. Every control, filter, deep link (`?request`, `#coding-jobs`, `/coding/$jobId?tab=`), Start-bound-to-digest rule and empty-state test is intact. Revisions on top of it:

1. The job list no longer prints "0 need you · 0 running" above the first-run empty state.
2. Job detail now says so when a refresh fails while showing an earlier read ("Couldn't refresh this job ... Showing the last successful read"). Before, the error was swallowed and the page looked live.
3. Progress copy: "Newest first · showing 20 of 45" replaces the confusing "shown in this history"; an agent state line with no reason no longer prints "(undefined)".
4. Two tests: queue ordering (draft) and the stale/unavailable wording (new).

## Checks against the 7780c08 baseline

| Check | 7780c08 | This branch |
| --- | --- | --- |
| `bun run typecheck` | clean | clean |
| `bun test scripts` | 9757 pass, 23 skip, 32 fail | 9759 pass, 23 skip, 32 fail |
| Failing test names | 32 | same 32, zero new, zero fixed |
| `scripts/coding` plus work/layout/continuity suites | not separately run | 370 pass, 0 fail |
| `bun run build` | exit 0 | exit 0 (only the proxy notice and chunk-size warnings) |

The 32 failures are the known container set from the handoff (200 KB timing, D:\ paths, tailscale identity, workspace and process-tree). They are not fixed and were not skipped.

## Rendering method and limits

Vite dev server on synthetic seeded example data, Chromium at 1280 px, 390 px and 390 px with reduced motion, all eight destinations plus /coding. Every page: no horizontal overflow, no page errors (the only console noise is a blocked external asset via the sandbox proxy). Coding list and detail were also driven with intercepted synthetic API responses for ok, failed and partly stale states. A 200 from a route only proves the SPA shell loaded; the "verified" column below means rendered and read, not that a live integration works. I read the screenshots of Home, Work, Receptionist, Finance, System and Coding closely; Jarvis, Memory and Studio got the automated checks and a lighter look only.

## Per destination

| Destination | Verified (synthetic render) | Synthetic only | Awaiting live or Windows acceptance | Broken or needs a decision |
| --- | --- | --- | --- | --- |
| Home | Renders, no overflow. Unknowns show "Unknown", not zero. Empty daily brief and unconnected sources are honest. | All figures are seeded example data. | Real inbox, calendar, NAB, brief generation. | Repeats itself: the top KPI row (calls, receptionist, sites, emails), the "Running now / Enquiries / Pipeline" row and "M&U at a glance" (clients, open leads, receptionist 0/5) show overlapping numbers. Cut candidates, left because they belong to the receptionist/Leads lane. |
| Jarvis | Renders, no overflow, reduced motion ok. | No live voice. | Real voice, device dispatch, Mehroz PC over Tailscale. | Nothing seen. |
| Receptionist | Renders, honest "Unknown / couldn't read calls / 0 of 7 met / 0 of 5 gates". | Retell not configured, so no call data. | Every go-live gate: real Retell call, Cal.com booking, Twilio number and SMS, billing/GST. | Layout bug: at 1280 px the "Safe to sell?" value wraps mid-word ("Unknow / n") in the four-column stat row. Not touched (other session's lane); the value should use a smaller size or `break-normal` with a shorter label. |
| Work | Renders. Decisions, calls, leads, websites panels show real states. Coding is one drilldown. | Seeded approvals and a seeded "Marden & Rowe HTTP 502". | Live CRM, site probes. | The four top tiles restate the four panels below them (decisions 7 vs Owner approvals 7, and so on). They carry the next-action buttons and are pinned by `work-calm` and `l1-layout` tests, so left. |
| Coding | List and detail verified on synthetic jobs: queue order, next action line, empty, first-load failure, stale wording, 20-of-N progress. | All jobs are fixtures. | A real job through draft, plan, build, test, review and merge approval on the PC with a real model; SSE "Live" state (shown as "Reconnecting" in the mocked run). | Nothing broken. |
| Memory | Renders, no overflow. | Empty vault. | Real vault sync, held-note list, Hindsight bank. | Nothing seen. |
| Finance | Renders. AI spend "at least", bank Unknown until a CSV, Stripe "Not connected", approved prices only (A$699/1099/1999 ex GST). | Package margins are estimates and say so. | Real NAB CSV import, package-payment panel against real invoices. | Nothing seen. |
| Studio | Renders, no overflow. | No generation calls made. | Paid or live generation. | Nothing seen. |
| System | Renders. Model providers "1 of 7", tools "0 of 21 working, 6 broken" stated plainly. | Container tool state, not the PC's. | Windows tool and provider state. | "Plan limits" and "Nearest plan limit" say the same thing; "Models" card and "Model providers" tile overlap. The "In System" tiles repeat the sidebar drilldowns (same pattern on every destination). Left. |

## Duplication that the evidence supports cutting next

The "In <Destination>" tile grid at the foot of each landing page repeats the sidebar drilldowns one for one. The KPI strip plus panels pattern on Home, Work and System says most numbers twice. Both are structural and shared, so they belong in a separate change with the receptionist/Leads session settled, not folded into this one.

## Not done

No deploy, restart, merge to main, live provider call, private audio or dataset access. Windows acceptance list in `docs/cloud-next-integration-20260929/HANDOFF.md` still applies unchanged.
