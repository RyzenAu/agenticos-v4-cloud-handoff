// Cached screenshots for the Website page, one headless-browser capture at a time through the same
// agent-browser CLI the lead thumbnails and site-draft QA use. Captures only ever target addresses
// computed here from real records (our live sites, our local previews, a lead's own public site);
// the page asks by key and can never name a URL. Page loads never wait on this: missing or stale
// screenshots are queued and the page polls.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentBrowserBin, defaultRunner, type Runner } from "../site-draft/qa";
import { captureThumb, thumbPath } from "../lead-sites/thumb";
import { dataDirFor } from "../cloud/data-dir";

export type ThumbTarget =
  | { key: string; kind: "live"; url: string }
  /** `source` is the file whose change makes the screenshot stale (the preview's index.html). */
  | { key: string; kind: "local"; url: string; source: string }
  | { key: string; kind: "real"; leadId: number; website: string };

export type ThumbState = { key: string; at: string | null; stale: boolean; error: string | null; busy: boolean };

const KEY = /^(site|preview|tpl|draft|real)-[a-z0-9-]{1,80}$/;
const LIVE_TTL = 24 * 3_600_000;

export const isThumbKey = (key: string) => KEY.test(key);

export function thumbFile(root: string, target: Pick<ThumbTarget, "key" | "kind"> & { leadId?: number }): string {
  if (target.kind === "real") return thumbPath(root, (target as { leadId: number }).leadId);
  return join(dataDirFor(root), "website-thumbs", `${target.key}.jpg`);
}

// One queue per process (a dev-server reload re-imports this module; two workers would fight over
// the same browser session).
type Queue = { pending: string[]; current: string | null; errors: Record<string, string>; running: boolean; targets: Map<string, ThumbTarget> };
const G = globalThis as { __muWebsiteThumbs?: Queue };
const queue = (): Queue => (G.__muWebsiteThumbs ??= { pending: [], current: null, errors: {}, running: false, targets: new Map() });

export function thumbState(root: string, target: ThumbTarget, now = Date.now()): ThumbState {
  const file = thumbFile(root, target);
  const q = queue();
  let at: string | null = null;
  let stale = true;
  if (existsSync(file)) {
    const taken = statSync(file).mtimeMs;
    at = new Date(taken).toISOString();
    if (target.kind === "live") stale = now - taken > LIVE_TTL;
    else if (target.kind === "local") stale = existsSync(target.source) && statSync(target.source).mtimeMs > taken;
    else stale = false; // a lead's real site: captured on request (drawer) or once when missing
  }
  return { key: target.key, at, stale, error: q.errors[target.key] ?? null, busy: q.current === target.key || q.pending.includes(target.key) };
}

export function queueStatus() {
  const q = queue();
  return { capturing: q.current, queued: [...q.pending] };
}

/**
 * Queues captures and starts the worker if it isn't running. With no `force`, only missing or stale
 * screenshots are queued (and one that failed isn't retried until forced).
 */
export function enqueueThumbs(
  root: string,
  targets: ThumbTarget[],
  opts: { force?: boolean; runner?: Runner; capture?: typeof captureThumb } = {},
): string[] {
  const q = queue();
  const added: string[] = [];
  for (const t of targets) {
    if (q.current === t.key || q.pending.includes(t.key)) continue;
    const s = thumbState(root, t);
    if (!opts.force && (!s.stale || (s.error && s.at === null) || (s.error && t.kind === "real"))) continue;
    if (opts.force) delete q.errors[t.key];
    q.targets.set(t.key, t);
    q.pending.push(t.key);
    added.push(t.key);
  }
  if (added.length && !q.running) void work(root, opts);
  return added;
}

/** Resolves once the queue is empty (tests). */
export async function thumbsIdle(): Promise<void> {
  while (queue().running) await new Promise((r) => setTimeout(r, 10));
}

async function work(root: string, opts: { runner?: Runner; capture?: typeof captureThumb }) {
  const q = queue();
  q.running = true;
  const run = opts.runner ?? defaultRunner(defaultAgentBrowserBin(), 45_000);
  const S = ["--session", "websites-thumbs"];
  let opened = false;
  try {
    while (q.pending.length) {
      const key = q.pending.shift()!;
      const target = q.targets.get(key);
      if (!target) continue;
      q.current = key;
      try {
        if (target.kind === "real") {
          await (opts.capture ?? captureThumb)(root, target.leadId, target.website);
        } else {
          opened = true;
          await captureShot(run, S, target.url, thumbFile(root, target));
        }
        delete q.errors[key];
      } catch (error) {
        q.errors[key] = error instanceof Error ? error.message : "Screenshot failed.";
      }
    }
  } finally {
    q.current = null;
    if (opened) await run([...S, "close"]).catch(() => {});
    q.running = false;
    // Anything queued while the browser was closing gets its own run.
    if (q.pending.length) void work(root, opts);
  }
}

/** One viewport screenshot as a JPEG (a 1280x800 PNG is ~2 MB; this is ~150 KB). */
export async function captureShot(run: Runner, session: string[], url: string, file: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  const started = Date.now() - 1000;
  const saved = () => existsSync(file) && statSync(file).mtimeMs >= started && statSync(file).size > 6_000;
  for (const waitMs of ["2500", "6000"]) {
    await run([...session, "open", url]);
    await run([...session, "set", "viewport", "1280", "800"]);
    await run([...session, "wait", waitMs]);
    await run([...session, "screenshot", "--screenshot-format", "jpeg", "--screenshot-quality", "72", file]);
    if (saved()) return file;
  }
  throw new Error("Couldn't capture this page — it may be slow or block headless browsers.");
}
