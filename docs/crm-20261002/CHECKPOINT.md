# Published CRM implementation checkpoint

Read `NEXT.md` and `RESUME-VERIFICATION.md` first. This branch contains the CRM-owned implementation and resumed business workflow package. It remains unmounted and is not release-ready.

## Current package

The existing records, migrations, operations, imports, Jobs adapter, Finance reader and workspace are extended with the ordered company-to-delivery journey, next-real-action dashboard, nine editable versioned templates, explicit 13-case fake-adapter contracts, deferred document reads, measured query/search improvements and a runnable actual-app acceptance script for Claude.

Fresh safe verification: 680 passed, one explicit live Jobs integration TODO, zero failed. Final affected checks and exact typecheck outcomes are in `resume-verification.json`. The earlier 1,129-test result applies only to the first assembled local candidate with unpublished shared hooks; it is historical evidence, not a pass for this checkpoint.

## Remaining owner integration

No shared files were changed in the resumed branch. Claude must mount the CRM API, classify the mount through existing identity policy, regenerate routing/add the agreed navigation link, and connect existing Jobs subjects, Jarvis dispatch, provider readers and event publishing. CRM uses explicit extension callbacks and the existing page selection contract, so the previous new page-context field is no longer required.

The exact setup and verification sequence is in `NEXT.md`. CRM-owned modules and scoped tests compile independently; this does not make the whole mounted application verified.

## Earlier publication restrictions preserved

Earlier full-file uploads of `scripts/events/sources.ts`, `src/lib/activity-stream.ts` and `src/routeTree.gen.ts` were denied as broad shared-source scope. Six other shared files were held for cohesive integration: `vite.config.ts`, `scripts/identity/routes.ts`, `docs/IDENTITY-ROUTES.md`, `scripts/identity/fixtures/legacy-route-decisions.json`, `scripts/events/bus.ts` and `src/lib/page-context.ts`.

Those nine files remain at baseline in this PR. The old proposed shared patch remains unpublished; denied contents are not delivered through another file or path. No further retry of the denied files was made in the resume.

## Blocked gates

Actual browser access remains blocked by the prior `ERR_BLOCKED_BY_CLIENT`; no alternate port/tool/browser workaround was used and no screenshots are invented. Full UI TypeScript was killed with exit 137; scoped CRM UI and backend/tests checks passed. The production build still awaits owner integration and adequate resources; the earlier broad repository suite remains blocked over unestablished Typesafe egress. These are not passing checks.

Base: `e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa`. Previous checkpoint: `d7fc93b62a55de9c77a2b5e74e73cf4cdcfff803`. Current exact head/tree and remote CI status are recorded in the draft PR body. No merge, deployment, production migration or live outreach occurred.
