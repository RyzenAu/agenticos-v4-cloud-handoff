// The bots the workspace lists. Source of truth is the agents service (GET /__agents/bots, B1). Until that is on the hub this reads the
// shared computers and offers the two seeded bots (Research, Builder) over the computers that carry their names, and SAYS so.
// Personal PCs are never bots and never appear here: a bot's computer must be a shared computer.
import { readComputers, type ComputerView } from "@/lib/computers-client";

export type BotId = string;
export type BotReadinessState = "ready" | "working" | "needs-you" | "offline" | "unconfigured";
/** active, archived, or archived with its earlier jobs still finishing (the hub works this out from the bot's open work). */
export type BotLifecycle = "active" | "archiving" | "archived";
export type Bot = {
  id: BotId;
  name: string;
  purpose: string;
  /** The version the agents service holds; an unarchive from the list is checked against it. Absent from the computers fallback. */
  rev?: number;
  /** Absent means active. */
  lifecycle?: BotLifecycle;
  archived?: { at: number; by: string; afterCurrentWork: boolean } | null;
  /** The other bots using the same shared computer (they share its one control lease: one task at a time, no queue). */
  sharesComputerWith?: Array<{ id: BotId; name: string; archived: boolean }>;
  /** The shared computer's name (scripts/computers store), or null when the bot has none. */
  computer: string | null;
  coding: { enabled: boolean; accountSlot: string | null; model: string | null };
  /** Present when the agents service sent one; otherwise derived live in the workspace. */
  readiness?: { state: BotReadinessState; reasons: string[] };
};
export type BotsRead = { status: "ok"; bots: Bot[]; source: "agents-service" | "computers" } | { status: "unavailable"; reason: string };

/** The seeded pair, used only while the agents service isn't there. */
export const SEEDED_BOTS: readonly Omit<Bot, "computer">[] = [
  { id: "research", name: "Research", purpose: "Looks things up on its own computer and saves what it finds.", coding: { enabled: false, accountSlot: null, model: null } },
  { id: "builder", name: "Builder", purpose: "Builds and fixes things: coding jobs, then checks the result.", coding: { enabled: true, accountSlot: null, model: null } },
];

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const asText = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Pure: one bot from what the agents service sent. Null when it isn't a usable row. */
export function botFromService(raw: unknown): Bot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asText(r.id, 32);
  if (!BOT_ID.test(id)) return null;
  const coding = (r.coding && typeof r.coding === "object" ? r.coding : {}) as Record<string, unknown>;
  const rd = r.readiness && typeof r.readiness === "object" ? (r.readiness as Record<string, unknown>) : null;
  const states: BotReadinessState[] = ["ready", "working", "needs-you", "offline", "unconfigured"];
  const archivedRaw = r.archived && typeof r.archived === "object" ? (r.archived as Record<string, unknown>) : null;
  const archived = archivedRaw && typeof archivedRaw.at === "number" ? { at: archivedRaw.at, by: asText(archivedRaw.by, 40), afterCurrentWork: archivedRaw.afterCurrentWork === true } : null;
  const lifecycle: BotLifecycle = r.lifecycle === "archiving" || r.lifecycle === "archived" ? r.lifecycle : archived ? "archived" : "active";
  const shared = (Array.isArray(r.sharesComputerWith) ? r.sharesComputerWith : []).flatMap((x) => {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    return o && typeof o.id === "string" && typeof o.name === "string" ? [{ id: o.id, name: asText(o.name, 60), archived: o.archived === true }] : [];
  });
  return {
    id,
    name: asText(r.name, 60) || id.charAt(0).toUpperCase() + id.slice(1),
    purpose: asText(r.purpose, 300),
    ...(typeof r.rev === "number" ? { rev: r.rev } : {}),
    lifecycle,
    archived,
    sharesComputerWith: shared,
    computer: typeof r.computer === "string" && r.computer ? r.computer : null,
    coding: { enabled: coding.enabled === true, accountSlot: typeof coding.accountSlot === "string" ? coding.accountSlot : null, model: typeof coding.model === "string" ? coding.model : null },
    ...(rd && states.includes(rd.state as BotReadinessState) ? { readiness: { state: rd.state as BotReadinessState, reasons: Array.isArray(rd.reasons) ? rd.reasons.filter((x): x is string => typeof x === "string").slice(0, 4) : [] } } : {}),
  };
}

