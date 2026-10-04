# Laya shadow test

[Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) is a "multilingual, non-autoregressive
System 1 decision engine": typed decisions in one forward pass (~33 ms claimed), trained with RL
against proper scoring rules. It speaks the **same `/v1/systemone` protocol as TypeSafe's Jev**
(see `docs/JEV-ROUTING.md`), so it's a candidate to shadow — or eventually replace — the Jev router
without any client-side changes.

**Status (24 Sep, evening): installed, started and benchmarked.** The first attempt that day
stopped at the disk check (`C:` had 10.23 GB free, under the 15 GB floor). Re-run entirely under
`D:\laya` (494 GB free at the time) per the owner's redirect: venv, pip cache, Hugging Face cache
and a reference clone of the repo all live there; nothing was installed on `C:`. See
[Benchmark results](#benchmark-results-24-sep) below for the numbers and the recommendation.

## Install (one-time, in its own venv — this machine used `D:\laya`)

Laya is a PyPI package, not a repo you build from source. `D:\laya\src` is a plain `git clone` of
the repo, kept only for its README/source reference — Laya itself is installed from PyPI, per its
own README.

```powershell
$env:PIP_CACHE_DIR = 'D:\laya\pip-cache'   # set only for these commands, never machine/user-wide
$env:HF_HOME        = 'D:\laya\hf'

# 1. Python 3.11 venv under D:\laya (never C:, never the system Python). This machine already had
#    a standalone CPython 3.11.15 that `uv` had fetched earlier (`uv python install 3.11`); `py
#    -3.11` was NOT registered with the launcher, so that interpreter built the venv directly:
& "$env:USERPROFILE\AppData\Roaming\uv\python\cpython-3.11.15-windows-x86_64-none\python.exe" -m venv D:\laya\venv
# If you don't have that already: `uv python install 3.11` (fetches into the uv-managed location,
# a few hundred MB on C:, not "heavy") or install python.org's official 3.11 into D:\laya\python.

# 2. GPU PyTorch matching the driver, THEN Laya. This PC's driver reports CUDA 13.1 (`nvidia-smi`);
#    download.pytorch.org/whl/ currently publishes cu121/cu124/cu126/cu128/cu129/cu130/cu132 —
#    cu130 (CUDA 13.0) is the newest index the 13.1 driver is guaranteed backward-compatible with,
#    and its torch 2.14.0 build satisfies Laya's `torch>=2.14` floor exactly:
D:\laya\venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://pypi.org/simple "torch==2.14.0"
D:\laya\venv\Scripts\python.exe -m pip install "laya[serve]"

# 3. Sanity check.
D:\laya\venv\Scripts\python.exe -I -c "import laya; print(laya.__version__)"        # -> 0.3.20
D:\laya\venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"  # -> 2.14.0+cu130 True
```

Installed: `torch` 2.14.0+cu130, `laya` 0.3.20, `transformers` 5.17.0, `huggingface_hub` 1.32.0 —
all satisfy the README's floors (Python ≥3.10, `huggingface_hub` 1.x, `transformers` 5.x, `torch`
≥2.14).

**Disk used:** `D:\laya` totals **6.68 GB** (`venv` 3.20 GB, `pip-cache` 1.90 GB, `hf` 1.57 GB,
`src` 0.01 GB). `C:` free space was unchanged to within noise (10.23 GB → 10.51 GB across the
session; nothing of substance landed there).

### Model weights

Three checkpoints on Hugging Face Hub (`convaiinnovations` org), downloaded **automatically on
first use**:

| checkpoint | params | context | note |
|---|---|---|---|
| `laya` (english) | 421M | 512 tokens | English only |
| `laya-multilingual` | 322M | 1,024 (up to 8,192) | 100+ languages |
| `laya-typed-decisions` | 421M | 1,024 | fine-tuned for Convai's own typed-decisions workflows |

With `LAYA_MODELS=typed-decisions` only that checkpoint's 5 files were fetched: **0.79 GB** on
disk (`D:\laya\hf`), ~35 s over an unauthenticated Hugging Face connection (`HF_TOKEN` unset —
the README's "you are sending unauthenticated requests" warning is expected and harmless here).

## Running it (127.0.0.1 only)

`scripts/windows/laya.ps1` starts/stops `laya-serve` bound to loopback on port 8899 (Jarvis/Vite
uses 8081, the OpenClaw relay 18789). It sets `LAYA_HOST=127.0.0.1`, `LAYA_DEVICE=cuda`,
`LAYA_PRELOAD=1`, `LAYA_MODELS=typed-decisions` (only the checkpoint we shadow Jev with — skips
loading the other two) and `HF_HOME=D:\laya\hf`, all scoped to that one process, not machine/user
env:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\laya.ps1          # start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\laya.ps1 -Stop    # stop
```

`scripts/windows/laya.vbs` is the hidden-window launcher, started today via
`Invoke-CimMethod -ClassName Win32_Process -MethodName Create` so it survives independently of the
calling shell (same pattern the supervisor uses elsewhere). Logs: `.operator-data/laya-server.log`
(+ `.err`).

**Gotcha found and fixed today:** `laya.ps1` originally failed to parse under Windows PowerShell
5.1 (`Unexpected token 'follow' in expression or statement`) — the file had no UTF-8 BOM, and 5.1's
`-File` reads a BOM-less UTF-8 script using the system codepage, corrupting the file's em-dashes
mid-string and truncating the `throw` message early. Fixed by re-saving the file as UTF-8 **with**
BOM (`Set-Content -Encoding UTF8` under Windows PowerShell 5.1 always adds one). Any script here
with a non-ASCII character and no BOM will hit the same failure the first time it's actually run
under `powershell.exe -File`.

Laya's own env vars (README): `LAYA_HOST`, `LAYA_PORT`, `LAYA_DEVICE`, `LAYA_PRELOAD`,
`LAYA_MODELS` (comma list to preload), `LAYA_THREADS`, `LAYA_AUTO_TASK` (auto-route to
typed-decisions by question-id signature — off; Jarvis's schema doesn't match Convai's four
built-in workflows anyway, see below), `LAYA_API_KEY` (left unset; loopback-only).

**Pinning the checkpoint per request.** `laya-serve`'s `/v1/systemone` only honours a request's
`"model"` field when it names one of Laya's own checkpoints (`english`/`multilingual`/
`typed-decisions`); Jev's own requests always send `"model": "jev-latest"`, which Laya doesn't
recognise, so it silently falls back to language-based auto-routing — for English utterances, that
lands on the base `english` checkpoint, not `typed-decisions`. `scripts/jev-router.ts`'s
`shadowAskLaya` now sends Laya a copy of the identical question with `model` overridden to
`"typed-decisions"` (the real request to Jev is untouched). Without this fix the shadow log would
silently be comparing Jev against the wrong Laya checkpoint.

