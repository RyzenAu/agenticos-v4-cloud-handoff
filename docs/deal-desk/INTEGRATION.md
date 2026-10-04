# Deal desk and motion kit: integration branch (3 Oct 2026)

Branch `int/deal-desk-motion-20261003`, worktree `D:/AgenticOS-int-dealdesk`, based on `r7/candidate-20261003` @ `253eaed5`.
**Prepared for the main OS lead to accept or reject. Not merged into the candidate, not deployed, not live.**

## What this branch changes on top of the candidate

| Change | Files | Why |
|---|---|---|
| Deal desk modules, tests, docs (merge of `quoting/deal-desk-20261003`) | `src/lib/deal-desk/**`, `scripts/deal-desk/**`, `tools/deal-desk/**`, `docs/deal-desk/**` | All new files; merge is conflict-free. |
| Static build of the desk | `public/deal-desk/{index.html,app.js}` | Served by the OS like `public/mu-creative-20261001`. Rebuild: `bun tools/deal-desk/serve.ts --build --out public/deal-desk`. |
| One launch link | `src/components/business/mu-operations.tsx` (header nav), `mu-operations.css` (one rule) | Operations already hosts the package economics the desk builds on. Same-tab link to `/deal-desk/index.html`; the desk shows "← Operations" to come back. |
| Freshness guard | `scripts/deal-desk/public-build.test.ts` | Fails if `public/deal-desk` is stale against `tools/deal-desk`. |

Deliberately **not** changed: `destinations.ts` (no nav entry), routes, `/__*` endpoints, identity routes, CRM, Finance, `sales-backoffice.ts`, any database.

## Checks run on this branch

- `bun --no-env-file test scripts/deal-desk scripts/operations-truth.test.tsx scripts/os-shell.test.ts`: 127 pass, 0 fail.
- `bun node_modules/typescript/bin/tsc --noEmit`: clean.
- The published page loaded from a `/deal-desk/` path (static server): 4 seed deals, Agreement tab "Fits: 2 A4 pages", back link present, printing goes through a same-document iframe (no pop-up), 0 page errors.
- Not run: the full suite (the release gate is running), and the page inside the live OS shell, the Tauri desktop app or the tailnet client.

## Known limits of this smallest step

- Deals are saved in the browser's `localStorage`, which is per origin: the loopback OS, the tailnet `:8443` client and the desktop app each keep their own deals. Use Export / Import (JSON) to move them.
- Nothing is attached to a CRM record yet.

## Next step, only if the owner wants shared deals (needs a decision)

Follow the existing contracts; no new database or `/__*` mount:
1. `POST /leads/deal-desk` in `scripts/leads/api.ts`, validated with the same `requireLead` + `draftTarget` as proposals, writing `deal-desk-deal.json`, `deal-desk-quote.html` and `deal-desk-agreement.html` into the existing `drafts/<leadId>` folder; extend the hard-coded list in `draftFiles` and the mime logic of `/leads/draft-file`.
2. An `OPERATOR_SITES` entry (`scripts/identity/operator-sites.ts`) and its test, so remote writes need a confirmed session.
3. A `leadId` on the desk's `Deal` and a "Save to lead" action. The lead drawer's Deal tab then lists the files with no UI change.
4. Or, CRM-native: `crm.document.create` with `kind: "proposal" | "agreement"` and `renderQuoteMarkdown` as `content` (the CRM renders plain text only). CRM is Dot's area: agree this with Dot first.

A static page has no OS page token, so step 1 also means mounting the desk as a section of Operations (React wrapper around the same pure modules) rather than as a static page.

## Open questions for the lead / owner

1. Is `r7/candidate-20261003` the right target? (Handoffs still describe only the live build.)
2. Do Usman and Mehroz need to see the same deals (the "next step" above), or is export/import enough for now?
3. Lead drafts or CRM documents as the home for exported quotes and agreements?
4. Should `OWNER_DECISION_B`, `BOOKING_DISCLOSURE` and `WEBSITE_OFFER` move into a pure module (they are mirrored with drift tests today)?

## Rollback

Nothing is live. To drop the work: `git worktree remove D:/AgenticOS-int-dealdesk` and delete the branch. If the lead merges it and wants it out, revert the merge commit; the only existing files touched are `mu-operations.tsx` and `mu-operations.css`.

## Update (3 Oct, later): shared quote workbooks are built on this branch

The "next step" above is done, adjusted to the round-7 lead's review. Read this section in place of "Known limits" and "Next step".

**Added on this branch**
- `scripts/leads/deal-desk-store.ts` and its tests: server-side quote workbooks under the data folder (`deal-desk/<id>.json`), with revision checks, a draft kept beside the last complete version, a previous-version copy, and damaged files never rewritten.
- `scripts/leads/api.ts`: new routes only, under `/leads/deal-desk/` (list, get, save, archive, link, attach). Existing routes are untouched.
- `scripts/leads/deals.ts`: `assertDraftable` extracted from `draftTarget` (same behaviour).
- `scripts/leads/sales-backoffice.ts`: `draftFiles` lists the three `deal-desk-*` files.
- `scripts/operator-plugin.ts`: two lines, so a workbook error returns its own status and body (404, and 409 with the current record). Accepted by the lead on the branch.
- `tools/deal-desk/shared.ts` and `app.ts`: the desk saves to the OS when served by it.

**Proposals, not on the branch** (`D:/deal-desk-shared/`)
- `operator-sites.patch` and `OPERATOR-SITES-PROPOSAL.md`: the identity entry for the new write routes. `scripts/identity/**` is lead-owned. Verified to apply and pass the identity tests.
- `CRM-DOCUMENT-PROPOSAL.md`: adding a quote to a CRM deal as a document version with an idempotent activity, and amounts only through `crm.deal.update` after founder confirmation.

**Checks**
- Targeted tests: 293 pass (deal desk, workbook store, leads API, deals, sales back office, operations, shell, house rule, formatting guard, motion kit, layout). Both typechecks clean.
- Real HTTP on an isolated test hub (port 8163, synthetic seed): `tools/deal-desk/acceptance/os-journey.ts`, 16 checks pass with two separate browser sessions. Evidence in `docs/deal-desk/os-evidence/`.

**For the integration gate (lead)**
- Re-merge the released round-7 commit into this branch, then the short re-check.
- Two authenticated founder sessions through the permission path (this branch tested two local sessions only).
- Downloads and printing in the desktop app and a tailnet browser.
- Decide the two proposals above.
