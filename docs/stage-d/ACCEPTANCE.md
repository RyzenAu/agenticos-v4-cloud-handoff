# Stage D acceptance: one authenticated memory route (28 Sep 2026, round 2 + R2 + R3)

**R3 (ready to switch on), latest run: 38/38** (run `d5ff8e`, bank `syn-stage-d-d5ff8e`,
`evidence/acceptance-run.json`). It includes the new check "switch-on verify": the lead's live
verification script `scripts/memory/stage-d-verify-live.ts`, pointed at this synthetic copy, passed.
- Save: processed by `openrouter/deepseek/deepseek-v4.1-flash`, metered, 3,579 tokens.
- Recall: via Hindsight, with its source.
- Correction: the new version was processed by the same model, and the old document returned 404.
- Single delete: the owner's own approval removed both versions (404).
- The `/__memory/mcp` tool list was correct.

Other R3 items:
- **jarvis-voice 709c8ab merged** (e6dd585). `free-voice.ts` keeps `sink`, `health` and `memory`, with
  the memory check before the router. The result fast-forwards jarvis-voice. Full suite on e6dd585:
  **5,075 pass, 13 skip, 0 fail**.
- **R3 phrasing** (2f356fb), each with a test in `secrets-screen.test.ts`:
  - Now refused: "Use X as the Xero password", "Xero: jane.admin / X", "Wifi: KestrelGuest / X",
    "uses passphrase X", "passwrod", "P@ssword".
  - Now stored: "required to be 12 characters", "stored in 1Password", "on the fridge", "the access code
    … is on the invite", "The token budget is 800 tokens per turn".
- **Switch-on runbook:** `docs/stage-d/SWITCH-ON-RUNBOOK.md`. It has exact PowerShell commands with a
  rollback per step, plus the verification script. None of its steps were run by an agent. The pilot's
  proxy writes are still OFF, and `agentic-os.env` has no memory variables.


**R2 re-check fixes (latest run):** 37/37 (run `b8167e`, bank `syn-stage-d-b8167e`) against the deployed
rev 3.1 proxy on the dedicated instance, including the two R2 repros:
- **R2-1:** the agent's forget request is recorded as `requested_actor: "process"`; the agent's grant with
  the page token it fetched → 403; even the owner's click → 403 ("A program asked for this, so a click
  can't approve it: it needs your spoken yes…"); the re-sent forget removes nothing (document still 200).
- **R2-2:** "The … Xero password is now sunflowerfield" through the agent route → refused (prohibited-content).
- `tsc` clean; memory tests 225 pass, 9 skip, 0 fail; full suite **4,685 pass, 13 skip, 0 fail** (4,698 tests).
- No new `%TEMP%` folders across the instance start; the instance is stopped.

The earlier round-2 run (35/35) is described below; `evidence/acceptance-run.json` now holds the 37/37 run.

Branch `f/stage-d-memory-20260928` (worktree `AgenticOS-v4-wt/stage-d`). Round 2 answers the independent
review (`MU-Workspace/memory/master-v3/REVIEW-STAGE-D.md`, verdict FIX FIRST) and is adapted onto the
integration branch `f/int-b1-c1c2-20260928` (jarvis-voice 6b1bdc3 + B1 identity c73b7fd + C1/C2), with
`f/deflake-20260928` and Hindsight ops rev 3.1 (`d/hindsight-ops-20260928` f5ad89b) merged.

The memory switch is still **off on the real pilot** (its proxy write gate read OFF). Nothing here touched
the pilot's data, the real vault, the live OS on 8081 or any real client config.

**Result: 35/35 checks passed** (run `273c99`, bank `syn-stage-d-273c99`, 28 Sep 07:59–08:03 AEST)
against the **deployed rev 3.1 proxy** (Host/Origin guard), plus a real Claude Code run through the new
wiring, the credential-copy fixture test (ALL PASS) and the test suites. Raw outputs: `evidence/`.

## The setup (synthetic only)

| Part | What was used |
|---|---|
| Hindsight | The dedicated synthetic instance `stage-d` (API 8893, proxy 8883, Postgres 5437, under `D:\hindsight\stage-d`, `scripts/hindsight/stage-d-instance.ps1`), running the deployed rev 3.1 supervisor and proxy unchanged. Stopped afterwards. |
| Model chain | The deployed default: OpenRouter `deepseek/deepseek-v4.1-flash` (ZDR), then Groq, then Codex. |
| Vault | A TEMP copy of `scripts/memory/fixtures/mini-wiki`. |
| AgenticOS | This worktree as a quiet copy on 8095 (`AGENTIC_OS_NO_BACKGROUND=1`), behind B1's identity gate, `MU_MEMORY_WRITES=on`, its own vault and store, Hindsight through an **HTTP relay that rewrites Host** (the rev 3.1 proxy refuses foreign Hosts; the old TCP relay no longer worked, as the reviewer found). |
| Driver | `bun --no-env-file scripts/memory/stage-d-acceptance.ts --port 8095 --out docs/stage-d/evidence/acceptance-run.json` |

