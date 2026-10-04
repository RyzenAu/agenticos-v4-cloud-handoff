# AgenticOS handoff: development baseline, 4 October 2026

This branch (`handoff/claude-dev-baseline-20261004`) is a **sanitised snapshot** of the AgenticOS source for Dot, who now
owns the backend. It is a **root commit with no parent**, so nothing older is reachable from it. It carries source, tests,
deploy scripts, non-sensitive docs and this `handoff/` folder. It carries no history from the working repository, no data,
no keys and no evidence screenshots.

Read in this order: this file, `ARCHITECTURE.md`, `CONTRACTS.md`, `CONFIG.md`, `VERIFY.md`, `OPERATIONS.md`,
`BACKEND-BACKLOG.md`, then `briefs/`.

> **Updated 5 Oct 2026, 06:10 AEDT:** this branch now matches production **`79dd8c50`** (Jarvis PR #7 included) (gateway, Dot's own Jarvis,
> durable command admission, R12 redesign, debug ops), with the same sanitisation as below. Base new PRs on THIS head.
> The "Baseline" table below describes the first snapshot (`8aeb6311`); the mapping rules are unchanged.

## Baseline

| Item | Value |
|---|---|
| Source snapshot | commit `8aeb6311`, branch `r11/next-20261004` of the lead's working repository: `82d6962d8b996b961bf041bb899e9f968484bc65` plus the frontend-only delta below |
| Production | `8aeb6311` on the Ryzen-PC hub since 4 Oct 17:12 (before that `82d6962d`, since 16:21). Rollback tag `rollback/pre-r11e-20261004` points at `82d6962d` |
| Production shape | `MU_HUB_ROLE=server`; the Vite dev hub (`bun --bun run dev`) on `127.0.0.1:8081`; Tailscale Serve in front on port 8443 (tailnet only) |
| Previous baseline | `handoff/claude-dev-baseline-20261002` at `e9ad7c2b`. **Not** an ancestor of this branch and not sanitised to this standard: do not base work on it |
| History of this branch | a single root commit. The working repository's history is not imported |

### Mapping this commit to production

The commit hash of this branch will never equal a production hash: it is a sanitised export with its own root. To verify
what you have against production, use the tree, not the hash:

1. Production runs `8aeb6311`. `GET /__version` on the hub reports the running revision.
2. This tree = `git archive 82d6962d` (tracked files only), minus the exclusions under "Sanitisation", with the in-place
   substitutions listed there, plus the non-evidence part of `git diff 82d6962d 8aeb6311`, plus this `handoff/` folder.
3. The `82d6962d → 8aeb6311` delta is frontend only (20 files): `src/lib/handoff-status.ts`, `src/lib/thread-stop.ts`
   and their test (a Stop button on running jobs in the Jarvis conversation; a hand-off row that follows its job instead
   of saying "Done"), the structural pass on Studio, Inbox, Calendar, Receptionist, Operations, Design and Activity, three
   layout tests and two synthetic screenshot scripts. No file under `scripts/` that the hub runs changed. The other
   handoff docs say "at `82d6962d`"; they are still accurate for the backend.
4. So every file here that is not listed under "Sanitisation" is byte-identical to production's tracked file. The lead
   keeps the unsanitised history; ask the lead for `git diff` output against a production path if you need to confirm one.

## Already live: inspect before replacing

These fixes are in this tree and in production. Read them before writing a replacement.

| Area | What is live | Where | Working-repo commit |
|---|---|---|---|
| 503s on send | Windows sharing violation (EPERM/EBUSY/EACCES) when `conversations.json` is renamed or read while another process holds it; now retried. The other process on the hub is still unidentified (backlog) | `scripts/conversations.ts` (`withSharingRetry`), `scripts/conversations.test.ts` | `43b7f0c3` |
| Admission of unconfirmed browsers | A bare tailnet login gets only the pairing page; shared `/__` routes answer 403 `CONFIRM_FIRST` except `/__version` and `/__health`; device commands and the preview origin refuse it | `scripts/identity/gate.ts`, `scripts/devices/service.ts` (`BARE_LOGIN_REFUSED`), `scripts/lead-sites/preview-origin.ts` | `712f04eb`, `43b0e46f` |
| Conversation-bound "start it" | A yes starts only a draft that is `awaiting_confirmation`, was requested by the caller and is bound to that conversation; none, two, or a changed plan asks once and starts nothing | `scripts/coding/voice.ts` (`asks`, `setPendingDrafts`, `EXPLICIT_START`), `scripts/jarvis-command/threads.ts` (`pendingDrafts`), wiring in `scripts/operator-plugin.ts` | `a8f29e93` |
| Conversation id plumbing | The originating conversation travels with a coding turn and a draft; the draft page's start reports to that conversation | `scripts/jarvis-command/service.ts`, `live.ts`, `scripts/coding/command-entry.ts` | `a27c04e4`, `0183bbe2` |
| Restart during a job | An `interrupted` coding job stays watched and is re-watched after a restart, so the resumed result reaches its conversation | `scripts/jarvis-command/threads.ts` (`resumable`) | `692f2587` |
| Answers and coding requests go to the hub | The client no longer resolves a whole-utterance answer ("start it", "yes") as a page reference or jumps to `/coding` | `src/lib/commands/jarvis-route.ts` | `a54336ee` |
| Stop | Stop before a job exists (coding, agent and computer lanes), the companion's Stop reaching the hub, and wording: "Stopped" only when confirmed, otherwise "Stop requested; not yet confirmed" after a bounded 2 s wait | `scripts/coding/voice.ts`, `src/lib/jarvis-command.ts` (`cancelCommand`, `stopSaid`) | `470a2644` |
| Send recovery | A resend carries the same `eventId` and is de-duplicated; first hop retried (400/1200/3000 ms) | `src/lib/jarvis-command.ts`, `src/lib/typed-send.ts` | r11 batch |

