// Vite dev-server plugin for founder-triggered lead previews, mounted at /__lead-sites/* (a sibling
// of /__site-draft, for the same reason: operator-plugin.ts's /__operator middleware never falls
// through). Loopback-only, same origin, and every POST needs the page's X-Claude-OS-Token — so a
// deploy can only come from a founder at this PC clicking the button (the drawer's confirm dialog
// supplies the typed domain that deployPreview checks). There is no bulk route.
//
//   GET  /status                 every preview + its expiry state, and which templates are built
//   GET  /qa?lead=<id>           the latest scripts/qa/gate.ts result for this lead's preview, or
//                                null if it's never been gated. deploy.ts refuses a deploy when
//                                the latest run failed -- this route is what the drawer reads first.
//   GET  /thumb?id=<lead>        the cached thumbnail of the lead's real site (PNG)
//   GET  /local/<lead>/          redirects to the preview's own origin, http://<slug>.localhost:8091/
//                                (preview-server.ts: Next exports load /_next/... from the site root)
//   POST /generate  {lead, by}
//   POST /deploy    {lead, by, confirm: "<slug>.muventures.com.au"}
//   POST /takedown  {lead, by}
//   POST /thumb     {lead}       capture the real site's thumbnail
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { crmPath, findLead, openCrm } from "../leads/crm";
import { latestGateResult } from "../qa/gate";
import { defaultDraftsRoot } from "../site-draft/orchestrator";
import { deployPreview, takeDownPreview } from "./deploy";
import { generatePreview } from "./generate";
import { localPreviewUrl, previewServerState, startPreviewServer } from "./preview-server";
import { getPreview, readRegistry, withExpiry } from "./registry";
import { templatesRoot, VERTICALS } from "./templates";
import { captureThumb, thumbInfo, thumbPath } from "./thumb";
import { websitesMiddleware } from "../websites/plugin";
import { backgroundJobsDisabled } from "../preview-guard";
import { refuseUnlessAtThisPc } from "../identity/gate";
import { PayloadTooLarge } from "../http/errors";

const FOUNDERS = ["usman", "mehroz"];

