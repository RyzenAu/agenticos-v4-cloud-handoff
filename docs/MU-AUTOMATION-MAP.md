# How much of M&U can Jarvis automate (23 Sep 2026)

Research: NotebookLM "M&U automation map" (`0bd17b71-804a-48cf-ab05-3d0c2667473f`, 35 sources:
small-agency case studies, the Hermes cron/skills docs, the wiki's M&U pages).

**Where M&U actually is** (wiki, via the notebook):
- Nothing bills yet.
- Cold outreach was cancelled on 15 Sep, and the prospect previews are retired.
- MU-Receptionist is a sandbox-verified prototype.
- The target is $100k/month.

So the work that recurs today is building, research, inbox/admin and coordination between the
two founders, not client reporting or invoicing.

**Hours are estimates** (marked ~). Replace them with your real weekly numbers once and the ranking
recalculates. Score = hours saved per month × confidence ÷ build effort (days).

## Ranked

| # | Work | Now ~h/week | Automation with the existing stack | Human / approval point | Build | Saves ~h/month | Conf. | Score | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Inbox triage (both founders) | ~3 | Morning brief: Gmail read tools via `claude -p`, Jev urgency, Telegram 7:30 | nothing is sent; replies stay human | 0.5 d | ~8 | 0.8 | 12.8 | **shipped (brief D)** |
| 2 | Keeping each other in sync: what shipped, what's stuck | ~1.5 | `founders-weekly`: commits + next actions + wiki log + owner actions, Monday 8:00 | read-only | 0.5 d | ~4 | 0.7 | 5.6 | **shipped** |
| 3 | Checking live sites are up | ~0.5 | `site-monitor`: status, speed, TLS, expected text every 30 min; silent when healthy | read-only | 0.25 d | ~2 | 0.9 | 7.2 | **shipped** |
| 4 | Meeting follow-ups (Granola) | ~2 | Hermes job after each meeting: decisions + action items to the wiki inbox and Telegram (the `meeting-wrap-up` skill exists in Claude Code) | writes to the wiki need his yes | 1 d | ~6 | 0.6 | 3.6 | next |
| 5 | Research for builds (sources, competitor sites) | ~4 | NotebookLM skill + Hermes: "make a notebook about X" → cited answers to the wiki | he picks the question | 1 d | ~8 | 0.5 | 4.0 | partly (manual) |
| 6 | Site QA before showing a client | ~2 | `mu-concept-qa` run by a cron on the flagship demo after each commit; contact sheet to Telegram | a human judges design | 1.5 d | ~5 | 0.5 | 1.7 | next |
| 7 | Receptionist client reporting (once live) | 0 now | weekly KPI report from the usage ledger (SOP §9) | sent only after a founder reads it | 1 d | ~2/client | 0.7 | — | after the first clinic |
| 8 | Proposals | ~1 | draft from the discovery-call transcript + rate card; never auto-sent (the research shows generated prices and scopes go wrong) | the founder writes the numbers | 2 d | ~2 | 0.4 | 0.4 | after the rate card |
| 9 | Invoicing | 0 now | Stripe metered billing is already designed in MU-Receptionist (`BILLING-POLICY.md`) | invoices checked by a founder | — | — | — | — | wait for revenue |

What the research says to keep human, and why it applies here:
- **Client relationships and discovery calls, positioning, pricing.** AI can't set a brand's
  positioning or earn trust.
- **Final voice on anything published.** Readers spot "AI slop"; blogs turned into "a competent
  stranger wrote it" within six weeks.
- **Approval before any outbound message.** Automated follow-ups dropped close rates and felt like a
  demotion to warm contacts.
- **Complaints and refunds.** Canned replies ended up quoted in public reviews.

Proposal generators invented prices (quoting $12,500 for a $25,000 scope).
Source: propal.io 2026 comparison (notebook).

Evidence that it pays off for agencies of two to five people. These are published claims, not M&U numbers:
- A two-person agency tripled output with Claude Code over MCP: 4 to 12 posts and 2 to 5 sites a
  month, with client updates cut from 30 to 5 minutes (RSL/A).
- A four-person agency went from 60 to 35 founder hours a week, and from $25k to $40k/month in
  pipeline, with three AI systems (DEMG.ai).
- Content repurposing went from 3 hours to 20 minutes a week (MITPO).

## Shipped automations

| Job | Schedule | Cost | Acceptance |
|---|---|---|---|
| `founders-weekly` (`ede730ae90d7`) | Mon 8:00 | one GPT-6 Sol run a week (subscription) | PASS: last run ok; digest has the Shipped and This-week lines |
| `site-monitor` (`e890f43abf15`) | every 30 min | $0 (no model) | PASS: simulated outage recovery reported, second run silent |

Both deliver to Usman's Telegram DM. Point them at the founders' group once it exists
(`hermes cron edit <name> --deliver telegram:<group id>`).

## Next five, with effort

1. Meeting follow-ups from Granola to the wiki inbox (1 day).
2. A NotebookLM research job Jarvis can run on request (1 day; the skill exists, add a Telegram trigger).
3. `mu-concept-qa` on the dental flagship after each commit (1.5 days).
4. Receptionist weekly KPI report (1 day, after the first clinic).
5. Proposal first draft from the call transcript + rate card (2 days, after the rate card).

## One question for the owner

Rough hours per week for each row in the table (just the "Now" column), for you and Mehroz.
That turns the estimates into real numbers.
