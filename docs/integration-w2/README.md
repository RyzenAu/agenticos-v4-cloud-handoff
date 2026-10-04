# Wave-2 integration evidence (Stage A), 27–28 Sep 2026

Branch `w2/integration-20260927` (evidence re-captured at 517fd7a). It contains `jarvis-voice` up to 0433a6d, the seven wave-2 feature branches, os-shell (final 6eb916d) and four Stage A fix branches.
Status: **integrated locally**. It has not been released to the live OS.

## How this was captured

- **Server:** a quiet copy on 127.0.0.1:4310, with `AGENTIC_OS_NO_BACKGROUND=1` and `ARGENTIC_PREVIEW=1` (a private Vite cache in `.preview-cache/`).
- **Data:** synthetic only. USERPROFILE/HOME point at an empty temp folder, so no real keys or stores are read. `MU_WIKI_ROOT` is a temp copy of `scripts/memory/fixtures/mini-wiki`, and memory writes are off.
- **Harness:** headless Chrome (playwright-core 1.63) and axe-core 4.x (wcag2a/aa and wcag21a/aa rules).
- **Masking:** the synthetic home is not complete isolation. The copy could still read real AI-plan usage (account names, plan tier, usage %) through credentials under `%LOCALAPPDATA%` (Codex/Hermes). Those tiles and the System "Plan limits" block are blurred in every screenshot.
- **Screenshots:** everything else shown is synthetic, empty, public (site uptime) or committed repo content (approvals list).

## Destinations: direct navigation at 1440×900 and 390×844 (`metrics.json`)

| Page | h1 | axe serious/critical | horizontal overflow | console errors |
|---|---|---|---|---|
| /today, /jarvis, /receptionist, /work, /memory, /memory/vault, /finance, /studio, /system | all visible | 0 | 0 px | 0 |

That is 18 of 18 page loads clean. Screenshots are `<page>-1440.png` and `<page>-390.png`.

The Receptionist page shows the honest "Couldn't read / Unknown" states. That is because the synthetic home has no agency-feed token, so there are no green zeros.

## Interactions

- **Sidebar click-through:** all 8 destinations reached, each with a new h1.
- **Phone drawer:** opens, and choosing Finance navigates there (`drawer-open-390.png`, `drawer-to-finance-390.png`).
- **Memory vault:** a search on synthetic facts works (`memory-vault-search-1440.png`).
- **Unknown URL:** renders the 404 page. The single console error is the 404 response itself.
- **Inspector:** opens and closes (`inspector-open-1440.png`). In the long click-through session the first click did not open it and the second did. A direct repro (9 destinations, immediate click) opened on the first click every time.
  - Open finding: probably a header layout shift when the deferred overlays mount.
- **Forced states** (`today-loading-and-errors-1440.png`, `today-errors-settled-1440.png`):
  - Setup: approvals held 6 s, call queue answering HTTP 500, receptionist aborted.
  - Result: skeletons render while loading. The failed sources say they couldn't be read and never show zero or success.

## Performance: same harness, same synthetic home (`perf/*.json`)

The baseline is b9aa233 (jarvis-voice when this branch started). Integrated is the final branch head. Each figure is the median of 3 fresh-context loads.

| Metric | Baseline | Integrated |
|---|---|---|
| Cold restart to listening | 6.2 s | 6.3 s |
| Cold restart to first h1 (home) | 6.8 s (`/workspace`) | 6.9 s (`/today`) |
| First interaction (click at load, next h1) | 120–126 ms | 104–105 ms |
| Direct load, h1: home | 337 ms | 341 ms |
| Direct load: /receptionist | 364 ms | 402 ms (was 1629 ms before 04a1282) |
| Direct load: /memory, /usage, /settings, /business | 348–397 ms | 367–432 ms |
| Direct load: new /jarvis, /work, /finance, /studio, /system | n/a | 323–376 ms |
| Warm sidebar navigation | 67–368 ms | 100–179 ms (/finance first visit 851 ms, then 137 ms) |