## Results (observed)

| # | Item | Result | Observed |
|---|---|---|---|
| 1 | Save, then recall with the source cited | PASS | Jarvis "Remember that …" → `model: "rules"`, a `mem-` in Hindsight; "Save this to the vault: …" → the block in `wiki/topics/business/memory-business-shared.md`; recall "(from the Jarvis memory mem-… ) Also: … (from the vault note …)"; HTTP recall `via: ["hindsight","local"]`. |
| 2 | Recall after a restart | PASS | After killing and restarting the OS: same items via Hindsight, pending 0. |
| 3 | An Obsidian edit appears in recall | PASS | 21 → 45 days: recall and the Hindsight document hold 45, not 21. |
| 4 | A rename doesn't duplicate | PASS | Same note id, same Hindsight document set, new path. |
| 5 | A correction suppresses the old fact | PASS | The old `mem-` is 404 in Hindsight and never recalled. **B4:** "Correct that: … 8am" is read back ("Update … from … to …? Say yes to update it, or no to leave it."), the item is still `current` before the yes, and only the yes supersedes. "Actually, can you open my email inbox for me" goes to the brain (`model: openai/gpt-oss-120b`), not memory. |
| 6 | Single delete, forget a/b/c with approval | PASS | a: no approval, Hindsight 404, note kept. b by voice: typed yes refused; a real spoken "Yes." (synthesised WAV through the voice STT) approves once; replay refused. c: plan + server-held approval; grant without the page token 403; forged id refused; approved removal of the vault block and the Hindsight document; single use. Proxy: bank delete, clear and an unsigned document delete refused. |
| 7 | Unauthenticated requests fail | PASS | **B1:** from another localhost origin (`Origin: http://localhost:5173`, `Sec-Fetch-Site: same-site`): `/__token` 403 (no ACAO header), `/__memory/items` 403, save 403 and unindex 403 even with a valid page token; the own page without its token 403. Also: foreign Host 403, relayed without tailnet identity 401, voice turn without token 403, direct Hindsight without key 401, cross-site 403. |
| 8 | Outage mid-sync | PASS | Relay cut after 1 of 6 new notes landed: pending 5, "Hindsight is unreachable", state `unavailable`. Back: pending 0, 16 documents = 16 desired, no duplicates, `n-35d562dfeb` landed on attempt 2. |
| 9 | No credential copies at startup | PASS | No new `hindsight-claude-code-*` folder in `%TEMP%` across the instance start (names only; the owner's kept folder excluded by name, never opened); the per-launch isolation dir is empty; `cred_fixture_test.py` ALL PASS (`evidence/cred-fixture-test.txt`). |
| 10 | Per-save model record, shown in the UI | PASS | e.g. `processed_by: openrouter / deepseek/deepseek-v4.1-flash, metered, 3,485 tokens`; saves per model 22 by the end (kept in status.json, no longer rebuilt from the log tail). |
| B2 | Secrets | PASS | Voice "… wifi password is correcthorsebatterystaple" refused ("That looks like a password, key or token…"); "BSB is 062-000 and account 1234 5678" and card `4111.1111.1111.1111` refused; an ordinary mobile number stored (owner: personal data is fine). |
| B3 | Agents through the OS | PASS | An agent process (no browser markers, no token) on `POST /__memory/mcp`: tools `remember, save_to_vault, recall, forget`; a save is screened, listed in the OS, model recorded (DeepSeek, 3,519 tokens); `forget` returns approval-required and nothing is removed. |
| Clients | Config shapes | PASS | `client-shapes-check.ts` (entries rebuilt from `connect-clients.ps1`, real configs untouched): Claude Code `{type: http, url: …/__memory/mcp}` and Hermes `{url, include: [recall, remember, save_to_vault, forget]}` both save and recall through the OS, no rewrite/delete tool exposed, a password refused; the skill's curl recall finds the canary. **Real Claude Code** (`claude -p`, identical entry via `--mcp-config --strict-mcp-config`): saved and recalled "The Heron52377d synthetic florist delivers flowers on Thursdays." from `mem-cf7ff6fc84`, which the OS lists with actor Usman and model DeepSeek v4.1 flash (`evidence/client-claude-code-real.json`). |

Note: the client check's own last save was still being processed by Hindsight when the run ended and closed
its relay, so it shows as one failed attempt ("unreachable") in the final processing log. That is the
teardown, not a failure of the flow (the save itself was confirmed and recalled).

## Review items: what changed (round 2)

| Review item | Fix | Proof |
|---|---|---|
| B1 cross-origin | `/__memory` sits behind B1's identity gate (cross-origin and same-site `/__*` refused, Vite CORS off); every POST needs the caller's OWN page token (`pageTokenMatches` + `requestPrincipal`); the memory middleware repeats the origin rule itself | route matrix (review repro), `origin.test.ts`, run item 7 |
| B2 screen (owner-adjusted) | Only credentials and financial secrets are refused, everywhere and never stored: passwords and login pairs (any value), API keys/tokens, BSB + account, cards (Luhn), TFNs, bank/one-time codes; matching normalises words, dashes, dots and spacing. Personal data is no longer screened; the app-store-only path is gone. Vault notes with a secret are not synced. Medicare and passport numbers are no longer screened (not on the owner's list). | `secrets-screen.test.ts` (23 refused, 14 allowed, all routes), run "secrets" |
| B3 agents | `POST /__memory/mcp` for Claude Code and Hermes (remember, save_to_vault, recall, forget-asks); agent processes at this PC need no page token on the agent routes only; `connect-clients.ps1` points them at it; the proxy's `write_images: ["bun.exe"]` (pilot) lets only AgenticOS write; Hindsight's MCP loses sync_retain/update_memory/invalidate_memory | `mcp.test.ts`, route matrix, python unit test, run "agents"/"clients", real `claude -p` |
| B4 corrections | Explicit intent only; read back; superseded only on a yes; "Actually, …" goes to the brain | `voice-turn.test.ts`, run item 5 |
| B5 identity / single writer | Vanished notes keep their id 30 days (`missing_since`); unindex kept by path too; an empty-looking vault removes nothing; the removal hold also covers half a small vault; one writer (main tree on 8081 + lock), any other copy read-only | `identity-writer.test.ts` |
| Item 6 | Rate-limited deletes soft-invalidate the facts (no reader sees them) and wait (`hold_until`, honoured by forced syncs); durable per-model tally incl. "model unknown"; logs rotate; no carried-over model; failed fetches show a failed state; "as of" time; retry times; queued reason; held removal bound to the listed digest | `connector-proxy.test.ts` |
| Finance review | Memory import refuses NAB/bank transaction exports (header, NAB Connect, headerless 4/5-column), pointing to Finance | `memory-bank-export.test.ts` |

## Test suite and typecheck

- `tsc --noEmit`: clean (exit 0).
- `bun --no-env-file test scripts` on the de-flaked, integrated base: **4,653 pass, 13 skip, 0 fail**
  (4,666 tests across 356 files, 283 s).
- Hindsight python unit tests (`scripts/hindsight/tests`): 32 pass.

## Switch-on steps (lead)

Writes are still OFF on the pilot. The exact commands, each with its rollback, and the live verification
script are in **`docs/stage-d/SWITCH-ON-RUNBOOK.md`**. The order:
1. Fast-forward the main tree.
2. Deploy Hindsight and restart the pilot.
3. Point the clients at the OS.
4. `hindsightctl writes -State on -Profile pilot`.
5. `MU_MEMORY_WRITES=on`, then restart the OS.
6. Run `bun --no-env-file scripts/memory/stage-d-verify-live.ts`.

## R2 re-check: what changed

| Item | Fix | Proof |
|---|---|---|
| R2-1 self-approval | Stage B2's rule: every approval records who asked (B1 actor; missing = process); only a human session can grant; a request a program made can't be answered by a click or the page token, only by the server-recorded spoken yes (voice channel) or, once B2's service replaces this stub, the owner's Telegram DM code. A person's own request from the Memory page keeps its UI confirm. Held-release: same rule. `/__token` untouched. | `mcp.test.ts` (the reviewer's repro, a person's click, a voice grant, held-release, missing actor), run "agents" R2-1 |
| R2-2 phrasing | Value introducers (is, now, changed to, set … to, stored as, :, =, pw direct), strong/weak labels, state words only clear a sentence with no value-shaped token after them, login pairs "user X pass Y", "sign in … with X and Y"; NFKC, zero-width removal, spelled-out tokens joined, "x" between digits, split keys after a known prefix. Saves and note sync. | `secrets-screen.test.ts`: every reviewer phrase refused, ten near misses stored; run "secrets" R2-2 |
| Minor: hold > 30 days | A vanished note keeps its identity as long as its documents are still in Hindsight | `identity-writer.test.ts` (31-day hold, restore, same ids) |

## Documented limit (not fixed, by decision): bun.exe can write directly

The proxy's `write_images: ["bun.exe"]` identifies AgenticOS by its executable name. Any `bun.exe` process
running as the owner (for example an agent running `bun -e "fetch(...)"`) can still write straight into
Hindsight, unscreened and invisible to the OS; the reviewer landed such a document. It stops the clients
as configured (Claude Code, Hermes, curl, Python), not a determined local process. Agents must be told to
save only through `http://127.0.0.1:8081/__memory/mcp`; the real fix is a dedicated service account for
the OS (or a per-run proxy credential only the OS holds), as HINDSIGHT-OPS §5 also notes.

## Open items

- Approvals are the connector's own durable, server-held path; Stage B's `approvals.request` should replace it.
- Bulk *unindex* (review S2) is not rate-held; it is reversible and now same-origin + token only.
- The `write_images` rule identifies the writer by executable name (bun.exe): a guard rail against
  configured clients, not against a determined process running as the owner (as ops' own "honest limit").
- The Hindsight ops agent's synthetic tests that use MCP `sync_retain` need updating once the tool list is deployed.
- The first real vault sync indexes every permitted note (one metered DeepSeek call each, about US$0.0002).
