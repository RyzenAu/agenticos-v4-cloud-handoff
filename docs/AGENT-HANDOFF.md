# Community source handoff

This is a clean community copy of Agentic OS 3.6.0. It contains the onboarding, dashboard, inbox, shared chat/calendar composer, memory views, voice and creative tools. Internal development handoffs and private account validation notes were intentionally excluded.

Read START-HERE.md before running the app and RELEASE-CHECK.md for the checks performed on this package. Integrations require the recipient's own authorization. Do not infer account access from a provider logo or a successful build.

Preserve the recipient's private state when modifying this installation. Do not import histories, connect providers, generate paid media, install scheduled jobs or publish anything without authorization for that action.

Use synthetic fixtures for tests and keep release artifacts separate from configured workspaces.

## Call queue and receptionist gates (27 September 2026)

Independent-review fix round: queue eligibility now also requires a recorded call action; cards preserve that action text, preview status, copy controls and stuck warnings. Verified website absence retains its recorded check date. Receptionist readiness uses a distinct Evidence missing state with corrective steps and blocks sign-off in that state. Owner retest counts require explicit per-call attribution; the current Retell adapter does not supply it, so live data says “not yet tracked — count from Retell call history”. The encoding regression now demonstrates that actual snapshot UTF-8 separators and masked bullets corrupt under the old missing-charset response and survive the existing UTF-8 response header. No source transcoding was found or added. Bun tests and browser review remain for the lead; no server, background job or commit was started in this fix round.

The Leads page now puts scheduled calls due today or earlier in Sydney above the overview and filters. The queue uses call statuses (new, to_call, no_answer, voicemail, call_back), requires a phone and a valid due date, and excludes closed/excluded records. Priority matches the CRM's callback-first, then score convention; due time and ID break ties. Calling hours reuse the existing Sydney/holiday policy, with disabled queue call links outside hours.

Default list cards show website verification, linked issue evidence, owner, status, last touch and the next action with Sydney due time. Score, ID, source, website check, pitch/stage and historical reasons are under Details. An automated empty website search is never presented as human-confirmed absence. Website evidence is invalidated when its URL differs from the current lead URL.

Receptionist gates distinguish automated eval reports from qualifying phone calls; the current records cannot attribute calls to owner tests, and the UI states that explicitly. An incomplete derived call gate is Not tested. A changed prompt that loses signed-off evidence reopens the gate. JSON responses declare UTF-8 to prevent legacy Windows HTTP readers decoding separators and masked phone bullets as Latin-1.

No server or background jobs were started for this change. Desktop/360px/390px render review remains for the lead after merge, as requested.

Builder verification: Node TypeScript `--noEmit -p .` passed; 14 lead regression tests passed through a Node compatibility runner, three readiness smoke checks passed, and the old/new JSON header reproduced/fixed the legacy decoding failure. The design detector and `git diff --check` were clean. Bun was unavailable in the session, so the Bun baseline/full suite and requested Bun command remain unverified. Staging was denied at the shared Git index lock outside this writable worktree; no commit was created. The local done-gate implementation run under Node reports a dirty tree. Finish the Bun checks, commit these paths and rerun the requested done gate before treating this as complete.

## Leads cloud refinement (1 October 2026)

Cloud-only patch based on the read-only `228bd23244b5aa7d96676d92f897c64ab9601656` export. Claude owns eventual integration; no PC source edits, live provider checks, push, merge or deployment were performed.

Leads opens into a focused prospect workspace, with the existing overview/call queue under Today. The default list is one set of compact business/website/next-step rows; the existing drawer owns contact details, evidence, preview history and actions. Search, website shortcuts and the three grouped advanced-filter sections share one control area. Repeated descriptions, count lines and per-lead missing-data boilerplate are removed. A shared pure selector applies multiword relevance search and schema-backed filters consistently across list, table and board. Search covers name, area, address, website and email, preserves phone digit order across formatting/country-code variants, and treats `#ID` as an exact identifier. Filters include website presence, stage, owner, source, contact presence, creation window and Sydney-calendar follow-up dates. Table defaults to that shared ordering; selecting a column still explicitly sorts it. Expanded cards survive the background polling clock; changing filters resets paging.

Website absence remains the existing explicit empty-URL plus `deal.websiteStatus=no_website_verified` state. Empty/invalid URLs, social-only links, and wrong-site evidence stay separate. Filters do not establish outreach permission or contact verification. Find leads defaults to OSM and optionally selects no-listed-website candidates before its cap. Stored source attribution and known owner-corrected rows are retained, and result counts explain skips/caps/discovered/inconclusive sites. Explicit OSM locality tags improve website matching without changing the stored search area. Concurrent discovery answer tracking is per lead, so a successful search for one lead cannot turn another failed lookup into absence evidence. Inconclusive checks leave no absence timestamp.

Synthetic tests cover these behaviors and existing lead/edit/deal/dedupe/provider contracts. Scoped UI and discovery TypeScript checks passed. Full build/tests, canonical integration verification, and rendered desktop/mobile QA must be checked against the accompanying verification report; a scoped pass is not a release pass. The export's safe empty graph index is build-fixture data and must never replace the operator's private graph index.
