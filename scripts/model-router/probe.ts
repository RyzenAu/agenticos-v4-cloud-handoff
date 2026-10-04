// scripts/model-router/probe.ts — zero-cost health probes for the catalogue.
//
// Only list reads that cost nothing: Cline's public free catalogue, OpenRouter's public model list,
// Groq's and Gemini's keyed model lists, and Hermes' loopback /health. Never a completion, never
// `claude -p` (see the 25 Sep probe-usage leak), never the OS's own :8081 server. Each provider is
// probed at most once an hour (once per 5 minutes when forced), one probe run at a time per process.
// Subscription windows and provider balances are NOT probed here: /usage (scripts/ai-usage) already
// reads them on a 15-minute cache, and the Models page shows those readings.
import { providerKey } from "../provider-config";
import { catalogue, type CatalogueModel } from "./catalogue";
import { routerHealthStore, type HealthStore } from "./health";

export const PROBE_INTERVAL_MS = 60 * 60_000;
export const FORCED_PROBE_INTERVAL_MS = 5 * 60_000;

export type ProbeOutcome = {
  provider: string;
  at: string;
  method: string;
  ok: boolean;
  listed: number;
  unlisted: string[];
  notes: string[];
  skipped?: string;
};

type Listed = {
  priceIn?: number;
  priceOut?: number;
  /** every pricing field is exactly 0 (request, image, etc. too) */ allZero?: boolean;
};
type Lister = (
  request: typeof fetch,
  key: (name: string) => string,
) => Promise<Map<string, Listed>>;

