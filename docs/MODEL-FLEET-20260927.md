# Model fleet verification — 27 September 2026

## Replacement specialist implementation handback

Current local implementation: acknowledged tree cancellation, settlement before slot
release, unverified-termination quarantine, strict returned provider identity and a
tested metadata-only SQLite sink module. MiMo is explicitly permitted on free Cline;
Pixel remains excluded. Host sink constructor wiring is pending the voice owner/lead,
so durable live receipts are not yet claimed. No new provider calls or commits.

The unfinished cancellation checkpoint below is now locally repaired. New
`scripts/model-fleet/process-runner.ts` waits for child close plus acknowledged tree
termination, including timeout/output-limit; the bridge awaits runner settlement
before slot release and quarantines unverified termination. Custom signal-ignoring
runners have a six-second settlement grace, then emit termination_unverified and
quarantine. Windows native synthetic parent/child/grandchild tests prove all fixture
PIDs gone on abort, timeout, output limit and real HTTP disconnect. This is not a
new live Cline provider call or proof of arbitrary detached provider descendants.

Exact changed paths in this replacement turn, relative to
`C:/Users/Nebula PC/source/repos/AgenticOS-v4`:

- `scripts/cline-bridge.ts`
- `scripts/cline-bridge.test.ts`
- `scripts/model-fleet/policy.ts`
- `scripts/model-fleet/bridge.integration.test.ts`
- `scripts/model-fleet/process-runner.ts` (new)
- `scripts/model-fleet/process-runner.test.ts` (new)
- `scripts/model-fleet/receipt-sink.ts` (new)
- `scripts/model-fleet/receipt-sink.test.ts` (new)
- `docs/FALLBACK-ORDER.md`
- `docs/MODEL-FLEET-20260927.md`
- `docs/JARVIS-INDEPENDENT-REVIEW-20260927.md` (new)

Inherited lead-ranking and other fleet changes were preserved, not rewritten.
No commit; lead must independently review. No additional models called.

Verification: `bun --no-env-file test scripts/cline-bridge.test.ts scripts/leads/issues.test.ts scripts/model-fleet/bridge.integration.test.ts scripts/model-fleet/process-runner.test.ts scripts/model-fleet/receipt-sink.test.ts`.
Full project `bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p .` exit 0.
Scoped git diff --check exit 0. Final combined fleet run: **45 pass, 0 fail, 204 assertions,
5 files**. A subsequent reader-only check also explicitly covers authorised GET when
storage is absent: empty receipts and no database/directory creation. Signal-ignoring adapter test confirms a truthful
unverified receipt after grace and refusal of subsequent work. Existing cancellation
failure was established from source/checkpoint; no pre-patch red run is claimed.
Remaining integration dependencies: voice writer constructor/GET wiring (not present
at final source check), root operations table rendered/browser validation. External
dependencies: stable live provider transport and current quota/allowance remain
unverified; no repeat provider probes. Video reviewer identity/sink observations were
addressed here; its MiMo-exclusion claim was rejected by root under latest user policy.
Quarantine is instance-local; process survival must be accounted for before any
reload/replacement after termination_unverified. Provider usage on killed runs may
remain unknown; no invented zero usage or live business-review success.

Exact minimal host hook for lead/voice: import `modelFleetReceiptSink` from
`./model-fleet/receipt-sink`; replace `clineBridge()` with
`clineBridge({ onReceipt: modelFleetReceiptSink(root) })`. Sink lives only at
`.operator-data/model-fleet/receipts.sqlite`; no prompts/output are persisted.
SQLite reopen/projection and actual bridge-to-sink synthetic integration are tested;
existing onReceipt callback failures remain best effort, never an execution success
proof. Constructor was not edited because operator-plugin belongs to voice.

Reader hook sent to lead: import `modelFleetReceiptRoute` from the same sink module.
Beside authenticated control receipt registration:

```ts
const fleetReply = modelFleetReceiptRoute({ path, method, url, remote: !!remote,
  authenticated: req.headers["x-claude-os-token"] === token }, root);
if (fleetReply) return send(fleetReply.body, fleetReply.status);
```

GET `/__operator/model-fleet/receipts?limit=50` returns `{ receipts,
costBasis: "provider_reported", unknownCost: "null", invoiceReconciled: false }`.
Page token and local-owner checks are required even for GET; limit 1–100.
Rows: id, recordedAt (Unix ms), model, provider, nullable providerModel, outcome,
elapsedMs, contextTrimmed (0/1), fallback, nullable inputTokens/outputTokens/costUsd.
`readModelFleetReceipts(root, limit)` opens only the dedicated DB read-only; missing
DB returns empty receipts. No model text is returned. Root owns operations table.
Existing ai-usage source offers no safe receipt append API; its service starts a raw
transcript scanner/provider snapshot, so it was not invoked or used for this sink.

