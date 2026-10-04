/**
 * Contextual voice (NEXUS-ADDENDUM §2): "explain this margin", "open that call" resolve against the
 * page he is looking at, sent with the command as a PageContext (contracts.ts). The server never
 * trusts it for identity or permission: it only narrows WHICH item a word like "this" means.
 *
 * Rules, all deterministic:
 *  - a deictic phrase ("this margin", "that call", "these leads", "it") names a kind;
 *  - candidates are searched focused → selected → visible, and the first tier that has any wins;
 *  - exactly one candidate in that tier → resolved; several → Jev asks which (never guesses);
 *    none, or no page context at all → Jarvis says so and asks. Nothing is invented.
 */
import type { PageContext, PageContextItem } from "./contracts";

const MAX_ITEMS = 20;
const MAX_TEXT = 120;

const clean = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) : "");
/** OS-internal paths only ("/receptionist?call=abc"); never an external URL or a protocol-relative one. */
export function safeHref(v: unknown): string | undefined {
  const s = clean(v, 200);
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(s) && !s.includes("..") ? s : undefined;
}

function item(v: unknown): PageContextItem | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const kind = clean(o.kind, 32).toLowerCase();
  const id = clean(o.id, 80);
  const label = clean(o.label);
  if (!/^[a-z][a-z-]{1,31}$/.test(kind) || !id || !label) return null;
  const data: Record<string, string | number | boolean | null> = {};
  if (o.data && typeof o.data === "object") {
    for (const [k, val] of Object.entries(o.data as Record<string, unknown>).slice(0, 16)) {
      if (!/^[A-Za-z][\w.-]{0,40}$/.test(k)) continue;
      if (typeof val === "number" && Number.isFinite(val)) data[k] = val;
      else if (typeof val === "boolean" || val === null) data[k] = val;
      else if (typeof val === "string") data[k] = clean(val, 80);
    }
  }
  const href = safeHref(o.href);
  return { kind, id, label, ...(href ? { href } : {}), ...(Object.keys(data).length ? { data } : {}) };
}

/**
 * Track 1's snapshot (src/lib/page-context.ts PageContextSnapshot: page {path,title}, selection, focused,
 * visible items with `to`/`search`/`facts`, sources, job) → this module's PageContext. Pure.
 */
function fromSnapshot(o: Record<string, unknown>): Record<string, unknown> {
  const page = o.page as Record<string, unknown>;
  const mapItem = (v: unknown) => {
    if (!v || typeof v !== "object") return null;
    const i = v as Record<string, unknown>;
    const search = i.search && typeof i.search === "object" ? new URLSearchParams(Object.entries(i.search as Record<string, unknown>).map(([k, x]) => [k, String(x)])).toString() : "";
    return { kind: i.kind, id: i.id, label: i.label, href: typeof i.to === "string" ? `${i.to}${search ? `?${search}` : ""}` : undefined, data: i.facts };
  };
  const src = Array.isArray(o.sources) && o.sources[0] && typeof o.sources[0] === "object" ? (o.sources[0] as Record<string, unknown>) : null;
  const job = o.job && typeof o.job === "object" ? (o.job as Record<string, unknown>) : null;
  return {
    page: page.path,
    title: page.title,
    selected: o.selection ? [mapItem(o.selection)] : [],
    focused: mapItem(o.focused),
    visible: Array.isArray(o.visible) ? o.visible.map(mapItem) : [],
    ...(src ? { source: { name: src.label ?? src.source, state: src.state, updatedAt: src.lastSuccess ?? undefined } } : {}),
    ...(job ? { jobId: job.id } : {}),
    capturedAt: o.at,
  };
}

