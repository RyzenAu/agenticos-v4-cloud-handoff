# Preserve requests across Jarvis routing questions

Based on handoff `b757e4e68d58186a550a2a55419d666d6748add8`, which maps to live `d83f8f8be24fb82eade878f6c98350472cf377c3`. The intervening CRM restart and founder-CSRF fixes are preserved unchanged.

## Fixed behavior

A routing question retains the original accepted request. Answering “Research” chooses the offered Research route for that request, rather than starting a task about the word “Research”. A coding route answer keeps its original explicit model/account pin. The request survives command, job and conversation service recreation, including the observed 126-second delay.

The server-owned conversation slot is separate from personal memory, CRM references and final-action approvals. It binds the verified person, conversation, authority class, original request/event, finite offered choices, selected context and target, pins and a 30-minute expiry. Client conversation snapshots cannot read or overwrite it. A generation check rejects late questions from superseded requests.

Reply admission is recorded from the actual incoming words before restoring task data. A reply consumes the question at most once; same-event retries use the existing admission receipt. Conflicting target/step metadata is rejected before consumption. Unkeyed route answers are refused without consuming the question. Expired, cancelled, ambiguous and already-consumed choices start no work. New task text remains a new request.

The selected lane narrows the current catalogue. Existing target, permission, account/model and approval checks still run; unavailable pins and changed own-device resolution are refused without substitution. Historical voice context is snapshotted, never replaced by a newer page or written back over it. A device choice cannot enter a CRM or other non-device outage fallback.

Stop retains the original job-cancellation path. Resumed requests waiting for their router are also stopped by their exact admitted event within the originating/target bot scope. Explicit bot targets and named-bot Stop phrases cannot cancel unrelated pending questions. Transcript-write failure cannot prevent stopping the known job, and the reply discloses if a saved question could not be cleared. Streamed and returned results share clarification provenance, including pre-execution refusal paths.

## Verification

- Released baseline: the Sydney Opera House original-request regression and explicit coding-pin regression both fail for the intended reasons.
- Final focused current-tree suite: 616 passed, 1 Windows-only skip, 0 failed; 3,250 assertions across 39 files.
- Focused tests use empty isolated HOME/TMPDIR/vault directories, disabled background/local-provider work, synthetic routing/execution boundaries and real temporary conversation/job stores. No live provider, personal-data fixture, server restart or deployment was used.
- Independent final subset: 135 passed, 0 failed; 685 assertions across the five native-acceptance files below. Strict changed-file TypeScript checking passed with the repository configuration and actual dependency types. Full native repository typecheck/build and live acceptance remain release-owner gates.

## Native acceptance

Run these five synthetic suites in the complete checkout:

- `scripts/jarvis-command/clarification.test.ts`
- `scripts/jarvis-command/clarification-continuity.test.ts`
- `scripts/jarvis-command/crm-followup-restart.test.ts`
- `scripts/jarvis-command/durable-admission.test.ts`
- `scripts/jarvis-command/stage-c.e2e.test.ts`

Then run the repository's native typecheck/build gates. Keep the release owner as the sole person merging/restarting. In an authorized founder session, verify that any offered routing clarification resumes the original task and returns its result to the original conversation. A direct successful route alone does not exercise the clarification branch; the synthetic suite explicitly does.
