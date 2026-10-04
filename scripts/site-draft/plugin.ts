// Vite dev-server plugin exposing the site-draft flow as a local HTTP endpoint, so the voice
// stack (see docs/WEBSITE-DRAFTS.md) and the /websites page can trigger it without shelling out.
//
// Mounted at /__site-draft/* — a dedicated prefix, sibling to /__operator (see
// scripts/website-os-plugin.ts for the same pattern), not nested under /__operator/*. The task
// brief asked for /__operator/websites/draft; scripts/operator-plugin.ts's single middleware
// swallows every /__operator/* request itself (it never calls next() for an unrecognised path), so
// a second plugin mounted underneath it would never be reached without editing that ~2,800-line
// shared file. /__site-draft/draft is the safe equivalent — same origin, same loopback + token
// guard, documented in WEBSITE-DRAFTS.md so this is easy to fold into /__operator later if wanted.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { openCrm, crmPath } from "../leads/crm";
import type { DraftResult } from "./generate";
import { defaultDraftsRoot, type DraftV2Result } from "./orchestrator";
import { draftForLead, type DraftMode } from "./dispatch";
import { localPreviewUrl, startPreviewServer } from "../lead-sites/preview-server";
import { refuseUnlessAtThisPc } from "../identity/gate";
import { withBody } from "../http/body";

/** import.meta.dir (Bun-only) is untyped under this project's tsconfig (no bun-types). */
const HERE = dirname(fileURLToPath(import.meta.url));

type Running = { port: number; proc: ChildProcess; slug: string };
const servers = new Map<string, Running>();

async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensurePreview(result: DraftResult | DraftV2Result): Promise<number> {
  const existing = servers.get(result.slug);
  if (existing && (await isAlive(existing.port))) return existing.port;
  if (existing) servers.delete(result.slug);
  const port = 4300 + (Math.abs(hash(result.slug)) % 200);
  const proc = spawn(process.execPath.includes("bun") ? process.execPath : "bun", [join(HERE, "serve.ts"), result.dir, String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  proc.unref();
  servers.set(result.slug, { port, proc, slug: result.slug });
  for (let i = 0; i < 20; i++) {
    if (await isAlive(port)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return port;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function siteDraftPlugin(options: { root: string; token: string }): Plugin {
  const { root, token } = options;
  return {
    name: "mu-site-draft",
    configureServer(server) {
      server.middlewares.use("/__site-draft", async (req, res) => {
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
          return send({ error: "Local access only" }, 403);
        const host = req.headers.host || "";
        // Stage B1: the verified principal must be the owner at this PC (relay headers never pass as local).
        const notHere = refuseUnlessAtThisPc(req, "Site drafts are made on this PC.", { root });
        if (notHere) return send({ error: notHere.error }, notHere.status);
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return send({ error: "Unknown origin" }, 403);
        const url = new URL(req.url || "/", "http://localhost");
        const method = req.method || "GET";

        if (url.pathname === "/status" && method === "GET") {
          return send({ drafts: [...servers.values()].map((s) => ({ slug: s.slug, previewUrl: `http://127.0.0.1:${s.port}` })) });
        }
        if (url.pathname !== "/draft") return send({ error: "Not found" }, 404);
        if (method !== "POST") return send({ error: "Use POST" }, 405);
        if (req.headers["x-claude-os-token"] !== token) return send({ error: "Refresh this page and try again." }, 403);
        if (!req.headers["content-type"]?.includes("application/json")) return send({ error: "JSON required" }, 415);

        // 413 over the limit, with the rest drained, not a dropped connection (Audit F5 P3).
        withBody(req, res, 4096, async (raw) => {
          const started = Date.now();
          try {
            const data = JSON.parse(raw || "{}");
            const ref = data?.lead;
            const fast = data?.fast === true;
            const mode = data?.mode as DraftMode | undefined;
            if (mode !== undefined && mode !== "flagship" && mode !== "bespoke") throw new Error("Choose flagship or bespoke preview mode.");
            if (typeof ref !== "string" && typeof ref !== "number") throw new Error("Say which lead — a name or CRM id.");
            const db = openCrm(crmPath(root));
            let draft: Awaited<ReturnType<typeof draftForLead>>;
            try {
              draft = await draftForLead(db, ref, { root, draftsRoot: defaultDraftsRoot(), by: "jarvis", fast, mode });
            } finally { db.close(); }
            if (draft.kind === "flagship") {
              const { record } = draft.result;
              startPreviewServer({ root, draftsRoot: defaultDraftsRoot() });
              send({ leadId: record.leadId, name: record.business, slug: record.slug, dir: record.dir,
                previewUrl: localPreviewUrl(record.slug), ms: Date.now() - started, mode: "flagship" });
              return;
            }
            const result = draft.result;
            const port = await ensurePreview(result);
            send({
              leadId: result.lead.id,
              name: result.lead.name,
              slug: result.slug,
              dir: result.dir,
              previewUrl: `http://127.0.0.1:${port}`,
              ms: Date.now() - started,
              ...( "qa" in result ? { qaPass: result.qa?.pass ?? null, imageryEngine: result.imagery.engine } : {}),
            });
          } catch (error) {
            send({ error: error instanceof Error ? error.message : "Could not draft that site." }, 400);
          }
        });
      });
    },
  };
}