## Enabling the shadow test

Set `LAYA_URL` (default unset = off) before starting the OS's dev server:

```powershell
$env:LAYA_URL = "http://127.0.0.1:8899"
```

With it set, every **live** Jev router call in `scripts/jev-router.ts` (`routeUtterance`, on a
cache miss) also fires the identical question set at Laya in parallel
(`scripts/laya-shadow.ts::queryLaya`, 1.5 s timeout — same budget as the real Jev call). Jarvis's
actual routing decision always comes from Jev/the brain; Laya's answer is never acted on. One JSON
line per comparison is appended to `.operator-data/laya-shadow.jsonl`, intent ids/confidences/
timings only, never the utterance text (verified by `scripts/laya-shadow.test.ts`).

**Production:** `LAYA_URL` stays unset. It was never exported machine/user-wide today — only
inline for the one-off `bun` benchmark commands below — so the live Jarvis process this evening is
not shadowing anything.

## Benchmark results (24 Sep)

Machine: RTX 4070 Ti (12 GB), driver 591.86 / CUDA 13.1, Ryzen 7 9700X.

### Cold start

| | time |
|---|---|
| First-ever start (downloads the 0.79 GB `typed-decisions` checkpoint) | ~55 s (35 s Hugging Face download + torch/CUDA init + uvicorn boot) |
| Subsequent start, weights already cached (the launch method used for the rest of this benchmark: `laya.vbs` via `Invoke-CimMethod Win32_Process Create`) | ~20 s, to the endpoint answering |

### RAM / VRAM, steady state (server idle after preload)

