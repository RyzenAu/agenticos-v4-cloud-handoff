# Stage 2 vertical slice: cloud-role hub → Jarvis → Usman's companion → verified action (lead, 1 Oct 2026 ~03:20 AEST)

**What ran:**
- **Hub:** the full Vite OS from `prog/integration-20261001` at `78a0553`, run as a separate process on `127.0.0.1:8110`.
  - Settings: `MU_HUB_ROLE=cloud`, `MU_DATA_DIR=D:\prog-slice\data` (empty synthetic), `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`.
  - `/__health` reported ok, `hubRole: cloud`, 5 stores open, companions 0/0, and PC-only features listed as "needs the companion".
- **Companion:** `bun companion/main.ts pair/run`, paired as `usman` using a one-time code created by a confirmed human browser session on the hub (curl without a session was correctly refused).
- **Commands:** sent as typed utterances through the real `/__operator/screen/command` route from the in-app browser session. No pre-planned steps were supplied; the hub's planner chose each executor.

**Stands in for cloud:** the hub was a separate process with its own data, reached over loopback. This is **not** a VM, and no Tailscale was involved: Tailscale on this PC was broken at the time.

## Defect found and fixed

Cloud role returned **501 for `/__operator/screen/command`**. Agent A's PC-only table blocked the one Jarvis command path, which Agent B had made companion-aware. Fixed in `78a0553` by removing `screen/command*` from the PC-only table (direct `screen/act`, `pc/act`, `open-url` and `vision` stay blocked). A regression test was added in `scripts/cloud/cloud.test.ts`.

## Results

| Utterance | Result | ms | Job state | Companion evidence |
|---|---|---|---|---|
| open Chrome | ok, verified | 2348 | succeeded | "a new chrome window appeared" (handle read back) |
| go to example.com | ok, verified | 1182 | succeeded | "chrome window titled 'Example Domain - Google Chrome' matches the page title" |
| open PowerPoint | ok, verified | 2937 | succeeded | "a new POWERPNT window appeared: 'Opening -'" ← **weak**: splash title accepted as verified |
| start a new blank presentation in PowerPoint | ok, verified | 1144 | succeeded | "PowerPoint reads back 1 slide, title layout, not saved". The wording 'presentation (Title) … "Title"' is clumsy |
| open a new Chrome tab and go to youtube.com then search for Sydney weather | **refused honestly** | 12 | refused | "needs Usman's PC's screen loop, so nothing ran, and I didn't send it anywhere else" |

All jobs were recorded on the hub with the target device `usman-…` ("Usman's PC") and per-step verification from the companion.

**Clean-up:**
- The test deck was closed without saving and PowerPoint was quit.
- The test Chrome window was closed.
- The example.com tab opened into an existing Chrome window (the Windows shell hands URLs to the last active window). It was left open rather than risk closing the owner's tabs. **Follow-up:** `open-url` should open a tab it owns, and track and close it when asked.

## Open (assigned to Agent B)

1. Compound or open-ended goals on the companion path: run the existing Jev screen loop on the PC as a `screen.goal` executor, with cancel, unknown-on-drop and approval resume.
2. PowerPoint verification must not accept a splash window.
3. Plain wording for an untitled blank deck.
