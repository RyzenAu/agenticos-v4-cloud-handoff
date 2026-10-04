/**
 * "Switch back to the website we were using", "go back to that page", "back to PowerPoint" (round 3).
 *
 * The sibling of context.ts for what is ON A DEVICE rather than on an OS page, with the same shape and rules: a deictic phrase names a
 * kind, candidates are searched, exactly one resolves, several ask (never guess), none says so. The memory is fed ONLY from verified
 * steps the hub already recorded for that person on that device (the executor result's url / title / app / window handle / tab id),
 * is kept per person AND device (never another person's, never another device's), and expires. Deterministic; no model.
 */
import { siteWindowMatches } from "../executors/desktop";
import { allowListedApp, APP_LAUNCH } from "../executors/windows";

export type Target = { kind: "site" | "app"; title: string; url?: string; app?: string; handle?: number; targetId?: string; at: number };

const TTL_MS = 30 * 60_000;
const MAX = 12;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

/** A verified executor result's data as a target, or null. Pure. */
export function targetFrom(executor: string, data: Record<string, unknown> | undefined, at: number): Target | null {
  if (!data) return null;
  const str = (v: unknown, n = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  if (executor === "browser.navigate" || executor === "screen.goal") {
    const url = str(data.finalUrl ?? data.url, 300);
    if (!url || !/^https?:/i.test(url)) return null;
    return { kind: "site", title: str(data.title) ?? hostOf(url), url, ...(str(data.targetId, 64) ? { targetId: str(data.targetId, 64) } : {}), at };
  }
  if (executor === "app.open" || executor === "app.focus") {
    const app = str(data.app, 40);
    if (!app || !allowListedApp(app)) return null;
    return { kind: "app", title: str(data.title) ?? app, app, ...(typeof data.handle === "number" ? { handle: data.handle } : {}), at };
  }
  return null;
}

export function createRecentTargets(now: () => number = Date.now) {
  const store = new Map<string, Target[]>();
  const key = (person: string, device: string) => `${person}|${device}`;
  return {
    record(person: string, device: string, t: Target) {
      const k = key(person, device);
      const same = (x: Target) => (t.kind === "site" ? x.kind === "site" && hostOf(x.url) + new URL(x.url ?? "http://x/").pathname === hostOf(t.url) + new URL(t.url ?? "http://x/").pathname : x.kind === "app" && x.app === t.app);
      const list = [t, ...(store.get(k) ?? []).filter((x) => !same(x))].slice(0, MAX);
      store.set(k, list);
      if (store.size > 64) store.delete(store.keys().next().value as string);
    },
    /** Drop a target whose tab is gone (so it is not offered again). */
    forget(person: string, device: string, targetId: string) {
      const k = key(person, device);
      store.set(k, (store.get(k) ?? []).filter((t) => t.targetId !== targetId));
    },
    /** Newest first; only this person's targets on this device, only the fresh ones. */
    list(person: string, device: string): Target[] {
      return (store.get(key(person, device)) ?? []).filter((t) => now() - t.at <= TTL_MS);
    },
  };
}
export type RecentTargets = ReturnType<typeof createRecentTargets>;

export type SwitchRef = { kind: "site" | "app" | "any"; app?: string; words: string[]; said: string };
const FILLER = new Set(["the", "that", "this", "those", "we", "were", "was", "i", "using", "on", "a", "an", "our", "my", "last", "previous", "earlier", "before", "one", "looking", "at", "working", "in", "from", "just", "it", "to"]);

/** "switch back to the website we were using" / "go back to that page" / "back to PowerPoint" → what is meant, or null. Pure. */
export function switchBackIn(utterance: string): SwitchRef | null {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  const m = /^(?:(?:hey )?jarvis,?\s+)?(?:please\s+)?(?:(?:switch|go|get|come|jump|flip)\s+back(?:\s+over)?\s+to|back\s+to|return\s+to)\s+(.+)$/i.exec(t);
  if (!m) return null;
  const rest = m[1].trim();
  // A song or a track is the music skill's, a slide or a step is something else: only sites, pages, tabs, windows and apps.
  if (/\b(?:song|track|video|slide|step|previous\s+(?:song|track)|beginning|top|start)\b/i.test(rest)) return null;
  const words = norm(rest).replace(/[^a-z0-9 .]/g, " ").split(" ").filter((w) => w && !FILLER.has(w));
  const siteWord = /\b(?:website|web ?site|site|page|web ?page|tab|browser)\b/i.test(rest);
  const windowWord = /\b(?:window|thing|screen)\b/i.test(rest);
  const generic = new Set(["website", "site", "page", "webpage", "tab", "browser", "window", "thing", "screen", "web"]);
  const content = words.filter((w) => !generic.has(w));
  if (siteWord) return { kind: "site", words: content, said: rest };
  if (windowWord && !content.length) return { kind: "any", words: [], said: rest };
  const app = allowListedApp(rest.replace(/^(?:the|that|my)\s+/i, "").replace(/\s+(?:app|window|program)$/i, ""));
  if (app) return { kind: "app", app, words: [], said: rest };
  return null;
}

export type SwitchResolution = { kind: "resolved"; target: Target } | { kind: "ambiguous"; options: Target[] } | { kind: "none"; why: "nothing-recent" | "only-current" | "no-match" };

/** Pick the most recent matching target that is not what is in front now; several distinct ones the words don't separate → ambiguous. Pure. */
export function resolveSwitch(ref: SwitchRef, targets: Target[], front: { process: string; title: string } | null): SwitchResolution {
  let list = targets.filter((t) => (ref.kind === "any" ? true : t.kind === ref.kind));
  if (ref.kind === "app") list = list.filter((t) => t.app === ref.app);
  if (!list.length) return { kind: "none", why: "nothing-recent" };
  const isFront = (t: Target) => {
    if (!front) return false;
    if (t.kind === "app") return !!t.app && !!APP_LAUNCH[t.app] && APP_LAUNCH[t.app].match({ handle: 0, cls: "", process: front.process, title: front.title });
    if (!/^(?:chrome|msedge|firefox|brave|opera|vivaldi)$/i.test(front.process)) return false;
    return siteWindowMatches(front.title, t.title, hostOf(t.url));
  };
  list = list.filter((t) => !isFront(t));
  if (!list.length) return { kind: "none", why: "only-current" };
  if (ref.words.length) {
    const hit = list.filter((t) => ref.words.some((w) => norm(`${t.title} ${hostOf(t.url)} ${t.app ?? ""}`).includes(w)));
    if (!hit.length) return { kind: "none", why: "no-match" };
    list = hit;
  }
  if (list.length === 1) return { kind: "resolved", target: list[0] };
  // "the page we were using" with several recent: the most recent only if the rest are the same site; otherwise ask.
  const distinct = list.filter((t, i) => list.findIndex((u) => (t.kind === "site" ? hostOf(u.url) === hostOf(t.url) : u.app === t.app) && u.kind === t.kind) === i);
  return distinct.length === 1 ? { kind: "resolved", target: distinct[0] } : { kind: "ambiguous", options: distinct.slice(0, 3) };
}
