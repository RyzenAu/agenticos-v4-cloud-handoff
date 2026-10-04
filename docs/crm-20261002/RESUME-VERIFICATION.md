# Fresh verification · resumed CRM package

This report covers the CRM-owned follow-through after checkpoint `d7fc93b62a55de9c77a2b5e74e73cf4cdcfff803`. The exact current head/tree and remote verification are in draft PR #1. It is based on handoff `e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa`; no shared integration files are included.

Earlier **1,129 passed** results describe a different assembled local candidate with unpublished shared hooks. They are retained as history in `VERIFICATION.md`/`verification.json`, not reused as a pass for this tree. `resume-verification.json` is the current machine-readable evidence.

## Fresh checks

| Check                                                  | Observed result and scope                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe CRM + Leads + UI + meeting suite                  | **680 passed, 1 TODO, 0 failed**, 3,228 assertions across 68 files. No provider or browser run. The existing socket-binding CRM HTTP test file was deliberately excluded; socketless HTTP contract tests ran instead                                                                                                        |
| Explicit business contracts                            | **13 passed, 1 TODO, 0 failed**, 149 assertions. Real disposable SQLite, existing durable Jobs and saved artifacts; fake owning-Jobs subjects/executor and injected HTTP identity                                                                                                                                           |
| Final affected UI/workflow/read checks                 | **32 passed, 0 failed**, 323 outer assertions across five files; includes the isolated React/linkedom child suite. The child tests do not render real browser pixels or verify native focus trapping                                                                                                                        |
| Backend TypeScript                                     | **Passed, exit 0**; full scripts configuration run serially                                                                                                                                                                                                                                                                 |
| CRM backend/tests/browser-runner TypeScript            | `scripts/crm/tsconfig.check.json` passed. Includes new contracts and the authored browser runner                                                                                                                                                                                                                            |
| CRM components/client/tests TypeScript                 | `scripts/crm/tsconfig.ui-check.json` passed. Deliberately scoped to CRM; excludes generated route integration and does not stand in for the full UI check                                                                                                                                                                   |
| Full UI TypeScript                                     | Attempt killed, **SIGKILL/exit 137**, no compiler diagnostics. An earlier concurrent attempt was also killed. Not counted as a pass                                                                                                                                                                                         |
| Independent reviews                                    | Runtime/workflow/store/UI boundary review found and verified fixes for read-only deferred content and maximum template text. Static browser-runner review found and corrected blank validation ordering, duplicate document DOM IDs, link assertions, local-only guards, startup-report handling and persistence assertions |
| Production build                                       | Not rerun in the resumed clean tree: CRM mounting/generated routing is Claude-owned and intentionally absent. Earlier assembled-candidate build attempts were killed with exit 137. No build pass is claimed                                                                                                                |
| Full repository release suite                          | Remains blocked by the earlier safety-review stop over unestablished Typesafe egress; its diagnostic was also denied. No provider retry or permission workaround was attempted                                                                                                                                              |
| Actual browser, screenshots, 1440/768/390 interactions | Not run: prior permitted cloud visit to `http://127.0.0.1:8131/crm` returned `net::ERR_BLOCKED_BY_CLIENT`. No alternate port/tool/browser/tunnel was used. No screenshot or rendered pass is supplied                                                                                                                       |
| Live providers/founder sessions/Windows checks         | Not exercised. Fake adapters do not establish live provider, identity or Windows acceptance                                                                                                                                                                                                                                 |

Initial combined verification exposed a missing `bun` executable in child-process PATH and a test assertion that incorrectly required notification time to equal record creation time to the millisecond. The PATH was supplied and the assertion now checks the exact safe event shape plus a valid non-regressing timestamp. The full combined rerun passed. Scoped typechecks also caught and fixed test-only typing issues and one remaining Finance-component dependency on the unpublished stream topic type.

## Reproduce safe verification

Use Bun 1.4.2, Node 24.19.0 and the frozen lockfile. Dependencies came from the previously verified frozen install; `bun.lock` is unchanged. Put the installed Bun directory on PATH because inherited CLI tests spawn `bun` by name.

```sh
bun install --frozen-lockfile
mapfile -t crm_test_files < <(rg --files scripts/crm | rg '\.test\.ts$' | rg -v '^scripts/crm/plugin.test.ts$' | sort)
HINDSIGHT_URL=off MU_MEMORY_WRITES=off AGENTIC_OS_NO_CODEX=1 AGENTIC_OS_NO_BACKGROUND=1 bun test "${crm_test_files[@]}" src/components/crm scripts/leads scripts/meeting-mode/meeting-mode.test.ts
node --max-old-space-size=2048 node_modules/typescript/bin/tsc --noEmit -p scripts/crm/tsconfig.check.json
node --max-old-space-size=2048 node_modules/typescript/bin/tsc --noEmit -p scripts/crm/tsconfig.ui-check.json
node --max-old-space-size=3072 node_modules/typescript/bin/tsc --noEmit -p tsconfig.scripts.json
bun scripts/crm/performance.ts --sizes=50,500,2000 --runs=5
```

