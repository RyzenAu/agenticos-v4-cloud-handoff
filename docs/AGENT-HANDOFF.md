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
