// Vite dev-server plugin serving the local files a completed SEO audit produced
// (.operator-data/seo-audits/<leadId>/report.pdf|xlsx|md), mounted at /__seo-audit-files/*. Running
// the audit and reading its JSON status go through the ordinary /__operator/leads/seo-audit routes
// (scripts/leads/api.ts); this plugin only streams the resulting binary/text files, the same way
// scripts/lead-sites/plugin.ts's GET /thumb streams a screenshot -- loopback-only, GET-only, no
// token needed because nothing here is mutated or spent.
import { createReadStream, existsSync } from "node:fs";
import type { Plugin } from "vite";
import { seoAuditFilePath } from "./seo-audit";
import { refuseUnlessAtThisPc } from "../identity/gate";

const CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
};

export function seoAuditFilesPlugin(options: { root: string }): Plugin {
  const { root } = options;
  return {
    name: "mu-seo-audit-files",
    configureServer(server) {
      server.middlewares.use("/__seo-audit-files", (req, res) => {
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
          return send({ error: "SEO audit files can only be opened from this PC." }, 403);
        // Stage B1: the verified principal must be the owner at this PC (a socket check alone let
        // any Serve-relayed request through).
        const notHere = refuseUnlessAtThisPc(req, "SEO audit files can only be opened from this PC.", { root: options.root });
        if (notHere) return send({ error: notHere.error }, notHere.status);
        if (req.method !== "GET") return send({ error: "Not found" }, 404);
        const url = new URL(req.url || "/", "http://localhost");
        const id = Number(url.searchParams.get("id"));
        const kind = url.searchParams.get("kind");
        if (!Number.isInteger(id) || id <= 0) return send({ error: "Missing lead id." }, 400);
        if (kind !== "pdf" && kind !== "xlsx" && kind !== "md" && kind !== "json") return send({ error: "kind must be pdf, xlsx, md or json." }, 400);
        const file = seoAuditFilePath(root, id, kind);
        if (!existsSync(file)) return send({ error: "Not generated yet." }, 404);
        res.setHeader("Content-Type", CONTENT_TYPE[kind]);
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Disposition", `inline; filename="lead-${id}-seo-audit.${kind === "json" ? "json" : kind}"`);
        createReadStream(file).pipe(res);
      });
    },
  };
}
