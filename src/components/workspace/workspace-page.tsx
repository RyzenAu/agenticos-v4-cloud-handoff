import { Badge, PageHeader } from "@/components/ds";
import { useWorkspacePanel } from "./api";
import { CallQueuePanel, EmailPanel, PipelinePanel, WebsitesPanel } from "./other-panels";
import { useNow } from "./panel-shell";
import { ReceptionistPanel, UrgentBanner, useUnseenUrgent } from "./receptionist-panel";
import { CallingWindow, TodayPanel, sydneyDate, sydneyTime } from "./today-panel";

/** The owner's morning command centre: approvals, calls, receptionist, sites, email and pipeline,
 *  each from the existing APIs, each refreshing on its own. Read-only. */
export function WorkspacePage() {
  const now = useNow(30_000);
  const receptionist = useWorkspacePanel("receptionist");
  const alerts = receptionist.data?.ok ? receptionist.data.data.urgent : undefined;
  const { unseen, markSeen } = useUnseenUrgent(alerts);
  return (
    <div className="min-w-0 max-w-[1400px] [overflow-wrap:anywhere]">
      <PageHeader
        title="Workspace"
        description="What needs you today across approvals, calls, the receptionist, your websites, email and the pipeline. Read-only: open a section to act."
        meta={
          <>
            {now ? (
              <>
                <span className="text-sm text-foreground">{sydneyDate(now)} · <span className="ds-num">{sydneyTime(now)}</span> Sydney</span>
                <CallingWindow now={now} />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Sydney time loading…</span>
            )}
            <Badge>Receptionist every 60 s · others every 5 min</Badge>
          </>
        }
      />
      {unseen.length > 0 && <UrgentBanner alerts={unseen} onSeen={markSeen} now={now} />}
      {now > 0 && <div className="mt-6 space-y-3">
        <TodayPanel now={now} />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <ReceptionistPanel now={now} />
            <CallQueuePanel now={now} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <EmailPanel now={now} />
            <PipelinePanel now={now} />
            <WebsitesPanel now={now} />
          </div>
        </div>
      </div>}
    </div>
  );
}
