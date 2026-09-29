// What the Sales -> Website page shows: M&U's own sites (clients and flagships), the generated lead
// previews, and the local templates and site-drafts. Everything is read from real files on this PC
// (client briefs, .vercel/project.json names, template.json, evidence.json, git) plus a cached
// `vercel project ls` for last-deployed times. Nothing here reads a .env file or a credential, and
// nothing deploys: the Vercel call is a read-only project listing.
import { spawn } from "node:child_process";
import { runCapture } from "../nonblocking-exec";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SiteKind = "client" | "flagship";
export type OurSite = {
  id: string;
  kind: SiteKind;
  name: string;
  vertical: "dental" | "legal" | "real-estate";
  /** The address we send people to. */
  url: string;
  /** Other live addresses for the same build. */
  alsoAt: string[];
  /** Vercel project (team nahda). Checked against the repo's .vercel/project.json when there is one. */
  project: string;
  /** Source folder, relative to the repos root. */
  repo: string;
  /** Client hub file in the repo (clients only). */
  brief?: string;
};

/** M&U's own websites. Addresses checked 25 Sep 2026 against `vercel project ls` and the live pages. */
export const OUR_SITES: OurSite[] = [
  {
    id: "bianca",
    kind: "client",
    name: "Bianca Brown Realty",
    vertical: "real-estate",
    url: "https://bianca.muventures.com.au",
    alsoAt: ["https://bianca-preview.muventures.com.au"],
    project: "bianca-brown-realty",
    repo: "bianca-brown-realty",
    brief: "CLIENT.md",
  },
  {
    id: "aldergate",
    kind: "flagship",
    name: "Aldergate",
    vertical: "real-estate",
    url: "https://aldergate.muventures.com.au",
    alsoAt: ["https://aldergate-demo.vercel.app"],
    project: "aldergate-demo",
    repo: "aldergate",
  },
  {
    id: "marden-rowe",
    kind: "flagship",
    name: "Marden & Rowe",
    vertical: "legal",
    url: "https://mardenrowe.muventures.com.au",
    alsoAt: ["https://muv-flagship-legal.vercel.app"],
    project: "muv-flagship-legal",
    repo: "muv-flagship-legal",
  },
  {
    id: "lantern-dental",
    kind: "flagship",
    name: "Lantern Dental",
    vertical: "dental",
    url: "https://muv-demo-dental.vercel.app",
    alsoAt: [],
    project: "muv-demo-dental",
    repo: "muv-demo-dental",
  },
];

// ── client hub (CLIENT.md) ───────────────────────────────────────────────

export type ClientBrief = {
  status: string | null;
  updated: string | null;
  previewDue: string | null;
  launchTarget: string | null;
  checklist: { done: number; total: number; next: string | null };
};

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "~13 Oct 2026" -> "2026-10-13" (no time zone games: a calendar date). */
export function parseDay(text: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(text);
  if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
  const month = String(MONTHS[m[2].toLowerCase()] + 1).padStart(2, "0");
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

const plainText = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

/**
 * Status, dates and delivery progress from a client hub. Deliberately narrow: contact details,
 * billing and the agreement never leave the file.
 */
export function parseClientBrief(md: string): ClientBrief {
  const header = /\*Last updated:\s*([0-9-]{10})[^*]*?Status:\s*([^*(\n]+)/i.exec(md);
  const row = (label: RegExp) => {
    for (const line of md.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length > 2 && label.test(plainText(cells[2] ?? ""))) return parseDay(plainText(cells[1] ?? ""));
    }
    return null;
  };
  const checklistBlock = /##\s*\d*\s*·?\s*Delivery checklist([\s\S]*?)(?:\n##\s|$)/i.exec(md)?.[1] ?? "";
  const items: { done: boolean; text: string }[] = [];
  let current: { done: boolean; text: string } | null = null;
  for (const line of checklistBlock.split(/\r?\n/)) {
    const item = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (item) {
      current = { done: item[1] !== " ", text: item[2] };
      items.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.text += ` ${line.trim()}`;
    } else current = null;
  }
  const next = items.find((i) => !i.done);
  const status = header?.[2]?.trim() ?? null;
  return {
    status: status ? status.charAt(0) + status.slice(1).toLowerCase() : null,
    updated: header?.[1] ?? null,
    previewDue: row(/^preview due/i),
    launchTarget: row(/^target launch/i),
    checklist: { done: items.filter((i) => i.done).length, total: items.length, next: next ? plainText(next.text).slice(0, 160) : null },
  };
}

// ── git and .vercel ──────────────────────────────────────────────────────

export type Commit = { at: string; subject: string } | null;
const gitCache = new Map<string, { t: number; value: Commit }>();
const gitPending = new Map<string, Promise<Commit>>();

/** `git log -1` for one repo; injectable so a test can make it slow. */
export type GitLog = (dir: string) => Promise<{ status: number | null; stdout: string }>;
const gitLog: GitLog = (dir) => runCapture("git", ["-C", dir, "log", "-1", "--format=%cI%x1f%s"], { timeout: 4000 });

/**
 * The repo's last commit, cached for a minute per folder. Async (T8b, review T8 S-6): a spawnSync per
 * site held the whole server for every /__websites/overview once the minute had passed. Concurrent
 * callers for one folder share one git run.
 */
export function lastCommit(dir: string, run: GitLog = gitLog): Promise<Commit> {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.t < 60_000) return Promise.resolve(hit.value);
  if (!existsSync(join(dir, ".git"))) {
    gitCache.set(dir, { t: Date.now(), value: null });
    return Promise.resolve(null);
  }
  let pending = gitPending.get(dir);
  if (!pending) {
    pending = run(dir)
      .then((r): Commit => {
        const [at, subject] = (r.stdout || "").trim().split("\x1f");
        return r.status === 0 && at ? { at: new Date(at).toISOString(), subject: (subject ?? "").slice(0, 140) } : null;
      })
      .catch((): Commit => null)
      .then((value) => (gitCache.set(dir, { t: Date.now(), value }), value))
      .finally(() => gitPending.delete(dir));
    gitPending.set(dir, pending);
  }
  return pending;
}

