// Gathers the overnight Dream's input bundle from data that already exists on this PC.
// Deliberately NOT included: raw Claude Code / Codex / Hermes transcripts or user prompts, meeting
// transcripts, audio, .env values, tokens. Every section is a digest: counts, statuses, titles and
// already-written summaries. Each gatherer is best-effort: a missing source becomes a note, never a
// failed Dream.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { coachingSummary } from "../leads/crm";
import { clientBuildDir } from "./core";

type Section = Record<string, unknown> | unknown[] | string | null;
const DAY = 86_400_000;

/** Strips things that should never ride along: email addresses, phone numbers, bearer-ish tokens. */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+?61|0)[\s-]?[2-478](?:[\s-]?\d){8}\b/g, "[phone]")
    .replace(/\b(?:sk|pk|rk|xox[abp]|ghp|gho|eyJ)[A-Za-z0-9_\-.]{16,}\b/g, "[secret]");
}
export const clip = (s: unknown, n: number) => scrub(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);

// ---- live-data.json (aggregate) -------------------------------------------------------------------

export function liveDigest(ld: any): Section {
  if (!ld || typeof ld !== "object") return "live-data.json missing";
  const hermes = ld.hermes ?? {};
  const byModel: Record<string, number> = {};
  for (const s of Array.isArray(hermes.recentSessions) ? hermes.recentSessions : []) {
    const k = `${s?.model ?? "?"} via ${s?.platform ?? "?"}`;
    byModel[k] = (byModel[k] ?? 0) + 1;
  }
  const skills = Array.isArray(ld.skills?.active) ? ld.skills.active : [];
  return {
    generatedAt: ld.generatedAt,
    summary: ld.summary,
    claudeUsageWindows: ld.usage?.claudeWindow?.windows,
    subscriptions: ld.subscriptions && {
      claude: ld.subscriptions.claude?.plan,
      chatgpt: ld.subscriptions.chatgpt?.plan,
      codexDefaultModel: ld.subscriptions.chatgpt?.configModel,
    },
    modelUsage: (ld.modelUsage ?? []).slice(0, 8).map((m: any) => ({ model: m.model, messages: m.messages, costUsdApiEquivalent: m.cost_usd })),
    daily: (ld.daily ?? []).slice(-7),
    recentProjects: (ld.recentProjects ?? []).slice(0, 12).map((p: any) => ({ name: p.displayName, sessions: p.sessions, messages: p.messages, lastActive: p.lastActiveAgo })),
    skills: {
      topUsed7d: skills.filter((s: any) => s.uses7d > 0).sort((a: any, b: any) => b.uses7d - a.uses7d).slice(0, 15).map((s: any) => `${s.name} ×${s.uses7d}`),
      unused7d: skills.filter((s: any) => !s.uses7d).length,
      installed: skills.length,
    },
    memory: {
      stats: ld.memory?.stats,
      staleFiles: (ld.memory?.staleFiles ?? []).slice(0, 12).map((f: any) => `${f.path} (${f.updated})`),
      recentlyUpdated: (ld.memory?.recentlyUpdated ?? []).slice(0, 12).map((f: any) => `${f.path} (${f.updated})`),
    },
    automations: ld.automations,
    hermes: { sessions: hermes.sessionCount, skills: hermes.skillCount, personas: hermes.personaCount, lastActive: hermes.lastActiveAgo, recentSessionsByModel: byModel },
    trend: (ld.history ?? []).slice(-7),
  };
}

// ---- session summaries (already-written wrap-ups, never transcripts) ------------------------------

