# Evaluation: github.com/tamaratran/fast-jev-compaction

Compiled 27 Sep 2026, Australian English. Read-only review via GitHub web pages (`gh` CLI is not
installed in this environment). Not cloned, not installed, no hooks run. Our installed Claude
Code: **2.1.278** (`claude --version`).

---

## 1. Summary

`fast-jev-compaction` is an MIT-licensed npm library + Claude Code plugin (v0.2.0, TS, Node ≥18)
that claims to replace Claude Code's native context-compaction summary with a Jev-scored
prune-and-truncate pass: it sends the whole conversation to TypeSafe's Jev model, gets back a
keep/drop decision per tool call and per tool result, and removes or truncates only what scores
low — everything kept stays byte-for-byte verbatim (no LLM rewriting).

**The central problem: its own issue tracker says the mechanism doesn't do what the README
implies.** Issue [#88](https://github.com/tamaratran/fast-jev-compaction/issues/88) states plainly
that Claude Code's compaction hooks only fire **before or after** compaction (PreCompact /
PostCompact) and cannot replace the summarisation step itself — which matches what Anthropic's own
current hooks documentation says (see section 6). The repo's hook code registers non-standard
event names (`session.compact`, `turn.complete`) gated behind an undocumented
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` flag and a minimum Claude Code version of 2.1.274 — a
"function hooks" system that does not appear anywhere in Anthropic's published hooks
documentation as fetched 27 Sep 2026. That gap, plus a 6.9k star count that is large for a
narrow utility plugin with only ~17 merged PRs of history, is reason enough to treat this as
**unverified/experimental, not a supported integration point**, until TypeSafe or Anthropic
confirms the mechanism exists in the shipped product.

## 2. What it preserves / truncates / removes (from `src/compact.ts`, fetched via raw.githubusercontent.com)

- **Always preserved:** pinned tool calls (explicitly marked "should stay in the history"); the
  most recent N messages (`preserveRecentMessages`, default **6**); any call+result pair scoring
  `keepResult >= keepThreshold` (default **0.5**) — kept **verbatim**, not summarised.
- **Truncated:** a tool result that stays "in spirit" but is long gets cut to `truncateHeadChars`
  (default **300** characters), with an inserted note like
  `[fast-jev-compaction truncated 4213 chars...]`.
- **Removed:** the whole tool call if `keepCall < keepThreshold`; just the result (call kept, body
  dropped) if only `keepResult` is low; any message left with no content after this is deleted
  entirely.
- Decision logic (`decideCall()`): two independent Jev `noul` scores — `keepCall` (does the
  invocation itself matter) and `keepResult` (must the output survive verbatim) — each compared
  against the single `keepThreshold`.

## 3. Exactly what is transmitted to TypeSafe

Confirmed from the README and `src/compact.ts`/`src/request.ts` (fetched, not fully reproduced
here per copyright limits): **the whole conversation so far, oldest first**, is sent as Jev's
`state`, with **every prior tool result already replaced by a short placeholder** like
`ok, 4213 chars (omitted)` — but **tool call inputs and all user/assistant text are sent in
full, unredacted**, up to the configured state token limit (default **25,000 tokens**). In other
words: **file paths, exact commands, arguments passed to every tool, and everything either party
typed do reach TypeSafe's servers** on every compaction pass; only the bodies of *already-scored*
past tool results are pre-omitted before the request. Whatever was in the most recent, not-yet-
scored tool results is not omitted — those go to Jev in full so it can score them.

**Consequence for us:** if a dental receptionist session's tool history contains patient names,
phone numbers, appointment details, call transcripts, or file contents (medical records, client
contracts), those would be sent to a third-party US-hosted API as part of ordinary compaction,
with no client-side redaction step. This directly conflicts with the standing rule never to send
private caller data, transcripts, recordings or client material to a third party without an
explicit decision to do so.

## 4. Fallback on API failure

From `src/compact.ts` and the `hooks/fast-jev.ts` adapter (both fetched):

- The core `compact()` function has **no built-in retry or degradation** — a failed API call
  (missing key, network error, TypeSafe 429/529, timeout) simply **throws**, and "the caller
  decides whether to fall back" (code comment).
- The Claude Code hook adapter (`session.compact` handler) catches that throw: if
  `TYPESAFE_API_KEY` is unset it throws immediately with a named error; if the API call fails or
  the resulting reduction is below `minReductionRatio`, it **falls back to Claude Code's own
  built-in summary** and shows a notification that this happened.
- The `turn.complete` handler (checks context usage per turn) just **logs the error to the UI and
  continues**, resetting an internal `compacting` flag in a `finally` block so it doesn't get
  stuck.
- Net effect: a TypeSafe outage degrades to native lossy summarisation rather than hanging or
  losing data outright — reasonable *if* the hook mechanism itself is real (see section 1/6).

## 5. Windows support

**Not addressed anywhere in the README.** The source itself (`src/*.ts`, `hooks/fast-jev.ts`) is
platform-agnostic TypeScript with no shell-outs, no OS-specific path handling, and no `bash`/`sh`
scripts in the reviewed files — it uses a generic `HookFetch`/`$.http.fetch` abstraction rather
than spawning anything. That's a mild positive (nothing here should hit the usual Windows
shell-quoting or path-mangling problems we've been bitten by elsewhere), but it also means
**Windows was never tested or claimed** — there's no CI matrix entry, no Windows-specific issue
found in the visible issue list, and no statement of support either way.

## 6. Claude Code version / hook API targeted vs our installed version

- README states: **Claude Code plugin requires version 2.1.274+**, with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` enabled in settings, and registers hook events
  **`session.compact`** and **`turn.complete`** (from `hooks/fast-jev.ts`, `hooks/hooks.json` →
  `{"modules": ["./fast-jev.ts"]}`).
- **Our installed Claude Code is 2.1.278** — numerically above the stated minimum, so the version
  gate alone would not block installation.
- **However**, Anthropic's current official hooks documentation
  ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks), fetched 27 Sep 2026)
  describes only five hook types (`command`, `http`, `mcp_tool`, `prompt`, `agent`) and two
  compaction-related **events** — `PreCompact` and `PostCompact` — both explicitly
  **observation-only**: they fire before/after compaction, receive JSON input, and can trigger
  side effects, but **the documentation gives no indication they can replace or alter the
  compaction summary itself**, and there is **no mention of `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`
  or a `session.compact`/`turn.complete` event pair anywhere** in that page.
- This mismatch is exactly what issue #88 on the repo itself flags. **We could not verify, from
  official Anthropic documentation, that the mechanism this plugin depends on exists in the
  Claude Code build we have installed.** It may be an undocumented/early-access feature flag, a
  fork-specific patch, or simply an inaccurate README — any of those is a reason not to install
  it against a client-facing system without direct confirmation from Anthropic or a working
  reproduction.

## 7. Licence

**MIT**, copyright 2025 (LICENSE file fetched from `main`). No restriction on commercial use,
modification or redistribution beyond retaining the notice.

## 8. Maintenance activity

- **Language:** TypeScript. **Version:** 0.2.0 (package.json).
- **Commit activity:** most recent visible commits dated **17 Sep 2026** (10 days before this
  review), including PR merges #16 and #17 (README tagline update, "chunk decision log");
  history runs back to an "Initial commit" / "Initial fast-jev-compaction library". Commits
  include both the human author (tamaratran) and a `devin-ai-integration` bot, i.e. some of the
  "maintenance" activity is an AI coding agent's own PRs, not necessarily human-reviewed changes.
- **Issues:** **34 total** visible; open issues include real, substantive concerns:
  - [#88](https://github.com/tamaratran/fast-jev-compaction/issues/88) — hooks cannot actually
    replace compaction; full transcripts sent to a third-party API (the core finding of this
    review, raised independently by a user).
  - [#100](https://github.com/tamaratran/fast-jev-compaction/issues/100) "Is it really accurate?"
    and [#99](https://github.com/tamaratran/fast-jev-compaction/issues/99) "Replay on real Claude
    Code sessions..." — accuracy of the keep/drop scoring is itself under open question by users.
  - [#97](https://github.com/tamaratran/fast-jev-compaction/issues/97) "Jev requests from real
    sessions are blocked by Cloudflare WAF" — a live reliability problem, separate from the
    hook-mechanism question.
  - [#89](https://github.com/tamaratran/fast-jev-compaction/issues/89) "Compaction is undone on
    `--resume`" — a correctness bug in session resumption.
  - No maintainer reply was visible on #88 at the time of this review.
- **Star count:** displayed as **6.9k** — unusually high for a single-purpose utility plugin with
  a ~17-PR history; treat with caution (star counts can be inflated by bots/campaigns and are not
  evidence of correctness or safety). Not independently verified beyond what the repo page shows.

## 9. Claimed speed/savings figures and reproducibility

No headline "X% faster" or "Y% token savings" figure was found stated in the README content
fetched (the README's own framing is about **verbatim preservation vs lossy summarisation**, not
a speed claim). **No benchmark suite, benchmark results file, or reproducible numbers were found**
in the reviewed directories (`src/`, `hooks/`, `tests/`, `examples/`) — `tests/` (per
`package.json`'s `vitest run` script) appears to hold correctness unit tests, not a benchmark
harness. **This is itself worth noting**: unlike our own `docs/jev-bench/` methodology (labelled
cases, before/after JSON, p50/p95 tables), this repo makes no reproducible latency, token-cost or
retention-accuracy claim we could check. Issues #99/#100 above suggest other users have also
found no evidence backing its accuracy.

## 10. Comparison with Claude Code's native `/compact` and auto-compact

Per Anthropic's current docs ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks),
fetched 27 Sep 2026) and general Claude Code documentation on compaction:

| | Native `/compact` / auto-compact | fast-jev-compaction (as claimed) |
|---|---|---|
| Mechanism | LLM-generated summary of old turns | Jev keep/drop scoring per tool call+result; kept content stays verbatim |
| Data leaves Claude Code? | Summarisation happens inside the same model call already in use (no new third party) | Yes — full conversation state (minus already-omitted past results) sent to `api.typesafe.ai` (US) on every compaction pass |
| Can a plugin actually replace the summary? | N/A — this *is* the native path | **Unconfirmed.** Official hook docs show PreCompact/PostCompact as observation-only; no documented way to substitute the compaction algorithm itself |
| Verbatim path preservation | Summary is lossy by design — exact paths/errors/constraints can be dropped | Claimed to preserve exact text of anything scored "keep"; unverified independently (see #99/#100) |
| Windows tested | Yes (shipped product) | Not stated |
| Version dependency | Ships with Claude Code itself | Requires 2.1.274+ **and** an undocumented flag |

## 11. Privacy assessment against our standing rules

Our rule: **never send credentials, private caller data, transcripts, recordings, or client
material to a third party.** Against that:

- **Fails by default for a receptionist/client-facing session.** Any session whose tool-call
  history includes patient/client names, phone numbers, call transcripts, appointment details, or
  file contents (contracts, medical notes) would have that data included verbatim in the `state`
  sent to `api.typesafe.ai` on every compaction pass, because only *already-scored past tool
  results* are pre-redacted — current-turn results, all tool inputs, and all chat text are not.
- **No redaction/allowlist mechanism was found** in the reviewed source for stripping PII, patient
  data or secrets before the request goes out.
- **Processing location:** TypeSafe's privacy policy (see the companion `jev-facts.md`, section 7)
  states data is processed and hosted in the **United States** — relevant to APP 8 cross-border
  disclosure obligations if any Australian client/patient data were ever included.
- **No HIPAA statement, and Australian Privacy Act/APP compliance for TypeSafe is unconfirmed**
  (see `jev-facts.md`, sections 6 and 9).

## 12. Risks

1. **Mechanism may not exist as documented** — the core value proposition ("replaces the native
   compaction summary") is contradicted by an open issue on the repo itself and by Anthropic's
   own current hooks documentation. Installing it on the strength of the README alone risks
   either: (a) it silently no-ops and native compaction runs anyway, or (b) it runs via an
   undocumented flag that could change or break on any Claude Code update.
2. **Data exposure** — full tool-call arguments and chat text reach a third-party US API on every
   compaction pass, with no redaction step; unacceptable for any session containing patient or
   client-identifying data under our standing rule.
3. **Unverified accuracy** — the repo's own users are asking "is it really accurate?" with no
   maintainer benchmark to answer them; a wrong "drop" decision could silently discard a
   safety-critical constraint or an exact error message we'd need later.
4. **Reliability** — issue #97 reports real-session Jev requests being blocked by Cloudflare WAF,
   i.e. the mechanism doesn't just risk data exposure, it may also simply not work reliably.
5. **Maintenance signal is mixed** — active commit dates, but a meaningful fraction of recent
   changes come from an AI coding bot (devin-ai-integration), and the highest-severity issue (#88)
   has no maintainer response.
6. **Star count (6.9k) is disproportionate** to visible development activity (~17 PRs) for a
   narrow utility; treat as a soft signal, not a safety guarantee either way.

## 13. Proposed synthetic-only benchmark design (not yet run)

If a pilot were later justified, this is the benchmark to run — **entirely with synthetic data**,
never real client/patient sessions:

- **Sessions:** 8–12 scripted Claude Code sessions of varying length (short ~5 turns, medium
  ~20 turns, long ~60+ turns crossing the default context-window compaction trigger), built from
  fictitious business scenarios (a fake dental practice, fake patient names like "Test Patient
  Alpha", fake phone numbers in a reserved test range) so nothing real is ever in the transcript.
- **Adversarial cases to embed deliberately** (these are the ones that matter most):
  - An old tool result, early in the session and likely to score low on `keepResult`, that
    contains a **still-critical safety rule or constraint** stated nowhere else (e.g. "never book
    appointments on Fridays — the practice is closed") — checked after compaction: is the rule
    still recoverable?
  - A **failing test's exact error output**, referenced again many turns later by file path and
    line number — checked whether the exact string/path survives or gets summarised/dropped.
  - A **long file read** whose only relevant line is buried in the middle — checked whether
    truncation (default 300 head chars) removes the relevant content.
  - A **contradicted-then-corrected instruction** (an early wrong constraint, later corrected) —
    checked whether compaction keeps both, keeps only the correction, or (worst case) keeps only
    the earlier wrong one.
- **Metrics:**
  - **Latency** — p50/p95 per compaction call, measured the same way our own
    `docs/jev-bench/*.json` methodology already does (client-side timing around the call).
  - **Tokens** — pre- vs post-compaction token count, and Jev's own `usage.input_tokens` /
    `output_tokens` per pass.
  - **Cost** — tokens × TypeSafe's published rate (confirm current rate first; see
    `jev-facts.md` section 5, currently unverified).
  - **Retention of exact paths/errors/constraints** — pass/fail per adversarial case, checked by
    exact string match against what was in the original transcript at that point.
  - **Recovery** — after a simulated Jev API failure (kill network mid-call, or point
    `TYPESAFE_API_KEY` at an invalid key), confirm the session falls back to native compaction
    cleanly and the assistant can still proceed with the task.
- **Comparator:** run the identical synthetic sessions through native `/compact` /
  auto-compact with no plugin installed, and score the same adversarial cases, so the comparison
  is apples-to-apples rather than fast-jev-compaction vs nothing.
- **Environment:** an isolated scratch Claude Code project (not `MU-Workspace`, not any client
  repo), synthetic `TYPESAFE_API_KEY` on a throwaway/trial TypeSafe account if one is opened for
  testing, never a production key.

## 14. Provisional verdict

**REJECT** for any client-facing or receptionist-adjacent use today; **not currently a candidate
even for a limited synthetic pilot**, for two independent reasons:

1. Its central claim — that it replaces Claude Code's native compaction — is **not supported by
   Anthropic's own current hooks documentation** and is **disputed on the repo's own issue
   tracker** (#88) with no maintainer rebuttal. We should not build a workflow around a mechanism
   we can't confirm actually runs.
2. Even if the mechanism works exactly as documented, its **default data flow sends full
   conversation content (tool arguments, chat text) to a third-party US-hosted API with no
   redaction**, which conflicts with the standing rule against sending private caller data,
   transcripts or client material to third parties — this would need a redaction layer we'd have
   to build ourselves regardless of whether the hook works.

**If TypeSafe or Anthropic later confirms the underlying hook mechanism is real and documented**,
this could be revisited as a **LIMITED SYNTHETIC PILOT** (section 13) — run only against
fabricated test sessions, never real client or patient data, with the adversarial cases above as
the pass/fail bar, before any conversation about a live pilot.

## 15. Exact reversible install + rollback steps (documentation only — NOT executed)

These are recorded for reference only, in case a future synthetic pilot is approved. **Nothing in
this section was run as part of this review.**

1. Back up current hook/plugin settings first, following the same pattern already used for other
   Hermes/Jev config changes on this PC (see `docs/JEV-ROUTING.md`'s own backup convention,
   `%LOCALAPPDATA%\...\backups\<file>.<timestamp>.before-<change>`): copy the current Claude Code
   `settings.json` (plugin/hooks section) to a timestamped `.before-fast-jev-compaction` backup.
2. In an **isolated scratch project only**, set the environment variable name `TYPESAFE_API_KEY`
   (value from a throwaway/trial TypeSafe account — never a shared production key) and, if truly
   piloting, enable the plugin's stated prerequisite flag
   (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`) in that scratch project's local settings only — never in
   global/user settings, and never in any client project's settings.
3. Add the repository as a Claude Code marketplace plugin per its own README instructions (not
   reproduced verbatim here for copyright reasons) and run its own `validate:plugin` script
   (`claude plugin validate .claude-plugin/plugin.json`) to confirm it loads without installing
   anything beyond the plugin manifest.
4. Run the synthetic benchmark (section 13) end to end in that scratch project only.
5. **Rollback:** disable/remove the plugin entry from the scratch project's settings, unset
   `TYPESAFE_API_KEY` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` in that project, restore the
   settings backup from step 1, and delete the scratch project once the pilot is scored. No global
   or client-project configuration is ever touched by this plan.
