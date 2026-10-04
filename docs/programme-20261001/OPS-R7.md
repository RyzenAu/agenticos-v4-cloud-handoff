# Round 7, worker G: desktop shell, pairing in the WebView, memory, backup and restore, operations

Worker G, model `claude-sonnet-5-5` (Claude Sonnet 5.5), 3 Oct 2026. Worktree `D:\AgenticOS-r7-g-ops-shell`, branch `r7/g-ops-shell-20261003`, base `491b8ee0`.
Nothing merged, deployed or messaged. No contact with Ryzen, 8081, the production Hindsight bank or the production vault. No `.env` value, token, cookie
or pairing code was read or recorded (the codes in the evidence are synthetic ones made by throwaway hubs). Evidence: `docs/programme-20261001/evidence/r7-ops/`.

Verdicts (honest):

| Journey | Verdict | One line |
|---|---|---|
| A. Desktop shell opens the Ryzen hub, no local hub or worktree | **Diagnosed, fixed in source and installer; owner-side step needed** | Source was already remote-safe. The failure came from an old 0.1.0 `app.exe` plus a config that still named a linked worktree. |
| B. Pairing recognised in the desktop WebView | **PASS on a synthetic server hub in a persistent Edge profile; real Serve identity not tested (no Ryzen contact)** | The page claimed "paired" and then offered to pair again. Fixed client side; honest waiting state, exact command, restart-proof. |
| H. Memory save, recall, correct, delete | **PASS 17/17, on a FAKE Hindsight** | No local engine was reachable, so the fake plays it. Proves the OS's own behaviour, not Hindsight's extraction. |
| L. Backup, verify, isolated restore, checked through the app | **PASS 14/14** | Online backup of a running hub, verify, tamper refused, restore into an empty folder, restored hub matches record for record. |
| Operations (deploy/windows) | **Guards added, 110/110 PowerShell checks** | Env-file append, SSH-session processes, public-Host probe. |

## A. The desktop shell "trying to launch a linked migration worktree"

**Where the installed app keeps its settings** (paths only; values read only for the non-secret keys `repoRoot`, `port`, `hubUrl`):

| What | Path |
|---|---|
| Settings the app reads | `C:\Users\Nebula PC\.jarvis-desktop\config.json` (keys `repoRoot`, `port`, `hubUrl`; written 2 Oct 17:58) |
| Installer logs and backups | `C:\Users\Nebula PC\.jarvis-desktop\install-*.log`, `...\backup\<stamp>\` |
| Installed app (real) | `C:\Users\Nebula PC\AppData\Local\Jarvis\app.exe` (0.2.1, 11,142,144 bytes per the install log) |
| **Stale second copy** | `C:\Users\Nebula PC\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Jarvis\app.exe` (0.1.0, 10,872,320 bytes, 27 Sep): what any process started from a Claude session sees as `...\Local\Jarvis\app.exe` |
| Local-mode server log | `%LOCALAPPDATA%\au.com.muventures.jarvis\logs\server.log`; WebView2 profile `...\EBWebView\` |
| Startup / Start Menu / Desktop shortcuts | `Jarvis.lnk` in each, all target the real `app.exe`. `Agentic OS.lnk` (Start Menu and Desktop) opens `chrome --app=http://localhost:8081`, a local hub that no longer runs. `Jarvis Chrome.lnk` runs a script in `source\repos\AgenticOS-v4` (the CDP profile; unrelated, left alone). |

**Diagnosis, at the failing boundary.** `config.json` holds `hubUrl` **and** `repoRoot = D:\AgenticOS-ryzen-migration` (a linked worktree): the installer was
run as `... -SkipBuild -HubUrl https://ryzen-pc.tailnet-name.ts.net:8443 -RepoRoot D:\AgenticOS-ryzen-migration` (install log, 2 Oct 17:58) and wrote `repoRoot`
even in remote mode. A 0.2.1 build ignores `repoRoot` in remote mode (cargo test pins it). The 0.1.0 build ignores `hubUrl`, runs local mode and checks the
checkout: `server.log` holds six lines of `couldn't start: D:\AgenticOS-ryzen-migration is a linked git worktree, not the main AgenticOS checkout` at
epoch 1790957383 to 1790957459 (3 Oct 02:09:43 to 02:10:59 AEST), in the *sandbox's* view of the log folder, i.e. written by a process started from a Claude
session, which runs the stale copy. That is "the desktop shell trying to launch a linked migration worktree". It never launched it (the repo check refused each
time), but it looped. The install log also shows the installer backed that stale copy up and listed it but did not retire it.

