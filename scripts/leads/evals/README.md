# Lead-classification regression evals

Fixed, offline fixtures for the lead-engine bugs found and fixed on 25-26 Sep 2026. Every test here
runs with an injected `fetch` (fixtures in `./fixtures/`, or an inline fake) — no real network
calls, ever. Run with:

```
bun test scripts/leads/evals
```

## What each case protects against

- **`discovery.eval.test.ts` — "SearXNG down + DuckDuckGo bot wall"**: when neither search backend
  actually answers (SearXNG unreachable, DuckDuckGo serving its "bots use DuckDuckGo too" CAPTCHA
  page), `discoverWebsiteDetailed` must report `unverifiable`, never `none` — the bug that told 17
  of the top 20 dental leads they had no website when every one checked by hand had one.
- **"202 JS stub" (beyond32dental.com.au)**: a real site answering HTTP 202 with a ~535-byte JS
  shell has nothing readable in it. Must be `unverifiable`, not treated as "checked, doesn't match"
  and therefore rejected.
- **"SearXNG top hit is the real site" (haberfielddentists.com.au)**: a business's real domain
  often swaps the OSM name's industry word for a synonym ("dental" -> "dentists"). When SearXNG's
  top result is that real site and the page content matches, it must be accepted as `found`.
- **"No address/suburb on file" (Maven Dental Group)**: a lead with nothing to verify a match
  against must never come out of the pipeline as a confirmed "no website" pitch — the missing data
  is a reason to ask a human, not to guess. Covered from both ends: `discoverWebsiteDetailed` isn't
  blocked from finding a real match just because the suburb is blank, and (in `issues.eval.test.ts`)
  a genuine "found nothing" always resolves to `audit_pending`, never `website`.
- **"Overseas namesake" (beverlyhillsdentalclinic.com vs Beverly Hills NSW 2209)**: a same-named
  suburb in a different country used to pass the suburb-only content check. `pageMatchesBusiness`
  now also requires the postcode to show up when one is on file, so a US "Beverly Hills, CA 90210"
  page no longer satisfies a check for "Beverly Hills NSW 2209".
- **"Directory/aggregator hosts"**: healthengine, healthdirect, findglocal, dentist.com.au,
  localdentists.au and wheree all confirmed live returning a genuine-looking per-business listing
  page. None of them may ever be accepted as "their own site" — checked both in `NOT_A_WEBSITE`
  (search-result filtering) and `isAggregatorOrDirectory` (hint/Hermes-candidate verification).
- **`issues.eval.test.ts` — "automatic no-website finding"**: `no_website_verified` must always
  score to pitch `audit_pending` — a human confirms it before it ever becomes a "you don't have a
  website" call script, whatever the lead's other data looks like.
- **"phone-only vs form-present home page"**: a home page with a `tel:` link, no online booking
  widget and no real enquiry `<form>` must trip the `phone_only` issue with the evidence quote
  (`no booking widget/link and no enquiry <form> found; phone shown: ...`). A page with a genuine
  enquiry `<form>` must NOT trip `phone_only` — it should still be evidenced as `no_booking` if
  there's no online booking widget, but the stronger "phone is the only way in" claim needs to be
  actually true.

## Adding a case

Add a case for every lead-engine bug. When a hand-check turns up a lead the engine got wrong:

1. Save the real page (or a trimmed-but-faithful excerpt) as a new fixture in `./fixtures/`, with a
   comment saying what was recorded and when.
2. Add a test in `discovery.eval.test.ts` or `issues.eval.test.ts` (whichever module owns the bug)
   that fails against the old behaviour and passes against the fix.
3. Add one bullet to this README explaining what the case protects against, in the same style as
   the ones above — evidence, not vibes.

Never delete a case because it's "obviously fixed now" — that's exactly what a regression test is
for.
