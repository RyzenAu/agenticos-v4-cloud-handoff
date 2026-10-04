import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorResult } from "../../scripts/jarvis-command/contracts";
import { abortableSleep } from "../../scripts/executors/windows";
import type { Executor } from "../executors";
import { AUDIT_SCRIPT } from "./audit-script";
import { createBuildExecutor } from "./build-workspace";
import { checkPublicUrl, type Resolver } from "./urlpolicy";

/**
 * The hands the four bot-computer workflows (research, builder, website audit, business preparation) need beyond the basics, all bounded and typed:
 *
 *   build.component {action,...}   the Builder computer's git workspace (build-workspace.ts)
 *   fixture.open {name}            open an .html file from THIS computer's own working folder in its browser (a local fixture; no network)
 *   page.audit {label,width,height,shot?,analyse?}   read the page in front at one screen size (page-script.ts) and keep a screenshot in the working folder
 *   page.links {items}             read-only GET of up to 25 same-site addresses (status only), or a check that fixture files exist
 *   file.chunk {name,offset,limit} bytes of a working-folder file as base64, in pieces small enough for one reply (a reply is capped at 16 KB)
 *
 * Nothing here clicks, types into a field, submits a form, follows a link on a page, or sends anything anywhere: the audit reads and photographs.
 */

export type ViewportBackend = {
  setViewport(width: number, height: number, mobile: boolean, tabId?: string): Promise<void>;
  clearViewport(tabId?: string): Promise<void>;
  evalJson(script: string, tabId?: string): Promise<string>;
  openFile(url: string): Promise<string>;
  read(tabId?: string): Promise<{ title: string; url: string; ready: string; tabId: string } | null>;
  frame(tabId?: string, quality?: number): Promise<Uint8Array>;
};

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const refused = (said: string): ExecutorResult => ({ ok: false, said, verified: false, data: { refused: true } });
/** Raw bytes per reply. Base64 grows by a third and a reply (the whole JSON body) must stay under 16 KB. */
export const CHUNK_BYTES = 8 * 1024;
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * Open a page from this computer's own folder with the network BLOCKED before it loads (a builder's preview is code a model wrote: whatever it tries,
 * nothing leaves the computer). The tab is made blank, offline emulation and a block on every network scheme are set, and only then is the page loaded.
 */
export async function openOffline(session: { send(method: string, params?: Record<string, unknown>): Promise<unknown> }, url: string): Promise<void> {
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await session.send("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*", "ftp://*"] });
  await session.send("Page.navigate", { url });
}

