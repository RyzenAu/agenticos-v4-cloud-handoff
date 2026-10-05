// CRM's transport adapter. Identity, page tokens, jobs and the event stream remain the hub's
// existing services. There is no outward-send route and no second scheduler here.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { ZodError } from "zod";
import { requestPrincipal, requestPageTokenMatches, nonCanonicalTarget } from "../identity/gate";
import { authorise, isBrowserPrincipal, type Principal } from "../identity/principal";
import { serverWorkAllowed, SERVER_WORK_NEEDS_SESSION } from "../identity/operator-sites";
import { hubRole, type HubRole } from "../cloud/hub-role";
import { backgroundJobsDisabled } from "../preview-guard";
import { readLimitedText, MB } from "../http/body";
import { crmRuntime, closeCrmRuntime } from "./runtime";
import { CrmNeedsUpgradeError } from "./upgrade-guard";
import { CrmError } from "./types";
import { attachmentInline } from "./attachments";
import { withholdPrivate } from "./redact";
import type { OpenedAttachment } from "./attachments";
import { readCrmFinanceLinks } from "./finance";
import { parseCrmRef } from "../../src/lib/crm-ref";

export type CrmHttpService = {
  snapshot(): unknown;
  resolveLegacyLead(id: number): unknown;
  finance?(companyId: string): unknown;
  /** A private attachment's bytes, read from the hub's own storage. Throws CrmError not-found. */
  file?(id: string): OpenedAttachment;
  operations: { list(): unknown; run(name: string, input: unknown, principal: Principal): unknown };
  close?(): void;
};
export type CrmHttpOptions = {
  root: string;
  token: string | (() => string);
  role?: () => HubRole;
  readOnly?: () => boolean;
  principal?: (req: IncomingMessage) => Principal | null;
  /** Tests use synthetic SQLite; production always reuses the hub's existing CRM file. */
  service?: () => CrmHttpService;
};

function failure(error: unknown): { status: number; body: unknown } {
  if (error instanceof CrmNeedsUpgradeError)
    return { status: 503, body: { ok: false, code: "needs-upgrade", error: error.message } };
  if (error instanceof ZodError)
    return {
      status: 400,
      body: {
        ok: false,
        code: "validation",
        error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      },
    };
  if (error instanceof CrmError)
    return {
      status:
        error.code === "not-found"
          ? 404
          : error.code === "conflict" || error.code === "idempotency-conflict"
            ? 409
            : error.code === "restricted"
              ? 403
              : 400,
      body: { ok: false, code: error.code, error: error.message },
    };
  // Unexpected errors may include database paths/provider details. Keep those off the wire.
  return {
    status: 503,
    body: {
      ok: false,
      code: "unavailable",
      error:
        "CRM couldn't complete this request. Your form is still here. Refresh the record before trying again.",
    },
  };
}

