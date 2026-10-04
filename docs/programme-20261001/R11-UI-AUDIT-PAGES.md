# R11 UI-PAGES audit (business pages)

Synthetic hub on port 8193, data under D:\AgenticOS-r11-data\ui-pages. Before/after screenshots at 1440, 768 and 390 are in `evidence/r11-ui/pages/{before,after}/` (made by `bun scripts/r11-ui-pages-shots.ts <before|after>`). No page overflowed horizontally at any width.

Problems found, and what was done:
- Websites: four promo cards (Make a site, Ask Jarvis, Motion graphics, Skills) sat above the sites and repeated the "Make a site" heading. Now one toolbar; sites first; the maker folds below them (opens on #make-site).
- Leads: two control rows plus a "Prospects" heading above the filter box. Now one toolbar (workspace and List/Table/Board), the visible "Search your leads" label is screen-reader only, and "of N loaded" shows only when the list is filtered.
- CRM: "what this page does" sentence, "Saved CRM records" tag, a time-zone sentence and a "missing steps" explainer. Removed or moved to a tooltip; the missing-step list now leads with the company or deal, not the same repeated step title.
- Work: the four stat tiles were repeated as four buttons (and again in the tools row). One next-step button remains.
- Studio: films link on its own caption line, plus kit and transition links hidden in a fold that duplicated the tools row. One action toolbar; the fold appears only when agent counts exist.
- Memory: the capture panel left a blank half-row; it is now full width.
- Left alone (already calm, or shared-system territory): Finance, Receptionist, Operations (package calculator), Calendar, Inbox, Workspaces, Design, Motion, Memory map and vault. Home (/business) is not in scope.
