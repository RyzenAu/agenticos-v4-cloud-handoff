// Jarvis: talk, hand off work and watch it run. The centre is Jarvis's own view of the day (the
// HUD: mode, next commitment, calls, what's waiting, system health), then live progress. The Jev
// track can fill the progress slot with its own panel (see ../jarvis-slot.tsx).
//
// W-C (29 Sep 2026) made it larger and calmer and folded the detail. L2 (29 Sep, owner: "see how
// the Inbox fills the screen"): one headline, then a full-width widget grid that leads with what
// the page DOES: talk to or ask Jarvis, and what it's doing. The HUD, the confirmed-event pipelines,
// the hand-offs and the ways in are all still here, each as a widget; sources sit in the page foot.
import { useEffect, useState } from "react";
import { AudioLines, Keyboard, ListChecks, MessageSquare, PanelRight, PhoneCall } from "lucide-react";
import { Button, PageFoot, PageHeader, Widget, WidgetEmpty, WidgetGrid, WidgetList, WidgetRow } from "@/components/ds";
import { JarvisHudBody, useJarvisHud } from "@/components/operator/jarvis-hud";
import { FEED_STATUS_LABEL, feedStatus, readFeed, subscribeFeed, type FeedTask } from "@/lib/agent-feed";
import { DrilldownList } from "../page-parts";
import { JarvisPanelSlot, openJarvis, openJarvisText, useJarvisProgress, type JarvisProgress } from "../jarvis-slot";
import { ProgressPanel } from "../progress-panel";
import "./jarvis-page.css";

/** How many hand-offs show before the rest fold into "Show all". */
export const HANDOFFS_SHOWN = 3;

function ProgressCard({ progress }: { progress: JarvisProgress }) {
  const idle = progress.phase === "idle";
  return (
    <Widget
      icon={AudioLines}
      span={2}
      className="h-full"
      title="Talk to Jarvis"
      badge={idle ? "Ready" : progress.source === "jev" ? "Jev" : progress.source === "agent-feed" ? "Agent" : "Voice"}
      value={idle ? "Nothing running" : progress.label}
      tone={progress.phase === "error" ? "danger" : progress.phase === "needs-you" ? "warn" : "default"}
      line={
        idle
          ? 'Say "Hey Jarvis", press the chip in the header, or type a request.'
          : progress.step
            ? `Step ${progress.step.index}${progress.step.total ? ` of ${progress.step.total}` : ""}: ${progress.step.text}`
            : undefined
      }
      action={
        <>
          <Button variant="accent" className="h-11 rounded-full px-5 text-base" onClick={openJarvis}>
            <AudioLines className="h-4 w-4" aria-hidden="true" /> Talk to Jarvis
          </Button>
          <Button variant="outline" className="h-11 rounded-full px-5 text-base" onClick={openJarvisText}>
            <MessageSquare className="h-4 w-4" aria-hidden="true" /> Type to Jarvis
          </Button>
        </>
      }
    />
  );
}

function HandoffRow({ t }: { t: FeedTask }) {
  const status = feedStatus(t);
  const tone = ({ running: "text-foreground", "needs-you": "text-warn", done: "text-success", failed: "text-danger" } as const)[status];
  return (
    <WidgetRow
      title={t.title}
      meta={`${t.agent} · ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`}
      aside={<span className={`text-sm font-medium ${tone}`}>{FEED_STATUS_LABEL[status]}</span>}
    />
  );
}

/** The ways to reach Jarvis, one widget each (were one folded list; W-C "Ways to reach Jarvis"). */
const WAYS_IN = [
  { Icon: AudioLines, title: "Voice", value: "Hey Jarvis", line: "Or the chip at the top of every page." },
  { Icon: Keyboard, title: "HUD", value: "Alt+Shift+J", line: "Opens Jarvis's HUD over any page." },
  { Icon: PanelRight, title: "Inspector", value: "Alt+Shift+I", line: "Every step of every hand-off." },
  { Icon: PhoneCall, title: "Away", value: "Telegram", line: "Reaches the same Jarvis when you're not at the PC." },
] as const;

export function JarvisPage() {
  const hud = useJarvisHud(true);
  const { progress } = useJarvisProgress();
  const [tasks, setTasks] = useState<FeedTask[]>([]);
  const [allHandoffs, setAllHandoffs] = useState(false);
  useEffect(() => {
    setTasks(readFeed());
    return subscribeFeed(setTasks);
  }, []);
  const shown = allHandoffs ? tasks : tasks.slice(0, HANDOFFS_SHOWN);
  const folded = tasks.slice(HANDOFFS_SHOWN);
  return (
    <div className="jv-page min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Jarvis" description="Talk to Jarvis or hand it work, and watch it run." />
      <WidgetGrid aria-label="Jarvis">
        <div className="col-span-full min-w-0 md:col-span-2">
          <JarvisPanelSlot fallback={<ProgressCard progress={progress} />} />
        </div>
        <section aria-label="Jarvis HUD" className="sh-hud-card jv-hud col-span-full min-w-0 md:col-span-2 xl:row-span-2">
          <JarvisHudBody data={hud} />
        </section>
        <WidgetList
          icon={ListChecks}
          title="Handed-off work"
          badge={tasks.length || undefined}
          empty={<WidgetEmpty title="No hand-offs in this session" body="Tasks Jarvis gives Hermes, screen hands or a coding agent appear here with every step." />}
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
        <ProgressPanel />
        {WAYS_IN.map(({ Icon, title, value, line }) => (
          <Widget key={title} icon={Icon} title={title} value={<span className="text-2xl">{value}</span>} line={line} data-way-in="" />
        ))}
      </WidgetGrid>
      <div className="mt-10">
        <DrilldownList id="jarvis" />
      </div>
      <PageFoot>
        Jev picks the action; anything that sends, pays, deletes or publishes waits for your yes. Progress moves only on confirmed events: coding from the job
        history (/__jobs), calls from the agency feed.
      </PageFoot>
    </div>
  );
}
