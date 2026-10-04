# Adoption ledger, round 10: Agents interface (3 Oct 2026)

Branch `r10/ui-20261003` (base `2803f98c`), Agents UI owner. One row per component taken from a reference. Columns are the ones the brief asks for.

## Licence check (done, not assumed)

| Item | Result |
|---|---|
| Source | `https://github.com/elie222/rakazo`, tree `ce6684555f7de1ccb63c8b24e4e556dbef32b275` (from `D:\prog-scratch\codex-jev-research-20261003\elie222--rakazo-tree.json`) |
| `LICENSE` blob | the tree lists `LICENSE`, blob `35e6c9da4c9916cec4f785e20fa63a7cd680cdaf`, 9,717 bytes. The tree json holds only the blob's hash and size, so the text was read from that blob (public GitHub API, held in memory, not saved): 9,717 bytes, git blob SHA-1 recomputed and equal to `35e6c9da...`, heading "Apache License, Version 2.0, January 2004", "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION" present, "Copyright 2026 Rakazo contributors" |
| `NOTICE` file upstream | none in the tree, so no section 4(d) text to reproduce |
| Earlier reading | round 7 recorded Apache-2.0 at `df708491` (`LICENSE` and `package.json`); this is the same licence at the newer pin |
| Attribution here | `NOTICE` section 7 (new) |

## Entries

| Component (reference file) | Pinned revision | Licence | Existing equivalent in this repo | Chosen change | Evidence |
|---|---|---|---|---|---|
| Bot list with live state and recent work (`apps/web/src/pages/shell/bot-panel.tsx`, the bot panel's list and activity) | `ce66845` | Apache-2.0 | `BotRail` / `BotSelector` (round 7): identity, name and one live status line per bot, no recent work | Idea only, **no code copied** (its file imports Lingui macros, `@rakazo/ui-web`, `@rakazo/contracts` and oRPC, none of which exist here). New `workspace/recent.ts` (pure, from the coding jobs and each shared computer's current or last job) and `workspace/recent-work.tsx` (a "Recent work" list: title, bot, true end state, one link). A result link appears only when the job truly has a verified result; otherwise "Open job" or "Open tasks". On a phone it is a closed `<details>` under the selector | `src/components/agents/r10-ui.test.tsx` "recent work in the bot list"; `evidence/r10-ui/after-*` |
| Conversation with the computer beside it, resizable (`apps/web/src/components/computer/ComputerWorkspace.tsx`) | `ce66845` | Apache-2.0 | `workspace/layout/chat-computer-layout.tsx` (round 7/8): resizable panel, Conversation / Computer switch on a phone, full-screen viewer, take-over / return / stop | Nothing taken. Audit found the equivalent already meets the brief | audit table in the round's report; `chat-computer-layout.test.tsx` |
| Dock with Browser, Terminal and Files windows (same file) | `ce66845` | Apache-2.0 | Screen viewer (`computer/viewer.tsx`, noVNC) and the Tasks & Files tab (saved results, changed files). **No terminal**: the computers service has no terminal or shell endpoint | Nothing taken and nothing faked. A terminal window with no backend would be a decorative box. Recorded as BLOCKED on the computers owner adding a lease-fenced shell route | audit table |
| Bot setup form (`bot-panel.tsx`: name, description, model, thinking level, skills, voice) | `ce66845` | Apache-2.0 | `setup/*` (purpose, model and account, computer, skills, routines, memory, copy or archive; advanced collapsed) | Nothing taken | audit table |

## Not adopted from the other references

OpenMausBot (setup, routines, leases) and Open Dot (voice and background tasks) were already adopted in earlier rounds (`OPENMAUSBOT-ADOPTION.md`, `OPEN-DOT-ADOPTION.md`); this round took nothing further from them.
