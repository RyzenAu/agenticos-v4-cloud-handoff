# Dental preview routing — 30 September 2026

## Observed fault and live correction

The owner's selected local reference was `http://dental-care-plus.localhost:8091/`.
It served the daylit-room `FlagshipOpening` preview with the same built CSS as the dedicated
`mu-preview-dental-care-plus.vercel.app` project.

The public address `https://dental-care-plus.muventures.com.au/` instead resolved to the
`muventures-app` production deployment and displayed Marigold Dental. The correct preview
was already uploaded; the public domain was the mismatch.

Corrected only that exact alias to the existing dental deployment and added the domain to
the dental preview project as a production domain. An alias without that project-domain
association briefly hit Vercel's standard deployment login protection. Adding the production
domain resolved it. No replacement design or new content was uploaded.

## Permanent changes

- Always link a staging copy to its explicitly named preview project.
- Check the exit status of project creation, linking, upload, domain addition and alias assignment.
- Add the production domain, then alias it to the exact expected deployment returned by upload.
- Check the public address for the business disclosure, noindex and the uploaded CSS/JS asset paths.
- A different or unverified build is failed, and the drawer shows an error instead of a success notice.
- Pin dental template generation/deployment to the selected room design. Validation happens before
  overwriting a previous generated preview. Existing valid cached templates remain usable.
- Dental quick actions, voice draft requests and the Hermes CLI use the same flagship generator.
  A new Claude design is an explicit bespoke choice; it cannot replace the default silently.
- Preserve the flagship source repo, original drafts, client/CRM records and provider configuration.

## Verification

The public and local pages were compared at 1440, 390 and 360 pixels: matching heading,
geometry, typography, background, CSS and visible image paths; no page errors, failed assets
or horizontal overflow. Hidden/offscreen lazy images are intentionally not required to load.

Regression checks execute the actual Windows PowerShell helper against a fabricated CLI,
including stale project links, failed upload/domain/alias commands and a wrong returned project.
Synthetic dispatch checks prove the dental default never starts a custom builder and never
falls back after a flagship error. A real loopback HTTP check rejects mismatched built assets.

Final frozen-source gate: 9698 pass; 13 skip; 0 fail; Ran 9711 tests across 561 files. [597.10s]. Typecheck and build exit zero; reviewed source hashes stayed unchanged. The unconfigured clean-copy frozen install, typecheck and build also exit zero.
