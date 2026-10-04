# Final independent Jarvis review — 27 September 2026

## CURRENT status — owner checkpoint, work stopped

Stopped at the owner's handoff request at a safe boundary. All tool calls and
synthetic tests completed; no owned running process, shell session, provider job or
agent remains. Files preserved, no commit. No new work/provider calls will start
until owner continuation reassigns scope.

Latest completed checks: final independent bounded suite **270 pass / 0 fail /
852 assertions / 16 files**; report-only git diff --check exit 0. Earlier fleet
suite **45 pass / 204 assertions / 5 files**, followed by sink-only **3 pass /
20 assertions**; earlier full tsc exit 0. These checks apply to their dated
revisions; no fresh build, full suite, browser or live-provider acceptance claim.

Current shared source has voice-owned constructor/GET receipt hooks, acknowledged
control watchdog, speculative cancellation and the intentional Hermes retention
503 gate. Unfinished: supported no-history/no-file-log Hermes execution proof;
runtime admission containment after unverified tree termination; visible sink
write-failure reporting; root rendered receipt UI and physical/live acceptance.

This specialist generated **no voice samples/audio/video**, made **no provider
calls**, and incurred no observed provider charge. Prior three-model free-route
reviews and reported USD 0 receipts are inherited historical evidence in
MODEL-FLEET-20260927.md, not newly measured cost or remaining allowance. Actual
business-review transport failures remain failures; killed-run costs may be unknown.

Exact changed paths across this replacement specialist's work, relative to
`C:/Users/Nebula PC/source/repos/AgenticOS-v4`:

- `scripts/cline-bridge.ts`
- `scripts/cline-bridge.test.ts`
- `scripts/model-fleet/policy.ts`
- `scripts/model-fleet/bridge.integration.test.ts`
- `scripts/model-fleet/process-runner.ts`
- `scripts/model-fleet/process-runner.test.ts`
- `scripts/model-fleet/receipt-sink.ts`
- `scripts/model-fleet/receipt-sink.test.ts`
- `docs/FALLBACK-ORDER.md`
- `docs/MODEL-FLEET-20260927.md`
- `docs/JARVIS-INDEPENDENT-REVIEW-20260927.md`

Inherited lead-ranking/review artefacts were preserved. Voice implementation and
operator-plugin hooks were changed by their owner, not this specialist. Existing
owner application/services must be left alone; no service was restarted or stopped.

## Final independent review at checkpoint

Current verdict: the previous watchdog, speculative cancellation and receipt-hook findings are resolved in reviewed source and targeted synthetic checks. Hermes control is intentionally unavailable with HTTP 503 until per-task history/file-log suppression is verified. This is a locally reviewed candidate, not live voice/executor acceptance. No implementation was changed in this review; only this report was written. No provider calls, private logs/journals, microphone, account actions or commits.

## Reviewed current integration

- `scripts/jarvis-execution/{child,journal,runtime,routes,server-approval,hermes-retention}.ts`, their tests and client receipt/lifecycle checks.
- Minimal `scripts/operator-plugin.ts` host/auth registration, control approval/receipts and Cline constructor; Vite control admission, child attachment, watchdog and disconnect paths.
- `scripts/model-fleet/receipt-sink.ts`, actual constructor and authenticated reader hooks; bridge provider identity/settlement; affected speculative client dispatch and transcript default.

Exact canonical prompt/task, UUID and expiring one-use server approval remain enforced. Runtime owner/policy are server-derived. Duplicate IDs do not replay; interrupted jobs recover unverified. Ordinary CLI completion has no independent verifier in the runtime wrapper, so successful exit remains unverified rather than falsely succeeded. Browser transcript persistence defaults off.

Current control watchdog calls `stopExecutionForWatchdog`, which selects journal cancellation and `stopOwnedChild` for a control ticket. Parent close waits for tree-stop acknowledgement; failed acknowledgement yields unverified. Legacy killTree remains for non-control chat and is outside this control-path acceptance. Source-registration assertions and real synthetic Windows process checks corroborate the wiring; the full Vite provider middleware was not booted.

Speculative navigate/open_url dispatch uses `AbortSignal.any([signal, controller.signal])`; turn invalidation aborts reflexController. Current actual-client synthetic tests observe abort on interruption and Stop and suppress late speculative success. Fake media/providers do not establish physical barge-in or browser navigation cancellation after an OS action has already happened.

