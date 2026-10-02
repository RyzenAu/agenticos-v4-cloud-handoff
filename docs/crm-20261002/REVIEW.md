# Independent review record

The reviewer inspected implementation code read-only and reproduced issues using disposable in-memory/file-backed data. Findings addressed before publication:

- Changed activity payload under the same event ID now conflicts instead of claiming a lost change was saved
- Provider occurrence identity deduplicates across caller-supplied event IDs; verified evidence is bound to the target record
- Suppression propagates to existing matching companies and child contacts; imported outreach follow-ups cancel when only the suppression registry changes
- Pre-existing forward-pointing duplicate relationships and late legacy updates resolve to the canonical company; UI follows repeated merges with a cycle guard
- Legacy ex-GST changes correctly round-trip to inclusive CRM values; unsupported legacy no-GST treatment is refused
- Receptionist holds consistently include combined offers and catalogue-only references
- Runtime migration verifies a consistent backup; migration checks originals/counts/relationships and rolls back on failure
- Trusted provider/job reader hooks are explicit, removable and fail closed
- Real four-process retry tests exposed a SQLite read-to-write lock upgrade race. Immediate transaction admission plus locked schema-version recheck fixed it; concurrent migrations, activity retries, stale CAS edits and automation retries are tested

The final review also covered the authenticated read-only Finance endpoint, exact-URL matching, stale evidence labels, GST-normalised UI totals and automation controls. No unresolved reproduced data/security finding was accepted as a feature limitation. External service wiring and unavailable verification gates are explicitly listed in the acceptance matrix.

This is code/synthetic-test review, not live provider, Windows or rendered-browser acceptance. Browser restrictions and the full release-gate blockers remain release blockers for Claude.
