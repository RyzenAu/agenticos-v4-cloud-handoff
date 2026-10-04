# Engineering skills for coding roles (Track K, 1-2 Oct 2026)

Code: `scripts/coding/guidance.ts`, `scripts/coding/guidance/{builder,reviewer,planner}.md` + `manifest.json`, `receipts.ts` (guidance on the receipt), `plugin.ts` (wiring), `live-smoke.ts` (bug-fix acceptance mode). Tests: `scripts/coding/guidance.test.ts`.
Reference: Matt Pocock's skills, MIT, commit `d81f3a183412e71a5b1e84ca21bc1a35eea03a60` (cloned read-only at `D:/prog-scratch/ref-skills`). Notice: `THIRD-PARTY-NOTICES.md` section 9.

## 1. The problem this solves

A coding runner starts with no profile CLAUDE.md, no global plugins and no skills (canary test, 30 Sep). Whatever the owner has installed under `~/.claude/skills` therefore never reaches a builder or reviewer the harness starts, on either Claude account or on Codex. The only channel every role already has is the system text the orchestrator builds (the shared M&U brief rides it). A skill is only useful to a runner if the harness delivers it, so the unit here is "a short guidance file delivered by the harness", not "an installed skill".

## 2. Mechanism chosen: guidance files + a runner wrapper (one mechanism, no duplicates)

| Option | Verdict |
|---|---|
| `skills/engineering-*/SKILL.md` in the repo | Rejected. Skills are loaded by an agent that has a skill loader; coding runners have none. The repo's `skills/` folder is also the OS's own and holds the owner's untracked creative skills, which must not be touched in any checkout. |
| Install into `~/.claude/skills` | Rejected. Owner's folder (read-only to this track), per-machine, and runners don't read it. |
| Edit `orchestrator.ts` `rolePrompt` | Rejected for now (the fixer owns that file), and not needed. |
| **`scripts/coding/guidance/{builder,reviewer,planner}.md`, pinned by `manifest.json`, delivered by `withGuidance(runner)`** | **Chosen.** Every runner already accepts `RunnerStart.system` (Claude: `--append-system-prompt-file`; Codex: thread `developerInstructions`; router: the system message). The wrapper appends the role's file to `system` and tags the turn's outcome, so no orchestrator change is needed. |

How it behaves:

- `plugin.ts` wraps all three runners (`claude`, `codex`, `router`) and the planner's runner. A role kind maps to a file: `builder` and `test-author` -> `builder.md`; `reviewer` -> `reviewer.md`; `planner` -> `planner.md`; `tester` (runs commands, no model) gets none.
- Bounded: a file over 6000 characters, a symlink, a missing file or a credential-shaped line is refused whole and reported, never trimmed. The three files are 3.1, 2.8 and 1.9 KB.
- Subordinate: each file opens with "Binding rules for this job ... always win over this page", and the injected block is headed "the job brief, owned paths and policy above always take precedence over it". It resolves routine questions from the brief and the repo; extended interviews are not required.
- Recorded: every turn's outcome carries `guidance: [{role, path, sha256 (full 64 hex), chars, version, supplied, reason?, unpinned?}]`; `buildReceipt` copies it to `receipt.guidance` and adds a 12-hex `engineering-guidance` entry to `receipt.contextSources` (so the job view's `context.sources` shows it with no UI change). A progress line is written per turn: `Engineering guidance: scripts/coding/guidance/builder.md (sha 2cb7dbe7aa0f)`.
- Honest about gaps: a route outside `supports` (default: all three) gets no guidance and the receipt says `supplied:false, reason:"not supported on the <route> route"`. `unpinned:true` flags a file edited without re-pinning `manifest.json`.
- Pinned: `manifest.json` holds `version` (`2026-10-01.1`), the upstream repo and commit, and each file's sha256; a test fails if a file changes without the manifest.

To change the guidance: edit the file, regenerate its digest into `manifest.json`, bump `version`.

## 3. Comparison and decisions (upstream vs what we already have)

