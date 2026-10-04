// `?tab=computer` used to be a tab of its own. The computer now sits beside the conversation, so the old link lands on the conversation with
// the computer showing, once; the address then reads plain `?tab=chat`. Every other tab is itself.
import type { WorkspaceTab } from "../bots";

export function resolveTab(tab: WorkspaceTab): { shown: WorkspaceTab; openComputer: boolean } {
  return tab === "computer" ? { shown: "chat", openComputer: true } : { shown: tab, openComputer: false };
}
