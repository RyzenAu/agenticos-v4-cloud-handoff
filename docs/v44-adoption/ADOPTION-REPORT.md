# V4.4 adoption into M&U AgenticOS

Date: 30 September 2026. Status: selected V4.4 adaptations implemented and verified for the user-authorised local merge.

## Source and preservation

- Supplied archive: `C:/Users/Nebula PC/Downloads/⭐️ Agentic OS V4.4.zip`.
- Archive SHA256: `7762CF81BA563399CF2F37AE897B5DA99DF011417CA2E650E3B4D6ED0C7B41C4`.
- Selectively extracted reference: `D:/AgenticOS-v44-reference`. Setup scripts were not executed. Configured state, credential files and private media were excluded.
- Existing repository: `C:/Users/Nebula PC/source/repos/AgenticOS-v4`, branch `jarvis-voice`, inspected base `6feeaf0`.
- Adoption branch: `codex/v44-stability-adoption`, worktree `D:/AgenticOS-v44-adoption`.
- Existing dirty documentation and seven creative skill folders were preserved. No agents launched or live provider actions performed. The user subsequently authorised completion and merge.
- Preserve the supplied LICENSE and attribution. Reference/adoption remains local.

`source-inventory.json` compares 835 source files against the inspected commit, ignoring CRLF differences: **357 identical, 294 changed, 184 new**. It excludes configured data. These are inventory counts, not a claim that every changed line has been reviewed. Targeted review covered the systems below.

V4.4's release notes describe macOS verification; Windows was not equivalently verified. A higher version number does not establish greater reliability for this customised Windows application.

## Implemented and checked

### 1. Validate Jev decisions at the existing shared boundary

Adapted the typed-answer pattern into `scripts/jev-answer-validation.ts` and the existing `scripts/jev-client.ts`. It rejects array/empty responses, unrequested answer IDs, invalid choice values, mismatched types, non-finite/out-of-range numeric values, and malformed supplied probability distributions. Malformed replies follow the existing failure/receipt path without executing or retrying the decision.

The existing legacy optional metadata and partial fan-out contract remain compatible. Callers still decide which answers are required before acting. This is wire-format validation, not proof that a decision is correct or permission to act.

Added bounded retry support for TypeSafe's documented HTTP 529 overload response, within the existing retry/time budget. Routing, model catalogue, thresholds and receipt architecture remain in place.

Current contract references: [TypeSafe HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul).

Six older test failures were traced to fixtures returning choices against empty question maps, including bare string answers. Their fixtures now use real typed questions/answers; their original transport, receipt and control assertions remain.

### 2. Motion rendering quality check

Ported V4.4's checker into `src/motion/check/` and added `bun run check:motion`.

It checks deterministic drawing, blank frames, finite canvas inputs, render exceptions, loop seams, registry/metadata, portrait/square formats and custom brand rendering. Existing Windows Chrome launch handling is retained. Adaptations reject unknown style names, avoid recursively deleting existing output folders, and stop the local checker server even if browser launch/cleanup fails.

Usage:

```text
bun run check:motion
bun run check:motion oil-impasto title-card
```

Report and stills: `outputs/motion-check/`. These are generated verification artifacts, not new promotional films or proof of editorial quality.

## Adoption decisions

