# Task for Dot: the first cross-department journey (backend)

Owner's requirement (4 Oct): "choose an existing permitted lead → research → website concept → draft quote/proposal → save
and link everything to its CRM record → return the result to the originating conversation." Spoken to Jarvis once. Client
messages stay unsent; Brooke/Bianca and the receptionist hold are untouched. Frontend (department views, progress, handoff
steps) is Claude's; this file is the backend half. Production revision when observed: `f15c01e0`.

## What production does today (observed through the Jarvis page, 4 Oct 19:15–19:25 AEDT, lead "Westpoint Dental Clinic", `legacy-company-5`, deal `legacy-deal-5`)

| Utterance | Result | Failure |
|---|---|---|
| "For the lead Westpoint Dental Clinic: research the business, make a website concept, draft a proposal, and save and link everything to its CRM record." | Jev sent the whole sentence to the Research computer as ONE `control` job; failed at once: "I'm not sure what to do next on ? (0% sure), so I stopped." | **J1** no plan for a compound request; **J2** job has no `subjects` (no CRM link) and no decision record |
| "research Westpoint Dental Clinic in Blacktown (…): services, location, what their website is missing, with sources" | Works: sourced report back in the conversation (job `92a914fa`, ~1 min) | **J3** result not linked to the company/deal and not saved as a CRM activity or document |
| "make a website concept for the lead Westpoint Dental Clinic" | Sent to a computer: "I couldn't read the computer: No page is open on this computer." (job `4200ae82`) | **J4** misrouted; the lead-site preview generator (`scripts/lead-sites/*`, the founder-requested one-off preview with its safeguards) is the right lane |
| "draft a proposal / a quote for the Westpoint Dental Clinic opportunity deal" | "Confirm this deal's agreed price before drafting a proposal." | **J5** correct guard (`commercialBasis: legacy-unconfirmed`); the journey must handle it explicitly, never infer a price |

## Build (one PR, `dot/lead-journey-<date>`)

1. **A durable journey (workflow) record** that reuses jobs, conversations and CRM records. Fields: id, conversationId (the
   originating one), requestedBy, subjects (`crm:company:<id>`, `crm:deal:<id>`), steps. Each step is a handoff with ONE
   accountable owner (department/agent), inputs, expected output, dependencies, acknowledgement time, and a completion or
   failure record (with the job id it ran as). Bounded: max steps per journey, max retries per step (e.g. 1), max delegation
   depth (no step may spawn a journey); a step that fails ends the journey as failed with what was saved so far. Restart-safe
   (re-watch like `resumable` coding jobs). Contract notes from the frontend side: `docs/programme-20261001/R12-DEPARTMENTS-CONTRACT.md`
   on Claude's design branch (Claude will copy it here when it lands).
2. **Jev decides; code executes.** Jev returns a typed decision `journey: "lead-to-proposal"` with the resolved lead (exact CRM
   match, or one question if ambiguous); deterministic code builds the steps. Keep the decision record on the journey.
3. **Steps for `lead-to-proposal`:**
   - Research (Research department, Research computer): a concrete research goal built from the CRM record (name, website,
     locality); the job carries the subjects; the report is saved to the company as an activity/document (drafted, internal).
   - Website concept (Design/Websites): the existing lead-site preview generator for that lead, as a founder-requested
     one-off (the journey request is the founder's click); preview URL + screenshot saved to the CRM record. Respect the
     existing preview safeguards; nothing is sent to the client.
   - Quote/proposal (Sales/CRM): if the deal is unpriced (`legacy-unconfirmed`/`pending`), the step asks ONCE in the
     conversation: "Use the approved website catalogue offer for this draft?" A yes sets the deal to the approved
     `website` catalogue item (an explicit, recorded change), then `crm.quote.package` / `crm.proposal.draft`. Never infer
     another price. Drafts only.
   - Report: one message back to the ORIGINATING conversation with the research summary, the concept link, the draft
     link and the CRM record link; or exactly which step failed and what was saved.
4. **Truthful states** on the journey and every step: queued, running, waiting (on the founder), failed, completed.
   Stop stops the running step and the rest (durable, like your command-admission work).
5. **Routes** for the frontend (read): `GET /__journeys?conversationId=&subject=`, `GET /__journeys/<id>`; Stop through the
   existing cancel path. Classify them in `scripts/identity/routes.ts`.

## Done when

- A focused test drives the journey with fakes (research, preview, CRM) end to end, plus: ambiguous lead asks once; unpriced
  deal asks once and only a yes changes it; a failed step ends the journey with a truthful record; Stop mid-journey; restart
  mid-journey resumes or reports truthfully; retries and delegation are bounded.
- On a synthetic hub, the same journey runs from one typed request.
- PR against `handoff/claude-dev-baseline-20261004` (or the newest baseline); Claude integrates, releases, and demonstrates it
  on production through the Jarvis page with a real permitted lead.
