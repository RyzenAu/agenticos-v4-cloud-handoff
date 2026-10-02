# Preview claims and domain assignment · 30 September 2026

The rating matcher treated the end of a phone number followed by “Start” as a
rating: `3761 Star`. It now requires the complete word `star` or `stars`.
Unsupported ratings remain refused, including decimals, hyphenated ratings,
scores out of five and star symbols.

Dundas Dental uploaded successfully but the CLI's `domains add` request failed
with HTTP 415. The existing deployment was verified Ready, then its exact domain
was attached with the authenticated CLI API, explicit JSON content type and
typed `name` field. The exact alias now serves the selected room flagship with
the disclosure and noindex header. No rebuild or new upload was needed.

The deploy helper now checks the exact project's domain first, reuses an existing
assignment, or adds it with that JSON request. A failed lookup, assignment or alias
still fails the operation. Public verification still checks the uploaded assets.
The displayed error keeps the failed step and removes successful-upload help text.

Checks use fabricated CRM data and a fake CLI. The public, tokenized Aldergate
template is also exercised through the real generator with a synthetic phone
number ending in 3761. Real lead records and other domains are not modified.

Final frozen-source gate: 9708 pass; 13 skip; 0 fail; Ran 9721 tests across 561 files. [599.09s]. Typecheck and build exit zero; reviewed source hashes stayed unchanged. A separate unconfigured source copy passed frozen install, typecheck and build.