| V4.4 idea | Decision for M&U | Integration and acceptance |
| --- | --- | --- |
| Jev decisions with visible probabilities | Existing decision engine stays; response checks adopted | Add presentation only to existing job/voice detail views if useful. Selected model, actual outcome and fallback must agree with receipts. |
| Agent task continuation and questions in chat | Existing durable workflow retained; activity presentation improved | Use existing durable jobs, isolated checkouts and approvals. Verify pause/question/resume/cancel after restart; do not create another job store. |
| Memory timeline, source detail and relationships | Timeline/date filters implemented; speculative relationship graph excluded | Reads current Hindsight/Obsidian records. Keeps source links and corrections. Any future shared-word links must be labelled inferred; never imply a verified fact relationship. No duplicate memory engine. |
| Bounded imports and source switches | Preserve existing shared import code; audit any new adapter | Many import files already match. V4.4's `briefAllowed` belongs to its new assistant path, which M&U does not use. Do not add an unused helper or replace current memory routing. Verify disabled-source handling when introducing derived/cached context. |
| Voice interruption, Fish voice controls | Existing interruption, reconnect and engine integrations retained | Reuse current session/audio pipeline; test interruption, device targeting, reconnect and narration. Do not introduce V4.4's second assistant backend or change receptionist voice provider here. |
| Editable tone/personality | Implemented as allowlisted reply-style preferences | Preferences in current Jarvis settings, tone only. No replacement persona by default, no effect on permissions, no mandatory sarcasm. |
| Plan usage meters | Implemented using existing account metadata | Bind existing subscription/router data to compact meters. Show reset time when known and unknown values explicitly; this API supplies no observation timestamp. Do not import V4.4's login-file/account-log readers. |
| Reels transcript/scene review and optional audio | Scene planning, timing and composer handoff implemented | Integrate with existing approved scripts, creative skills and render jobs. Bring timing validators/preview controls through existing model router. Remove hard-coded models and developer-specific macOS reference paths before adoption. No automatic batch of redundant videos. |
| Source status/empty states | Apply consistently during relevant UI work | Keep M&U's existing loading/error/stale/live/synthetic states. V4.4 components are references; do not replace accurate status with demo data. |
| Reply outbox with durable uncertain state | Pattern worth retaining for future integrations | Existing shared jobs/SMS delivery logic remains authoritative. Unknown delivery must not be auto-replayed; no new YouTube send workflow is needed for this request. |
| Motion quality checks | Adopted | 103 existing styles rendered successfully on Windows. Human review still needed for readability, pacing and brand fit. |

## Existing systems that must be preserved

The targeted comparison found concrete regressions in wholesale replacement:

- **Windows execution:** M&U already has stronger executable resolution, controlled CLI environment, protected-root checks and isolated coding execution. Upstream agent adapter replacement removes these.
- **Local file search:** upstream `local-memory-search.ts` uses macOS `mdfind`; M&U includes a bounded Windows traversal and bank-export exclusion.
- **Finance/memory boundary:** M&U's NAB CSV summary path keeps raw transactions out of general memory. Upstream business memory is not its replacement.
- **Inbox discovery:** upstream native inbox sync would lose M&U's cached discovery and explicit probe behaviour, reintroducing work during page reads.
- **Mail reliability:** preserve existing SQLite close/busy handling rather than substituting upstream code.
- **UI data health:** retain current live-data loading/failure status and hydration fixes.
- **Hindsight and Obsidian:** keep shared memory and current connector architecture. Upstream filesystem streams are not a reason to create a second authoritative store or ingest private session transcripts.
- **Remote access:** upstream loopback-only cross-site guard cannot replace the current device/Tailscale identity system without breaking the shared workspace.
- **Receptionist:** preserve catalogue pricing, seconds-based billing, GST, booking idempotency, consent and readiness gates. V4.4 does not replace these business-specific systems.
- **Brand/navigation:** retain M&U black and gold, NEXUS work, current destinations and skills. Skip fictional inbox, usage savings claims, onboarding reset and decorative orb-lab as production replacements.
- **Dependencies:** do not wholesale replace package/lock files or introduce `motion`/`ogl` until an adopted component actually needs them.

## Reusable coding rules extracted

1. Validate external/model data at a shared boundary before consumers act.
2. Keep parsing and decision logic pure and testable with synthetic fixtures.
3. Use stable IDs and durable status for resumable jobs; distinguish failed from uncertain.
4. Bound work by file size, record count, timeout and cancellation; avoid scans on page reads.
5. Make source choices authoritative across cached/derived context as well as raw records.
6. Keep rendering deterministic and run automated render checks across formats.
7. Preserve the last valid artifact on failure and clean up owned processes on every exit.
8. Adapt upstream features through existing services, with targeted regression checks for M&U customisations.

## Verification

Windows, Bun 1.4.2, isolated checkout. Dependencies installed from existing frozen lockfile with lifecycle scripts disabled.

| Check | Result |
| --- | --- |
| Jev and related desktop/away/receipt tests plus motion launch/request boundaries | **206 passed, 3 skipped, 0 failed** across 15 files |
| TypeScript `bun run typecheck` | Passed |
| Build with `AGENTIC_OS_NO_CODEX=1`, `AGENTIC_OS_NO_BACKGROUND=1` | Passed; fresh checkout seeded from committed example data |
| `bun run check:motion` | **103/103 styles passed** in headless Chrome |
| Patch whitespace | `git diff --check` passed |

This is not a full application or live-provider acceptance run. No real voice call, account access, memory write, receptionist call or remote-device action was used to establish these results. No claim of zero bugs is made.

