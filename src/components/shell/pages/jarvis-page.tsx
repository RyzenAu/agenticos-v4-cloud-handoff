// Jarvis: talk, hand off work and watch it run. The centre is Jarvis's own view of the day (the
// HUD: mode, next commitment, calls, what's waiting, system health), then live progress. The Jev
// track can fill the progress slot with its own panel (see ../jarvis-slot.tsx).
//
// W-C (29 Sep 2026) made it larger and calmer and folded the detail. L2 (29 Sep, owner: "see how
// the Inbox fills the screen"): one headline, then a full-width widget grid that leads with what
// the page DOES: talk to or ask Jarvis, and what it's doing. The HUD, the confirmed-event pipelines,
// the hand-offs and the ways in are all still here, each as a widget; sources sit in the page foot.
import { useEffect, useState } from "react";
import { AudioLines, ListChecks, Send } from "lucide-react";
import { Button, DeviceStatusSlot, PageFoot, PageHeader, TaskBar, TaskWord, Widget, WidgetEmpty, WidgetGrid, WidgetList, WidgetRow } from "@/components/ds";
import { JarvisHudBody, useJarvisHud } from "@/components/operator/jarvis-hud";
import { AgentQuestionsPanel } from "@/components/operator/agent-jobs-panel";
import { FEED_STATUS_LABEL, feedStatus, readFeed, subscribeFeed, type FeedTask } from "@/lib/agent-feed";
import { DrilldownList } from "../page-parts";
import {
  JarvisPanelSlot,
  openJarvis,
  submitJarvisRequest,
  useJarvisProgress,
  type JarvisProgress,
} from "../jarvis-slot";
import { activeDevice, deviceSlotInput, useDevices } from "@/lib/use-devices";
import { ProgressPanel } from "../progress-panel";
import "./jarvis-page.css";
import { useDraft } from "@/lib/use-draft";

/** How many hand-offs show before the rest fold into "Show all". */
export const HANDOFFS_SHOWN = 3;

function ProgressCard({ progress }: { progress: JarvisProgress }) {
  const idle = progress.phase === "idle";
  const [request, setRequest] = useDraft("jarvis-request");
  return (
    <Widget
      icon={AudioLines}
      span={4}
      title="What do you want done?"
      badge={idle ? undefined : progress.label}
      tone={progress.phase === "error" ? "danger" : progress.phase === "needs-you" ? "warn" : "default"}
      line={!idle && progress.step ? progress.step.text : undefined}
    >
      <form
        className="space-y-4"
        data-assistant-request
        onSubmit={(event) => {
          event.preventDefault();
          if (!request.trim()) return;
          submitJarvisRequest(request);
          setRequest("");
        }}
      >
        <label htmlFor="assistant-request" className="sr-only">
          Request for Jarvis
        </label>
        <textarea
          id="assistant-request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          maxLength={600}
          rows={3}
          placeholder="Describe the task. Include the project or app you want to use."
          className="w-full resize-y rounded-xl border border-input bg-background px-4 py-3 text-base leading-relaxed placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="accent"
            className="min-h-11 rounded-full px-5"
            disabled={!request.trim()}
          >
            <Send className="h-4 w-4" aria-hidden="true" /> Send request
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 rounded-full px-5"
            onClick={openJarvis}
          >
            <AudioLines className="h-4 w-4" aria-hidden="true" /> Use voice
          </Button>
        </div>
      </form>
    </Widget>
  );
}

function HandoffRow({ t }: { t: FeedTask }) {
  const status = feedStatus(t);
  // Start -> progress -> complete (src/lib/ui-motion.ts): the bar slides while the length is unknown and
  // the tick lands once when the confirming event arrives. A run that stopped for his yes is "waiting".
  const phase = ({ running: "running", "needs-you": "waiting", done: "done", failed: "failed" } as const)[status];
  return (
    <WidgetRow
      title={t.title}
      meta={
        <>
          {t.agent} · {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
          <TaskBar phase={phase} label={`${t.title}: ${FEED_STATUS_LABEL[status]}`} className="mt-2" />
        </>
      }
      aside={<TaskWord phase={phase} word={FEED_STATUS_LABEL[status]} className="text-sm" />}
    />
  );
}

function HudDetails() {
  const hud = useJarvisHud(true);
  return <JarvisHudBody data={hud} />;
}

export function JarvisPage() {
  const { progress } = useJarvisProgress();
  const [tasks, setTasks] = useState<FeedTask[]>([]);
  const [allHandoffs, setAllHandoffs] = useState(false);
  const [hudOpen, setHudOpen] = useState(false);
  const [previewsOpen, setPreviewsOpen] = useState(false);
  const devices = useDevices();
  useEffect(() => {
    setTasks(readFeed());
    return subscribeFeed(setTasks);
  }, []);
  const shown = allHandoffs ? tasks : tasks.slice(0, HANDOFFS_SHOWN);
  const folded = tasks.slice(HANDOFFS_SHOWN);
  return (
    <div className="jv-page min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Jarvis" meta={devices.data ? <DeviceStatusSlot device={deviceSlotInput(activeDevice(devices.data))} /> : devices.isError ? <span className="text-xs text-muted-foreground">Devices not readable</span> : undefined} />
      <WidgetGrid aria-label="Jarvis">
        <div className="col-span-full min-w-0">
          <JarvisPanelSlot fallback={<ProgressCard progress={progress} />} />
        </div>
        <WidgetList
          icon={ListChecks}
          title="Handed-off work"
          span={4}
          badge={tasks.length || undefined}
          empty={<WidgetEmpty title="No tasks in this session" />}
          action={
            folded.length > 0 ? (
              <Button variant="outline" size="sm" className="rounded-full" aria-expanded={allHandoffs} onClick={() => setAllHandoffs((v) => !v)}>
                {allHandoffs ? "Show fewer" : <>Show all {tasks.length} hand-offs</>}
              </Button>
            ) : undefined
          }
        >
          {shown.map((t) => (
            <HandoffRow key={t.id} t={t} />
          ))}
        </WidgetList>
      </WidgetGrid>
      <div className="mt-6"><AgentQuestionsPanel /></div>
      <details
        className="mt-6 border-t border-border py-2"
        onToggle={(event) => setHudOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground hover:text-foreground">
          Daily status & shortcuts
        </summary>
        {hudOpen && (
          <div className="sh-hud-card jv-hud mt-3 max-w-2xl">
            <HudDetails />
          </div>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          Alt+Shift+J opens the HUD. Alt+Shift+I opens diagnostics. Away mode uses your configured
          Telegram connection.
        </p>
      </details>
      <details
        className="border-t border-border py-2"
        onToggle={(event) => setPreviewsOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground hover:text-foreground">
          Workflow previews
        </summary>
        {previewsOpen && (
          <WidgetGrid className="mt-3">
            <ProgressPanel />
          </WidgetGrid>
        )}
      </details>
      <div>
        <DrilldownList id="jarvis" />
      </div>
      <PageFoot>
        Jev picks the action; anything that sends, pays, deletes or publishes waits for your yes. Progress moves only on confirmed events: coding from the job
        history (/__jobs), calls from the agency feed.
      </PageFoot>
    </div>
  );
}
