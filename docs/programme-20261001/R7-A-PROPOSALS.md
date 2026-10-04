# Round 7, worker A: proposals for other owners (3 Oct 2026)

Worker A owns `src/components/agents/workspace/**`, `setup/**`, `src/routes/agents.*` and the references record. These are changes that belong to files A does not own. None has been applied. Each says what the person sees today, the change, and how to tell it is done. Screenshots: `evidence/r7-agents/` (`before-*` at `491b8ee0`, `after-*` on `r7/a-agents-ui-20261003`).

## For worker B (`src/components/agents/chat/**`)

1. **Stop saying the offline or unconfigured state twice more.** The workspace header now states the bot's status once, with one action button (`status-action`), and the bot list shows two or three words. `BotChat` still opens with an "X is offline" or "X is not set up yet" Notice carrying the same sentence, and then the empty state says "Ask X for something". Today at 1440 a bot with no computer reads: header line, Notice, empty state (see `before-1440-chat.png` and `after-390-06`).
   Change: show the Notice only for what the header cannot say (a conversation read failure, "this browser isn't confirmed"), or only when `status.reasons` has more than the header's first reason. Keep the `Reconnect` action reachable (the header button opens the computer panel where `Reconnect` is).
   Done when: a bot whose computer failed shows one status sentence on the page, not two, and `bot-chat.test.tsx` still covers the recovery action.
2. **Composer on a narrow row.** With the computer panel open at 1440 the chat column is about 390 px and the placeholder "Ask Research to do something" wraps to two clipped lines (`after-1440-02`). Give the textarea `rows={1}` with `min-h` of one line and let the placeholder truncate (`text-ellipsis`), or shorten it to "Ask Research". Done when no placeholder line is clipped at a 390 px chat column.
3. **A "needs you" card in the thread that opens the computer** (Rakazo's `computer-needs-you-card` journey). When a run is waiting on the person (approval, take-over request), put a card at the end of the conversation with one `Open computer` button that links to `/agents/workspace/<bot>?tab=computer` (the workspace already opens the panel once for that link and then reads `?tab=chat`). The workspace header shows the same action; the card is where the person is already looking.
4. **Offline empty state.** When the bot is offline, drop the dashed "Ask X for something" box: the Notice already says what to do and the box invites an action that cannot start.

## For worker C (`src/components/agents/computer/**`)

1. **Retry beside the error.** Rakazo's browser test (`computer-screen-error.spec.ts`) keeps a screen-connection failure visible with a `Retry screen` button, in both the side preview and the full-screen view, and clears it on success. Our `ComputerTab` shows the failure and `Reconnect` (a computer restart), but a viewer that merely failed to connect (the 15 s deadline) should offer `Try the screen again` that re-opens only the viewer, without restarting the computer. Done when a viewer deadline shows the reason, one retry, and the retry does not call the computer's `recover`.
2. **Say who is driving in the panel header, not only in the body.** The panel title row is `<computer label>` plus Expand and Hide (workspace layout). `ComputerTab` repeats a headline, a state badge and a connection state below it. Put the connection phase (`Connecting`, `Live`, `Can't reach the screen`) as the one chip in `ComputerTab`'s headline row and remove the second headline sentence when the badge says the same thing ("Research computer failed" plus "Failed").
3. **`compact` should not cap the viewer.** In the side panel the iframe wrapper already clears `max-h`; confirm the viewer fills the panel height so the screen, not the surface card, is the largest thing in it.
4. **Files of the computer** (Rakazo's `FilesApp`: browse the workspace, preview text, download, upload while you hold control). Deferred in this round's UI; if C builds a file list it should sit in the panel, below the viewer, not as a fourth tab.
5. **Terminal.** Rakazo ships a PTY terminal behind control. Not built here, so not advertised anywhere in the Agents UI. Do not add a Terminal button until the PTY exists.

## For worker D (`src/components/agents/tasks/**`)

1. The Tasks & Files tab now starts under a calm two-line header and fills a scrolling panel (the tab body scrolls; the header and tabs stay). Its own `Current` / `Past work` / `Saved results` headings are `text-lg`, larger than the bot name's neighbours; use `text-base font-semibold` so the three read as sections of one panel.
2. **Saved results** should open in place from the conversation too (B's result card links `/__computers/artifacts/<job>`); nothing needed here, noted so the two stay on one link shape.

## For worker F (`src/components/ds/**`)

1. **`StatusDot`** with the tone map now repeated in `workspace/status.ts` (`TONE_DOT`) and in `ds/status.tsx` consumers: one component that renders the dot and takes its words as children, so a dot is never alone.
2. **`IdentityMark`** (the initial in a ring, 36 px and 40 px) used by the bot list and the bot header; today it is two inline spans in `workspace/bot-selector.tsx` and `workspace-page.tsx`.
3. **`Tabs` height.** The pill tabs are 44 px tall with 1 rem text; on a phone that plus the Conversation / Computer switch costs 100 px. A `size="sm"` (36 px) would return a line of chat to a 390 px screen.
4. The shell's `PageHeader` is not used by the Agents page any more (the shell breadcrumb already says Jarvis > Agents; the page keeps an `sr-only` h1). If the app-wide rule is "one visible h1 per page", tell A.
