# CRM statuses — for two people actually dialling

Drafted by DeepSeek V4.1 Flash (free, through the Cline bridge) and edited by Claude Opus 5.5. Updated 27 Sep for the booking receptionist. It maps each status to the existing `/leads` stages so nothing new has to be built for Monday.

**Every record carries:** practice + suburb, role reached (not a personal mobile), lead source and date, **next action + date** (never blank), **owner** (exactly one person, or you'll double-dial) and an opt-out flag that overrides everything.
**Two rules:** one dial per practice per day; a maximum of three attempts in each "trying" status before closing.

| # | Status | Means exactly | Next action | When | CRM stage today |
|---|---|---|---|---|---|
| 1 | **New – to call** | On the list, not dialled | First dial | Within 2 business days | to-contact |
| 2 | **No live contact** | Rang out, voicemail or hung up before talking | Retry at a different time band. One voicemail per week at most | 2–3 business days. After 3 tries → 9 | contacted |
| 3 | **Gatekeeper** | Spoke to someone who isn't the decision-maker | Get the role and a good time. Call back then | 2 business days. After 3 tries → 9 | contacted |
| 4 | **Call back – time agreed** | They named a time | Call at exactly that time | The agreed time | contacted |
| 5 | **Talked – no demo yet** | Real conversation with the decision-maker, no demo | One follow-up referencing what they said | Their time, or 4–5 business days. After 3 touches → 9 | interested |
| 6 | **Info requested** | They asked for an email | One email, Usman approves it (script §8). Follow up once | Email same day; follow-up call 3 business days later | interested |
| 7 | **Demo booked** | 15-minute demo scheduled | Calendar invite by email; reminder the business day before | — | meeting |
| 8 | **Proposal sent** | Demo held; they asked for the proposal (Usman approved it before sending) | One follow-up answering open questions and asking yes or no | 2 business days after | proposal |
| 9 | **Closed** + reason | Declined / no contact after max tries / wrong number / not a fit (e.g. practice software only, no separate calendar) | None. Keep the record for audit | — | closed |
| 10 | **Won – awaiting go-live** | Signed proposal and agreement (billing per the signed agreement) | Onboarding kickoff (`14-onboarding.md`) once booking go-live is approved | Within 2 business days | won |
| — | **Do not contact** (flag) | Asked us to stop, complained, or unsubscribed | Apologise once, end the call. Flag every number and duplicate **within 5 minutes**. Never delete the record | Never again | closed + opt-out |

**Do-not-contact is permanent and overrides every status.** If they later call *us*, that's their call; we still never cold-call them again.

**Calendar note (log on every real conversation):** Google Calendar / Cal.com / practice software only / would use a dedicated booking calendar / unknown. It decides fit (`10-qualification.md`).