export function leadSitesPlugin(options: { root: string; token: string; draftsRoot?: string }): Plugin {
  const { root, token } = options;
  const draftsRoot = options.draftsRoot ?? defaultDraftsRoot();
  const busy = new Set<number>();
  return {
    name: "mu-lead-sites",
    configureServer(server) {
      // Each preview at the root of its own loopback origin; one listener per process (HMR-safe).
      // A quiet copy (AGENTIC_OS_NO_BACKGROUND=1, e.g. a perf/supervisor test on a preview port)
      // must not take 127.0.0.1:8091 from the live OS on 8081 -- previews stay the live copy's job.
      if (!backgroundJobsDisabled()) startPreviewServer({ root, draftsRoot });
      // Sales -> Website's data (scripts/websites/plugin.ts): our sites, previews, drafts, screenshots.
      server.middlewares.use("/__websites", websitesMiddleware({ root, draftsRoot, token }));
      server.middlewares.use("/__lead-sites", async (req, res) => {
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
          return send({ error: "Previews can only be generated or deployed from this PC." }, 403);
        const host = req.headers.host || "";
        // Stage B1: the verified principal must be the owner at this PC (relay headers never pass as local).
        const notHere = refuseUnlessAtThisPc(req, "Previews can only be generated or deployed from this PC.", { root });
        if (notHere) return send({ error: notHere.error }, notHere.status);
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return send({ error: "Unknown origin" }, 403);
        const url = new URL(req.url || "/", "http://localhost");
        const method = req.method || "GET";

        try {
          if (method === "GET" && url.pathname === "/status") {
            const templates = Object.fromEntries(VERTICALS.map((v) => {
              const file = join(templatesRoot(draftsRoot), v, "template.json");
              return [v, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).builtAt : null];
            }));
            const previews = readRegistry(root).map((p) => ({ ...withExpiry(p), thumb: thumbInfo(root, p.leadId), localUrl: localPreviewUrl(p.slug) }));
            return send({ previews, templates, thumbs: thumbList(root, url.searchParams.get("ids")), previewServer: previewServerState() });
          }
          if (method === "GET" && url.pathname === "/qa") {
            const record = getPreview(root, Number(url.searchParams.get("lead")));
            if (!record) return send({ error: "No preview generated" }, 404);
            return send({ gate: latestGateResult(root, record.slug) });
          }
          if (method === "GET" && url.pathname === "/thumb") {
            const id = Number(url.searchParams.get("id"));
            const file = thumbPath(root, id);
            if (!Number.isInteger(id) || !existsSync(file)) return send({ error: "No thumbnail yet" }, 404);
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "no-cache");
            return res.end(readFileSync(file));
          }
          // Old links: the preview now lives at the root of its own origin (see preview-server.ts).
          const local = /^\/local\/(\d+)(\/.*)?$/.exec(url.pathname);
          if (method === "GET" && local) {
            const record = getPreview(root, Number(local[1]));
            if (!record) return send({ error: "No preview generated" }, 404);
            res.statusCode = 302;
            res.setHeader("Location", localPreviewUrl(record.slug));
            res.setHeader("X-Robots-Tag", "noindex");
            return res.end();
          }
          if (method !== "POST") return send({ error: "Not found" }, 404);
          if (req.headers["x-claude-os-token"] !== token) return send({ error: "Refresh this page and try again." }, 403);
          if (!req.headers["content-type"]?.includes("application/json")) return send({ error: "JSON required" }, 415);
          const body = await readJson(req);
          const leadId = Number(body?.lead);
          if (!Number.isInteger(leadId) || leadId <= 0) return send({ error: "Say which lead." }, 400);
          const by = String(body?.by ?? "").toLowerCase();
          if (url.pathname !== "/thumb" && !FOUNDERS.includes(by)) return send({ error: "by must be usman or mehroz." }, 400);
          if (busy.has(leadId)) return send({ error: "Something is already running for this lead — wait for it to finish." }, 409);
          busy.add(leadId);
          const db = openCrm(crmPath(root));
          try {
            if (url.pathname === "/generate") {
              const r = await generatePreview(db, leadId, { root, draftsRoot, by });
              return send({ preview: withExpiry(r.record), missing: r.missing, services: r.facts.services.length });
            }
            if (url.pathname === "/deploy") {
              const r = await deployPreview(db, leadId, { root, confirm: String(body?.confirm ?? ""), by });
              return send({ preview: withExpiry(r) });
            }
            if (url.pathname === "/takedown") {
              const r = await takeDownPreview(db, leadId, { root, by });
              return send({ preview: withExpiry(r) });
            }
            if (url.pathname === "/thumb") {
              const lead = findLead(db, leadId);
              if (!lead) return send({ error: "Lead not found." }, 404);
              await captureThumb(root, leadId, lead.website);
              return send({ thumb: thumbInfo(root, leadId) });
            }
            return send({ error: "Not found" }, 404);
          } finally {
            busy.delete(leadId);
            db.close();
          }
        } catch (error) {
          return send({ error: error instanceof Error ? error.message : "That didn't work." }, error instanceof PayloadTooLarge ? 413 : 400);
        }
      });
    },
  };
}

function thumbList(root: string, ids: string | null): Record<string, string | null> {
  if (!ids) return {};
  const out: Record<string, string | null> = {};
  for (const raw of ids.split(",").slice(0, 200)) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) out[id] = thumbInfo(root, id).at;
  }
  return out;
}

function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let over = false;
    // Over the limit: stop keeping it, drain the rest, then answer 413 (not a dropped connection).
    req.on("data", (chunk) => {
      if (over) return;
      raw += chunk;
      if (raw.length > 4096) { over = true; raw = ""; }
    });
    req.on("end", () => {
      if (over) return reject(new PayloadTooLarge("Request too large"));
      try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
