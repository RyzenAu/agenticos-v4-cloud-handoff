# R11 UI audit (UI-CORE pages)

4 Oct 2026. Synthetic hub on 8192 (`scripts/acceptance/r7/hub.ts`, data `D:\AgenticOS-r11-data\ui-core`). BEFORE shots at 1440×900, 768×1024 and 390×844:
`docs/programme-20261001/evidence/r11-ui/core/before/` (`bun scripts/acceptance/r11/ui-core-shots.ts --label before`).

## Main problems

1. **The same warning three times.** An unconfirmed browser shows the top banner, a "Confirm this browser" button in the sidebar footer, and on Home a "Confirm this browser first…" line under every decision card.
2. **Top bar is busy and repeats the page.** Breadcrumb repeats the h1 on every top-level page ("Home" / "Home"); five text buttons (Jarvis, Type a request, Share screen, Meeting, pulse, More) compete with the page's own primary action.
3. **Cards inside cards.** Coding wraps the job grid in a "Jobs" card with a count shown twice (9, and "5 need you · 0 running"); Home's Needs-you items are boxes in a box; System and Models stack icon-in-circle card headers everywhere.
4. **Technical receipts in the ordinary flow.** Coding job repeats each worker line as "Receipts confirm …"; Home shows config names (TRUST_PROXY_HEADERS); Activity's "Kind" column says "PC control" on every row; Tools rows show raw config hints.
5. **Too much red/wash.** Activity paints "Interrupted, not re-run" and "Outcome unknown" red like a real failure; state pills compete with titles.
6. **Agents computer panel.** The side panel is a fixed 440 px default (320 minimum) whatever the row width, beside a 250 px bot rail, so on a real screen the live desktop is a postage stamp and the chat is squeezed; the rail never gets out of the way.
7. **Status shown twice, differently.** Agents shows the bot's state in the rail ("Needs you") and again as a long sentence under the title plus a button; Coding cards repeat state in the chip and the body sentence.
8. **Explanations nobody needs every day.** Activity opens with a two-line paragraph about what is and isn't recorded; Computers repeats "can't be added yet" in a notice and in the empty state.
9. **Space.** Jarvis' composer card is a short box with a half-empty page beneath; Models shows one provider card alone on a row; empty states are tall dashed boxes.
10. **Phone.** The banner takes three lines; Home tabs scroll off-screen; Agents stacks bot switcher, recent work, title, status, two tab rows before the conversation.
