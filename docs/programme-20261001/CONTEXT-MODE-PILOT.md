# context-mode pilot for one Claude coding worker (builder CM, 1 Oct 2026)

Branch `prog/cm-context-20261001`, worktree `D:/AgenticOS-prog-cm`. Nothing merged, deployed or messaged. No credential, env value or account identity was read or recorded. Nothing was installed globally; `~/.claude` and the claude:max-2 profile were not edited (the profile folder was only named as `CLAUDE_CONFIG_DIR` for the four real runs, as the harness already does).

## Decision

**ADOPT AS AN OPT-IN, OFF BY DEFAULT. Do not make it a default and do not claim savings.** The integration is safe (it cannot be used to get round `policy.ts`) and costs nothing when off (argv byte-identical, tested). The measured benefit is mixed: over two matched pairs it was cheaper in one and dearer in the other, and the one thing the upstream pitch leans on most, session continuity across compaction, is not available in the MCP-only form we can run safely. Use it for a job that is expected to produce large, unpredictable output (a big test or build log) and re-measure on five or more pairs before changing the default. Hindsight stays the business memory engine and Obsidian the vault; the helper's store is a per-job scratch cache, never memory.

Turn it on with `"contextHelper": "context-mode"` in `.operator-data/coding-prefs.json`. Remove the key (or the checkout) and the harness behaves exactly as before.

## 1. What context-mode is (commit 573e697, v1.0.169)