/** Validate and bound a client-sent page context (ours, or Track 1's snapshot). Anything malformed is dropped, never repaired into meaning. */
export function parsePageContext(value: unknown): PageContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let o = value as Record<string, unknown>;
  if (o.page && typeof o.page === "object" && typeof (o.page as Record<string, unknown>).path === "string") o = fromSnapshot(o);
  const page = safeHref(o.page);
  if (!page) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS).map(item).filter((x): x is PageContextItem => !!x) : []);
  const focused = item(o.focused);
  const src = o.source && typeof o.source === "object" ? (o.source as Record<string, unknown>) : null;
  const states = ["live", "simulated", "stale", "failed", "unknown", "setup-required"];
  return {
    page,
    ...(clean(o.title) ? { title: clean(o.title) } : {}),
    selected: list(o.selected),
    focused,
    visible: list(o.visible),
    ...(src && clean(src.name) ? { source: { name: clean(src.name), ...(states.includes(String(src.state)) ? { state: src.state as NonNullable<PageContext["source"]>["state"] } : {}), ...(clean(src.updatedAt, 40) ? { updatedAt: clean(src.updatedAt, 40) } : {}) } } : {}),
    ...(clean(o.jobId, 64) ? { jobId: clean(o.jobId, 64) } : {}),
    ...(typeof o.capturedAt === "number" && Number.isFinite(o.capturedAt) ? { capturedAt: o.capturedAt } : {}),
  };
}

