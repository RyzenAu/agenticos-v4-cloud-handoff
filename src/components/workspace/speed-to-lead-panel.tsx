// Speed-to-lead: a small, self-contained presentational panel — props in, markup out. No data
// fetching and no dependency on the workspace shell's query wiring (today-panel.tsx /
// workspace-page.tsx / api.ts), on purpose: this is the piece the os-shell track drops into a
// PanelShell (see src/components/workspace/panel-shell.tsx and other-panels.tsx for the pattern)
// once it registers a real "speed-to-lead" source (scripts/workspace/sources.ts) that reads
// scripts/speed-to-lead/panel.ts's projectSpeedToLead(). Until then it renders fine from a
// synthetic EnquiryPanel for a Storybook-style preview or a test.
import { Badge, EmptyState, fmtCount } from "@/components/ds";
import type { EnquiryPanel, EnquiryPanelItem } from "@/lib/speed-to-lead";

function dueLabel(item: EnquiryPanelItem): string {
  if (item.overdue) {
    const late = Math.abs(item.dueInMinutes);
    return `Overdue by ${fmtCount(late)} min`;
  }
  return `Due in ${fmtCount(item.dueInMinutes)} min`;
}

function EnquiryRow({ item }: { item: EnquiryPanelItem }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{item.topic}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {fmtCount(item.sinceMinutes)} min since enquiry
        </div>
      </div>
      <Badge tone={item.overdue ? "danger" : "accent"}>{dueLabel(item)}</Badge>
    </li>
  );
}

const NOT_SCHEDULED =
  "The enquiry watcher isn't scheduled yet (needs your yes), so new marketing-site enquiries show here only after it is run.";

export function SpeedToLeadPanel({ panel }: { panel: EnquiryPanel }) {
  const scheduled = panel.watcherScheduled !== false;
  if (panel.items.length === 0) {
    return (
      <EmptyState
        variant="row"
        title="No open enquiries recorded"
        body={scheduled ? "A new marketing-site enquiry appears here within about a minute of arriving." : NOT_SCHEDULED}
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {fmtCount(panel.openCount)} open · {fmtCount(panel.overdueCount)} overdue
      </p>
      {!scheduled && <p className="text-xs text-muted-foreground">{NOT_SCHEDULED}</p>}
      <ul className="space-y-1.5">
        {panel.items.map((item) => (
          <EnquiryRow key={item.ref} item={item} />
        ))}
      </ul>
    </div>
  );
}
