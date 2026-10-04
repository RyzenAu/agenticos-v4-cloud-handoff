// Jarvis: talk, hand off work and watch it run.
//
// R11 (owner: "conversation and useful results should dominate"): the page is the Jarvis thread (jarvis-thread.tsx) with the
// composer pinned under it, using the same command path the request box always used. Hand-offs and agent questions are a slim
// side column that is not there at all when both are empty. The daily status (the HUD) and the workflow previews are secondary
// views, not folded sections in the flow; the sidebar already lists the other Jarvis pages, so the row of links is gone.
// The Jev track can still fill the panel slot above the thread with its own surface (see ../jarvis-slot.tsx).
import { useEffect, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import { Button, DeviceStatusSlot, PageFoot, PageHeader, Segmented, TaskBar, TaskWord, WidgetGrid, WidgetList, WidgetRow } from "@/components/ds";
import { JarvisHudBody, useJarvisHud } from "@/components/operator/jarvis-hud";
import { AgentQuestionsPanel } from "@/components/operator/agent-jobs-panel";
import { FEED_STATUS_LABEL, feedStatus, readFeed, subscribeFeed, type FeedTask } from "@/lib/agent-feed";
import { JarvisPanelSlot } from "../jarvis-slot";
import { activeDevice, deviceSlotInput, useDevices } from "@/lib/use-devices";
import { ProgressPanel } from "../progress-panel";
import { JarvisThread, readJarvisThread } from "./jarvis-thread";
import { handoffStatus } from "@/lib/handoff-status";
import { useQuery } from "@tanstack/react-query";
import { ChatComputerLayout } from "@/components/agents/workspace/layout/chat-computer-layout";
import { ComputerTab } from "@/components/agents/computer/computer-tab";
import { readComputers, type ComputerView } from "@/lib/computers-client";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import { useMe } from "@/lib/use-devices";
import "./jarvis-page.css";

/** How many hand-offs show before the rest fold into "Show all". */
export const HANDOFFS_SHOWN = 3;

function HandoffRow({ t }: { t: FeedTask }) {
  const status = feedStatus(t);
  // Start -> progress -> complete (src/lib/ui-motion.ts): the bar slides while the length is unknown and
  // the tick lands once when the confirming event arrives. A run that stopped for his yes is "waiting".
  // A hand-off that started a job follows THAT job through the conversation: "Done" only when it finished; a stopped job says Stopped.
  const thread = useQuery({ queryKey: ["jarvis-thread"], queryFn: readJarvisThread, staleTime: 5_000 });
  const { phase, word } = handoffStatus(status, FEED_STATUS_LABEL[status], t.result, thread.data ?? []);
  return (
    <WidgetRow
      title={t.title}
      meta={
        <>
          {t.agent} · {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
          <TaskBar phase={phase} label={`${t.title}: ${word}`} className="mt-2" />
        </>
      }
      aside={<TaskWord phase={phase} word={word} className="text-sm" />}
    />
  );
}

function HudDetails() {
  const hud = useJarvisHud(true);
  return <JarvisHudBody data={hud} />;
}

/** Fills the window below wherever the page starts (lg and up), so the composer sits at the bottom and the thread scrolls. */
function useFillWindow(on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof window === "undefined" || !window.matchMedia?.("(min-width: 1024px)").matches) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(480, Math.round(window.innerHeight - top - 24))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    // The header grows once the device line arrives; re-fit whenever the page's layout moves.
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    watch?.observe(document.body);
    return () => {
      window.removeEventListener("resize", fit);
      watch?.disconnect();
      el.style.height = "";
    };
  }, [on]);
  return ref;
}

/** The shared computer the pane shows: the one doing something now, else the first. Pure. */
export function paneComputer(computers: readonly ComputerView[]): ComputerView | null {
  return computers.find((c) => c.state === "busy" || !!c.assigned) ?? computers.find((c) => c.state === "online") ?? computers[0] ?? null;
}

type JarvisView = "conversation" | "today" | "previews";
const VIEWS = [
  { value: "conversation", label: "Thread" },
  { value: "today", label: "Daily status" },
  { value: "previews", label: "Previews" },
] as const;