## Scope closure

The selected upstream improvements are integrated through current services. Existing task questions, resume/cancel, voice interruption/reconnect, import boundaries, remote devices and uncertain-delivery handling remain authoritative. This adoption does not add another assistant, memory store, account reader or video engine. Inferred memory graphs and decorative demo systems were deliberately excluded.

## Second implementation batch

Implemented after the user's instruction to continue:

- **Memory timeline:** chronological groups with local calendar dates, newest first, a list alternative, and rolling 7/30/90-day ranges. Counts explicitly describe loaded records, not the whole memory bank. Unknown dates remain visible under Any time. Original record/source/version objects are retained.
- **Memory detail stability:** selection requests are sequenced; earlier slow replies cannot replace a newer selection. Leaving a loading view invalidates its response. Network failure is shown as a load error, distinct from a missing/forgotten record.
- **Coding readability:** Milestones is the default activity view. Decisions, failures, state transitions, tests, reviews and final summaries remain visible. Agent updates and All activity expose other received events; the backend event store is unchanged.
- **Coding navigation:** a keyed job session prevents events, pending controls and notices from a previous job remaining on a newly selected job's screen.
- **Design:** existing M&U tokens, components, keyboard controls and black/gold palette retained. No new runtime dependencies or alternate assistant/memory backend.

Verification of this batch:

- 34 focused memory/coding checks passed, including late-response and network-error cases.
- Browser interaction checks passed at 1440px and 390px: timeline/list, keyboard selection, range controls, mobile item details and coding filters. No browser page errors or horizontal document overflow.
- Synthetic-only component preview used the real components and styles via a minimal local Vite server, without loading the OS backend or accessing private records. This verifies components, not authenticated live-route/provider acceptance.
- Four captures and a machine-readable browser result are under `outputs/v44-ui/`; preview/check scripts are under `outputs/` and ignored by Git.
- Impeccable mechanical detector returned no findings for the changed UI targets.
- TypeScript check and application production build passed after these changes.

The first two batches were checked against base `6feeaf0`. The following final batch closes the selected feature work.

## Final implementation batch

- **Jarvis style:** Current, Direct and Warm choices in the existing free-engine settings. Typed and spoken requests use the same preference. Only fixed presentation instructions are appended; arbitrary instructions are rejected and the existing action/confirmation rules remain. Preferences are browser-local and storage failures are shown. Other voice engines retain their current provider settings.
- **Account usage:** compact accessible meters over existing account metadata. Unknown or invalid usage never appears as zero; unknown reset times are explicit. Installed CLI status no longer implies authenticated readiness. No new credential or account-log reader.
- **Scene planning:** a Scene plan tab in Motion supports 1–12 scenes, title/script/visual direction, 3–60 whole seconds per scene (matching the existing renderer), continuous timing, pacing estimates, reordering, explicit browser-local save/clear and JSON export. A scene can populate the current composer for review; this does not start generation. Unsaved edits survive Motion tab switches. No private transcript ingestion or new render pipeline.
- **Test fixtures:** updated one additional legacy Jev response to the actual category/sub-choice contract. CLI tests now use explicit synthetic environments instead of inheriting the shell; the Windows rollback test distinguishes Deny entries from valid Allow entries. Production permission rules are unchanged.

Final checks so far: 38 workflow/memory/coding tests passed, 159 voice/CLI/routing tests passed, and 24 Windows isolation tests passed. Desktop/mobile browser interactions passed for both batches with no page errors or horizontal overflow. Typecheck and production build passed. The replacement broad run completed: 9,645 passed, 13 skipped, one failed across 553 files (573 seconds). The sole remaining failure was another obsolete untyped Jev test fixture. That fixture was corrected without changing production code; the complete E12 review group and Jev boundary tests then passed: 83 passed, 0 failed across 17 files. The entire 553-file suite was not repeated after this final test-only correction. No known failing check remains. The final scene whole-second constraint also passed its focused regression check.

Verification uses synthetic data. Real microphone/provider quality, existing receptionist go-live readiness and remote-device acceptance are not established by this adoption. Scene saving is local to this browser; JSON export is available for sharing and backup.


Integration checks: the actual MotionLibrary component accepted a scene into its composer, stayed within the mobile viewport, and made no generation request. Canonical root returned HTTP 200 before integration. Ten existing dirty/untracked documentation and skill files were fingerprinted for preservation. No agents or paid generations were launched.
