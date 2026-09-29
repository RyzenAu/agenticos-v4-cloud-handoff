// The ONE destination/action registry and resolver (Track 1, 28 Sep 2026). Contract: ./types.ts.
//
//   buildCommandIndex(dynamic)            static entries (every OS destination and drilldown, named page
//                                         sections, package-margin answers) + dynamic sources (projects,
//                                         sites, files, installed apps, CRM leads), each with its honest state
//   resolveCommand(text, index, opts)     typed (palette Enter) and spoken (Jarvis, Track 2) → ONE entry, an
//                                         ambiguity question, or a reason; "that call" goes to page context
//   searchCommands(text, index, limit)    the palette's ranked list (same scoring as resolveCommand)
//   planCommand(entry, parsed, who)       what running it does; device plans carry the /screen/command body
//
// Pure: no fetch, no React, no DOM. Numbers in answers come from the catalogue and the economics model only.
import { DESTINATIONS, drilldownHref, visibleDrilldowns } from "../../components/shell/destinations";
import { calculateEconomics, defaultEconomicsInput, ECONOMICS_AS_OF } from "../business-economics";
import { formatAud, RECEPTIONIST_PACKAGES, type ReceptionistPackage } from "../receptionist-packages";
import { resolveReference, type PageContextSnapshot } from "../page-context";
import type {
  CommandAction,
  CommandAnswer,
  CommandChannel,
  CommandEntry,
  CommandIndex,
  CommandPlan,
  CommandSourceStatus,
  ParsedCommand,
  Resolution,
  ScoredEntry,
} from "./types";

export * from "./types";
import { codingCommandEntry } from "./coding";

