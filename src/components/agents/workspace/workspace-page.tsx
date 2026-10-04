// Jarvis > Agents: one workspace per bot. Choose a bot, type or speak, see the work, inspect its computer, take over, reopen the saved result.
//   wide (>= 1360 px): a persistent bot list on the left (BotRail), the bot's header and tabs on the right, filling the window so the composer is always in view.
//   narrower:          the compact selector row above the same header.
// The bot's live computer is not a tab of its own: it sits beside the conversation (a resizable panel on desktop, a Conversation / Computer switch on
// tablet and phone), so the chat's draft, scroll and stream are never lost to look at the screen. `?tab=computer` still opens the conversation
// with the computer showing. The URL is the state (`/agents/workspace/<bot>?tab=…`).
// Ideas borrowed (behaviour only, no code): Open Dot's bot header with one live status line; Rakazo's persistent bot list with live state and its
// conversation beside its computer. The status is said once, in the header; the list shows only a few words.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, Notice, PageFoot, Skeleton, TabPanel, Tabs } from "@/components/ds";
import { cn } from "@/lib/utils";
import { codingClient } from "@/lib/coding-client";
import { readComputers } from "@/lib/computers-client";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import { useMe } from "@/lib/use-devices";
import { useComputerJob } from "@/components/computers/computers-page";
import { TasksTab } from "@/components/agents/tasks/tasks-tab";
import { BotPanels, BotRail, BotSelector, initialOf, type BotPanel } from "./bot-selector";
import { TAB_LABEL, WORKSPACE_TABS, computerForBot, readBots, workspaceHref, type Bot, type WorkspaceTab } from "./bots";
import { Conversation } from "./layout/conversation";
import { WorkspaceStage, inertProps } from "./stage";
import { resolveTab } from "./layout/deep-link";
import { SetupSlot } from "./slots";
import { recentWork } from "./recent";
import { TONE_DOT, deriveBotStatus, statusAction, statusActionVisible, type BotStatusKind } from "./status";

const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const ID_BASE = "agents-ws";
/** The Computer tab folded into the conversation; its deep link opens the panel instead. */
const NAV_TABS = WORKSPACE_TABS.filter((t) => t !== "computer");
/** The bot list sits beside the workspace from here up; below it the compact selector row stands in. */
export const RAIL_AT = 1400;

/** True while the window is at least `px` wide. Read once up front so the first paint already has the right list. */
function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, [query]);
  return on;
}

/** Fills the window below wherever the page starts (a banner above it moves that), so the composer is never pushed under the fold. */
function useFillWindow(on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(544, Math.round(window.innerHeight - top - 24))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    watch?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", fit);
      watch?.disconnect();
      el.style.height = "";
    };
  }, [on]);
  return ref;
}

