// Page context: ONE API that tells Jarvis/Jev what is on screen (Track 1, NEXUS-ADDENDUM item 2).
//
//   active page       path, destination and title (the shell sets it on every navigation)
//   selection         the selected client, package, lead or call, when a page has one
//   focused item      the row or card with keyboard focus / last opened
//   visible items     what the page is listing right now (so "that call" can be resolved or asked about)
//   data sources      each visible source with its honest state, source name and last success
//   current job       the job the Jarvis chip is following
//
// Pages publish with `publishPageContext(providerId, partial)` (or the React hook in
// src/components/shell/page-context.tsx). Readers call `readPageContext()` or `subscribePageContext()`;
// the snapshot is also on `window.__agenticPageContext.read()` for code outside the React tree, and a
// `page-context:change` event fires on every change.
//
// The rule: never invent context. `resolveReference("that call")` returns the ONE matching item when
// the page makes it unambiguous (a selection or focus of that kind, or exactly one visible item of that
// kind), otherwise `{ ok: false, ask }` with the question to ask, or `{ ok: false, unknown }` when no
// page has said anything. Pure module state: no React, importable by bun tests and the voice client.
import type { SourceState } from "./commands/types";

export const PAGE_CONTEXT_VERSION = 1 as const;

export type ContextItemKind = "client" | "package" | "lead" | "call" | "job" | "site" | "project" | "metric" | "approval" | "file";

export type ContextItem = {
  kind: ContextItemKind;
  id: string;
  /** What a person would call it ("Professional package", "Call 11:02 am from 04•• ••• 123"). Masked by the page. */
  label: string;
  /** Where it opens (an OS path), when it has its own view. */
  to?: string;
  search?: Record<string, string>;
  /** The element id on that page to scroll to and focus (e.g. the call's row). */
  focus?: string;
  /** Figures that describe it, label → value, with their source. For "explain this margin". */
  facts?: Record<string, string>;
  source?: string;
};

export type ContextDataSource = {
  id: string;
  label: string;
  state: SourceState;
  /** File, feed or endpoint the figures come from. */
  source: string;
  /** ISO time of the last successful read, or null when never. */
  lastSuccess: string | null;
  reason?: string;
};

export type ContextJob = { id: string; title: string; state: string; step?: string };

/** What one page (or shell part) contributes. Every field optional; later providers don't erase earlier ones' other fields. */
export type PageContextPart = {
  selection?: ContextItem | null;
  focused?: ContextItem | null;
  visible?: readonly ContextItem[];
  sources?: readonly ContextDataSource[];
  job?: ContextJob | null;
};

export type PageContextSnapshot = {
  version: typeof PAGE_CONTEXT_VERSION;
  page: { path: string; destination: string | null; title: string } | null;
  selection: ContextItem | null;
  focused: ContextItem | null;
  visible: readonly ContextItem[];
  sources: readonly ContextDataSource[];
  job: ContextJob | null;
  /** Which providers contributed (for the Inspector and for "no provider on this page"). */
  providers: readonly string[];
  at: number;
};

export type ReferenceResult =
  | { ok: true; item: ContextItem; how: "selection" | "focused" | "only-visible" }
  | { ok: false; ask: string; candidates: readonly ContextItem[] }
  | { ok: false; unknown: string };

// --- store ---------------------------------------------------------------------------------------------
let page: PageContextSnapshot["page"] = null;
const parts = new Map<string, PageContextPart>();
let job: ContextJob | null = null;
let version = 0;
let cached: PageContextSnapshot | null = null;
const listeners = new Set<(snapshot: PageContextSnapshot) => void>();

function changed() {
  version++;
  cached = null;
  const snap = readPageContext();
  for (const l of listeners) l(snap);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("page-context:change", { detail: { version } }));
}

/**
 * The shell calls this on every navigation. It does NOT clear other providers' parts: a page's part is
 * withdrawn when that page unmounts (usePageContext's cleanup), which is what keeps the context truthful.
 */
export function setActivePage(next: { path: string; destination: string | null; title: string }) {
  if (page && page.path === next.path && page.title === next.title && page.destination === next.destination) return;
  page = { ...next };
  changed();
}

/** Publish (replace) one provider's part. Pass null to withdraw it (on unmount). */
export function publishPageContext(providerId: string, part: PageContextPart | null) {
  if (part === null) {
    if (!parts.delete(providerId)) return;
  } else parts.set(providerId, part);
  changed();
}

/** The job the Jarvis chip follows (from src/lib/job-events.ts). */
export function setContextJob(next: ContextJob | null) {
  if (JSON.stringify(next) === JSON.stringify(job)) return;
  job = next;
  changed();
}

