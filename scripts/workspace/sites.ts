// Workspace "Websites": a server-side uptime check of every M&U site plus any local preview
// that's listening. GET with a timeout, the first 256 KB read for a robots meta tag, results
// cached 5 minutes. Read-only: nothing here deploys, logs in or submits anything.
import { connect } from "node:net";
import { OUR_SITES } from "../websites/catalogue";

export type SiteTarget = {
  id: string;
  name: string;
  url: string;
  kind: "marketing" | "client" | "flagship" | "demo" | "app" | "local";
  /** true = should carry noindex (previews), false = should be indexable, null = just report it. */
  expectNoindex: boolean | null;
};

export type SiteCheck = SiteTarget & {
  status: number | null;
  ok: boolean;
  ms: number | null;
  noindex: boolean | null;
  finalUrl: string | null;
  tone: "ok" | "warn" | "bad";
  note: string | null;
};

export type SitesPanel = {
  checkedAt: string;
  sites: SiteCheck[];
  local: SiteCheck[];
  /** Local preview ports that weren't listening. */
  localNotRunning: { port: number; name: string }[];
};

/** Every public site: the Website page's catalogue (scripts/websites/catalogue.ts) plus the
 *  marketing site and the receptionist app, which that catalogue doesn't list. */
export function publicTargets(): SiteTarget[] {
  const out: SiteTarget[] = [{ id: "marketing", name: "M&U Ventures", url: "https://muventures.com.au", kind: "marketing", expectNoindex: false }];
  for (const s of OUR_SITES) {
    out.push({ id: s.id, name: s.name, url: s.url, kind: s.kind === "client" ? "client" : "flagship", expectNoindex: null });
    for (const also of s.alsoAt) {
      // Only the owner-facing preview domains; *.vercel.app aliases duplicate the main check.
      if (/\.vercel\.app/.test(also)) continue;
      out.push({ id: `${s.id}-preview`, name: `${s.name} preview`, url: also, kind: "client", expectNoindex: /preview/.test(also) ? true : null });
    }
  }
  out.push({ id: "mu-receptionist", name: "MU-Receptionist app", url: "https://mu-receptionist.vercel.app", kind: "app", expectNoindex: null });
  return out;
}

/** Local previews (docs/MU-EXECUTION-20260927.md): shown only while listening. */
export const LOCAL_PORTS: { port: number; name: string }[] = [
  { port: 3401, name: "Marketing (local)" },
  { port: 3402, name: "Preview (local)" },
  { port: 3403, name: "Property (local)" },
  { port: 3404, name: "Legal (local)" },
  { port: 3405, name: "Dental (local)" },
  { port: 3417, name: "Video gallery (local)" },
];

const ROBOTS_META = /<meta\b[^>]*name\s*=\s*["']?(?:robots|googlebot)["']?[^>]*>/gi;

/** noindex from the X-Robots-Tag header or a robots/googlebot meta tag. */
export function detectNoindex(header: string | null, html: string): boolean {
  if (header && /noindex/i.test(header)) return true;
  for (const tag of html.match(ROBOTS_META) ?? []) if (/content\s*=\s*["'][^"']*noindex/i.test(tag)) return true;
  return false;
}

async function readHead(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit));
}

export async function checkSite(target: SiteTarget, deps: { fetch: typeof fetch; now: () => number; timeoutMs: number }): Promise<SiteCheck> {
  const started = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(target.url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { "User-Agent": "AgenticOS-Workspace-uptime/1 (+owner check)", Accept: "text/html" } });
    const ms = deps.now() - started;
    const html = /html/i.test(res.headers.get("content-type") ?? "") ? await readHead(res, 256 * 1024) : (await res.body?.cancel().catch(() => undefined), "");
    const noindex = detectNoindex(res.headers.get("x-robots-tag"), html);
    const up = res.status >= 200 && res.status < 400;
    const mismatch = target.expectNoindex !== null && noindex !== target.expectNoindex;
    const slow = ms > 3000;
    return {
      ...target,
      status: res.status,
      ok: up,
      ms,
      noindex,
      finalUrl: res.url && res.url.replace(/\/+$/, "") !== target.url.replace(/\/+$/, "") ? res.url : null,
      tone: !up ? "bad" : mismatch || slow ? "warn" : "ok",
      note: !up ? `HTTP ${res.status}` : mismatch ? (target.expectNoindex ? "Should be noindex but is indexable" : "Carries noindex but should be indexable") : slow ? "Slow response" : null,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return { ...target, status: null, ok: false, ms: timedOut ? deps.timeoutMs : deps.now() - started, noindex: null, finalUrl: null, tone: "bad", note: timedOut ? `No response within ${deps.timeoutMs / 1000} s` : `Unreachable: ${String((error as Error)?.message ?? "error").slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
export function portListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export type SiteCheckerOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  targets?: SiteTarget[];
  ports?: { port: number; name: string }[];
  listening?: (port: number) => Promise<boolean>;
};

/** Cached checker: one run per `ttlMs` (5 min); concurrent callers share the run in flight. */
export function createSiteChecker(options: SiteCheckerOptions = {}) {
  const f = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 8000;
  const listening = options.listening ?? portListening;
  let cached: SitesPanel | null = null;
  let running: Promise<SitesPanel> | null = null;

  async function run(): Promise<SitesPanel> {
    const targets = options.targets ?? publicTargets();
    const ports = options.ports ?? LOCAL_PORTS;
    const [sites, portStates] = await Promise.all([
      Promise.all(targets.map((t) => checkSite(t, { fetch: f, now, timeoutMs }))),
      Promise.all(ports.map(async (p) => ({ ...p, up: await listening(p.port) }))),
    ]);
    const local = await Promise.all(
      portStates.filter((p) => p.up).map((p) => checkSite({ id: `local-${p.port}`, name: p.name, url: `http://127.0.0.1:${p.port}/`, kind: "local", expectNoindex: null }, { fetch: f, now, timeoutMs: 3000 })),
    );
    return { checkedAt: new Date(now()).toISOString(), sites, local, localNotRunning: portStates.filter((p) => !p.up).map(({ port, name }) => ({ port, name })) };
  }

  return {
    check(force = false): Promise<SitesPanel> {
      if (running) return running;
      if (!force && cached && now() - Date.parse(cached.checkedAt) < ttl) return Promise.resolve(cached);
      running = run().then((r) => (cached = r)).finally(() => { running = null; });
      return running;
    },
    cached: () => cached,
  };
}
