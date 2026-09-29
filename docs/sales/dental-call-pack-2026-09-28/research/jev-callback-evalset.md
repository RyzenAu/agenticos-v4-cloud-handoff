# Synthetic caller phrases — "when do you want the callback?" parsing

**Fixed context used for every row**

| Item | Value |
|---|---|
| Call time | Mon 28 Sep 2026, 19:40 (Sydney) — practice already closed |
| Practice hours | Mon–Fri 08:00–17:00; closed weekends and public holidays |
| Date map | tomorrow = Tue 29 Sep · this week = 28 Sep–2 Oct · next week = 5–9 Oct · "Thursday week" = Thu 8 Oct · week after next = 12–16 Oct |
| Window rules | morning 08:00–12:00 · lunch/midday 12:00–14:00 · arvo/afternoon 12:00–17:00 · "after X" = X→17:00 · "before X" = 08:00→X · exact time = 30 min · "around X" = 60 min |
| `null` rule | If the resolved time falls entirely outside practice hours, or has already passed, both start and end are `null` and `needs_human_check` = `true`; the requested time goes in Notes |
| `needs_human_check` | `true` when the day is assumed, the phrase is vague, self-contradictory, a public holiday, or outside practice hours |

All phrases are synthetic. No real names, numbers or patient details.