function dedupe(items: ContextItem[]) {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}:${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function readPageContext(now = Date.now()): PageContextSnapshot {
  if (cached) return cached;
  const all = [...parts.entries()];
  const last = <K extends keyof PageContextPart>(key: K) => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i][1][key] !== undefined) return all[i][1][key];
    return undefined;
  };
  cached = {
    version: PAGE_CONTEXT_VERSION,
    page,
    selection: (last("selection") as ContextItem | null | undefined) ?? null,
    focused: (last("focused") as ContextItem | null | undefined) ?? null,
    visible: dedupe(all.flatMap(([, p]) => [...(p.visible ?? [])])),
    sources: all.flatMap(([, p]) => [...(p.sources ?? [])]),
    job: (last("job") as ContextJob | null | undefined) ?? job,
    providers: all.map(([id]) => id),
    at: now,
  };
  return cached;
}

export function subscribePageContext(listener: (snapshot: PageContextSnapshot) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** For tests: forget everything. */
export function resetPageContext() {
  page = null;
  parts.clear();
  job = null;
  cached = null;
}

// --- references ("this", "that call") -----------------------------------------------------------------
const KIND_WORDS: Record<string, ContextItemKind> = {
  client: "client", clients: "client", customer: "client", practice: "client",
  package: "package", plan: "package", tier: "package", margin: "package",
  lead: "lead", prospect: "lead", business: "lead",
  call: "call", calls: "call", conversation: "call",
  job: "job", task: "job", run: "job",
  site: "site", website: "site",
  project: "project", repo: "project",
  number: "metric", figure: "metric", metric: "metric",
  approval: "approval", request: "approval",
  file: "file", document: "file", doc: "file",
};

/** "that call" → "call"; "this" → null (any kind); "the margin" → "package". */
export function referenceKind(noun: string | null | undefined): ContextItemKind | null {
  if (!noun) return null;
  const w = noun.toLowerCase().trim().split(/\s+/).pop() ?? "";
  return KIND_WORDS[w] ?? KIND_WORDS[w.replace(/s$/, "")] ?? null;
}

const plural = (kind: ContextItemKind | null) => (kind ? `${kind}s` : "items");

/**
 * What "this"/"that <noun>" means on the current page. Never guesses: several candidates → ask; nothing
 * published → unknown (Jarvis says the context is unknown and asks).
 */
export function resolveReference(noun: string | null, snapshot: PageContextSnapshot = readPageContext()): ReferenceResult {
  const kind = referenceKind(noun);
  if (noun && !kind && !/^(?:this|that|it|one|thing)$/i.test(noun.trim()))
    return { ok: false, unknown: `I don't know what "${noun}" refers to here.` };
  const fits = (i: ContextItem | null): i is ContextItem => !!i && (!kind || i.kind === kind);
  if (fits(snapshot.focused)) return { ok: true, item: snapshot.focused, how: "focused" };
  if (fits(snapshot.selection)) return { ok: true, item: snapshot.selection, how: "selection" };
  const visible = snapshot.visible.filter((i) => !kind || i.kind === kind);
  if (visible.length === 1) return { ok: true, item: visible[0], how: "only-visible" };
  const where = snapshot.page?.title ? ` on ${snapshot.page.title}` : "";
  if (visible.length > 1) {
    const names = visible.slice(0, 3).map((i) => i.label);
    return { ok: false, ask: `Which one? I can see ${visible.length} ${plural(kind)}${where}: ${names.join("; ")}${visible.length > 3 ? " …" : ""}.`, candidates: visible };
  }
  // (J4: it says what to do next, and never the word "that" for "it": the page hasn't published its items.)
  if (!snapshot.providers.length) return { ok: false, unknown: `I can't tell which ${kind ?? "item"} you mean, because this page hasn't told me what's on it. Say its name and I'll open it.` };
  return { ok: false, unknown: `I can't see any ${plural(kind)}${where}. Which ${kind ?? "item"} do you mean?` };
}

// --- a global handle for code outside the React tree (the voice client, the HUD window) -------------------
declare global {
  interface Window {
    __agenticPageContext?: { version: number; read: () => PageContextSnapshot; resolveReference: typeof resolveReference; subscribe: typeof subscribePageContext };
  }
}
// Always the latest module instance (a hot reload in development must not leave readers on a stale store).
if (typeof window !== "undefined")
  window.__agenticPageContext = { version: PAGE_CONTEXT_VERSION, read: () => readPageContext(), resolveReference, subscribe: subscribePageContext };
