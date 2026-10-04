# Vault on Ryzen: git-only sync between the hub and the main PC

The authoritative copy of the Obsidian vault (`mu-ventures-obsidian-wiki`, branch `main`) lives on the hub PC **Ryzen-PC** at
`C:\mu-hub\vault\mu-ventures-obsidian-wiki`. The AgenticOS memory connector there (`MU_WIKI_ROOT`) reads `wiki/**/*.md` and writes
notes into it ("save to vault"). The owner edits on the main PC in Obsidian; a Claude skill there writes session reports. The only
transport is git, over ssh alias `ryzen-bots`. Ryzen is the hub of a star: it never pushes, fetches or pulls anything.

```
 main PC clone  --(vault-sync.ps1: commit, fetch, rebase, push)-->  Ryzen clone (checked-out main, updateInstead)
 Obsidian edits <--(same script, next run: fetch + rebase)-------   connector writes notes -> autocommit task commits them
```

| Script | Where | What |
|---|---|---|
| `Initialize-RyzenVault.ps1` | Ryzen, once | `receive.denyCurrentBranch=updateInstead`, `core.autocrlf=false`, identity only if none exists. Refuses unless the path is a repo on `main`. Idempotent, `-WhatIf`. |
| `mu-vault-autocommit.ps1` | Ryzen, scheduled | Commits only `wiki/*.md` (plus deletions/renames under `wiki/`) that the connector may read. Mutex, no run during `index.lock`, never pushes. |
| `Install-VaultAutocommit.ps1` | Ryzen, once, elevated | Registers `\MU\MU Vault Autocommit` (startup +60 s, then every 10 min, S4U). Only touches that one task. `-WhatIf`, `-Remove`, `-StartNow`. |
| `vault-sync.ps1` | main PC (and the skill) | Commit local edits, `git fetch ryzen`, `git rebase ryzen/main`, `git push ryzen HEAD:main`. Aborts and tells you on conflict. `-Setup` adds the remote. |
| `mu-vault-common.ps1` | both | Shared helpers, including the connector's allow/deny rules. |
| `tests\Test-VaultSync.ps1` | anywhere | Temp repos only. `powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\vault\tests\Test-VaultSync.ps1` |

All scripts are ASCII-only Windows PowerShell 5.1 and need Git for Windows (`C:\Program Files\Git\cmd` is found automatically).

## Cutover (owner or lead, one time, in this order)

Nothing here has been run on the real vault or on Ryzen. The repo is `deploy\windows\vault` of this branch; on Ryzen it sits under
`C:\mu-hub\AgenticOS-v4\deploy\windows\vault` once the branch is merged and deployed. `$V` below is the vault folder.

1. **Main PC, freeze and commit.** Close Obsidian (so nothing writes mid-bundle). In the vault: `git status`. The owner commits any
   pending change (or says to commit it). Stop the main-PC connector if it writes to the vault (the connector allows one writer,
   which becomes Ryzen). Note the head: `git rev-parse HEAD` and `git rev-parse "HEAD^{tree}"`.
2. **Bundle.** `git bundle create C:\Users\Public\vault.bundle --all` then `git bundle verify C:\Users\Public\vault.bundle`
   (must say "okay"). Ignored files (for example `.obsidian\workspace.json`) are not in a bundle, which is intended.
3. **Copy.** `C:\Windows\System32\OpenSSH\scp.exe C:\Users\Public\vault.bundle ryzen-bots:C:/mu-hub/incoming/`
   (the connector reads only `wiki/`, so nothing else needs to travel).
4. **Clone on Ryzen** (`ssh ryzen-bots`, default shell cmd):
   `mkdir C:\mu-hub\vault` then
   `"C:\Program Files\Git\cmd\git.exe" clone C:\mu-hub\incoming\vault.bundle C:\mu-hub\vault\mu-ventures-obsidian-wiki`, then in it
   `git remote remove origin` (the bundle path is not a remote you want) and `git branch --show-current` must print `main`.
5. **Initialize** on Ryzen:
   `powershell -NoProfile -ExecutionPolicy Bypass -File C:\mu-hub\AgenticOS-v4\deploy\windows\vault\Initialize-RyzenVault.ps1 -WhatIf`
   then again without `-WhatIf`. If Ryzen has no global git identity it stops and asks for
   `-AuthorName "<name>" -AuthorEmail "<email>"` (it never invents one; it sets them locally in the vault only). Use the account
   that sshd logs in as, and that will own the scheduled task.
6. **Verify identical.** On Ryzen `git rev-parse HEAD` and `git rev-parse "HEAD^{tree}"` in the vault must equal the values noted in
   step 1. Stop on any difference.
7. **Install the autocommit task** (elevated PowerShell on Ryzen, as that same account):
   `Install-VaultAutocommit.ps1 -WhatIf`, then `Install-VaultAutocommit.ps1 -StartNow`. Check
   `Get-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Vault Autocommit'` and `C:\mu-hub\logs\mu-vault-autocommit.log`
   ("nothing to commit"). Then prove the ssh trigger that `vault-sync.ps1` uses on a refused push, from the main PC:
   `ssh ryzen-bots "schtasks /run /tn \"\MU\MU Vault Autocommit\""` must print `SUCCESS`. (That exact quoting could not be
   tested without ssh; if it fails, fix the `$defaultTrigger` line in `vault-sync.ps1` or pass `-TriggerCommand`.)