export function AgentsWorkspacePage({ botId, tab }: { botId?: string; tab: WorkspaceTab }) {
  const navigate = useNavigate();
  const railed = useMinWidth(RAIL_AT);
  const [panel, setPanel] = useState<BotPanel>(null);
  // Where the conversation puts its computer controls: on the tab row, so the header stays two lines.
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  // The computer is full screen: everything outside its overlay is inert, so focus cannot wander behind it. Whether it is showing at all
  // tells the status action if it still has something to open.
  const [fullScreen, setFullScreen] = useState(false);
  const [computerShown, setComputerShown] = useState(false);
  const inertWhile = inertProps;
  const botsQ = useQuery({ queryKey: ["agent-bots"], queryFn: readBots, staleTime: 10_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: false });
  useStreamInvalidate([["computers"]], ["computer", "lease", "device"], { debounceMs: 100 });
  const computersQ = useQuery({ queryKey: ["computers"], queryFn: readComputers, staleTime: 2_000, refetchInterval: streamRefetchInterval(30_000, 4_000), refetchIntervalInBackground: false, retry: false });
  const meQ = useMe();
  const me = meQ.data?.id ?? null;
  const nameOf = (id: string) => (meQ.data && id === meQ.data.id ? meQ.data.name : cap(id));

  const bots = botsQ.data?.status === "ok" ? botsQ.data.bots : [];
  const wanted = botId ? bots.find((b) => b.id === botId) ?? null : bots[0] ?? null;
  const bot = wanted;
  const computers = computersQ.data?.status === "ok" ? computersQ.data.computers : [];
  const computerReason = computersQ.data?.status === "unavailable" ? computersQ.data.reason : null;
  const computer = bot ? computerForBot(bot, computers) : null;
  const job = useComputerJob(computer ?? { assigned: null, paused: null, lastJob: null });
  const anyCoding = bots.some((b) => b.coding.enabled);
  const codingQ = useQuery({ queryKey: ["agent-coding"], queryFn: () => codingClient.list(), enabled: anyCoding, staleTime: 3_000, refetchInterval: streamRefetchInterval(20_000, 6_000), refetchIntervalInBackground: false, retry: false });
  const coding = codingQ.data?.jobs ?? null;

  const statuses = useMemo(() => {
    const out: Record<string, ReturnType<typeof deriveBotStatus>> = {};
    for (const b of bots) out[b.id] = deriveBotStatus({ bot: b, computer: computerForBot(b, computers), job: bot && b.id === bot.id ? job : null, coding, me, nameOf });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, computers, job, coding, me, meQ.data, bot?.id]);
  const recent = useMemo(() => recentWork({ bots, computers, coding }), [bots, computers, coding]);
  const openRecent = (href: string) => void navigate({ href } as never);
  const kinds = Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v.kind])) as Record<string, BotStatusKind>;
  const status = bot ? statuses[bot.id] : null;

  // A link to the computer lands on the conversation with the computer showing (once), then the URL says plain Chat.
  const { shown: shownTab, openComputer } = resolveTab(tab);
  const goTab = (t: WorkspaceTab) => void navigate({ ...workspaceHref(bot?.id ?? botId, t), replace: true } as never);
  const goBot = (id: string) => {
    setPanel(null);
    void navigate({ ...workspaceHref(id, tab), replace: false } as never);
  };
  // R11: while the computer shows beside the chat, the bot list steps aside for the compact selector row, so the live desktop gets the room.
  const showRail = railed && !computerShown;
  const ready = !botsQ.isLoading && botsQ.data?.status === "ok" && bots.length > 0;
  const rootRef = useFillWindow(ready);

  return (
    <div
      ref={rootRef}
      className={cn("flex min-w-0 flex-col [overflow-wrap:anywhere]", ready && "h-[calc(100dvh-8rem)] min-h-[34rem]")}
      data-agents-workspace
      data-bot={bot?.id ?? ""}
      data-tab={tab}
    >
      <h1 className="sr-only">Agents</h1>
      {botsQ.isLoading ? (
        <div role="status" aria-busy="true" aria-label="Reading the agents" className="flex flex-col gap-4" data-testid="agents-loading">
          <Skeleton className="h-10 w-64 rounded-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : botsQ.data?.status === "unavailable" ? (
        <Notice
          tone="info"
          title="Agents aren't available"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void botsQ.refetch()}>
              Try again
            </Button>
          }
        >
          {botsQ.data.reason} Nothing is listed until the hub reports.
        </Notice>
      ) : bots.length === 0 ? (
        <EmptyState title="No agents yet" body="Agents appear here once the hub has any. Shared computers are managed in Computers." action={<Button asChild variant="outline"><Link to="/computers">Open Computers</Link></Button>} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-6">
          {showRail && (
            <div className="flex min-h-0 w-56 shrink-0 flex-col" {...inertWhile(fullScreen)}>
              <BotRail bots={bots} value={bot?.id ?? ""} statuses={statuses} onChange={goBot} panel={panel} onPanel={setPanel} recent={recent} onOpenRecent={openRecent} />
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 sm:gap-3">
            {!showRail && (
              <div {...inertWhile(fullScreen)}>
                <BotSelector bots={bots} value={bot?.id ?? ""} kinds={kinds} onChange={goBot} panel={panel} onPanel={setPanel} recent={recent} onOpenRecent={openRecent} />
              </div>
            )}
            {botId && !wanted && (
              <Notice tone="warn" title={`There is no agent called "${botId}"`}>Pick one from the list. The link may be old or mistyped.</Notice>
            )}
            <WorkspaceStage panel={panel ? <BotPanels panel={panel} onPanel={setPanel} bots={bots} onChange={goBot} /> : null}>
            {bot && status && (
              <>
                <div className="flex min-w-0 flex-col gap-2 sm:gap-3" {...inertWhile(fullScreen)}>
                {/* R11 visual pass: one compact line — the bot, its one status and the one next step. The purpose is in Setup and on hover. */}
                <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full border border-brand/60 bg-inset text-base font-semibold text-brand lg:hidden">{initialOf(bot.name)}</span>
                    <h2 className="ds-page-title min-w-0 truncate leading-tight text-foreground" title={bot.purpose || undefined}>{bot.name}</h2>
                    {bot.purpose && <p className="sr-only">{bot.purpose}</p>}
                  </div>
                  <p className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 text-sm" role="status" data-testid="bot-status" data-status={status.kind}>
                    <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", TONE_DOT[status.tone])} />
                    <span className="min-w-0">{status.text}</span>
                  </p>
                  {(() => {
                    const act = statusAction(status, bot);
                    return statusActionVisible(act, shownTab as "chat" | "tasks" | "setup", computerShown) ? (
                      <Button type="button" variant="outline" size="sm" data-testid="status-action" onClick={() => goTab(act.tab)}>
                        {act.label}
                      </Button>
                    ) : null;
                  })()}
                </header>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <Tabs tabs={NAV_TABS.map((t) => ({ id: t, label: TAB_LABEL[t] }))} value={shownTab} onChange={goTab} idBase={ID_BASE} label={`${bot.name} workspace`} />
                  <div ref={setToolbarHost} className="flex min-w-0 items-center gap-2" data-testid="workspace-toolbar" />
                </div>
                </div>
                {NAV_TABS.map((t) => (
                  <TabPanel key={t} idBase={ID_BASE} id={t} active={t === shownTab} className={cn(t === shownTab && "flex min-h-0 flex-1 flex-col", t !== "chat" && "overflow-y-auto pb-6")}>
                    {t === shownTab && <TabBody key={bot.id} tab={t} bot={bot} computer={computer} computerReason={computerReason} me={me} nameOf={nameOf} status={status} onTab={goTab} openComputer={openComputer} onComputerOpened={() => goTab("chat")} toolbarHost={toolbarHost} onExpandedChange={setFullScreen} onComputerShownChange={setComputerShown} />}
                  </TabPanel>
                ))}
              </>
            )}
            </WorkspaceStage>
            {botsQ.data?.status === "ok" && botsQ.data.source === "computers" && (
              <PageFoot>The agents service isn't on this hub yet, so these agents are the shared computers named Research and Builder. Tasks come from the jobs and coding services.</PageFoot>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabBody({ tab, bot, computer, computerReason, me, nameOf, status, onTab, openComputer, onComputerOpened, toolbarHost, onExpandedChange, onComputerShownChange }: { onExpandedChange: (b: boolean) => void; onComputerShownChange: (b: boolean) => void; openComputer: boolean; onComputerOpened: () => void; toolbarHost: HTMLElement | null; tab: WorkspaceTab; bot: Bot; computer: ReturnType<typeof computerForBot>; computerReason: string | null; me: string | null; nameOf: (id: string) => string; status: ReturnType<typeof deriveBotStatus>; onTab: (t: WorkspaceTab) => void }) {
  if (tab === "chat") return <Conversation bot={bot} status={status} computer={computer} computerReason={computerReason} me={me} nameOf={nameOf} openComputer={openComputer} onComputerOpened={onComputerOpened} toolbarHost={toolbarHost} onExpandedChange={onExpandedChange} onComputerShownChange={onComputerShownChange} />;
  if (tab === "setup") return <SetupSlot bot={bot} status={status} />;
  return <TasksTab bot={bot} computer={computer} onTab={onTab} />;
}
