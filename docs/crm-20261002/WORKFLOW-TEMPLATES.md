# Editable business workflow templates

The CRM has nine local workflow templates. Applying a template creates linked, open CRM tasks and, where appropriate, a draft document. It does not mark the underlying work complete, send anything, arrange a meeting, request payment, change delivery status or launch a site.

## Catalogue

| Template ID           | Default record scope   | Created work                                    |
| --------------------- | ---------------------- | ----------------------------------------------- |
| `website-enquiry`     | Company, deal          | Qualification task and enquiry notes            |
| `discovery`           | Company, deal, project | Requirements review task and meeting notes      |
| `proposal`            | Deal                   | Proposal review task and priced draft proposal  |
| `onboarding`          | Deal, project          | Scope and input tasks plus onboarding checklist |
| `delivery-acceptance` | Project                | Acceptance review task and evidence checklist   |
| `cms-handover`        | Project                | Training/handover task and handover notes       |
| `change-request`      | Deal, project          | Change assessment task and review draft         |
| `follow-up`           | Company, deal, project | Internal next-action task                       |
| `maintenance-review`  | Project                | Maintenance task and review notes               |

Copy uses Australian English and explicit placeholders for missing information. A discovery template does not claim a meeting happened; acceptance remains pending until evidence is recorded. Only four substitutions are supported: `{{company.name}}`, `{{deal.title}}`, `{{deal.scope}}` and `{{project.name}}`. Substitution reads the selected record; it does not evaluate expressions or invent client facts.

## Integration contract

`scripts/crm/workflow-templates.ts` is browser-safe. It exports the validated default definitions, Zod request schemas and shared types. `scripts/crm/workflows.ts` is the server-only service:

```ts
const workflows = new CrmWorkflows(store, { now: () => new Date().toISOString() });
workflows.listTemplates(); // WorkflowTemplate[]
workflows.updateTemplate({ id, expectedVersion, patch }, { personId });
workflows.applyTemplate(
  {
    templateId,
    expectedVersion,
    ref,
    requestId,
    expectedDealVersion, // required when the output is a proposal
    owner,
    dueAt, // optional; no due date is invented
  },
  { personId },
);
```

Typed operation names are `crm.workflow.templates`, `crm.workflow.update` and `crm.workflow.apply`. The existing authenticated operation registry supplies the founder identity. The service also validates attribution and accepts only `usman` or `mehroz`; a payload cannot supply an arbitrary actor or an agent identity.

The editable fields are `title`, `summary`, `appliesTo`, `tasks` and `document`. IDs and provenance cannot be changed through a patch. Tasks contain stable keys, title, description and kind; their initial status is always open. A document contains title, kind and content; its status is always draft. The proposal workflow must retain a proposal document. There is no template deletion or external automation setting.

The apply receipt includes the request ID, template ID and version, selected CRM reference, created task/document IDs, activity ID, founder, creation time and duplicate flag. The immutable timeline event links each task to its template/version/request provenance without consuming the task description's text allowance. Drafts also include the provenance. Placeholder expansion is checked before any task is created; oversized content produces an explicit validation error without truncation or partial work.

## Persistence, version checks and retries

- Uses existing `CrmStore.getSetting`, `setSetting` and immediate transactions. No new CRM table or migration is required
- Defaults are copied only when a template's setting is absent. Existing customised definitions are never reconciled over or reset by the catalogue
- Every edit compares the expected version inside the transaction, increments the version and stores a full immutable snapshot of the previous definition and its author/time
- Catalogue ID/version and creation time survive all edits. Invalid saved templates raise an error rather than being replaced with defaults
- Task creation, draft creation, activity and receipt commit in one transaction. A later failure rolls back all created records and pending notifications
- The caller supplies a stable request ID and reuses it after an uncertain result. The exact same request and founder return the saved receipt without creating work, including after a restart or template edit
- Reusing a request ID for another payload or founder rejects with an idempotency conflict. A new request ID means a deliberate new application, so repeated maintenance/follow-up rounds remain possible
- Durable receipts are never silently evicted. At 2,000 runs, new applications stop until an explicit archival solution is supplied. Saved retries still work at the cap
- Definitions allow at most eight tasks and 50 previous snapshots. An encoded template exceeding 900,000 characters fails before saving. Reaching a cap preserves existing history and reports the limit

Each task links to the chosen company and, when selected, its deal/project. Project links also preserve the project's explicit linked deal. The selected record's assigned owner is used, falling back to the company owner and then the applying founder; an explicitly chosen owner, including unassigned, wins. Dates are applied only when supplied. Merged company targets require the retained company to be selected.

## Commercial and execution boundaries

Proposal drafting requires an explicit deal, or an explicitly linked deal on a supported project. It never guesses which of a company's deals to use. `expectedDealVersion` must match the current deal before pricing is copied, preserving the existing proposal operation's reviewed-price check.

For catalogue-priced website deals, amounts must match the existing `scripts/leads/sales-backoffice.ts` website catalogue on the selected GST basis. Agreed deal prices are preserved exactly; unconfirmed legacy prices and mismatched catalogue values are rejected. The immutable document version stores price amounts, currency, GST treatment, catalogue reference and deal version. Editable template copy has no separate price catalogue and does not alter the approved website prices.

Receptionist and combined-offer deal/project applications are blocked under the existing hold. Every generated draft states that setup and pilot terms remain unapproved, receptionist development/billing remain on hold, and the draft authorises no issue, signature, payment, message or launch. Unknown terms stay as prompts for the founder. Existing Finance remains authoritative for invoice and payment status.

All work stays in the CRM store. There are no provider calls, schedules, credential access, shared navigation edits or changes to the existing job runtime in this implementation.

## Focused verification

`bun test scripts/crm/workflow-templates.test.ts` uses in-memory SQLite and disposable temporary databases. Coverage includes browser bundling, all nine templates, independent default copies, immutable history, both-founder stale edits, two database connections, durable replay, mismatched request attribution, stale proposal prices, catalogue/agreed pricing, hold enforcement, full transaction rollback, validation and capacity failures. The exact command is safe to run without the repository's broader provider-facing suite.

UI integration and rendered browser checks are separate acceptance work; service tests do not establish browser interaction quality or release readiness.