8. **Main PC, wire the remote:** `vault-sync.ps1 -Setup`. It adds `ryzen` = `ryzen-bots:C:/mu-hub/vault/mu-ventures-obsidian-wiki`,
   checks it with `git ls-remote`, then syncs (a no-op right after the cutover). Check both heads match again.
9. **Point the connector at it.** On Ryzen set `MU_WIKI_ROOT=C:\mu-hub\vault\mu-ventures-obsidian-wiki` (section 8.D of
   `docs/programme-20261001/RYZEN-HINDSIGHT.md`). Then reopen Obsidian on the main PC.

## Daily use

* Main PC: `powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\deploy\windows\vault\vault-sync.ps1` (add `-Message "..."`
  to name the commit). It commits your edits, takes whatever Ryzen has, and pushes. Run it after editing and before you rely on
  what the OS saved. If you use Obsidian Git, keep its auto-pull/auto-push off; this script is the one path.
* Ryzen: nothing. Every 10 minutes the task commits notes the connector wrote (`vault: OS memory notes (auto, <time>)`).
* A push is refused while Ryzen's work tree is dirty. The script then starts the autocommit task once over ssh, waits 25 s,
  and retries once. If that fails too it exits 3: nothing is lost, run it again in a few minutes.
* Exit codes: 0 synced, 1 error, 2 conflict, 3 push refused, 4 refused to start (not on `main`, unfinished rebase, `index.lock`,
  remote missing), 5 Ryzen unreachable (your commit is kept locally).

## Conflicts

When your edit and Ryzen's change touch the same lines of the same note, `vault-sync.ps1` prints
`CONFLICT` and the file names, runs `git rebase --abort`, and exits 2. It has pushed nothing and discarded nothing: your commit is
still on top of your branch and Ryzen is unchanged. To resolve, in the vault run `git fetch ryzen`, `git rebase ryzen/main`,
edit the marked files, `git add <file>`, `git rebase --continue`, then run `vault-sync.ps1` again. To give up instead:
`git rebase --abort` leaves everything as it was. A conflict only occurs when both sides edited the same note since the last sync,
so syncing often keeps it rare.

What the autocommit leaves alone (and logs by name): anything outside `wiki/`, non-markdown files, and any name matching the
connector's deny rules (`*secret*`, `*credential*`, `*password*`, `*transcript*`, `*bank-statement*`, `*.env*`, `README.md`,
`CLAUDE.md`, `AGENTS.md`, `templates/`, `raw/`, ...). Those stay uncommitted on Ryzen, which keeps Ryzen's work tree dirty, so
pushes are refused until someone commits or deletes them on Ryzen. The log line says `LEFT UNTOUCHED` when that happens.
The rules are copied from `scripts/memory/settings.ts`; the test fails if they drift, and runs the connector's own matcher
(through bun) over sample paths to compare. The autocommit is path-based only; the connector's content screening (`guard.ts`) still
runs when it indexes.

## Rollback

* Stop the sync, keep everything: on the main PC just stop running `vault-sync.ps1`. The main clone is a normal repo; `git remote remove ryzen`
  detaches it. Nothing on the main PC is ever reset or rewritten by these scripts.
* Remove the task on Ryzen: `Install-VaultAutocommit.ps1 -Remove` (only `\MU\MU Vault Autocommit`).
* Undo the Ryzen repo settings: `git config --local --unset receive.denyCurrentBranch` (pushes are refused again).
* Restore the old arrangement: the connector goes back to the main-PC path (`MU_WIKI_ROOT`), and the bundle from step 2 is a complete
  copy of the history at cutover. The Ryzen clone can be deleted without affecting the main PC.
* If the Ryzen vault ever gets ahead of the main PC and something looks wrong, the main PC's clone still has its own full history; nothing is
  deleted by a sync, and every state is a commit you can `git reflog` back to.

## Proposed addition to the `obsidian-wrap-up` skill (a proposal only; the skill file was not edited)

> **After writing.** Once the report page, `index.md` and `log.md` are written, run
> `powershell -NoProfile -ExecutionPolicy Bypass -File "<AgenticOS repo>\deploy\windows\vault\vault-sync.ps1"` and relay its last line
> to Usman. If it exits 2 (CONFLICT) or any other non-zero code, tell Usman which files or what it printed, and stop: do not
> resolve conflicts, do not retry in a loop, and do not run any other git command in the vault.

## Tests

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\vault\tests\Test-VaultSync.ps1` (about 80 s, exit code = number of failed checks).
It builds a "ryzen" non-bare repo with `updateInstead` and a "main" clone joined by a local-path remote, under `%TEMP%`, with a private git
config. It covers: clean sync both ways; a main edit plus a Ryzen autocommit of a different file; a same-line conflict (aborted, nothing
pushed, main's commit kept); Ryzen dirty (refused, one retry, then success); autocommit staging rules (including an accented and a spaced
file name, a rename, a deletion, a denied `secret` name, a non-wiki file, something staged by hand); `index.lock`, an unfinished merge
and the mutex; Initialize idempotence and refusals; installers under `-WhatIf`; and the rule parity with the connector. It registers no task
and never touches the real vault or Ryzen.