What we already have: `systematic-debugging` (iron law: root cause first), `verification-before-completion` (evidence before claims), `test-driven-development` (Addy Osmani; red-green, Prove-It for bugs), `source-driven-development`, `agent-task-gate` (outcome + done-when brief, done gate, restart trigger), `mu-model-handoff` (builder/reviewer split, HANDOFF.md), the built-in `code-review`. The harness already enforces much of this mechanically: own worktree, owned paths, orchestrator-run tests, independent reviewer on a different model, done gate, handoff to memory. Those skills help the lead and interactive sessions; none reaches a runner. Upstream is subordinate to project rules throughout.

| Upstream skill (path under `skills/`) | Decision | What and why |
|---|---|---|
| `engineering/diagnosing-bugs` | **Merge** into `builder.md` | Keep: the feedback loop is the skill (a red-capable, deterministic, unattended signal for the owner's exact symptom), minimise, 2-3 falsifiable guesses with one variable at a time, smallest fix, regression test only at an honest seam ("no seam" is itself a finding), re-run the original scenario. Skip: the 10-way loop menu and HITL script (runners can only run registered checks), "show ranked hypotheses to the user" (no human in the loop; routine questions come from the brief), `[DEBUG-xxxx]` log tagging (the policy refuses ad-hoc instrumentation). Overlaps `systematic-debugging`; ours has the iron law, upstream adds the loop and the seam rule, so only the delta is carried. |
| `engineering/code-review` | **Merge** into `reviewer.md` | Keep the two-axis idea, reported separately: (a) requested behaviour (the done-when criteria and the symptom), (b) fit with the repo's own standards and architecture. Findings are tagged `[behaviour]` / `[fit]` inside the existing JSON schema so the harness contract is unchanged. Skip: parallel sub-agents (the reviewer is one read-only turn; sub-agents are not allowed), issue-tracker lookup, "ask for the fixed point" (the orchestrator pins the exact diff). Condense the Fowler smell list to a judgement-call sentence: a documented repo rule overrides it, and a taste preference is never a blocker. |
| `engineering/codebase-design` | **Merge, condensed** into builder/reviewer "fit" and planner "fit" | Keep: small interface with real behaviour behind it, no pass-through layers, no speculative options, put code where a maintainer looks, tests cross the same seam as callers. Skip the glossary/vocabulary lesson, `DEEPENING.md` and `DESIGN-IT-TWICE.md` (parallel sub-agent design explorations: expensive, and not a coding-role task). |
| `engineering/to-spec` | **Merge** into `planner.md` | Keep: problem and solution from the user's view, testing decisions at the highest existing seam, out-of-scope. Mapped onto the planner's existing JSON (objective, non-goals, done-when with evidence). Skip: the long user-story list, publishing to a tracker, "check seams with the user" (the owner confirms the whole plan once, already). |
| `engineering/to-tickets` | **Merge** into `planner.md` | Keep: complete vertical slices that are demoable/verifiable alone, explicit blocking edges, small enough for one fresh context. Expressed as builder instructions plus disjoint owned globs. Skip: the quiz loop, local-file/tracker publishing. **Our programme board and the job spec are the tracker.** |
| `engineering/implement`, `engineering/implement-spec` | **Skip** (as skills) | They orchestrate worktrees, implementer and merger sub-agents and an integration branch. The harness orchestrator already does worktree-per-role, merging, tests, review and the gate. The two useful lines (typecheck early, full suite once; commit complete increments) are in `builder.md`. |
| `productivity/handoff` | **Merge** one rule into builder | Unresolved work stays visible; reference artefacts instead of duplicating; never state what wasn't run. Skip writing a doc to the OS temp dir (the orchestrator's handoff and the `agent-task-gate` restart note cover it) and the "suggested skills" section (runners have no skills). |
| `engineering/tdd` (+ `tests.md`, `mocking.md`) | **Merge** the relevant parts | Keep: behavioural tests through the public interface, the tautological-test anti-pattern (expected value from an independent source), vertical slices over horizontal, no mocking the module under test. Skip: "confirm seams with the user before any test" (focused behavioural tests are the standard; no routine interview) and "refactoring is not part of the loop" (our rule is simply no drive-by refactors in a fix). Addy Osmani's `test-driven-development` already installed covers red-green; not duplicated. |
| `productivity/grilling`, `grill-with-docs`, `to-questionnaire`, `triage`, `wayfinder`, `wizard`, `retro`, `pr`, `prototype`, `research`, `setup-matt-pocock-skills`, `improve-codebase-architecture`, `domain-modeling` | **Skip** | Interactive or tracker/PR/issue-label workflows, or setup of upstream's own repo conventions. Extended interviews stay optional, owner-invoked (the owner's own `grilling` skill exists for that). |

