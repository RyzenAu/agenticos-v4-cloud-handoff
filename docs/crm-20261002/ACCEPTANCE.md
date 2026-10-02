# Requirement-by-requirement acceptance

Status terms: **implemented/tested** means scoped automated synthetic evidence; **integration pending** means the defined hook needs the owning service; **blocked** means attempted but unavailable. None implies live release acceptance.

| Requirement | Implementation and evidence | Status / remaining gate |
|---|---|---|
| Exact agreed baseline, manifest, ownership | Full Git/manifest hash verification; dedicated child branch from exact e9ad7c2 | Verified; original tarball bytes not independently checked |
| Preserve current Leads search, phone/ID, evidence, concurrent discovery, locality, edits/imports | Existing modules retained; original regression suite included | Implemented/tested; live dataset untouched |
| One authoritative CRM | New related tables reuse existing crm.sqlite and deliberate legacy bridge | Implemented/tested |
| Manual companies, stable IDs, fields, owners, tags, provenance | Store + typed ops + company editor | Implemented/tested |
| Multiple contacts, primary contact, role/preferences/restrictions | Foreign-key relationships, primary selection, monotonic suppression | Implemented/tested |
| Multiple opportunities and lost deal not closing company | Independent deal records; lost reason/history | Implemented/tested |
| Separate sales/delivery stages; editable pipeline retaining history | Configurable stages with archived historical references; delivery project status separate | Implemented/tested |
| One-off/recurring AUD, GST, dates, agreed prices | Integer cents, existing catalogue, explicit tax treatment, ex-GST aggregate totals | Implemented/tested |
| Activities versus tasks | Immutable event log; distinct task lifecycle and due dates | Implemented/tested |
| Completion, reopen, reassignment, promises | Typed operations and UI; synthetic lifecycle and DOM tests | Implemented/tested |
| Stable activity/provider events; concurrent retries | Payload-conflict checking, unique provider occurrence, four-process SQLite tests | Implemented/tested |
| Onboarding/delivery, scope, content/access requests, milestones, previews/revisions/deliverables/renewals | Project records/editors; Won triggers one onboarding through durable Jobs | Implemented/tested |
| Versioned documents, draft/issued/accepted | Append-only content/pricing versions with status history; UI records historical status, never signs/sends | Implemented/tested |
| Migration dry run/counts/orphans/ambiguities | Schema v1, refusal on invalid relationships, original-row hashes | Implemented/tested; live dry run pending Claude |
| Backup/restore/rollback/repeated migration | Verified consistent backup, preserved originals, disposable rollback/reopen | Implemented/tested |
| Preserve opt-outs/exclusions/duplicate history | Existing suppression registry; cross-record propagation; original duplicate rows retained | Implemented/tested |
| Source-storage restrictions and website states | Independent Google field origins only; old evidence/files referenced in place | Implemented/tested |
| Today, actionable next steps/meetings/delivery | Routes open relevant company/deal/task/editor | Implemented/tested via selectors/DOM; rendered gate blocked |
| Pipeline board/table, configurable stages and finances clearly distinct | Net-of-GST pipeline totals; Won separate from Finance invoice evidence | Implemented/tested via selectors/DOM; rendered gate blocked |
| Company/contact lists, filters/search/saved views/duplicate review | Typed selectors and operations, reviewable merge | Implemented/tested |
| CSV preview/validation/conflict decisions/export | Bounded parser, formula-safe CSV export, atomic commit/stale checks/idempotency | Implemented/tested |
| Company Overview/Timeline/Deals/Delivery, editable fields | Existing design system and isolated CRM components | Implemented/tested via DOM; rendered gate blocked |
| Error recovery and concurrent edits | Frozen editor version, dirty-only patch, preserved drafts, uncertain-write warning | Implemented/tested |
| Old Leads URLs and commands | Retained; stable legacy references plus canonical merged targets | Implemented/tested |
| Email/thread/meeting links and call outcomes | Linked activities with draft/queued/sent/received/failed/unknown states | Implemented/tested; trusted live provider evidence readers pending |
| Delivery-confirmation honesty and no duplicated messages | Sent/received require verified target-bound provider evidence; event uniqueness | Implemented/tested; no live sending or invitations |
| Existing Finance invoice/payment link, no new ledger | Exact invoice-reference URL to read-only existing Stripe snapshot; stale/unknown explicit | Implemented/tested; other providers need existing Finance reader support |
| Equal Usman/Mehroz access, responsibility not permission | Existing principal/CSRF/session contract, no owner read restriction | Implemented/tested with both founders; real sessions pending |
| Jarvis typed operations/context/receipts | Same registry as HTTP; strict active-reference resolution; persisted receipts | Implemented/tested; Claude owns actual voice/intent dispatch |
| Existing jobs/accounts/model/progress/results | Durable JobService; existing job detail and artifact links | Implemented/tested; actual subject/account fields depend on Claude's Jobs contract |
| Memory contextual only | No memory-to-CRM overwrite path | Implemented/tested contract |
| Six automation rules with enable/trigger/action/outcome/error | Existing Jobs adapter, semantic dedupe, UI controls; no new scheduler | Implemented/tested; Won wired; external/timed source adapters pending owning services |
| Complete enquiry-to-follow-up synthetic journey | operations-journey.test.ts plus SQLite/Jobs restart and concurrent retry tests | Implemented/tested |
| Responsive layout, keyboard, reduced motion | Responsive classes/design system; keyboard tab/form/CSV/board DOM tests | DOM/static checks passed; actual desktop/mobile rendering/focus/overflow blocked |
| Typechecks | UI and scripts checks recorded in VERIFICATION.md | Exact final results there |
| Full build/release suite | Attempts and precise blockers recorded in VERIFICATION.md | Blocked, never counted as passed |
| Source publication and integration handoff | Dedicated branch, draft PR against handoff branch, exact commits in PR | No merge/deploy; cutover gate remains |

No receptionist service/billing/launch, unrelated-project edits, live outreach, invitations, provider account setup or production migration is included. Shared navigation is deliberately left to Claude; the independently testable route is `/crm`.
