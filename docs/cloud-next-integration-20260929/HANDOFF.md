# Release candidate handoff: cloud/agenticos-next-integration-20260929 (29 Sep 2026)

Candidate only. Not merged to main or the live OS, not deployed, no live provider, no private data. Synthetic fixtures throughout. The live OS merge is reserved for the owner's explicit approval.

## Source heads (recorded before integration)

| Branch | Head | Status here |
| --- | --- | --- |
| cloud/integration-j6-f1-p1 (start point) | e9366d8 | base of the candidate |
| cloud/nexus-interface-20260929 | ebc5b47 | integrated |
| cloud/memory-finance-20260929 | 9382382 | integrated |
| cloud/jarvis-device-coding-20260929 | 83361ca (owner-declared final, confirmed with git ls-remote; earlier a689c94 and e5eb59a were partial) | integrated, clean merge |

Working tree was clean and no stash existed at the start. main is 3a8d304.

## What is in the candidate (after e9366d8)

1. NEXUS merged clean: palette rows name where they act, one shared `os:handoff` signal, still Command scene (hollow gold mark unless live, no ambient drift, one 2D sweep only for moving work).
2. Memory and NAB CSV merged clean: copied notes count once, rename plus edit keeps identity, recall provenance, package-payment candidate route.
3. Finance page panel "Possible receptionist package payments": source, as-of, last import, "not a live bank feed", "possible match", UNKNOWN (never zero) for an uncovered period, failed-read notice, and the caveat that an amount can coincide. It never says a client paid. Approved monthly prices only (A$699/1099/1999 plus GST); setup fees and pilot terms stay unapproved and unmatched. No price changed.
4. Jarvis, device and coding slice (83361ca) merged clean, no conflicts (the only shared file, `operator-plugin.ts`, touched different lines). Reviewed: shared typed/spoken context resolver, "here" origin rule in `resolveTarget`, dispatch idempotency key, per-person device ownership, coding entry that hands coding words to the harness with the verified principal, money words blocked before the coding entry, role choice with a different-family reviewer, Jev's proposal recorded but unable to pick the reviewer's model, free-only never picking a paid model, receipts.
5. New cross-slice contract test `scripts/integration/next-contracts.test.ts` (6 tests): the palette's "Runs on ..." line agrees with the device contract (Mehroz's "here" names his PC, naming Usman's PC is refused, offline never falls back), and coding job device ids reach the handoff row without animating while waiting on a yes.
6. Memory fix (risk 1, concrete): an unindexed or forgotten note's identity now goes only to a near-identical note (similarity 0.85 or more). A look-alike between 0.6 and 0.85 gets neither the identity nor an index entry: it is held out and listed in skipped as "held: looks like ..., give it its own id in the frontmatter to index it". Tests: a similar different note is held, does not appear in recall, and indexes normally once given its own id; the existing rename-plus-edit-stays-out test still passes.
7. Mail-archive close (risk 2, root-caused and fixed): in Bun 1.3.11 on Linux, `db.close(true)` throws "database is locked" whenever any statement was prepared, even on a bare one-table database with nothing else open (reproduced in isolation). Every write in the archive is its own committed transaction (BEGIN IMMEDIATE .. COMMIT) and migrations run at open, so nothing pending is lost, and a fresh handle sees every committed message (test). `close()` now falls back to the plain `close()` only for a locked/busy error and rethrows anything else. Also, `closeBundle` in `operator-plugin.ts` closes each store independently and logs a warning instead of hiding a failure. The build now exits 0 with no warning. The same Bun behaviour was behind about 49 of the baseline "database is locked" test failures (below).

