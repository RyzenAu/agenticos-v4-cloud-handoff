# Freebuff queue: copy-ready (nothing has been queued)

**Verified 27 Sep 2026:** "Free Buff" is **Freebuff Desktop** (Codebuff's free desktop app, `AppData\Local\Programs\@codebufffreebuff-desktop\Freebuff.exe`), relaunched 08:12. It's the same product that ran GLM on `D:\MU-Receptionist`. Screen access was declined, so **no task was queued**. Paste these yourself, one at a time.

Rules for every task:
- Read-only on other agents' branches.
- Write only to the output path named in the task.
- No push, deploy, merge, email or form submission.
- Never open `.env` files.
- Stop and report if anything asks for credentials.

**⚠️ Don't paste #1–#2 while an Opus agent is finishing GLM's work in `D:\MU-Receptionist`** (check the call pack `06` or the handoff for its status).

| # | Task (paste as-is) | Output contract |
|---|---|---|
| 1 | "In `D:\MU-Receptionist`, read-only: review the latest commits on `feat/sale-ready-20260927` against `C:\Users\Nebula PC\Downloads\BRIEF-GLM-2026-09-27-RECEPTIONIST.md`. List any criterion not met, with file:line evidence. Don't edit code." | `D:\MU-Receptionist-review\freebuff-review-sale-ready.md` |
| 2 | "Read-only: review `D:\MU-Receptionist-wt-prompt` branch `fix/prompt-truth-20260927`. Does any generated prompt claim a booking, transfer or SMS capability that isn't configured? Report with evidence." | `D:\MU-Receptionist-review\freebuff-review-prompt.md` |
| 3 | "In `C:\Users\Nebula PC\source\repos\mu-video-demos`, create branch `freebuff/calculator-tests`. Add edge-case tests to `calculator/test.mjs` (zero inputs, blanks, 100% rates, negative numbers rejected, very large numbers). Don't change calculator logic unless a test proves a bug; describe any bug in the commit message. Commit on that branch only." | branch `freebuff/calculator-tests` |
| 4 | "Read-only accessibility review of `C:\Users\Nebula PC\source\repos\muv-marketing-wt-design` (Next.js): check colour contrast tokens, focus order, alt text and reduced-motion handling in `src/`. Report issues ranked by severity with file:line." | `C:\Users\Nebula PC\source\repos\muv-marketing-wt-design\review\freebuff-a11y.md` |
| 5 | "Draft 3 alternative 15-second hook scripts per sector (dental, real estate, legal) for an AI receptionist that, at go-live, books appointments into a connected Google Calendar or Cal.com calendar. Rules: say it is an AI assistant; show booking as the flow at go-live, labelled 'Illustrative demonstration'; no earnings, 'never miss a call' or guaranteed-bookings claims; no testimonials; no clinical or legal advice; any urgent caller hears the 000 line. First 5 seconds must name a specific moment in the cover the business chooses (after hours, while the desk is busy with patients, or alongside the team); never frame it as missed-call cover. Australian English." | `C:\Users\Nebula PC\source\repos\mu-video-demos\sectors\freebuff-hook-drafts.md` |
