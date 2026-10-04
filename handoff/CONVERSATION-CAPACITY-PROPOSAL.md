# Conversation capacity guards and pending continuity contract

Based on `handoff/claude-dev-baseline-20261004` at `a7bc83369b55fb7db5382f823edb0be9cb2c02d1`.
This is a backend guard patch for review. Claude retains release ownership. It is not a complete fix for the
conversation-continuity backlog and must not be presented as production acceptance.

## Implemented in this patch

- `appendMessage` throws a distinct `ConversationCapacityError` for a new typed message at the existing 500-message
  limit. Previously it returned the same `false` as an already-saved key, and `/thread/say` acknowledged the lost message.
- The command route returns its existing failed-save contract, `503 { ok: false, error }`, for that refusal. Duplicate
  keys still return success, including after store reconstruction at capacity. No new wire fields are introduced.
- A save counts client/typed messages separately from the up-to-300 merged job entries. A full read containing 500
  messages plus 300 job entries can be saved without a false capacity refusal. The raw request array remains bounded.
- The limit is also checked after preserving omitted server-written typed turns. An interleaved append cannot push a
  partial transcript save past the limit. Failure leaves the existing file unchanged and does not claim the rejected key.
- Verified-principal ownership, revisions, typed-omission preservation, job links, job-entry storage and retention, and
  draft origins are unchanged. No production data migration or deletion is performed.

## Still open: visible failure and continuing beyond 500

`src/components/operator/voice-companion.tsx:1446–1450` sends `/screen/command/thread/say` in the background, ignores
non-success responses, and swallows network errors. Its reply is already displayed locally, but failure to save it into
the default Jarvis thread is not surfaced. A truthful server failure is therefore not an end-to-end no-loss guarantee.
The default thread remains capped at 500; this patch does not add overflow persistence or pagination.
Legacy records already above 500 may round-trip their exact existing history for metadata-only saves and retries,
including a partial transcript whose preservation merge produces that same history. The request bound is at most the
existing message count plus 300 job entries. New or altered history that still exceeds 500 is refused; a save returning
to 500 or fewer is allowed under the existing preservation rules. No automatic migration or trimming is performed.

The separate job-entry path already has its own last-300-entry retention. This patch neither changes that policy nor
claims indefinite report retention. Full saved results remain the responsibility of the authoritative job/artifact stores.

## Still open: intentional deletion versus an incomplete snapshot

The backend cannot distinguish these requests today:

1. A companion submits its transcript, which has never contained the server-written `say:*` turns.
2. A reader intentionally removes a `say:*` turn and submits the remaining messages.

Both omit the turn at the same revision. `scripts/jarvis-command/draft-origin-r11.test.ts` explicitly requires the first
case to preserve the typed exchange. Removing the preservation merge, or incrementing the revision for every server
append, would break that behavior. Omitting a message is not treated as authorization to delete it.

## Proposed shared contract for Claude's review, not implemented

Use one server-owned typed-history resolver for reads, keyed appends, explicit deletion and replay detection, scoped to
the verified founder and the established conversation ID. Do not mint a different origin or move job/draft bindings when
history crosses a storage page boundary.

- Keep legacy saves compatible: absent explicit deletion keys, omitted typed turns are preserved. Add an opt-in list of
  exact `say:*` keys to delete on the existing revision-checked save. Reject unknown/foreign keys and job-entry keys.
  Persist content-free tombstones atomically with the save so stale retries and repeated `/thread/say` cannot resurrect a
  removed typed turn after restart. Define tombstone lifetime and replay scope before implementation; silent eviction
  must not create an unbounded promise of idempotency.
- Store typed history in bounded pages, proposed maximum 500 turns and 1 MiB UTF-8 text per page. Atomically commit an
  append and its stable request-key claim before acknowledging it. Reads use an owner/conversation-bound opaque cursor
  and a bounded page size. Job entries stay separate and retain their established semantics.
- Keep the current unpaged read shape during transition and negotiate exact recent-page metadata/ordering with the
  frontend. Do not hide older history without an explicit older-history affordance. No automatic retention deletion is
  authorized by this proposal. A total-byte quota and quota-exhaustion UX must be agreed, rather than unlimited storage.
- Claude's UI needs a durable pending-save state and retry of the same request ID for failed/uncertain typed saves. It
  must not advertise saved history before acknowledgment, discard pending content on navigation, or immediately retry a
  capacity error forever. The server must expose enough error detail for a recovery action agreed by both owners.

Required joint acceptance before closing the backlog: more than 500 typed turns across reload and server restart;
accepted-response loss and same-key retry; bounded page traversal with exact ordering; a typed append interleaved with
an older transcript save; explicit deletion followed by stale save and keyed replay; server job progress and final
reports preserved; founder isolation and bot permissions; unchanged conversation/draft/job origins; capacity/disk-write
failure visible with pending content recoverable. Cross-process store writes require their own locking/transaction
validation: these synchronous tests do not establish multi-process writer safety.

## Verification scope

Synthetic temporary stores only. The tests cover storage refusal/retry, merged entry bounds, interleaved save/append,
founder and revision guards, and the real command route/service/thread-store chain. Existing conversation and
coding-draft-origin regression tests are also run. The native Windows sharing test is skipped on Linux. Full release
build, all-repository checks, browser UI behavior, live providers, and production files remain unverified here.
