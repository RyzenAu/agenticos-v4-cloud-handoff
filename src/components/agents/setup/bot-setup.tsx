// The Setup tab for one bot (Agents workspace). A founder edits the bot's purpose and instructions, computer, model and
// account, skills, routines and memory behaviour; every control persists through PATCH /__agents/bots/:id with the
// rev it was looking at. The shell (B3) mounts <BotSetup botId=... navigate=... />; nothing else is needed.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Skeleton, Surface } from "@/components/ds";
import { agentBots, botQueryKeys, type AgentBotsClient, type BotId } from "@/lib/agent-bots";
import { ArchivedNotice, ManageSection, RecentChanges } from "./manage-section";
import { ComputerSection, ConflictNotice, MemorySection, ModelSection, type Navigate, PurposeSection, ReadinessCard, RoutinesSection, SetupNav, SkillsSection } from "./sections";
import { createSetupController, workspaceDrafts } from "./setup-controller";
import { SECTION_IDS, cardReasons, linkedRoutineNames, skillsSectionShown, type RecoveryAction, type SectionKey } from "./setup-model";
import { liveSources, type SetupSources } from "./sources";

export type BotSetupProps = {
  botId: BotId;
  /** Defaults to the real `/__agents/bots` client; a page or test may hand in the fake. */
  client?: AgentBotsClient;
  /** Defaults to the real services; each is read, never copied. */
  sources?: SetupSources;
  /** Deep links (Computers, Automations). Defaults to a plain page load; the shell passes its router's navigate. */
  navigate?: Navigate;
};

const defaultNavigate: Navigate = (to) => window.location.assign(to);

/** Moves to a section and lands on its first usable control, so a keyboard user isn't left at the top. */
export function focusSection(key: SectionKey) {
  const el = document.getElementById(SECTION_IDS[key]);
  if (!el) return;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  const target = el.querySelector<HTMLElement>("select:not([disabled]), textarea:not([disabled]), input:not([disabled]), button[role=switch]:not([disabled])") ?? el.querySelector<HTMLElement>("h2");
  target?.focus({ preventScroll: true });
}

function useSource<T>(name: keyof SetupSources, sources: SetupSources) {
  return useQuery({ queryKey: ["agent-setup", name], queryFn: () => (sources[name] as () => Promise<T>)(), staleTime: 20_000 });
}

function Pending({ title }: { title: string }) {
  return (
    <Surface as="section" aria-busy="true" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold leading-snug">{title}</h2>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-10 w-full" />
    </Surface>
  );
}