## 4. Adaptation rules applied

1. Routine questions are resolved from the brief, the done-when criteria and the repository; a runner that is truly blocked says so in its summary and stops.
2. Focused behavioural tests, not implementation-mirroring ones.
3. Short updates: one or two lines; no narration.
4. The programme board and the job spec are the tracker; no issue tracker, labels or PR workflow are assumed.
5. The job brief, owned paths and coding policy always win; the guidance cannot widen what a role may do.
6. Nothing in the guidance asks a role to read env values, run ad-hoc commands, push, merge or deploy.

## 5. Verification

### 5.1 Tests (synthetic, `bun test scripts/coding/guidance.test.ts`, 11 pass)

- The manifest pins version, upstream commit and every file's sha256; files are bounded and say the brief wins; each carries the workflow it should (bug-fix loop, two-axis review, dependency-aware slices).
- Delivery: Claude CLI on **both** `claude:max` and `claude:max-2`, builder and reviewer (the system file contains the role's text and not the other role's); Codex app-server (thread `developerInstructions`); model router (system message). Each outcome and receipt lists `{path, sha256, chars, version, supplied}`.
- Honest gaps: a route outside `supports` is reported `supplied:false, "not supported on the model-router route"` with no text added and no `engineering-guidance` context source; the tester role is untouched; oversized, credential-shaped, missing or un-pinned files are refused or flagged.
- Orchestrated: builder on `claude:max-2` and reviewer on `claude:max` through the real orchestrator with fake CLIs: each receipt carries its own file's digest and a progress line is written. Receipts hold paths and digests only (a test checks no guidance text is in them).
- Whole `scripts/coding` suite: 428 pass, 0 fail. `bun run typecheck` and `bun run typecheck:scripts` exit 0.
- Not proven live: the Codex route (no live Codex job: `codex:openai-2` is paused until the owner runs `codex-isolation.ts --apply`); it is covered by the app-server protocol test above only.

### 5.2 One real harness run (bug fix, claude:max-2, 1 Oct 2026)

Command (nothing else; no retry was needed): `CODING_LIVE_SMOKE=1 CODING_SMOKE_TASK=bugfix CODING_ACCOUNTS_FILE=<accounts.json> CODING_SHARED_CONTEXT_FILE=<shared-context.json> CODING_SMOKE_DIR=D:/prog-scratch/k-bugfix-run1 bun scripts/coding/live-smoke.ts claude2`, at commit `e054204`. The throwaway repo (`D:/prog-scratch/k-bugfix-run1/canonical`, never connected to a business repo, nothing merged or pushed) is a tiny TypeScript invoice library with an `AGENTS.md` (integer cents, all rounding through `roundCents`, behavioural tests beside the code). Seeded bug: a GST-inclusive $110.00 invoice reports "includes GST $11.00" (GST taken as 10% of the total instead of one eleventh); `bun scripts/symptom.ts` prints it and exits 1. The existing tests passed at the base (they never covered GST). Requested as a bug fix: "Fix this bug: the GST on our invoices is wrong."

