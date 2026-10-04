# Public Aldergate template correction — 2 October 2026

## Governing requirement

Match https://aldergate.muventures.com.au/ exactly in layout, styling, imagery, components and page structure; change agency information. The owner explicitly rejected the newer editorial working-tree redesign. Source preparation now archives Aldergate revision `9f374eb`. Its original repository and all dirty working-tree changes remain untouched.

Do not reintroduce PropertyScene, PropertyCollection or the scrolling ApproachSequence: the selected public reference does not use them. Earlier acceptance of the working-tree design is superseded by this correction.

## Implemented

- Original photographic hero, search desk, four-property grid, selling/management panels, activity, assistant demonstration, agent cards, suburb map/guides, insights, credibility section and contact CTA.
- Complete original navigation and secondary pages: Buy, Rent, Sold, Saved, 13 public property details, five agent profiles, six suburb guides, insights, selling, management, tenants, about, contact and legal pages.
- Agency identity and evidenced contact facts use tokens. Missing facts remain unconfirmed.
- Original fictional properties and profiles remain explicitly labelled as examples. Numeric price/search values remain intact; display prices and event notes use `Example` and `AUD` labels.
- Search reads browser query parameters so filters work in the static export.
- Forms validate locally and report that nothing was sent. The walkthrough uses the existing local rules provider, with an explicit example-property answer prefix. No backend enquiry, paid model generation or real inspection is wired into prospect previews.
- `data-mu-property-experience="v2"` rejects stale homepage-only or redesigned caches.
- Next template builds now include TypeScript validation rather than ignoring type errors.

## Current local state

The rebuilt template cache is active. Cordeiro Real Estate was regenerated through the running OS and checked at http://cordeiro-real-estate.localhost:8091/ . Existing real-estate previews require Regenerate to receive the corrected template. This repair is uncommitted; no git merge or public deployment was performed.

## Verification for this correction

- `bun --bun test scripts/lead-sites`: 53 passed, zero failed.
- Both OS typechecks passed. `git diff --check` passed.
- Complete Next static export succeeded with TypeScript validation, 13 public property-detail pages and 168 responsive image variants.
- Rendered desktop homepage at 1440 px retains all public-reference sections; no broken loaded images or horizontal overflow.
- Actual homepage search for `glover` reached `/buy?q=glover` and showed exactly one property.
- Glover detail page shows full six-image gallery, floor plan, location, inspections, agent and similar-property sections. Next image changed Exterior 1/6 to Living 2/6.
- Walkthrough assistant answered the features question from local structured example data.
- Agent Theo Marchetti and Lilyfield suburb detail pages rendered with their correct headings.
- Mobile homepage at 390 px has no horizontal overflow; menu expands to the full navigation. Temporary viewport override was reset.
- Homepage proof: `D:/prog-scratch/aldergate-listings-proof/public-matching-home.png`.

The full OS test suite and OS build were not rerun for this correction. Prior broader gate results are not presented as new evidence. Production listing feeds and live enquiry delivery are outside this prospect-preview correction.

## Rebuild

From AgenticOS-v4:

```powershell
bun --bun scripts/lead-sites/cli.ts templates real-estate --build-root D:\prog-scratch\aldergate-listings-build2
```

Cache: `C:/Users/Nebula PC/source/repos/mu-site-drafts/_templates/real-estate`.

Preserve existing `docs/FALLBACK-ORDER.md`, untracked owner documents/skills and original Aldergate work. Brooke's project was not touched. An earlier scratch build contains a node_modules junction to Aldergate; never recursively delete its target.
