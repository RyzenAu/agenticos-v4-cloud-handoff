# Plain-answer persistence: Claude review patch

Review-only source proposal, based on the exact original client snapshots supplied for `a0da58145e4534dff29aacfd210ef3599f1f3909`. Nothing was applied to the integration frontend, published, or deployed. No CSS, layout, design, service configuration or active voice-engine implementation is changed.

## Bug and intended result

Reproduction: type `Reply with QA JARVIS 20261005 only.` Jarvis currently answers correctly, but the request and answer disappear after reload.

For the ordinary inactive typed Jarvis lane, this patch:

- Awaits a verified `/screen/command/thread/say` user save before routing, invoking a model, or dispatching a tool.
- Keeps the composer's existing request ID, captures conversation/style/target once, and sends `typed:true`, `requestId`, and zero-based `turnIndex` on durable `/voice/free/turn` requests. An omitted conversation is resolved by the verified user-save acknowledgement before effects.
- Requires the matching `persistence:{requestId,conversationId,saved:true,complete}` acknowledgement before using a typed decision. A terminal free-turn already saves the exact answer; the client does not append it twice.
- Removes command fallback from this durable lane. A persistence error or unknown outcome is visible and cannot become a different command execution.
- Keeps typed stage bodies and completed tool results in memory for same-ID, same-stage retries. HTTP `typed_*` errors are not discarded by the generic transient retry helper. A generated-but-unsaved answer stays visible, including if the next retry loses its connection.
- Saves non-model/local-route replies with an awaited acknowledgement. Retrying a failed reply save reuses the answer and does not rerun the route/tools.
- Clears the composer only after durable completion. A rejection leaves its words and identity in place and unlocks Send for the same-ID retry. Slow text truthfully says it is waiting for reply/save confirmation.
- Passes client-owned captured context separately through the typed tool dispatcher to the actual command adapter. Live page/scope getters and model-provided context cannot replace it. Local routing uses the captured page snapshot and fails closed when page/selected-reference/scope identity changes during save/model waits. Own-job, timestamp, label/facts and source refreshes do not retarget the request or block the next tool. Typed approval context is explicitly null: typed words cannot reuse a prior spoken approval, even when their text matches. Live voice retains its existing approval lookup.
- Separates effect-started from completion. Editing/unmounting cancels pre-start companion queue admission, including pre-microtask delivery and an awaited initial append; editing after effects begin only detaches its waiter, matching the prior owned-work behavior.
- Bounds volatile checkpoints to 64 requests per mounted companion, five model stages and 20 tool results. Existing Stop cancellation still gains explicit rejection notifications so waiting composers do not hang; no new Stop behavior is introduced.

## Scope compatibility

Scoped bot requests (`target.bot`) retain the old turn shape and routing: exact conversation ID and target, no new requestId/turnIndex opt-in, and no new founder-thread write. The scope adapter has a behavioral regression test. The active non-browser voice-session branch retains its previous behavior and is outside this plain typed persistence fix.

This patch depends on the backend's new durable typed-turn and thread-say protocol. Do not apply it against an older server and interpret a missing acknowledgement as success.

## Reload safety and limits

The current composer identity is saved in session storage. If the page reloads before completion, the composer reports an unknown outcome and refuses automatic/same-text replay. Its prior browser-tool checkpoint cannot be reconstructed safely. Check the saved conversation before deliberately starting a new request. This proposal does not claim exactly-once replay of arbitrary browser tools across a reload, tab closure, or browser crash. Session-storage unavailability also limits this reload guard; it does not affect the backend's persistent request identity checks.

The patch has not been applied to the real UI. Full-app typecheck/build, mounted React/browser tests, microphone/active voice sessions, real provider calls, and authenticated user reload QA were not run. Relevant frontend dependencies were not part of the supplied exact-original snapshot. Strict checking covers the new helper and event adapter, and TSX syntax checking covers both edited components.

## Files

- `src/lib/typed-persistence.ts`: durable save/turn adapters, stable stage checkpoints, fail-closed errors and scoped-bot adapter
- `src/lib/typed-persistence.test.ts`: synthetic behavioral tests of those adapters and real composer events
- `src/lib/jarvis-send.ts`: explicit rejection event, same-ID retry selection and interrupted composer identity
- `src/components/operator/voice-companion.tsx`: narrow typed execution/save integration
- `src/components/shell/pages/jarvis-thread.tsx`: retain failed draft/ID, show save errors and interrupted-reload status

`plain-answer-client-review-manifest.json` records SHA-256 hashes for every original and proposed output; new files have a null original hash. The patch applies cleanly to a fresh copy of the supplied originals, and every applied output was hash-compared with the reviewed source.

## Checks

27 focused tests passed with 106 assertions (22 persistence/scope/context/cancellation tests plus five existing event-adapter tests). They ran with synthetic HOME/TMP and injected Response/EventTarget boundaries; no network, model, user storage or tool execution occurred.

Also passed:
- strict TypeScript checking of typed-persistence.ts, jarvis-send.ts and their pure dependency
- TSX syntax transpilation of voice-companion.tsx and jarvis-thread.tsx
- `git apply --check` against untouched exact-original files
- apply-and-hash verification of all five proposed files

To review in Claude's separate UI branch, verify original hashes first, run `git apply --check plain-answer-client-review.patch`, apply it only after review, then run:

```sh
bun test src/lib/typed-persistence.test.ts src/lib/jarvis-send.test.ts
bun run typecheck
bun run build
```

Final browser acceptance after Claude integrates: perform the exact QA request, confirm the response carries a matching saved/complete acknowledgement, reload and verify both messages; inject user-save failure and prove no route/model/tool starts; inject final-save failure and prove the answer is retained, same-ID retry saves it, and no prior tool runs again; inject conflict/unknown and verify the explicit error with no fallback; verify a scoped bot's conversation/target remains intact.
