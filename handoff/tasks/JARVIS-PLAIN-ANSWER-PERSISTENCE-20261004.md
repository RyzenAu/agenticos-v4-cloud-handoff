# Founder Jarvis plain-answer persistence

Base: sanitized handoff `a0da58145e4534dff29aacfd210ef3599f1f3909`. This patch is a new bounded change, not the earlier paused integration. Merge the diff into Claude's current source while retaining already integrated admission, Stop and routing fixes. Do not replace shared files wholesale.

## Why this needs a client seam

The baseline founder composer executes a plain request through `voice-companion.tsx`'s `typedTurn`, posting `/voice/free/turn`. It does not necessarily call the command runner. The composer already has a stable request ID, but this request did not send it. Its separate `sayToThread` calls were fire-and-forget, hid non-2xx/timeouts, omitted origin, trimmed text to 4000 characters, and let the backend job-log masker replace the numeric QA token.

The backend patch alone therefore does not close the deployed repro. Claude must review the separate client patch: capture the originating Jarvis conversation and composer ID, await/verify saves, preserve unsaved input/answer, supply the new free-turn fields, and prevent a typed persistence error from invoking command fallback. Opt in only founder Jarvis turns; scoped bot turns retain the existing path and must not be rewritten to a default conversation.

## Wire contract

For `/voice/free/turn`, a founder typed turn opts in with:

- `typed: true`
- `requestId`: existing composer ID, 6–80 characters matching `[\w:.-]`; never derived from words
- `turnIndex`: stable tool-loop stage 0–4
- `conversationId`: captured owned Jarvis UUID, or omitted for the verified founder's deterministic default
- unchanged original user text as the first and only user message, followed by the existing tool-loop history

The host passes its verified principal independently from the optional memory caller. Only a human paired session or human loopback owner is admitted. Body identities, cookies and unrelated fields cannot grant access or change the binding. Foreign, unowned and bot conversations are rejected; another founder's still-missing reserved default cannot be claimed.

Response preserves the engine's application fields and adds `persistence: { requestId, conversationId, saved: true, complete }`. `complete` means no tool calls and a nonempty reply was saved. A response must never be treated as durable without this receipt. Scoped bots and legacy callers without requestId remain on their prior path and do not receive this guarantee.

`/screen/command/thread/say` accepts the existing `requestId`, `part` (`user`, `reply`, `note`), `role`, `text`, plus the same optional `conversationId`. Successful responses include `saved: true`. Early user saves are compatible with free-turn admission. An identical final reply save is idempotent. A changed part, role or origin is refused. Stored text is exact; oversized content is rejected rather than truncated or masked.

Errors include a stable `code`, `error`, and `saved: false` for free turns; thread/say uses `ok: false`. All `typed_*` errors stop generic command fallback:

- `typed_binding_invalid` 400: malformed/oversized/deep input
- `typed_identity_required` / `typed_conversation_forbidden` 403
- `typed_request_conflict` 409: changed binding or replay content
- `typed_conversation_full` 409: capacity refusal, distinct from a replay conflict
- `typed_outcome_unknown` 409: durable pending turn without a cached result; do not execute again
- `typed_save_failed` 503: storage failure; a terminal generated answer is returned as `content`, explicitly unsaved
- `typed_save_busy` 503: bounded in-memory pending-save capacity reached; no new turn admitted
- `typed_reply_missing` / `typed_reply_too_large` 502: invalid result cannot claim a saved answer

Free-turn input matches the existing 60-message/8-tool-call/8000-character-original-word limits; canonical input and cached result are each bounded at 128000 bytes, depth 12 and 10000 nodes. Private message fragments allow up to 20000 characters, without truncation. The retained failed-result map allows at most 64 entries, fails closed at capacity and never evicts uncertain entries into reruns.

## Durability model

The existing `conversations.json` atomic replacement stores server-owned typed receipts alongside existing messages, jobs and entries. Reservation and original user message are committed before invoking the engine. Completion atomically stores the application response and final reply. An identical stage replay reads its cached response, including after a restart. Concurrent duplicates share one invocation. Changed binding is rejected before dispatch.

If completion saving fails, the same process retains the generated response; retrying the identical stage saves it without regeneration. If the hub restarted with only a pending receipt, it reports an unknown outcome and refuses to run it again. This is recoverable partial persistence, not a promise to recover a generated answer lost in a process crash. Receipts never appear in conversation list/get responses and client snapshots cannot inject, erase or alter them or saved `say:` messages. Existing client messages, pins, jobs and pending draft links remain intact.

Atomicity is the existing synchronous read/modify/rename model within one hub process. No new cross-process coordination guarantee is claimed. Deleting a conversation also deletes its replay receipts. Cached tool selections do not replace the existing client command-event IDs or tool authorization controls.

## Verification

All tests used synthetic temporary roots, a synthetic HOME and no real model/network/account activity.

- Portable `plain-answer-contract.test.ts`: baseline 0 pass / 4 fail; candidate 4 pass. Baseline failures show missing plain exchange, numeric QA token masking, ignored origin and false-success at capacity.
- Final focused group (`typed-turn-persistence`, portable contract, conversations, draft-origin): 45 pass, 1 Windows-only skip, 0 fail, 187 assertions on the final frozen backend.
- Earlier command-directory regression: 388 pass, 0 fail, 2287 assertions. Later changes are covered by the final focused group; parent owns combined integration verification.
- Full and scoped script typechecks attempted but blocked by absent modules/dependencies in this partial handoff snapshot (including model-router/probe, design-system modules and React Query). No production-file diagnostic arose in the new helper, conversations, threads, route, service or free-voice. No full build or browser acceptance is claimed.

Focused command (absolute paths required by the isolated runner):

```
/tmp/agenticos-test-runtime.UMnOn4/run-isolated-tests.sh \
  /workspace/shared/agenticos-plain-persistence-20261004/scripts/jarvis-command/typed-turn-persistence.test.ts \
  /workspace/shared/agenticos-plain-persistence-20261004/scripts/jarvis-command/plain-answer-contract.test.ts \
  /workspace/shared/agenticos-plain-persistence-20261004/scripts/conversations.test.ts \
  /workspace/shared/agenticos-plain-persistence-20261004/scripts/jarvis-command/draft-origin-r11.test.ts
```

No remote writes, server restart, release or deployment was performed.