Cline constructor is now `clineBridge({ onReceipt: modelFleetReceiptSink(root) })`. Operator GET `/__operator/model-fleet/receipts?limit=50` calls modelFleetReceiptRoute under existing host/origin checks plus explicit page-token/local-owner checks. Actual operator registration HTTP test reads a seeded synthetic sink, retains null cost and refuses tokenless/remote reads. Separate reader tests establish absent storage returns empty receipts without creating a DB. The root UI contract is flattened `{ receipts: [...] }` metadata; no source review text or prompts/output are returned. No rendered UI/live ledger was inspected.

Returned provider/model identity must match or completion fails; providerModel is null until verified. Null usage/cost remains unknown. MiMo is permitted via free Cline; Pixel excluded. There is no automatic paid fallback.

## Actionable remaining gates and limits

1. **Live Hermes control blocker: retention suppression unverified.** `hermesControlRetentionAdmission()` always refuses with 503 / hermes_retention_unverified, before runtime admission/spawn for yolo or control envelopes. Warm operator task route also returns fallback 503. Keep this gate until the actual runtime has a supported independently demonstrated no-history/no-file-log mode. Client flags/environment cannot override it. Retention tests use synthetic HTTP plus source-placement assertions; no private Hermes state was read.
2. **Contain unverified child termination before enabling control.** Source observation: runtime.ts settles ChildTerminationUnverified, removes the active completion, and accepts a fresh ID; it has no quarantine/worker-poison state after an unacknowledged stop. Surviving external work could overlap a later task if control were enabled. Existing tests establish truthful unverified status, not containment of subsequent admission. Add fail-closed admission after unverified termination, with explicit independent process accounting before recovery. This is a pre-enable requirement; the current 503 gate prevents live control dispatch. Cline's separate runner already quarantines its own unverified termination.
3. **Receipt persistence is best effort, not a complete cost ledger.** cline-bridge.ts catches onReceipt exceptions. A SQLite write failure can therefore return a completed model result without durable usage metadata or a recorder error visible in the GET rows. Add sanitised recorder failure visibility if the UI is intended to account for every run. Do not interpret missing receipts/null costs as zero spend or invoice reconciliation. This limitation does not invalidate tested metadata reads.

No new approval replay or metadata-authentication defect was established. Physical microphone/speaker/echo, actual Hermes tool cancellation, native Save As, browser-rendered operations receipts and live quota/cost reconciliation remain unverified external/integration acceptance. No whole-product completion claim.

## Independent verification

From `C:/Users/Nebula PC/source/repos/AgenticOS-v4`:

```powershell
bun --no-env-file test scripts/jarvis-execution scripts/jarvis-control.test.ts scripts/control-risk.test.ts scripts/control-outcome.test.ts scripts/free-voice-client.test.ts scripts/model-fleet/receipt-sink.test.ts scripts/model-fleet/bridge.integration.test.ts scripts/model-fleet/process-runner.test.ts scripts/cline-bridge.test.ts
```

Observed **270 pass, 0 fail, 852 assertions, 16 files**. This is the independent bounded selection; the owner's 448-test report was not repeated or adopted as independent evidence. No test failure. One source-search command used a Windows-incompatible glob and exited 1; explicit directory/file searches replaced it. No implementation fix followed.

Evidence levels: actual temporary SQLite/reopen/leases and synthetic file effects; actual loopback operator/bridge HTTP; native Windows synthetic process trees; fake provider/media/client signals; static Vite registration/retention-placement assertions. These are not live Cline/Hermes or physical voice evidence. No build/typecheck was rerun in this read-only final pass; earlier typecheck exit 0 remains historical.

Snapshot SHA256:

- runtime.ts: 9B8F1526FBA42E3EA0478166CD8626C1602AC241B18FB793F0EB8F6A2D85A3D2
- hermes-retention.ts: C9DA8D60114A61320B481471599B6A7CDB3372744444F103DED25A7C07AF2EC7
- receipt-sink.ts: 4A03BDACD7CD2586C2C23797B461151D13D4C9A31121B004193A6C4CEAAAC59E
- free-voice-client.ts: 44F24D8D7EEF4F33698F1F3ABE39653DD46E88A5D4A5A9368CDB8409F6979DE3

## Historical evidence, superseded findings

Earlier independent run: 229 pass / 639 assertions / 8 files, then 5 runtime/routes tests / 49 assertions. At that revision watchdog used legacy killTree, speculative dispatch used session-only signal, and sink hooks were absent. Those are historical findings now resolved as above. Previous JobReceipt type and missing runtime-test concerns were also repaired before this final review. Prior live fleet model reviews belong to MODEL-FLEET-20260927.md; none were repeated here.

Exact changed path this final review: `docs/JARVIS-INDEPENDENT-REVIEW-20260927.md`. Lead owns integration decisions and any implementation response to findings.
