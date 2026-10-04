# Round 7, worker F: proposals for files F does not own, and merge notes

## For the lead (merge order matters)

1. **Real-estate previews: land the owner's uncommitted lead-sites work as one change.** In `C:\Users\Nebula PC\source\repos\AgenticOS-v4` (and on Ryzen) these are
   modified or untracked: `scripts/lead-sites/design.ts`, `next-templates.ts`, `overlays/real-estate/**` (page, data, Footer, PreviewBanner, PreviewServices, new
   `app/buy|rent|sold|property|contact|demonstration`, `data/listings.ts`, `PreviewSearch.tsx`). The committed code on this branch removes listings and refuses the
   template those files produce: with the 2 Oct real-estate template on disk, `generatePreview` fails with `Refusing to write this preview: about.html: /Balmain/ ...`
   (the committed residue list still names the Aldergate suburbs and agents that the owner now keeps as labelled fictional examples). Until the owner's `next-templates.ts`
   (residue `[/Aldergate/, /9000 0000/, /aldergate\.demo/]`) and `design.ts` (`data-mu-property-experience="v2"` check) are committed together with the overlay,
   real-estate generation cannot work from a committed checkout. F did not edit any of these files, so the merge is clean: F touched only `deploy.ts`, `fill.ts`,
   `generate.ts`, `motion.ts`, `templates.ts` and tests in `scripts/lead-sites/`.
2. **Rebuild the dental template before the next dental preview.** The template on disk is the 24 Sep build; `muv-demo-dental` HEAD is now "R16: the lantern comes up"
   (`FlagshipLantern`, `LanternCanvas`) while the overlay and `assertPreviewDesign` still pin the R15 room hero. The check passes today; a rebuild from a tree whose
   `FlagshipOpening` changed would need the owner's decision on R15 versus R16 (the owner selected R15 on 30 Sep).
3. **Motion script path** (`motion.ts`): `src="/_mu/motion.js"` is required by any multi-page export (the owner's Aldergate pages are nested). Templates built before
   this change are unaffected: the script is added when a preview is generated, not when the template is built.

## Proposals in others' files

- **`scripts/preview-guard.ts`** (lead): the quiet-copy 409 message names `AGENTIC_OS_NO_BACKGROUND=1` and "127.0.0.1:8081". It reaches the page verbatim (Chat storage
  warning, Work "Decision wasn't saved"). On a real hub it never appears. If reviewers keep meeting it, return `{ error: "This is a read-only preview copy. Save in the main app." }`
  with the details in a separate `detail` field.
- **`src/components/receptionist/**`** (Receptionist, on hold): the dashboard tabs use `history.replaceState`, so Back leaves the page instead of the previous tab
  (`components/receptionist/dashboard/index.tsx:48`). Same one-line change as Settings: `pushState` on a click, keep `replaceState` for the arrow keys.
- **`scripts/j2/**`** (unowned): reconciliation recommendation 4 (soft-404 and wrong-site checks). Not started; it needs an owner for `scripts/j2/browser-skill.ts` first.
- **`src/components/ds/**`** is F's; nothing from A, B or C was proposed to F this round.

## Acceptance baseline findings (H-04, H-07)

- **H-07, outside F's files: `scripts/jarvis-skills/pc-control.ts` (`answerDeploys`, ~line 278).** It runs `vercel ls` through `execFile(node, [entry, "ls"])` on a spoken "show my deploys". With no
  Vercel login the CLI (v59) starts its device sign-in unless it sees `CI`. Exact patch:
  ```ts
  execFile(process.execPath.includes("bun") ? "node" : process.execPath, [entry, "ls", "--non-interactive"],
    { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, CI: "1", VERCEL_TELEMETRY_DISABLED: "1" } }, ...
  ```
  and map output matching `/no existing credentials|vercel login/i` to "Vercel isn't signed in on the hub." Those are the only other Vercel CLI calls outside F's files (checked by grep over `scripts`, `src` and
  `vite.config.ts`; `vite.config.ts` has none).
- **H-04, for G (`src/components/profile/**`, `scripts/devices/store.ts:337`, `scripts/identity/confirm-browser.ts:5`):** the pending-browser text says "Make a code in Profile on a browser you already use". Say "in
  System, Devices and people" (the deep link is now `/system#system-devices`, which opens the section and scrolls to the panel), and offer the same link in the Profile panel itself. F's side is done: a banner
  on every page and a sidebar link read "Confirm this browser" while `hubSession.pending`, and System's header has "Pair or confirm a browser" for everyone.

## Audit 2, P11 (not F's files): environment variable names on /usage and the dashboard

`scripts/ai-usage/snapshot.ts` returns each provider's `keyName` and the pages print it as a value ("OPENROUTER_API_KEY_ALT", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN"), and `scripts/ai-usage/sources.ts:173`
puts "~/.claude/.credentials.json" in a failure sentence. Exact change: keep `keyName` as the lookup key but add a display field and show only that:
- `snapshot.ts:385` loop: `add({ ..., keyName, label: "OpenRouter key" })`, and for the second key `label: "OpenRouter key (second account)"`.
- `snapshot.ts:608`: `keyName: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN"` becomes `label: "Twilio account"` (keep `keyName` for the lookup and the Inspector).
- `sources.ts:173`: "No Claude Code sign-in found in this account's own profile" without the file name; the file path goes in the Inspector facts.
- The page components then print `label` and fall back to nothing, never `keyName`. A one-line house-rule test (scripts/r7-house-rule.test.ts already scans `src/components/ai-usage` once it is added to `DIRS`) pins it.