The exclusions are transparent limits, not hidden passes. Once Claude has a permitted loopback test environment, also run `bun test scripts/crm/plugin.test.ts` for the original real HTTP transport checks. After integration, run the repository's required UI typecheck, build and full safely configured release gate. Do not enable live providers just to make synthetic checks pass.

## Measured performance

`performance-before.json` measures the published checkpoint implementation; `performance-after.json` measures the resumed implementation with the same seed and measurement command. The data sizes are 50, 500 and 2,000 companies, each with one contact, deal, project, task, document, activity and two document versions. Records and content are fictional, seeded in disposable SQLite files and removed afterward.

Measurements are warm local SQLite/typed-operation/pure-selector samples, five runs after warm-up. Reported median/p95 exclude JSON serialisation time; JSON byte counts are UTF-8 uncompressed payload sizes. SQL counts count executed prepared statements and exclude transaction control, PRAGMAs and fixture seeding. These are **not browser paint, HTTP or network latency measurements**. Small sample p95 is effectively the slowest observation; it is not an SLA.

The observed N+1 problem was fixed: snapshot query count no longer scales with every contact/document/version. Directory operations read only their needed record tables. UI company search builds the contacts index once. The HTTP snapshot explicitly omits document bodies (`contentDeferred: true`) and loads exact content/status history through authenticated `GET /__crm/record?ref=...` on expansion; original data and all document versions remain intact. The full snapshot remains proportional to record count; large-workspace pagination beyond existing list limits remains a future measured optimisation rather than a claimed fix.

| Companies | Full snapshot median ms | Snapshot SQL queries | 50-row list median ms | UI search median ms |    HTTP snapshot bytes |
| --------: | ----------------------: | -------------------: | --------------------: | ------------------: | ---------------------: |
|        50 |           2.472 → 1.827 |             214 → 16 |         1.897 → 0.690 |       0.427 → 0.195 |      298,611 → 187,011 |
|       500 |         61.574 → 17.729 |           2,014 → 16 |        45.018 → 6.560 |       4.021 → 1.984 |  2,986,211 → 1,870,211 |
|     2,000 |        364.943 → 65.758 |           8,014 → 16 |      354.179 → 27.390 |      31.175 → 6.547 | 11,982,211 → 7,518,211 |

Exact before/after medians, p95s, SQL counts and payload sizes are in the adjacent JSON files. `performance.test.ts` protects constant query counts, deferred-body semantics and exact version/status restoration without asserting flaky timing thresholds.

## Actual-app command for Claude

First integrate the mounts listed in `NEXT.md`. Use a separate empty disposable workspace, fake/disconnected provider adapters and a synthetic founder session established through the normal identity flow. Keep real credentials and production data out of that hub. Quiet/read-only mode intentionally rejects mutations, so use the integration owner's explicit disposable write-enabled configuration without weakening production identity gates. Do not start live jobs or providers to exercise this runner.

```sh
bun scripts/crm/browser-acceptance.ts --disposable --base-url=http://localhost:8081 --browser-executable=/absolute/path/to/permitted/chromium --storage-state=/absolute/path/to/synthetic-founder.json --output-dir=/absolute/path/to/new-acceptance-output
```

The executable must already be installed and permitted. The runner neither installs a browser nor obtains credentials. It refuses non-loopback hosts and non-empty company/deal/project data, blocks service workers and off-hub HTTP/WebSocket requests, avoids API redirects and writes a fresh run report before launching. Browser guards cannot constrain server-side providers; the disposable server setup is essential.

The runner exercises actual mounted controls for company/contact/deal/project/task/draft/result creation, editing, search, required validation, duplicate submission, reload persistence, template versions/application, keyboard tab switching, unsaved draft preservation under a held response, failed reads and recovery. It asserts saved relationships and external document link attributes without visiting the external link. It captures the delivery workspace and templates at 1440/768/390; those screenshots alone do not prove every interaction at each width.

Claude must additionally repeat the full interaction journey at all three widths, inspect the screenshots, test native focus trap/restore, Escape/Close/Cancel/Back/Forward, unsaved navigation, reduced motion, long-text overflow, all empty states, and real owning-service job/artifact links. The runner's `neverRun` list records these limits. Keep screenshots and its `report.json` with the final integration evidence. No screenshots from a DOM fixture are acceptable substitutes.

## Migration and rollback

No schema version changes were added in this resume. Editable templates and retry receipts use `crm_record_settings`; their linked tasks, documents and activity use existing tables. Whole-database backup includes those settings. Follow `MIGRATION.md` for schema-v1 dry run, count/hash reconciliation, verified backup, disposable rollback and preservation of original Leads tables. Do not apply to production before Claude's release gate and cutover review.
