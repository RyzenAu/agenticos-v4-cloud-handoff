// /__ai_usage — the AI usage & spend page's API (loopback only; the Tailnet proxy arrives on
// loopback too, as for every other /__ route).
//
//   GET  /__ai_usage            → the snapshot (provider reads cached 15 min each)
//   POST /__ai_usage/refresh    → re-read local sources now (transcripts, call counts); providers
//                                  are only called again once their 15-minute cache has expired
//   POST /__ai_usage/settings   → edit prices / account names (X-Claude-OS-Token required)
//   GET  /__ai_usage/ask?q=…    → Jarvis: { matched, intent, said } for a spend/limits question
//
// The call counter is installed when this module loads, before other plugins create their
// provider clients, so their fetches are counted.
import { hubRole } from "../cloud/hub-role";
import type { IncomingMessage, ServerResponse } from "node:http";
import { publishUsageSnapshot } from "../model-router/allowance";
import { loadAccounts } from "../coding/accounts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { installCallCounter } from "./call-counter";
import { aiUsageIntent, answerAiUsage } from "./jarvis-intent";
import { applySettingsPatch, buildSnapshot, createProviderCache, readSettings, writeSettings } from "./snapshot";
import { createTranscriptScanner } from "./transcripts";
import type { AiUsageSnapshot } from "./types";
import { requestPrincipal } from "../identity/gate";
import { authorise, isBrowserPrincipal } from "../identity/principal";
import { withBody } from "../http/body";
import { dataDirFor } from "../cloud/data-dir";

// The dev server runs from the repo root; aiUsagePlugin() re-points the file at its real root.
let counter = installCallCounter(resolve(dataDirFor(process.cwd()), "ai-usage-calls.json"));

let activeService: AiUsageService | null = null;

/** The running server's snapshot, for in-process callers (the Jarvis router hook). */
export function aiUsageSnapshot(): Promise<AiUsageSnapshot> {
  if (!activeService) return Promise.reject(new Error("The AI usage service isn't running."));
  return activeService.get();
}

/** Jarvis hook: the spoken answer for a spend/limits question, or null when it isn't one. */
export async function answerAiUsageQuestion(utterance: string): Promise<string | null> {
  const intent = aiUsageIntent(utterance);
  if (!intent) return null;
  return answerAiUsage(intent, await aiUsageSnapshot());
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export type AiUsageService = ReturnType<typeof createAiUsageService>;

export function createAiUsageService(options: { root: string; providerKey: (name: string) => string }) {
  const settingsFile = join(dataDirFor(options.root), "ai-usage.json");
  const cache = createProviderCache();
  // Cloud hub: there is no owner home here, so this PC's Claude logs and logins are "on your PC", never read from the VM user's home.
  const cloud = hubRole() === "cloud";
  const homeDir = cloud ? join(dataDirFor(options.root), "no-owner-home") : homedir();
  const scanner = createTranscriptScanner({ dir: join(homeDir, ".claude", "projects") });
  let snapshot: AiUsageSnapshot | null = null;
  let building: Promise<AiUsageSnapshot> | null = null;
  let lastScan = 0;

  const scanSoon = () => {
    if (Date.now() - lastScan < 60_000 || scanner.scanning()) return;
    lastScan = Date.now();
    void scanner.scan().then(() => {
      snapshot = null; // next read picks up the new totals
    }, () => {});
  };

  /** Starts a fresh build after any in-flight one (whose inputs may predate a settings change). */
  const rebuild = async () => {
    if (building) await building.catch(() => {});
    return build();
  };

  const build = () => {
    building ??= buildSnapshot({
      settingsFile,
      ...(cloud ? { home: homeDir } : {}),
      cache,
      root: options.root,
      // Every Claude login in the coding accounts (each read from its own profile); unreadable = the default only.
      claudeProfiles: () => loadAccounts(join(dataDirFor(options.root), "coding", "accounts.json")).claude.map((c) => ({ slot: c.slot, label: c.label, configDir: c.configDir })),
      counts: counter.counts,
      transcripts: scanner.last,
      transcriptsScanning: scanner.scanning,
      providerKey: options.providerKey,
    })
      .then((s) => {
        snapshot = s;
        // The model router's >= 95% subscription skip reads this cached reading (no extra provider call).
        publishUsageSnapshot(s);
        return s;
      })
      .finally(() => {
        building = null;
      });
    return building;
  };

  return {
    async get(force = false): Promise<AiUsageSnapshot> {
      scanSoon();
      // Rebuild at most once a minute from cache, unless asked (providers keep their own 15-min TTL).
      if (!force && snapshot && Date.now() - Date.parse(snapshot.generatedAt) < 60_000) return snapshot;
      return build();
    },
    async refresh(): Promise<AiUsageSnapshot> {
      lastScan = 0;
      scanSoon();
      return rebuild();
    },
    async saveSettings(patch: unknown): Promise<AiUsageSnapshot> {
      writeSettings(settingsFile, applySettingsPatch(readSettings(settingsFile), patch));
      return rebuild();
    },
  };
}

export function aiUsagePlugin(options: { root: string; token: string; providerKey: (name: string) => string }): Plugin {
  counter = installCallCounter(join(dataDirFor(options.root), "ai-usage-calls.json"));
  return {
    name: "agentic-os-ai-usage",
    configureServer(server) {
      const service = createAiUsageService(options);
      activeService = service;
      server.middlewares.use("/__ai_usage", (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const route = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        };
        if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return json(403, { error: "Loopback only" });
        // Stage B1: a verified principal (the identity gate answers first; this is defence in depth).
        const principal = requestPrincipal(req, { root: options.root });
        const access = authorise(isBrowserPrincipal(principal) ? principal : null, { kind: "business", area: "ai-usage" }, req.method === "GET" ? "read" : "write");
        if (!access.ok) return json(access.status, { error: access.reason });
        if (route === "/" && req.method === "GET") {
          service.get().then((s) => json(200, s), (e) => json(500, { error: e instanceof Error ? e.message : "Usage snapshot failed" }));
          return;
        }
        if (route === "/ask" && req.method === "GET") {
          const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("q") ?? "";
          const intent = aiUsageIntent(q.slice(0, 200));
          if (!intent) return json(200, { matched: false });
          service.get().then(
            (s) => json(200, { matched: true, intent, said: answerAiUsage(intent, s) }),
            (e) => json(500, { error: e instanceof Error ? e.message : "Usage snapshot failed" }),
          );
          return;
        }
        if (req.method !== "POST" || (route !== "/refresh" && route !== "/settings")) return next();
        if (req.headers["x-claude-os-token"] !== options.token) return json(403, { error: "Forbidden" });
        // 413 over the limit instead of a dropped connection (Audit F5 P3).
        withBody(req, res, 20_000, (body) => {
          const work =
            route === "/refresh"
              ? service.refresh()
              : (async () => {
                  let patch: unknown;
                  try {
                    patch = JSON.parse(body || "{}");
                  } catch {
                    throw new Error("Send JSON.");
                  }
                  return service.saveSettings(patch);
                })();
          work.then((s) => json(200, s), (e) => json(400, { error: e instanceof Error ? e.message : "Could not save" }));
        });
      });
    },
  };
}