function firstLines(md: string): { title: string; tldr: string } {
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const title = (lines.find((l) => l.startsWith("# ")) ?? "").replace(/^#\s+/, "");
  const tldr = lines.find((l) => l && !l.startsWith("#") && !l.startsWith("---") && !/^\w+:\s/.test(l)) ?? "";
  return { title, tldr };
}

function walkMd(dir: string, depth: number, out: string[]) {
  if (depth < 0 || !existsSync(dir)) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, depth - 1, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
}

/** Session summaries written in the last `hours`: every repo's memory/session-summaries/, the
 *  desktop bucket folders, and the wiki's reports (obsidian-wrap-up pages). */
export function sessionSummaries(opts: { reposRoot: string; desktop: string; wikiRoot: string; now?: number; hours?: number }): Section {
  const now = opts.now ?? Date.now();
  const since = now - (opts.hours ?? 36) * 3_600_000;
  const files: string[] = [];
  try {
    for (const repo of readdirSync(opts.reposRoot)) walkMd(join(opts.reposRoot, repo, "memory", "session-summaries"), 1, files);
  } catch {
    /* no repos dir */
  }
  try {
    for (const bucket of readdirSync(opts.desktop)) walkMd(join(opts.desktop, bucket, "memory", "session-summaries"), 1, files);
  } catch {
    /* no desktop */
  }
  walkMd(join(opts.wikiRoot, "wiki", "reports"), 3, files);
  const recent = files
    .map((f) => ({ f, m: (() => { try { return statSync(f).mtimeMs; } catch { return 0; } })() }))
    .filter((x) => x.m >= since)
    .sort((a, b) => b.m - a.m)
    .slice(0, 25);
  return recent.map(({ f, m }) => {
    const { title, tldr } = firstLines(readFileSync(f, "utf-8").slice(0, 4000));
    return { file: f.replace(/\\/g, "/").replace(/^.*?source\/repos\//, "repos/"), at: new Date(m).toISOString(), title: clip(title, 140), tldr: clip(tldr, 320) };
  });
}

/** Session titles from the last `hours`: Claude Code's own session titles (`custom-title` /
 *  `ai-title` records, the only lines read from a log) plus per-project session counts, and
 *  Codex's thread names from ~/.codex/session_index.jsonl. No message content is read. */
export function sessionTitles(opts: { claudeProjects: string; codexIndex: string; now?: number; hours?: number; maxFiles?: number }): Section {
  const now = opts.now ?? Date.now();
  const since = now - (opts.hours ?? 24) * 3_600_000;
  const claude: Record<string, { sessions: number; titles: string[] }> = {};
  const recent: { f: string; project: string; m: number; size: number }[] = [];
  try {
    for (const project of readdirSync(opts.claudeProjects)) {
      const dir = join(opts.claudeProjects, project);
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          const st = statSync(join(dir, n));
          if (st.mtimeMs >= since) recent.push({ f: join(dir, n), project, m: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      }
    }
  } catch {
    /* no Claude projects dir */
  }
  const readable = (p: string) => p.replace(/^C--Users-[^-]+-[^-]+-/, "").replace(/^source-repos-/, "").slice(0, 60) || p;
  for (const r of recent) {
    const key = readable(r.project);
    (claude[key] ??= { sessions: 0, titles: [] }).sessions++;
  }
  for (const r of recent.sort((a, b) => b.m - a.m).slice(0, opts.maxFiles ?? 400)) {
    if (r.size > 60 * 1024 * 1024) continue;
    let text = "";
    try {
      text = readFileSync(r.f, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes('"custom-title"') && !text.includes('"ai-title"')) continue;
    let title = "";
    for (const line of text.split("\n")) {
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
      try {
        const j = JSON.parse(line);
        title = j.customTitle ?? j.aiTitle ?? j.title ?? title;
      } catch {
        /* partial line */
      }
    }
    const list = claude[readable(r.project)].titles;
    if (title && !list.includes(clip(title, 120))) list.push(clip(title, 120));
  }
  const codex: { thread: string; at: string }[] = [];
  if (existsSync(opts.codexIndex)) {
    for (const line of readFileSync(opts.codexIndex, "utf-8").split("\n")) {
      try {
        const j = JSON.parse(line);
        if (Date.parse(j.updated_at) >= since && j.thread_name) codex.push({ thread: clip(j.thread_name, 120), at: j.updated_at });
      } catch {
        /* blank/partial */
      }
    }
  }
  return { claudeCodeByProject: claude, codexThreads: codex.slice(-30) };
}

// ---- CRM (leads hunted, called, outcomes, coaching) ------------------------------------------------

export function crmDigest(file: string, now = Date.now()): Section {
  if (!existsSync(file)) return "CRM not found";
  const db = new Database(file, { readonly: true });
  try {
    const since1 = new Date(now - DAY).toISOString();
    const since7 = new Date(now - 7 * DAY).toISOString();
    const q = (sql: string, ...args: any[]) => db.query(sql).all(...args) as any[];
    const hunted24 = q("SELECT vertical, source, COUNT(*) n FROM leads WHERE created_at >= ? GROUP BY vertical, source", since1);
    const hunted7 = q("SELECT COUNT(*) n FROM leads WHERE created_at >= ?", since7)[0]?.n ?? 0;
    const acts = (since: string) => q("SELECT kind, outcome, by, COUNT(*) n FROM activities WHERE at >= ? GROUP BY kind, outcome, by ORDER BY n DESC", since);
    const recentNotes = q(
      "SELECT a.at, a.kind, a.outcome, a.by, a.note, l.name, l.vertical FROM activities a JOIN leads l ON l.id = a.lead_id WHERE a.at >= ? ORDER BY a.at DESC LIMIT 20",
      since1,
    ).map((r) => ({ at: r.at, kind: r.kind, outcome: r.outcome, by: r.by, lead: clip(r.name, 60), vertical: r.vertical, note: clip(r.note, 200) }));
    const pipeline = Object.fromEntries(q("SELECT status, COUNT(*) n FROM leads WHERE excluded = 0 GROUP BY status").map((r) => [r.status, r.n]));
    const byPitch = Object.fromEntries(q("SELECT pitch, COUNT(*) n FROM leads WHERE excluded = 0 AND status NOT IN ('won','lost','not_interested','do_not_contact') GROUP BY pitch").map((r) => [r.pitch || "none", r.n]));
    const followUps = q(
      "SELECT name, next_at, status FROM leads WHERE next_at IS NOT NULL AND next_at <= ? AND status NOT IN ('won','lost','not_interested','do_not_contact') ORDER BY next_at LIMIT 12",
      new Date(now + DAY).toISOString(),
    ).map((r) => ({ lead: clip(r.name, 60), due: r.next_at, status: r.status }));
    let coaching: unknown = "no coaching table yet";
    try {
      coaching = {
        last7d: coachingSummary(db, null, 7, new Date(now)),
        last30d: coachingSummary(db, null, 30, new Date(now)),
        recent: q("SELECT at, by, score, objection_tag, worked, improve, next_step FROM coaching ORDER BY at DESC LIMIT 8").map((r) => ({
          at: r.at, by: r.by, score: r.score, objection: r.objection_tag, worked: clip(r.worked, 160), improve: clip(r.improve, 160), next: clip(r.next_step, 160),
        })),
      };
    } catch {
      /* coaching table missing on an old CRM */
    }
    return { pipeline, openLeadsByPitch: byPitch, hunted24h: hunted24, hunted7d: hunted7, activities24h: acts(since1), activities7d: acts(since7), recentActivity: recentNotes, followUpsDue: followUps, coaching };
  } finally {
    db.close();
  }
}

// ---- meeting-mode coaching notes (never transcripts) ----------------------------------------------

export function meetingDigest(dir: string, now = Date.now()): Section {
  const notesDir = join(dir, "notes");
  if (!existsSync(notesDir)) return "no meeting-mode notes yet";
  const out: unknown[] = [];
  for (const f of readdirSync(notesDir)) {
    if (!f.endsWith(".json") || f.includes("transcript")) continue;
    const p = join(notesDir, f);
    if (now - statSync(p).mtimeMs > 14 * DAY) continue;
    try {
      const n = JSON.parse(readFileSync(p, "utf-8"));
      out.push({
        at: n.at, by: n.by, lead: n.lead?.name ? clip(n.lead.name, 60) : null, title: clip(n.title, 100),
        outcome: n.crm?.outcome, score: n.coaching?.score, categories: n.coaching?.categories, objection: n.coaching?.objectionTag,
        wentWell: (n.coaching?.wentWell ?? []).slice(0, 3).map((s: string) => clip(s, 160)),
        fixes: (n.coaching?.fixes ?? []).slice(0, 3).map((x: any) => clip(typeof x === "string" ? x : x?.what ?? x?.fix ?? JSON.stringify(x), 200)),
        frameworks: n.coaching?.frameworks, nextSteps: (n.summary?.nextSteps ?? []).slice(0, 3).map((x: any) => clip(typeof x === "string" ? x : x?.what ?? JSON.stringify(x), 160)),
      });
    } catch {
      /* unreadable note */
    }
  }
  return out.length ? out.slice(-12) : "no meeting-mode notes in the last 14 days";
}

// ---- AI usage & spend -----------------------------------------------------------------------------

export async function fetchAiUsage(url = "http://127.0.0.1:8081/__ai_usage", timeoutMs = 45_000): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function aiUsageDigest(s: any): Section {
  if (!s) return "AI usage snapshot unavailable (dashboard server not answering on :8081)";
  return {
    month: s.month?.label,
    totalsAud: s.totals,
    subscriptions: (s.subscriptions ?? []).map((x: any) => ({
      id: x.id, plan: x.plan, owner: x.owner, monthlyAud: x.monthly?.aud, peakPercent: x.peakPercent,
      windows: (x.status?.windows ?? []).map((w: any) => `${w.label}: ${w.usedPercent}% (resets ${w.resetsAt})`),
      notes: x.status?.notes,
    })),
    // Provider, usage summary, spend and limit only: never keyName/keyTail.
    apiKeys: (s.apiKeys ?? []).map((k: any) => ({ provider: k.provider, usage: clip(k.usage, 120), spendAud: k.spend?.aud ?? null, limit: k.limit, status: k.status, note: clip(k.note, 160) })).slice(0, 20),
    unknown: s.totals?.unknown,
  };
}

// ---- tests + typecheck ----------------------------------------------------------------------------

export type CheckResult = { ok: boolean; ms: number; summary: string; failures: string[] };

function run(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  return { out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, status: r.status, ms: Date.now() - started, timedOut: !!r.error && /ETIMEDOUT/.test(String(r.error)) };
}

export function summariseBunTest(out: string, status: number | null): CheckResult & { pass: number; fail: number } {
  const pass = Number(/^\s*(\d+) pass/m.exec(out)?.[1] ?? 0);
  const fail = Number(/^\s*(\d+) fail/m.exec(out)?.[1] ?? 0);
  const failures = [...out.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => clip(m[1], 200)).slice(0, 20);
  return { ok: status === 0 && fail === 0, ms: 0, pass, fail, failures, summary: `${pass} pass, ${fail} fail` };
}

export function summariseTsc(out: string, status: number | null): CheckResult & { errors: number; byFile: Record<string, number> } {
  const lines = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const byFile: Record<string, number> = {};
  for (const l of lines) {
    const f = l.split("(")[0].trim();
    byFile[f] = (byFile[f] ?? 0) + 1;
  }
  return { ok: status === 0 && lines.length === 0, ms: 0, errors: lines.length, byFile, failures: lines.slice(0, 15).map((l) => clip(l, 220)), summary: `${lines.length} error(s)` };
}

export function runChecks(repo: string, bun: string): Record<string, unknown> {
  const t = run(bun, ["test", "scripts"], repo, 20 * 60_000);
  const tests = { ...summariseBunTest(t.out, t.status), ms: t.ms, timedOut: t.timedOut };
  const c = run(bun, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "."], repo, 15 * 60_000);
  const tsc = { ...summariseTsc(c.out, c.status), ms: c.ms, timedOut: c.timedOut };
  return { tests, tsc };
}

// ---- client hubs ----------------------------------------------------------------------------------

/** Open items from every <repo>/CLIENT.md: unchecked delivery boxes, the Next actions section and
 *  dated timeline rows. Emails/phones are scrubbed. */
export function clientHubs(reposRoot: string): Section {
  const out: unknown[] = [];
  let repos: string[] = [];
  try {
    repos = readdirSync(reposRoot);
  } catch {
    return "no repos directory";
  }
  for (const repo of repos) {
    const file = join(reposRoot, repo, "CLIENT.md");
    if (!existsSync(file)) continue;
    const md = readFileSync(file, "utf-8");
    const lines = md.split(/\r?\n/);
    const title = (lines.find((l) => l.startsWith("# ")) ?? repo).replace(/^#\s+/, "");
    const open = lines.filter((l) => /^\s*- \[ \]/.test(l)).map((l) => clip(l.replace(/^\s*- \[ \]\s*/, ""), 220));
    const nextIdx = lines.findIndex((l) => /^##.*next actions/i.test(l));
    const next: string[] = [];
    if (nextIdx >= 0) for (const l of lines.slice(nextIdx + 1)) {
      if (/^##\s/.test(l)) break;
      if (l.trim()) next.push(clip(l, 220));
    }
    const timeline = lines.filter((l) => /^\|.*\b20\d\d\b.*\|/.test(l) || /^\|.*\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(l)).map((l) => clip(l, 200)).slice(0, 12);
    out.push({ client: clip(title, 80), repo, build: (() => {
      const b = clientBuildDir(join(reposRoot, repo), md);
      return b ? { dir: b.dir.replace(/\\/g, "/").replace(/^.*?source\/repos\//, "repos/"), source: b.source } : null;
    })(), openChecklist: open.slice(0, 20), nextActions: next.slice(0, 15), timeline });
  }
  return out;
}

// ---- Jarvis routing -------------------------------------------------------------------------------

/** Route quality from the shadow log (intent + confidence only, no utterance text) and the
 *  capability acceptance file (anything not PASS). */
export function jarvisDigest(operatorData: string, now = Date.now()): Section {
  const out: Record<string, unknown> = {};
  const shadow = join(operatorData, "laya-shadow.jsonl");
  if (existsSync(shadow)) {
    const since = now - DAY;
    const rows = readFileSync(shadow, "utf-8").split("\n").filter(Boolean).slice(-5000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && Date.parse(r.at) >= since);
    const low = rows.filter((r) => typeof r.jevConfidence === "number" && r.jevConfidence < 0.5);
    const byIntent: Record<string, number> = {};
    for (const r of low) byIntent[r.jevIntent] = (byIntent[r.jevIntent] ?? 0) + 1;
    const ms = rows.map((r) => r.jevMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
    out.routing24h = {
      decisions: rows.length,
      lowConfidence: low.length,
      lowConfidenceByIntent: byIntent,
      shadowDisagreements: rows.filter((r) => r.agree === false).length,
      jevP50Ms: ms[Math.floor(ms.length / 2)] ?? null,
      jevP95Ms: ms[Math.floor(ms.length * 0.95)] ?? null,
    };
  } else out.routing24h = "no route log";
  const acc = join(operatorData, "capability-acceptance.json");
  if (existsSync(acc)) {
    try {
      const j = JSON.parse(readFileSync(acc, "utf-8"));
      out.capabilitiesNotPassing = Object.entries(j).filter(([, v]: any) => v?.result !== "PASS").map(([k, v]: any) => ({ id: k, result: v?.result, evidence: clip(v?.evidence, 200), at: v?.at }));
    } catch {
      /* unreadable */
    }
  }
  const caps = join(operatorData, "capabilities.json");
  if (existsSync(caps)) {
    try {
      const j = JSON.parse(readFileSync(caps, "utf-8"));
      out.capabilitiesBroken = (j.capabilities ?? []).filter((c: any) => c.status === "broken").map((c: any) => ({ id: c.id, evidence: clip(c.evidence, 200) }));
    } catch {
      /* unreadable */
    }
  }
  return out;
}

// ---- bundle ---------------------------------------------------------------------------------------

/** Serialises sections in priority order, dropping the lowest-priority ones when the bundle would
 *  exceed `maxChars` (so the nightly token cap is respected before we spend anything). */
export function buildBundle(sections: [name: string, value: unknown][], maxChars: number): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const parts = sections.map(([name, value]) => `## ${name}\n${typeof value === "string" ? value : JSON.stringify(value)}`);
  let total = parts.reduce((s, p) => s + p.length + 2, 0);
  while (total > maxChars && parts.length > 1) {
    const p = parts.pop()!;
    dropped.push(sections[parts.length][0]);
    total -= p.length + 2;
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, dropped };
}

export const label = (p: string) => basename(p);
