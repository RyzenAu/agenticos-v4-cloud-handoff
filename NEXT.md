# CRM resume checkpoint · 2 October 2026

Start with this file and `docs/crm-20261002/RESUME-VERIFICATION.md`. This is CRM implementation progress for Claude to integrate, not a release-ready mounted application.

## Git and ownership

- Repository: `RyzenAu/agenticos-v4-cloud-handoff`
- Draft PR: https://github.com/RyzenAu/agenticos-v4-cloud-handoff/pull/1
- Target: `handoff/claude-dev-baseline-20261002`, exact base `e9ad7c2bcd2fc4ae9e4778345e90d59265eed5fa`
- Previous published checkpoint: `d7fc93b62a55de9c77a2b5e74e73cf4cdcfff803`; the resumed commit is its direct descendant on `dot/crm-workspace-20261002`
- The PR body records the verified current head and tree. Confirm with `git rev-parse HEAD`; never substitute another baseline or overwrite the production checkout
- The base branch and remote PR were rechecked on 2 October: no newer Claude handoff or PR review comments were present
- Dot owns CRM/Leads. Claude owns shared navigation, identity gates, job runtime and release integration. All shared files remain at the handoff baseline in this branch; earlier unpublished shared edits remain separate

## Implemented in the resumed commit

The company journey now links contact, opportunity, next action, proposal draft, project, delivery task and recorded result. The dashboard identifies the next real missing step. Task completion or a project card move does not mark an agent job, invoice or deliverable complete.

Nine editable workflow templates have immutable prior versions and catalogue provenance. Applying one creates actual linked open tasks and draft documents in one CRM transaction, with an immutable activity and durable retry receipt. Proposal application checks the reviewed deal version and approved catalogue/agreed AUD price. There is no external send operation.

The 13 explicit fake-adapter business contracts cover migration/history/old links, repeated migration, manual corrections, edit conflicts, one project per deal, job-record subjects, duplicate events, out-of-order completions, artifact links, denied mutations, attribution, recovery and backup relationships. The owning Jobs subject reader is fake; its missing live persistence/filter has a separate TODO.

Measured performance changes batch document history reads, avoid per-contact canonical-record queries, load list projections without document bodies, defer full document bodies to an authenticated GET, and index UI contact lookup. Measurements and their limits are in the verification document.

## Integration still required from Claude

1. Mount the existing exported `crmPlugin` using the hub's root and internal page-token callback. Classify only the `/__crm` mount using the existing identity route policy; retain all current principal, origin, token and server-session gates
2. Regenerate TanStack's route tree with the CRM route source present and add the agreed CRM navigation link. No navigation or generated route file was changed here
3. Connect `configureCrmIntegrations(root, { publishChange, verifyAgent, verifyCommunicationEvidence })` to owning services. `publishChange` receives only `{ref, change, at}` after commit. Publish it through the existing stream. A missing publisher leaves focus/30-second polling as the UI fallback
4. Persist/filter the existing Jobs `subjects` contract, and verify the real saved job, subject and artifact before approving agent attribution. Wire Jarvis `crm.*` intents to `crmRuntime(root).operations`; page context already carries the explicit reference in `selection.search.ref`, so no new shared page-context field is needed
5. Run the mounted-app browser runner and manual checks at 1440, 768 and 390 px; then full UI/backend typechecks, build and the safely configured full release gate. Use only disposable data until all gates pass

The exact CRM API and source adapters exist; these owner steps do not require new provider permissions or activation. No denied shared-file contents or integration patch are published through another path.

## Resume commands and evidence

See `docs/crm-20261002/RESUME-VERIFICATION.md` for commands, fresh results and each blocked check; `RESUME-ACCEPTANCE.md` for the requested backlog; `WORKFLOW-TEMPLATES.md` for editable contracts; `MIGRATION.md` for dry-run, backup and rollback. The resumed change adds no schema migration; templates and receipts use the existing CRM settings table and are included in the existing whole-database backup.

No merge, deployment, production migration, provider activation, real client communication, invitation, purchase or paid generation has been performed. Receptionist remains on hold. The excluded lead-site work and unrelated project are outside this PR.
