// /__websites/* — the data behind Sales -> Website. Mounted by the lead-sites plugin (same server,
// same guards): loopback only, a local Host, same origin, and the one POST needs the page's
// X-Claude-OS-Token. Read-only apart from caching screenshots; nothing deploys or contacts anyone.
//
//   GET  /overview          our sites, lead-preview extras, templates, drafts, screenshot states
//   GET  /thumb?key=<key>   a cached screenshot (keys come from /overview; never a URL)
//   POST /thumbs {keys?, force?}  queue missing/stale screenshots (all of them when keys is omitted)
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crmPath, findLead, openCrm } from "../leads/crm";
import { listLocalSites, localPreviewUrl, previewServerState } from "../lead-sites/preview-server";
import { readRegistry } from "../lead-sites/registry";
import { publicSiteUrl } from "../lead-sites/thumb";
import {
  draftInfo,
  lastCommit,
  linkedProject,
  OUR_SITES,
  parseClientBrief,
  readVercelCache,
  refreshVercelIfStale,
  templateInfo,
  type OurSite,
} from "./catalogue";
import { enqueueThumbs, isThumbKey, queueStatus, thumbFile, thumbState, type ThumbTarget } from "./thumbs";
import { refuseUnlessAtThisPc } from "../identity/gate";

export type WebsitesOptions = { root: string; draftsRoot: string; reposRoot?: string; sites?: OurSite[]; vercel?: boolean };

/** Every screenshot the page can show, keyed. */
export function thumbTargets(opts: WebsitesOptions, leadSites?: Map<number, string>): ThumbTarget[] {
  const { root, draftsRoot } = opts;
  const out: ThumbTarget[] = (opts.sites ?? OUR_SITES).map((s) => ({ key: `site-${s.id}`, kind: "live" as const, url: s.url }));
  for (const p of readRegistry(root)) {
    out.push({ key: `preview-${p.leadId}`, kind: "local", url: localPreviewUrl(p.slug), source: join(p.dir, "index.html") });
    const website = leadSites?.get(p.leadId);
    if (website && publicSiteUrl(website)) out.push({ key: `real-${p.leadId}`, kind: "real", leadId: p.leadId, website });
  }
  const local = listLocalSites(draftsRoot);
  for (const v of local.templates)
    out.push({ key: `tpl-${v}`, kind: "local", url: localPreviewUrl(`tpl--${v}`), source: join(draftsRoot, "_templates", v, "index.html") });
  for (const d of local.drafts)
    out.push({ key: `draft-${d}`, kind: "local", url: localPreviewUrl(`draft--${d}`), source: join(draftsRoot, d, "index.html") });
  return out;
}

/** Each previewed lead's own website (for the before/after), read from the CRM. */
function leadWebsites(root: string): Map<number, { website: string; name: string; status: string; area: string }> {
  const out = new Map<number, { website: string; name: string; status: string; area: string }>();
  const previews = readRegistry(root);
  if (!previews.length || !existsSync(crmPath(root))) return out;
  const db = openCrm(crmPath(root));
  try {
    for (const p of previews) {
      const lead = findLead(db, p.leadId);
      if (lead) out.set(p.leadId, { website: lead.website, name: lead.name, status: lead.status, area: lead.area });
    }
  } finally {
    db.close();
  }
  return out;
}