const MAX_HOPS = 5;
export function createWorkflowExecutors(opts: { workdir: string; browser: ViewportBackend | null; resolve: Resolver; settleMs?: number; fetchImpl?: typeof fetch }): Record<string, Executor> {
  const doFetch = opts.fetchImpl ?? fetch;
  mkdirSync(opts.workdir, { recursive: true });
  const { browser } = opts;
  const build = createBuildExecutor(opts.workdir);
  const settle = opts.settleMs ?? 600;
  const noBrowser = () => refused("This computer has no browser installed, so there is nothing to open or photograph.");

  const executors: Record<string, Executor> = {
    "build.component": async (args, ctx) => build(args, ctx),

    "file.chunk": async (args) => {
      const name = String(args.name ?? "");
      if (!FILE_NAME.test(name)) return refused("A file name is letters, digits, dots, dashes and underscores (no folders).");
      const path = join(opts.workdir, name);
      if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, said: `${name} isn't in this computer's working folder.`, verified: false };
      const size = statSync(path).size;
      if (size > MAX_READ_BYTES) return refused(`${name} is larger than ${MAX_READ_BYTES / 1024 / 1024} MB.`);
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const limit = Math.max(1, Math.min(CHUNK_BYTES, Math.floor(Number(args.limit) || CHUNK_BYTES)));
      const all = readFileSync(path);
      const part = all.subarray(offset, offset + limit);
      return { ok: true, said: `Read ${part.length} bytes of ${name} from ${offset} (${size} bytes in all).`, verified: true, data: { name, size, offset, b64: part.toString("base64"), done: offset + part.length >= size, sha256: sha(all) } };
    },

    "fixture.open": async (args, ctx) => {
      if (!browser) return noBrowser();
      const name = String(args.name ?? "");
      if (!FILE_NAME.test(name) || !/\.html?$/i.test(name)) return refused("A fixture is an .html file in this computer's own working folder.");
      const path = join(opts.workdir, name);
      if (!existsSync(path)) return { ok: false, said: `${name} isn't in this computer's working folder.`, verified: false };
      const tab = await browser.openFile(`file://${path}`);
      let facts = null as Awaited<ReturnType<ViewportBackend["read"]>>;
      for (let i = 0; i < 25 && !ctx.signal.aborted; i++) {
        await abortableSleep(200, ctx.signal);
        facts = await browser.read(tab).catch(() => null);
        if (facts && facts.ready === "complete") break;
      }
      const ok = !!facts && facts.ready === "complete" && facts.url.startsWith("file://") && facts.url.endsWith(`/${name}`);
      return { ok, said: ok ? `Opened ${name} from the working folder: "${facts!.title.slice(0, 60)}".` : `${name} did not open.`, verified: ok, evidence: `file ${name}; ${facts?.ready ?? "no page"}`, data: { tabId: tab, title: facts?.title?.slice(0, 160) ?? "", file: name } };
    },

    "page.audit": async (args, ctx) => {
      if (!browser) return noBrowser();
      const width = Math.floor(Number(args.width));
      const height = Math.floor(Number(args.height));
      const label = String(args.label ?? "view");
      if (!(width >= 280 && width <= 2560 && height >= 400 && height <= 2000)) return refused("A screen is 280 to 2560 wide and 400 to 2000 high.");
      if (!/^[a-z0-9-]{1,30}$/.test(label)) return refused("A label is lowercase letters, digits and dashes.");
      const tab = typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;
      const analyse = args.analyse !== false;
      const mobile = width <= 500;
      let analysis: Record<string, unknown> | null = null;
      let shotName = "";
      let shotBytes = 0;
      try {
        await browser.setViewport(width, height, mobile, tab);
        await abortableSleep(settle, ctx.signal);
        if (analyse) analysis = JSON.parse(await browser.evalJson(AUDIT_SCRIPT, tab)) as Record<string, unknown>;
        if (args.shot !== false) {
          const frame = await browser.frame(tab, 42); // a reply is capped at 16 KB, so a picture comes back in pieces: a lower quality is fewer pieces
          shotName = `shot-${label}.jpg`;
          writeFileSync(join(opts.workdir, shotName), frame, { mode: 0o600 });
          shotBytes = frame.length;
        }
      } catch (e) {
        return { ok: false, said: e instanceof Error ? e.message.slice(0, 160) : "The page couldn't be read at that size.", verified: false };
      } finally {
        await browser.clearViewport(tab).catch(() => undefined);
      }
      if (ctx.signal.aborted) return { ok: false, said: "Stopped.", verified: false, data: { cancelled: true } };
      const wroteOk = !shotName || (existsSync(join(opts.workdir, shotName)) && statSync(join(opts.workdir, shotName)).size === shotBytes);
      const ok = wroteOk && (!analyse || !!analysis?.ok);
      return { ok, said: ok ? `Read the page at ${width}x${height}${analyse ? "" : " (picture only)"}${shotName ? `; saved ${shotName} (${Math.round(shotBytes / 1024)} KB)` : ""}.` : "The page could not be read at that size.", verified: ok, evidence: `${width}x${height}; ${shotBytes} byte picture`, data: { label, width, height, mobile, ...(analysis ? { analysis } : {}), ...(shotName ? { shot: shotName, shotBytes } : {}) } };
    },

    "page.links": async (args, ctx) => {
      const items = Array.isArray(args.items) ? args.items.slice(0, 25) : [];
      if (!items.length) return refused("Give 1 to 25 addresses or files to check.");
      const results: { target: string; status: number | null; ok: boolean; note: string }[] = [];
      for (const it of items) {
        if (ctx.signal.aborted) break;
        const item = it as { url?: unknown; file?: unknown };
        if (typeof item.file === "string") {
          const ok = FILE_NAME.test(item.file) && existsSync(join(opts.workdir, item.file));
          results.push({ target: item.file.slice(0, 80), status: ok ? 200 : 404, ok, note: ok ? "file is there" : "no such file" });
          continue;
        }
        const verdict = await checkPublicUrl(item.url, opts.resolve);
        if (!verdict.ok) {
          results.push({ target: String(item.url ?? "").slice(0, 120), status: null, ok: false, note: `not checked: ${verdict.reason}` });
          continue;
        }
        try {
          // A read-only GET (some sites refuse HEAD). The body is not read. Redirects are followed by the platform, at most a few.
          // Redirects are followed BY HAND: every hop is checked against the same public-address rules BEFORE it is fetched, so a redirect to a
          // private, tailnet or metadata address is never requested.
          let current = verdict.url.href;
          let res: Response | null = null;
          let blocked = "";
          let hops = 0;
          for (; hops <= MAX_HOPS; hops++) {
            res = await doFetch(current, { method: "GET", redirect: "manual", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(12_000)]), headers: { accept: "text/html,*/*;q=0.5", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" } });
            void res.body?.cancel().catch(() => undefined);
            const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
            if (!loc) break;
            let next: string;
            try {
              next = new URL(loc, current).href;
            } catch {
              blocked = "redirected to something that is not an address";
              break;
            }
            const hop = await checkPublicUrl(next, opts.resolve);
            if (!hop.ok) {
              blocked = `redirected to an address the computer won't request (${hop.reason})`;
              break;
            }
            current = hop.url.href;
          }
          if (!blocked && res && hops > MAX_HOPS) blocked = "too many redirects";
          if (blocked || !res) results.push({ target: verdict.url.href.slice(0, 160), status: res?.status ?? null, ok: false, note: `not followed: ${blocked || "no answer"}` });
          else results.push({ target: verdict.url.href.slice(0, 160), status: res.status, ok: res.status < 400, note: res.status < 400 ? (current !== verdict.url.href ? `redirected to ${current.slice(0, 80)}` : "answered") : `HTTP ${res.status}` });
        } catch (e) {
          results.push({ target: verdict.url.href.slice(0, 160), status: null, ok: false, note: ctx.signal.aborted ? "stopped" : `did not answer (${e instanceof Error ? e.message.slice(0, 50) : "error"})` });
        }
      }
      const bad = results.filter((r) => !r.ok).length;
      return { ok: true, said: `Checked ${results.length} link${results.length === 1 ? "" : "s"}: ${results.length - bad} answered, ${bad} did not.`, verified: true, evidence: `${results.length - bad}/${results.length} ok`, data: { results } };
    },
  };
  return executors;
}
