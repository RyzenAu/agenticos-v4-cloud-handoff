# Open Dot add-on review: fixes (1 Oct 2026)

Branch `prog/fix-od-20261001`. Each fix has a regression test that failed on the reviewed code.

## Conversation ownership (C1, C7)
- A conversation belongs to the verified person who saved it. `/__operator/conversations` lists only the caller's own; save or delete of another person's conversation is 403. The owner comes from the principal, never the body.
- `ensureThread` never adopts a conversation by id: another person's id is refused, an unowned (legacy) id gets the caller their own default thread instead.
- **Migration rule:** conversations saved before ownership existed have no owner, and nothing records who made them, so they are not assigned. They are visible and editable only to the hub owner (`loopback-owner`, Usman at the hub PC), and are stamped with that person on their next save. Nobody else sees them.
- Thread and job text stored in a conversation (titles, notes, detail, added context) passes `maskJobText` first.

## Activity stream scope (C2, C8)
- A job or approval reaches the person it belongs to. Shared: coding, memory and trigger jobs; shared-computer jobs; merge, deploy, provider and trigger-review approvals. A job or approval with no known device ("none", unknown id) fails closed to the requester's person. Applies to live events, replay and snapshot.
- The stream re-checks the session every 60 s and before delivering an event (at most every 5 s); a revoked session or changed person ends it.
- **For the lead (unchanged, out of scope):** `/__jobs`, `/__jobs/events` and `/__approvals` are still unscoped to both founders (V7). So the stream is now narrower than those routes; the other founder's personal Jarvis jobs and approvals remain readable there. Decide whether to scope them or keep them shared.

## Follow-ups (C3)
A continuation marker attaches only when what follows overlaps the job's own topic (at least half its content words), or is an additive marker pointing back with their/its/them/those and exactly one job is open. "skip this song", "don't forget my 5pm meeting", "open YouTube" and the like run as new commands. A bare "stop it" cancels only a job mentioned in the last 2 minutes.

## Context helper (C4, C5)
`ctx_index` takes content, or one explicit regular file passing the Read verdict. Per-job data defaults to `<MU_DATA_DIR>/coding/context-mode/<jobId>/<roleId>` and is deleted when the job completes, fails or is cancelled. The install dir default (`D:/prog-scratch/ref-context-mode`) is still an env setting (`AGENTICOS_CONTEXT_MODE_DIR`); `removeWorktree` has no production caller, so cleanup hangs off the job end rather than the worktree removal.

## Triggers (C9) and seeds
The loop guard escapes `%`, `_` and `\` in stored refs (LIKE ... ESCAPE). The morning business summary routine is seeded paused; the owner opts in from Automations.
