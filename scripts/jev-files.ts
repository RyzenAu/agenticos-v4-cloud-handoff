/**
 * "Open the file quarterly-plan" (Wave 2, 27 Sep 2026): find an authorised document by name and open it
 * in its default app, then check a window for it actually appeared. Deterministic: Jev (or rules) only
 * routes here; the search is a bounded file-name walk (names only, never contents).
 *
 * Fences, in code: only authorised roots (default D:\tmp\jarvis-acceptance; JARVIS_FILE_ROOTS adds more,
 * ;-separated); secret-bearing names (.env, keys, tokens, credentials) are never matched or opened;
 * executables and scripts are never opened; several matches → he is asked which, nothing is guessed.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import { SECRET_BEARING } from "../src/lib/control-risk";

export const DEFAULT_FILE_ROOTS = ["D:\\tmp\\jarvis-acceptance"];
export function fileRoots(env: Record<string, string | undefined> = process.env): string[] {
  return [...DEFAULT_FILE_ROOTS, ...(env.JARVIS_FILE_ROOTS ?? "").split(";").map((s) => s.trim()).filter(Boolean)].map((r) => resolvePath(r));
}
/** Never opened, whatever the name: programs, scripts, shortcuts, installers. */
export const NEVER_OPEN = /\.(?:exe|com|bat|cmd|ps1|psm1|vbs|js|jse|wsf|msi|msix|appx|scr|lnk|reg|hta|cpl|jar|py|sh)$/i;

export const OPEN_FILE = /\b(?:open|show|pull up|bring up|find)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:file|document|doc|spreadsheet|sheet|deck|pdf|note|notes)\s+(?:called\s+|named\s+)?["“']?([\w .()&+-]{2,80}?)["”']?(?=$|[?.!,]|\s+(?:please|for me|in\b))/i;

/** The file name his words ask for, or null. Pure. */
export function fileNameIn(text: string): string | null {
  return OPEN_FILE.exec(text)?.[1]?.trim() ?? null;
}

const words = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").split(/[^a-z0-9]+/).filter(Boolean);

/** Files under the roots whose name matches: exact name, same stem, or every word of his name. Bounded. */
export function findFiles(name: string, roots: string[] = fileRoots(), limits = { depth: 5, entries: 6000 }): string[] {
  const want = name.trim().toLowerCase();
  const wantWords = words(want);
  if (!wantWords.length || SECRET_BEARING.test(name)) return [];
  const exact: string[] = [], stem: string[] = [], loose: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > limits.depth || seen > limits.entries) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > limits.entries) return;
      if (entry.startsWith(".") || entry === "node_modules" || entry === "profile") continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (NEVER_OPEN.test(entry) || SECRET_BEARING.test(full)) continue;
      const lower = entry.toLowerCase();
      if (lower === want) exact.push(full);
      else if (lower.replace(/\.[a-z0-9]{1,5}$/, "") === want.replace(/\.[a-z0-9]{1,5}$/, "")) stem.push(full);
      else if (wantWords.every((w) => words(lower).includes(w))) loose.push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return exact.length ? exact : stem.length ? stem : loose;
}

export type OpenFileResult = { ok: boolean; said: string; path?: string; matches?: number; window?: string; ask?: boolean };
export type FileDeps = {
  roots?: string[];
  open(path: string): Promise<void>;
  /** Titles of the windows on screen now (for the check). */
  titles(): Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
};

/** Find by name, open with the default app, and confirm a window for it appeared. Never throws. */
export async function openFileByName(name: string, deps: FileDeps): Promise<OpenFileResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (SECRET_BEARING.test(name)) return { ok: false, said: "That name looks like a secret-bearing file, which I never open." };
  const matches = findFiles(name, deps.roots ?? fileRoots());
  if (!matches.length) return { ok: false, said: `I couldn't find a file called ${name} in the folders I'm allowed to use.`, matches: 0 };
  if (matches.length > 1) return { ok: false, ask: true, said: `${matches.length} files match "${name}": ${matches.slice(0, 3).map((m) => basename(m)).join(", ")}${matches.length > 3 ? "…" : ""}. Which one?`, matches: matches.length };
  const path = matches[0];
  const before = new Set(await deps.titles().catch(() => [] as string[]));
  try {
    await deps.open(path);
  } catch (error) {
    return { ok: false, said: `Windows wouldn't open ${basename(path)} (${(error as Error).message.slice(0, 80)}).`, path };
  }
  const stem = basename(path, extname(path)).toLowerCase();
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const titles = await deps.titles().catch(() => [] as string[]);
    const hit = titles.find((t) => t.toLowerCase().includes(stem) && (!before.has(t) || i > 5));
    if (hit) return { ok: true, said: `Opened ${basename(path)}.`, path, matches: 1, window: hit };
  }
  return { ok: false, said: `I asked Windows to open ${basename(path)}, but no window for it showed up, so I can't say it opened.`, path, matches: 1 };
}
