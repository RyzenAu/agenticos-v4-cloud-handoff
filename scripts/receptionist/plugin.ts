import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { fetchFx } from "../ai-usage/sources";
import { buildReceptionistSnapshot, type SnapshotInputs } from "./aggregate";
import { createAgencyFeed } from "./agency-feed";
import { buildDashboard, type ClientPackageMap, type DashboardViewModel, type PackageWarning } from "./dashboard";
import { fetchRetell } from "./retell";
import { fetchTwilio } from "./twilio";
import { callAttribution } from "./usage-economics";
import { readLedgerMonth, readReceiptsMonth } from "./usage-sources";
import { readEvals, readLegalTemplate } from "./evals";
import { readLeads } from "./commercial";
import { createSummaries } from "./summaries";
import { actorName, validateActor, validateIncidentPatch, validatePatch, type FollowUps, type Signoffs } from "./readiness";
import type { FlagCode, LineSource, ReceptionistSnapshot } from "./types";
import { getReceptionistPackage, LEGACY_PACKAGE_ALIASES, RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { authorise, type Principal } from "../identity/principal";
import { dataDirFor } from "../cloud/data-dir";
export type ReceptionistOptions = {
  root: string;
  token: string;
  providerKey: (name: string) => string;
  /** Explicit override; otherwise RECEPTIONIST_RETELL_AGENT_ID via providerKey (see resolveLine). */
  agentId?: string;
  /** Explicit override (E.164); otherwise RECEPTIONIST_INBOUND_NUMBER via providerKey. */
  number?: string;
  receptionistRoot?: string;
  fetch?: typeof fetch;
};
/** Runtime config names for the single-tenant line. Values are read at runtime, never logged. */
export const LINE_CONFIG_KEYS = { agentId: "RECEPTIONIST_RETELL_AGENT_ID", number: "RECEPTIONIST_INBOUND_NUMBER" } as const;
/**
 * TODO(Stage 2, multi-client line config): the agency feed carries only `readiness.agentMapped`
 * and a masked inbound number per client, so the Retell agent id and number cannot come from the
 * feed yet. Until the feed contract adds per-client `retellAgentId` + `inboundNumber` (or the owner
 * sets the two LINE_CONFIG_KEYS), the M&U demo line below is the LAST-resort fallback and every
 * snapshot says so (`agent.lineSource === "legacy-demo-default"`). Remove it once config is set.
 */
const LEGACY_DEMO_LINE = {
  agentId: "agent_21273200f10cb3694a4cf82112",
  number: "+61485011208",
} as const;
const defaults = {
  receptionistRoot: "D:/MU-Receptionist",
};
export type ResolvedLine = { agentId: string; number: string; lineSource: LineSource };
/**
 * Explicit options win, then runtime config through providerKey (a runtime reference: the value
 * is only passed to the provider clients, never returned in an error or printed), then the
 * legacy demo line. A half-configured line (agent id without number, or the reverse) never mixes
 * with the demo line's other half: it falls back to the demo line as a whole, labelled as such.
 */
export function resolveLine(options: Pick<ReceptionistOptions, "agentId" | "number" | "providerKey">): ResolvedLine {
  if (options.agentId && options.number) return { agentId: options.agentId, number: options.number, lineSource: "options" };
  const read = (name: string) => {
    try { return options.providerKey(name)?.trim() ?? ""; } catch { return ""; }
  };
  const agentId = options.agentId || read(LINE_CONFIG_KEYS.agentId);
  const number = options.number || read(LINE_CONFIG_KEYS.number);
  if (agentId && number) return { agentId, number, lineSource: options.agentId || options.number ? "options" : "config" };
  return { ...LEGACY_DEMO_LINE, lineSource: "legacy-demo-default" };
}
export function readSignoffs(file: string): Signoffs {
  const signs: Signoffs = {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, entry] of Object.entries(data)) {
      try {
        const v = entry as any;
        const p = validatePatch({
          id,
          done: v.done,
          ...(v.note !== undefined ? { note: v.note } : {}),
        });
        const by = validateActor(v.by);
        if (typeof v.at === "string" && Number.isFinite(Date.parse(v.at)))
          signs[p.id] = {
            done: p.done,
            by,
            at: v.at,
            ...(p.note !== undefined ? { note: p.note } : {}),
          };
      } catch {
        /* ignore invalid record */
      }
    }
  } catch {
    /* no valid sign-offs */
  }
  return signs;
}
/** Follow-ups live under `followedUp` in the same file as the sign-offs. */
export function readFollowUps(file: string): FollowUps {
  const out: FollowUps = {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))?.followedUp;
    if (data && typeof data === "object")
      for (const [callId, v] of Object.entries(data as Record<string, any>)) {
        try {
          const p = validateIncidentPatch({ callId, ...(v?.note !== undefined ? { note: v.note } : {}) });
          const by = validateActor(v?.by);
          if (typeof v.at === "string" && Number.isFinite(Date.parse(v.at)))
            out[p.callId] = { by, at: v.at, ...(p.note !== undefined ? { note: p.note } : {}) };
        } catch {
          /* ignore invalid record */
        }
      }
  } catch {
    /* none yet */
  }
  return out;
}
/**
 * Local client -> package assignment for the dashboard's cost/margin figures. NOT part of the
 * agency feed contract (it carries no package selection field) — this is M&U's own record,
 * keyed by client slug. Missing/invalid entries are dropped, never guessed: an unassigned client
 * shows "unassigned" rather than a fabricated package.
 */