- **Licence: Elastic License 2.0**, text verified in `LICENSE` (package.json says `Elastic-2.0`). Scope for us: **internal M&U coding use only.** ELv2 forbids providing the software to third parties as a hosted or managed service where they get access to a substantial set of its features; forbids circumventing licence-key functionality (it has none we touch) and removing licence notices; a modified copy must carry a prominent notice of the change (we modify nothing: the bundle is run as shipped). So: never expose it as part of a client-facing product, MU-Receptionist or any hosted M&U service, and do not bundle it into something we resell. Patent-claim clause: a patent claim against it ends our licence. `resolveContextMode` refuses any checkout whose `package.json` is not `Elastic-2.0` or not version 1.0.169.
- **MCP tools (11):** `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`.
- **Execution:** `ctx_execute*` run caller-supplied code in a child process (12 languages; shell on Windows is Git Bash) from a temp script, with the MCP server's cwd. "Sandboxed" means output is kept out of the conversation, **not** a security sandbox: the code has the user's full filesystem and network. Upstream's own annotations say `destructiveHint: true, openWorldHint: true`. It has its own deny-list firewall (`security.ts`), which is not our policy.
- **Retrieval:** SQLite + FTS5, BM25 with Porter stemming plus a trigram matcher, per-project DB named by a hash of the project dir under `CONTEXT_MODE_DIR/content/`, session events under `.../sessions/`. Large `ctx_execute` output (with `intent`) or `ctx_batch_execute` output is indexed and only matching sections come back.
- **Hooks (not used by us):** upstream's `hooks.json` registers PostToolUse (capture), PreCompact (resume snapshot), PreToolUse (routing; blocks or rewrites Bash/Read/Grep/WebFetch/Agent calls), UserPromptSubmit, SessionStart (injects a routing block, and on `compact` restores a snapshot) and Stop. The hook scripts run under plain `node`, need `better-sqlite3` (a native module that is not installed in the checkout; I got `Cannot find module 'better-sqlite3'`), hard-code the plugin tool names (`mcp__plugin_context-mode_context-mode__*`, which do not match a plain `--mcp-config` server key) and write logs under the config dir.
- **Session/project identity:** hooks use the transcript UUID or `session_id`; the MCP side uses `CLAUDE_SESSION_ID` (we pass the pre-assigned `--session-id`) and the project dir (`CLAUDE_PROJECT_DIR`/`CONTEXT_MODE_PROJECT_DIR`, we pass the worktree).
- **Retention/cleanup:** the server removes content DBs older than 14 days and stale sources at start; `cleanupOldSessions(7)` runs only from the SessionStart hook; `ctx_purge` is explicit. The helper never deletes our per-job dir, so the orchestrator deletes `<data root>/<jobId>/` (every role's store) when the job ends for good (completed, failed or cancelled; a job that can still resume keeps it).
- **Hazards if run the upstream way:** `start.mjs` rewrites `$CLAUDE_CONFIG_DIR/settings.json` (adds a SessionStart hook), writes `hooks/` and `plugins/installed_plugins.json` in the profile, and runs a background `npm install`. **We never run `start.mjs`.** We start `server.bundle.mjs` directly and point its `CLAUDE_CONFIG_DIR` at an empty per-run stub.
- **Windows + SQLite:** under Bun 1.4.2 (`bun:sqlite`) it starts in about 1.5 to 3 s and FTS5 index/search worked on Windows. Under Node 23.5 the hooks need `better-sqlite3`, which is absent; the Linux path re-execs under Bun, Windows does not, so we launch with the real `bun.exe` (`process.execPath`).

## 2. Integration (files)

- `scripts/coding/runners/context-helper.ts` (new): install check, per-run launch pieces, policy wrapper.
- `scripts/coding/runners/claude.ts`: `claudeArgs(..., helper?)` and the launch/policy hook. `types.ts`: optional `RunnerStart.contextHelper`. `role-choice.ts`: `contextHelper?: "context-mode"` pref. `orchestrator.ts`: optional dep `contextHelper()` and the per-run `dataDir`. `plugin.ts`: wires the pref (data root `AGENTICOS_CONTEXT_MODE_DATA`, default `<MU_DATA_DIR>/coding/context-mode`, laid out `<root>/<jobId>/<roleId>/`; install `AGENTICOS_CONTEXT_MODE_DIR`, default `D:/prog-scratch/ref-context-mode`).
- Tests: `scripts/coding/runners/context-helper.test.ts` (33 tests). Driver for the measurements: `scripts/coding/context-helper-pilot.ts`.

What a run with the helper on looks like (everything else unchanged: `--restricted`, `--permission-prompt-tool stdio`, `disableAllHooks`, the `--tools` allowlist, `--strict-mcp-config`):

- `--mcp-config` carries exactly one server, `context-mode`, started as `bun.exe <checkout>/server.bundle.mjs` with `CONTEXT_MODE_DIR=<job data dir>/store`, `CLAUDE_CONFIG_DIR=<job data dir>/profile-stub`, `CLAUDE_PROJECT_DIR`/`CONTEXT_MODE_PROJECT_DIR` = the worktree, `CLAUDE_SESSION_ID` = the run's session id.
- `--disallowedTools` additionally lists `ctx_execute_file`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`. The model sees four tools: `ctx_batch_execute`, `ctx_execute`, `ctx_search`, `ctx_index`.
- The role's system text gets a six-line guidance block (no hook injects routing, so the model is told once).
- **MCP only. No hooks.** Hooks could in principle be passed per run through `--settings`, but they would need `better-sqlite3`, would run outside the policy, and `PreToolUse` can rewrite tool calls; not worth the risk for the pilot.
- If the checkout is missing, the wrong version or not Elastic-2.0, the run proceeds exactly as with the helper off and a step "Context helper not used" says why.

### Policy: it cannot be used to bypass `policy.ts`

By default the harness refuses every MCP tool, so the helper is unusable until a rule exists. The rule is a wrapper, not a loosening: for the helper's tools only, each piece of shell text is decided by **the same Bash verdict** a plain Bash call gets (same worktree confinement, secret paths, consequential git, run-time-built text such as `$(...)`, network, deploy tools, registry commands). Everything that is not plain shell is refused:

| Helper call | Decision |
|---|---|
| `ctx_execute` language `shell` | verdict of `Bash` with that code; cwd must be inside the worktree; `background:true` refused |
| `ctx_execute` any other language (JS, Python, Ruby, Go ...) | denied (arbitrary code the text policy cannot read) |
| `ctx_batch_execute` | 1 to 12 commands, each through the Bash verdict; the worst verdict wins; cwd rule as above |
| `ctx_index` with a path | ONE explicit regular file that passes the `Read` verdict; directories, globs, links and the walk options (include, exclude, extensions, maxDepth, maxFiles, followSymlinks, respectGitignore) are denied, because the helper's own directory walk would skip the per-file secret rules; inline content allowed |
| `ctx_search` | allowed (reads only this run's own store) |
| every other tool, other MCP servers, and the old `mcp` request kind | denied by the unchanged base policy |

The test matrix runs 16 commands (push, reset, `cat .env`, `cat ../outside`, `$(...)`, `bash -c`, `node -e`, curl, `rm -rf`, vercel, redirects outside, ...) through Bash, `ctx_execute` and `ctx_batch_execute` and asserts the decisions are identical, plus that the denied ones really are denied, and that a read-only role keeps read-only rules. The honest limit is the same as for Bash: text can't prove what `node test.js` itself does; the orchestrator's post-turn diff and live-checkout snapshot checks still apply. The helper's store holds command output, so it can hold whatever a command printed; secret paths are refused before a command runs, and the store lives only in the job's scratch.

Compatibility: Claude Code 2.1.286 started the server (`mcp_servers: connected, source: dynamic`) under the exact runner flags, the helper's tools were offered despite the `--tools` allowlist, and every helper call reached `can_use_tool` and our policy.

## 3. Measured comparison (real runs on claude:max-2, Sonnet 5.5, Claude Code 2.1.286; the 4 runs allowed)

Fixture: disposable repo `D:/prog-scratch/cm-pilot/fx/repo` (generated by `context-helper-pilot.ts gen`): 300 modules, a rounding bug, `node test.js` printing 3,415 lines / 123,723 bytes (206 failures, the first at case 1139, mid-log), `node typecheck.js` printing 1,800 lines with exactly one real error. Task A: run the tests, fix the bug (only `src/billing/**`), re-run, report the one real typecheck error, and report from memory the first failing case and its `at roundCents (...)` text. Task B: count `legacyFormat(` call sites and find the `'EUR-SPECIAL'` one, then the typecheck error. Raw results: `D:/prog-scratch/cm-pilot/fx/run-{A,B}-{on,off}.json`.

Tokens are the CLI's own `usage` for the whole run (input + cache read + cache write; output separately). "Peak" is the largest single-turn context. n = 1 per cell, one model, one machine: **indicative, not significant.**

| Run | Context tokens (in+cache) | Output tok | Peak ctx | Turns | Time | Value (API-equiv.) | Tool-result bytes seen | Correct |
|---|---|---|---|---|---|---|---|---|
| A off | 54,033 | 1,103 | 12,029 | 6 | 16.9 s | $0.041 | 4,122 | all three answers |
| A on | 93,022 | 1,237 | 20,447 | 6 | 18.4 s | $0.109 | 8,456 | all three answers |
| B off | 51,425 | 937 | 21,519 | 4 | 40.5 s | $0.071 | 24,398 | all |
| B on | 50,050 | 734 | 17,759 | 3 | 15.2 s | $0.033 | 5,026 | counts and line right; one side claim ("definition is not in src/") wrong |

Reading it:
- **The model floods itself less than the pitch assumes.** In both A runs the model filtered the 123 KB log with `grep`/`head`/`grep -v` pipes (the harness allows them as registry commands), so the baseline never saw the flood. In B off the one unfiltered `node typecheck.js` returned 13.9 KB, which is where the helper saved most (B on: 5 KB of tool results, 3 turns, 15 s versus 40 s).
- **Fixed overhead is real:** with the helper on, the first turn cached about 14.7k tokens versus about 8.9k off, i.e. roughly 6k tokens of extra tool schemas and guidance, re-read every turn. That is why A on used more context and cost than A off. `startupMs` (time to the init message) was 2.8 s versus 1.2 s.
- **Exact-detail retrieval worked but is ranking, not order.** In A on the model's own `ctx_search` did not return the first failure, so it re-ran the (deterministic, still unfixed) test once, correctly. In the scripted demo (below) five different queries all returned case 1139 for a log indexed through `ctx_batch_execute`; a `ctx_execute` + `intent` index of the same log did not return it for a source-scoped query. BM25 answers "find this thing", not "the first/last/all of these"; for those the model still has to write a filter.
- Extra overhead per helper call: one MCP round trip; one headless escalation in A on (a compound `sed -i ... && node test.js ...` command, denied as `unclassified`, the same verdict Bash would have given). Process overhead: one extra bun process per run (about 2 s start), 2.1 MB of store for the demos.
- No allowance or billing claim is made: "value" is the CLI's API-equivalent figure, not spend.

**Upstream claims (not verified by us):** the README says 98% context saving ("315 KB becomes 5.4 KB"), that a tool-heavy session loses about 40% of context in 30 minutes, and `BENCHMARK.md` reports 96% over 21 scenarios (376 KB raw to 16.5 KB). Those compare raw dumps against summaries; our runs compared against a model that already pipes through `grep`.

## 4. Acceptance demos (scripted against the real server with the runner's own launch config; `context-helper-pilot.ts demos`, results in `fx/demos.json`)

- **(a) Large output without flooding:** `node test.js` (123,723 bytes) through `ctx_batch_execute` returned 3,522 bytes to the conversation. In the real run B, tool results were 5 KB with the helper versus 24 KB without.
- **(b) Exact detail retrieved later:** after the log was indexed, `ctx_search("first FAIL case")`, `("FAIL case 1139")`, `("1139")`, a source-scoped query and a `timeline` query each returned the exact line `FAIL case 1139 amount=1025.1 expected 1025.1 got 1025.09` plus its `at roundCents (src/billing/invoice.js:41:16)` location, in 1.5 to 2 KB. A `ctx_execute`+`intent` index was less reliable (see above). In the real run A on, the model recovered the exact detail by re-running instead.
- **(c) After compaction: not demonstrated.** A forced compaction needs a long or `/compact` run and the 4-run budget was spent on the matched pairs. Mechanically: with hooks off there is no PreCompact snapshot or SessionStart restore, so after Claude's own compaction the helper adds nothing automatic; the store survives and the model can `ctx_search` it if it remembers to. Running the upstream hooks standalone failed on the missing `better-sqlite3`, so this was not tested with them either. Claim withheld.
- **(d) Two concurrent jobs, each only its own context:** two servers started concurrently with separate data dirs; each indexed a unique marker and both searched for both markers: job A found only its own, job B only its own, neither found the other's. Isolation rests on the per-job `CONTEXT_MODE_DIR` (and the stub `CLAUDE_CONFIG_DIR`, which also stops its "auto-memory" timeline search reading a real profile).
- **(e) Disabled equals previous behaviour:** `claudeArgs` output with the helper off equals a literal copy of the pre-change argv (test), `--mcp-config` stays `{"mcpServers":{}}`, an MCP tool is still presented to policy as `mcp` and refused, and the real OFF runs show `mcp_servers: []`. With the helper on but not installed the argv is also unchanged.

## 5. Other runners (facts only; nothing enabled)

- **Codex (app-server 0.159.0 here):** supports MCP servers and hooks (`[features] hooks = true`; upstream ships `configs/codex/` with `config.toml`, `hooks.json` and `hooks/codex/*`). Our Codex runner deliberately switches every configured MCP server off for the thread (`mcp_servers.<name>.enabled=false`) and answers MCP elicitations through the policy (denied), and its sandbox isolation is separate. Enabling would need a per-run `-c` MCP entry, the same policy wrapper on the `command` approvals, and a hooks decision; not done.
- **Router roles (OpenRouter/DeepSeek/MiMo/Cline text models):** one routed chat call, no tools, no MCP, no hooks; nothing to attach.
- Upstream also ships adapters for Gemini CLI, Cursor, VS Code Copilot, OpenCode, Kiro and others; none are used here.

## 6. Residual risks and follow-ups

- Output stored by the helper is not passed through `redactText`; it only ever lives in the job's scratch and is returned to the same model that ran the command. Delete the per-job data dir with the worktree (follow-up wiring).
- ELv2 scope must be re-read before any hosted or client-facing use.
- Pin: `CM_PINNED_VERSION` 1.0.169 / commit 573e697; an upgrade needs a re-review of `start.mjs`-style side effects and the tool list.
- The helper's search is throttled upstream (a soft cap after a few calls per window); the model is told to batch queries.
- Re-measure with 5+ pairs, including a model/job that does not pre-filter, before any default-on discussion.

## 7. Correction (R5 reconciliation, 2 Oct 2026, checked against af45e77)

* The first bullet of section 6 ("Delete the per-job data dir with the worktree (follow-up wiring)") is out of date. The wiring exists: `scripts/coding/orchestrator.ts` calls `removeContextJobData(root, jobId)` when a job ends for good (line 1049, best effort). Section 2 already described this correctly.
* The code is on the live base (`af45e77`), not only on `prog/cm-context-20261001`: commits `8285ba92` (pilot) and `877b59a6` (review fixes). It stays off unless `"contextHelper": "context-mode"` is set in `.operator-data/coding-prefs.json`; `scripts/coding/runners/context-helper.test.ts` passes (part of 199 passing tests in the R5 focused run).
* Licence handling is as recorded: `resolveContextMode` refuses a checkout whose `package.json` licence is not `Elastic-2.0`. context-mode is run from `D:/prog-scratch/ref-context-mode`, not vendored or redistributed, so no `THIRD-PARTY-NOTICES.md` entry exists or is required today. Add one if it is ever bundled.
* The "not claimed" items stand: no savings claim, no compaction demonstration, one run per cell.