| # | Caller phrase (synthetic) | Type | start | end | confidence | needs_human_check | Notes |
|---|---|---|---|---|---|---|---|
| 1 | "Tomorrow at 9:30, thanks." | Clear | Tue 2026-09-29T09:30 | Tue 2026-09-29T10:00 | high | false | Explicit day + time. |
| 2 | "Wednesday around 10 works for me." | Clear | Wed 2026-09-30T10:00 | Wed 2026-09-30T11:00 | high | false | "Around" → 1-hour window. |
| 3 | "Thursday at 4pm." | Clear | Thu 2026-10-01T16:00 | Thu 2026-10-01T16:30 | high | false | Fits inside hours. |
| 4 | "Ring me Friday afternoon, any time." | Clear / vague | Fri 2026-10-02T12:00 | Fri 2026-10-02T17:00 | high | false | Block clear; exact time left to staff. |
| 5 | "Monday morning next week, ta." | Clear | Mon 2026-10-05T08:00 | Mon 2026-10-05T12:00 | high | true | Mon 5 Oct 2026 is NSW Labour Day — practice likely closed, confirm and offer Tue 6 Oct. |
| 6 | "Tuesday, about 12:30 — my lunch break." | Clear | Tue 2026-09-29T12:30 | Tue 2026-09-29T13:00 | high | false | |
| 7 | "After 3 on Wednesday." | Clear | Wed 2026-09-30T15:00 | Wed 2026-09-30T17:00 | high | false | Ends at practice close. |
| 8 | "Before 9 tomorrow if you can." | Clear | Tue 2026-09-29T08:00 | Tue 2026-09-29T09:00 | high | false | Starts at practice open. |
| 9 | "Tomorrow at 8am sharp." | Clear | Tue 2026-09-29T08:00 | Tue 2026-09-29T08:30 | high | false | Earliest bookable slot. |
| 10 | "The 6th of October, morning-ish?" | Clear | Tue 2026-10-06T08:00 | Tue 2026-10-06T12:00 | high | false | "‑ish" softened only slightly; date is explicit. |
| 11 | "Give us a bell tomorrow arvo." | Slang | Tue 2026-09-29T12:00 | Tue 2026-09-29T17:00 | high | false | Arvo = afternoon. |
| 12 | "I'll be on smoko about 10 tomorrow." | Slang | Tue 2026-09-29T10:00 | Tue 2026-09-29T10:30 | med | false | Smoko ≈ mid-morning break; treated as approximate. |
| 13 | "Friday just before knock-off." | Slang | Fri 2026-10-02T16:00 | Fri 2026-10-02T17:00 | med | false | Knock-off = 5pm close. |
| 14 | "Cobber, this arvo's no good — make it Thursday morning." | Slang + self-correct | Thu 2026-10-01T08:00 | Thu 2026-10-01T12:00 | high | false | First option withdrawn; note "this arvo" had already passed at 19:40. |
| 15 | "Yeah nah, tomorrow arvo's cactus — Wednesday arvo instead." | Slang + self-correct | Wed 2026-09-30T12:00 | Wed 2026-09-30T17:00 | high | false | Final stated option wins. |
| 16 | "Sometime Tuesday arvo, no rush." | Slang / vague | Tue 2026-09-29T12:00 | Tue 2026-09-29T17:00 | med | false | Day and block clear; exact time left to staff. |
| 17 | "Thursday week, any time." | Slang idiom | Thu 2026-10-08T08:00 | Thu 2026-10-08T17:00 | med | true | "Thursday week" = Thursday of next week; confirm idiom reading. |
| 18 | "Sometime in the morning." | Vague | Tue 2026-09-29T08:00 | Tue 2026-09-29T12:00 | med | true | No day given; day assumed = next business day. |
| 19 | "Later today, if that's alright." | Vague / passed | null | null | low | true | Call is 19:40 Mon; today's 08:00–17:00 window has gone. Offer Tue 29 Sep. |
| 20 | "Any time after 4, I finish work then." | Vague + rule | Tue 2026-09-29T16:00 | Tue 2026-09-29T17:00 | med | true | Only a 1-hour usable window; day assumed. |
| 21 | "Ring after school pick-up, about 3:30." | Vague / context | Tue 2026-09-29T15:30 | Tue 2026-09-29T16:00 | med | true | Day assumed; time rounded from context. |
| 22 | "Not this week — the week after next." | Relative week | Mon 2026-10-12T08:00 | Fri 2026-10-16T17:00 | med | true | Whole-week window; staff pick a slot. |
| 23 | "Tomorrow, same time as now?" | Contradictory | null | null | low | true | 19:40 is after practice close (17:00); caller likely means their own availability. Confirm. |
| 24 | "Whenever's good, I'm flexible." | No time | null | null | low | true | No time information at all. |
| 25 | "No idea — whatever suits the practice." | No time | null | null | low | true | No time information at all. |
| 26 | "Any day but Monday, and not before 10." | Exclusion only | Tue 2026-09-29T10:00 | Tue 2026-09-29T17:00 | low | true | Only exclusions given; day not chosen — staff to propose. |
| 27 | "I'm free Tuesday but not between 1 and 3." | Exclusion | Tue 2026-09-29T08:00 | Tue 2026-09-29T13:00 | med | true | Second admissible window 15:00–17:00 also exists; structure holds one start/end. |
| 28 | "Anytime after 6pm, any evening." | Outside hours | null | null | med | true | Practice phone hours end 17:00; offer next-day 08:00–17:00 or a message. |
| 29 | "Ring me back Sunday afternoon." | Closed day | null | null | low | true | Practice closed weekends; next business day is Mon 5 Oct — check Labour Day, else Tue 6 Oct. |
| 30 | "Labour Day Monday's fine, any time." | Public holiday | null | null | med | true | Mon 5 Oct 2026 is NSW Labour Day; practice likely closed. Confirm and offer Tue 6 Oct. |

**Two practical flags for the call pack**

1. **Early windows.** Rows 5, 8, 9, 10, 17 and 27 resolve to windows that *start* at 08:00 — inside the practice's hours but **before M&U's own 9am–8pm calling window**. Either hand those callbacks to practice staff, or agree a 9am-or-later slot on the call.
2. **Holidays and closures.** Rows 5, 29 and 30 all hinge on Mon 5 Oct 2026 (NSW Labour Day). The parser should always be checked against the practice's own closure list before a slot is promised — which is exactly why `needs_human_check` is `true` on those rows rather than the AI guessing.

Both flags keep the pilot inside its honest scope: it records what the caller asked for and flags anything uncertain for a person to confirm — it never books, confirms or advises.