export function readClientPackages(file: string): ClientPackageMap {
  const out: Record<string, ReturnType<typeof getReceptionistPackage>["id"]> = {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data === "object")
      for (const [slug, id] of Object.entries(data as Record<string, unknown>)) {
        if (typeof id !== "string") continue;
        try { out[slug] = getReceptionistPackage(id).id; } catch { /* unknown package id: skip */ }
      }
  } catch {
    /* no assignment file yet: every client is unassigned */
  }
  return out;
}

/** Assignments that used a legacy alias (resolved silently by the catalogue) or an unknown id: surfaced, never hidden. */
export function clientPackageWarnings(file: string): PackageWarning[] {
  const out: PackageWarning[] = [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data === "object")
      for (const [slug, id] of Object.entries(data as Record<string, unknown>)) {
        if (typeof id !== "string") continue;
        if (id in LEGACY_PACKAGE_ALIASES) out.push({ slug, id, kind: "legacy-alias", resolvedTo: getReceptionistPackage(id).shortName });
        else if (!RECEPTIONIST_PACKAGES.some((p) => p.id === id)) out.push({ slug, id, kind: "unknown" });
      }
  } catch {
    /* no assignment file */
  }
  return out;
}

function writeStore(file: string, signoffs: Signoffs, followedUp: FollowUps) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...signoffs, followedUp }, null, 2));
  renameSync(`${file}.tmp`, file);
}
export class PatchRefused extends Error {}
export function createReceptionistService(
  options: ReceptionistOptions,
  /** `load(force)`: force = a Refresh, which must bypass every cache on the path (audit RX-1). */
  deps: { load?: (force: boolean) => Promise<SnapshotInputs>; now?: () => number } = {},
) {
  const line = resolveLine(options);
  const o = { ...defaults, ...options, agentId: line.agentId, number: line.number },
    now = deps.now ?? Date.now;
  const file = join(dataDirFor(o.root), "receptionist-readiness.json");
  const clientPackagesFile = join(dataDirFor(o.root), "receptionist-client-packages.json");
  const flagCache = new Map<string, FlagCode[]>();
  const summary = createSummaries(o.root, { fetch: o.fetch });
  // Server-only: the feed's token stays in this closure and its Authorization header.
  // `view: "full"` explicitly: the feed's own default became metadata (MU-Receptionist, 29 Sep 2026).
  const agencyFeed = createAgencyFeed({ providerKey: o.providerKey, fetch: o.fetch, now, view: "full" });
  // The dashboard reads its OWN cached feed with `?view=metadata` — a separate cache from the
  // single-tenant snapshot's full-view read above, so neither read's staleness affects the other.
  const agencyFeedMetadata = createAgencyFeed({ providerKey: o.providerKey, fetch: o.fetch, now, view: "metadata" });
  let snapshot: ReceptionistSnapshot | null = null,
    building: Promise<ReceptionistSnapshot> | null = null,
    dashboard: DashboardViewModel | null = null,
    buildingDashboard: Promise<DashboardViewModel> | null = null,
    // Whether the in-flight build is a forced one: a Refresh never joins a cached-path build (RX-1).
    buildingForced = false,
    buildingDashboardForced = false,
    revision = 0;
  // The last SUCCESSFUL provider reads for the dashboard: a failed read shows these (audit RX-7).
  const lastGood: { retell: number | null; twilio: number | null } = { retell: null, twilio: null };
  const load =
    deps.load ??
    (async (force: boolean): Promise<SnapshotInputs> => {
      const [retell, twilio, fx, feed] = await Promise.all([
        fetchRetell({ ...o, flagCache }),
        fetchTwilio(o),
        fetchFx(o.fetch ?? fetch),
        // A Refresh re-reads the feed too: never a cached failure from up to 60 s ago (RX-1).
        agencyFeed(force),
      ]);
      if (retell.calls.ok)
        for (const c of retell.calls.rows) {
          const s = await summary(c.id, c.analysisSummary);
          c.analysisSummary = null;
          c.summary = s?.line ?? null;
          c.summarySource = s?.source ?? "none";
        }
      return {
        agentId: o.agentId,
        number: o.number,
        lineSource: line.lineSource,
        agent: retell.agent,
        numberFacts: retell.number,
        calls: retell.calls,
        twilio,
        evals: readEvals(o.receptionistRoot),
        agencyFeed: feed,
        agencyFeedRead: agencyFeed.status(),
        legal: readLegalTemplate(o.receptionistRoot),
        leads: readLeads(
          process.env.RECEPTIONIST_CRM_FILE || join(dataDirFor(o.root), "crm.sqlite"),
        ),
        signoffs: readSignoffs(file),
        fx: fx.ok ? fx.fx : null,
      };
    });
  const get = (force = false): Promise<ReceptionistSnapshot> => {
    if (building && (!force || buildingForced)) return building;
    // A Refresh arriving while a non-forced build is in flight waits for it, then reads again.
    if (building) return building.catch(() => null).then(() => get(true));
    if (!force && snapshot && now() - Date.parse(snapshot.generatedAt) < 60_000)
      return Promise.resolve(snapshot);
    buildingForced = force;
    building = (async () => {
      const input = await load(force);
      // Sign-offs and follow-ups always come from the store (they may change while providers are in flight).
      input.signoffs = readSignoffs(file);
      input.followedUp = readFollowUps(file);
      snapshot = buildReceptionistSnapshot(input, now());
      return snapshot;
    })().finally(() => {
      building = null;
    });
    return building;
  };
  const getDashboard = (force = false): Promise<DashboardViewModel> => {
    if (buildingDashboard && (!force || buildingDashboardForced)) return buildingDashboard;
    if (buildingDashboard) return buildingDashboard.catch(() => null).then(() => getDashboard(true));
    if (!force && dashboard && now() - Date.parse(dashboard.generatedAt) < 60_000)
      return Promise.resolve(dashboard);
    buildingDashboardForced = force;
    buildingDashboard = (async () => {
      const [retell, twilio, feed, fullFeed] = await Promise.all([
        fetchRetell({ ...o, flagCache }),
        fetchTwilio(o),
        agencyFeedMetadata(force),
        // The snapshot's cached full-view read: used ONLY for providerCallId → organizationId, so a
        // client's Retell cost can be measured. No caller content goes into the dashboard model.
        agencyFeed(),
      ]);
      // The provider reads just completed: this is their read time, not the agent's edit time.
      const readAt = now();
      if (retell.agent.ok) lastGood.retell = readAt;
      if (twilio.ok) lastGood.twilio = readAt;
      const feedStatus = agencyFeedMetadata.status();
      const attribution = callAttribution(fullFeed, readAt);
      dashboard = buildDashboard({
        now: readAt,
        providersReadAt: readAt,
        feedReadAt: feedStatus.readAt ?? readAt,
        lastGoodReadAt: { feed: feedStatus.lastOkAt, retell: lastGood.retell, twilio: lastGood.twilio },
        lineSource: line.lineSource,
        feed,
        agent: retell.agent,
        numberFacts: retell.number,
        twilio,
        clientPackages: readClientPackages(clientPackagesFile),
        packageWarnings: clientPackageWarnings(clientPackagesFile),
        usageSources: {
          retellCalls: retell.calls.ok ? { ok: true, rows: retell.calls.rows.map(({ id, startedAt, usdCents }) => ({ id, startedAt, usdCents })) } : retell.calls,
          attribution,
          attributionReason: attribution ? undefined : fullFeed.ok ? "the feed returned its metadata view, with no call list" : fullFeed.reason,
          receipts: readReceiptsMonth(o.root, readAt),
          ledger: readLedgerMonth(o.root),
        },
      });
      return dashboard;
    })().finally(() => {
      buildingDashboard = null;
    });
    return buildingDashboard;
  };
  return {
    get,
    refresh: () => get(true),
    getDashboard,
    refreshDashboard: () => getDashboard(true),
    /**
     * `by` is the VERIFIED principal's name, supplied by the middleware (requestPrincipal); a `by` in
     * the body is ignored by validatePatch (audit RX-5).
     */
    async saveReadiness(value: unknown, by: string) {
      const p = validatePatch(value);
      const actor = validateActor(by);
      if (p.done) {
        const current = await get();
        const state = current.readiness.blockers.find((b) => b.id === p.id)?.state;
        if (state === "fail") throw new PatchRefused("Can't sign off: a real call since the last prompt change was flagged");
        if (state === "not-tested") throw new PatchRefused("Can't sign off: no real call since the last prompt change");
        if (state === "evidence-missing") throw new PatchRefused("Can't sign off: restore the missing evidence and retest first");
        if (state === "unknown") throw new PatchRefused("Can't sign off: the Retell calls couldn't be read, so the gate's evidence is unknown");
      }
      const signs = readSignoffs(file);
      signs[p.id] = {
        done: p.done,
        by: actor,
        at: new Date(now()).toISOString(),
        ...(p.note !== undefined ? { note: p.note } : {}),
      };
      writeStore(file, signs, readFollowUps(file));
      revision++;
      snapshot = null;
      return get(true);
    },
    /** As saveReadiness: `by` is the verified principal, never the body (audit RX-5). */
    async followUp(value: unknown, by: string) {
      const p = validateIncidentPatch(value);
      const actor = validateActor(by);
      const follow = readFollowUps(file);
      follow[p.callId] = { by: actor, at: new Date(now()).toISOString(), ...(p.note !== undefined ? { note: p.note } : {}) };
      writeStore(file, readSignoffs(file), follow);
      revision++;
      snapshot = null;
      return get(true);
    },
  };
}
let active: ReturnType<typeof createReceptionistService> | null = null;
export async function receptionistSentence(): Promise<string> {
  if (!active) throw new Error("Receptionist service unavailable");
  return (await active.get()).sentence;
}
/** The whole snapshot, for Jarvis's receptionist questions (scripts/jarvis-command/receptionist.ts). Read-only. */
export async function receptionistSnapshot() {
  if (!active) throw new Error("Receptionist service unavailable");
  return active.get();
}
export function receptionistMiddleware(
  service: ReturnType<typeof createReceptionistService>,
  token: string,
  /** The verified principal (scripts/identity, Stage B1). The live server passes its root. */
  principalFor: (req: IncomingMessage) => Principal | null = (req) => requestPrincipal(req),
) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      // Source strings and res.end's bytes are UTF-8. Legacy Windows HTTP readers
      // default to an ANSI decoder without this charset (· becomes Â·); do not
      // "repair" valid source strings or transcode the JSON. See encoding.test.ts.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    res.setHeader("Cache-Control", "no-store");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? ""))
      return json(403, { error: "Loopback only" });
    // Stage B1 (review H1): a verified principal, not just a loopback socket. Serve and Funnel both
    // arrive on loopback; an unknown tailnet login, a tagged device or a Funnel visitor is nobody.
    // Both founders share the receptionist (V7), so a verified person is authorised as business.
    const access = authorise(principalFor(req), { kind: "business", area: "receptionist" }, req.method === "GET" ? "read" : "write");
    if (!access.ok) return json(access.status, { error: access.reason });
    // Also reject browser cross-site reads from a hostile page running on the operator's machine.
    if (req.headers["sec-fetch-site"] === "cross-site") return json(403, { error: "Forbidden" });
    const route = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (route === "/" || route === "/ask")) {
      void service.get().then(
        (s) => json(200, route === "/ask" ? { said: s.sentence } : s),
        () => json(500, { error: "Receptionist status unavailable" }),
      );
      return;
    }
    if (req.method === "GET" && route === "/dashboard") {
      void service.getDashboard().then(
        (d) => json(200, d),
        () => json(500, { error: "Receptionist dashboard unavailable" }),
      );
      return;
    }
    if (req.method !== "POST" || !["/refresh", "/dashboard/refresh", "/readiness", "/incident"].includes(route)) return next();
    // The caller's OWN page token (Stage B1): internal at this PC, person-bound remotely.
    if (!token || !pageTokenMatches(principalFor(req), req.headers["x-claude-os-token"], token))
      return json(403, { error: "Forbidden" });
    if (route === "/dashboard/refresh") {
      void service.refreshDashboard().then(
        (d) => json(200, d),
        () => json(500, { error: "Receptionist dashboard unavailable" }),
      );
      return;
    }
    let chunks: Buffer[] = [],
      bytes = 0,
      tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4096) {
        if (!tooLarge) json(413, { error: "Body too large" });
        tooLarge = true;
        chunks = [];
      } else if (!tooLarge) chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (tooLarge) return;
      let patch: unknown;
      if (route !== "/refresh") {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          patch = route === "/readiness" ? validatePatch(body) : validateIncidentPatch(body);
        } catch {
          return json(400, { error: route === "/readiness" ? "Invalid readiness patch" : "Invalid follow-up" });
        }
      }
      // Who signed off / followed up: the verified principal only, never a name from the body (RX-5).
      let by: string;
      try {
        by = actorName(principalFor(req));
      } catch {
        return json(401, { error: "Sign in first" });
      }
      const work =
        route === "/refresh" ? service.refresh() : route === "/readiness" ? service.saveReadiness(patch, by) : service.followUp(patch, by);
      void work.then(
        (s) => json(200, s),
        (e) => (e instanceof PatchRefused ? json(400, { error: e.message }) : json(500, { error: "Receptionist update failed" })),
      );
    });
  };
}
export function receptionistPlugin(options: ReceptionistOptions): Plugin {
  return {
    name: "agentic-os-receptionist",
    configureServer(server) {
      active = createReceptionistService(options);
      server.middlewares.use("/__receptionist", receptionistMiddleware(active, options.token, (req) => requestPrincipal(req, { root: options.root })));
    },
  };
}
