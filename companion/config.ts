import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isPersonId, type PersonId } from "../scripts/devices/types";

/**
 * The companion's own pairing, kept on this PC only (the token is never printed). `roots`: the folders
 * file.open may open documents from (default: Documents\MU-Jarvis); set with --root at pair time or by
 * editing companion.json.
 */
export type CompanionConfig = { hubUrl: string; deviceId: string; owner: PersonId; label: string; token: string; expiresAt: number; pairedAt: number; roots?: string[] };

/** The default authorised folder for file.open: a dedicated one, never the whole profile. */
export function defaultRoots(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.USERPROFILE || homedir();
  return [join(home, "Documents", "MU-Jarvis")];
}

/**
 * An authorised root must be a specific folder: absolute, not a drive root, not the profile itself,
 * not Windows or Program Files. Returns the resolved path or why not. Pure (no disk access).
 */
export function checkRoot(value: string, env: Record<string, string | undefined> = process.env): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = String(value ?? "").trim();
  if (!raw || !isAbsolute(raw)) return { ok: false, reason: `"${raw}" isn't a full folder path (e.g. C:\\Users\\you\\Documents\\MU-Jarvis).` };
  const path = resolve(raw);
  const trim = (s: string) => s.toLowerCase().replace(/[\\/]+$/, "");
  const lower = trim(path);
  if (trim(parse(path).root) === lower) return { ok: false, reason: "A whole drive can't be an authorised folder." };
  if (lower === trim(env.USERPROFILE || homedir())) return { ok: false, reason: "Your whole user folder can't be an authorised folder; pick one folder inside it." };
  const system = [env.SystemRoot || "C:\\Windows", env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", env.ProgramData || "C:\\ProgramData"].map(trim);
  if (system.some((s) => lower === s || lower.startsWith(`${s}\\`) || lower.startsWith(`${s}/`))) return { ok: false, reason: "System folders can't be authorised." };
  return { ok: true, path };
}

/** The roots this companion uses: its config's (checked), else the default. */
export function rootsOf(config: Pick<CompanionConfig, "roots"> | null, env: Record<string, string | undefined> = process.env): string[] {
  const list = (config?.roots ?? []).map((r) => checkRoot(r, env)).filter((r): r is { ok: true; path: string } => r.ok).map((r) => r.path);
  return list.length ? list : defaultRoots(env);
}

export function configDir(override?: string) {
  if (override) return override;
  const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return join(base, "mu-companion");
}

export const configFile = (dir: string) => join(dir, "companion.json");
export const micLockFile = (dir: string) => join(dir, "mic.lock");

export function readConfig(dir: string): CompanionConfig | null {
  try {
    const c = JSON.parse(readFileSync(configFile(dir), "utf8"));
    if (typeof c?.hubUrl !== "string" || typeof c?.token !== "string" || typeof c?.deviceId !== "string" || !isPersonId(c?.owner)) return null;
    if (c.roots !== undefined && !(Array.isArray(c.roots) && c.roots.every((r: unknown) => typeof r === "string"))) delete c.roots;
    return c as CompanionConfig;
  } catch {
    return null;
  }
}

export function writeConfig(dir: string, config: CompanionConfig) {
  const file = configFile(dir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Only ever talk to the OS over the tailnet (https://<name>.ts.net, or a 100.x tailnet
 * address) or on this same PC. Anything else would send the device token somewhere public.
 */
export function checkHubUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const tailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.username || url.password) return { ok: false, reason: "No credentials in the address." };
  if (host.endsWith(".ts.net") && url.protocol === "https:") return { ok: true, url: url.origin };
  if ((loopback || tailnetIp) && (url.protocol === "http:" || url.protocol === "https:")) return { ok: true, url: url.origin };
  return { ok: false, reason: "Use the OS's Tailscale address, e.g. https://desktop-xxxx.tailxxxx.ts.net:8443" };
}
