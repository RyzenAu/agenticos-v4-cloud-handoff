// Where Jarvis's file routes may work: his home folders (Downloads, Desktop, Documents, Pictures)
// and the scratch root D:\tmp. Everything else is refused. A place is written "Downloads/x/y" or
// "D:/tmp/x/y" (forward slashes, no ".."), and resolved to a real path only under its root.
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export const WORK_ROOT = "D:\\tmp";
const HOME: Record<string, string> = { downloads: "Downloads", desktop: "Desktop", documents: "Documents", pictures: "Pictures", photos: "Pictures", screenshots: "Pictures/Screenshots" };
const SEG = /^[\w][\w .()&+,'-]{0,80}$/;
/** A valid place string (for request validation). Pure. */
export const PLACE = /^(?:(?:Downloads|Desktop|Documents|Pictures)|D:\/tmp)(?:\/[\w][\w .()&+,'-]{0,80})*$/;
export const isPlace = (v: unknown): v is string => typeof v === "string" && PLACE.test(v) && !v.split("/").some((s) => /^\.+$/.test(s));

/**
 * "the jarvis-suite-files folder in my Downloads" → "Downloads/jarvis-suite-files"; "my Documents" →
 * "Documents"; "D:\tmp\jarvis-suite\files" → "D:/tmp/jarvis-suite/files"; a bare name → a sub-folder
 * of Downloads. Null for anything else. Pure.
 */
export function placeFromWords(words: string): string | null {
  const w = words.trim().replace(/^(?:the|my)\s+/i, "").replace(/\s+folder\b/gi, "").replace(/[.,!?]+$/, "").replace(/\s+/g, " ").trim();
  const abs = w.match(/^d:[\\/]+tmp((?:[\\/]+[^\\/]+)*)[\\/]*$/i);
  if (abs) {
    const segs = abs[1].split(/[\\/]+/).filter(Boolean);
    return segs.every((s) => SEG.test(s) && !/^\.+$/.test(s)) ? ["D:/tmp", ...segs].join("/") : null;
  }
  const parts = w.split(/\s+(?:in|inside|on|from)\s+(?:my\s+|the\s+)?/i);
  const lastWords = parts[parts.length - 1];
  const last = HOME[lastWords.toLowerCase()] ?? (/^d:[\\/]+tmp/i.test(lastWords) ? placeFromWords(lastWords) : null);
  if (parts.length === 1) return last ?? (SEG.test(w) ? `Downloads/${w}` : null);
  const sub = parts.slice(0, -1).join(" ").trim();
  return last && SEG.test(sub) ? `${last}/${sub}` : null;
}

/** A place → its real path, only under its root (null otherwise). */
export function resolvePlace(place: string, home = homedir(), workRoot = WORK_ROOT): string | null {
  if (!isPlace(place)) return null;
  const [root, ...rest] = place.startsWith("D:/tmp") ? [resolve(workRoot), ...place.slice(7).split("/").filter(Boolean)] : [resolve(home), ...place.split("/")];
  const p = resolve(root, ...rest);
  return p === root || p.startsWith(root + sep) ? p : null;
}
/** "Downloads > x" or "D:\tmp\x" for speech. */
export const spokenPlace = (place: string) => (place.startsWith("D:/tmp") ? place.replace(/\//g, "\\") : place.replace(/\//g, " > "));