export function JarvisPage() {
  const [tasks, setTasks] = useState<FeedTask[]>([]);
  const [allHandoffs, setAllHandoffs] = useState(false);
  const [view, setView] = useState<JarvisView>("conversation");
  const devices = useDevices();
  const fill = useFillWindow(view === "conversation");
  // The computer is an optional, resizable companion pane beside the conversation (the same layout the Agents workspace uses).
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  useStreamInvalidate([["computers"]], ["computer", "lease", "device"], { debounceMs: 100 });
  const computersQ = useQuery({ queryKey: ["computers"], queryFn: readComputers, staleTime: 2_000, refetchInterval: streamRefetchInterval(30_000, 4_000), refetchIntervalInBackground: false, retry: false });
  const computers = computersQ.data?.status === "ok" ? computersQ.data.computers : [];
  const computer = paneComputer(computers);
  // The pane layout depends on the window's width, which the server can't know: it mounts after hydration (the thread alone until then),
  // so a phone never keeps the server's side-by-side markup.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const meQ = useMe();
  const nameOf = (id: string) => (meQ.data && id === meQ.data.id ? meQ.data.name : id.charAt(0).toUpperCase() + id.slice(1));
  useEffect(() => {
    setTasks(readFeed());
    return subscribeFeed(setTasks);
  }, []);
  const shown = allHandoffs ? tasks : tasks.slice(0, HANDOFFS_SHOWN);
  const folded = tasks.slice(HANDOFFS_SHOWN);
  return (
    <div className="jv-page flex min-w-0 flex-col [overflow-wrap:anywhere]">
      <PageHeader
        title="Jarvis"
        spacing="tight"
        meta={devices.data ? <DeviceStatusSlot device={deviceSlotInput(activeDevice(devices.data))} /> : devices.isError ? <span className="text-xs text-muted-foreground">Devices not readable</span> : undefined}
        actions={
          <>
            <div ref={setToolbarHost} className={view === "conversation" ? "flex items-center gap-2" : "hidden"} data-testid="jarvis-toolbar" />
            <Segmented<JarvisView> ariaLabel="Jarvis view" value={view} onChange={setView} options={VIEWS} />
          </>
        }
      />
      {view === "conversation" && (
        <div ref={fill} className="flex min-h-[28rem] min-w-0 flex-col gap-4 xl:flex-row xl:gap-6">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <JarvisPanelSlot fallback={null} />
            {!mounted ? (
              <JarvisThread />
            ) : (
            <ChatComputerLayout
              botName="Jarvis"
              hasComputer={!!computer}
              computerLabel={computer ? computer.label || computer.name : "Computer"}
              toolbarHost={toolbarHost}
              chat={<JarvisThread />}
              renderComputer={() => (
                <ComputerTab compact botName="Jarvis" computerName={computer?.name ?? null} computer={computer} me={meQ.data?.id ?? null} nameOf={nameOf} unavailable={computersQ.data?.status === "unavailable" ? computersQ.data.reason : null} />
              )}
            />
            )}
          </div>
          {/* Above the thread on narrow screens, a slim column on wide ones; nothing at all when both are empty. */}
          <aside className="order-first flex min-w-0 flex-col gap-4 empty:hidden xl:order-none xl:w-[22rem] xl:shrink-0 xl:overflow-y-auto" aria-label="Hand-offs and questions">
            {tasks.length > 0 && (
              <WidgetList
                icon={ListChecks}
                title="Handed-off work"
                span={4}
                badge={tasks.length}
                action={
                  folded.length > 0 ? (
                    <Button variant="ghost" size="sm" aria-expanded={allHandoffs} onClick={() => setAllHandoffs((v) => !v)}>
                      {allHandoffs ? "Show fewer" : <>Show all {tasks.length}</>}
                    </Button>
                  ) : undefined
                }
              >
                {shown.map((t) => (
                  <HandoffRow key={t.id} t={t} />
                ))}
              </WidgetList>
            )}
            <AgentQuestionsPanel hideWhenEmpty compact />
          </aside>
        </div>
      )}
      {view === "today" && (
        <div className="sh-hud-card jv-hud max-w-2xl">
          <HudDetails />
          <p className="mt-3 text-sm text-muted-foreground">
            Alt+Shift+J opens the HUD. Alt+Shift+I opens diagnostics. Away mode uses your configured Telegram connection.
          </p>
        </div>
      )}
      {view === "previews" && (
        <WidgetGrid>
          <ProgressPanel />
        </WidgetGrid>
      )}
      {view !== "conversation" && <PageFoot>Anything that sends, pays, deletes or publishes waits for your yes.</PageFoot>}
    </div>
  );
}