/** Spoken nouns → the item kinds they can mean. */
const NOUN_KINDS: Record<string, string[]> = {
  margin: ["margin", "package", "metric"],
  margins: ["margin", "package", "metric"],
  package: ["package"],
  plan: ["package"],
  tier: ["package"],
  call: ["call"],
  calls: ["call"],
  lead: ["lead"],
  leads: ["lead"],
  client: ["client"],
  customer: ["client"],
  practice: ["client"],
  job: ["job"],
  task: ["job"],
  file: ["file"],
  document: ["file"],
  invoice: ["invoice"],
  booking: ["booking", "call"],
  figure: ["margin", "metric"],
  number: ["margin", "metric"],
  metric: ["metric", "margin"],
};
/** "explain the job", "open the client": only these two nouns take "the", and only as the whole request (the page names them). */
const DEFINITE = /^(?:please\s+)?(?:can you\s+)?(?:explain|open|show|read|summari[sz]e|what(?:'s| is)|how(?:'s| is))\s+(?:me\s+)?the\s+(job|client)(?:\s+(?:status|now|please))?\s*[.!?]?$/i;
const DEICTIC = /\b(this|that|these|those|the (?:selected|highlighted|open|current|focused))\s+(?:one\s+)?([a-z]+)\b/i;
/** Only a whole request that is just the verb and the pronoun ("open it", "explain this one"): "…and show it" is not a page reference. */
const BARE_IT = /^(?:please\s+)?(?:can you\s+)?(?:explain|open|show|read|summari[sz]e|what(?:'s| is))\s+(?:me\s+)?(it|this|that)(?:\s+one)?(?:\s+please)?\s*[.!?]?$/i;

export type Reference = { word: string; noun: string | null; kinds: string[] | null };
/** "explain this margin" → { word: "this", noun: "margin", kinds: [...] }; "open it" → noun null. Pure. */
export function referenceIn(utterance: string): Reference | null {
  const m = DEICTIC.exec(utterance);
  if (m) {
    const noun = m[2].toLowerCase();
    const kinds = NOUN_KINDS[noun];
    if (kinds) return { word: m[1].toLowerCase(), noun, kinds };
  }
  const def = DEFINITE.exec(utterance.trim());
  if (def) return { word: "the", noun: def[1].toLowerCase(), kinds: NOUN_KINDS[def[1].toLowerCase()] };
  const bare = BARE_IT.exec(utterance);
  return bare ? { word: bare[1].toLowerCase(), noun: null, kinds: null } : null;
}

export type Resolution =
  | { kind: "resolved"; item: PageContextItem; tier: "focused" | "selected" | "visible" | "page"; page: string }
  | { kind: "ambiguous"; candidates: PageContextItem[]; tier: "focused" | "selected" | "visible"; said: string }
  | { kind: "none"; said: string };

const plural = (noun: string | null) => noun ?? "thing";

/** Which page item his words mean. Never guesses: ambiguous and missing both ask. Pure. */
export function resolveReference(ref: Reference, ctx: PageContext | null): Resolution {
  if (!ctx) return { kind: "none", said: `I can't see which page you're on, so I don't know which ${plural(ref.noun)} you mean. Which one?` };
  const fits = (i: PageContextItem) => !ref.kinds || ref.kinds.includes(i.kind);
  const tiers: Array<["focused" | "selected" | "visible", PageContextItem[]]> = [
    ["focused", ctx.focused ? [ctx.focused] : []],
    ["selected", ctx.selected ?? []],
    ["visible", ctx.visible ?? []],
  ];
  for (const [tier, items] of tiers) {
    const hits = items.filter(fits);
    if (hits.length === 1) return { kind: "resolved", item: hits[0], tier, page: ctx.page };
    if (hits.length > 1) {
      const names = hits.slice(0, 3).map((h) => h.label).join(", ");
      return { kind: "ambiguous", candidates: hits, tier, said: `There are ${hits.length} ${ref.noun ? `${ref.noun}s` : "items"} here (${names}${hits.length > 3 ? "…" : ""}). Which one do you mean?` };
    }
  }
  // "the job" / "this job": the job the page is showing (pageContext.jobId) when no job item was listed.
  if (ctx.jobId && ref.kinds?.includes("job")) return { kind: "resolved", item: { kind: "job", id: ctx.jobId, label: `job ${ctx.jobId}` }, tier: "page", page: ctx.page };
  return { kind: "none", said: `I can't find ${ref.noun ? `a ${ref.noun}` : "that"} on ${ctx.title ?? ctx.page}, so I won't guess. Which one do you mean?` };
}

// ------------------------------------------------------------------------------------------------
// One resolver for typed and spoken commands.

/** A page context captured longer ago than this (client clock) is treated as unknown: Jarvis asks. */
export const CONTEXT_MAX_AGE_MS = 2 * 60_000;
/** A spoken command that arrives with no context may use the last one this same person sent, this long. */
export const CONTEXT_MEMORY_TTL_MS = 45_000;

export type CommandContext = {
  context: PageContext | null;
  /** "sent": the request's own; "remembered": this person's last one (spoken only); "stale": sent but too old, so dropped; "none". */
  from: "sent" | "remembered" | "stale" | "none";
  reference: Reference | null;
  resolution: Resolution | null;
};

/**
 * Typed and spoken commands both resolve their page words HERE: parse and bound what the client sent, drop
 * it if its capture time is too old (unknown → Jarvis asks), use the person's remembered context only when
 * nothing was sent and `allowMemory` (spoken), then resolve "this margin" / "the job" against it. Pure.
 */
export function resolveCommandContext(input: { utterance: string; pageContext?: unknown; remembered?: PageContext | null; allowMemory?: boolean; now?: number }): CommandContext {
  const now = input.now ?? Date.now();
  const reference = referenceIn(input.utterance);
  let context = parsePageContext(input.pageContext);
  let from: CommandContext["from"] = context ? "sent" : "none";
  if (context && typeof context.capturedAt === "number" && now - context.capturedAt > CONTEXT_MAX_AGE_MS) {
    context = null;
    from = "stale";
  }
  if (!context && from === "none" && input.allowMemory && input.remembered) {
    context = input.remembered;
    from = "remembered";
  }
  if (!reference) return { context, from, reference: null, resolution: null };
  const resolution = resolveReference(reference, context);
  if (resolution.kind === "none" && from === "stale")
    return { context, from, reference, resolution: { kind: "none", said: `What's on screen may be out of date, so I don't know which ${plural(reference.noun)} you mean. Which one?` } };
  return { context, from, reference, resolution };
}

/**
 * The last page context each verified person sent, bounded and short-lived. Never shared across people:
 * the key is the verified personId, so one founder's page can't answer for the other.
 */
export function createContextMemory(ttlMs = CONTEXT_MEMORY_TTL_MS, maxPeople = 16) {
  const seen = new Map<string, { ctx: PageContext; at: number }>();
  return {
    remember(personId: string, ctx: PageContext | null, now = Date.now()) {
      if (!ctx || !personId) return;
      seen.delete(personId);
      seen.set(personId, { ctx, at: now });
      while (seen.size > maxPeople) seen.delete(seen.keys().next().value as string);
    },
    recall(personId: string, now = Date.now()): PageContext | null {
      const hit = seen.get(personId);
      if (!hit) return null;
      if (now - hit.at > ttlMs) {
        seen.delete(personId);
        return null;
      }
      return hit.ctx;
    },
  };
}
