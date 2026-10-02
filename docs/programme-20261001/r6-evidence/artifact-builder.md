# Builder: Opening Hours

**Request:** build an opening hours component for the clinic site

**Isolated:** worktree on branch `job/0f15bfb224d7` in the builder computer's own folder. The base site (`main`) was not changed, and nothing was merged, pushed or deployed.

## What changed
Displays the clinic’s weekly opening times in an accessible list.

- added `components/opening-hours.css`
- added `components/opening-hours.html`

Size of the change: 2 files changed, 23 insertions(+).

## Verification
9 of 9 checks passed. The computer ran them in the worktree after committing.

| Result | Check | Detail |
| --- | --- | --- |
| pass | something changed against main | 2 files |
| pass | components/opening-hours.css: braces balanced | 6 rule blocks |
| pass | components/opening-hours.css: nothing loaded from elsewhere | no remote loads |
| pass | components/opening-hours.html: tags balanced | every tag closes |
| pass | components/opening-hours.html: images have alt text | no images |
| pass | components/opening-hours.html: nothing loaded from elsewhere | no external scripts, images or form targets |
| pass | components/opening-hours.html: no inline handlers or javascript: links | none |
| pass | no whitespace errors (git diff --check) | clean |
| pass | worktree is clean after the commit | clean |

## Preview
![desktop preview](shot-preview-desktop.jpg)
![phone preview](shot-preview-phone.jpg)

The page itself is `preview.html` (open it from the Files list below).

## Files and diff
- `components/opening-hours.html`: component-opening-hours.html
- `components/opening-hours.css`: component-opening-hours.css
- The full diff is `change.diff`.

Made by a connected model, then validated and checked.