# Resumed CRM and business workflow acceptance

These statuses describe the resumed CRM-owned tree. Earlier 1,129-test results apply only to the prior assembled local candidate and are not reused here. Actual app mounting, live owner adapters and rendered browser acceptance remain separate gates.

## Business journey

| Requested result                        | Current implementation/evidence                                                                                                      | Remaining gate                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Lead/enquiry to company and contact     | Existing legacy bridge and enquiry adapter; stable references, multiple contacts, manual creation/imports; synthetic contracts 01–03 | Actual mounted UI                                        |
| Company/contact to deal and next action | Editable opportunity, owner, scope, dated next action; ordered journey and actionable dashboard                                      | Rendered keyboard/mobile review                          |
| Proposal draft                          | Versioned draft, frozen reviewed deal version, catalogue/agreed AUD/GST price; no invoice/payment/sending inference                  | Founder review and any external issue remain separate    |
| Project and delivery task               | Exactly one project per linked deal, independent business stages, linked project/deal/contact task fields                            | Actual browser journey                                   |
| Linked result and timeline              | Delivery document/result controls; saved artifacts referenced in place; task completion does not fabricate a result                  | Claude's real job subject/artifact reader                |
| Search/edit/filter/error states         | Indexed contact lookup, stable IDs, retained conflicting drafts, deferred document read/retry, stale data warning                    | Rendered drawer/focus/overflow/unsaved navigation checks |

## Thirteen disposable contracts

All run in `scripts/crm/business-contracts.test.ts`; fixtures use real SQLite CRM, existing durable Jobs and artifact storage, fake research/subject readers and injected HTTP identity. The HTTP handler is invoked without opening a socket.

1. Original legacy ID/history/relationships and old links survive migration
2. Repeated migration/reopen creates no duplicate entities or history
3. Manual founder corrections survive later directory imports
4. Conflicting edits preserve the accepted record and audit
5. Won/retry/reopen creates one linked delivery project
6. Trusted fake Jobs subjects bind the correct record and reject another target
7. Duplicate completion records one activity across restart
8. Older completions cannot regress terminal Jobs or founder CRM state
9. Record/artifact routes resolve the intended saved result and file
10. Unauthorised mutations fail before store access
11. Founder and verified agent attribution remain distinct and cannot be spoofed
12. Interrupted partial work rolls back and recovers once
13. Consistent backup restores relationships, versions, Jobs identity and artifacts

The live Jobs subject persistence/filter is explicitly TODO. Passing the fake-adapter boundary does not prove that owner integration exists.

## Editable business templates

| Template/dashboard                   | Persistence and behaviour                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Website enquiry qualification        | Editable checklist and draft qualification notes                                                          |
| Discovery notes/requirements         | Meeting evidence, scope, access, decisions and open questions                                             |
| Website proposal                     | Explicit deal selection and deal-version check; approved catalogue or reviewed agreed price               |
| Client onboarding                    | Scope/responsibilities, content and secure access checklist                                               |
| Delivery and acceptance              | Agreed criteria, actual checks, defects and explicit acceptance evidence                                  |
| CMS training and handover            | Training/access needs, delivered topics and remaining questions                                           |
| Change/revision workflow             | Requested change, impact, approval and linked next action                                                 |
| Follow-up tasks                      | Open tasks with responsibility and optional explicit date                                                 |
| Maintenance review                   | Recorded review, issues, owner and next review                                                            |
| Client/project next action dashboard | Uses existing records to identify missing/unfinished work; no invented job, payment or deliverable status |

Template versions/provenance and run receipts survive reopen. Customisations are never replaced by new defaults. Exact retry returns the original records; conflicting request reuse fails. Prior template versions are immutable; history caps fail explicitly without deleting earlier receipts. Setup fees and pilot terms remain unapproved. Australian English copy uses placeholders for unknown facts. No task or draft sends anything automatically.

## Actual-browser acceptance

`scripts/crm/browser-acceptance.ts` is an authored, statically checked runner for a permitted browser against Claude's mounted disposable app. It is not DOM-fixture evidence and has not been executed here. The prior cloud visit failed with `ERR_BLOCKED_BY_CLIENT`; no alternate port, browser, tunnel or socket workaround was attempted. Screenshots remain unavailable.

The runner produces report JSON and screenshots at 1440/768/390 and distinguishes completed assertions from manual/never-run items. Claude must finish all unautomated requested checks, including any full interaction flow not run at each width, focus trapping, unsaved navigation, and visual review. No actual-browser pass is claimed by the isolated React/linkedom tests.
