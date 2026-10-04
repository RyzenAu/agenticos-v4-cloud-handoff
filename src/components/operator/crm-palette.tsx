// The CRM search now lives in the ONE command palette (src/components/shell/command-palette.tsx): CRM
// leads, contacts, proposals and clients are its "leads" source (scripts/leads/crm-search.ts, read-only),
// and choosing one still opens it on /leads. Ctrl/⌘K belongs to that palette; this keeps the old entry
// point working for the Leads page's search button.
import { openCommandPalette } from "@/components/shell/command-palette";

export function openCrmPalette() {
  openCommandPalette();
}
