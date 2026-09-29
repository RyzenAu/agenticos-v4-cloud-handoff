# Nightly prep

`bun scripts/leads/cli.ts prep-tomorrow --top 10` builds tomorrow's morning pack: for the top N
leads on tomorrow's call list (respecting `callWindow` in `scripts/leads/outreach.ts` — Saturday
9am–5pm, closed Sunday and national public holidays), it re-runs the SEO audit, builds a **local**
preview (never deployed — see `scripts/lead-sites/generate.ts`), and writes an opener + call script
(`scripts/leads/call-script.ts`, same Claude-subscription-primary/MiMo-fallback path the drawer
uses). Everything is best-effort: a failed SEO audit, preview build or script generation notes
itself in the pack instead of failing the whole run.

Output: `.operator-data/prep/<date>/index.md` (`<date>` is tomorrow's date, Sydney).

If tomorrow is a Sunday (or a national public holiday), the pack says so and stops — there is
nothing to call, so nothing else runs.

## Running it by hand

```
bun scripts/leads/cli.ts prep-tomorrow --top 10
```

Add `--by usman` or `--by mehroz` to pick whose sender name goes on the openers/drafts (defaults to
Usman). Add `--json` for machine output.

## Hermes cron job definition (not registered by this change)

Name: `mu-leads-nightly-prep`
Schedule: `0 22 * * 0-5` — 10:00 pm Sydney, Sunday night through Friday night (so Monday through
Saturday mornings each have a fresh pack; skips Saturday night, since Sunday has no calls).
Command: `bun scripts/leads/cli.ts prep-tomorrow --top 10 --json`, run from this project's root
(`C:/Users/Nebula PC/source/repos/AgenticOS-v4/ops` — the real checkout, not this worktree).
Deliver: a one-line Telegram note ("Morning pack ready: N leads, see .operator-data/prep/<date>/")
to Usman's DM, the same channel the other shipped jobs in `docs/MU-AUTOMATION-MAP.md` use. The pack
itself is a local file, not the Telegram message — nothing about a lead goes out over Telegram.

### Exact install command (do not run without the owner's go-ahead)

```
hermes cron add mu-leads-nightly-prep \
  --schedule "0 22 * * 0-5" \
  --command "bun scripts/leads/cli.ts prep-tomorrow --top 10 --json" \
  --cwd "C:/Users/Nebula PC/source/repos/AgenticOS-v4/ops" \
  --deliver telegram:usman \
  --note "Morning pack for tomorrow's call list -- SEO audit + local preview + opener/script per lead. Read-only, nothing deployed or sent."
```

Manage it afterwards the same way as every other job: `hermes cron list | pause | resume | run
mu-leads-nightly-prep`.

This file only documents the job and the command that would install it — no cron job has been
registered by this change.