/** The project NAME from .vercel/project.json — the only field read (the ids aren't needed). */
export function linkedProject(dir: string): string | null {
  const file = join(dir, ".vercel", "project.json");
  if (!existsSync(file)) return null;
  try {
    const name = JSON.parse(readFileSync(file, "utf8"))?.projectName;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

// ── Vercel: a cached, read-only project listing ──────────────────────────

export type VercelProject = { name: string; url: string | null; updatedAt: string | null };
export type VercelCache = { at: string | null; projects: VercelProject[]; error: string | null };
const VERCEL_TTL = 15 * 60_000;
const G = globalThis as { __muWebsitesVercel?: { refreshing: Promise<void> | null } };

export function vercelCachePath(root: string) {
  return join(root, ".operator-data", "websites-vercel.json");
}

export function readVercelCache(root: string): VercelCache {
  try {
    const data = JSON.parse(readFileSync(vercelCachePath(root), "utf8"));
    return { at: data.at ?? null, projects: Array.isArray(data.projects) ? data.projects : [], error: data.error ?? null };
  } catch {
    return { at: null, projects: [], error: null };
  }
}

/** `vercel project ls --format json` output -> the three fields we show. */
export function parseVercelProjects(stdout: string): VercelProject[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Vercel didn't return a project list.");
  const data = JSON.parse(stdout.slice(start, end + 1));
  return (Array.isArray(data?.projects) ? data.projects : [])
    .filter((p: any) => typeof p?.name === "string")
    .map((p: any) => ({
      name: p.name,
      url: typeof p.latestProductionUrl === "string" ? p.latestProductionUrl : null,
      updatedAt: Number.isFinite(p.updatedAt) ? new Date(p.updatedAt).toISOString() : null,
    }));
}

function runVercelList(): Promise<string> {
  // Through PowerShell: the npm `vercel` shim is a .cmd that can't be spawned directly.
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "vercel project ls --scope nahda --format json"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Vercel took too long to answer.")); }, 60_000);
    child.stdout.on("data", (c) => (out += c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

/** Refreshes the cache in the background when it's older than 15 minutes. Never awaited by a page load. */
export function refreshVercelIfStale(root: string, run: () => Promise<string> = runVercelList): { refreshing: boolean } {
  const state = (G.__muWebsitesVercel ??= { refreshing: null });
  const cache = readVercelCache(root);
  const fresh = cache.at && Date.now() - Date.parse(cache.at) < VERCEL_TTL;
  if (fresh || state.refreshing) return { refreshing: !!state.refreshing };
  state.refreshing = run()
    .then((out) => writeVercelCache(root, { at: new Date().toISOString(), projects: parseVercelProjects(out), error: null }))
    .catch((error) => writeVercelCache(root, { ...cache, at: new Date().toISOString(), error: error instanceof Error ? error.message : "Vercel list failed" }))
    .finally(() => { state.refreshing = null; });
  return { refreshing: true };
}

function writeVercelCache(root: string, cache: VercelCache) {
  const file = vercelCachePath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(cache, null, 2), "utf8");
  renameSync(`${file}.tmp`, file);
}

// ── templates and drafts ─────────────────────────────────────────────────

export type TemplateInfo = { vertical: string; flagship: string | null; builtAt: string | null; kind: string | null };
export type DraftInfo = {
  folder: string;
  name: string;
  leadId: number | null;
  vertical: string | null;
  direction: string | null;
  builtAt: string | null;
  qaPass: boolean | null;
};

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

export function templateInfo(draftsRoot: string, vertical: string): TemplateInfo {
  const t = readJson(join(draftsRoot, "_templates", vertical, "template.json"));
  return {
    vertical,
    flagship: typeof t?.flagship === "string" ? t.flagship : null,
    builtAt: typeof t?.builtAt === "string" ? t.builtAt : mtime(join(draftsRoot, "_templates", vertical, "index.html")),
    kind: typeof t?.kind === "string" ? t.kind : null,
  };
}

export function draftInfo(draftsRoot: string, folder: string): DraftInfo {
  const dir = join(draftsRoot, folder);
  const evidence = readJson(join(dir, "evidence.json"));
  const direction = readJson(join(dir, "direction.json"));
  const qa = readJson(join(dir, "qa.json"));
  return {
    folder,
    name: typeof evidence?.name === "string" ? evidence.name : folder.replace(/-/g, " "),
    leadId: Number.isInteger(evidence?.leadId) ? evidence.leadId : null,
    vertical: typeof evidence?.vertical === "string" ? evidence.vertical : null,
    direction: typeof direction?.name === "string" ? direction.name : null,
    builtAt: mtime(join(dir, "index.html")),
    qaPass: typeof qa?.pass === "boolean" ? qa.pass : null,
  };
}

export function mtime(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}