## Interrupted task: restart policy (`perf/interrupt-*.json`)

A synthetic running agent task was written to the copy's own `.operator-data/agent-jobs.json`, and a server file's mtime was touched.

> **Correction (28 Sep 2026, Stage A review): the timings in this table are CONFIGURED values, not
> measurements.** The measured files say otherwise: `idleTouchToRestartMs` is 120,044 ms (baseline)
> and 120,056 ms (integrated), and `releaseToRestartMs` is 180,033 / 180,099 ms. Those are the
> harness's 120 s and 180 s timeouts, so no restart was ever observed completing. That fits the
> junction problem described below: in this worktree Vite's restart can't load its temp config, so
> it never comes back. Only the "held for 15 s" row was measured (`heldFor15s: true`, `waitingFor:
> 1 agent task active`, in both files). To measure restart latency, rerun the harness on a checkout
> with a real `node_modules` (the main tree). That hasn't been done: it means restarting a server in
> the main tree, which the review rules out while 8081 is live.

| | Baseline | Integrated | Source |
|---|---|---|---|
| Idle: touch to restart attempt | configured 4.0 s quiet window; **measured: timed out at 120 s** | same (timed out at 120 s) | `devRestartPolicy` quietMs; `interrupt-*.json` |
| Task in flight: restart held for 15 s | yes (`waitingFor: 1 agent task active`) | yes | measured |
| Task released: time to restart attempt | **not measured: timed out at 180 s** | same | `interrupt-*.json` |

**Pre-existing, both sides:** in a worktree whose `node_modules` is a junction, Vite's restart fails to load its temp config (`Cannot find module …/.vite-temp/…mjs`). The old server keeps serving. `vite build` fails the same way unless it runs with `--configLoader native`. The main tree has a real `node_modules` and isn't affected, so the recovery after the lead's single restart must be observed there.

## Pricing (rendered, synthetic) — `pricing/`

Captured by `scripts/integration/pricing-evidence.ts` on the quiet copy, with a synthetic Professional client served to `/receptionist`.

- **Operations › Package economics** (`pricing/rendered.json`, `operations-*.png`). Essential shows 699 / 990 / 400 / 0.8, Professional 1099 / 1490 / 1000 / 0.75, and Premium 1999 / 2490 / 1800 / 0.7. The first load and a cache-bypassing reload both show Essential from the catalogue.
  - Status lines: "Monthly price, included minutes, extra-minute rate: Approved 28 Sep 2026 (ex GST, +10% GST)" / "Setup fee: Proposed, not approved" / "Pilot terms: Not approved" / service readiness.
  - GST: "M&U is GST registered", ticked by default. The setup section is labelled a scenario using a PROPOSED fee.
  - No stale token (549, 1.10, 300 min, old approval wording) was rendered. The only "549" is output GST, $549.50 = 5 × A$1,099 × 10%.
- **Draft JSON:** status "approved", setupStatus "proposed", with the notice stating each field's status.
- **Receptionist commercial block:** MRR A$1,099.00 "Catalogue price (approved), ex GST"; setup A$1,490.00 "Proposed setup fee, not approved; ex GST; not a billed record".
- **Invoice draft** (`pricing/invoice-professional.md`, regenerated 28 Sep 2026 for review T5 R2 C3): nothing is due on issue. The monthly fee sits under the owner-decision (b) placeholder as an illustration only (A$1,099.00 + A$109.90 GST = A$1,208.90), and the setup fee is listed as not invoiced.
- **Proposal draft** (`pricing/proposal-professional.md`, regenerated 28 Sep 2026): approved monthly price; setup quoted separately once approved (no figure); "Pilot terms: not approved; no pilot is offered"; GST registered.
- **Fixture** (`pricing/code-path.json`): 1,200 billable minutes give A$1,249.00 ex GST + A$124.90 GST = A$1,373.90. There is no setup line, and transfer minutes are not billable.