// --- normalising and parsing ---------------------------------------------------------------------------
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}'$+ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const LEAD_IN = /^(?:(?:hey|ok|okay)\s+)?(?:jarvis\b[,\s]*)?(?:(?:can|could|would|will) you\s+|please\s+|i want to\s+|i'd like to\s+|let's\s+)?/;
const TRAIL = /\s+(?:please|for me|now|thanks|jarvis)$/;
const VERBS: Array<[RegExp, ParsedCommand["verb"]]> = [
  [/^(?:launch|start|run|fire up|boot up|load up|start up)\s+/, "launch"],
  [/^(?:open|open up|pull up|bring up)\s+/, "open"],
  [/^(?:show|show me|display|view|see|go to|take me to|navigate to|jump to|switch to)\s+/, "show"],
  [/^(?:find|search for|search|look up|where is|where's)\s+/, "find"],
];
/** A device named at the end: "here", "on this pc", "on my laptop", "on mehroz's laptop". */
const DEVICE_SUFFIX = /\s+(here|on (?:this|my|the|[a-z]+'s|[a-z]+s) (?:pc|computer|desktop|machine|laptop|notebook|phone|device)|on (?:my|this) (?:main |work )?(?:pc|computer))$/;
/** Words meaning "the device I'm on" (scripts/commands/plugin.ts isHere uses the same list). */
export const HERE = /^(?:here|on this (?:pc|computer|desktop|machine|laptop|device))$/;
/** "that call", "this client", "it", "this one". */
const DEICTIC = /^(?:this|that|it|the selected|the highlighted|the focused)(?:\s+(one|[a-z]+))?$/;
const STOP = new Set(["the", "a", "an", "my", "our", "your", "of", "for", "to", "in", "on", "page", "tab", "screen", "please", "me", "up", "and"]);

/** Only the verb is left ("go to", "open"): nothing was actually named. */
const bareVerb = (t: string) => VERBS.some(([re]) => re.test(`${t} `) && !`${t} `.replace(re, "").trim());

/**
 * "hey jarvis, open X please" → "open X". The lead-in and trail words are dropped only when something is
 * left to name: "jarvis" and "go to jarvis" mean the Jarvis page (audit P1-2), not an empty query.
 */
function stripFraming(t: string): string {
  const lead = t.replace(LEAD_IN, "").trim();
  const base = lead || t.replace(/^(?:hey|ok|okay)\s+/, "").trim();
  const trimmed = base.replace(TRAIL, "").trim();
  return trimmed && !bareVerb(trimmed) ? trimmed : base;
}

/** "Hey Jarvis, open PowerPoint here please" → { verb: "open", object: "powerpoint", spokenTarget: "here" }. Pure. */
export function parseCommandText(text: string): ParsedCommand {
  let t = stripFraming(norm(text));
  let verb: ParsedCommand["verb"] = null;
  for (const [re, v] of VERBS) {
    if (re.test(t)) {
      verb = v;
      t = t.replace(re, "");
      break;
    }
  }
  let spokenTarget: string | undefined;
  const dev = DEVICE_SUFFIX.exec(t);
  if (dev) {
    spokenTarget = dev[1];
    t = t.slice(0, dev.index).trim();
  }
  t = t.replace(/^(?:the|my|our)\s+/, "").trim();
  const d = DEICTIC.exec(t);
  const deictic = d ? { noun: d[1] && d[1] !== "one" ? d[1] : null } : undefined;
  return { verb, object: t, ...(spokenTarget ? { spokenTarget } : {}), ...(deictic ? { deictic } : {}) };
}

const stem = (w: string) => w.replace(/'s$/, "").replace(/'/g, "").replace(/(?<=[a-z]{3})(?:ies)$/, "y").replace(/(?<=[a-z]{3})s$/, "");
const tokens = (s: string) => norm(s).split(" ").map(stem).filter((w) => w && !STOP.has(w));

/** Levenshtein similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function tokenMatch(want: string, have: readonly string[]): number {
  let best = 0;
  for (const h of have) {
    if (h === want) return 1;
    if (want.length >= 3 && h.startsWith(want)) best = Math.max(best, 0.9);
    // "receptionists" / "receptionist": a longer word only when it's the same word plus an ending, never
    // "notepad" for "notes" (a different word that happens to start the same).
    else if (h.length >= 4 && want.startsWith(h) && want.length - h.length <= 2) best = Math.max(best, 0.8);
    else if (want.length >= 4 && h.length >= 4) {
      const s = similarity(want, h);
      if (s >= 0.8) best = Math.max(best, s * 0.9);
    }
  }
  return best;
}

/** How well `object` names this phrase, in [0, 1]. */
function phraseScore(object: string, phrase: string): number {
  const o = norm(object);
  const p = norm(phrase);
  if (!o) return 0;
  if (o === p) return 1;
  const ot = tokens(o);
  const pt = tokens(p);
  if (!ot.length || !pt.length) return 0;
  if (ot.join(" ") === pt.join(" ")) return 0.98;
  // The same words in another order ("margin on the Professional package" / "professional package margin").
  if (ot.length === pt.length && [...ot].sort().join(" ") === [...pt].sort().join(" ")) return 0.95;
  // "power point" / "powerpoint", "note pad" / "notepad": speech-to-text splits and joins words.
  if (ot.join("") === pt.join("")) return 0.96;
  const objCover = ot.reduce((sum, w) => sum + tokenMatch(w, pt), 0) / ot.length;
  const phraseCover = pt.reduce((sum, w) => sum + tokenMatch(w, ot), 0) / pt.length;
  const prefix = p.startsWith(o) && o.length >= 3 ? 0.08 : 0;
  return Math.min(0.97, 0.6 * objCover + 0.32 * phraseCover + prefix);
}

function entryScore(entry: CommandEntry, parsed: ParsedCommand, context?: PageContextSnapshot | null): number {
  let best = 0;
  for (const phrase of [entry.title, ...entry.phrases]) best = Math.max(best, phraseScore(parsed.object, phrase));
  if (best <= 0) return 0;
  // The verb nudges between kinds; it never makes a poor match good.
  const deviceKind = entry.kind === "app" || entry.kind === "file";
  if (parsed.verb === "launch") best += deviceKind ? 0.06 : -0.04;
  if (parsed.verb === "show") best += deviceKind ? -0.06 : 0.03;
  if (parsed.spokenTarget) best += deviceKind ? 0.08 : -0.1;
  if (context?.page?.destination && entry.destination === context.page.destination) best += 0.01;
  // A destination's own landing page wins a tie with one of its drilldowns ("finance" → /finance, not "Finances").
  if (entry.kind === "page" && best >= 0.9 && DESTINATIONS.some((d) => `page:${d.to}` === entry.id)) best += 0.02;
  return Math.max(0, Math.min(1, best));
}

/** The words are exactly this entry's title ("finances" is the Finances page, whatever else scores 1). */
const literalTitle = (entry: CommandEntry, object: string) => !!object && norm(entry.title) === norm(object);

/**
 * The page the typed words name outright (its title, whatever gate words they contain: "share card" is the
 * Share card page even though "share" is an action word). Pure; null when the words name no page.
 */
export function exactPageMatch(text: string, index: CommandIndex): CommandEntry | null {
  const object = parseCommandText(text).object;
  if (!object) return null;
  return index.entries.find((e) => e.kind === "page" && e.action.type === "navigate" && literalTitle(e, object)) ?? null;
}

/**
 * The palette's list, in order: this page's context answer, then the page the words name outright, then
 * "Ask Jarvis" (rule answer, money or action words), then everything else ranked. The page named by its own
 * title always comes first, so "share card" opens Share card, with "Ask Jarvis" second (audit P1-2).
 */
export function orderPaletteResults(text: string, found: readonly ScoredEntry[], index: CommandIndex, extras: { context?: CommandEntry | null; ask?: CommandEntry | null } = {}): ScoredEntry[] {
  const exact = exactPageMatch(text, index);
  const lead: ScoredEntry[] = [];
  if (extras.context) lead.push({ entry: extras.context, score: 1 });
  if (exact) lead.push({ entry: exact, score: 1 });
  if (extras.ask) lead.push({ entry: extras.ask, score: 1 });
  const taken = new Set(lead.map((s) => s.entry.id));
  return [...lead, ...found.filter((f) => !taken.has(f.entry.id))];
}

/**
 * Does this entry account for EVERY word of the object? A device or site entry runs only when it does
 * (REVIEW-T1 fix 2): "stake com" must not open a site whose address happens to contain "com", and "press
 * send" must not open "Send to OneNote". Pure.
 */
export function coversObject(entry: CommandEntry, object: string): boolean {
  const want = tokens(object);
  if (!want.length) return false;
  const have = [...new Set([entry.title, ...entry.phrases].flatMap((p) => tokens(p)))];
  // A speech or typing slip of a longer word still counts ("powerpnt"); a different word never does.
  return want.every((w) => tokenMatch(w, have) >= 0.8 || (w.length >= 5 && have.some((h) => h.length >= 5 && similarity(w, h) >= 0.75)));
}

/** Can Enter run this entry on a device or open it as a site? Score at least the typed act, full coverage. */
export function mayRunEntry(scored: ScoredEntry, object: string): boolean {
  const kind = scored.entry.action.type;
  if (kind !== "device" && kind !== "open-url") return true;
  return scored.score >= THRESHOLDS.typed.act && coversObject(scored.entry, object);
}

/** Minimum score to act on, and the margin inside which two different actions are "ambiguous". */
export const THRESHOLDS: Record<CommandChannel, { act: number; margin: number }> = {
  typed: { act: 0.5, margin: 0.04 },
  voice: { act: 0.78, margin: 0.08 },
};

const sameAction = (a: CommandAction, b: CommandAction) => JSON.stringify(a) === JSON.stringify(b);

/** Ranked entries for the palette (same scoring as resolveCommand). Empty text → the pages, in nav order. */
export function searchCommands(text: string, index: CommandIndex, limit = 30, context?: PageContextSnapshot | null): ScoredEntry[] {
  const parsed = parseCommandText(text);
  if (!parsed.object) return index.entries.filter((e) => e.kind === "page").slice(0, limit).map((entry) => ({ entry, score: 0 }));
  return index.entries
    .map((entry) => ({ entry, score: entryScore(entry, parsed, context) }))
    .filter((s) => s.score >= 0.34)
    .sort((a, b) => b.score - a.score || Number(literalTitle(b.entry, parsed.object)) - Number(literalTitle(a.entry, parsed.object)) || a.entry.title.length - b.entry.title.length)
    .slice(0, limit);
}

/**
 * The ONE resolver for typed and spoken commands. Never guesses: two different actions within the
 * channel's margin → `ambiguous` with the question to ask; "that call" → page context (asks when unclear).
 */
export function resolveCommand(
  text: string,
  index: CommandIndex,
  options: { channel?: CommandChannel; context?: PageContextSnapshot | null } = {},
): Resolution {
  const channel = options.channel ?? "typed";
  const parsed = parseCommandText(text);
  const unavailable = index.sources.filter((s) => s.state !== "live" && s.state !== "simulated");
  if (!parsed.object) return { status: "unresolved", parsed, reason: "Say or type what to open.", unavailable };
  // Spoken: the wake word on its own is not a request to open the Jarvis page (typed "jarvis" is).
  if (channel === "voice" && /^(?:(?:hey|ok|okay)\s+)?jarvis$/.test(norm(text))) return { status: "unresolved", parsed, reason: "Say or type what to open.", unavailable };
  // Track 3 (F8): "fix / build / change X in <repo>" drafts a coding job (typed and spoken alike).
  const coding = codingCommandEntry(text);
  if (coding) return { status: "resolved", entry: coding, score: 1, parsed, alternatives: [] };

  if (parsed.deictic) {
    const ref = resolveReference(parsed.deictic.noun, options.context ?? undefined);
    if (!ref.ok) return "ask" in ref ? { status: "ambiguous", parsed, candidates: [], ask: ref.ask } : { status: "unresolved", parsed, reason: ref.unknown, unavailable };
    const item = ref.item;
    if (!item.to) return { status: "unresolved", parsed, reason: `${item.label} has no page of its own to open.`, unavailable };
    const entry: CommandEntry = {
      id: `context:${item.kind}:${item.id}`,
      kind: "section",
      title: item.label,
      detail: `From this page (${ref.how.replace("-", " ")})`,
      phrases: [],
      action: { type: "navigate", to: item.to, ...(item.search ? { search: item.search } : {}), ...(item.focus ? { focus: item.focus } : {}) },
      source: "static",
    };
    return { status: "resolved", entry, score: 1, parsed, alternatives: [] };
  }

  const ranked = searchCommands(text, index, 8, options.context);
  const { act, margin } = THRESHOLDS[channel];
  const best = ranked[0];
  if (!best || best.score < act) {
    const devicey = parsed.verb === "launch" || !!parsed.spokenTarget;
    const apps = index.sources.find((s) => s.id === "apps");
    const why =
      devicey && apps && apps.state !== "live"
        ? `Nothing matches "${parsed.object}" in pages or projects. ${apps.reason ?? "The app index isn't available."}`
        : best
          ? `Not sure what "${parsed.object}" means${channel === "voice" ? "" : ` (closest: ${best.entry.title})`}.`
          : `Nothing called "${parsed.object}".`;
    return { status: "unresolved", parsed, reason: why, unavailable };
  }
  // A name that is exactly ONE entry's title is that entry (J4: "go to Finance" is the Finance page, "open Vault" the Vault,
  // not "Did you mean Finance or Finances?" / "Vault or Memory?"). Two entries with the same title still ask.
  const asTitled = ranked.filter((s) => s.score >= act && norm(s.entry.title) === norm(parsed.object));
  if (asTitled.length === 1) return { status: "resolved", entry: asTitled[0].entry, score: asTitled[0].score, parsed, alternatives: ranked.filter((s) => s !== asTitled[0]).slice(0, 3) };
  // An exact name beats near names ("finance" is the Finance page, not "Finances"): only other exact matches rival it.
  const exact = best.score >= 0.99;
  const rivals = ranked.filter((s) => s !== best && best.score - s.score <= margin && (!exact || s.score >= 0.99) && !sameAction(s.entry.action, best.entry.action));
  if (rivals.length) {
    const candidates = [best, ...rivals].slice(0, 3);
    return { status: "ambiguous", parsed, candidates, ask: `Did you mean ${candidates.map((c) => c.entry.title).join(" or ")}?` };
  }
  return { status: "resolved", entry: best.entry, score: best.score, parsed, alternatives: ranked.slice(1, 4) };
}

/** What running an entry does. Device plans are only sent after their target is resolved and shown. */
export function planCommand(entry: CommandEntry, parsed: ParsedCommand | null, who: { personId?: string } = {}): CommandPlan {
  const a = entry.action;
  if (a.type === "navigate") return { kind: "navigate", entryId: entry.id, to: a.to, ...(a.search ? { search: a.search } : {}), ...(a.focus ? { focus: a.focus } : {}), ...(entry.answer ? { answer: entry.answer } : {}) };
  if (a.type === "open-url") return { kind: "open-url", entryId: entry.id, url: a.url };
  // "here" is the requester's current device, which the Jarvis entry already defaults to; a device NAME
  // ("on my laptop") is passed through for resolveTarget to check.
  const spokenTarget = parsed?.spokenTarget && !HERE.test(parsed.spokenTarget) ? parsed.spokenTarget : undefined;
  return {
    kind: "device",
    entryId: entry.id,
    request: { utterance: a.utterance, ...(spokenTarget ? { spokenTarget } : {}), ...(who.personId ? { personId: who.personId } : {}) },
    needsTargetPreview: true,
  };
}

// --- static entries --------------------------------------------------------------------------------------
const pct = (bps: number | null) => (bps === null ? "not computable" : `${(bps / 100).toFixed(1)}%`);

/** The margin answer for one package: base usage, 5 clients (the same defaults as scripts/jev-margin.ts). */
export function packageMarginAnswer(pkg: ReceptionistPackage, clients = 5): CommandAnswer {
  const r = calculateEconomics({ ...defaultEconomicsInput(pkg, "base"), clients });
  const status = pkg.pricing.status === "approved" ? "approved" : "proposed";
  return {
    headline: `${pkg.shortName}: estimated contribution margin ${pct(r.contributionMarginBps)}, operating margin ${pct(r.operatingMarginBps)}`,
    figures: [
      { label: "Price", value: `${formatAud(pkg.pricing.monthly.cents)} / month ex GST (${status})` },
      { label: "Revenue (5 clients)", value: `${formatAud(r.revenueExGstCents)} / month` },
      { label: "Contribution", value: `${formatAud(r.contributionCents)} / month` },
      { label: "Usage scenario", value: `Base, ${clients} client${clients === 1 ? "" : "s"}` },
    ],
    source: "Package catalogue (src/lib/receptionist-packages.ts) + economics model (src/lib/business-economics.ts)",
    state: "simulated",
    caveat: `Estimate from planning assumptions as of ${ECONOMICS_AS_OF}; not measured usage or reconciled invoices${r.incomplete ? "; some cost rates are still unknown" : ""}.`,
  };
}

/** Extra words people use for each OS page (the label and purpose are always searchable). */
const PAGE_WORDS: Record<string, string[]> = {
  "/inbox": ["email", "emails", "mail", "messages"],
  "/inbox-triage": ["triage", "inbox alerts", "shadow review"],
  "/business?view=audience": ["followers", "content", "social", "growth"],
  "/dashboard": ["mission control", "old dashboard"],
  "/calendar": ["schedule", "meetings", "diary"],
  "/jarvis": ["voice", "assistant", "talk"],
  "/chat": ["conversations", "typed chat"],
  "/agents/hermes": ["executor", "hermes agent"],
  // Track 3: coding jobs live under Work → Coding; the Claude Code page is Mission Control sessions.
  "/agents/claude-code": ["claude code sessions", "claude code"],
  "/coding": ["coding", "coding jobs", "coding workspace", "agent jobs", "code"],
  "/automations": ["cron", "scheduled jobs"],
  "/activity": ["log", "history", "what agents did"],
  "/receptionist": ["ai receptionist", "receptionist dashboard", "calls", "safe to sell", "retell", "call feed"],
  "/operations": ["operations", "m&u operations", "packages", "pricing", "margins", "economics", "prices", "package prices"],
  "/work": ["approvals", "pipeline"],
  "/leads": ["crm", "call queue", "prospects", "pipeline"],
  "/websites": ["sites", "flagships", "previews"],
  // Home is the Business brief (29 Sep 2026); "brief" and the old Today words still find it.
  "/business": ["home", "today", "dashboard", "start", "what's next", "needs me", "business", "business brief", "brief", "advisor"],
  "/workspaces": ["projects", "repos", "project folders"],
  "/memory": ["vault", "notes", "knowledge", "hindsight"],
  "/memory/vault": ["facts", "corrections", "forget"],
  "/finance": ["money", "cash", "invoices", "costs", "bank"],
  "/usage": ["usage", "spend", "ai spend", "tokens", "plan limits", "ai usage", "model usage"],
  "/studio": ["proposals", "decks", "videos", "scripts", "films"],
  "/design": ["images", "generation", "media"],
  "/system": ["devices", "tools", "diagnostics", "tool check"],
  "/models": ["model routes", "providers", "llms"],
  "/settings": ["preferences", "profile", "connections"],
};

/** The Settings switches that show or hide pages in the sidebar (Mission Control, OpenClaw). */
export type NavSettings = Partial<Record<"openclaw" | "mission", unknown>>;

function pageEntries(settings?: NavSettings): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const d of DESTINATIONS) {
    out.push({
      id: `page:${d.to}`,
      kind: "page",
      title: d.label,
      detail: d.purpose,
      phrases: [d.label.toLowerCase(), ...(PAGE_WORDS[d.to] ?? [])],
      action: { type: "navigate", to: d.to },
      destination: d.id,
      source: "static",
    });
    // The palette follows the same Settings switches as the sidebar; without settings every page is listed.
    for (const dd of settings ? visibleDrilldowns(d, settings) : d.drilldowns) {
      const href = drilldownHref(dd);
      out.push({
        id: `page:${href}`,
        kind: "page",
        title: dd.label,
        detail: `${d.label} · ${dd.purpose}`,
        phrases: [dd.label.toLowerCase(), ...(PAGE_WORDS[href] ?? (dd.view ? [] : PAGE_WORDS[dd.to] ?? []))],
        action: { type: "navigate", to: dd.to, ...(dd.view ? { search: { view: dd.view } } : {}) },
        destination: d.id,
        source: "static",
      });
    }
  }
  return out;
}

/** Named sections: the ids exist on those pages (tests check the ids are rendered). */
export const SECTION_ENTRIES: readonly CommandEntry[] = [
  {
    id: "page:/setup",
    kind: "page",
    title: "Setup",
    detail: "System · first-run setup and connections",
    phrases: ["setup", "set up", "first run setup", "onboarding"],
    action: { type: "navigate", to: "/setup" },
    destination: "system",
    source: "static",
  },
  {
    id: "page:command-scene",
    kind: "page",
    title: "Command scene",
    detail: "Optional spatial overview: Receptionist, Leads, Coding, Memory, Finance",
    phrases: ["command scene", "scene", "command centre", "command center", "overview scene", "spatial overview", "business at a glance"],
    action: { type: "navigate", to: "/business", search: { scene: "1" } },
    destination: "today",
    source: "static",
  },
  {
    id: "section:receptionist/flagged-calls",
    kind: "section",
    title: "Receptionist flagged calls",
    detail: "Receptionist · real calls flagged by transcript checks or production QA",
    phrases: ["receptionist flagged calls", "flagged calls", "receptionist's flagged calls", "receptionist flags", "calls flagged", "call flags", "flagged receptionist calls"],
    action: { type: "navigate", to: "/receptionist", focus: "rx-flagged-calls" },
    destination: "receptionist",
    source: "static",
  },
  {
    id: "section:receptionist/sell-status",
    kind: "section",
    title: "Receptionist sell status",
    detail: "Receptionist · is it safe to sell, and why not",
    phrases: ["safe to sell", "sell status", "not safe to sell", "go live gates", "receptionist verdict"],
    action: { type: "navigate", to: "/receptionist", focus: "rx-sell-verdict" },
    destination: "receptionist",
    source: "static",
  },
];

/**
 * The three workspaces (M&U Ventures, Receptionist, Websites; src/components/workspace/three-workspaces.tsx) are nameable by
 * voice and typing: "open the receptionist workspace", "open the M and U Ventures workspace" (J4, AUDIT-JARVIS continuity).
 * They live at /workspaces/<id>; "open workspaces" is the Workspaces page itself.
 */
export const WORKSPACE_ENTRIES: readonly CommandEntry[] = (
  [
    ["mu-ventures", "M&U Ventures workspace", ["m and u ventures workspace", "mu ventures workspace", "m u ventures workspace", "muv workspace", "business workspace", "main workspace"], "M&U Ventures: the business itself"],
    ["receptionist", "Receptionist workspace", ["receptionist workspace", "ai receptionist workspace", "mu receptionist workspace"], "Receptionist: the AI receptionist product and its projects"],
    ["websites", "Websites workspace", ["websites workspace", "website workspace", "sites workspace", "client sites workspace"], "Websites: client sites, flagships and previews"],
  ] as const
).map(([id, title, phrases, detail]) => ({
  id: `page:/workspaces/${id}`,
  kind: "page" as const,
  title,
  detail: `Work · ${detail}`,
  phrases: [...phrases],
  action: { type: "navigate" as const, to: `/workspaces/${id}` },
  destination: "work" as const,
  source: "static" as const,
}));

function answerEntries(): CommandEntry[] {
  return RECEPTIONIST_PACKAGES.map((pkg) => {
    const price = Math.round(pkg.pricing.monthly.cents / 100);
    const name = pkg.shortName.toLowerCase();
    return {
      id: `answer:margin/${pkg.id}`,
      kind: "answer" as const,
      title: `${pkg.shortName} margin`,
      detail: `Packages & economics · ${pkg.name}, estimated from the catalogue`,
      phrases: [`${name} margin`, `${name} package margin`, `${name} margins`, `margin ${name}`, `${name} economics`, `${name} profit`, `${price} margin`, `$${price} margin`, `${name} package`],
      action: { type: "navigate", to: "/operations", search: { package: pkg.id }, focus: "economics-workbench" },
      destination: "receptionist",
      source: "static",
      answer: packageMarginAnswer(pkg),
    };
  });
}

export function staticEntries(settings?: NavSettings): CommandEntry[] {
  return [...pageEntries(settings), ...SECTION_ENTRIES, ...WORKSPACE_ENTRIES, ...answerEntries()];
}

// --- dynamic sources ------------------------------------------------------------------------------------
export type DynamicSource<T> = { state: CommandSourceStatus["state"]; reason?: string; lastSuccess?: string | null; items: readonly T[] };
export type DynamicSources = {
  projects?: DynamicSource<{ id: string; name: string; detail?: string }>;
  sites?: DynamicSource<{ id: string; name: string; url: string; kind: string }>;
  files?: DynamicSource<{ name: string; where: string }>;
  apps?: DynamicSource<{ name: string }>;
  leads?: DynamicSource<{ leadId: number; title: string; detail: string }>;
};

const LABELS = { static: "OS pages", projects: "Projects", sites: "Websites", files: "Files", apps: "Installed apps", leads: "CRM leads" } as const;
const UNKNOWN_REASON: Record<keyof DynamicSources, string> = {
  projects: "Projects haven't loaded yet.",
  sites: "Websites haven't loaded yet.",
  files: "Type a file name to search authorised folders.",
  apps: "The installed-app index hasn't loaded yet.",
  leads: "Type two or more characters to search the CRM.",
};

/** The index: static entries plus whatever dynamic sources have been read, each with its honest state. */
export function buildCommandIndex(dynamic: DynamicSources = {}, now = Date.now(), options: { settings?: NavSettings } = {}): CommandIndex {
  const entries: CommandEntry[] = staticEntries(options.settings);
  const sources: CommandSourceStatus[] = [{ id: "static", label: LABELS.static, state: "live", count: entries.length }];
  const add = <K extends keyof DynamicSources>(id: K, make: (item: NonNullable<DynamicSources[K]>["items"][number]) => CommandEntry) => {
    const src = dynamic[id];
    if (!src) return void sources.push({ id, label: LABELS[id], state: "unknown", reason: UNKNOWN_REASON[id], count: 0 });
    const made = src.items.map((item) => make(item as never));
    entries.push(...made);
    sources.push({ id, label: LABELS[id], state: src.state, ...(src.reason ? { reason: src.reason } : {}), lastSuccess: src.lastSuccess ?? null, count: made.length });
  };
  add("projects", (p) => ({ id: `project:${p.id}`, kind: "project", title: p.name, detail: p.detail ?? "Project", phrases: [p.name.toLowerCase(), `${p.name.toLowerCase()} project`], action: { type: "navigate", to: `/workspaces/${encodeURIComponent(p.id)}` }, destination: "work", source: "projects" }));
  add("sites", (s) => ({ id: `site:${s.id}`, kind: "site", title: s.name, detail: `${s.kind === "flagship" ? "Flagship" : "Client"} site · ${s.url.replace(/^https?:\/\//, "")}`, phrases: [s.name.toLowerCase(), `${s.name.toLowerCase()} site`, `${s.name.toLowerCase()} website`, s.url.replace(/^https?:\/\//, "").toLowerCase()], action: { type: "open-url", url: s.url }, destination: "work", source: "sites" }));
  add("files", (f) => ({ id: `file:${f.where}/${f.name}`, kind: "file", title: f.name, detail: `File · ${f.where}`, phrases: [f.name.toLowerCase(), f.name.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "")], action: { type: "device", op: "open_file", subject: f.name, utterance: `open the file ${f.name.replace(/\.[a-z0-9]{1,5}$/i, "")}` }, source: "files" }));
  // The Windows Settings app is not the OS's Settings page: it says so, and the plain word goes to the page.
  const appTitle = (name: string) => (/^settings$/i.test(name) ? "Windows settings" : name);
  add("apps", (a) => ({ id: `app:${a.name}`, kind: "app", title: appTitle(a.name), detail: "Installed app · opens on your device", phrases: /^settings$/i.test(a.name) ? ["windows settings", "settings app"] : [a.name.toLowerCase()], action: { type: "device", op: "open_app", subject: a.name, utterance: `open ${a.name}` }, source: "apps" }));
  add("leads", (l) => ({ id: `lead:${l.leadId}:${l.title}`, kind: "lead", title: l.title, detail: `Lead #${l.leadId} · ${l.detail}`, phrases: [l.title.toLowerCase(), `#${l.leadId}`, `lead ${l.leadId}`], action: { type: "navigate", to: "/leads", search: { lead: String(l.leadId) } }, destination: "work", source: "leads" }));
  return { entries, sources, builtAt: now };
}