export function createCrmMiddleware(options: CrmHttpOptions) {
  let opened: CrmHttpService | undefined;
  const service = () => {
    if (opened) return opened;
    if (options.service) return (opened = options.service());
    const { store, operations } = crmRuntime(options.root);
    return (opened = {
      snapshot: () => store.snapshot({ documentSummaries: true }),
      file: (id) => store.openAttachment(id),
      resolveLegacyLead: (id) => store.resolveLegacyLead(id),
      operations,
      finance(companyId) {
        if (!store.getCompany(companyId)) throw new CrmError("not-found", "Company not found.");
        return readCrmFinanceLinks(
          options.root,
          store.snapshot().documents.filter((d) => d.companyId === companyId),
        );
      },
      close() {
        closeCrmRuntime(options.root);
      },
    });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = String(req.url ?? "/");
    const path = raw.split("?")[0];
    if (!/^\/__crm(?:\/|$)/.test(path)) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
    };
    if (nonCanonicalTarget(raw)) return send(400, { ok: false, error: "Non-canonical CRM path." });
    const host = String(req.headers.host ?? "");
    if (req.headers["sec-fetch-site"] === "cross-site")
      return send(403, { ok: false, error: "Cross-site request blocked" });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${host}` &&
      req.headers.origin !== `https://${host}`
    )
      return send(403, { ok: false, error: "Unknown origin" });
    const principal = options.principal
      ? options.principal(req)
      : requestPrincipal(req, { root: options.root });
    if (!principal)
      return send(401, {
        ok: false,
        error: "Sign in to the shared business workspace.",
        signIn: "/__devices/me",
      });
    if (
      !isBrowserPrincipal(principal) ||
      !["usman", "mehroz"].includes(principal.personId) ||
      !authorise(principal, { kind: "business", area: "crm" }).ok
    )
      return send(403, { ok: false, error: "A verified founder session is required." });
    // Private text (document bodies, drafted replies, attachment names, contact notes) is for a CONFIRMED person only.
    const confirmed = principal.actor === "human";
    const visible = <T>(value: T): T => (confirmed ? value : withholdPrivate(value));
    const method = req.method ?? "GET";
    if (!["GET", "HEAD", "POST"].includes(method))
      return send(405, { ok: false, error: "Use GET or POST." });
    const url = new URL(raw, "http://localhost");
    try {
      if (method === "GET" || method === "HEAD") {
        if (path === "/__crm/snapshot") return send(200, visible(service().snapshot()));
        if (path === "/__crm/record") {
          const ref = parseCrmRef(url.searchParams.get("ref") ?? "");
          if (!ref)
            return send(400, {
              ok: false,
              code: "validation",
              error: "Choose a valid CRM record reference.",
            });
          const result = service().operations.run("crm.record.get", { ref }, principal) as {
            ok?: boolean;
            code?: string;
          };
          return send(
            result.ok === false ? (result.code === "not-found" ? 404 : 400) : 200,
            visible(result),
          );
        }
        if (path === "/__crm/ops") return send(200, { operations: service().operations.list() });
        if (path === "/__crm/finance") {
          const companyId = url.searchParams.get("companyId") ?? "";
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(companyId))
            return send(400, { ok: false, error: "Choose a valid company ID." });
          const read = service().finance;
          return read
            ? send(200, read(companyId))
            : send(503, {
                ok: false,
                code: "unavailable",
                error: "The existing Finance snapshot adapter is unavailable.",
              });
        }
        if (path === "/__crm/file") {
          // Private attachments: same founder-session gate as every other CRM read, never a public asset, never cached.
          // Stricter than a snapshot read: client files open only for a person with a CONFIRMED browser session (actor human). A browser
          // that is still pending (even at the hub's own PC), a bare tailnet login, a script or a companion is refused.
          if (principal.actor !== "human")
            return send(403, {
              ok: false,
              error:
                "Open private files from a confirmed browser session: pair this browser first.",
            });
          const file = url.searchParams.get("id") ?? "";
          const read = service().file;
          if (!read)
            return send(404, { ok: false, code: "not-found", error: "Attachment not found." });
          const { attachment, body } = read(file);
          const inline = attachmentInline(attachment.mime);
          res.statusCode = 200;
          res.setHeader("Content-Type", attachment.mime);
          res.setHeader("Content-Length", String(body.byteLength));
          res.setHeader("Cache-Control", "private, no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader(
            "Content-Security-Policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          );
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          res.setHeader(
            "Content-Disposition",
            `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          );
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }
        if (path === "/__crm/resolve-legacy") {
          const lead = url.searchParams.get("lead") ?? "";
          if (!/^[1-9][0-9]{0,14}$/.test(lead) || !Number.isSafeInteger(Number(lead)))
            return send(400, { ok: false, error: "Choose a valid legacy lead ID." });
          const ref = service().resolveLegacyLead(Number(lead));
          return send(ref ? 200 : 404, ref ? { ref } : { ok: false, error: "Lead not found." });
        }
        return send(404, { ok: false, error: "Unknown CRM route." });
      }
      if (path !== "/__crm/ops")
        return send(404, { ok: false, error: "Unknown CRM operation route." });
      if ((options.readOnly ?? backgroundJobsDisabled)())
        return send(409, {
          ok: false,
          code: "read-only",
          error:
            "This is a quiet read-only copy. CRM changes need the owning hub or an isolated write-enabled development workspace.",
        });
      const token = typeof options.token === "function" ? options.token() : options.token;
      if (!requestPageTokenMatches(req, principal, token))
        return send(403, { ok: false, error: "Refresh this page and try again." });
      const role = (options.role ?? hubRole)();
      if (
        role === "server" &&
        principal.via !== "loopback-owner" &&
        !serverWorkAllowed(principal, role)
      )
        return send(403, { ok: false, error: SERVER_WORK_NEEDS_SESSION });
      if (
        String(req.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        return send(415, { ok: false, error: "Send JSON." });
      const text = await readLimitedText(req, res, 2 * MB);
      if (text === null) return;
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return send(400, { ok: false, error: "Invalid JSON body." });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return send(400, { ok: false, error: "Send an operation name and input." });
      const command = body as Record<string, unknown>;
      if (
        typeof command.name !== "string" ||
        !command.name.startsWith("crm.") ||
        Object.keys(command).some((key) => !["name", "input"].includes(key))
      )
        return send(400, {
          ok: false,
          error:
            "Send only a crm.* operation name and input; identity comes from your verified session.",
        });
      if (!confirmed && command.name === "crm.csv.export")
        return send(403, {
          ok: false,
          code: "forbidden",
          text: "Confirm this browser to export.",
          error: "Confirm this browser to export.",
        });
      if (
        !confirmed &&
        ["crm.proposal.draft", "crm.invoice.draft", "crm.quote.package"].includes(command.name)
      )
        return send(403, {
          ok: false,
          code: "forbidden",
          text: "Confirm this browser to draft a proposal.",
          error: "Confirm this browser to draft a proposal.",
        });
      const result = (await service().operations.run(
        command.name,
        command.input ?? {},
        principal,
      )) as { ok?: boolean; code?: string };
      const status =
        result?.ok === false
          ? ((
              {
                "not-found": 404,
                conflict: 409,
                "idempotency-conflict": 409,
                restricted: 403,
                forbidden: 403,
                unauthorised: 401,
                unavailable: 503,
                failed: 503,
              } as Record<string, number>
            )[result.code ?? ""] ?? 400)
          : 200;
      return send(status, visible(result));
    } catch (error) {
      const reply = failure(error);
      return send(reply.status, reply.body);
    }
  };
  return {
    handle,
    close: () => {
      opened?.close?.();
      opened = undefined;
    },
  };
}

export function crmPlugin(options: CrmHttpOptions): Plugin {
  return {
    name: "agentic-os-crm",
    configureServer(server) {
      const middleware = createCrmMiddleware(options);
      server.middlewares.use(middleware.handle);
      server.httpServer?.once("close", middleware.close);
    },
  };
}
