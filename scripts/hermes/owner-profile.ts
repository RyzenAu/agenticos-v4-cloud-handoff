// Tell Hermes who the owner is and what he's working towards (W-C, 29 Sep 2026; asked for directly).
//
// Hermes' persistent user profile is ~/.hermes/memories/USER.md: "§"-separated entries, loaded into
// the system prompt as a frozen snapshot at the start of every session, capped by
// memory.user_char_limit (1,375 by default). Its memory tool refuses to write a file that doesn't
// round-trip (entries joined by "\n§\n") or holds an entry longer than the cap, so this writes
// exactly that shape, LF only. Our entries all start with OWNER_MARK; every other entry (the ones
// Hermes learns itself) is kept as it is.
//
// Built from the M&U Obsidian wiki (identity, education, faith, work, the business, shared goals)
// and the owner's global Claude profile (suburb, how he wants to be worked with). Contact details,
// street address, date of birth and anything from raw transcripts are never read into the profile:
// only allow-listed fields are extracted, and a final screen drops any sentence that still looks
// like a phone number, email, street address or birth date.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const OWNER_MARK = "Owner profile (Agentic OS, from the M&U wiki)";
export const ENTRY_DELIMITER = "\n§\n";
const BACKUPS_KEPT = 3;

export type OwnerProfileSources = {
  /** Root of the Obsidian vault (the folder that holds wiki/). */
  wikiRoot: string;
  /** The owner's global Claude profile (~/.claude/CLAUDE.md). */
  claudeMdPath: string;
  now?: () => Date;
};

export type BuiltProfile = { entries: string[]; sources: string[]; warnings: string[] };