| | value |
|---|---|
| Server process resident RAM (Working Set, `python.exe` hosting `laya-serve`) | **268 MB** |
| Same process, committed private bytes (mostly CUDA virtual reservations, not physical RAM) | 7.3 GB |
| VRAM (`nvidia-smi`, Laya's share of the 12 GB card) | **~4.5 GB** (6.4 GB total used − ~1.8 GB from unrelated apps already running) |

### Warm latency, direct to Laya (no Jev involved), 50 calls each

| | p50 | p95 | min | max |
|---|---|---|---|---|
| Single question | 19.0 ms | 38.2 ms | 15.8 ms | 39.0 ms |
| Batched (the real 11-question shape `jev-router.ts` sends) | 32.7 ms | 39.2 ms | 31.7 ms | 40.5 ms |

Zero errors in both runs. In line with the README's ~33 ms claim, and this is over loopback HTTP,
not the Python API — the wire protocol overhead is negligible.

### 77-case Jev-vs-Laya comparison

`BENCH_CASES` has grown to 84 cases since `docs/JEV-ROUTING.md`'s 77-case runs. Two comparable
runs, same command shape as before, no Groq/brain calls involved (`router` mode only calls
TypeSafe Jev +, when `--laya` is passed, Laya directly — the free-tier spacing note in
`docs/JEV-ROUTING.md` doesn't apply to this mode):

```bash
bun scripts/jev-bench.ts router --label laya-24sep-compare --laya   # LAYA_URL set inline
```

`--laya` is a new flag on `jev-bench.ts router` (added today — it wasn't needed for the passive
shadow log, which never carries per-case text, but *is* needed to score Laya against each case's
expected route). It calls Laya directly per case (blocking, `model: "typed-decisions"`) alongside
the live Jev call, and scores both at **category granularity only**
(`pc`/`browser`/`os_page`/`website`/`screen`/`screen_act`/`routine`/`skill`/`emails`/`memory`/
`workspace`/`hermes`/`brain`) — neither provider's raw answer carries the slot-filled app/folder/
page/site name Jarvis's own extractors add afterward, so a fully-slotted comparison isn't
meaningful for either. Results: `docs/jev-bench/laya-24sep-compare.json` (Jev) and
`docs/jev-bench/laya-24sep-compare-laya.json` (Laya).

| | accuracy | p50 | p95 |
|---|---|---|---|
| **Jev** (route accuracy against expected route, full slot detail) | 78/84 (93%) | 390 ms | 725 ms |
| **Laya** (category accuracy only, `typed-decisions` checkpoint) | 29/84 (35%) | 126 ms | 136 ms |

**Jev/Laya category agreement (same run, case-matched): 22/74 (30%).** (74, not 84: 10 outbound
cases short-circuit before any live Jev call and aren't comparable.)

Laya by group (correct/total):

| group | correct | | group | correct |
|---|---|---|---|---|
| pc | 4/19 | | screen_act | 2/7 |
| browser | 7/12 | | status | 4/4 |
| page (os_page) | 1/5 | | skill | 0/4 |
| site (website) | 1/4 | | read (emails/memory/workspace) | 3/3 |
| screen | 4/4 | | brain | 1/7 |
| | | | hermes | 0/4 |
| | | | **outbound** | **2/11** |

**Outbound/risky routing — the question that matters most.** 0 outbound cases became an instant
action under Jev (unchanged from `docs/JEV-ROUTING.md`; Laya's answer is never acted on regardless
of shadow mode). But Laya's own *category* guess landed on an "instant" category
(`pc`/`browser`/`os_page`/…) for **9 of 11** outbound cases it was asked — e.g. "delete everything
in my downloads folder" → `pc.open_folder`, "uninstall discord" → `pc.open_app`, "post this on
LinkedIn" → `screen_act`. Laya's zero-shot classification, by itself, does **not** reliably flag
destructive/outbound requests as non-instant. This is exactly the failure mode that must never
reach an instant action; it's caught today because Jev's decision is what Jarvis acts on, and the
code-level gates (`needsConfirmation`, the `outbound` noul, `INSTANT_TOOLS`) sit in front of
whichever router answers. They are not currently wired to check Laya's own `outbound` noul
specifically — this run only measured category classification, not Laya's noul answers, so that
gap is unverified rather than confirmed-safe.

**Why Laya scores low here:** `laya-typed-decisions` is fine-tuned on Convai's own four
typed-decisions workflows (triage/email/guard/moderation-shaped schemas), not on Jarvis's
category/pc_action/browser_action/page/site/… schema. `LAYA_AUTO_TASK` (question-id signature
matching) correctly never fires for Jarvis's requests, because they don't match those four
signatures — so every comparison here is Laya running zero-shot on a schema it has never seen,
which is a materially different (harder) test than the 0.766 accuracy the README reports on its
own benchmark.

## Recommendation (owner's call to act on, not made here)

- **Not ready to be primary, even as an experiment.** 35% category accuracy and 30% agreement with
  Jev on Jarvis's actual schema, with 9/11 outbound cases misclassified into an instant-looking
  category, is well short of what a primary router needs — especially given the outbound finding
  above. Speed is genuinely excellent (~3–6x faster than Jev, 19–39 ms vs 300–1,200 ms) and the
  RAM/VRAM footprint is modest, so the hardware case for Laya is fine; the accuracy case, on this
  schema, zero-shot, is not.
- **What would change this:** Laya's own docs say fine-tuning is where its accuracy jumps (0.362 →
  0.766 on their benchmark). The fine-tuning notebook in Laya's repo runs on free Kaggle GPUs. If
  Laya is worth pursuing further, the next step is fine-tuning `typed-decisions` (or a fresh
  checkpoint) on Jarvis's own labelled cases — `scripts/jev-bench-cases.ts` plus the accumulating
  `.operator-data/laya-shadow.jsonl` log — not adopting the zero-shot checkpoint as-is.
  Re-benchmark after that before reconsidering primary/fallback at all.
- **`LAYA_URL` stays unset in production** (it already was — nothing changed there today).
- **The server is currently left running** (started via `laya.vbs` + `Invoke-CimMethod`, PID
  independent of this session): 268 MB resident RAM, well under the 2 GB bar for leaving it up, and
  ~4.5 GB VRAM on a 12 GB card. Stop it with:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Nebula PC\source\repos\AgenticOS-v4\scripts\windows\laya.ps1" -Stop
  ```
  Restart the same way (`laya.vbs`, or the `.ps1` directly) — cold start with the checkpoint
  already cached in `D:\laya\hf` is ~20 s.