export async function websitesOverview(opts: WebsitesOptions) {
  const { root, draftsRoot } = opts;
  const reposRoot = opts.reposRoot ?? dirname(root);
  const leads = leadWebsites(root);
  const targets = new Map(thumbTargets(opts, new Map([...leads].map(([id, l]) => [id, l.website]))).map((t) => [t.key, t]));
  const thumb = (key: string) => {
    const t = targets.get(key);
    return t ? thumbState(root, t) : null;
  };
  const vercel = readVercelCache(root);
  const refreshing = opts.vercel === false ? false : refreshVercelIfStale(root).refreshing;
  const project = (name: string) => vercel.projects.find((p) => p.name === name) ?? null;

  const siteList = opts.sites ?? OUR_SITES;
  // Every repo's last commit in parallel, off the event loop (T8b, review T8 S-6).
  const commits = await Promise.all(siteList.map((s) => lastCommit(join(reposRoot, s.repo))));
  const sites = siteList.map((s, i) => {
    const dir = join(reposRoot, s.repo);
    const briefFile = s.brief ? join(dir, s.brief) : null;
    const linked = linkedProject(dir);
    const deployed = project(s.project);
    return {
      id: s.id,
      kind: s.kind,
      name: s.name,
      vertical: s.vertical,
      url: s.url,
      alsoAt: s.alsoAt,
      project: s.project,
      /** A repo linked to a different project than we expect is worth a warning. */
      linkedProject: linked,
      deployedAt: deployed?.updatedAt ?? null,
      repo: { path: dir, exists: existsSync(dir), commit: commits[i] },
      brief: briefFile && existsSync(briefFile) ? parseClientBrief(readFileSync(briefFile, "utf8")) : null,
      thumb: thumb(`site-${s.id}`),
    };
  });

  const previews = readRegistry(root).map((p) => ({
    leadId: p.leadId,
    lead: leads.get(p.leadId) ?? null,
    previewThumb: thumb(`preview-${p.leadId}`),
    realThumb: thumb(`real-${p.leadId}`),
    deployedProjectAt: project(p.project)?.updatedAt ?? null,
  }));

  const local = listLocalSites(draftsRoot);
  const templates = local.templates.map((v) => ({ ...templateInfo(draftsRoot, v), localUrl: localPreviewUrl(`tpl--${v}`), thumb: thumb(`tpl-${v}`) }));
  const drafts = local.drafts
    .map((d) => ({ ...draftInfo(draftsRoot, d), localUrl: localPreviewUrl(`draft--${d}`), thumb: thumb(`draft-${d}`) }))
    .sort((a, b) => (b.builtAt ?? "").localeCompare(a.builtAt ?? ""));

  return {
    sites,
    previews,
    templates,
    drafts,
    previewServer: previewServerState(),
    vercel: { at: vercel.at, error: vercel.error, refreshing },
    thumbs: queueStatus(),
  };
}

export function websitesMiddleware(opts: WebsitesOptions & { token: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    };
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) return send({ error: "Only available on this PC." }, 403);
    const host = req.headers.host || "";
    // Stage B1: the verified principal must be the owner at this PC (relay headers never pass as local).
    const notHere = refuseUnlessAtThisPc(req, "Only available on this PC.", { root: opts.root });
    if (notHere) return send({ error: notHere.error }, notHere.status);
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return send({ error: "Unknown origin" }, 403);
    const url = new URL(req.url || "/", "http://localhost");
    const method = req.method || "GET";
    try {
      if (method === "GET" && url.pathname === "/overview") return send(await websitesOverview(opts));
      if (method === "GET" && url.pathname === "/thumb") {
        const key = url.searchParams.get("key") ?? "";
        if (!isThumbKey(key)) return send({ error: "Unknown screenshot" }, 400);
        const target = thumbTargets(opts).find((t) => t.key === key) ??
          (key.startsWith("real-") ? { key, kind: "real" as const, leadId: Number(key.slice(5)) } : null);
        const file = target ? thumbFile(opts.root, target) : null;
        if (!file || !existsSync(file)) return send({ error: "No screenshot yet" }, 404);
        res.setHeader("Content-Type", file.endsWith(".png") ? "image/png" : "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable"); // the page adds ?t=<taken-at>
        return res.end(readFileSync(file));
      }
      if (method === "POST" && url.pathname === "/thumbs") {
        if (req.headers["x-claude-os-token"] !== opts.token) return send({ error: "Refresh this page and try again." }, 403);
        if (!req.headers["content-type"]?.includes("application/json")) return send({ error: "JSON required" }, 415);
        const body = await readJson(req);
        const leads = leadWebsites(opts.root);
        const all = thumbTargets(opts, new Map([...leads].map(([id, l]) => [id, l.website])));
        const keys = Array.isArray(body?.keys) ? new Set(body.keys.filter((k: unknown) => typeof k === "string" && isThumbKey(k))) : null;
        const queued = enqueueThumbs(opts.root, keys ? all.filter((t) => keys.has(t.key)) : all, { force: body?.force === true });
        return send({ ...queueStatus(), queued });
      }
      return send({ error: "Not found" }, 404);
    } catch (error) {
      return send({ error: error instanceof Error ? error.message : "That didn't work." }, 400);
    }
  };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8192) { reject(new Error("Request too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
