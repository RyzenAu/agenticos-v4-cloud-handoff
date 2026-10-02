# Published CRM progress checkpoint

This branch is an implementation checkpoint for review, not a runnable or release-ready integrated build.

## Published

CRM-owned records, safe migrations and rollback tooling, typed operations, imports, automation adapter, Finance reader, workspace UI, reference/link helpers, regression tests and evidence documents.

## Not published in this checkpoint

All nine shared integration files remain at the handoff baseline. The proposed shared patch is retained locally and is intentionally not included in this checkpoint. Publication review denied full-file uploads for:

- scripts/events/sources.ts: shared stream producer source
- src/lib/activity-stream.ts: shared browser stream source
- src/routeTree.gen.ts: generated route tree

No alternate path or patch is used to publish those denied contents. The other shared changes are kept separate so Claude can integrate the hooks together: vite.config.ts, scripts/identity/routes.ts, docs/IDENTITY-ROUTES.md, scripts/identity/fixtures/legacy-route-decisions.json, scripts/events/bus.ts and src/lib/page-context.ts.

Consequences: the new API is not mounted, /crm is absent from the committed generated route tree, and the event/context type extensions are missing. Building this checkpoint alone will require those integration changes; it must not be represented as runnable or deployed.

## Evidence scope

The other documents in this folder describe the complete assembled local candidate. Its safe combined suite passed 1,129 tests with three Windows-only skips and zero failures; both UI and backend TypeScript checks passed. Those results do NOT apply to this partial published tree in isolation. The remaining integration contents are excluded from publication following the tool denials and remain local for authorised review.

Independent review found no unresolved reproduced issue in the assembled candidate after the migration, duplicate-event, suppression, GST and concurrency fixes. Production build attempts were killed (SIGKILL/137); browser access was blocked (ERR_BLOCKED_BY_CLIENT); the broad suite was stopped over unestablished Typesafe egress. No blocked check is a pass.

Base: e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa on handoff/claude-dev-baseline-20261002. No merge, deployment or production migration is authorised by this checkpoint.
