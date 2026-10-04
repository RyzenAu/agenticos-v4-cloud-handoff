import type { IncomingMessage, ServerResponse } from "node:http";
import type { DevicesService } from "../devices/service";
import type { Principal as JobPrincipal } from "../approvals/principal";
import type { ComputersService } from "./service";
import { isNovncAssetPath, novncAsset, viewerCsp, viewerPage } from "./novnc";
import { artifactPage, downloadDisposition, headersFor, type ArtifactStore } from "./artifacts";

/**
 * /__computers: the JSON API the Computers page (Agent C) and agents use. Mount with
 * `server.middlewares.use("/__computers", (req, res, next) => void computers.handle(req, res, next))`.
 *
 * Who is asking comes only from the one identity contract (devices service `identify`): a verified person, never a body field.
 * Reads need any signed-in founder. Lifecycle, takeover, input and the viewer need a PERSON (a confirmed browser session or
 * paired device), not a program: any local program holds the page token, so a script cannot take a computer from an agent.
 * Starting and cancelling an agent job is allowed to a verified process (an agent a founder started), and the agent gets exactly
 * that founder's permitted targets.
 *
 *   GET  /                      { computers: ComputerView[], targets }       every shared computer, and what this person may target
 *   GET  /targets               { targets }                                   this person's own devices + shared computers
 *   GET  /host                  { adapters: [{ kind, check }] }               what each host has and lacks (and the owner's install command)
 *   GET  /events                { events }                                    the recent lifecycle and lease log (no secrets)
 *   POST /host/install-browser  { adapter? }                                  download a headless browser for the host (user-level, no root); only when asked
 *   POST /                      { name, adapter?, resolution?, label? }       provision a computer
 *   POST /:name/action          { action: start|stop|suspend|resume|recover|destroy, force? }
 *   POST /:name/jobs            { agent?, title?, steps: [{ executor, args?, timeoutMs? }], wake? }  -> { jobId }
 *   GET  /jobs/:id              the job and whether it is paused by a person
 *   POST /jobs/:id/cancel
 *   POST /:name/take-here       the SAME person moves their own controls from another window to this one (explicit, recorded, a new epoch); 409 when they hold none
 *   POST /:name/takeover        the lease: granted now, or pending until the agent reaches a step boundary
 *   POST /:name/lease/renew     the viewer's heartbeat (keeps a person's control; an abandoned viewer expires)
 *   POST /:name/return          "Return to agent": the same paused job resumes, re-reading the computer first
 *   POST /:name/input           { executor: input.click|input.type|input.key|browser.navigate|observe.page|file.write|file.read|computer.info, args }   only for the person holding the lease
 *   GET  /artifacts             { artifacts }                                 this person's saved workflow results, newest first
 *   GET  /artifacts/:jobId      the saved result as a page (report, screenshots, preview, files); only for the person who asked
 *   GET  /artifacts/:jobId/f/:file   one file of it (HTML runs in a network-less sandbox); add ?download=1 to save it (Content-Disposition: attachment, a plain file name)
 *   GET  /:name/screenshot      one frame (image/jpeg), read-only
 *   GET  /:name/viewer          the noVNC viewer page (iframe it; contract in novnc.ts)
 *   GET  /:name/screen          { screen }: which layer of the screen is failing (host, display, VNC, viewer, frame, blank), why, and the next action; probes the layers and takes a real screenshot now
 *   POST /:name/screen-report   { frame, blank }: what this person's viewer actually drew (a person only); an all-black frame is a blank screen
 *   GET  /:name/viewer-state    { view, canControl, heldByThisSession, heldByYouElsewhere, me }: whether THIS window holds the lease, or the same person holds it in another window
 *   GET  /assets/novnc/core/*.js, /vendor/*.js   the pinned noVNC client files (signed-in founders only)
 *   Terminal (round 10, scripts/computers/terminal.ts): a confirmed person who holds the computer's control lease in THIS window; checked on every call.
 *   POST /:name/terminal                 { cols?, rows? } -> { id, attached }   open (or re-attach to) this person's terminal; 409 with the reason otherwise
 *   GET  /:name/terminal                 { terminal: { id } | null }             this person's open terminal on the computer
 *   GET  /:name/terminal/:id/events?after=<seq>&wait=<ms>  { chunks: [{ seq, data }], next, gap, closed: { reason } | null }  output (long-polls up to 25 s)
 *   POST /:name/terminal/:id/input       { data }        keystrokes (UTF-8 text, at most 4 KB a call); each Enter is logged as a command
 *   POST /:name/terminal/:id/resize      { cols, rows }
 *   POST /:name/terminal/:id/close
 */