export function BotSetup({ botId, client = agentBots, sources = liveSources, navigate = defaultNavigate }: BotSetupProps) {
  const controller = useMemo(() => createSetupController({ botId, client, draftStore: workspaceDrafts }), [botId, client]);
  const s = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const qc = useQueryClient();
  useEffect(() => {
    void controller.load();
  }, [controller]);
  // Tell the shell's selector and status line that this bot changed.
  const saveStamp = Math.max(0, ...Object.values(s.savedAt).map((v) => v ?? 0));
  useEffect(() => {
    if (saveStamp) void qc.invalidateQueries({ queryKey: botQueryKeys.all });
  }, [saveStamp, qc]);

  const computers = useSource<Awaited<ReturnType<SetupSources["computers"]>>>("computers", sources);
  const accounts = useSource<Awaited<ReturnType<SetupSources["accounts"]>>>("accounts", sources);
  const router = useSource<Awaited<ReturnType<SetupSources["router"]>>>("router", sources);
  const skills = useSource<Awaited<ReturnType<SetupSources["skills"]>>>("skills", sources);
  const routines = useSource<Awaited<ReturnType<SetupSources["routines"]>>>("routines", sources);
  const memory = useSource<Awaited<ReturnType<SetupSources["memory"]>>>("memory", sources);

  if (s.load === "loading" && !s.bot) {
    return (
      <div data-testid="bot-setup" aria-busy="true" className="flex max-w-[46rem] flex-col gap-6">
        <Pending title="Setup" />
        <Pending title="Purpose and instructions" />
      </div>
    );
  }
  if (!s.bot) {
    return (
      <div data-testid="bot-setup" className="max-w-[46rem]">
        <EmptyState title={s.load === "missing" ? "This bot isn't on this hub" : "Setup isn't available"} body={s.loadError ?? "The Agents service didn't answer."} action={s.load === "missing" ? undefined : <Button type="button" variant="outline" onClick={() => void controller.load()}>Try again</Button>} />
      </div>
    );
  }

  const bot = s.bot;
  const busy = s.saving !== null;
  const archived = bot.lifecycle === "archived" || bot.lifecycle === "archiving";
  // A pending conflict blocks every write; an archived bot's settings are read-only until it is unarchived.
  const locked: boolean | string = s.conflict !== null ? true : archived ? "Archived: unarchive this bot to change its settings." : false;
  const status = (k: SectionKey) => ({ saving: s.saving === k, savedAt: s.savedAt[k] ?? null, error: s.errors[k] ?? null });
  const common = (k: SectionKey) => ({ bot, busy: busy || s.manage.busy !== null, locked, status: status(k), save: (section: SectionKey, patch: Parameters<typeof controller.save>[1]) => void controller.save(section, patch) });
  const onAction = (a: RecoveryAction) => (a.retry ? void controller.reload() : a.section ? focusSection(a.section) : a.to ? navigate(a.to) : undefined);
  // The routines an archived bot released, by name; one deleted since is said so rather than shown as a raw id.
  const known = routines.data?.status === "ok" ? routines.data.routines : null;
  const releasedNames = known ? (bot.releasedRoutines ?? []).map((id) => known.find((r) => r.id === id)?.name ?? "a routine that no longer exists") : null;
  const hasDrafts = Object.keys(s.drafts).length > 0;
  const omit: SectionKey[] = skillsSectionShown(bot) ? [] : ["skills"];
  // The page's header already says a bot has no computer, with its one action; the card is only for what it can't say.
  const reasonsLeft = cardReasons(bot.readiness.reasons);
  const showCard = s.readinessStale || (!archived && bot.readiness.state !== "ready" && reasonsLeft.length > 0);
  const botList = qc.getQueryData<{ status: string; bots?: Array<{ id: string; name: string }> }>(["agent-bots"]);
  const botName = (id: string) => botList?.bots?.find((b) => b.id === id)?.name ?? id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

  return (
    <div data-testid="bot-setup" data-bot={bot.id} className="grid w-full gap-6 xl:grid-cols-[minmax(0,44rem)_16rem] xl:gap-10">
      <aside className="flex flex-col gap-4 xl:col-start-2 xl:row-start-1 xl:sticky xl:top-6 xl:self-start">
        {showCard ? <ReadinessCard bot={{ ...bot, readiness: { ...bot.readiness, reasons: reasonsLeft } }} stale={s.readinessStale} onAction={onAction} omit={omit} /> : <SetupNav onAction={onAction} omit={omit} className="flex flex-row flex-wrap gap-x-5 gap-y-1 text-sm xl:flex-col xl:gap-y-0.5 xl:border-l xl:border-border xl:pl-4" />}
        {s.conflict && <ConflictNotice conflict={s.conflict} bot={bot} hasDrafts={hasDrafts} onReload={() => void controller.reload()} />}
      </aside>
      <div className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-1">
        {archived && <ArchivedNotice bot={bot} busy={s.manage.busy !== null || s.conflict !== null} onUnarchive={() => void controller.unarchive()} />}
        <PurposeSection {...common("purpose")} drafts={s.drafts} onDraft={controller.setDraft} onDiscard={controller.discardDraft} onSave={() => void controller.savePurpose()} />
        {computers.data ? <ComputerSection {...common("computer")} computers={computers.data} navigate={navigate} /> : <Pending title="Computer" />}
        {router.data && accounts.data ? <ModelSection {...common("model")} router={router.data} accounts={accounts.data} /> : <Pending title="Model and account" />}
        {skills.data && computers.data ? <SkillsSection bot={bot} status={status("skills")} skills={skills.data} computers={computers.data} /> : <Pending title="What this bot can do" />}
        {routines.data ? <RoutinesSection {...common("routines")} routines={routines.data} navigate={navigate} /> : <Pending title="Routines" />}
        {memory.data ? <MemorySection {...common("memory")} memory={memory.data} /> : <Pending title="Memory" />}
        <ManageSection
          bot={bot}
          manage={s.manage}
          locked={s.conflict !== null}
          status={status("manage")}
          onDuplicate={() => void controller.duplicate()}
          onAskArchive={() => void controller.askArchive()}
          onCancel={controller.cancelArchive}
          onArchive={(o) => void controller.archive(o)}
          onUnarchive={() => void controller.unarchive()}
          onOpen={(id) => navigate(`/agents/workspace/${id}?tab=setup`)}
          onDismissCopy={controller.dismissDuplicated}
          routines={routines.data ? linkedRoutineNames(routines.data, bot.routines) : bot.routines}
          releasedNames={releasedNames}
          botName={botName}
        />
        <RecentChanges bot={bot} />
      </div>
    </div>
  );
}
