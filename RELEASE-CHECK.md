# Community release checks · 18 September 2026 (3.6.1)

This is a reviewed community source package. It includes the connections onboarding, Notion via Codex, Business overview and daily brief, chat retrieval, Windows portability and memory catch-up changes. The configured creator installation was not used as the release source.

## Observed checks

- A clean source extraction passed `bun install --frozen-lockfile`, all 790 tests across 97 files (5,032 assertions), `bun run typecheck` and `bun run build` on macOS. Tests used `AGENTIC_OS_NO_CODEX=1` and an isolated user directory.
- Python stream tests (3), Website OS tests (23) and the standalone bundled linter regression script passed. The macOS launcher passed shell syntax validation.
- The nine main pages were exercised through the local server: setup, Business, Inbox, Calendar, Memory, Chat, Websites, Design and Settings. No JavaScript page errors were observed.
- The initial profile and photo were blank. Conversations, inbox, calendar, memories and financial snapshots were empty. The optional public design graph is a labelled example.
- Cross-origin, cross-site and foreign-host workspace reads and tokenless profile writes returned 403. Private test files inside `.operator-data` could not be downloaded through static or Vite file URLs.
- Source and configuration text, URLs, example data, bundled scripts, archive entries and binary metadata were scanned. All 116 raster assets were visually reviewed; three frames from each of 17 videos were reviewed. No private photograph or screenshot was identified. Images had no EXIF, XMP, textual or provenance metadata. Video tags were technical container/encoder fields; no audio tracks were present.

## Release corrections

The package and README now consistently say 3.6.1. Both Windows launchers check locked dependencies every time, including when updating an existing installation. Windows documentation no longer implies an end-to-end platform verification. Privacy documentation explicitly identifies the public author credits and product links that remain.

## What is excluded

Private workspace storage, profiles, photos, imported histories, account grants, non-example environment files, generated live data, private graphs, Git history, dependency folders, application build output, logs, audit files and test runtime state are excluded. The intentionally bundled Website OS template assets are reviewed distribution files.

The archive is built from an explicit reviewed file list. `MANIFEST.sha256` records every included file except itself. The adjacent ZIP checksum uses a filename only, with no creator filesystem path.

## Public references that remain

Author and licence credits, public repository and website URLs, the public news-feed address, public profile-building templates and remote Refero references remain. They contain no embedded account credential. Cloud providers, news, fonts and other optional external services may make network requests when the recipient uses the app; this is not an offline-only product.

## Limits

No live secret or private creator record was identified in this package. This is an evidence-based audit, not a zero-risk guarantee or a proof that all possible code paths are secure. Public attribution is intentionally present.

macOS was tested. Windows and Linux did not receive equivalent end-to-end testing. The Windows launcher change was reviewed statically; native execution remains unverified. Live provider replies, microphone sessions, account imports, message sends, calendar booking, paid generation and publishing were not exercised using the creator's accounts. Recipients must configure their own supported tools and accounts.

An optional Claude adversarial review was attempted but did not run because its local OAuth session had expired. It is not counted as independent review evidence.

Share this clean ZIP, never a folder after it has been configured or used.
