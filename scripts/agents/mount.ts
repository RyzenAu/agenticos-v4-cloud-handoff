import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { dataDirFor } from "../cloud/data-dir";
import { hubRole } from "../cloud/hub-role";
import { DEFAULT_ACCOUNTS, loadAccounts, type AccountsConfig } from "../coding/accounts";
import { createCodingCommandEntry } from "../coding/command-entry";
import { codingDataDir, codingRuntime, codingVoiceFor, type CodingRuntimeFull } from "../coding/plugin";
import type { CodingVoice } from "../coding/voice";
import { createArtifactStore, type ArtifactMeta } from "../computers/artifacts";
import type { ComputersService } from "../computers/service";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { safeEqual, type Principal } from "../identity/principal";
import type { JobThreads, ThreadStore } from "../jarvis-command/threads";
import type { Delegates } from "../jarvis-command/service";
import type { JobService } from "../jobs/service";
import { catalogue } from "../model-router/catalogue";
import { defaultHealthStore } from "../model-router/defaults";
import { unavailableReason } from "../model-router/health";
import { route as routerRoute } from "../model-router/router";
import { accountFacts, allCodingModels, anyAccountFacts, modelsForSlot, slotsOf, type AccountsView } from "./accounts";
import { createRoutineLinks, memorySavesFile, routineBinding, routineLinksFile, startResultMemory } from "./automation";
import type { MemoryPort } from "./brief";
import { createBotCommands, type CodingBridge } from "./jarvis";
import { createLinksStore, linksFile } from "./links";
import type { AccountFacts, ComputerFacts } from "./readiness";
import { createAgentsRoutes } from "./routes";
import { createAgentsService, type CodingSource } from "./service";
import { botsFile, createBotStore } from "./store";

/**
 * Wiring for the Agents workspace on a real hub: the real stores and services behind the bot store, the readiness derivation, the
 * validation of what a bot may point at, the task and file lists, the routes and the bot-scoped Jarvis. Everything here is an adapter; the
 * rules live in the modules it hands the adapters to, and each of those is tested with fakes.
 *
 *   createAgents(options)        builds the service, the routes and the Jarvis hooks (nothing is mounted or started)
 *   mountAgentsRoutes(server, …)  `/__agents` on the dev server (identity: scripts/identity/routes.ts, shared; writes see routes.ts)
 */

export type CreateAgentsOptions = {
  root: string;
  /** The per-run internal page token (a write carries the caller's own page token derived from it). */
  token: string;
  computers: Pick<ComputersService, "list" | "view" | "jobView" | "startJob" | "canPlanGoals" | "canResearch" | "canWorkflows">;
  conversations: ThreadStore;
  jobs: () => JobService;
  threads: JobThreads;
  /** Routine ids (trigger kind "routine"). Null: the trigger service isn't running here, so none exist. */
  routines: () => string[];
  /** Tests: the coding runtime (default: this process's own). */
  codingRuntime?: () => Promise<CodingRuntimeFull>;
  codingVoice?: () => Promise<CodingVoice>;
  /** The shared memory pool (recall for a bot with recall on, one memory per saved result for a bot with save-results on). Null/absent: neither happens, with a note. */
  memory?: () => MemoryPort | null;
  accounts?: () => AccountsConfig;
  routerCheck?: (route: string) => { ok: boolean; reason: string | null };
  role?: () => string;
  now?: () => number;
};