## Historical predecessor evidence and stop checkpoint

The following records describe earlier revisions. The current handback above
supersedes their native-tree and sink blockers; dated live reviews are preserved.

Bounded specialist in AgenticOS-v4, branch `jarvis-voice`. No commit, deployment,
account changes, private runtime/config reads, paid fallback or account rotation.
Latest user instruction permits Cline MiMo; Pixel remains excluded.

## Fresh fleet facts

Public Cline catalogue GET returned the exact IDs below in `free`; endpoint identified
in installed official `@cline/llms` source (CLI 3.0.65), without reading configuration.
AgenticOS `/__cline/v1/models` and Hermes `http://127.0.0.1:8642/health` returned 200.
These are metadata/reachability facts; completions separately establish authentication.

| Route / actual provider ID | Verified capability/cost | Entitlement gap |
|---|---|---|
| DeepSeek `cline-free/deepseek-v4.1-flash` | Live text/source review. Public free listing; later receipt USD 0. | Remaining quota/reset unknown. |
| MiMo `cline-free/mimo-v2.6-flash` | Live synthetic text review via Cline. Public free listing. | Remaining quota unknown; no OpenRouter use. |
| Muse `cline-free/muse-spark-1.3-contributor` | Live text/source review; receipt USD 0. Public/synthetic source only. | Remaining quota/reset unknown. |
| `cline-free/gemini-3.8-flash`, `stealth/space-bunny-alpha` | Public free listing and source aliases. | No completion in this task. |
| `stealth/pixel-canary` | Provider lists it; bridge refuses it. | Not used. |
| Claude bridge | Source IDs `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5`; text adapter. | Authentication/current availability/allowance unverified; no probe. |
| Codex current native account | Supported app usage: weekly 33% used/67% remaining, 10,080-minute window, reset Unix 1791083127, ordinary usage allowed, metered credit 0. | Snapshot for current account only; not Hermes pool or model-specific guarantee. |
| Hermes | Health 200; source exposes `hermes-agent` and explicit `gpt-6-astra` example. | No authenticated task probe/config read. |
| Gemini direct | Source `gemini-flash-latest`. | Account tier, alias resolution, remaining free quota unverified. |
| OpenRouter Gemini | Source `google/gemini-2.5-flash-lite`, `google/gemini-3.1-pro-preview`. | Metered route; no credit inspection/call; not fallback. |
| OpenRouter MiMo | Legacy module exists elsewhere; removed from issues execution. | Other callers outside scope; no call. |
| ElevenLabs | Source TTS endpoint exists; licensing plan-dependent. | Plan, commercial grant and credits unverified by this track. |
| Higgsfield | Source catalogue/schema integration exists. | Balance/model entitlement/historical cap remainder unverified; no paid job. |
| Freebuff | Dated handoff only. | Current model/allowance unverified; no desktop action. |

The bridge exposes **text only**, regardless of base-model capabilities. Official
catalogue describes DeepSeek 1M context and Muse multimodal reasoning; this adapter's
26,000 escaped-character limit is separate. No invented RPM/RPD allowances.

Interfaces: `clineBridge({ onReceipt, availability, run })`, `complete(body, signal?)`,
HTTP `handle(req,res)`. `Receipt` and `Availability` live in `scripts/model-fleet/policy.ts`.
The runner now receives AbortSignal as fourth argument. The receipt callback is an
integration interface, not durable dashboard storage. See [fallback policy](FALLBACK-ORDER.md).

## Live evidence

All reviews used existing AgenticOS `/__cline/v1/chat/completions`, source/synthetic
data only, no tools, at most two in flight. Evidence contains review outputs/metadata,
not private transcripts/traces. Model findings require independent reproduction.

| Review | Model | Elapsed ms | Input/output tokens | Evidence file under scripts/model-fleet |
|---|---|---:|---:|---|
| Synthetic economics | DeepSeek | 13957 | 9865 / 1331 | review-results.json |
| Synthetic finance adapter | MiMo | 18910 | 9269 / 519 | review-results.json |
| Synthetic routing QA | Muse | 16432 | 5368 / 812 | review-results.json |
| Actual receptionist flags/signals plus type/incident excerpts | Muse | 77175 | 12996 / 5298 | source-review-results.json |
| Actual legal film-loader block | DeepSeek | 109306 | 12009 / 20333 | source-review-results.json |

