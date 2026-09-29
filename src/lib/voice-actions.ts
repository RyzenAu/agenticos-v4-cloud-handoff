import { DESTINATIONS } from "../components/shell/destinations";

// Every OS destination and drilldown is a voice destination too (AUDIT-F4 F3: Today, Jarvis, Receptionist,
// Work, Finance, Studio, System, Operations and Models were unreachable). Built from the shell's list, so a
// new page can't be forgotten here.
const SHELL_PAGES: readonly { path: string; label: string }[] = [
  ...DESTINATIONS.flatMap((d) => [{ path: d.to, label: d.label }, ...d.drilldowns.filter((dd) => !dd.view).map((dd) => ({ path: dd.to, label: dd.label }))]),
  { path: "/setup", label: "Setup" },
  // The three workspaces (src/components/workspace/three-workspaces.tsx): nameable by voice.
  { path: "/workspaces/mu-ventures", label: "M&U Ventures workspace" },
  { path: "/workspaces/receptionist", label: "Receptionist workspace" },
  { path: "/workspaces/websites", label: "Websites workspace" },
  // Today merged into Home (29 Sep 2026); the old path still redirects, so a stale reference still lands.
  { path: "/today", label: "Home" },
];
/**
 * The name Jarvis says for a page is the shell's own label (src/components/shell/destinations.ts is the single
 * source: J4, "Home" for /business, not "Dashboard"; "Websites"; "Knowledge graph"). The hand-written entries keep
 * their spoken synonyms (`match`) only; a path the shell doesn't list falls back to the hand-written label.
 */
const shellLabel = (path: string, fallback: string) => SHELL_PAGES.find((p) => p.path === path)?.label ?? fallback;
export const VOICE_PAGES = [
  { path: "/business", label: shellLabel("/business", "Home"), match: /dashboard|business|revenue|cash.?flow|overview/i },
  { path: "/inbox", label: shellLabel("/inbox", "Inbox"), match: /inbox|email|messages/i },
  { path: "/calendar", label: shellLabel("/calendar", "Calendar"), match: /calendar|schedule|meetings/i },
  { path: "/memory", label: shellLabel("/memory", "Memory"), match: /memor(?:y|ies)|brain|cortex/i },
  { path: "/design", label: shellLabel("/design", "Design"), match: /design/i },
  { path: "/motion", label: shellLabel("/motion", "Motion Library"), match: /motion|animation/i },
  { path: "/websites", label: shellLabel("/websites", "Websites"), match: /website/i },
  { path: "/agents/hermes", label: shellLabel("/agents/hermes", "Hermes"), match: /hermes/i },
  { path: "/settings", label: shellLabel("/settings", "Settings"), match: /settings|connections/i },
  { path: "/chat", label: shellLabel("/chat", "Chat"), match: /chat/i },
  { path: "/codegraph", label: shellLabel("/codegraph", "Knowledge graph"), match: /codebase|code.?graph|knowledge graph/i },
  { path: "/coding", label: shellLabel("/coding", "Coding"), match: /\bcoding\b/i },
  { path: "/leads", label: shellLabel("/leads", "Leads"), match: /\bleads?\b|\bcrm\b|call list/i },
  { path: "/dashboard", label: shellLabel("/dashboard", "Mission Control"), match: /mission control/i },
];

/** Query parameters a voice or typed navigation may carry, per page. Anything else is refused. */
const ALLOWED_SEARCH: Record<string, Record<string, RegExp>> = {
  "/today": { scene: /^1$/ },
  "/operations": { package: /^receptionist-(?:essential|professional|premium)$/ },
  "/business": { view: /^(?:finance|progress)$/, scene: /^1$/ },
  "/leads": { lead: /^\d{1,9}$/ },
};

export type VoiceDestination = { path: string; label: string; search?: Record<string, string> };

/** An exact internal page (optionally with an allowed query), or undefined. Never an external URL. */
export function voiceDestination(path: unknown): VoiceDestination | undefined {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#") || path.includes("..")) return undefined;
  const [bare, query] = path.split("?", 2) as [string, string | undefined];
  const page = VOICE_PAGES.find((p) => p.path === bare) ?? SHELL_PAGES.find((p) => p.path === bare);
  if (!page) return undefined;
  if (query === undefined) return { path: page.path, label: page.label };
  const allowed = ALLOWED_SEARCH[bare];
  if (!allowed) return undefined;
  const search: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) {
    if (!allowed[k]?.test(v)) return undefined;
    search[k] = v;
  }
  // A Business tab ("/business?view=finance") is named the way the shell names it ("Finances", "Goals"), not "Home".
  const tab = search.view ? DESTINATIONS.flatMap((d) => d.drilldowns).find((dd) => dd.to === bare && dd.view === search.view) : undefined;
  return { path: page.path, label: tab?.label ?? page.label, search };
}

/** A section id the navigation may scroll to ("rx-flagged-calls"). */
export function voiceFocus(focus: unknown): string | undefined {
  return typeof focus === "string" && /^[a-z][a-z0-9-]{1,60}$/.test(focus) ? focus : undefined;
}
export function voiceIntent(
  text: string,
): { kind: "navigate"; path: string } | { kind: "memory"; query: string } | { kind: "ask" } {
  const q = text.trim().replace(/^jarvis[,\s]+/i, "");
  const memory = q.match(
    /^(?:find|search|show(?: me)?|pull up|bring up)(?: my| the)? (?:memories|memory|notes)(?: about| on| for)?\s+(.+)$/i,
  );
  if (memory) return { kind: "memory", query: memory[1].trim() };
  if (/^(?:open|go to|take me to|show me|navigate to)\b/i.test(q)) {
    const page = VOICE_PAGES.find((p) => p.match.test(q));
    if (page) return { kind: "navigate", path: page.path };
  }
  return { kind: "ask" };
}