/** Pure: the seeded pair over the shared computers that carry their names (a bot with no such computer has none, and says so). */
export function seededBots(computers: readonly Pick<ComputerView, "name" | "kind" | "owner">[]): Bot[] {
  const shared = new Set(computers.filter((c) => c.kind === "cloud-computer" && c.owner === "shared").map((c) => c.name));
  return SEEDED_BOTS.map((b) => ({ ...b, computer: shared.has(b.id) ? b.id : null }));
}

export async function readBots(): Promise<BotsRead> {
  try {
    const r = await fetch("/__agents/bots", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const body = (await r.json().catch(() => null)) as { bots?: unknown[] } | null;
      if (body && Array.isArray(body.bots)) {
        // Active bots first (the page opens on the first one, and the hub never lets the last active bot be archived), then the archived, in the hub's order.
        const bots = sortActiveFirst(body.bots.map(botFromService).filter((b): b is Bot => !!b));
        return { status: "ok", bots, source: "agents-service" };
      }
    }
    if (r.status === 401 || r.status === 403) return { status: "unavailable", reason: "Sign in as a founder to see the agents." };
  } catch {
    /* fall through: the computers service may still answer */
  }
  const c = await readComputers();
  if (c.status === "unavailable") return { status: "unavailable", reason: c.reason };
  return { status: "ok", bots: seededBots(c.computers), source: "computers" };
}

/** Pure: is this bot taking requests? An archived bot, and one finishing its last jobs, is not. */
export const isArchivedBot = (b: Pick<Bot, "lifecycle">) => b.lifecycle === "archived" || b.lifecycle === "archiving";

/** Pure: active bots first, each group keeping the order it came in. */
export function sortActiveFirst<T extends Pick<Bot, "lifecycle">>(bots: readonly T[]): T[] {
  return [...bots.filter((b) => !isArchivedBot(b)), ...bots.filter(isArchivedBot)];
}

/** Pure: the bot a shared computer belongs to (for "Open in workspace" links), or null. An active bot is preferred over an archived one. */
export function botForComputer(bots: readonly Bot[], computerName: string): Bot | null {
  const on = bots.filter((b) => b.computer === computerName);
  return on.find((b) => !isArchivedBot(b)) ?? on[0] ?? null;
}

/** Pure: the bot whose computer ran this job (a job's targetDeviceId is the computer's device id), or null. */
export function botForJob(bots: readonly Bot[], computers: readonly Pick<ComputerView, "name" | "id">[], job: { targetDeviceId?: string; kind?: string }): Bot | null {
  if (job.kind === "coding") return bots.find((b) => b.coding.enabled && !isArchivedBot(b)) ?? bots.find((b) => b.coding.enabled) ?? null;
  const c = job.targetDeviceId ? computers.find((x) => x.id === job.targetDeviceId) : undefined;
  return c ? botForComputer(bots, c.name) : null;
}

/** Pure: the computer a bot works on, only if it is a shared computer. A personal PC is never returned. */
export function computerForBot(bot: Pick<Bot, "computer">, computers: readonly ComputerView[]): ComputerView | null {
  if (!bot.computer) return null;
  const c = computers.find((x) => x.name === bot.computer);
  return c && c.kind === "cloud-computer" && c.owner === "shared" ? c : null;
}

export const WORKSPACE_TABS = ["chat", "computer", "tasks", "setup"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const TAB_LABEL: Record<WorkspaceTab, string> = { chat: "Chat", computer: "Computer", tasks: "Tasks & Files", setup: "Setup" };

/** Pure: the tab a `?tab=` names; anything else is Chat. */
export function parseTab(v: unknown): WorkspaceTab {
  return typeof v === "string" && (WORKSPACE_TABS as readonly string[]).includes(v) ? (v as WorkspaceTab) : "chat";
}

/** Pure: the workspace URL for a bot and tab (the one place links are built, so deep links can't drift). */
export function workspaceHref(botId?: string | null, tab: WorkspaceTab = "chat"): { to: string; params?: { botId: string }; search: { tab: WorkspaceTab } } {
  return botId ? { to: "/agents/workspace/$botId", params: { botId }, search: { tab } } : { to: "/agents/workspace", search: { tab } };
}
