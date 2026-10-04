// The 30-day skill-candidate mining pass (Chase AI "Claude OS" video, Method 1: analyse 30 days of
// interaction logs for a repeated manual task worth turning into a skill). Bolted onto the existing
// overnight Dream — same nightly `claude -p` call, same budget, no new timer, no new network call.
// See run-dream.ts (adds this as one more digest section) and skills/dream/SKILL.md (the model's
// instructions for turning this digest into up to 5 `skillCandidates`).
//
// Privacy, same posture as inputs.ts: every source here is either already a summary (Hermes
// session metadata, CRM activity kinds) or a short, scrubbed excerpt (Jarvis conversation
// messages, away-mode task text, Claude Code's first prompt per session) — never a full raw
// transcript, never audio, never anything from a .env or credential file. `scrub`/`clip` strip
// emails, phone numbers and secret-shaped tokens before anything is counted or sampled.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clip } from "./inputs";

type Section = Record<string, unknown> | unknown[] | string | null;
const DAY = 86_400_000;

// ---- repeat detection (the "same intent 3+ times" rule) --------------------------------------------

/** Loose normalisation for grouping near-identical short phrases: lowercase, digits collapsed,
 *  punctuation stripped. Not semantic clustering — that's the model's job with this as a head
 *  start — just enough to surface exact/near-exact repeats with real counts and dates as evidence. */
function normaliseIntent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export type Repeat = { text: string; count: number; firstAt: string; lastAt: string };

/** A bounded, most-recent-first sample of distinct clipped texts — evidence for a multi-step
 *  routine that spans sources and so never repeats identically within any one of them. Repeats
 *  (3+ exact/near-exact) are the stronger signal (groupRepeats); this is the fallback breadth. */
export function sampleOf(items: { text: string; at: string }[], max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of [...items].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (!it.text || seen.has(it.text)) continue;
    seen.add(it.text);
    out.push(it.text);
    if (out.length >= max) break;
  }
  return out;
}

/** Groups `{text, at}` items by normalised intent, keeping only groups seen `minCount`+ times,
 *  ranked by count. This is the concrete "same task 3+ times" evidence the skill-mining pass needs. */