function read(path: string): string {
  try {
    return readFileSync(path, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

/** Body of a "## Heading" section (up to the next ## heading), or "". */
export function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const m = re.exec(md);
  if (!m) return "";
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##?\s/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Markdown → plain words: no bold, links or wiki-links. */
export function plain(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "- **Label:** value" inside a section → value (plain), or "". */
function field(block: string, label: string): string {
  const re = new RegExp(`^[-*]\\s+\\*\\*${label}:?\\*\\*:?\\s*(.+)$`, "im");
  return plain(re.exec(block)?.[1] ?? "");
}

/** Age in whole years from a "Born:" value ("24 December 2004 · age 21"); the date itself is never kept. */
export function ageFrom(born: string, now: Date): number | null {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(born);
  if (m) {
    const d = new Date(`${m[1]} ${m[2]} ${m[3]} 12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      let age = now.getFullYear() - d.getFullYear();
      if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
      if (age > 0 && age < 120) return age;
    }
  }
  const stated = /age\s+(\d{1,3})/i.exec(born)?.[1];
  return stated ? Number(stated) : null;
}

/** First sentence of a paragraph of prose. */
function firstSentence(s: string): string {
  const p = plain(s);
  const m = /^(.+?[.!?])(\s|$)/.exec(p);
  return (m ? m[1] : p).trim();
}

const STATES = "NSW|VIC|QLD|WA|SA|TAS|ACT|NT";

/** "Mount Druitt NSW" from the global profile's "… Mount Druitt, NSW." (suburb and state only). */
export function suburbFrom(claudeMd: string, wikiAddress: string): string | null {
  const who = section(claudeMd, "Who I am");
  const m = new RegExp(`(?:^|[.\\n]\\s*)([A-Z][A-Za-z' -]{2,40}),\\s*(${STATES})\\b`).exec(who);
  if (m) return `${m[1].trim()} ${m[2]}`;
  // Fallback: the wiki address, keeping only the part after the street ("…, Suburb NSW 2770").
  const a = new RegExp(`,\\s*([A-Z][A-Za-z' -]{2,40}?)\\s+(${STATES})\\b`).exec(wikiAddress);
  return a ? `${a[1].trim()} ${a[2]}` : null;
}

/** Sentences that still look like contact details or a birth date are dropped. */
const SENSITIVE: Array<[RegExp, string]> = [
  [/(?:\+?61|\b0)[2-9](?:[\s-]?\d){8}\b/, "a phone number"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "an email address"],
  [/\b\d+[A-Za-z]?\s*\/\s*\d+\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Place|Pl|Crescent|Cres|Drive|Dr|Lane|Ln|Way|Court|Ct)\b/i, "a street address"],
  [/\b\d+\s+[A-Z][a-z]+\s+(?:Street|Road|Avenue|Crescent|Drive|Lane|Court)\b/, "a street address"],
  [/\bborn\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i, "a birth date"],
  [/\b(?:password|api[_ ]?key|token|secret)\b/i, "a credential word"],
];

export function screenSensitive(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept = text
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => {
      const hit = SENSITIVE.find(([re]) => re.test(sentence));
      if (hit) dropped.push(hit[1]);
      return !hit;
    });
  return { text: kept.join(" ").trim(), dropped };
}

function join2(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
}

function stripEndDot(s: string) {
  return s.replace(/[.;,\s]+$/, "");
}

/** Page titles by file name ("mu-ventures" → "M&U Ventures") so [[links]] read as names. */
function wikiTitles(wiki: string): Map<string, string> {
  const titles = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      if (n.endsWith(".md")) {
        const title = /^title:\s*["']?([^"'\n]+)/m.exec(read(p).slice(0, 600))?.[1]?.trim();
        if (title) titles.set(n.slice(0, -3).toLowerCase(), title);
      } else if (!n.includes(".")) walk(p, depth + 1);
    }
  };
  walk(wiki, 0);
  return titles;
}

export function buildOwnerProfile(src: OwnerProfileSources): BuiltProfile {
  const now = (src.now ?? (() => new Date()))();
  const wiki = join(src.wikiRoot, "wiki");
  const paths = {
    owner: join(wiki, "topics", "personal", "usman", "usman.md"),
    partner: join(wiki, "topics", "personal", "mehroz", "mehroz.md"),
    goals: join(wiki, "topics", "personal", "shared-goals.md"),
    business: join(wiki, "entities", "mu-ventures.md"),
  };
  const titles = wikiTitles(wiki);
  const named = (s: string) =>
    plain(s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, slug: string, alias?: string) => alias ?? titles.get(slug.toLowerCase()) ?? slug));
  const owner = read(paths.owner);
  const partner = read(paths.partner);
  const goals = read(paths.goals);
  const business = read(paths.business);
  const claudeMd = read(src.claudeMdPath);
  const warnings: string[] = [];
  const sources = [...Object.values(paths).filter((p) => existsSync(p)), ...(claudeMd ? [src.claudeMdPath] : [])];
  if (!owner) warnings.push("The wiki has no owner page (wiki/topics/personal/usman/usman.md).");

  // ── Who he is ──
  const identity = section(owner, "Identity");
  const legal = field(identity, "Full legal name");
  const shortName = /^([A-Z][a-z]+)/.exec(field(identity, "Goes by"))?.[1] ?? null;
  const legalUse = /\*\*([A-Z][a-z]+)\*\*\s+for\s+(?:important\s+)?([^.]+)/.exec(identity);
  const age = ageFrom(field(identity, "Born"), now);
  const suburb = suburbFrom(claudeMd, field(section(owner, "Contact"), "Address"));
  const timezone = /Australia\/[A-Za-z_]+/.exec(field(section(owner, "Contact"), "Timezone"))?.[0] ?? null;
  const education = stripEndDot(named(firstSentence(section(owner, "Education"))).replace(/\s+[—-]\s+completed\s+/i, ", completed "));
  const faithRaw = named(section(owner, "Faith"));
  const faith = /hafiz/i.test(faithRaw)
    ? stripEndDot(
        `${/muslim/i.test(faithRaw) ? "Muslim and hafiz" : "Hafiz"}${/memoris/i.test(faithRaw) ? ": the Quran is already memorised; his work is strengthening and revising it, never learning it" : ""}`,
      )
    : stripEndDot(firstSentence(faithRaw));
  const who = join2([
    `${OWNER_MARK}, who he is:`,
    legal ? `${legal}${shortName ? `, called ${shortName}` : ""}${legalUse ? ` (${legalUse[1]} for ${stripEndDot(legalUse[2])})` : ""}.` : null,
    age !== null || suburb ? `${age !== null ? `${age}` : ""}${age !== null && suburb ? ", " : ""}${suburb ? `lives in ${suburb}` : ""}${timezone ? ` (${timezone})` : ""}.` : null,
    education ? `${education}.` : null,
    faith ? `${faith}.` : null,
  ]);

  // ── The business and his partner ──
  const bizTitle = /^title:\s*["']?([^"'\n]+)/m.exec(business)?.[1]?.trim() ?? null;
  const ownership = /50\s*\/\s*50/.test(section(business, "Ownership") + section(owner, "Work")) ? "equal 50/50 partners" : null;
  const partnerName = /^#\s+(.+)$/m.exec(partner)?.[1]?.trim() ?? null;
  const bizBody = named(business.replace(/^---[\s\S]*?\n---\n/, "").replace(/^#.*$/m, "").trim().split(/\n##\s/)[0]);
  const bizIntro = stripEndDot(firstSentence(bizBody))
    .replace(/^The\s+/i, "the ")
    .replace(/\s+founded by .*$/i, "");
  const sells = stripEndDot(named(firstSentence(section(business, "What it sells"))).replace(/\s*[—-]\s*demonstrated.*$/i, ""));
  const partnerAge = ageFrom(field(section(partner, "Identity"), "Born"), now);
  const partnerEdu = stripEndDot(named(firstSentence(section(partner, "Education"))).replace(/\s+[—-]\s+still studying/i, ", still studying"));
  const partnerBits = [partnerAge !== null ? `${partnerAge}` : null, partnerEdu || null, /hafiz/i.test(section(partner, "Faith")) ? "also hafiz" : null].filter(Boolean);
  const biz = join2([
    `${OWNER_MARK}, business:`,
    bizTitle ? `Co-founder of ${bizTitle}${partnerName ? ` with ${partnerName}` : ""}${ownership ? `, ${ownership}` : ""}.` : null,
    bizTitle && bizIntro ? `${bizTitle} is ${bizIntro}${sells ? `, selling ${sells.replace(/^(\w)/, (c) => c.toLowerCase())}` : ""}.` : null,
    partnerName ? `${partnerName}${partnerBits.length ? ` (${partnerBits.join("; ")})` : ""} may message too, so check who is speaking.` : null,
  ]);

  // ── Mission and how to work with him ──
  const goalsIntro = goals.replace(/^---[\s\S]*?\n---\n/, "").split(/\n##\s/)[0];
  const goalLines = goalsIntro
    .split("\n")
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => stripEndDot(named(l.replace(/^[-*]\s+/, "")).split(/\.\s/)[0]))
    .filter(Boolean)
    .map((g) => g.replace(/^(\w)/, (c) => c.toLowerCase()));
  const how = section(claudeMd, "How to work with me");
  const whoAmI = section(claudeMd, "Who I am");
  const style = [
    /not a beginner/i.test(whoAmI + how) ? "he is not a beginner, so skip the basics" : null,
    /act, don['’]t survey/i.test(how) ? "act, don't survey: one recommendation, not a list of options" : null,
    /re-explain religious basics/i.test(how) ? "never re-explain religious basics" : null,
    /Australian English/i.test(how) ? "Australian English" : null,
  ].filter(Boolean);
  const mission = join2([
    `${OWNER_MARK}, mission:`,
    goalLines.length ? `${goalLines.join("; ")}.` : null,
    style.length ? `Working with him: ${style.join("; ")}.` : null,
  ]);

  const entries: string[] = [];
  for (const [label, text] of [
    ["identity", who],
    ["business", biz],
    ["mission", mission],
  ] as const) {
    const screened = screenSensitive(text);
    for (const d of screened.dropped) warnings.push(`Left out a ${label} sentence that looked like ${d}.`);
    // Only the heading left means nothing was found for this entry.
    if (!/:\s*$/.test(screened.text) && screened.text.length > OWNER_MARK.length + 16) entries.push(screened.text);
  }
  return { entries, sources, warnings };
}
// ── USER.md ──────────────────────────────────────────────────────────────────────────────────

export function parseEntries(raw: string): string[] {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean);
}

export function isOwnerEntry(entry: string): boolean {
  return entry.startsWith(OWNER_MARK);
}

/** memory.user_char_limit from config.yaml (Hermes' default 1,375). */
export function userCharLimit(configYaml: string): number {
  const text = configYaml.replace(/\r\n/g, "\n");
  const block = /^memory:\s*\n((?:[ \t]+.*\n?)+)/m.exec(text)?.[1] ?? "";
  const n = Number(/^[ \t]+user_char_limit:\s*(\d+)/m.exec(block)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : 1375;
}

export type ProfileState = {
  path: string;
  exists: boolean;
  limit: number;
  /** Our entries as they are in USER.md now. */
  current: string[];
  /** Entries Hermes wrote itself (kept untouched). */
  others: string[];
  /** What a refresh would write. */
  proposed: string[];
  inSync: boolean;
  /** Characters the file would use after a refresh, against `limit`. */
  usageAfter: number;
  fits: boolean;
  sources: string[];
  warnings: string[];
};

export function ownerProfileState(options: OwnerProfileSources & { hermesHome: string }): ProfileState {
  const path = join(options.hermesHome, "memories", "USER.md");
  const limit = userCharLimit(read(join(options.hermesHome, "config.yaml")));
  const exists = existsSync(path);
  const entries = parseEntries(read(path));
  const current = entries.filter(isOwnerEntry);
  const others = entries.filter((e) => !isOwnerEntry(e));
  const built = buildOwnerProfile(options);
  const next = [...built.entries, ...others];
  const usageAfter = next.join(ENTRY_DELIMITER).length;
  const warnings = [...built.warnings];
  const fits = usageAfter <= limit && next.every((e) => e.length <= limit);
  if (!fits) warnings.push(`The profile would use ${usageAfter} of ${limit} characters in USER.md. Shorten the wiki pages or raise memory.user_char_limit.`);
  return {
    path,
    exists,
    limit,
    current,
    others,
    proposed: built.entries,
    inSync: current.length === built.entries.length && current.every((e, i) => e === built.entries[i]),
    usageAfter,
    fits,
    sources: built.sources,
    warnings,
  };
}

export type WriteResult = { ok: boolean; changed: boolean; backup: string | null; error?: string; state: ProfileState };

/** Refresh our entries in USER.md: back up, write LF "\n§\n"-joined entries atomically, re-validate. */
export function writeOwnerProfile(options: OwnerProfileSources & { hermesHome: string }): WriteResult {
  const state = ownerProfileState(options);
  if (!state.proposed.length) return { ok: false, changed: false, backup: null, error: "Nothing to write: the wiki pages weren't found.", state };
  if (!state.fits) return { ok: false, changed: false, backup: null, error: state.warnings[state.warnings.length - 1], state };
  if (state.inSync) return { ok: true, changed: false, backup: null, state };
  const now = (options.now ?? (() => new Date()))();
  const dir = join(options.hermesHome, "memories");
  mkdirSync(dir, { recursive: true });
  let backup: string | null = null;
  if (state.exists) {
    backup = join(dir, `USER.md.bak-agentic-os-${now.toISOString().replace(/[:.]/g, "-")}`);
    copyFileSync(state.path, backup);
    const olds = readdirSync(dir).filter((n) => n.startsWith("USER.md.bak-agentic-os-")).sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
  }
  const text = [...state.proposed, ...state.others].join(ENTRY_DELIMITER);
  const tmp = join(dir, `.USER.md.agentic-os-${process.pid}.tmp`);
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, state.path);
  // Re-read and check it round-trips the way Hermes' memory tool requires.
  const raw = readFileSync(state.path, "utf-8");
  const parsed = parseEntries(raw);
  const roundTrips = raw.trim() === parsed.join(ENTRY_DELIMITER) && !raw.includes("\r") && parsed.every((e) => e.length <= state.limit);
  if (!roundTrips) {
    if (backup) copyFileSync(backup, state.path);
    return { ok: false, changed: false, backup, error: "USER.md didn't round-trip after writing; the backup was restored.", state };
  }
  return { ok: true, changed: true, backup, state: ownerProfileState(options) };
}

/**
 * Run Hermes' own strict memory scan (tools/threat_patterns.first_threat_message, the check its
 * memory tool applies to every write) over the entries, with Hermes' bundled Python. Returns one
 * finding per entry (null = clean), or null when Hermes' Python isn't available to ask.
 */
export async function hermesMemoryScan(
  entries: string[],
  agentDir: string,
  run: (file: string, args: string[], input: string) => Promise<{ status: number | null; stdout: string }>,
): Promise<Array<string | null> | null> {
  const candidates = [join(agentDir, "venv", "Scripts", "python.exe"), join(agentDir, "venv", "bin", "python")];
  const python = candidates.find((p) => existsSync(p));
  if (!python || !existsSync(join(agentDir, "tools", "threat_patterns.py"))) return null;
  const code =
    "import sys,json; sys.path.insert(0, sys.argv[1]); from tools.threat_patterns import first_threat_message as f; " +
    "print(json.dumps([f(e, scope='strict') for e in json.loads(sys.stdin.read())]))";
  const res = await run(python, ["-c", code, agentDir], JSON.stringify(entries));
  if (res.status !== 0) return null;
  try {
    const out = JSON.parse(res.stdout.trim().split(/\r?\n/).pop() ?? "null");
    return Array.isArray(out) && out.length === entries.length ? out.map((x) => (typeof x === "string" && x ? x : null)) : null;
  } catch {
    return null;
  }
}