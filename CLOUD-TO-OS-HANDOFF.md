# Cloud-to-OS handoff · 2 October 2026

This is the consolidated source inventory and integration order for Claude. **No current-running-OS revision or deployment is verified by this handoff.** A published branch, ZIP, recorded historical gate or open PR is not evidence that the everyday OS uses it.

## 1. Review entry points and exact revisions

Repository: [RyzenAu/agenticos-v4-cloud-handoff](https://github.com/RyzenAu/agenticos-v4-cloud-handoff).

| Item | Exact value / status |
| --- | --- |
| Agreed development base | `handoff/claude-dev-baseline-20261002` · `e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa` |
| Base tree | `fd7545e27e26c69af345b3a57de943e36775edbf` |
| CRM implementation | [Draft PR #1](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/pull/1), `dot/crm-workspace-20261002` |
| CRM code head | `5d5443fb1467741ddc97ace881f9a005ddb65586` |
| CRM code tree | `c8ecad5547894b338bd77e4a85a65a6bc28d5fd3` |
| Earlier CRM checkpoint | `d7fc93b62a55de9c77a2b5e74e73cf4cdcfff803`; direct parent of current CRM head |
| CRM change scope | Two commits, 77 files: 74 additions and three existing-file fixes |
| This inventory | Documentation-only branch `dot/cloud-os-handoff-20261002`, directly based on the agreed base; its PR records its exact final head |
| Remote observation | 2 October 2026, 16:03–16:11 UTC: PR #1 open/draft/mergeable, no comments or reviews. Latest earlier check had no statuses and zero check runs; fresh publication checks belong in this inventory PR |
| Running OS | **Unknown here.** The supplied handoff said older `6607e4f` was serving while Ryzen release gate/cutover remained pending |

Start with this document; use the immutable [CRM NEXT checkpoint](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/blob/5d5443fb1467741ddc97ace881f9a005ddb65586/NEXT.md) for implementation continuation. This inventory does not change CRM code or shared contracts.

## 2. Sanitised source and original revision mapping

The October 2 package records original AgenticOS-v4 branch `ryzen/migration-20261002`, source commit `317c5e6a90912632395ee89d42b7c03de2edfefc`; its handoff says the code is identical to `995c0a40` apart from handoff documents. The GitHub handoff commit is a sanitised tree on parent `3a8d304475fa4ae917e1d916bc67fcf623e3f8d3`, **not the original source commit or its original ancestry**.

- Package name: `mu-hub-317c5e6a9091.tar.gz`
- Recorded tar SHA-256: `2efe5fb76cc88d7957519543e57dbedde2e2c6cb4ba99b3849d078bacbdf3358`
- Independently recomputed manifest SHA-256: `5000884f93deb4cd9c70775c90e4329e435f9995e995ff327fa44bb737dbb370`
- All **3,206 manifest files** match the exact handoff baseline byte-for-byte, with zero missing/different files. The baseline Git tree contains 3,210 blobs
- The tarball itself is not available in the inspected cloud workspace. Its archive checksum is a recorded declaration, not a newly verified tarball hash
- The manifest deliberately excludes 1,007 media/screenshot files. These are not silently restored
- The 35 uncommitted lead-site/template entries excluded by Claude remain excluded and are not reconstructed

The earlier private cloud repository main, `3a8d304475fa4ae917e1d916bc67fcf623e3f8d3`, reports a snapshot of original local `jarvis-voice` revision `b96c046`, with a raw transcript fixture omitted. [Original cloud handoff](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/blob/3a8d304475fa4ae917e1d916bc67fcf623e3f8d3/CLOUD-HANDOFF.md). That statement supplies a source mapping; it does not establish an identical original Git object.

### Original Dot Leads package

Programme records identify exact patch `17ddd0a2`, branch `r6/dot-leads-20261002`, abbreviated ZIP SHA-256 `b2f6379a…835893d`; `UI-CONTROLS-R6.md` reports manual reconciliation into `r6/ui-20261002` and drawer revision `af155440` with Dot list revision `d8d9b1df`.

The original archive filename/full digest, patch object and conflict-resolution report are unavailable in this workspace. **Original-package byte reconciliation is not confirmed.** Current source presence and preservation are confirmed: multiword/accent-folded search, AU phone and exact-ID matching, filter chips, list/table/board, drawer links, locality, concurrent discovery, manual corrections and honest website evidence all exist in the manifest-verified baseline and remain unchanged at CRM head.

Later explicit website-check states supersede earlier inferred absence: an empty legacy site is not-checked, a stored site is found, and an old date or model response alone cannot establish verified absence. Leads assets/tests are already in the baseline: 104 files under `scripts/leads`, including 47 test files. No older overlay should be reapplied over them.

Only these original manifest files differ at CRM head:

| File | CRM change |
| --- | --- |
| `scripts/leads/crm.ts` | A note preserves the existing follow-up unless a terminal outcome clears it |
| `scripts/leads/care-plan.ts` | Dated changes are filtered to the relevant month; undated founder notes remain |
| `scripts/meeting-mode/crm-sync.ts` | Follow-ups resolve to 9 am Australia/Sydney, including daylight saving |

Representative SHA-256 values, identical in manifest, baseline and CRM head:

| File | SHA-256 |
| --- | --- |
| `src/lib/lead-search.ts` | `93bf361e81b403c701fdb8db21251bd328b7e07f76d9e01f59ef2dc0d94df2fe` |
| `src/components/operator/lead-list.tsx` | `1be6085fd3472140da4a7ac9f352726afba9ab645e9e29a4b5c4900c0303fa1b` |
| `scripts/leads/discovery.ts` | `e68f7e9db47925ba7e05f5e70e2f6c7ae0a9e2394c88067246ea87ba88b2ca4e` |
| `scripts/leads/discovery-concurrency.test.ts` | `39eabc1ffe173f8032a101f779de1cc63d89379c4f16eaf79cfbb015b4a33b4d` |
| `scripts/leads/website-check.test.ts` | `155a7a8363e0eda2c4ec0d0ad10fb223f068df4b68066a4dd1c78c2d595e2eae` |

## 3. All discoverable published cloud OS work

All ten historical work branches below already exist in the same private repository. Their source/tests/assets remain available at the immutable links; no duplicate code branch is created. All branch trees were retrieved without truncation. [Machine-readable source inventory](docs/cloud-os-handoff-20261002/source-inventory.json) contains every changed path, cloud blob SHA, original-main blob SHA and October 2 baseline blob SHA.

The final column is **identical / different / absent paths in the October 2 baseline**, considering each branch's cumulative delta from historical main `3a8d304`. These overlap and must not be added together. Identical confirms source presence. Different requires semantic reconciliation; it does not prove missing behaviour. Absent means the old path is absent, not that its functionality was not moved or replaced. No whole historical branch is certified fully integrated.

| Existing branch / immutable source | Head | Work | Identical / different / absent |
| --- | --- | --- | --- |
| [cloud/agenticos-next-integration-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/7780c08848b4e9d03c70b4652e63e439abff11e3) | `7780c08848b4e9d03c70b4652e63e439abff11e3` | Combined candidate plus memory decision-transfer/mail-archive close fixes | 32 / 59 / 41 |
| [cloud/f1-flows-wip](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/1e32908a9175ab8c5fec3c55bf9dd2c70f496757) | `1e32908a9175ab8c5fec3c55bf9dd2c70f496757` | F1 typed/voice flows; original 1c677ee plus 21 preserved unverified edits | 4 / 20 / 8 |
| [cloud/integration-j6-f1-p1](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/e9366d87e6f965d3d3bcd17950c0eeb46494cbeb) | `e9366d87e6f965d3d3bcd17950c0eeb46494cbeb` | J6/F1/P1 integration and later retry/soft-404/host-binding fixes | 4 / 40 / 32 |
| [cloud/j6-browser](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/14377f604955a52f7afeec152b17e089a3f10ef6) | `14377f604955a52f7afeec152b17e089a3f10ef6` | J6 browser task loop; original local 18c7c07 | 0 / 12 / 7 |
| [cloud/jarvis-device-coding-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/83361cacd174613f75762e2e5fa2ea0e95d76c8e) | `83361cacd174613f75762e2e5fa2ea0e95d76c8e` | Founder device targeting, coding handoff and recorded reviewer routing | 14 / 54 / 32 |
| [cloud/memory-finance-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/938238240c63df54853944513dc557f88017270b) | `938238240c63df54853944513dc557f88017270b` | Memory identity/provenance and NAB CSV package candidates | 11 / 43 / 32 |
| [cloud/nexus-interface-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/ebc5b47323d841ac369a96b49d58683bc4ad61d0) | `ebc5b47323d841ac369a96b49d58683bc4ad61d0` | Target-labelled palette, shared handoff signal, Command scene | 7 / 44 / 32 |
| [cloud/p1-desk](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/4212de86326bd8dd4ab5717510f01c75d8f8327b) | `4212de86326bd8dd4ab5717510f01c75d8f8327b` | P1 synthetic desk-payment workflow; original local 3f85c48; never live-accepted | 0 / 16 / 16 |
| [cloud/receptionist-leads-handoff-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/f548259530f6b5f269ca5f4f273ba3d580038613) | `f548259530f6b5f269ca5f4f273ba3d580038613` | Aggregate staff handoffs and future event seam; receptionist remains on hold | 36 / 58 / 46 |
| [codex/coding-ux-audit-20260929](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/tree/65dd796ca5eee5061603325b09c2d356807c3b25) | `65dd796ca5eee5061603325b09c2d356807c3b25` | Coding queue clarity, stale states and eight-destination audit | 33 / 62 / 46 |

Historical `cloud-next-integration` documentation reports clean integration of NEXUS, Memory/Finance and Jarvis/device/coding into that September 29 candidate. It reported 9,757 passed, 23 skipped, 32 failed; the coding UX branch reported 9,759 passed with the same failures. Those are **prior reports**, not new runs or October 2 release results. Other historical slices have their own partial/failing gates; follow their adjacent handoffs and current owner review.

### Owner reconciliation needed outside CRM

Thirty-two source/test paths from the combined historical candidate are absent at their old paths in the newer handoff:

- `scripts/flows/`: five files; `scripts/f1/email-calendar.test.ts`, `leads-voice.test.ts`; `scripts/jarvis-command/lead-resolve.ts`
- `scripts/j2/`: eight browser-task/task-brain/task-intents/typed/fake/test files including `desk-handoff.test.ts`
- `scripts/desk-payments/`: fourteen files; `src/components/operator/desk-payment-card.tsx`; `src/lib/desk-money.ts`

The inventory gives each exact path and source hash. Claude owns current Jarvis, browser/computer and shared runtime reconciliation. Review whether the current implementation deliberately replaces each slice before proposing a narrowly scoped code PR. Do not merge the old whole branches into the newer sanitised base or activate payment/provider/receptionist paths. The old payment code is archival source, not payment authorisation.

Historical rendered assets remain at the historical source commits where listed. Their package-era documentation describes synthetic screenshots; this inventory has not inspected their pixels or recertified privacy. They are not current CRM screenshots and are not copied into this sanitised documentation PR. Current required CRM source, templates, tests and interface assets are already in PR #1 or the manifest-verified base.

## 4. CRM implementation and local unpublished inventory

PR #1 contains relational CRM records/migration, typed operations, CSV preview/import/export, pipelines/history, task lifecycle, versioned documents, projects/delivery, existing Finance links, durable-Jobs automation adapter and CRM UI. Its latest commit adds the company-to-result journey, nine editable versioned business templates, next-action dashboard, 13 synthetic business contracts, concurrency/price/retry fixes, deferred documents and measured query/search improvements.

Nine templates: website qualification, discovery notes, proposal draft, onboarding, delivery acceptance, CMS training/handover, change/revision, follow-up and maintenance review. Applying them creates linked open tasks and drafts; it never sends to clients or fabricates a payment, finished agent job or delivered result. Catalogue/agreed AUD/GST pricing is reused; setup fees and pilot terms remain unapproved.

Available local worktrees were inventoried without reading runtime databases or logs:

| Local worktree / ref | State | Disposition |
| --- | --- | --- |
| `crm-resume`, local `dot/crm-followthrough-20261002` | Clean at remote CRM head `5d5443f` | Published implementation |
| `baseline-verified` | Detached exact `e9ad7c2` | Verified source reference |
| `published-checkpoint` | Detached `d7fc93b`; copied untracked performance benchmark | Measurement copy superseded by tracked current benchmark |
| `source`, local `dot/crm-workspace-20261002` | Old `d7fc93b` plus nine staged shared edits and one duplicate patch | Preserved proposals, not current remote branch state |
| Local `dot/crm-reviewed-local-20261002` | `c30002f51d558002aceda575469d60b5e701529c` | Same tree `c8ecad…` as published `5d5443f`; no missing source commit to publish |
| Dependency/build/cache/test-home/test-data/log/transport directories | Generated or verification material | Excluded; reviewed evidence summaries already published |

### Nine held shared-file proposals

These nine files still match the original handoff at current CRM head. Claude owns their current integration. This inventory lists purpose/status only; it does not republish prior denied code.

| Path | Original proposal / current disposition |
| --- | --- |
| `vite.config.ts` | CRM plugin mount; still needed, adapt to current owner configuration |
| `scripts/identity/routes.ts` | CRM mount classification; still needed under current owner policy |
| `docs/IDENTITY-ROUTES.md` | Corresponding route documentation; update with actual owner mount |
| `scripts/identity/fixtures/legacy-route-decisions.json` | Route-classification fixture; regenerate/update with owner tests |
| `scripts/events/bus.ts` | CRM event topic typing; coordinate existing stream owner |
| `scripts/events/sources.ts` | Old event helper; previously denied publication, incomplete against current optional callback seam |
| `src/lib/activity-stream.ts` | CRM stream topic typing; previously denied publication, coordinate publisher |
| `src/routeTree.gen.ts` | Generated route inclusion; previously denied publication, regenerate rather than apply old generated diff |
| `src/lib/page-context.ts` | **Obsolete**: current CRM uses existing `selection.search.ref`; no new field needed |

The first three actual publication denials were `scripts/events/sources.ts`, `src/lib/activity-stream.ts`, `src/routeTree.gen.ts`; the other six were held for cohesion. `SHARED-INTEGRATION.patch` exactly duplicates the nine-file staged diff: 12,508 bytes, SHA-256 `5feccc10f1a568104a815ffb1b113795bc54b43f7c6d41b48f9cb891543ceec1`. It is stale historical packaging, not extra implementation. Fresh handoff authority supports documenting needed owner changes; it does not make that stale bundle valid or justify bypassing its earlier denials.

## 5. Integration order and owner contracts

1. **Claude confirms the actual integration revision and running-OS/cutover status.** Preserve current work and real data; start from the agreed handoff only if it is still compatible. Review the source inventory for older branch differences. No application to the running OS is authorised by this handoff.
2. **Review CRM PR #1 as one two-commit delta against exact e9ad7c2.** Preserve existing Leads code. Do not cherry-pick duplicate local `c30002f` after `5d5443f`.
3. **Claude mounts CRM.** Import `crmPlugin` from `scripts/crm/plugin.ts` and supply the hub root plus existing page-token callback. Classify only `/__crm` through current identity policy; regenerate TanStack routes from `src/routes/crm.tsx` and add the agreed navigation entry.
4. **Claude connects owning services.** Use `configureCrmIntegrations(root, { publishChange, verifyAgent, verifyCommunicationEvidence })`. The callback receives committed `{ref, change, at}` without business field values. Missing readers fail closed; focus/30-second polling is the current UI fallback.
5. **Claude supplies Jobs/Jarvis integration.** Persist canonical CRM subjects on existing job-create/reopen paths and implement `GET /__jobs?subject=crm:deal:<id>` under existing identity gates. Verify saved job/agent/subject/artifact before attribution. Jarvis calls `crmRuntime(root).operations.run(name, input, verifiedPrincipal)`; page context uses `selection.search.ref`. Stable event IDs dedupe `crm.activity.add`; results stay identity-gated `artifact:<jobId>[/file]` references.
6. **Run disposable migration, mounted acceptance and full release checks.** Keep provider adapters fake/disconnected. Reconcile against the actual integration head before any separately authorised merge or deployment.

CRM GET routes: `/__crm/snapshot`, `/__crm/record?ref=...`, `/__crm/ops`, `/__crm/finance?companyId=...`, `/__crm/resolve-legacy?lead=...`. POST `/__crm/ops` accepts `{name,input}`; identity comes from the verified server session. Retain founder, origin, page-token, remote-server-session and read-only gates. Read-only GET can fetch deferred document bodies. Do not accept browser-supplied attribution or memory recall as authority.

Existing Finance remains the only invoice/payment source. CRM links a verified saved invoice URL and reports unavailable/stale/unknown states; moving a card does not assert payment. Existing Jobs remain the only job engine; business tasks are separate records.

## 6. Dependencies, configuration and recovery

Use Bun **1.4.2**, the unchanged frozen lockfile, and Node **24.19.0** for the recorded typechecks. No new dependency or secret is required for synthetic CRM verification. Lockfile SHA-256: `ab55d0b1826f217c95d7e5fbc809648a0ec9218952d13515ea851b8d3cb14d6f`.

Configuration **names only**: `MU_DATA_DIR` (disposable workspace), `MU_HUB_ROLE` (owning hub role), `HINDSIGHT_URL`, `MU_MEMORY_WRITES`, `AGENTIC_OS_NO_CODEX`, `AGENTIC_OS_NO_BACKGROUND`. Safe test values are shown below. The quiet/background-disabled hub is read-only; use Claude's explicit disposable write-enabled configuration for the actual UI journey without weakening production gates. Full placeholder catalogue: [DOT-CONFIG-NAMES.md](docs/programme-20261001/DOT-CONFIG-NAMES.md). No credential values, profiles, private correspondence or client data are included.

CRM schema v1 adds related records/settings/receipts in the existing `crm.sqlite`, retaining original Leads tables and IDs. The resumed templates add no schema version. On a **disposable copy**:

```sh
bun scripts/crm/migrate.ts --db /absolute/path/to/copy/crm.sqlite
bun scripts/crm/migrate.ts --db /absolute/path/to/copy/crm.sqlite --apply --backup /absolute/path/to/new-pre-crm.sqlite
```

Review counts, original-record hashes, missing independent source fields and orphan/duplicate findings. The apply path takes an immediate write lock, reconciles again, creates an integrity-checked backup and refuses existing backup destinations. Repeated/concurrent migration tests protect existing records.

Disposable schema rollback only:

```sh
bun scripts/crm/migrate.ts --db /absolute/path/to/disposable.sqlite --rollback --disposable --acknowledge-data-loss
```

For any later live rollback, stop writes, retain the current database and WAL/SHM siblings, restore the verified pre-upgrade copy without stale siblings, restore reviewed source, verify integrity/counts, and reconcile CRM-only records created after backup. Do not overwrite newer data to make an old build run. [Full CRM migration/rollback guide](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/blob/5d5443fb1467741ddc97ace881f9a005ddb65586/docs/crm-20261002/MIGRATION.md).

## 7. Exact reproduction and outstanding gates

Run these from a disposable checkout of the **CRM code head**, not this documentation-only branch:

```sh
git fetch origin handoff/claude-dev-baseline-20261002 dot/crm-workspace-20261002
git worktree add --detach ../agenticos-crm-review 5d5443fb1467741ddc97ace881f9a005ddb65586
cd ../agenticos-crm-review
git rev-parse HEAD
git diff --stat e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa...HEAD
bun install --frozen-lockfile
mapfile -t crm_test_files < <(rg --files scripts/crm | rg '\.test\.ts$' | rg -v '^scripts/crm/plugin.test.ts$' | sort)
HINDSIGHT_URL=off MU_MEMORY_WRITES=off AGENTIC_OS_NO_CODEX=1 AGENTIC_OS_NO_BACKGROUND=1 bun test "${crm_test_files[@]}" src/components/crm scripts/leads scripts/meeting-mode/meeting-mode.test.ts
node --max-old-space-size=2048 node_modules/typescript/bin/tsc --noEmit -p scripts/crm/tsconfig.check.json
node --max-old-space-size=2048 node_modules/typescript/bin/tsc --noEmit -p scripts/crm/tsconfig.ui-check.json
node --max-old-space-size=3072 node_modules/typescript/bin/tsc --noEmit -p tsconfig.scripts.json
bun scripts/crm/performance.ts --sizes=50,500,2000 --runs=5
```

The `mapfile` command requires Bash; ensure installed Bun is on PATH because CLI tests spawn it. The original socket-binding HTTP test is explicitly excluded above; run `bun test scripts/crm/plugin.test.ts` only in a permitted loopback environment. No tests are rerun merely for this documentation inventory.

Fresh CRM evidence at 5d5443f: **680 passed, 1 TODO, 0 failed**; 13 requested business contracts passed with the owning Jobs reader fake; later affected checks 32 passed (overlapping, not additive). Full backend and scoped CRM typechecks passed. The older 1,129-test result belongs to a different assembled local candidate with unpublished shared hooks and must not be reused as this PR's pass.

| Unfinished gate | Exact known cause / next owner action |
| --- | --- |
| CRM mounted application | Shared mount/identity/generated route integration intentionally absent; Claude integrates |
| Real Jobs subjects/filter, trusted readers, Jarvis | Current baseline lacks general subjects persistence/filter; fake tests prove CRM boundary only |
| Full UI TypeScript | SIGKILL / exit 137 without diagnostics; rerun serially on integration environment |
| Production build | Not rerun on resumed tree before owner mounts; earlier assembled attempts exited 137 |
| Full repository suite | Earlier safety review blocked unestablished Typesafe egress; configure hermetic synthetic paths before rerun, do not enable providers just to pass |
| Actual browser/screenshots | Earlier permitted cloud localhost visit returned ERR_BLOCKED_BY_CLIENT; no alternate port/tool/tunnel bypass and no CRM screenshots |
| Windows/founder/live-provider acceptance | Not exercised for CRM; owner integration evidence required |
| GitHub CI | No checks observed on CRM code head; empty check list is not a pass |
| Original Leads archive/patch | Full original checksum/archive/patch unavailable; source preservation verified against later manifest only |
| Running OS / Ryzen cutover | No fresh runtime evidence; do not infer integration from PR or historical docs |

After owner integration, use an already-installed permitted browser, a separate empty disposable hub with fake/disconnected providers and a synthetic founder session established through normal identity:

```sh
bun scripts/crm/browser-acceptance.ts --disposable --base-url=http://localhost:8081 --browser-executable=/absolute/path/to/permitted/chromium --storage-state=/absolute/path/to/synthetic-founder.json --output-dir=/absolute/path/to/new-acceptance-output
```

The authored runner has not been executed here. It creates screenshots/report for the real mounted app at 1440/768/390 and exercises the company→contact→deal→next-action→proposal→project→delivery-task→result journey, edits/search/templates/validation/duplicates/reload/error recovery. Repeat the full journey at every width and manually verify focus trap/restore, Escape/Close/Cancel/Back/Forward, unsaved navigation, reduced motion, long text, empty states and real owning-service artifact links. Browser interception cannot prevent server-side provider calls; the isolated server configuration is required.

Then run the required full `bun run typecheck`, `bun run typecheck:scripts`, `bun run build`, and hermetically configured `bun test scripts src` against the actual integrated commit. Record that exact head, results and screenshots. [Detailed CRM verification and measured performance](https://github.com/RyzenAu/agenticos-v4-cloud-handoff/blob/5d5443fb1467741ddc97ace881f9a005ddb65586/docs/crm-20261002/RESUME-VERIFICATION.md).

## 8. Publication and remaining decisions

This documentation PR publishes only this handoff and sanitised path/hash inventory. Existing branch links provide the historical source without recreating or merging it. CRM PR #1 remains the implementation review. No shared patch, runtime database, log, credential, original private evidence, excluded lead-site work or unrelated project is included.

Claude's next decisions are bounded: confirm the current integration revision; classify older changed/absent paths as replaced, intentionally retired or needing a scoped review; supply the shared CRM mount/Jobs adapters; run actual application/release gates. This handoff does not authorise merge, deploy, production migration, client communication, provider activation, purchases or paid generation. Receptionist remains on hold.