**Fixed in source** (`desktop/src-tauri`, `scripts/windows/install-jarvis-desktop.ps1`; cargo test 45/0):

- `remote.rs` regression test `remote_mode_ignores_a_stale_repo_root_that_is_a_linked_worktree`: a config with `repoRoot` = a worktree plus `hubUrl` plans `OpenHub`,
  runs no local server, holds no supervisor mutex even on 8081, scopes the WebView to the hub origin.
- `lib.rs` logs `repoRoot ... is a linked worktree; ignored in hub mode` so the log says why it is harmless.
- Installer, remote mode: writes `repoRoot` as `...\.jarvis-desktop\remote-mode-no-local-checkout` (a path that cannot exist), so an older build that ignores `hubUrl`
  fails closed with "does not exist" instead of starting a competing main-PC hub from a real checkout (removing the key would have made old builds default to
  `AgenticOS-v4` and start the main-PC hub: two writers). Retires package-cache `app.exe` copies by renaming them `app.exe.retired-<stamp>` after backing them up (never
  deleting). Lists, but does not change, other shortcuts that still open `localhost:<port>`.
- `scripts/devices/desktop-install-guards.test.ts` pins those three behaviours (the installer can only run on the owner's PC).

**Owner-side change (I did not touch the installed state; run these in a normal PowerShell window, not in a Claude session):**

```powershell
# 1. Retire the stale 0.1.0 copy the Claude sandbox sees (reversible: rename it back).
Rename-Item 'C:\Users\Nebula PC\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Jarvis\app.exe' 'app.exe.retired-20261003'
# 2. Make the config fail closed for any old build.
$p = "$env:USERPROFILE\.jarvis-desktop\config.json"; $j = Get-Content $p -Raw | ConvertFrom-Json
$j.repoRoot = "$env:USERPROFILE\.jarvis-desktop\remote-mode-no-local-checkout"
[IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
# 3. The two "Agentic OS" shortcuts open the dead local hub: delete them, or repoint them at the hub:
#    chrome.exe --app=https://ryzen-pc.tailnet-name.ts.net:8443
```

After the next release the installer does 1 and 2 itself. To confirm the running app is the remote 0.2.1 one: the window title reads
`Jarvis · hub ryzen-pc.tailnet-name.ts.net · shell 0.2.1`, and `Jarvis.log` says `REMOTE HUB mode`. I could not tell from here which exe pid 37072 is (this shell sees the sandbox copy of the folder).
Not rebuilt or reinstalled.

## B. Pairing in the desktop WebView

**Boundary found.** In the server role a bare Tailscale login mints a *pending* session. The identity layer correctly treats a pending cookie as no session at all
(`session: null`, a process principal), so `/me` reported "never paired". The panel then answered the click with the notice "This device is paired." **and kept
offering "Pair this device"**: the founder saw confirmed pairing "not recognised". Nothing in the page said a code was needed, and the only description of the
console route was in docs. Also, each redeem left the browser's old pending session in the list.

What was checked and is **not** the cause:

| Suspect | Finding |
|---|---|
| Cookie scope | `mu_session`: `Path=/`, host-only, `HttpOnly`, `SameSite=Strict`, `Secure` over the Serve HTTPS origin, `Max-Age` 30 days. The app's own `navigate()` is same-origin, so Strict still sends it. Pinned by a test. |
| WebView2 profile persistence | The app's default profile is persistent (only the `[test]` instance gets a separate folder). Persisted across a real browser restart on the same profile folder in the repro (cookie flushed on a clean quit). Caveat: Chromium writes new cookies to disk lazily (about 30 s); the installer's `Stop-Process -Force` or a killed session right after pairing can lose a fresh cookie. Quit from the tray (clean exit) or wait. |
| Page token | `/__token` returns the pairing-only token for a login with no principal and the person-bound token after; the panel refetches it after every pairing call. Works (repro). |
| Origin check | The Serve origin equals the Host the hub computes; same-origin passes. |
| Tailnet identity in WebView requests | By design it comes from Tailscale Serve stamping the request from this PC's node; the WebView on the main PC reaches Ryzen over the tailnet so it carries the signed-in Tailscale user. **Not tested here** (no Ryzen contact; the synthetic hub simulates Serve exactly as the existing test harness does). Real-world proof of 2 Oct: "browser over Tailscale: pending until a console code; confirmed session works" (RYZEN-MIGRATION.md section 7). |

**Fix** (`src/components/profile/**`, `scripts/devices/service.ts`; no pairing rule weakened):

- `GET /__devices/me` now also returns `waitingSession` (this browser's own pending Tailscale session, found from the cookies it presents; never a code) and `hubRole`.
- Profile panel: after a bare login it says "Signed in with Tailscale, but this browser is not confirmed yet" and shows **This browser needs a code** with the one next
  action: the exact command `bun scripts/identity/pair-code.ts --for <usman|mehroz> --port 8081` (in `C:\mu-hub\AgenticOS-v4` on the hub, with a Copy button), a code box and
  **Confirm this browser**. The same command is shown up front on a server hub, before anyone clicks. "Pair another device" is disabled while waiting. A confirmed
  browser of the same person gets an **Approve** button on the pending row (the existing `/sessions/approve`; Usman still cannot approve Mehroz's).
- `/pair/redeem` retires the pending session of the same person that the redeeming request itself presented, so it no longer lingers to be approved later.
- A bare Tailscale login stays unconfirmed; codes stay one-time, 10 minutes, console- or confirmed-device-issued; wrong codes share the existing lockout.

**Tests** (`scripts/devices/pairing-webview.test.tsx`, 6 tests): honest waiting state and the exact command; it survives an app restart (same cookie jar) and a wrong code does
not confirm it; a console code confirms once and only for the right person and retires the pending session; same-person approve works and the other founder is refused (403);
cookie attributes; command text. Real `/__devices` service in the server role, real panel.

**Reproduction.** `scripts/devices/pairing-harness/` (vite plus a middleware that dresses requests as Serve delivers them) is a synthetic server-role hub on loopback 8127,
data `D:\AgenticOS-r7-data\g`, with the real Profile panel; `drive.mjs` drives it in Edge with a persistent `--user-data-dir`, quitting and relaunching it between steps
(the closest thing to the WebView's constraints that runs here). Screenshots: `pairing-00-before-fix.png` (the old panel at `491b8ee0` against the same hub: claims paired, still
offers pairing; `pairing-before-log.txt`), then `pairing-02` to `-07` (up-front hint, waiting state, after restart still waiting, wrong code, confirmed, confirmed after restart;
`pairing-journey-log.txt`). The "before" copy of the old panel is kept at `D:\AgenticOS-r7-data\g\before-copy` (put `before/` and `before.html` back into the harness folder to re-run `--mode before`).

Proposals for the lead's files (gate pairing page wording, a pending-session field, and a first-navigation double-mint observation): `R7-G-PROPOSALS.md`.

## H. Memory (disposable, and what is fake)

`bun --no-env-file scripts/memory/r7-journey-h.ts` (17 checks, `memory-journey-result.json`). **PASS.** Real: this worktree's hub (quiet copy, scratch HOME so no real config
is visible), the Memory page, `/__memory`, approvals, vault writer and index, the Hindsight connector. **Fake: the Hindsight server.** Nothing listened on 8888, 8878, 8883 or
8893 (the main PC's Hindsight was stopped at the cutover and must not get a second writer), so `scripts/memory/testing/fake-hindsight.ts` plays it in-process: real REST shapes,
no language-model extraction. Bank `r7g-disposable-<stamp>-<run>`; vault = scratch copy of the synthetic mini-wiki; the script refuses anything else.

Through the page, in a real browser: saved a fact (it reached the engine in the disposable bank, listed with a source); found it by search and by the recall route; corrected it
(engine holds Wednesday, not Tuesday, recall agrees; screenshot `memory-05`); deleted it (the dialog shows the plan and removes nothing, `memory-06`; after Approve the engine document is
gone, recall no longer returns it, and the engine's call log shows a DELETE carrying the approval header, `memory-07`); saved a fact to the scratch vault (in one note, indexed);
a password sentence was refused and left nothing (`memory-09`).

Two things worth knowing: (1) deletion needs a confirmed human session ("a program asked for this, so a click can't approve it" appeared when the browser held a *pending* session);
the run installs a synthetic confirmed owner session after observing that the browser's first page load left it pending (P3 in the proposals). (2) Not proven: Hindsight's real
extraction and cost, the production bank, voice and Telegram approval. R5 (`MEMORY-ACCEPTANCE-R5.md`) did prove the real engine; this run re-proves the OS side of the integration.

## L. Backup, verify, isolated restore, checked through the app

`bun --no-env-file scripts/cloud/r7-journey-l.ts` (14 checks, `restore-journey-result.json`, exact commands and output in `restore-journey-commands.txt`). **PASS.** Synthetic data seeded
with `scripts/acceptance/seed-gate-hub.ts` (6 CRM leads, 7 jobs, 3 saved results, one Jarvis thread of 20 entries), all under `D:\AgenticOS-r7-data\g\restore\run-<id>`.

```
bun scripts/cloud/backup-cli.ts backup  --data-dir <run>\src-data --out <run>\backups     # while hub A (8127) is running: 25 files, 6 SQLite stores
bun scripts/cloud/backup-cli.ts verify  --from <run>\backups\backup-<stamp>               # verified: 25 files match the manifest
bun scripts/cloud/backup-cli.ts verify  --from <run>\tampered-backup                      # FAILED: .gate-seed.json: size differs   (exit 1)
bun scripts/cloud/backup-cli.ts restore --from <backup> --to <run>\not-empty              # refused: target not empty              (exit 1)
bun scripts/cloud/backup-cli.ts restore --from <backup> --to <run>\restored-data          # checksums verified; every store's rows match the manifest
```

Hub B (8137) was started on the restored copy; through the app (pages `/leads` and `/activity`, the saved-result page, and the same API calls the pages make, read from a browser
holding the owner's session): the same 6 leads and lead summary, the same 7 jobs (ids, states, titles), the same 3 saved results byte for byte (hashes), the same 20-entry conversation, and the
owner's browser session cookie still works on the restored hub (the session store is part of the backup). The checks refuse an empty read on both sides passing as "same".
Screenshots `restore-01` to `restore-06`. Caveats: the PC role was used (the server role admits only a console-proven owner or a Tailscale founder, so a loopback browser cannot be driven there);
Hindsight was off in both hubs, so a Hindsight dump is not part of this rehearsal (RYZEN-HINDSIGHT.md covers it).

## Operations (deploy/windows)

Found by reading the scripts against the last release's defects, then pinned in `deploy/windows/tests/Test-MuHubWindows.ps1` (110 checks, 0 failed with `-SkipSlow`):

| Defect | Guard added |
|---|---|
| `hub.env` had no final newline and `Add-Content` glued a setting onto the last line | `Set-MuEnvSetting` (adds, replaces or reports `unchanged`; keeps CRLF or LF; refuses a bad name or a line break; atomic; never returns or prints a value) and `Get-MuEnvFileProblems` (flags a missing final newline and a line that looks like two settings glued together, by name only). A test fails if any deploy script appends to an env file with `Add-Content`. No deploy script did; the lead's `release.ps1` lives outside the repo and can dot-source `mu-common.ps1` to use these. |
| A process started inside SSH dies with the session | `Test-MuSshSession` and `Start-MuDetached` (WMI `Win32_Process.Create`, so the child is outside the login's job; verified its parent is not the caller). `crm-rehearsal.ps1 start` now relaunches itself detached when run over SSH and waits for its pid file. The MU hub, backup, WSL and SearXNG tasks were already scheduled tasks (S4U), which survive. |
| The Funnel probe needed the public Host header | `Test-MuHttp -HostHeader <public name>`: connect to 127.0.0.1 but send the public Host. A plain loopback probe carries a loopback Host, which the hub treats as the owner at the PC, so it tests nothing about the public surface. Tested against a listener that only answers the public Host. |

Limitation: `Start-MuDetached` does not pass this process's environment (WMI's own is used), so the detached program must set what it needs; `crm-rehearsal.ps1` already does.

## Commands run for the done gate

See the end of this file's commit message and the final report: `bun test scripts/devices scripts/cloud scripts/memory src/components/profile` (1,517 pass, 9 skip, 0 fail when last run
before the final edits; re-run at the end), the two house-rule guards, `cargo test` (45/0), both typechecks, and the PowerShell suite above.

## Review round (independent Opus review of `814b1430`): fixes

| # | Finding | Fix | Test (fails without it) |
|---|---|---|---|
| 1 | Approve could not tell a script's pending browser from the founder's own | A short **match code** (`sha256("match|"+sessionId)`, 6 hex characters, `ABC-123`) is shown on the pending browser's own page only (round 2: not on the approver's row), with source (tailnet address#node) and created time. Approve opens a form ("Approve only if this matches the code on the new device") that needs the code typed. **The server checks it**: `/sessions/approve` returns 400 with no code, 403 with a wrong one, for a pending Tailscale browser of the approver's own person. | `pairing-webview.test.tsx`: server-side missing/blank/wrong refused, the script's session stays pending, a lower-case spaced right code approves; UI wrong code refused then right code approves; `server-role-review.test.ts` updated to pass the code |
| 2 | `Set-MuEnvSetting -Name api_key` replaced `API_KEY` | `-cmatch` | `Test-MuHubWindows.ps1` |
| 3 | `LASTKEY=valueNEW=1` not detected; `&ab_cd=2` flagged | case-sensitive detection after a lower-case/digit/quote with a value following, plus names defined elsewhere in the file; base64 padding and URLs are not flagged | same |
| 4 | Test cleanup killed whatever owned the detached pid; exit 1 | pid never added to cleanup; `Stop-MuProcessTree` swallows taskkill errors | same (`Stop-MuProcessTree` on a gone pid under `Stop`) |
| 5 | Values with ` #`, quotes or edge spaces did not round-trip | `Format-MuEnvValue` double-quotes exactly when the reader would otherwise change the value | round-trip of 9 awkward values, plus "rewrite is unchanged" |
| 6 | Non-atomic write, ACL lost | `[IO.File]::Replace` with a backup name (deleted afterwards, it would hold secrets), temp and backup removed in `finally`; a missing file uses Move | ACL identical before and after (inheritance cut plus a Users read grant); a locked file fails leaving the original and no leftovers |
| 7 | Retirement not gated; shortcut listing not recursive | retirement only when `$remoteOnly`; `-Recurse` over Start Menu, Desktop and Startup | `desktop-install-guards.test.ts` |
| 9 | Restore check compared leads by count and names | every field of every lead, hashed per row and keyed by id, and an empty read on either side fails | `r7-journey-l.ts` (15 checks, PASS) |

### Restore and sessions (one of `--keep-sessions` / `--fresh-sessions` is REQUIRED; no default)

A backup carries every login that worked on the machine it came from, so `backup-cli.ts restore` now **refuses to run unless you choose**: `--fresh-sessions` (test restores and any other machine)
signs everyone out of the copy: it rotates the session signing secret (`devices-secret`, so every old cookie stops verifying), marks every browser session revoked, and drops unused
pairing codes. Nothing else in the data is touched. `--keep-sessions` is the production rollback / same-machine disaster-recovery choice (people stay signed in). Neither flag, or both, is refused before anything is restored, so a rollback can never sign production out by accident. The production rollback instructions (`deploy/README.md`, `deploy/windows/mu-hub-backup.ps1`, `scripts/cloud/health.ts`, `deploy/windows/README.md`) now say `--keep-sessions`. Companion bearer tokens are not signed with that secret and are left alone (they can only reach a hub at the address they were paired to); the hub-trust marker
stays, so after a fresh restore the first browser at that PC starts *pending* and is confirmed with `bun scripts/identity/confirm-browser.ts` (or a console code on the server hub),
not trusted on first use. Tests: `scripts/cloud/restore-sessions.test.ts` (`--fresh-sessions` signs out and keeps other data; `--keep-sessions` keeps the cookie, secret and code; neither flag refused and nothing restored; both flags refused). The
restore journey now does both: a `--fresh-sessions` restore must reject the owner cookie, and a restore with neither flag is refused, and the hub rehearsal uses `--keep-sessions` to prove the same-machine path.
Deploy docs that restore for real (`deploy/windows/README.md`, `crm-rehearsal.ps1`) get the new default: the rehearsal copy is a different folder, so `crm-rehearsal.ps1` passes `--fresh-sessions` and the copy starts signed out, which is what you want for a rehearsal. The lead's restore rehearsal (`scripts/cloud/restore-rehearsal.ts`) passes `--keep-sessions` because it checks that a pairing code survives.

**Match code is shown only to the pending browser (review round 2):** the approver's row and form no longer show it and the sessions list never carries it for another session; it is returned only to the browser that owns the pending session (its own page, `/me` and its own pairing response). The server still answers 400 (missing) and 403 (wrong).

## Audit 2 fixes (items 4, 5, 6, 7, 11 with P11, 12, 14)

Candidate `253eaed5` merged, then `c74e2b25` (worker F's P11 note). Defects only. Tests: `scripts/devices/audit2-fixes.test.tsx`, `scripts/memory/sync-off.test.ts`, and two lines added to
`scripts/devices/pairing-webview.test.tsx`. Screenshots before and after at 1440 and 390: `evidence/r7-ops/audit-fixes/{before,after}-<page>-<width>.png` (synthetic hub on 8127, one browser at a
time; `scripts/cloud/r7-audit-shots.ts`; the "before" run uses a clean worktree of `253eaed5`). The synthetic hub has no Claude, Hermes or Codex sign-in and builds no tool registry, so those two
reads are fixtured in the browser, identically in both runs (Claude Code installed but signed out, Hermes installed, Codex signed in, and the tool rows the audit quoted).

| Item | What was wrong | What I did |
|---|---|---|
| 4 Claude Code page | A 2,700-word prompt printed in full with `localhost:8081/__hermes_missions/create`; "Ready" in green while System said sign-in needed | The prompt sits behind **Show the prompt** (and Copy prompt still copies the real text); when shown, the hub address and the missions file are in words (`promptForDisplay`); "Watching ~/.hermes/missions.json" is "Watching for the result". The state word and tone come from the one tool check (below). |
| 4 and 5 one status | Claude Code said Ready, System said Sign-in needed, Settings said Installed · not connected; Hermes had three wordings on three pages | `src/lib/tool-status.ts`: one read (`/__operator/models?snapshot=1`, the key System already uses) and one wording (`providerView`). Claude Code page, Hermes page and Settings › AI tools now take their word from it; System already did. Where there is no row the page says "Checking…", "Not checked yet" or "Check unavailable", the same everywhere; apps with no sign-in to check (VS Code, Terminal, Notion…) say "Found on this PC". Hermes' headline gives only the next step and its dot carries the status word; the install card shows only when the one source says it is not installed. |
| 6 Vault | "MU_MEMORY_WRITES is off", "Writing is off until acceptance", Sync now twice and a 500 | Plain words ("Saving to shared memory is switched off on this hub"); one Sync now, disabled with that reason while saving is off; the second one in the empty state is gone; `/__memory/sync` answers a 409 refusal with the same sentence (and a 503 sentence if it genuinely fails), never a 500 "Memory is unavailable". |
| 7 Connections | "Connect Stripe" and "Add a YouTube API key in Settings" went nowhere; Mercury headed the Money list | Both say plainly that keys are added on the hub PC, not in this app ("Create a key in Stripe" is the link label); the server's own messages no longer name a config file; the Mercury row shows only when Codex access or a saved snapshot exists, so Stripe leads. |
| 11 System tool rows and P11 | `TYPESAFE_API_KEY`, `~/.config/agentic-os.env`, `browser.cdp_url`, `docs/FILM-JARVIS.md` | `toolRowText`: a human sentence ("Needs its key added on the hub PC.", "Needs setting up on the hub PC.", "Its last check failed."); any text that names a variable, path, doc, CDP key or command moves into an expandable **Technical detail**, verbatim. AI usage prints `keyLabel` ("OpenRouter key", "Twilio account", "Signed in") and no variable name; the Claude sign-in message no longer names `~/.claude/.credentials.json`. |
| 12 Devices and people | Referred to a "Profile" page that does not exist; an unconfirmed browser listed finance and device control and offered codes | Every mention now says System › Devices and people (panel, server messages, the gate's messages); for an unconfirmed browser "Can use" reads "Shared business only, until this browser is confirmed", "Pair another device" is not offered, and a confirmed browser's list reads in words ("shared memory, Usman's memory, Mehroz's memory") instead of ids. The doubled title and Close button belong to the System section wrapper (worker F). |
| 14 Settings › Jarvis | Save answered "Keep 1–20 people." and the page said "Unsaved changes" | The page checks before it sends and says what to do ("Add at least one person, with the role owner."), and every refusal ends "Nothing was saved." with the status line "Not saved". The server already validated all three parts before writing any; a test now pins that a valid greeting sent with an empty people list changes nothing. |

Not mine and left alone: `scripts/memory/handoff-screen.test.ts` fails on the candidate itself (worker D's "Ran on: … Claude Max 2" wording against a test that expects `claude:max-2`); I changed
no file it covers.