export type ComputersRoutesOptions = { devices: DevicesService; computers: ComputersService; /** Was this job made for a shared agent bot (the job service records `bot`)? Its saved result is then open to BOTH founders; any other result stays its owner's. */ isBotResult?: (jobId: string) => boolean; /** Saved results of workflows (research, builder, audit, business preparation); the routes under /artifacts. */ artifacts?: ArtifactStore; /** The repo root that holds node_modules/@novnc/novnc (default: the working directory). */ root?: string };

const LIMIT = 16 * 1024;
/** What a person holding the lease may send: browser input, and (on a computer with no browser) its files and a status read. */
export const HUMAN_INPUT = ["input.click", "input.type", "input.key", "browser.navigate", "observe.page", "file.write", "file.read", "computer.info"];
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function createComputersRoutes(options: ComputersRoutesOptions) {
  const { devices, computers } = options;

  function send(res: ServerResponse, status: number, value: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  }

  async function body(req: IncomingMessage): Promise<any> {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw Object.assign(new Error("JSON required"), { status: 415 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMIT) throw Object.assign(new Error("Too large"), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      throw Object.assign(new Error("Bad JSON"), { status: 400 });
    }
  }

  function artifactRoute(res: ServerResponse, path: string, person: string, download = false, shared = false) {
    const store = options.artifacts;
    /** Whose result this is for THIS caller: their own; or, for a shared bot's job and a confirmed founder, its owner's (both founders see a bot's work). */
    const holder = (id: string): string | null => {
      if (!store) return null;
      if (store.get(id, person)) return person;
      const owner = store.ownerOf(id);
      return shared && owner && options.isBotResult?.(id.toLowerCase()) ? owner : null;
    };
    const html = (status: number, page: string) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'");
      res.end(page);
    };
    const missing = () => html(404, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No saved result</title><body style="font:16px system-ui;margin:32px;max-width:36em"><h1>No saved result</h1><p>There is no saved result for this job that belongs to you. It may not have finished, or it was never saved.</p>');
    if (path === "/artifacts") {
      const list = !store ? [] : shared ? store.listAll().filter((a) => a.personId === person || options.isBotResult?.(a.id)) : store.list(person);
      return send(res, 200, { artifacts: list.map(({ personId: _p, ...m }) => m) });
    }
    if (!store) return missing();
    const m = /^\/artifacts\/([0-9a-f-]{36})(?:\/f\/([^/]+))?$/i.exec(path);
    if (!m) return missing();
    if (!m[2]) {
      const owner = holder(m[1]);
      const meta = owner ? store.get(m[1], owner) : null;
      if (!meta || !owner) return missing();
      const main = store.file(m[1], owner, meta.main);
      return html(200, artifactPage(meta, main && !/^(?:image|application\/octet)/.test(main.mime) ? main.data.toString("utf8") : null, `/__computers/artifacts/${meta.id}`));
    }
    let name = "";
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return missing();
    }
    const owner = holder(m[1]);
    const f = owner ? store.file(m[1], owner, name) : null;
    if (!f) return missing();
    res.statusCode = 200;
    for (const [k, v] of Object.entries(headersFor(f.mime))) res.setHeader(k, v);
    if (download) res.setHeader("Content-Disposition", downloadDisposition(name));
    res.setHeader("Content-Length", String(f.data.length));
    res.end(f.data);
  }

  /** The verified caller for a request, or the refusal to send. */
  function caller(req: IncomingMessage, path: string, method: string) {
    const id = devices.identify(req);
    if (!id.loopbackSocket) return { error: { status: 403, message: "Local access only" } };
    if (!id.local && !id.tailnet) return { error: { status: 403, message: "Local host required" } };
    const principal = id.principal;
    if (!principal || !id.verified) return { error: { status: 401, message: "Pair this device first." } };
    if (method !== "GET") {
      const blocked = devices.browserWriteBlocked(req, id, path);
      if (blocked) return { error: { status: 403, message: blocked } };
    }
    if (principal.sharedOnly) return { error: { status: 403, message: "Computer control needs your own paired device." } };
    const human = id.verified.actor === "human";
    return { id, person: principal.personId, human, session: id.verified.sessionId ?? null, verified: id.verified };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/^\/__computers(?=\/|$)/, "").replace(/\/+$/, "") || "/";
      const method = req.method || "GET";
      const who = caller(req, path, method);
      if ("error" in who) return send(res, who.error!.status, { error: who.error!.message });
      const needPerson = () => (who.human && who.session ? null : "Only a person using a confirmed browser or paired device can do that, not a program.");
      const personRef = () => ({ personId: who.person, session: who.session! });

      if (method === "GET" && isNovncAssetPath(path)) {
        const a = novncAsset(options.root ?? process.cwd(), path);
        if (!a) return send(res, 404, { error: "Not found" });
        res.statusCode = 200;
        res.setHeader("Content-Type", a.type);
        res.setHeader("Cache-Control", "private, max-age=3600");
        return void res.end(a.body);
      }
      if (method === "GET" && (path === "/artifacts" || path.startsWith("/artifacts/"))) return artifactRoute(res, path, who.person, url.searchParams.get("download") === "1", who.verified.via === "loopback-owner" || who.verified.via === "paired-session");
      if (method === "GET" && path === "/") {
        // For a browser session each row also says whether THIS window holds the controls or the same person holds them in another window.
        const rows = computers.list().map((c) => (who.session && c.id ? { ...c, ...(({ heldByThisSession, heldByYouElsewhere }) => ({ heldByThisSession, heldByYouElsewhere }))(computers.sessionFlags(c.name, personRef())) } : c));
        return send(res, 200, { computers: rows, targets: computers.targets(who.person) });
      }
      if (method === "GET" && path === "/targets") return send(res, 200, { targets: computers.targets(who.person) });
      if (method === "GET" && path === "/events") return send(res, 200, { events: computers.events() });
      if (method === "GET" && path === "/host") return send(res, 200, await computers.host());

      if (method === "POST" && path === "/host/install-browser") {
        const refused = needPerson();
        if (refused) return send(res, 403, { error: refused });
        const b = await body(req);
        return send(res, 200, await computers.installBrowser(typeof b.adapter === "string" ? b.adapter : undefined));
      }
      if (method === "POST" && path === "/") {
        const refused = needPerson();
        if (refused) return send(res, 403, { error: refused });
        const b = await body(req);
        const computer = await computers.provision({ name: String(b.name ?? ""), by: who.person, ...(typeof b.adapter === "string" ? { adapter: b.adapter } : {}), ...(typeof b.resolution === "string" ? { resolution: b.resolution } : {}), ...(typeof b.label === "string" ? { label: b.label } : {}) });
        return send(res, 200, { computer });
      }

      let m = /^\/jobs\/([0-9a-f-]{36})(\/cancel)?$/.exec(path);
      if (m) {
        if (!m[2] && method === "GET") {
          const job = computers.jobView(m[1]);
          return job ? send(res, 200, { job }) : send(res, 404, { error: "No such job." });
        }
        if (m[2] && method === "POST") {
          const r = await computers.cancelJob(m[1]);
          return send(res, r.ok ? 200 : 409, { cancelled: r.ok, state: r.state });
        }
      }

      // A person's terminal on a computer they hold (round 10): the same confirmed-person and control-lease rule as /input, checked again on every call.
      m = /^\/([a-z0-9-]{1,32})\/terminal(?:\/([a-z0-9]{6,40})\/(events|input|resize|close))?$/.exec(path);
      if (m && NAME.test(m[1])) {
        const refused = needPerson();
        if (refused) return send(res, 403, { error: refused });
        const [, name, id, op] = m;
        const t = computers.terminals;
        if (!id) {
          if (method === "GET") return send(res, 200, { terminal: t.openFor(name, personRef()) });
          if (method !== "POST") return send(res, 405, { error: "POST to open a terminal." });
          const b = await body(req);
          const r = await t.start(name, personRef(), { cols: Number(b.cols), rows: Number(b.rows) });
          return send(res, r.ok ? 200 : r.status, r.ok ? { id: r.id, attached: r.attached } : { error: r.reason });
        }
        if (op === "events" && method === "GET") {
          const r = await t.events(name, id, personRef(), Math.max(0, Number(url.searchParams.get("after")) || 0), Math.min(25_000, Math.max(0, Number(url.searchParams.get("wait")) || 0)));
          return send(res, r.ok ? 200 : r.status, r.ok ? { id: r.id, chunks: r.chunks, next: r.next, gap: r.gap, closed: r.closed } : { error: r.reason });
        }
        if (method !== "POST") return send(res, 405, { error: "Not allowed." });
        const b = await body(req);
        const r = op === "input" ? t.input(name, id, personRef(), typeof b.data === "string" ? b.data : "") : op === "resize" ? t.resize(name, id, personRef(), Number(b.cols), Number(b.rows)) : t.close(name, id, personRef());
        return send(res, r.ok ? 200 : r.status, r.ok ? { ok: true } : { error: r.reason });
      }

      m = /^\/([a-z0-9-]{1,32})\/(action|jobs|takeover|take-here|lease\/renew|return|input|screenshot|screen|screen-report|viewer|viewer-state)$/.exec(path);
      if (m && NAME.test(m[1])) {
        const name = m[1];
        const op = m[2];
        if (method === "GET" && op === "viewer") {
          computers.view(name); // 404 for an unknown computer
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Security-Policy", viewerCsp(String(req.headers.host ?? "")));
          res.setHeader("X-Frame-Options", "SAMEORIGIN");
          return void res.end(viewerPage(name));
        }
        if (method === "GET" && op === "viewer-state") {
          if (!who.session) return send(res, 200, { view: computers.view(name), canControl: false, heldByThisSession: false, heldByYouElsewhere: false, me: who.person });
          return send(res, 200, computers.viewerState(name, personRef()));
        }
        if (method === "GET" && op === "screen") return send(res, 200, { screen: await computers.verifyScreen(name) });
        if (method === "GET" && op === "screenshot") {
          const shot = await computers.snapshot(name);
          if (!shot) return send(res, 404, { error: "This computer has no desktop to show (its host is missing the desktop packages)." });
          res.statusCode = 200;
          res.setHeader("Content-Type", shot.mime);
          res.setHeader("Cache-Control", "no-store");
          return void res.end(Buffer.from(shot.data));
        }
        if (method !== "POST") return send(res, 404, { error: "Not found" });
        const b = await body(req);
        if (op === "jobs") {
          const r = await computers.startJob({ computer: name, by: who.person, principal: who.verified as unknown as JobPrincipal, agent: typeof b.agent === "string" ? b.agent : undefined, title: typeof b.title === "string" ? b.title : undefined, steps: b.steps, wake: b.wake !== false });
          return send(res, r.ok ? 200 : r.status, r.ok ? { jobId: r.jobId } : { error: r.reason });
        }
        const refused = needPerson();
        if (refused) return send(res, 403, { error: refused });
        if (op === "action") {
          const action = String(b.action ?? "");
          if (action === "destroy") {
            await computers.destroy(name);
            return send(res, 200, { destroyed: name });
          }
          if (!["start", "stop", "suspend", "resume", "recover"].includes(action)) return send(res, 400, { error: "Unknown action." });
          return send(res, 200, { computer: await computers.lifecycle(name, action as "start", { force: b.force === true }) });
        }
        if (op === "screen-report") {
          const refusedReport = needPerson();
          if (refusedReport) return send(res, 403, { error: refusedReport });
          computers.screenReport(name, { blank: typeof b.blank === "boolean" ? b.blank : null, frame: b.frame === true });
          return send(res, 200, { screen: computers.view(name).screen });
        }
        if (op === "take-here") return send(res, 200, computers.takeHere(name, personRef()));
        if (op === "takeover") return send(res, 200, computers.takeover(name, personRef()));
        if (op === "lease/renew") return send(res, 200, computers.viewerHeartbeat(name, personRef()));
        if (op === "return") return send(res, 200, computers.returnToAgent(name, personRef()));
        if (op === "input") {
          const executor = String(b.executor ?? "");
          if (!HUMAN_INPUT.includes(executor)) return send(res, 400, { error: "Unknown input." });
          const r = await computers.input(name, personRef(), { executor: executor, args: b.args && typeof b.args === "object" ? b.args : {} });
          return send(res, r.ok ? 200 : r.status, r.ok ? { result: r.result } : { error: r.reason });
        }
      }
      if (next) return next();
      return send(res, 404, { error: "Not found" });
    } catch (error: any) {
      if (!error?.status) console.error("[computers] unexpected error:", String(error?.stack ?? error).slice(0, 600));
      return send(res, error?.status ?? 500, { error: error?.status ? String(error.message).slice(0, 300) : "Something went wrong." });
    }
  }

  return { handle };
}

export type ComputersRoutes = ReturnType<typeof createComputersRoutes>;
