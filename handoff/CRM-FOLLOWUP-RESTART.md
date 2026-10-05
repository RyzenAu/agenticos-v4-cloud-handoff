# CRM follow-up references across service restart

Based on handoff `181e346cc0af996c61a28acae59c4b4ac8f8afe5`, mapped to live `d56f306c8f32ffc1c59dd732c9245e06bcd00008`. The four affected source blobs are unchanged from `0af9b85a6604338d0834f2388db64b5d2a5660f8`, where the baseline reproduction failed.

## Behavior

A successful CRM lookup followed by “what stage is that deal in” or “what's the next action for it” retains its reference after command/job/conversation service recreation. Production stores one short-lived server-owned CRM reference in the existing owned conversation, with the original 15-minute TTL. It uses the exact CRM record ID and re-reads the record through the existing authorized CRM operations. Personal-memory sources and controls are unchanged.

The reference never crosses founders or conversations. Client snapshots cannot supply, overwrite, erase or read the internal reference. Missing, expired, future-dated, invalid, deleted, archived or merged targets ask for a named record. Company references with multiple deals ask which deal. Names colliding with renamed records or parser placeholders never select a different record.

Before a result-producing lookup, a durable generation invalidates the previous reference. A delayed result can save only against its matching generation. Failed persistence cannot restore an earlier record or make it authoritative after a newer lookup. If invalidation fails, the lookup does not run; if its final save fails, the answer explicitly says to name the record in the next request. Pending generations contain no CRM data and never resolve as references.

The existing in-memory fallback remains only for command services constructed without thread persistence. No routing framework was replaced; principal gates, device/model/account pins, command admission and release ownership are unchanged.

## Verification

- Baseline regression: client lookup succeeded, but the next stage query failed after reconstructing the services and reopening persisted stores.
- New synthetic tests cover restart, exact IDs, founders/conversations, default-thread aliases, TTL/replay, ambiguity, renamed/deleted/archived records, client snapshot spoofing, legacy ownership, unverified results, note payloads, permissions, malformed storage, persistence failures and overlapping requests.
- Tests use isolated HOME/data/vault paths and fake or local CRM providers. No live restart, provider action, personal-data fixture, merge or deployment was performed.
- Full build and aggregate verification remain for the release owner in the complete checkout. This handoff is a bounded source materialization, not a complete repository export.

Run `bun test scripts/jarvis-command/crm-followup-restart.test.ts` and the existing Jarvis command/conversation suites before integration. Then run the repository's typecheck/build/release checks and verify the two-turn flow in an authorized live session after the release owner restarts it.