Working-repo hashes are for reference in conversation with the lead; they do not exist in this repository.

## Release owner

One release owner at a time (see `OPERATIONS.md`).

- **Until Dot has proven production access through the gateway:** the lead (Claude) runs releases, with the backed-up
  script and a new rollback tag each time. Dot's work arrives as a pull request here and the lead imports it byte-exact.
- **After that:** Dot is the release owner for the whole product, as the owner assigned it. Frontend batches from Claude
  then go to Dot as a branch for Dot to release.

The switch happens once, when Dot accepts it in writing in a pull request on this repository. Until then nobody else stops,
starts or updates the hub.

## How Dot reads the source and submits work

1. Clone `https://github.com/RyzenAu/agenticos-v4-cloud-handoff` (private) and check out
   `handoff/claude-dev-baseline-20261004`.
2. Branch as `dot/<topic>-<yyyymmdd>` from it. Push the branch and open a pull request against
   `handoff/claude-dev-baseline-20261004`.
3. The lead imports the pull request into the working repository byte-exact (as was done for PR #1), runs the focused
   checks in `VERIFY.md`, and releases it, or returns one list of blockers on the pull request.
4. A newer baseline is published as a new dated branch with its own root. Rebase onto it; never merge an older
   baseline into it.

Access to this repository from Dot's cloud environment needs a GitHub credential held by Dot's environment, granted by the
owner. Access to the running app is separate: see `ACCESS.md`.

## How this relates to Dot's packages (do not apply these twice)

| Package | Status in this baseline |
|---|---|
| **PR #1** `dot/crm-workspace-20261002` at `5d5443fb` (CRM workspace) | **Already applied.** It went into the working repository byte-exact as commit `d5329391` (all 77 added or changed files matched the PR's blobs; the PR deletes nothing), followed by `64e182aa` (Windows: skip `mkdir` for in-memory SQLite). 28 later commits then changed CRM files (mount and route classification, event topic, redaction for unconfirmed callers, review fixes, import deliverables, R11 visual pass). In this tree: 45 of the PR's files are still byte-identical to the PR, 27 carry those later changes, and 5 are absent because they are generated verification JSON under `docs/crm-20261002/` that this package excludes. **Do not re-apply PR #1.** Rebase CRM work onto this branch |
| **PR #2** `dot/cloud-os-handoff-20261002` at `c2a982e1` (cloud handoff and source inventory) | **Documentation only, nothing to apply.** Its two files (`CLOUD-TO-OS-HANDOFF.md`, `docs/cloud-os-handoff-20261002/source-inventory.json`) are not in this tree and stay on that branch. Its content was read and reconciled against the code: see `docs/programme-20261001/CLOUD-RECONCILIATION-R7.md` (32 absent paths classified; none is a drop-in; payments code is archive-only) |
| Older `cloud/*` and `codex/*` branches | Unchanged on the remote. Their status against the current code is the per-branch table in `CLOUD-RECONCILIATION-R7.md` §3 |
| Dot's nine held shared-file proposals | Resolved in the working repository after that reconciliation was written: `/__crm` is mounted (`vite.config.ts`), classified (`scripts/identity/routes.ts`, `docs/IDENTITY-ROUTES.md`), and `src/routes/crm.tsx` is in the route tree. `src/lib/page-context.ts` needed no change |
| Not in this baseline | The five scoped follow-ups in `CLOUD-RECONCILIATION-R7.md` §5 (CRM voice resolve and retry key, coding decisions in "what needs me?", Sydney date and email-draft parser, soft-404 checks, one router regression test) were proposals; check each against the code before starting. The gateway (`scripts/gateway/*`) is **not** on this branch: it lives on `gw/dot-gateway-20261002` in the lead's repository |

No existing remote branch was modified or deleted to make this one.

## Ownership

**Claude owns the frontend:** the shared design system and components; navigation and the app shell; layouts, typography,
spacing and visual polish; frontend integration with Dot's backend contracts.

**Dot owns everything else:** the backend and Jev routing; business workflows and integrations; jobs, native coding
delegation and results; memory, bot computers and reliability; operations and the overall integration and release process.

One resolver per shared file:

| Owner | Paths |
|---|---|
| Frontend (Claude) | `src/styles.css`, `src/operator.css`, `src/components/ds/`, `src/components/ui/`, `src/components/calm/`, `src/components/shell/`, the page components under `src/routes/` and `src/components/*` |
| Backend (Dot) | `scripts/**`, `deploy/**`, `companion/**`, the plugins mounted in `vite.config.ts` |
| Shared seam: coordinate any API change with both owners before it lands | `src/lib/jarvis-command.ts`, `src/lib/commands/*`, `src/lib/typed-send.ts`, `src/components/operator/voice-companion.tsx`, `src/lib/coding-client.ts`, and the other clients: `src/lib/computers-client.ts`, `src/lib/terminal-client.ts`, `src/lib/crm-client.ts`, `src/lib/free-voice-client.ts`, `src/lib/openai-voice-client.ts`, `src/lib/design-publish-client.ts`. Also `scripts/jarvis-command/contracts.ts` and `scripts/coding/contracts.ts`, which the frontend imports as types |

A change to a wire shape in `CONTRACTS.md` is a seam change: the backend owner proposes it, the frontend owner adapts the
client in the same release.

## Sanitisation (what differs from `82d6962d`)

**Excluded from the tree**

- every folder whose name contains `evidence` (for example `docs/**/evidence/**`, `docs/hindsight-evidence/`,
  `docs/programme-20261001/r6-evidence/`, `docs/stage-d/evidence/`, `docs/t6-memory/evidence/`);
- every image, video, PDF and Office file under `docs/`, and the `screens`, `screenshots`, `shots`, `before`, `after`
  folders there;
- `docs/sales/**` except `receptionist-pack-2026-09-28/package-economics.json` (two tests and the catalogue exporter read
  it; it holds package pricing only);
- generated result data: `scripts/memory/r5-acceptance-result.json`, `scripts/acceptance/r7/results/**`,
  `scripts/model-fleet/*results.json`, and every JSON file under `docs/` except the receptionist catalogue, the
  receptionist consistency fixture and `docs/crm-20261002/migration-example.json`;
- `docs/cloud-ops-20261001/restore-rehearsal-transcript.txt`;
- every `*.bak*` and `*.orig` file;
- the six wake-word audio fixtures `scripts/fixtures/wake/*.wav` (their origin is not recorded, so they are held back pending the owner's review). `scripts/wake-word.test.ts` needs them: its model-based cases fail without them. The lead adds them back once the owner confirms they are synthetic.

Scripts that write evidence (for example `scripts/acceptance/r11/staging-flows.ts`) recreate their output folders.

**Substituted in place (same substitution everywhere, so tests still agree with code)**

| What | Replaced with | Where |
|---|---|---|
| The owner's Telegram id | `1000000001` | `scripts/away-mode/notify.ts` (`DEFAULT_OWNER_TELEGRAM`), `scripts/inbox-triage/alerts.ts` (`OWNER_TELEGRAM`), a comment in `scripts/remote-access.ts` and `src/components/operator/automations-workspace.tsx`, `docs/FILM-JARVIS.md`, 11 test and fixture files |
| The co-founder's Telegram id | `1000000002` | 4 test files |
| A real client contact's name, mobile and email | a made-up name, an ACMA fiction number and an `.example` address | `scripts/site-draft/client-qa.test.ts`, `client-evidence.test.ts`, `client-evidence.ts` (comment), `scripts/inbox-triage/triage.test.ts`, `rules.ts` (comment), `scripts/dream/dream.test.ts` |
| The owner's date of birth and street name in test strings | a different date and "Example Street" | `scripts/hermes/hermes-customise.test.ts`, `scripts/hermes/owner-profile.ts` (comment) |
| The tailnet's name in hostnames | `tailnet-name` | 13 files: 9 docs, `deploy/windows/verify-after-reboot.ps1` (the default of `-PublicVersionUrl`; pass the real URL), `scripts/windows/openclaw-pair-phone.ps1` and `scripts/remote-access.ts` (comments), `scripts/memory/api.test.ts`. One tailnet IP in `docs/programme-20261001/RYZEN-MIGRATION.md` is masked |
| SHA-256 values of credential files | `<sha256 withheld>` | `docs/programme-20261001/ryzen-hermes/RYZEN-HERMES.md`, `docs/programme-20261001/CLOUD-ARCHITECTURE.md` |

**Before running this tree against real Telegram:** the two source constants above hold a placeholder. Production gets
its real values from the lead's repository; restore them (or better, move them to configuration) before any deployment
built from this branch. The 22 test files that touch the substituted values pass (2,357 tests, run on the sanitised tree).

The full scan record (patterns, hits by path, dispositions) is kept by the lead outside this repository.
