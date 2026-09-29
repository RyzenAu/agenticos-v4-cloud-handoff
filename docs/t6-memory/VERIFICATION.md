# Track 6 · shared memory: verification (28 Sep 2026)

This is branch `f/t6-memory-20260928`, from jarvis-voice `f334ab7`, in worktree `AgenticOS-v4-wt/t6-memory`.

**REAL** means through the live OS on `127.0.0.1:8081`, the pilot proxy `8878`, the `mu-shared` bank and
the real vault, using tagged synthetic facts and test notes that were all removed again.
**SYNTHETIC** means the dedicated `stage-d` Hindsight instance, a temporary copy of the mini-wiki and a
quiet OS copy, with never the pilot or the real vault.

## Verification table

| # | What | Where | Result | Evidence |
|---|---|---|---|---|
| 1 | Save ("remember") through the OS | **REAL** | ✔ confirmed in `mu-shared` | `evidence/live-verify.json` (A save) |
| 2 | Model receipt per save | **REAL** | ✔ every save: `openrouter/deepseek/deepseek-v4.1-flash`, metered, 3,469–3,768 tokens; 7 saves this run | live-verify (A receipt, receipts) |
| 3 | Sourced recall | **REAL** | ✔ via Hindsight, with its source (memory id; vault path and Obsidian link for notes) | live-verify (A recall, B recall) |
| 4 | Correction | **REAL** | ✔ new version confirmed; old document gone (404); only the new version recalled | live-verify (A correction) |
| 5 | Forget kind a (unindex; the file stays), then re-include | **REAL** | ✔ document 404 and file kept; re-included 200 with a fresh receipt | live-verify (B forget a, B re-include) |
| 6 | Forget kind b (memory, approval in the owner's session) | **REAL** | ✔ asks first; both versions deleted | live-verify (A forget b) |
| 7 | Forget kind c: one section, then the whole note | **REAL** | ✔ the section leaves the vault file and Hindsight re-indexes without it; the whole note's file is deleted and its document is 404 | live-verify (C …) |
| 8 | Obsidian note: create, edit, rename, delete sync | **REAL** | ✔ created and indexed; edit re-indexed (Hindsight holds the new wording, not the old); rename keeps the id with no duplicate; deleting the file retracts it | live-verify (B …) |
| 9 | End state after the live run | **REAL** | ✔ no test note left in the vault; nothing from the run in the index; 0 pending; 0 errors; 7 of the proxy's 20 deletes an hour used | live-verify (end state) |
| 10 | The same 29 checks on a synthetic copy first (dry run) | SYNTHETIC | ✔ 29/29 | (dry run, before the live run) |
| 11 | Restart recovery: a real restart (the PC restarted at ~14:59) | **REAL** (read-only) | ✔ 7/7 against the snapshot taken before it: the same 25 items (ids, versions, hashes), all still indexed, 7 tombstones, 0 queued and 0 errors, the model tally (35), the switch on, and this OS still the writer. New OS PID 34992 (was 140620). Proxy and pilot were up with writes ON; a recall through the OS answered via Hindsight; the Hermes gateway was back | `evidence/restart-real.txt` |
| 12 | Restart recovery: a fresh process over the persisted store | a read-only preview (port 8099, its own Vite cache on D:, `MU_MEMORY_WRITES` unset, not the writer) over a **copy of the live store** plus the real vault, read-only | ✔ 7/7: the same 25 items (ids, versions, hashes), 25 indexed, 7 tombstones, 0 queued, the model tally (35); the vault untouched; the copy deleted afterwards | `evidence/restart-preview.txt` |
| 13 | Restart recovery: OS restart mid-use | SYNTHETIC | ✔ recall after a restart still finds it via Hindsight; nothing pending (full acceptance on this branch: **38/38**, run against the deployed proxy, which also proves compatibility with a proxy that has no writer route) | `evidence/synthetic-acceptance-run.json` ("2 restart") |
| 14 | Failure: Hindsight down mid-sync | SYNTHETIC | ✔ what didn't land stays queued **with the reason**, then lands exactly once after recovery | synthetic acceptance ("8 outage") |
| 15 | Failure: Hindsight unreachable at forget | SYNTHETIC (unit) | ✔ "queued for deletion (Hindsight isn't reachable right now; it retries)"; state `queued` | `voice-intents.test.ts` (F12) |
| 16 | Failure: Hindsight off | SYNTHETIC (unit) | ✔ "Hindsight is off here…", never "deleted from Hindsight" | `voice-intents.test.ts` (F12) |
| 17 | Failure: the proxy refuses this OS as the writer | SYNTHETIC | ✔ queued, state `writer-refused`, a receipt, a red line on the Memory page | `writer-capability.test.ts` |
| 18 | The bun.exe bypass closed | SYNTHETIC (this branch's proxy.py, standalone) | ✔ 12/12: other bun processes refused, a forged registration refused, a co-bind on 0.0.0.0 and on [::] refused (REVIEW-T6 finding 2), recovery after proxy and OS restarts, and off reopens the bypass | `evidence/writer-capability-run.json` |
| 19 | The OS's writes come from the 8081 listener PID (the premise of #18) | **REAL** (read-only) | ✔ every allowed write in the pilot log is `client_pid` 140620 = the 8081 LISTEN owner | pilot `proxy.jsonl` (read 28 Sep) |
| 20 | Forget approvals on B2's durable service | SYNTHETIC | ✔ unit, HTTP and acceptance; see the matrix below | tests, acceptance |

## Forget approvals (B2) test matrix

All synthetic. Who approves (lead decision, 28 Sep): **either founder's spoken yes or card; the Telegram code
goes only to the requester's DM**. The owner decision "an agent can never approve its own forget, and a user-started
Memory-page forget uses its button" holds throughout.

| Case | Result | Test |
|---|---|---|
| A program's request (MCP): no card, no page-token grant, no click, not even the owner's | refused | `mcp.test.ts`, acceptance "agents R2-1" |
| A program's request: the code goes to the **requester's own** Telegram DM, never back to the agent | sent to usman only | `mcp.test.ts`, `approvals-t6.test.ts` |
| A program's request: "approve CODE" from the requester's DM approves it and the server runs it | runs once; `granted_via: telegram`; outcome recorded | `mcp.test.ts` |
| A program's request: "deny CODE" | refused; can't be approved later | `mcp.test.ts` |
| A program's request: the other founder's Telegram, a non-interactive Telegram principal, a wrong code | refused; a wrong code is a counted miss | `approvals-t6.test.ts` |
| **Brute force (REVIEW-T6 finding 1):** 248 wrong codes | 3 misses void the code and lock guessing for 15 minutes; the right code then approves nothing; the approval stays pending for a spoken yes; after the window, asking again sends a fresh code that works | `approvals-t6.test.ts` |
| Ordinary Telegram text ("approve payments") | never taken for a code, never counted | `approvals-t6.test.ts`, plugin test |
| `/__away/telegram` rate limit | 30 messages and 5 code replies a minute per sender | `away-mode/relay-limit.test.ts` |
| A spoken yes from a program (REVIEW-T6 finding 5) | refused; no question is put to a program | `approvals-t6.test.ts` |
| "yes, forget it" with S2 merged (finding 4) | Jarvis re-asks ("just say yes"); a plain spoken yes then approves | `approvals-t6.test.ts` |
| A section forget's heading (finding 6) | stored as a hash (`#h-…`), never the words; Telegram lines and replies name ids only | `approvals-t6.test.ts`, `mcp.test.ts` |
| A mismatched forget from a program (finding 7) | refused without cancelling the person's approval; the person's own mismatch cancels it | `approvals-t6.test.ts` |
| A program's request: "approve the pending forget" (voice), then a spoken yes | the question goes through the ONE registry and the yes is redeemed by B2 | voice routes, `voice-turn.test.ts` |
| A person's own Memory-page forget: the card's button (nonce bound to that browser session) | runs at once | `connector.test.ts`, `client-integration.test.ts`, acceptance |
| The other founder, in his own session, on a person's own request | allowed (one shared pool, equal founders) | `connector.test.ts`, `approvals-t6.test.ts` |
| A forged nonce, another session's card, a revoked session | refused; a misused card is spent | `approvals-t6.test.ts` |
| A changed target: an approval spent on another item | refused and voided | `approvals-t6.test.ts` |
| A changed item: the note edited before the approval runs | voided; nothing removed | `connector.test.ts` 7(c) |
| Replay: a consumed approval, a reused card, a reused Telegram code, a reused spoken yes | refused | several |
| Restart: a pending approval survives (a new card approves it); an approved-but-not-run one is used exactly once; a consumed one never replays | ✔ | `connector-proxy.test.ts` |
| Restart: a program's pending request keeps its approval, but its old Telegram code can't be checked (the keys are in memory); asking again sends a fresh code that works once | ✔ | `approvals-t6.test.ts` |
| The approvals store never holds the text being forgotten (ids only; readable descriptions are computed live) | ✔ | `connector-proxy.test.ts`, `mcp.test.ts` |
| A person's request is never merged into a program's identical one (B2 `request()` now keys on the actor) | ✔ | `mcp.test.ts` held-release |

## Restart: what the lead runs (read-only)

```powershell
cd $env:USERPROFILE\source\repos\AgenticOS-v4-wt\t6-memory     # or the main tree once merged
bun --no-env-file scripts\memory\t6-restart-check.ts --snapshot D:\agent-scratch\t6\before-restart.json
# ... the scheduled OS restart ...
bun --no-env-file scripts\memory\t6-restart-check.ts --compare  D:\agent-scratch\t6\before-restart.json
```
It compares, without any text:
- the same item ids, versions and hashes;
- items still recorded as indexed;
- tombstones and exclusions;
- no dropped queued write;
- the model tally;
- the switch and writer;
- the Hindsight state.

## Found and fixed on the way

- **B2 `request()` merged a person's request into a program's identical pending one.** It keyed on the
  person and action but not the actor, so the person's own Memory-page forget would have inherited the
  program's "no click" rule. It now keys on the actor.
- **B2's approvals store kept the approval summary**, which held the text being forgotten, after the
  forget. Memory approvals now store ids only, and readable descriptions come from the store as it is now.
- **The adapter** now counts a caller as a person only when both the memory caller and B1's own
  principal say "human" (fail closed).
- **Audit F12:** a spoken correction kept only the pronoun fragment, and forget replies said "deleted
  from Hindsight" when Hindsight was off. Both are fixed, with regression tests.
- **The dry run found** that Hindsight's extraction model keeps nothing from text labelled "(test data,
  removed by the check)": 0 memory units, so no receipt and no Hindsight recall. The live check therefore
  uses plain synthetic facts. **Product note:** a document with 0 extracted units shows "model not
  recorded" and is recalled from the local index only. Surfacing that state is a follow-up.
- **A section forget's reply said "Hindsight isn't reachable"** when the delete was only still queued.
  Replies now say what happened in each store.

## Open

- **One connection reset** on a forced `POST /__memory/sync` during a slow first index on the live OS
  (attempt 1 aborted there). There was no restart, same PID. The retry passed, and the script now
  treats `/sync` as best-effort. The cause isn't proven; likely a Vite dev-server connection reset
  under load.
- **Nightly backup task.** The task file is present after the restart. A non-elevated account can't read
  its trigger or principal, so "runs tonight at 03:30 as SYSTEM" can only be confirmed from an elevated
  prompt: `Get-ScheduledTask -TaskPath '\MU\' -TaskName 'Hindsight nightly backup' | Select-Object State,
  @{n='User';e={$_.Principal.UserId}}; (Get-ScheduledTaskInfo -TaskPath '\MU\' -TaskName 'Hindsight nightly
  backup').NextRunTime`.
- **The deploys** (Track 6 OS code, then the writer capability) are for the owner's approval:
  `WRITER-CAPABILITY.md`.
