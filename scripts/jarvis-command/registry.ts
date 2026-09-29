/**
 * The destination registry adapter (NEXUS-ADDENDUM §1). Track 1 owns the ONE command/destination
 * registry (f/t1-experience-20260928); until its head is published the command path uses this small
 * built-in one through the same `DestinationRegistry` interface (contracts.ts), and swaps it at merge.
 *
 * Built in: the OS's own pages, the apps the executors allow-list, and a few public websites. Pure.
 */
import type { Destination, DestinationRegistry } from "./contracts";

type Entry = Omit<Destination, "score"> & { words: string[] };

const PAGES: Array<[string, string, string[]]> = [
  ["/operations", "Operations", ["operations", "ops", "margins", "packages", "pricing"]],
  ["/receptionist", "Receptionist", ["receptionist", "calls", "flagged calls", "bookings"]],
  ["/leads", "Leads", ["leads", "lead engine", "crm", "prospects"]],
  ["/finance", "Finance", ["finance", "money page", "ledger", "invoices"]],
  ["/memory", "Memory", ["memory", "hindsight", "vault"]],
  ["/work", "Work", ["work", "jobs", "job log", "activity"]],
  ["/inbox", "Inbox", ["inbox", "email", "emails", "mail"]],
  ["/calendar", "Calendar", ["calendar", "schedule"]],
  ["/business", "Business", ["business", "business dashboard"]],
  ["/chat", "Chat", ["chat"]],
  ["/websites", "Websites", ["websites", "sites"]],
  ["/settings", "Settings", ["settings", "preferences"]],
  ["/agents/hermes", "Hermes", ["hermes"]],
  ["/today", "Today", ["today", "home", "dashboard"]],
];

/** The apps the executors will launch (scripts/executors + pc-hands). Anything else is refused. */
export const APP_ALLOW_LIST: Record<string, string[]> = {
  notepad: ["notepad"],
  calculator: ["calculator", "calc"],
  powerpoint: ["powerpoint", "power point", "ppt"],
  excel: ["excel"],
  word: ["word", "microsoft word"],
  chrome: ["chrome", "google chrome"],
  edge: ["edge", "microsoft edge"],
  explorer: ["file explorer", "explorer", "files"],
  "vs code": ["vs code", "vscode", "visual studio code"],
  paint: ["paint", "ms paint"],
};

const SITES: Array<[string, string, string[]]> = [
  ["https://www.youtube.com/", "YouTube", ["youtube", "yt"]],
  ["https://example.com/", "example.com", ["example.com", "example dot com"]],
  ["https://www.google.com/", "Google", ["google"]],
];

const ENTRIES: Entry[] = [
  ...PAGES.map(([ref, label, words]) => ({ id: `page:${ref}`, kind: "os-page" as const, label, ref, deviceAction: false, words })),
  ...Object.entries(APP_ALLOW_LIST).map(([name, words]) => ({ id: `app:${name}`, kind: "app" as const, label: name, ref: name, deviceAction: true, words })),
  ...SITES.map(([ref, label, words]) => ({ id: `site:${label}`, kind: "website" as const, label, ref, deviceAction: true, words })),
];

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim()} `;

export function builtinRegistry(extra: Entry[] = []): DestinationRegistry {
  const all = [...ENTRIES, ...extra];
  return {
    resolve(text: string) {
      const t = norm(text);
      const out: Destination[] = [];
      for (const e of all) {
        const hit = e.words.filter((w) => t.includes(norm(w))).sort((a, b) => b.length - a.length)[0];
        if (hit) out.push({ id: e.id, kind: e.kind, label: e.label, ref: e.ref, deviceAction: e.deviceAction, score: Math.min(1, 0.6 + hit.length / 40) });
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };
}

/** "open notepad" / "launch power point" → the allow-listed app name, else null. Pure. */
export function appNameIn(text: string): string | null {
  const m = /\b(?:open|launch|start|fire up|bring up|run)\s+(?:up\s+)?(?:the\s+|a\s+new\s+|a\s+)?([a-z][a-z .]{1,30}?)(?=$|[?.!,]|\s+(?:and|then|app|on|here|please|for)\b)/i.exec(text);
  if (!m) return null;
  const said = norm(m[1]);
  for (const [name, words] of Object.entries(APP_ALLOW_LIST)) if (words.some((w) => norm(w) === said)) return name;
  return null;
}