const LISTERS: Record<string, { method: string; list: Lister }> = {
  cline: {
    method: "Cline public free catalogue (api.cline.bot)",
    list: async (request) => {
      const r = await request("https://api.cline.bot/api/v1/ai/cline/recommended-models", {
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { free?: { id?: string }[] };
      return new Map(
        (body.free ?? []).filter((x) => typeof x?.id === "string").map((x) => [x.id!, {}]),
      );
    },
  },
  openrouter: {
    method: "OpenRouter public /api/v1/models (no key)",
    list: async (request) => {
      const r = await request("https://openrouter.ai/api/v1/models", {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as {
        data?: { id?: string; pricing?: Record<string, string | number | undefined> }[];
      };
      return new Map(
        (body.data ?? [])
          .filter((m) => typeof m?.id === "string")
          .map((m) => {
            const fields = Object.entries(m.pricing ?? {}).filter(([k]) => k !== "discount");
            const allZero = fields.length > 0 && fields.every(([, v]) => Number(v) === 0);
            return [
              m.id!,
              {
                priceIn: Number(m.pricing?.prompt) * 1_000_000,
                priceOut: Number(m.pricing?.completion) * 1_000_000,
                allZero,
              },
            ];
          }),
      );
    },
  },
  groq: {
    method: "Groq keyed /openai/v1/models (zero cost)",
    list: async (request, key) => {
      const k = key("GROQ_API_KEY");
      if (!k) throw new Error("GROQ_API_KEY not configured");
      const r = await request("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${k}` },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { data?: { id?: string }[] };
      return new Map(
        (body.data ?? []).filter((m) => typeof m?.id === "string").map((m) => [m.id!, {}]),
      );
    },
  },
  gemini: {
    method: "Gemini keyed models.list (zero cost)",
    list: async (request, key) => {
      const k = key("GEMINI_API_KEY");
      if (!k) throw new Error("GEMINI_API_KEY not configured");
      const out = new Map<string, Listed>();
      let page = "";
      for (let i = 0; i < 10; i++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
        const r = await request(url, {
          headers: { "x-goog-api-key": k },
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { models?: { name?: string }[]; nextPageToken?: string };
        for (const m of body.models ?? [])
          if (typeof m?.name === "string") out.set(m.name.replace(/^models\//, ""), {});
        if (!body.nextPageToken) break;
        page = body.nextPageToken;
      }
      return out;
    },
  },
};

const within = (at: string | undefined, ms: number, now: number) =>
  !!at && now - Date.parse(at) < ms;
const money = (n: number) => `$${Number(n.toFixed(4))}`;

/** Compare one model with the provider's list. A `:free` model that isn't $0 any more is unlisted (never routed). */
function judge(
  m: CatalogueModel,
  listed: Map<string, Listed>,
): { ok: boolean; note: string | null } {
  const row = listed.get(m.providerModel);
  if (!row) return { ok: false, note: "absent from the provider's list" };
  if (
    m.provider === "openrouter" &&
    m.route === "free" &&
    (row.priceIn !== 0 || row.priceOut !== 0 || row.allZero === false)
  )
    return { ok: false, note: "no longer listed at $0" };
  if (
    m.provider === "openrouter" &&
    m.cost.basis === "catalogue_price" &&
    Number.isFinite(row.priceIn) &&
    Number.isFinite(row.priceOut)
  ) {
    const drift =
      Math.abs((row.priceIn ?? 0) - (m.cost.inputUsdPerM ?? 0)) > 1e-6 ||
      Math.abs((row.priceOut ?? 0) - (m.cost.outputUsdPerM ?? 0)) > 1e-6;
    if (drift)
      return {
        ok: true,
        note: `price now ${money(row.priceIn!)}/${money(row.priceOut!)} per M (catalogue ${m.cost.inputUsdPerM}/${m.cost.outputUsdPerM})`,
      };
  }
  return { ok: true, note: null };
}

let running: Promise<ProbeOutcome[]> | null = null;

export type ProbeOptions = {
  root: string;
  force?: boolean;
  request?: typeof fetch;
  health?: HealthStore;
  key?: (name: string) => string;
  now?: () => number;
  hermesUrl?: string | null;
};

/** Run the due probes (single-flight). Returns one outcome per provider, including skipped ones. */
export function probeCatalogue(options: ProbeOptions): Promise<ProbeOutcome[]> {
  if (running) return running;
  running = runProbes(options).finally(() => {
    running = null;
  });
  return running;
}

async function runProbes(options: ProbeOptions): Promise<ProbeOutcome[]> {
  const now = options.now ?? Date.now;
  const request = options.request ?? fetch;
  const health = options.health ?? routerHealthStore(options.root);
  const key = options.key ?? ((name: string) => providerKey(options.root, name));
  const interval = options.force ? FORCED_PROBE_INTERVAL_MS : PROBE_INTERVAL_MS;
  const out: ProbeOutcome[] = [];
  for (const [provider, lister] of Object.entries(LISTERS)) {
    const at = new Date(now()).toISOString();
    const last = health.provider(provider).lastProbe;
    if (last && within(last.at, interval, now())) {
      out.push({
        provider,
        at: last.at,
        method: last.method,
        ok: true,
        listed: 0,
        unlisted: [],
        notes: [],
        skipped: `probed ${Math.round((now() - Date.parse(last.at)) / 60_000)} min ago`,
      });
      continue;
    }
    // An owner-choice entry (providerModel with "*") names a family, not one listed model: never probed.
    const models = catalogue().models.filter(
      (m) => m.provider === provider && m.status !== "not-configured" && !m.providerModel.includes("*"),
    );
    try {
      const listed = await lister.list(request, key);
      const unlisted: string[] = [];
      const notes: string[] = [];
      for (const m of models) {
        const verdict = judge(m, listed);
        const prev = health.model(m.id);
        const probe = {
          at,
          method: lister.method,
          result: verdict.ok ? (verdict.note ?? "listed") : verdict.note!,
        };
        if (!verdict.ok) {
          unlisted.push(m.id);
          health.markModel(m.id, {
            state: "unlisted",
            until: null,
            lastProbe: probe,
            detail: verdict.note,
          });
        } else {
          // A listing proves the id, not the quota: an active rate limit stays until it expires.
          const keep =
            prev.state === "limited" || prev.state === "exhausted" || prev.state === "down";
          health.markModel(m.id, {
            state: keep ? prev.state : "ok",
            lastProbe: probe,
            detail: keep ? prev.detail : verdict.note,
          });
        }
        if (verdict.note && verdict.ok) notes.push(`${m.id}: ${verdict.note}`);
      }
      health.markProvider(provider, {
        lastProbe: {
          at,
          method: lister.method,
          result: `${listed.size} listed; ${unlisted.length} catalogue model(s) missing`,
        },
        failure: null,
      });
      out.push({
        provider,
        at,
        method: lister.method,
        ok: true,
        listed: listed.size,
        unlisted,
        notes,
      });
    } catch (error) {
      const detail = String((error as Error)?.message ?? "probe failed")
        .replace(/[^\w .:/-]/g, "")
        .slice(0, 80);
      health.markProvider(provider, {
        lastProbe: { at, method: lister.method, result: `failed: ${detail}` },
        failure: { at, errorCode: "probe_failed", detail },
      });
      out.push({
        provider,
        at,
        method: lister.method,
        ok: false,
        listed: 0,
        unlisted: [],
        notes: [detail],
      });
    }
  }
  // Hermes: loopback /health only (no completion, no Codex allowance spent).
  if (options.hermesUrl !== null) {
    const at = new Date(now()).toISOString();
    const last = health.provider("hermes").lastProbe;
    if (!(last && within(last.at, interval, now()))) {
      const method = "Hermes GET /health (loopback)";
      try {
        const r = await request(`${options.hermesUrl ?? "http://127.0.0.1:8642"}/health`, {
          redirect: "error",
          signal: AbortSignal.timeout(3_000),
        });
        health.markProvider("hermes", {
          lastProbe: { at, method, result: `HTTP ${r.status}` },
          failure: r.ok ? null : { at, errorCode: "unhealthy", detail: `HTTP ${r.status}` },
        });
        out.push({ provider: "hermes", at, method, ok: r.ok, listed: 0, unlisted: [], notes: [] });
      } catch {
        health.markProvider("hermes", {
          lastProbe: { at, method, result: "no answer" },
          failure: { at, errorCode: "unreachable", detail: "no answer on 127.0.0.1:8642" },
        });
        out.push({
          provider: "hermes",
          at,
          method,
          ok: false,
          listed: 0,
          unlisted: [],
          notes: ["no answer"],
        });
      }
    }
  }
  return out;
}

// CLI: `bun --no-env-file scripts/model-router/probe.ts [--force]` prints outcomes (no keys, no bodies).
if (import.meta.main) {
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outcomes = await probeCatalogue({ root, force: process.argv.includes("--force") });
  console.log(JSON.stringify(outcomes, null, 1));
}
