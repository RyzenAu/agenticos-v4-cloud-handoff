# Integration contracts: Agents workspace (Claude) ↔ CRM (Dot)

Status: **proposed by Claude, 2 Oct 2026.** Dot confirms or amends in the CRM pull request / package. Ownership: `AGENTS-WORKSPACE-OWNERSHIP.md`.
Rule of thumb: the CRM database is authoritative for business records; agents only *reference* records and *add* activities through Dot's typed operations. Hindsight/Obsidian are context, never a source that overwrites CRM fields.

## 1. Record references

```ts
// src/lib/crm-ref.ts  (owner: Dot; Claude imports it)
export type CrmKind = "company" | "contact" | "deal" | "project" | "document" | "lead";
export type CrmRef = { kind: CrmKind; id: string };          // id is the stable CRM id as a string
export const crmRefString = (r: CrmRef) => `crm:${r.kind}:${r.id}`;   // "crm:deal:42"
export function parseCrmRef(s: string): CrmRef | null;      // inverse; null on anything else
```
- Existing lead ids stay valid as `crm:lead:<id>`. After Dot's migration, Dot provides `resolveLegacyLead(id) → CrmRef` (usually the company) so old links keep working.

## 2. Deep links

```ts
// src/lib/crm-links.ts  (owner: Dot)
export function crmHref(ref: CrmRef, tab?: "overview" | "timeline" | "deals" | "delivery"): string;
```
- Agents never hard-code CRM routes; they call `crmHref`. Old `/leads…` URLs keep working (Dot's requirement).

## 3. Job ↔ record relationship

- Existing job services stay the only job engines (`/__jobs`, coding jobs, computer jobs). A job MAY carry `subjects: CrmRef[]` (string form stored), set when the request was made in a record's context or names one.
- Claude adds the optional `subjects` field to the job create paths it owns (computer jobs, the bot conversation) and passes it through to coding jobs' metadata; Dot reads it to show "agent work on this record".
- Query: `GET /__jobs?subject=crm:company:7` (Claude adds the filter to the existing route; read-only, same identity rules as `/__jobs`).

## 4. Activities from agents (idempotent)

```ts
// scripts/crm/ops.ts  (owner: Dot) — typed operation, also used by buttons and Jarvis
crm.activity.add({
  ref: CrmRef,
  eventId: string,            // stable, e.g. `${jobId}:result` — a retry with the same eventId is a no-op
  kind: "agent-result" | "agent-blocked" | "note" | ...,
  title: string,              // one line
  by: { personId: "usman" | "mehroz" } | { agent: string, jobId: string },
  artifact?: string,          // see §6
}) → { ok: true, activityId: string, href: string }
```
- Claude calls it when a job with a CRM subject ends with a saved result ("Save the result to this client"), or when the person asks.

## 5. Typed operations for Jarvis and buttons

- Dot exposes a registry `scripts/crm/ops.ts`: `{ name, summary, input (zod), run(input, principal) → receipt { ok, href, text } }`, names under `crm.*` (e.g. `crm.followups.overdue`, `crm.contact.add`, `crm.activity.add`, `crm.task.assign`, `crm.deal.move`, `crm.proposal.draft`, `crm.promises.list`).
- Business lookups and drafts (round 10, `scripts/crm/business.ts`): `crm.search` (companies, contacts, deals, projects, tasks, quotes, invoices, documents, linked files, deal-desk workbooks), `crm.next.list` (next real action with owner and dependencies), `crm.drafts.list` (existing unsent outreach and meeting packs with recipient and restriction gaps), `crm.invoice.draft` (draft from the deal's agreed price; exact integer cents, GST from `splitGst`; the only deposit is the approved website one), `crm.quote.package` (a deal-desk quote workbook from an approved receptionist package price, linked back to the deal). Private text is searched and shown only for a confirmed person; the three drafting operations need a confirmed browser on HTTP and in Jarvis. Jarvis speaks them through `scripts/jarvis-command/business.ts` (named records, never a guess: one match acts, several ask which).
- Jarvis routes `crm.*` intents to that registry (Claude wires the Jarvis side; Dot owns the operations and their validation). Active-page context: the CRM page publishes the open record via `publishPageContext({ crm: CrmRef })`; Jarvis resolves "this client/deal" from it.
- Routine internal edits by a verified founder need no approval prompt; outward actions (sending, publishing) follow existing B2 rules.

## 6. Result files

- Saved agent results are referenced, not copied: `artifact:<jobId>` or `artifact:<jobId>/<file>`, resolvable at `/__computers/artifacts/<jobId>` and `/__computers/artifacts/<jobId>/f/<file>` (existing, identity-gated). CRM documents link to them by this string.

## 7. Events

- Dot publishes record changes on the existing `/__events` stream under a new topic `crm` (payload: `{ ref, change: "created"|"updated"|"deleted", at }`, no field values), per-person scoping as other topics. Agents subscribe only to refresh links/labels.

## Synthetic contract test (both sides)

A fixture company + deal; a Research job created with `subjects:[crm:deal:<id>]`; job completes with an artifact; `crm.activity.add` with `eventId=<jobId>:result` called twice → one activity whose `href` opens the deal timeline and whose `artifact` opens the saved result.
