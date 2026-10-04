# Disk report (round 6, Builder D, 2 Oct 2026)

> **REPORT ONLY. Nothing here has been run. Every command needs the owner's explicit yes, one item at a time.** Nothing was deleted, moved or changed.

**Why it matters: C: has 15.5 GB free of 465 GB (D: has 270 GB free of 931 GB).** Everything big that can safely go from C: is below.

Method: sizes come from `robocopy <dir> NULL /L /E /XJ /SL /NFL /NDL /BYTES` (list-only, so junctions and symlinks are excluded and nothing is opened), run from
`D:\AgenticOS-r6-perf-tmp\size.ps1` on 364 named paths plus the children of the scratch folders. Only names and sizes were read: no credential file, private dataset,
audio or transcript was opened. Brooke's website (Dot's) and the Bianca site were not sized or listed. "Contained" means the worktree's branch is an ancestor of the live
commit `228bd232` (`git merge-base --is-ancestor`), and "clean" means `git status --porcelain --no-optional-locks` printed nothing, so removing the worktree directory loses no commit and no edit.
Branches are never deleted by `git worktree remove`.

Classes: **owner file**, **active worktree**, **rebuildable cache**, **disposable programme temp**.

## Top items

| # | Item | GB | Where | Class | Command that would do it (not run) | Recovers |
|---|---|---|---|---|---|---|
| 1 | `itqan-r1-relocated` (the recitation research: model and data) | 161.6 | D: | owner file | none; leave | 0 |
| 2 | `Relocated-Downloads`, `Clips`, `VoiceStudio`, `WSL` (VHDX), `Documents` | 62.0, 36.9, 18.4, 9.4, 50.0 (C:) | D:, C: | owner file | none; sizes only | 0 |
| 3 | `AgenticOS-v4-wt\*` worktrees whose branch tip is an ancestor of the live commit `228bd232` and whose tree is clean (explicit list in the appendix; most are on C:) | 24.8 | C: | candidate for the owner: finished work (branches stay in git). `git branch --merged jarvis-voice` matches none of them, so the test used is "ancestor of live" | for each path in the appendix only: `git -C "<wt>" status --porcelain` must print nothing, then `cmd /c rmdir "<wt>\node_modules"` (removes only the link) and `git -C "C:\Users\Nebula PC\source\repos\AgenticOS-v4" worktree remove "<wt>"` | up to 24.8 GB on C: |
| 4 | `AppData\Local\Temp` (98,875 entries; `node-compile-cache` 3.2, `claude` 2.7, diagnostics 0.9, scoped dirs, synthetic homes) | 21.8 | C: | rebuildable cache / temp, but a live session keeps files here | only top-level entries NOT named `claude*` or `codex*` that contain no file written in the last 7 days. First print the list: `Get-ChildItem "$env:TEMP" -Force \| Where-Object { $_.Name -notmatch '^(claude\|codex)' -and $_.LastWriteTime -lt (Get-Date).AddDays(-7) -and -not (Get-ChildItem $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue \| Where-Object LastWriteTime -gt (Get-Date).AddDays(-7) \| Select-Object -First 1) } \| Select-Object -ExpandProperty FullName`; only after the owner has read it, `cmd /c rd /s /q "<each path>"` | not measured; likely 10 to 15 GB on C: |
| 5 | `D:\temp-archive-20260929\p` (an archive made on 29 Sep; its contents were not opened and nobody has said what it is) | 31.0 (33.3 with siblings) | D: | unknown | none. Owner to inspect; no action proposed | 0 |
| 6 | `D:\AgenticOS-*` worktrees: those in the appendix only (clean, branch an ancestor of live). Excluded: `D:\AgenticOS-prog-int`, every `AgenticOS-r6-*` worktree (including this one), `AgenticOS-prog-os` (the unmerged OpenShell pilot), and every worktree with unmerged commits or a dirty tree. Each has its own 0.7 GB `node_modules` | about 24 | D: | candidate for the owner | per path in the appendix: `git -C "<wt>" status --porcelain` must be empty, then `git -C "C:\Users\Nebula PC\source\repos\AgenticOS-v4" worktree remove "<wt>"` | up to about 24 GB on D: |
| 7 | `D:\agent-scratch` (144 builder folders `t8`, `s1`, `review-*`, `l*`, ...) | 25.3 | D: | disposable programme temp | `cmd /c rd /s /q "D:\agent-scratch"` | 25.3 GB on D: |
| 8 | `uv` cache | 7.1 | C: | rebuildable cache | `uv cache clean` | 7.1 GB on C: |
| 9 | `.bun\install` (bun's package cache) | 6.2 | C: | rebuildable cache | `bun pm cache rm` | 6.2 GB on C: (re-downloaded on the next install) |
| 10 | `.cache\huggingface` 6.2, `codex-runtimes` 2.5, `whisper` 1.6 | 10.3 | C: | rebuildable cache (model downloads; the owner may be using them) | move: set `HF_HOME=D:\hf-cache`, then `robocopy "C:\Users\Nebula PC\.cache\huggingface" "D:\hf-cache" /MOVE /E` | 6.2 GB on C: |

Further, smaller: `D:\prog-scratch` 6.9 (307 subfolders: `r4`, `r5`, `clean-r3`, `clean-r4`, `clean-a9407aa` are disposable clean copies of about 1.0 GB each);
four old clean copies `D:\AgenticOS-{dental,detail,editable,preview}-clean-*` 0.835 each (3.3 total, disposable: `cmd /c rd /s /q "D:\<name>"`); `D:\tmp` 2.7 (`jev-repos` 1.3);
`Roaming\npm` 3.1 (npm global modules: owner decision); `D:\MU-Receptionist-wt*` 5.3 across 30 worktrees (the Receptionist repo, not checked here);
`D:\MU-AIOS` 4.5, `D:\laya` 6.7, `D:\meeting-mode` 5.9 (features; owner files); `D:\hindsight` 2.7 (memory; never touch).

## Active worktrees (keep)

Not contained in live, or dirty: the 6 round-6 branches `r6/{integration,coding,perf,ui,bots}-20261002` and `prog/os-openshell-20261001` (about 1.0 GB each on D:), and 15 older
`AgenticOS-v4-wt` entries (4.5 GB) holding unmerged work (`f/f1-flows-20260929` has 21 uncommitted files; `coding/in-agentic-os-*` jobs; `codex/b2-security-review-20260928`, `codex/b1-jobs-route-20260928`).
`AgenticOS-v4` itself (the live hub, 9.4 GB with its `node_modules`) is the canonical checkout.

## Totals

| If you do | Frees |
|---|---|
| Items 3, 4, 8, 9 (C: only), if the owner says yes to each | at most about 55 GB on C: |
| Items 6, 7 and the clean copies (D:), if the owner says yes to each | at most about 55 GB on D: |

Before removing any worktree: `git -C "<wt>" status --porcelain` must print nothing, and 98 of the 100 `AgenticOS-v4-wt` entries have `node_modules` as a link, so always remove the link with `rmdir`
(not a recursive delete) first. One entry (`codex-b2-security`) has a real 0.66 GB `node_modules`.
My own temporary files (`D:\AgenticOS-r6-perf`, `-data`, `-home`, `-tmp`, five `D:\AgenticOS-r6-perf-*` logs and `D:\stop8154.ps1`) are disposable once this branch is merged.

## Appendix: the worktrees items 3 and 6 refer to

Generated, not hand-typed: `git worktree list --porcelain` for `AgenticOS-v4`, kept when `git merge-base --is-ancestor <branch> 228bd232` is true and `git status --porcelain --no-optional-locks` printed nothing,
then excluded: `AgenticOS-prog-int`, every `r6/*` branch and `AgenticOS-r6-*` path, `prog/os-openshell-20261001`, the live checkout `AgenticOS-v4`, and anything outside `AgenticOS-v4-wt` and the `D:\AgenticOS-*` / `D:\MU-AgenticOS-*` folders.
`git branch --merged jarvis-voice` was also run: it matches none of these (the live code is not on that branch), so "ancestor of live" is the criterion and the owner should confirm it.
Re-run the checks immediately before removing any of them: a worktree can change after this list was made.

```
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\coding-c1c2  [f/coding-c1c2-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\crm2  [track-a/crm2]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\d-hindsight  [d/hindsight-ops-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\d-memory  [d/memory-connector-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\d1  [f/d1-receptionist-calm-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\deflake  [f/deflake-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\f-econ  [f/economics-stress-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\f-package-id  [f/deal-exgst-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\gaps  [track-a/gaps]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\jarvis  [track-a/jarvis]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\jarvis-p0  [jarvis/control-p0-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\jfix  [f/jfix-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\l10  [f/l10-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\leadq  [track-a/leadq]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\m1  [f/m1-minors-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\native-perf  [f/native-perf-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\ops  [track-a/ops]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\p1  [f/p1-polish-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\places-compliance  [leads/places-compliance-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\receptionist  [track-a/receptionist]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\rx-feed  [f/rx-feed-view-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\s1-security  [f/s1-security-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\s1b  [f/s1b-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\s1c  [f/s1c-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\s3-api  [f/s3-api-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\safety-r3  [f/safety-r8-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\sales  [track-a/sales]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\sales-catalogue  [f/sales-catalogue-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\sales-pack  [sales/receptionist-pack-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-b1  [f/int-b1-c1c2-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-b2  [f/stage-b2-approvals-jobs-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-d  [f/stage-d-memory-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-e1  [f/stage-e1-router-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-e2  [f/stage-e2-migrate-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\stage-f-finance  [f/finance-csv-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t1-experience  [f/t1-experience-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t2-jarvis  [f/t2c-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t3-coding  [f/t3-coding-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t3c  [f/t3c-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t3d  [f/t3d-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t3e  [f/t3e-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t5-finance  [f/t5-finance-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t5c  [f/t5c-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t6-memory  [f/t6-memory-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t6b  [f/t6b-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t6c  [f/t6c-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t8-reliability  [f/t8-reliability-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t8b  [f/t8b-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\t8c  [f/t8c-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\ui-call-queue  [ui/call-queue-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\ui-truth  [f/ui-truth-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\ui-truth-2  [f/ui-truth-2-20260928]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-devices  [w2/devices-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-finance  [w2/finance-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-int-finance  [w2/int-finance-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-int-prices  [w2/int-prices-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-int-rx  [w2/int-rx-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-int-shell  [w2/int-shell-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-integration  [w2/integration-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-leads  [w2/leads-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-memory  [w2/memory-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-native  [w2/native-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-os-shell  [w2/os-shell-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-rx-dash  [w2/rx-dash-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\w2-sales2  [w2/sales2-20260927]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wa  [f/wa-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wb  [f/wb-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wc  [f/wc-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wd  [f/wd-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\we  [f/we-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wf  [f/wf-20260929]
C:\Users\Nebula PC\source\repos\AgenticOS-v4-wt\wg  [f/wg-shell-20260929]
D:\AgenticOS-coding-resume-repair  [codex/coding-resume-repair-20261001]
D:\AgenticOS-prog-a-cloud  [prog/a-cloud-20261001]
D:\AgenticOS-prog-b-worker  [prog/b-worker-20261001]
D:\AgenticOS-prog-c-ui  [prog/c-ui-20261001]
D:\AgenticOS-prog-cm  [prog/cm-context-20261001]
D:\AgenticOS-prog-d-coding  [prog/d-coding-20261001]
D:\AgenticOS-prog-e2-sales  [prog/e2-sales-20261001]
D:\AgenticOS-prog-f-computers  [prog/f-computers-20261001]
D:\AgenticOS-prog-fix-od  [prog/fix-od-20261001]
D:\AgenticOS-prog-fix-r3  [prog/fix-r3-20261001]
D:\AgenticOS-prog-g-voice  [prog/g-voice-20261001]
D:\AgenticOS-prog-k-skills  [prog/k-skills-20261001]
D:\AgenticOS-prog-s-stream  [prog/s-stream-20261001]
D:\AgenticOS-prog-t  [prog/t-triggers-20261001]
D:\AgenticOS-r4-cloud  [r4/cloud-20261001]
D:\AgenticOS-r4-coding-jobs  [r4/coding-jobs-20261001]
D:\AgenticOS-r4-coding-ui  [r4/coding-ui-20261001]
D:\AgenticOS-r4-computers  [r4/computers-20261001]
D:\AgenticOS-r4-memrx  [r4/memrx-20261001]
D:\AgenticOS-r5-conv  [r5/conv-loop-20261001]
D:\AgenticOS-r5-creative  [r5/creative-20261002]
D:\AgenticOS-r5-lan-bots  [r5/computers-ui-20261002]
D:\AgenticOS-r5-memrx  [r5/memrx-20261002]
D:\AgenticOS-r5-ui  [r5/ui-20261002]
D:\AgenticOS-v44-adoption  [codex/jarvis-command-followthrough]
D:\MU-AgenticOS-cloud-integration  [integration/cloud-ux-20260929]
```