| Evidence | Result |
|---|---|
| Job | `39d24c92`, state **completed**, gate passed for `a24d23d`, 8/8 checks (clean, ownership, secret scan, checks pass, review approved for the sha, done-when evidenced, receipts recorded) |
| Account | `claude:max-2` for both roles (`claude:max` is weekly-exhausted); execution location `this-pc`; CLI 2.1.286 |
| Builder model | requested `claude-sonnet-5-5`, reported `claude-sonnet-5-5`, `modelMismatch:false` |
| Reviewer model | requested `claude-opus-5-5`, reported `claude-opus-5-5`, `modelMismatch:false` (a different model from the builder, independent read-only turn) |
| Guidance, builder receipt | `scripts/coding/guidance/builder.md`, sha256 `2cb7dbe7aa0fb622562273d58370aa9edb7fa1987173d7e46c594ef31d719461`, 3080 chars, version `2026-10-01.1`, supplied. Also in `contextSources` as `engineering-guidance` (sha `2cb7dbe7aa0f`) beside the shared brief (11809 chars, sha `1f041305256b`), the worktree `AGENTS.md` and the task context |
| Guidance, reviewer receipt | `reviewer.md`, sha256 `508569075292d20d1a5b9d63fff5cb54bc9d48faef3eff65d84dff2bbab4466d`, 2790 chars, supplied |
| Diff (+8/-2, 2 files, both owned) | `src/invoice.ts`: `roundCents(totalCents * 0.1)` -> `roundCents(totalCents / 11)` (the one-line cause fix, rounding still through `roundCents` as AGENTS.md requires). `src/invoice.test.ts`: one new behavioural test through the public `invoiceSummary`: an 11000-cent line gives `gstCents` 1000 and the text "Total $110.00 (includes GST $10.00)". No refactor, no other file touched. |
| Orchestrator test runs | base `4c4e600`: 2 pass; head `a24d23d`: 3 pass, 0 fail (exit 0) |
| Reviewer (approve, no findings) | c1 met: it ran the symptom script at the exact sha and got "Total $110.00 (includes GST $10.00)", exit 0, and named the cause (GST on an inclusive total is total/11). c2 met: the test calls the public function, would fail on the old `*0.1` code (1100), and rounding/test placement follow AGENTS.md. Both assessments (behaviour and fit) are addressed in its criterion notes; it raised nothing it could not support. |
| Original symptom, checked by me outside the harness | `git archive` of the base: `bun scripts/symptom.ts` prints "includes GST $11.00", exit 1. Of the head: prints "includes GST $10.00", exit 0, `bun test` 3 pass. The new test copied onto the base source fails (Expected 1000, Received 1100), so it is a real regression test. |
| Isolation | the live OS checkout and the throwaway canonical checkout were byte-identical afterwards (`liveCheckoutUntouched: true`, `git status` clean) |

What the run also showed (honest notes):

1. The builder first tried to run `bun scripts/symptom.ts; echo ...` itself. The coding policy treats that as an unregistered command and escalated it; the smoke has no approval service, so the question expired after the 60 s input timeout and the builder carried on and committed. The guidance tells builders to use only registered checks, and the repo registry here lists only `inv.test`. To let a builder watch the original symptom go from red to green, register the symptom as a second registry command (for example `inv.symptom`) in the repo's registry entry; that is a per-repo registry choice, not a harness change.
2. The reviewer's findings list was empty, so the `[behaviour]` / `[fit]` tags were not exercised live (they are only a prefix convention inside the existing JSON; the schema and verdict handling are unchanged). The tags are checked only as text in the reviewer file.
3. One run cannot show that the guidance changed the outcome (the bug is easy and Sonnet 5.5 may have fixed it unaided). What it proves is delivery and recording on the real route; effect on quality needs a comparison across jobs, which this track did not run.

## 6. Hooks and follow-ups for the lead

- No change to `orchestrator.ts` or `runners/policy.ts` was needed or made. If the lead later wants guidance in `rolePrompt` instead of the wrapper, call `loadGuidance(guidanceRoleFor(role.role))` there and pass `use` into `buildReceipt` (the wrapper then goes away).
- Merge note: the diff touches `contracts.ts` (a `GuidanceUse` type, an optional `UsageReceipt.guidance`, one new `ContextSource.kind`), `receipts.ts`, `runners/types.ts` (optional `RunnerOutcome.guidance`) and `plugin.ts` (four `withGuidance(...)` wrappers). All additions are optional fields, so stored receipts stay valid.
- Decision for the owner (not needed now): whether to also make these three files the source for the interactive `~/.claude` skills. This track did not touch the owner's skills.