First three probes preceded receipt hardening: free listing verified, actual provider
cost not returned. Later source reviews reported `costUsd:0`, no trimming/fallback.
Source-review files include SHA256 of the exact excerpt, not a claim to review a whole repo.

Root findings to reproduce:
- Muse: bare `000` may suppress missed-advice flags; “zero zero zero” may be missed;
  same-clause clinician deferral may mask clinical directives; ended-call-ID cache
  may retain clean results after late final turns.
- DeepSeek film: inspect fallback after breakpoint reset, discarded image generations,
  and permanent loading flags after errors. Window/onload scheduling appeared bounded.
  Its scrollbar/media-query claim is unverified; intentional no-retry is a trade-off.
- Toy economics found GST denominator/support omission. Toy MiMo review was imperfect:
  suggested float-to-cents conversion still rounds, and unconditional timestamp claim
  ignores thrown exceptions. Do not adopt model suggestions mechanically.

Follow-up at approximately 05:29 UTC: independently invoked current `callFlags` and
`checkCall` with Muse's four synthetic cases. Current results are correct:
bare-number => `URGENT_NO_000`; spoken-zeros => no flags; clinical-deferral =>
`CLINICAL_ADVICE`; late-ended-update => `DANGER_LANGUAGE, URGENT_NO_000` and checked.
The original Muse excerpt hash is therefore historical; these findings are stale/fixed
in root's concurrent work and must not be reported as current open defects.

Actual economics/NAB reviews initially hit ECONNRESET during local source reload;
result/usage unknown. One deliberate retry followed fresh local catalogue health.
No automatic provider/model fallback. See business-review-results.json when available.
The second parallel attempt also failed without usable results. Root authorised one
deliberate repeat after fresh health: a sequential PowerShell HTTP run followed.
Economics again failed after 91,974 ms and NAB after 160,338 ms, both with
HttpRequestException; no completed actual business source review or usage is claimed.
Read-only diagnostics showed port 8081 listening under bun.exe PID 90128 (parent 52076),
and GET models 200 with Pixel absent. No logs, command-line secrets or service restarts.
Listener PID remained unchanged across the economics disconnect, and bridge/policy
mtime preceded the request. Exact reset cause remains unproven. Process metadata also
showed an older unrelated Cline session, so no restart/blanket process termination was
appropriate. This is a live transport dependency, not a passing business review.
Read-only file metadata correlates the disconnects with concurrent source reloads:
vite.config.ts changed at 15:29:58 Sydney immediately before economics failed around
15:30:00; receptionist/flags.ts changed 15:32:39 immediately before NAB disconnected
around 15:32:40. Vite reload is strongly suggested, not proven from logs (none read).
No further completion retries are scheduled; root needs a stable source-review window.

## Checks and limitations

`bun test scripts/cline-bridge.test.ts scripts/leads/issues.test.ts scripts/model-fleet/bridge.integration.test.ts`
passed **34 tests / 157 assertions**. Real Node HTTP handler transport with synthetic
provider adapters covers Pixel/prototype-key refusal, MiMo permission, stale/free
checks, tools/images refusal, timeout, actual HTTP disconnect, queue saturation,
queued cancellation, late-result suppression, sanitised errors, clipping and null usage.
One additional red/green regression proves that aborted provider results retain their
reported usage in the failure receipt. Parsing usage now precedes finish-status validation.
Fresh live route checks after final edit: catalogue HTTP 200 with Pixel absent;
synthetic Pixel request HTTP 403 before model dispatch. Final full tsc exited 0.

`bun node_modules/typescript/bin/tsc --noEmit -p .` exited 0. An initial queue test
stalled because a pending Bun rejection matcher preceded abort; corrected test order
passed in the full focused run. No whole-app build/suite claim. Native Cline process
tree termination, physical voice, real banking and remaining quotas remain unverified.
Full tsc repeated after another specialist reported a line-159 error: current source
again exited 0 without diagnostics (27 September approximately 05:29 UTC). That
earlier diagnostic was not reproducible against this revision.

Owned files use Git HEAD's LF endings. Paid issue ranking is removed; deprecated
`rankWithMimo` compatibility alias remains for out-of-scope CLI/batch imports. No
model calls or ledger reads remain in that path. Root independently reviews/commits.

## Official references

