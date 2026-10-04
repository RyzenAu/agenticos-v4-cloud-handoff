// Speed-to-lead: the shared, metadata-only shape between the backend projection
// (scripts/speed-to-lead/panel.ts) and the Today panel UI — same convention as
// src/lib/leads.ts's BoardLead, which scripts/workspace/projections.ts also imports.
export type EnquiryPanelItem = {
  ref: string;
  topic: string;
  /** Minutes since the enquiry's own received-at metadata (not since it was detected). */
  sinceMinutes: number;
  /** Minutes until due; negative once overdue. */
  dueInMinutes: number;
  overdue: boolean;
};

export type EnquiryPanel = {
  items: EnquiryPanelItem[];
  openCount: number;
  overdueCount: number;
  /**
   * Whether anything runs the enquiry watcher on a schedule. False until the owner approves the
   * schedule in docs/SPEED-TO-LEAD.md ("Patch for lead"); until then new enquiries appear only
   * after someone runs scripts/speed-to-lead/run.ts by hand.
   */
  watcherScheduled?: boolean;
};