export function groupRepeats(items: { text: string; at: string }[], minCount = 3, max = 20): Repeat[] {
  const groups = new Map<string, { texts: string[]; ats: string[] }>();
  for (const it of items) {
    const key = normaliseIntent(it.text).slice(0, 70);
    if (key.length < 6) continue; // too short to be a meaningful intent
    const g = groups.get(key) ?? { texts: [], ats: [] };
    g.texts.push(it.text);
    g.ats.push(it.at);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.texts.length >= minCount)
    .map((g) => {
      const sorted = [...g.ats].sort();
      return { text: g.texts[0], count: g.texts.length, firstAt: sorted[0], lastAt: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

// ---- Jarvis conversations (.operator-data/conversations.json) -------------------------------------

/** User turns from Jarvis chat conversations updated in the last `days`. Each SavedConversation has
 *  no per-message timestamp, so every message in a recent conversation is stamped with that
 *  conversation's updatedAt — good enough for a 30-day window, not for exact ordering. */
export function jarvisConversationsDigest(file: string, since: number, maxMessages = 400): Section {
  if (!existsSync(file)) return "no conversations.json yet";
  let items: { text: string; at: string }[] = [];
  try {
    const all = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(all)) return "conversations.json unreadable";
    for (const c of all) {
      if (!c || Date.parse(c.updatedAt) < since) continue;
      for (const m of Array.isArray(c.messages) ? c.messages : []) {
        if (m?.role !== "user" || typeof m.text !== "string" || !m.text.trim()) continue;
        items.push({ text: clip(m.text, 160), at: c.updatedAt });
        if (items.length >= maxMessages) break;
      }
      if (items.length >= maxMessages) break;
    }
  } catch {
    return "conversations.json unreadable";
  }
  return { messagesSeen: items.length, repeatedIntents: groupRepeats(items), sample: sampleOf(items) };
}

// ---- jarvis-events (.operator-data/jarvis-events.json) ---------------------------------------------

export function jarvisEventsDigest(file: string, since: number): Section {
  if (!existsSync(file)) return "no jarvis-events.json yet";
  try {
    const state = JSON.parse(readFileSync(file, "utf-8"));
    const events: any[] = Array.isArray(state?.events) ? state.events : [];
    const recent = events.filter((e) => Date.parse(e?.createdAt) >= since);
    const bySource: Record<string, number> = {};
    const items: { text: string; at: string }[] = [];
    for (const e of recent) {
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      if (typeof e.text === "string" && e.text.trim()) items.push({ text: clip(`${e.source}: ${e.text}`, 160), at: e.createdAt });
    }
    return { total: recent.length, bySource, repeatedIntents: groupRepeats(items), sample: sampleOf(items) };
  } catch {
    return "jarvis-events.json unreadable";
  }
}

// ---- Hermes session metadata (tool names, turn counts — never raw prompts) ------------------------

/** Sessions started in the last `days`, from Hermes' own state.db (sqlite). Titles are Hermes'
 *  own short auto-generated labels (already used elsewhere, e.g. dream/inputs.ts sessionTitles) —
 *  never the raw prompt — and are still clipped/scrubbed before use. */
export function hermesSessionsDigest(hermesHome: string, sinceSec: number): Section {
  const dbPath = join(hermesHome, "state.db");
  if (!existsSync(dbPath)) return "no Hermes state.db (not installed, or pre-0.17)";
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT source, model, title, message_count, tool_call_count, tool_names, started_at
           FROM sessions WHERE started_at >= ? ORDER BY started_at DESC LIMIT 2000`,
        )
        .all(sinceSec) as any[];
      const bySource: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const titleItems: { text: string; at: string }[] = [];
      const toolNameCounts: Record<string, number> = {};
      let msgTotal = 0;
      let toolCallTotal = 0;
      for (const r of rows) {
        bySource[r.source ?? "?"] = (bySource[r.source ?? "?"] ?? 0) + 1;
        byModel[r.model ?? "?"] = (byModel[r.model ?? "?"] ?? 0) + 1;
        msgTotal += r.message_count ?? 0;
        toolCallTotal += r.tool_call_count ?? 0;
        if (typeof r.title === "string" && r.title.trim()) titleItems.push({ text: clip(r.title, 120), at: new Date(r.started_at * 1000).toISOString() });
        if (typeof r.tool_names === "string" && r.tool_names.trim())
          try {
            for (const n of JSON.parse(r.tool_names)) if (typeof n === "string") toolNameCounts[n] = (toolNameCounts[n] ?? 0) + 1;
          } catch {
            /* not JSON */
          }
      }
      // Best-effort fallback: sessions.tool_names is often unpopulated, so pull tool names
      // straight from messages for the same window (counts only, no message content).
      if (Object.keys(toolNameCounts).length === 0) {
        try {
          const toolRows = db
            .query(
              `SELECT m.tool_name AS name, COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id
               WHERE m.tool_name IS NOT NULL AND s.started_at >= ? GROUP BY m.tool_name ORDER BY n DESC LIMIT 25`,
            )
            .all(sinceSec) as any[];
          for (const t of toolRows) if (t.name) toolNameCounts[t.name] = t.n;
        } catch {
          /* messages table shape differs on this Hermes version */
        }
      }
      return {
        sessions: rows.length,
        bySource,
        byModel,
        avgMessageCount: rows.length ? Math.round(msgTotal / rows.length) : 0,
        avgToolCallCount: rows.length ? Math.round(toolCallTotal / rows.length) : 0,
        toolNameCounts,
        repeatedSessionTitles: groupRepeats(titleItems),
        sampleTitles: sampleOf(titleItems),
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return `Hermes state.db unreadable: ${(e as Error).message}`;
  }
}

// ---- Claude Code session first prompts (first user message only) ----------------------------------

/** Extracts the first line-level user message (role user, not a sub-agent sidechain) from a
 *  Claude Code session JSONL. Returns null if none is found in the first `maxLines` lines. */
function firstUserPrompt(text: string, maxLines = 200): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const line = lines[i];
    if (!line || !line.includes('"type":"user"')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.type !== "user" || j?.isSidechain === true || j?.message?.role !== "user") continue;
    const c = j.message.content;
    const text2 = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ") : "";
    if (text2 && text2.trim()) return text2.trim();
  }
  return null;
}

/** First prompts across Claude Code sessions started in the last `days`, one per session file,
 *  clipped and scrubbed. Bounded like sessionTitles in inputs.ts: newest `maxFiles` files, files
 *  over 60 MB skipped (nothing about skill mining needs a session that large). */
export function claudeCodeFirstPromptsDigest(claudeProjects: string, since: number, maxFiles = 400): Section {
  if (!existsSync(claudeProjects)) return "no ~/.claude/projects";
  const recent: { f: string; project: string; m: number; size: number }[] = [];
  try {
    for (const project of readdirSync(claudeProjects)) {
      const dir = join(claudeProjects, project);
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
    return "no ~/.claude/projects";
  }
  const readable = (p: string) => p.replace(/^C--Users-[^-]+-[^-]+-/, "").replace(/^source-repos-/, "").slice(0, 60) || p;
  const items: { text: string; at: string }[] = [];
  const byProject: Record<string, number> = {};
  for (const r of recent.sort((a, b) => b.m - a.m).slice(0, maxFiles)) {
    if (r.size > 60 * 1024 * 1024) continue;
    byProject[readable(r.project)] = (byProject[readable(r.project)] ?? 0) + 1;
    let text = "";
    try {
      text = readFileSync(r.f, "utf-8");
    } catch {
      continue;
    }
    const prompt = firstUserPrompt(text);
    if (prompt) items.push({ text: clip(prompt, 160), at: new Date(r.m).toISOString() });
  }
  return { sessions: recent.length, byProject, repeatedFirstPrompts: groupRepeats(items), sample: sampleOf(items) };
}

// ---- leads CRM activity log (hand-done actions logged 3+ times a similar way) ----------------------

export function crmActivityDigest(file: string, since: number): Section {
  if (!existsSync(file)) return "no crm.sqlite yet";
  try {
    const db = new Database(file, { readonly: true });
    try {
      const sinceIso = new Date(since).toISOString();
      const byKind = db.query("SELECT kind, by, COUNT(*) n FROM activities WHERE at >= ? GROUP BY kind, by ORDER BY n DESC LIMIT 20").all(sinceIso) as any[];
      const notes = db
        .query("SELECT at, kind, note FROM activities WHERE at >= ? AND note IS NOT NULL AND note != '' ORDER BY at DESC LIMIT 200")
        .all(sinceIso) as any[];
      const items = notes.filter((r) => r.note).map((r) => ({ text: clip(`${r.kind}: ${r.note}`, 160), at: r.at }));
      return { byKindAndBy: byKind, repeatedNotes: groupRepeats(items), sampleNotes: sampleOf(items) };
    } finally {
      db.close();
    }
  } catch (e) {
    return `crm.sqlite unreadable: ${(e as Error).message}`;
  }
}

// ---- away-mode queue (explicit task text — the clearest "do this for me" signal) -------------------

export function awayModeDigest(operatorData: string, since: number): Section {
  const file = join(operatorData, "away-mode", "state.json");
  if (!existsSync(file)) return "no away-mode queue yet";
  try {
    const state = JSON.parse(readFileSync(file, "utf-8"));
    const tasks: any[] = Array.isArray(state?.tasks) ? state.tasks : [];
    const recent = tasks.filter((t) => Date.parse(t?.createdAt) >= since);
    const byRoute: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const items: { text: string; at: string }[] = [];
    for (const t of recent) {
      byRoute[t.route ?? "?"] = (byRoute[t.route ?? "?"] ?? 0) + 1;
      byStatus[t.status ?? "?"] = (byStatus[t.status ?? "?"] ?? 0) + 1;
      if (typeof t.text === "string" && t.text.trim()) items.push({ text: clip(t.text, 160), at: t.createdAt });
    }
    return { total: recent.length, byRoute, byStatus, repeatedTasks: groupRepeats(items), sample: sampleOf(items) };
  } catch (e) {
    return `away-mode state.json unreadable: ${(e as Error).message}`;
  }
}

// ---- the whole 30-day bundle -----------------------------------------------------------------------

export type SkillMiningSources = {
  operatorData: string; // <repo>/.operator-data
  claudeProjects: string; // ~/.claude/projects
  hermesHome: string; // ~/.hermes (or $HERMES_HOME)
  now?: number;
  days?: number;
};

/** One digest across all six sources, last `days` (default 30). Every field is either an
 *  aggregate count or a short scrubbed excerpt — see the file header. Feeds run-dream.ts as one
 *  more section in the same nightly Claude call; nothing here makes a network or model call. */
export function skillMiningDigest(opts: SkillMiningSources): Section {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const since = now - days * DAY;
  return {
    windowDays: days,
    jarvisConversations: jarvisConversationsDigest(join(opts.operatorData, "conversations.json"), since),
    jarvisEvents: jarvisEventsDigest(join(opts.operatorData, "jarvis-events.json"), since),
    hermesSessions: hermesSessionsDigest(opts.hermesHome, Math.floor(since / 1000)),
    claudeCodeFirstPrompts: claudeCodeFirstPromptsDigest(opts.claudeProjects, since),
    crmActivity: crmActivityDigest(join(opts.operatorData, "crm.sqlite"), since),
    awayModeQueue: awayModeDigest(opts.operatorData, since),
  };
}