## Results (Linux cloud container)

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| `bun test scripts`, unchanged e9366d8 | 9578 pass, 23 skip, 84 fail |
| `bun test scripts`, candidate (with Jarvis slice and both fixes) | 9757 pass, 23 skip, 32 fail |
| Failures new vs e9366d8 baseline | 0 (set difference of `(fail)` names is empty) |
| Baseline failures now passing | 49, mostly the Bun close(true) lock; not counted as feature wins |
| `bun run build` | built, exit 0, no closeBundle warning |
| `scripts/coding` | 312 pass, 0 fail |
| `scripts/devices` | 106 pass, 0 fail |
| `scripts/jarvis-command` | 124 pass, 0 fail |
| `scripts/integration` and `nexus-interface` | 16 pass, 0 fail |
| `scripts/f1 scripts/j2 scripts/desk-payments` | 434 pass, 1 fail (F2 200 KB timing) |
| `scripts/finance scripts/memory` and mail-archive close | 703 pass, 1 fail (F2/F3 200 KB timing) |

The Jarvis owner reported 9671 pass against 9579 with the same 84 failing names; that is consistent with this run's baseline. The 32 remaining failures are all in the e9366d8 failure set: two timing assertions on 200 KB inputs, D:\ and Windows-path tests, tailscale identity tests, and a few workspace and process-tree tests. They are not successes and were not skipped or edited.

Rendered check (earlier candidate, before the Jarvis merge; the Jarvis slice changes no page except `src/lib/commands/coding.ts`): /finance, palette and Command scene at 1280 and 390 px and reduced motion, screenshots in `docs/cloud-next-integration-20260929/screenshots/`. No overflow or page errors, scene values Unknown or Setup required, one sweep per synthetic handoff and none under reduced motion. Not re-shot after the Jarvis merge, and the Finance package panel is covered by its UI test only.

## Unresolved risks

- Held notes: a genuinely renamed and heavily edited note that had been removed from search now shows up as "held" until the owner gives it a frontmatter id, instead of silently staying hidden. Safer, but the owner must act.
- Everything device-related is synthetic. A real Mehroz PC, Tailscale, PowerPoint licence (unlicensed on 28 Sep) and companion service across a reboot are unproven; see `docs/WINDOWS-DEVICE-CHECKLIST.md`.
- The Bun close(true) failure is a Bun-on-Linux behaviour. On Windows, close(true) was added to release file locks; the fallback only triggers on a locked/busy error, so Windows behaviour is unchanged when close(true) works. Confirm on the PC that no warning appears in a build.
- Only coding job history announces `os:handoff`; receptionist to Leads never draws a handoff.
- Model-sent "open my bank" at the desk (P1, pre-existing) is open-only; not changed.
- The 32 remaining failures need a Windows run to classify; several are container-specific and were not proven Windows-safe.
- Actual-model receipts, Jev as primary brain and the coding lifecycle are proven only through the Jarvis owner's synthetic tests (all passing here), never with a real model.

## Windows and local acceptance (not cloud-verified)

1. Install the branch beside the live OS, do not merge. Run `bun run build`, then open Finance, the palette and the Command scene on the PC at desktop and phone width and with Windows reduced motion on.
2. Memory: with writes off, sync a copy of the real vault and read the skipped list for "duplicate of" notes. Then, on a disposable Hindsight bank, rename and edit a note within a minute: one document, same id, and an unindexed note stays out of recall. Save through Jarvis and confirm `processed_by` shows the real route or unknown.
3. Finance: import a real NAB CSV export, check the package panel against real invoices for the month. Treat every match as a lead, and confirm the panel shows UNKNOWN for a month you did not import.
4. Mehroz device test: founder-specific dispatch to Mehroz's own PC over Tailscale (after the Jarvis branch is integrated).
5. Receptionist live gates, separate from everything above: real Retell agent call, Cal.com booking, Twilio number and SMS, and billing/GST. **Receptionist stays NOT SAFE TO SELL until every recorded go-live gate passes.** Nothing here changes that.
6. Owner film: sound levels and every claim in the film reviewed by the owner before it is used.
7. Windows full `bun test scripts` and compare with the lists above; database-locked failures may disappear on the PC.
