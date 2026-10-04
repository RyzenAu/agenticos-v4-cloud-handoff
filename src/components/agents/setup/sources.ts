// What the Setup tab READS from the services that already own the facts. Nothing here is stored or copied: the shared
// computers, the coding accounts, the model router, the skills, the routines and the memory pool each stay the single
// source of truth, and every read answers `unavailable` with a reason rather than inventing a row.
import { readComputers, type ComputersRead } from "@/lib/computers-client";
import { codingClient, type CodingAccount, type CodingAccounts } from "@/lib/coding-client";
import { operatorRequest } from "@/lib/operator";
import type { ModelRouterView } from "../../../../scripts/model-router/api";
import { catalogueLabel } from "../../../../scripts/model-router/pickers";

export type Read<T> = ({ status: "ok" } & T) | { status: "unavailable"; reason: string };

export type RouterModel = {
  id: string;
  provider: string;
  route: "free" | "subscription" | "metered";
  verifiedFree: boolean;
  /** The name a person would say ("Gemini 2.5 Flash Lite"); the raw id is only secondary text. Absent = use the id. */
  label?: string;
  /** Takes text in and gives text out, so it can write a report. Voice, image and video models are not offered. Absent = assumed text. */
  text?: boolean;
  /** catalogue status: only "verified" and "configured" can run. */
  status: string;
  health: { state: string; until: string | null; detail: string | null } | null;
};
export type RouterLite = { models: RouterModel[]; healthAt: string | null };

export type SkillOption = { name: string; description?: string };

export type RoutineRow = {
  id: string;
  name: string;
  kind: "event" | "routine";
  source: string;
  state: "active" | "paused" | "disabled";
  schedule?: { kind: "daily"; at: string; tz: string } | { kind: "interval"; everyMinutes: number };
  nextRunAt: string | null;
};

export type MemoryPool = { mode: string | null; hindsightEnabled: boolean | null; reason: string | null; pending: number | null; lastSuccessAt: string | null };

export type SetupSources = {
  computers(): Promise<ComputersRead>;
  accounts(): Promise<Read<{ accounts: CodingAccount[]; codexIsolation?: CodingAccounts["codexIsolation"] }>>;
  router(): Promise<Read<{ router: RouterLite }>>;
  skills(): Promise<Read<{ skills: SkillOption[] }>>;
  routines(): Promise<Read<{ routines: RoutineRow[] }>>;
  memory(): Promise<Read<{ memory: MemoryPool }>>;
};

const reasonOf = (e: unknown, what: string) => {
  const m = e instanceof Error ? e.message : "";
  return m ? `${what}: ${m}` : `${what} couldn't be read.`;
};

export function routerLite(view: ModelRouterView): RouterLite {
  const health = view.health?.models ?? {};
  return {
    healthAt: view.health?.updatedAt ?? null,
    models: view.catalogue.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      route: m.route,
      verifiedFree: m.verifiedFree === true,
      label: catalogueLabel(m.providerModel, m.provider) ?? undefined,
      text: !m.modality || (m.modality.in.includes("text") && m.modality.out.includes("text")),
      status: m.status,
      health: health[m.id] ? { state: health[m.id].state, until: health[m.id].until ?? null, detail: health[m.id].detail ?? null } : null,
    })),
  };
}

async function modelRouterView(): Promise<ModelRouterView> {
  const t = await fetch("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const res = await fetch("/__operator/model-router", { headers: { Accept: "application/json", ...(typeof t?.token === "string" ? { "X-Claude-OS-Token": t.token } : {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new Error(typeof body?.error === "string" ? body.error : `answered HTTP ${res.status}`);
  return body as ModelRouterView;
}

export const liveSources: SetupSources = {
  computers: readComputers,
  async accounts() {
    try {
      const a = await codingClient.accounts();
      return { status: "ok", accounts: a.accounts, codexIsolation: a.codexIsolation };
    } catch (e) {
      return { status: "unavailable", reason: reasonOf(e, "The coding accounts") };
    }
  },
  async router() {
    try {
      return { status: "ok", router: routerLite(await modelRouterView()) };
    } catch (e) {
      return { status: "unavailable", reason: reasonOf(e, "The model router") };
    }
  },
  async skills() {
    // Proposed contract addition (the server validates skill names, so it knows them): GET /__agents/skills.
    try {
      const r = await fetch("/__agents/skills", { cache: "no-store" });
      const json = (r.headers.get("content-type") ?? "").includes("json");
      if (!r.ok || !json) return { status: "unavailable", reason: "The hub can't list its skills yet." };
      const body = (await r.json().catch(() => null)) as { skills?: unknown[] } | null;
      if (!body || !Array.isArray(body.skills)) return { status: "unavailable", reason: "The hub sent a skills list this page can't read." };
      const skills = body.skills.flatMap((s): SkillOption[] => {
        if (typeof s === "string") return [{ name: s }];
        const o = s as { name?: unknown; description?: unknown };
        return typeof o?.name === "string" ? [{ name: o.name, ...(typeof o.description === "string" ? { description: o.description } : {}) }] : [];
      });
      return { status: "ok", skills };
    } catch {
      return { status: "unavailable", reason: "The skills list couldn't be reached." };
    }
  },
  async routines() {
    try {
      const { triggers } = await operatorRequest<{ triggers: RoutineRow[] }>("/triggers", undefined, "GET");
      if (!Array.isArray(triggers)) return { status: "unavailable", reason: "Automations sent a list this page can't read." };
      return { status: "ok", routines: triggers.map((t) => ({ id: t.id, name: t.name, kind: t.kind, source: t.source, state: t.state, schedule: t.schedule, nextRunAt: t.nextRunAt ?? null })) };
    } catch (e) {
      return { status: "unavailable", reason: reasonOf(e, "Automations") };
    }
  },
  async memory() {
    try {
      const r = await fetch("/__memory/status", { cache: "no-store" });
      const body = (await r.json().catch(() => null)) as { settings?: { mode?: string; hindsight_enabled?: boolean; reason?: string | null }; pending?: number; last_success_at?: string | null } | null;
      if (!r.ok || !body) return { status: "unavailable", reason: "The memory service didn't answer." };
      return {
        status: "ok",
        memory: {
          mode: body.settings?.mode ?? null,
          hindsightEnabled: typeof body.settings?.hindsight_enabled === "boolean" ? body.settings.hindsight_enabled : null,
          reason: body.settings?.reason ?? null,
          pending: typeof body.pending === "number" ? body.pending : null,
          lastSuccessAt: body.last_success_at ?? null,
        },
      };
    } catch {
      return { status: "unavailable", reason: "The memory service couldn't be reached." };
    }
  },
};
