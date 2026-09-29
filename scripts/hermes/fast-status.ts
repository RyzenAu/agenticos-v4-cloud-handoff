// Fast, spawn-free answers for the Hermes page (W-C, 29 Sep 2026), plus the parsers for the two
// Hermes CLI readouts that still need the CLI (they now run in the background; see last-known.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where Hermes keeps its state: $HERMES_HOME, else ~/.hermes (Hermes' own rule). */
export function hermesHomeDir(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = (env.HERMES_HOME ?? "").trim();
  return fromEnv || join(home, ".hermes");
}

const versionCache = new Map<string, { stamp: string; text: string | null }>();

/**
 * "Hermes Agent v0.21.3 (2026.9.14)" read from the installed package's hermes_cli/__init__.py, the
 * same values `hermes --version` prints, without starting Python (5.7 s on this PC, and the old
 * 800 ms timeout meant the page always fell back to a made-up "v0.13.0"). Null when not found.
 */
export function hermesVersionFromInstall(binPath: string | null, hermesHome: string): string | null {
  const candidates: string[] = [];
  if (binPath) {
    // <root>/bin/hermes(.exe) → <root>/hermes-agent/…; a venv script sits in <root>/venv/Scripts/.
    const binDir = dirname(binPath);
    candidates.push(join(dirname(binDir), "hermes-agent", "hermes_cli", "__init__.py"));
    candidates.push(join(dirname(dirname(binDir)), "hermes_cli", "__init__.py"));
  }
  candidates.push(join(hermesHome, "hermes-agent", "hermes_cli", "__init__.py"));
  for (const file of candidates) {
    let stamp: string;
    try {
      const s = statSync(file);
      stamp = `${s.size}:${s.mtimeMs}`;
    } catch {
      continue;
    }
    const cached = versionCache.get(file);
    if (cached && cached.stamp === stamp) return cached.text;
    let text: string | null = null;
    try {
      text = parseHermesVersionFile(readFileSync(file, "utf-8"));
    } catch {
      text = null;
    }
    versionCache.set(file, { stamp, text });
    if (text) return text;
  }
  return null;
}

/** `__version__ = "0.21.3"` + `__release_date__ = "2026.9.14"` → "Hermes Agent v0.21.3 (2026.9.14)". */
export function parseHermesVersionFile(source: string): string | null {
  const version = /^__version__\s*=\s*["']([^"']+)["']/m.exec(source)?.[1]?.trim();
  if (!version) return null;
  const released = /^__release_date__\s*=\s*["']([^"']+)["']/m.exec(source)?.[1]?.trim();
  return `Hermes Agent v${version}${released ? ` (${released})` : ""}`;
}

export type HermesProfileRow = {
  name: string;
  model: string | null;
  gateway: string | null;
  alias: string | null;
  distribution: string | null;
  active: boolean;
};

/** Rows of `hermes profile list` (Rich table; ◆ marks the sticky default). */
export function parseProfileList(raw: string): HermesProfileRow[] {
  const out: HermesProfileRow[] = [];
  for (const line of raw.split("\n")) {
    const clean = line.replace(/[┃│┏┓┗┛━─╇┡┩┛┃◇]/g, " ").trim();
    if (!clean) continue;
    if (/^Profile/i.test(clean) || /^[\s─━]+$/.test(clean) || /^Name\s+Model/i.test(clean)) continue;
    const cells = clean.split(/\s{2,}/).map((c) => c.trim());
    if (cells.length < 2) continue;
    let name = cells[0];
    const active = name.startsWith("◆") || name.startsWith("*");
    name = name.replace(/^[◆*]\s*/, "").trim();
    if (!name || /^[—-]+$/.test(name) || !/[a-z0-9_-]/i.test(name)) continue;
    const cell = (i: number) => (cells[i] && !/^[—-]+$/.test(cells[i]) ? cells[i] : null);
    out.push({ name, model: cell(1), gateway: cell(2), alias: cell(3), distribution: cell(4), active });
  }
  return out;
}

export type HermesMemoryProvider = { active: string | null; available: Array<{ name: string; needsKey: boolean }> };

/** `hermes memory status` → the active provider and the installable ones. */
export function parseMemoryStatus(raw: string): HermesMemoryProvider {
  let active: string | null = null;
  const available: HermesMemoryProvider["available"] = [];
  for (const line of raw.split("\n")) {
    const clean = line.trim();
    if (!clean) continue;
    const prov = clean.match(/^Provider:\s*([a-z0-9_-]+)/i);
    if (prov) active = prov[1] ?? null;
    const plugin = clean.match(/^[•·*]\s+([a-z0-9_-]+)\s*(?:\(([^)]+)\))?/i);
    if (plugin) {
      const meta = (plugin[2] ?? "").toLowerCase();
      if (plugin[1]) available.push({ name: plugin[1], needsKey: /(requires|needs)\s+api\s*key/.test(meta) || /api\s+key/.test(meta) });
    }
  }
  return { active, available };
}

/** config.yaml's external memory provider (`memory.provider`), read without starting Hermes. */
export function memoryProviderFromConfig(configYaml: string): string | null {
  const text = configYaml.replace(/\r\n/g, "\n");
  const block = /^memory:\s*\n((?:[ \t]+.*\n?)+)/m.exec(text)?.[1] ?? "";
  const provider = /^[ \t]+provider:\s*["']?([^"'\n#]+)/m.exec(block)?.[1]?.trim();
  return provider || null;
}

/** True when a file exists and is readable as text; "" otherwise. */
export function readTextOr(path: string, fallback = ""): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : fallback;
  } catch {
    return fallback;
  }
}