- [Current Cline free catalogue](https://api.cline.bot/api/v1/ai/cline/recommended-models).
- [Free promotion terms](https://github.com/cline/cline/blob/main/docs/getting-started/free-models.mdx): rotating limited quotas, CLI/IDE access, possible model-improvement use.
- [Cline CLI flags](https://docs.cline.bot/usage/cli-overview): provider/model, timeout, auto-approval.
- [Model capabilities](https://docs.cline.bot/api/models): model-specific support does not expand this adapter.
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [3.8 Flash update](https://ai.google.dev/gemini-api/docs/latest-model?hl=en): published introductory USD 0.75/M input, 3.75/M output through December 2026; not this account's entitlement or Cline pricing.
- [ElevenLabs plans](https://elevenlabs.io/pricing): advertised plans are not evidence of this account's commercial allowance.

## Specialist stop checkpoint — 2026-09-27 (user model reassignment)

Stopped at user instruction; all files preserved, no commit. No provider call is running from this specialist; all our probe jobs completed. No processes were cancelled or services restarted. Historical server PID 90128 (parent 52076) and unrelated Cline PID 107144 (parent 149076) were observed earlier only; current state was not rechecked at stop. Last two read-only tool calls completed successfully; no shell job remains from them.

Current fleet changes: scripts/cline-bridge.ts and test; scripts/leads/issues.ts and test; scripts/model-fleet/{policy.ts,bridge.integration.test.ts,review-probes.ts,review-results.json,source-review.ts,source-review-results.json,business-review-results.json}; docs/MODEL-FLEET-20260927.md and docs/FALLBACK-ORDER.md. Original tracked LF style restored; issues diff last measured 9 insertions/72 deletions, focused test 13/24. Latest fleet verification before stop: 34 tests passed, 157 assertions; full `bun node_modules/typescript/bin/tsc --noEmit -p .` exit 0 after receipt fix. The reported line159 TS failure was not reproducible; do not claim an additional TS repair. Last scoped diff check passed. Use --no-env-file for subsequent Bun commands.

Provider evidence: all three requested free Cline models completed useful synthetic reviews. Actual source reviews completed for Muse receptionist flags and DeepSeek legal film; saved results include hashes, elapsed and usage, reported cost 0. Actual DeepSeek economics and MiMo NAB reviews failed transport, including the single deliberate repeat (91,974ms and 160,338ms respectively); no business review success claimed. Vite reload timing correlated with resets but is not proven. User now says STOP provider probes; no further retries or paid fallback. Remaining account quotas/entitlements remain unknown.

CRITICAL UNFINISHED FIX: root found default spawnRun immediately rejects after child.kill; outer abortable(run(...)) releases concurrency before child close and Windows descendants may survive. No patch for this finding was applied before stop. Next owner must implement actual tree termination, wait for process settlement before releasing active slot, fail closed/quarantine if termination remains unverified, and truthful termination-unverified receipt distinct from confirmed cancellation. scripts/jarvis-execution/child.ts was inspected as a reference: it waits child close plus successful taskkill, but has no output collection and uses env {}. Do not alter voice-owned helper without coordination. Add real synthetic parent/grandchild tests plus queued-slot regression and timeout/disconnect tests; revise adapter tests that currently use never-settling runners. Rerun focused fleet tests, full tsc and scoped diff checks. Coordinate independent review with Mill through lead: app thread listing did not expose Mill; no message sent and no agents started.

UNFINISHED VOICE INDEPENDENT REVIEW: user authorized report docs/JARVIS-INDEPENDENT-REVIEW-20260927.md only, no voice edits. Report not yet written. Read docs/JARVIS-ACCEPTANCE-20260927.md and actual server-approval/client control/child/journal/transcript files plus operator/Vite/free-client source. Independent `bun --no-env-file test scripts/jarvis-execution scripts/jarvis-control.test.ts scripts/control-risk.test.ts scripts/control-outcome.test.ts scripts/free-voice-client.test.ts` passed 229 tests, 639 assertions, 8 files. Approval gates bind exact task/request, two-minute expiry, one-use nonce and request dedup; local/token checks inspected. No replay defect established. Privacy: transcript persistence defaults off; upstream Hermes retention remains unverified; journal helper is not actual operations integration.

Voice review findings requiring final verification/report: (1) production vite.config.ts killTree around818 ignores taskkill nonzero exit (only error event falls back), and cancellation tests exercise runChild/shared disconnect rather than that actual killTree path; do not infer verified production tree termination. (2) free-voice-client.ts speculative onTool around1353 receives session signal, whereas invalidateCurrentTurn aborts turn controller; stop may not cancel an already dispatched speculative action. scripts/free-voice.ts reflexPartial around1163 restricts these to show-only page/website actions; do not label them arbitrary external control. Confirm scope and document accurately without editing voice. Final report should distinguish source observations, synthetic verification and physical/live acceptance not performed. No mic/private data was used.
