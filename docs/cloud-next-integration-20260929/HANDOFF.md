# Release candidate handoff: cloud/agenticos-next-integration-20260929 (29 Sep 2026)

Candidate only. Not merged to main or the live OS, not deployed, no live provider, no private data. Synthetic fixtures throughout. The live OS merge is reserved for the owner's explicit approval.

## Source heads (recorded before integration)

| Branch | Head | Status here |
| --- | --- | --- |
| cloud/integration-j6-f1-p1 (start point) | e9366d8 | base of the candidate |
| cloud/nexus-interface-20260929 | ebc5b47 | integrated |
| cloud/memory-finance-20260929 | 9382382 | integrated |
| cloud/jarvis-device-coding-20260929 | a689c94 when first fetched, e5eb59a ("WIP (unverified)") at second fetch, 83361ca at last fetch | NOT integrated: still moving, no completion statement. Step 4 is waiting. |

Working tree was clean and no stash existed at the start. main is 3a8d304.

## What is in the candidate (after e9366d8)

1. NEXUS merged clean (no conflicts): palette rows name where they act, one shared `os:handoff` signal, still Command scene (hollow gold mark unless live, no ambient drift, one 2D sweep only for moving work).
2. Memory and NAB CSV merged clean: copied notes count once, rename plus edit keeps identity (MinHash, 0.6 and a 0.15 margin), recall provenance fields, package-payment candidate route.
3. New here: the Finance page panel "Possible receptionist package payments" (`src/components/finance/manual-finance.tsx`). Shows source, as-of, last import, "not a live bank feed", "possible match" wording, UNKNOWN (never zero) when no import covers the period, a separate failed-read notice, and the caveat that an amount can coincide. It never says a client paid. Approved monthly prices only; setup fees stay unmatched. No price was changed (A$699/1099/1999 plus GST, A$0.80/0.75/0.70 extra minute; setup and pilot terms still unapproved).
4. New here: `scripts/operator-plugin.ts` closeBundle closes each store independently. Cause of the known build exit: `archive.close()` throws "database is locked", which skipped later closes and turned a finished Vite build into exit 1. It is now logged as a warning and the build exits 0. The underlying lock is not root-caused (see risks).

Conflicts: none in either merge. Nothing overwrote Jev, Jarvis or the coding harness.

## Results (Linux cloud container)

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| `bun test scripts`, unchanged e9366d8 baseline | 9578 pass, 23 skip, 84 fail |
| `bun test scripts`, candidate 7d02c87 | 9623 pass, 23 skip, 66 fail |
| Failures new vs baseline | 0 (set difference of `(fail)` names is empty) |
| `bun run build` | "built in 42s", exit 0, with one closeBundle warning "mail archive did not close cleanly: database is locked" |
| `bun test scripts/nexus-interface.test.ts` | 10 pass |
| `bun test scripts/finance scripts/memory` | 699 pass, 4 fail, all in the baseline set |
| new Finance UI test (`manual-finance-ui.test.ts`) | passes |

The 18 fewer failures than baseline are mostly "database is locked" tests that fail or pass with machine load. Do not count them as fixes. The 66 remaining are baseline failures (locked databases, D:\ and Windows paths, tailscale, timing assertions such as F2/F3 at 200 KB), not successes.

Rendered check (vite dev in a throwaway HOME, headless Chromium, screenshots in `docs/cloud-next-integration-20260929/screenshots/`): /finance, the palette, and the Command scene at 1280 and 390 px, plus 390 px with reduced motion. No horizontal overflow, no page errors, black/gold intact. Scene objects read Unknown or Setup required (nothing fabricated). A synthetic `os:handoff` event made the receiving object travel once, and under reduced motion it stayed still with the sweep hidden. The Finance package panel is covered by the jsdom-style UI test only, not the browser (the preview had no NAB import).

## Unresolved risks

- Jarvis, device dispatch and coding slice not integrated: typed and spoken context, per-founder device dispatch, Jev as primary brain, actual-model receipts and the builder/reviewer/test/diff/cancel/resume lifecycle are NOT proven in this candidate. Once its owner declares a final head, merge it and resolve the palette/context/device contracts against NEXUS (`palette-target.ts`, `handoff.ts` already read `targetDeviceId` from job history).
- Rename plus edit similarity can hand a vanished note's identity, including a "remove from search" decision, to a different note that overlaps at 0.6 or more. A note renamed and edited before the first scan after upgrade gets a new id.
- Mail-archive "database is locked" at close is baseline; the build now survives it, the cause is not found.
- Nothing announces `os:handoff` yet except coding job history, so receptionist to Leads never shows a handoff.
- Model-sent "open my bank" at the desk (P1, pre-existing) is open-only; not changed.

## Windows and local acceptance (not cloud-verified)

1. Install the branch beside the live OS, do not merge. Run `bun run build`, then open Finance, the palette and the Command scene on the PC at desktop and phone width and with Windows reduced motion on.
2. Memory: with writes off, sync a copy of the real vault and read the skipped list for "duplicate of" notes. Then, on a disposable Hindsight bank, rename and edit a note within a minute: one document, same id, and an unindexed note stays out of recall. Save through Jarvis and confirm `processed_by` shows the real route or unknown.
3. Finance: import a real NAB CSV export, check the package panel against real invoices for the month. Treat every match as a lead, and confirm the panel shows UNKNOWN for a month you did not import.
4. Mehroz device test: founder-specific dispatch to Mehroz's own PC over Tailscale (after the Jarvis branch is integrated).
5. Receptionist live gates, separate from everything above: real Retell agent call, Cal.com booking, Twilio number and SMS, and billing/GST. **Receptionist stays NOT SAFE TO SELL until every recorded go-live gate passes.** Nothing here changes that.
6. Owner film: sound levels and every claim in the film reviewed by the owner before it is used.
7. Windows full `bun test scripts` and compare with the lists above; database-locked failures may disappear on the PC.