const within = <T>(p: Promise<T> | undefined, ms: number) => Promise.race([Promise.resolve(p).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

export function createAgents(options: CreateAgentsOptions) {
  const { root, computers } = options;
  const store = createBotStore({ file: botsFile(root), ...(options.now ? { now: options.now } : {}) });
  const links = createLinksStore({ file: linksFile(root) });
  const artifacts = createArtifactStore(join(dataDirFor(root), "computers", "artifacts"));
  const accountsConfig: () => AccountsConfig =
    options.accounts ??
    (() => {
      try {
        return loadAccounts(join(codingDataDir(root), "accounts.json"));
      } catch {
        return DEFAULT_ACCOUNTS;
      }
    });
  const runtime = options.codingRuntime ?? (() => codingRuntime(root));
  const routineLinks = createRoutineLinks(routineLinksFile(root));

  // The accounts service as the last prepare() saw it (a read never blocks on a sign-in check; the check refreshes in the background).
  let view: AccountsView | null = null;
  const forget: AccountFacts = { ready: null, label: "the coding accounts", reason: "the coding harness isn't running here" };
  async function prepare(): Promise<void> {
    const rt = await runtime().catch(() => null);
    if (!rt) return void (view = null);
    view = { accounts: rt.accounts, cliVersions: rt.cliVersions, claudeStatus: rt.claudeStatus, codexIsolationApproval: rt.codexIsolationApproval };
    void rt.claudeStatus?.refresh().catch(() => undefined);
  }

  const computerFacts = (name: string): ComputerFacts | null => {
    let v: ReturnType<typeof computers.view>;
    try {
      v = computers.view(name);
    } catch {
      return null;
    }
    return {
      exists: true,
      label: v.label,
      state: v.state,
      desired: v.desired,
      controller: { kind: v.controller.kind, who: v.controller.who, jobId: v.controller.jobId },
      takeoverPending: v.takeoverPending ? { by: v.takeoverPending.by } : null,
      failure: v.failure ? { reason: v.failure.reason } : null,
      assigned: v.assigned ? { jobId: v.assigned.jobId, title: v.assigned.title } : null,
      ...(v.screen ? { screen: { applicable: v.screen.applicable, ok: v.screen.ok, checking: v.screen.checking, reason: v.screen.reason, nextLabel: v.screen.nextLabel } } : {}),
      ...(typeof v.usable === "boolean" ? { usable: v.usable } : {}),
    };
  };

  const routerCheck =
    options.routerCheck ??
    ((routeName: string) => {
      if (routeName === "auto") return { ok: true, reason: null };
      const health = defaultHealthStore(root);
      try {
        if (routeName === "free-only") {
          routerRoute("bulk.text", { freeOnly: true, health });
          return { ok: true, reason: null };
        }
        const why = unavailableReason(health.model(routeName), Date.now());
        return why ? { ok: false, reason: why } : { ok: true, reason: null };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    });

  const codingSource = async (): Promise<CodingSource | null> => {
    const rt = await runtime().catch(() => null);
    if (!rt) return null;
    return { jobs: (limit, before) => rt.store.listJobs({ limit, ...(before !== undefined ? { before } : {}) }).map((job) => ({ job, events: rt.store.events(job.id, 0, 3000) })) };
  };

  const service = createAgentsService({
    store,
    validation: {
      computerExists: (name) => computers.list().some((c) => c.name === name),
      accountSlots: () => slotsOf(accountsConfig()),
      modelsFor: modelsForSlot,
      allModels: allCodingModels,
      routerModels: () => catalogue().models.map((m) => m.id),
      routineIds: options.routines,
      routineBotElsewhere: (routineId, exceptBot) => store.list().find((b) => b.id !== exceptBot && !b.archived && b.routines.includes(routineId))?.name ?? null,
      bots: () => store.list().map((b) => ({ id: b.id, name: b.name })),
    },
    readiness: {
      computer: computerFacts,
      codingAccount: (slot) => (view ? (slot ? accountFacts(view, slot) : anyAccountFacts(view)) : forget),
      routerCheck,
    },
    jobs: () => {
      try {
        return options.jobs();
      } catch {
        return null;
      }
    },
    computers: {
      deviceIdOf: (name) => computers.list().find((c) => c.name === name)?.id ?? null,
      artifacts: (personId) => artifacts.list(personId),
      allArtifacts: () => {
        const dir = join(dataDirFor(root), "computers", "artifacts");
        const out: ArtifactMeta[] = [];
        for (const name of existsSync(dir) ? readdirSync(dir) : []) {
          try {
            const m = JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf8")) as ArtifactMeta;
            if (m && typeof m.id === "string" && typeof m.personId === "string" && typeof m.computer === "string") out.push(m);
          } catch {
            /* a folder with no complete meta.json is not an artifact (written last) */
          }
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
    },
    coding: codingSource,
    capabilities: () => ({ research: computers.canResearch, workflows: computers.canWorkflows, computers: computers.list().map((c) => c.name), codingSlots: slotsOf(accountsConfig()) }),
    routineLinks,
    links,
    conversations: options.conversations,
    prepare,
    ...(options.now ? { now: options.now } : {}),
  });

  const routes = createAgentsRoutes({
    service,
    principal: (req) => requestPrincipal(req as never, { root }) as Principal | null,
    // The caller's own page token, or (for a founder the gate admitted to a local-owner route in the server role) the internal token the gate hands on.
    tokenOk: (req, principal) => {
      const presented = req.headers["x-claude-os-token"];
      return pageTokenMatches(principal, presented, options.token) || (typeof presented === "string" && !!presented && safeEqual(presented, options.token));
    },
    role: options.role ?? (() => hubRole()),
  });

  /**
   * The bot-scoped Jarvis hooks. `sharedCoding` is the command service's own coding delegate (same per-person voice state and "last thing said"),
   * so a draft made in a bot's conversation is started by the same "start it" as anywhere else. Absent: this module's own entry.
   */
  function botCommands(sharedCoding?: Delegates["coding"]) {
    const bridge = async (): Promise<CodingBridge | null> => {
      const rt = await runtime().catch(() => null);
      if (!rt) return null;
      const voice = await (options.codingVoice ?? (() => codingVoiceFor(root)))();
      const entry = createCodingCommandEntry({ voice, store: rt.store });
      const current: AccountsView = { accounts: rt.accounts, cliVersions: rt.cliVersions, claudeStatus: rt.claudeStatus, codexIsolationApproval: rt.codexIsolationApproval };
      return {
        handle: sharedCoding ?? ((utterance, turn) => entry.handle(utterance, turn)),
        matches: (utterance) => voice.isCodingStart(utterance, rt.registry().repos.map((r) => r.id)),
        pending: (personId, actor) => {
          const p = voice.peek({ id: personId, actor });
          if (p.draftId) return true;
          const job = p.jobId ? rt.store.getJob(p.jobId) : null;
          return !!job && (job.state === "awaiting_confirmation" || job.state === "draft");
        },
        accounts: rt.accounts,
        accountReady: async (slot) => {
          // The real sign-in check, run now (it is cached for five minutes), then the accounts service's own answer for that slot.
          await within(rt.claudeStatus?.refresh(), 20_000);
          return accountFacts(current, slot);
        },
      };
    };
    return createBotCommands({ bots: () => store.list(), computers, jobs: options.jobs, threads: options.threads, links, coding: bridge, ...(options.memory ? { memory: options.memory } : {}) });
  }

  /**
   * What the trigger engine calls (scripts/triggers, the existing scheduler: nothing new runs on a timer). A routine listed on a bot runs AS that bot:
   * its job carries the bot and lands in the conversation of the founder who linked it; a routine whose action is bot.task also starts the bot's own
   * task on its computer. Read live from the bots, so unlinking a routine stops all of it at the next run.
   */
  const binding = routineBinding(() => store.list(), routineLinks);
  const lazyCommands = (() => {
    let c: ReturnType<typeof botCommands> | null = null;
    return () => (c ??= botCommands());
  })();
  const link = (personId: string, bot: { id: string; name: string }, jobId: string, title: string) =>
    options.threads.link({ personId, bot, jobId, kind: "job", title }).catch(() => null);
  const routineHooks = {
    asBot: (trigger: { id: string }): { bot: string; personId: string } | null => {
      const b = binding(trigger.id);
      return b ? { bot: b.bot.id, personId: b.personId } : null;
    },
    onBotJob: (info: { bot: string; personId: string; jobId: string; title: string }) => {
      const b = store.get(info.bot);
      if (b) void link(info.personId, { id: b.id, name: b.name }, info.jobId, info.title);
    },
    botTask: async (input: { triggerId: string; goal: string }) => {
      const b = binding(input.triggerId);
      if (!b) return null;
      const r = await lazyCommands().routineTask({ bot: b.bot.id, personId: b.personId, goal: input.goal, routine: input.triggerId });
      if (r.ok && r.jobId) await link(b.personId, { id: b.bot.id, name: b.bot.name }, r.jobId, input.goal.slice(0, 80));
      return { ok: r.ok, said: r.said, jobId: r.jobId ?? null, bot: b.bot.name };
    },
  };

  /** Start remembering outcomes (one memory per saved result, for a bot with save-results on). Returns the stop function. */
  const startMemory = () =>
    startResultMemory({ jobs: () => { try { return options.jobs(); } catch { return null; } }, bots: () => store.list(), artifacts, memory: () => options.memory?.() ?? null, conversations: options.conversations, file: memorySavesFile(root) });

  return { store, service, routes, links, botCommands, prepare, routineHooks, startMemory };
}

export type Agents = ReturnType<typeof createAgents>;

/** Mount `/__agents`. Identity is classified in scripts/identity/routes.ts (shared) and enforced by the gate before this runs. */
export function mountAgentsRoutes(server: ViteDevServer, routes: Agents["routes"]) {
  server.middlewares.use("/__agents", (req, res, next) => void routes.handle(req, res, next));
}
