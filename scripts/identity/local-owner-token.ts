import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { safeEqual } from "./principal";

/**
 * The local-owner proof (MU_HUB_ROLE=server only).
 *
 * On a headless server any local process can reach 127.0.0.1, and with WSL mirrored networking so can every Linux user
 * of the bot desktops. So in the server role a loopback request is the loopback owner ONLY when it carries this
 * secret: a random token the hub creates at startup, in a file under the data directory that only the hub's account,
 * SYSTEM and Administrators can read (Windows: ACL with inheritance removed; POSIX: mode 0600). WSL users cannot read
 * Windows files (interop and automount are off on Ryzen-PC), so they cannot present it.
 *
 * Presented as `Authorization: Bearer <token>` (what Hermes sends for an OpenAI-compatible provider's api_key) or
 * `X-MU-Local-Owner: <token>`. Compared in constant time. The gate strips both before any handler runs. The value is
 * never logged, never in a response, never in /__health: callers get the FILE PATH (see the CLI below).
 *
 * pc and cloud never create or read this file; the helpers below are inert there.
 */

export const LOCAL_OWNER_HEADER = "x-mu-local-owner";
export const LOCAL_OWNER_TOKEN_FILE = "local-owner.token";
const VALID = /^[A-Za-z0-9_-]{43,128}$/;

type Env = Record<string, string | undefined>;

/** Where the token lives: MU_LOCAL_OWNER_TOKEN_FILE, else <data dir>/local-owner.token. */
export function localOwnerTokenPath(root: string, env: Env = process.env): string {
  const override = (env.MU_LOCAL_OWNER_TOKEN_FILE ?? "").trim();
  return override ? resolve(override) : join(dataDirFor(root, env), LOCAL_OWNER_TOKEN_FILE);
}

/** The repo root this script lives under (scripts/identity/ -> ../..), the same root vite.config.ts uses. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Restrict a file to the current account, SYSTEM and Administrators. Throws when it cannot (fail closed). */
function restrict(file: string) {
  if (process.platform !== "win32") {
    chmodSync(file, 0o600);
    return;
  }
  // Absolute paths: a Git-for-Windows PATH shadows whoami with a coreutils one that takes different arguments.
  const sys32 = system32();
  const who = spawnSync(join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(String(who.stdout ?? "").trim())?.[1];
  if (!sid) throw new Error("local-owner token: could not work out the current account to restrict the token file to.");
  const r = spawnSync(join(sys32, "icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`local-owner token: icacls could not restrict the token file (exit ${r.status}).`);
}

const system32 = () => join(process.env.SystemRoot || "C:\\Windows", "System32");

/** The file's DACL as icacls prints it, path removed, one normalised line per ACE, sorted. Null when unreadable. */
function aclFingerprint(file: string): string | null {
  const r = spawnSync(join(system32(), "icacls.exe"), [file], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const lines = String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.replace(file, "").trim())
    .filter((l) => l && !/^Successfully processed/i.test(l));
  return lines.map((l) => l.toLowerCase()).sort().join("\n");
}

/**
 * Is this file protected exactly as restrict() leaves a fresh one: ONLY the current account, SYSTEM and Administrators
 * (Full), inheritance off, no other ACE? Windows: its DACL must equal, entry for entry, the DACL of a freshly restricted
 * reference file made next to it (so names resolve the same way in any language). POSIX: mode 0600 and ours.
 */
/** The file's OWNER on Windows (PowerShell Get-Acl; the path goes in an environment variable, never parsed as script). Null when unreadable. */
function windowsOwner(file: string): string | null {
  const r = spawnSync(join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:MU_OWNER_PROBE).Owner"], { encoding: "utf8", windowsHide: true, env: { ...process.env, MU_OWNER_PROBE: file } });
  const owner = String(r.stdout ?? "").trim();
  return r.status === 0 && owner ? owner : null;
}

/** Who may own the token file: the account that makes files here (a fresh reference file's owner), or Administrators or SYSTEM. */
function ownerAcceptable(owner: string | null, referenceOwner: string | null): boolean {
  if (!owner) return false;
  if (referenceOwner && owner.toLowerCase() === referenceOwner.toLowerCase()) return true;
  return /(?:^|\\)(?:administrators|system)$/i.test(owner);
}

/**
 * Is this file protected exactly as restrict() leaves a fresh one AND owned by the hub's account (or Administrators/SYSTEM)?
 * Windows: its DACL must equal, entry for entry, the DACL of a freshly restricted reference file made next to it (so names
 * resolve the same way in any language), inheritance off, and its owner is the reference file's owner or Administrators or
 * SYSTEM. POSIX: mode 0600 and owned by this account. `ownerOf` is for tests.
 */
export function tokenFileProtected(file: string, probes: { ownerOf?: (path: string) => string | null } = {}): boolean {
  try {
    if (process.platform !== "win32") {
      const st = statSync(file);
      return (st.mode & 0o777) === 0o600 && (typeof process.getuid !== "function" || st.uid === process.getuid());
    }
    const reference = join(dirname(file), `.local-owner-ref-${randomBytes(6).toString("hex")}.tmp`);
    closeSync(openSync(reference, "w"));
    try {
      restrict(reference);
      const want = aclFingerprint(reference);
      const have = aclFingerprint(file);
      if (!(want !== null && want === have && !/\(i\)/i.test(have ?? ""))) return false;
      const ownerOf = probes.ownerOf ?? windowsOwner;
      return ownerAcceptable(ownerOf(file), ownerOf(reference));
    } finally {
      rmSync(reference, { force: true });
    }
  } catch {
    return false;
  }
}

/**
 * Create the token file when it is missing or unusable. An EXISTING file is trusted only if its protection is exactly
 * right (tokenFileProtected); otherwise (planted, copied, inherited a wider ACL, wrong mode) it is replaced with a NEW
 * random value and the correct protection, and the rotation is logged without the value. A correctly protected token is
 * never rotated on a restart (Hermes stores the value as an api_key). Returns the path, never the value.
 *
 * A new file is made as a restricted temp file in the same folder (empty, restricted, then given the secret) and renamed
 * into place, so the secret is never on disk under the folder's ACL and a planted file or link at the final name is
 * replaced rather than written through.
 */
export function ensureLocalOwnerToken(root: string, env: Env = process.env): string {
  const file = localOwnerTokenPath(root, env);
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch {
    /* missing: create it below */
  }
  if (existing !== null) {
    if (VALID.test(existing) && tokenFileProtected(file)) return file;
    if (existing.length > 0) console.warn("local-owner token rotated: permissions were wrong or the file was unusable");
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${LOCAL_OWNER_TOKEN_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    closeSync(openSync(temp, "wx", 0o600));
    restrict(temp);
    writeFileSync(temp, randomBytes(32).toString("base64url"), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (!tokenFileProtected(file)) throw new Error("local-owner token: the token file is not protected as required after creation.");
  return file;
}

/**
 * Write a secret file that is protected from its first byte (the same protection as the local-owner token): an empty restricted
 * temp file in the same folder, then the secret, then a rename into place. For other long-lived local secrets (the Telegram relay
 * bearer, the Jev shim key): `mode: 0o600` does nothing on Windows, where the file would inherit the folder's ACL.
 */
export function writeProtectedSecret(file: string, value: string) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    closeSync(openSync(temp, "wx", 0o600));
    restrict(temp);
    writeFileSync(temp, value, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Tighten an EXISTING secret file in place (same value, correct protection). Returns true when it had to change anything. */
export function tightenSecret(file: string): boolean {
  if (tokenFileProtected(file)) return false;
  restrict(file);
  return true;
}

export type LocalOwnerProof = {
  /** Does this request carry the current token? Strips both carrier headers either way. */
  check(req: { headers?: Record<string, string | string[] | undefined> }): boolean;
  /** The same answer without touching the request (for a middleware that runs before the gate and must leave the headers for it). */
  peek(req: { headers?: Record<string, string | string[] | undefined> }): boolean;
  path: string;
};

/** The hub's checker: creates the file at startup, re-reads it when it changes (rotation revokes the old value). */
export function createLocalOwnerProof(root: string, env: Env = process.env): LocalOwnerProof {
  const path = ensureLocalOwnerToken(root, env);
  let stamp = "";
  let token = "";
  let warned = "";
  const current = () => {
    try {
      const s = statSync(path);
      // ctime moves when the owner or the ACL changes, not only when the content does.
      const key = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      if (key !== stamp) {
        const text = readFileSync(path, "utf8").trim();
        // Whenever the file changes it is re-verified like a fresh start: protection AND owner. A file that is not protected
        // exactly is no proof at all (a change by someone who could not have written it is the thing being guarded against).
        if (!tokenFileProtected(path)) {
          token = "";
          if (warned !== key) console.warn("local-owner token ignored: the token file changed and its permissions or owner are wrong (restart the hub to rotate it)");
          warned = key;
        } else token = VALID.test(text) ? text : "";
        stamp = key;
      }
    } catch {
      token = "";
      stamp = "";
    }
    return token;
  };
  const matches = (headers: Record<string, string | string[] | undefined>) => {
    const want = current();
    const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? "").trim())?.[1]?.trim() ?? "";
    const header = String(Array.isArray(headers[LOCAL_OWNER_HEADER]) ? (headers[LOCAL_OWNER_HEADER] as string[])[0] : headers[LOCAL_OWNER_HEADER] ?? "").trim();
    return { viaBearer: !!want && !!bearer && safeEqual(bearer, want), viaHeader: !!want && !!header && safeEqual(header, want) };
  };
  return {
    path,
    peek(req) {
      const m = matches(req.headers ?? {});
      return m.viaBearer || m.viaHeader;
    },
    check(req) {
      const headers = req.headers ?? {};
      const m = matches(headers);
      // Never let the secret, or a wrong guess at it, reach a handler (a bridge would forward Authorization).
      if (m.viaBearer) delete headers.authorization;
      if (LOCAL_OWNER_HEADER in headers) delete headers[LOCAL_OWNER_HEADER];
      return m.viaBearer || m.viaHeader;
    },
  };
}

/** Requests that carried a valid proof: set by the gate only, so a bridge can accept it in place of its own key. */
const proven = new WeakSet<object>();
export function markLocalOwnerProven(req: object) {
  proven.add(req);
}
export function hasLocalOwnerProof(req: object): boolean {
  return proven.has(req);
}

// ---------------------------------------------------------------------------------------------------------------
// For programs that call the hub from the same machine (cron scripts, probes, the hub itself).

/** The token value, or null when this machine has none (pc/cloud, or not readable by this account). Never log it. */
export function readLocalOwnerToken(root: string = REPO_ROOT, env: Env = process.env): string | null {
  try {
    const file = localOwnerTokenPath(root, env);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8").trim();
    return VALID.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** `{ "X-MU-Local-Owner": token }`, or `{}` where there is no token file (so pc and cloud send exactly what they always did). */
export function localOwnerHeaders(root: string = REPO_ROOT, env: Env = process.env): Record<string, string> {
  const token = readLocalOwnerToken(root, env);
  return token ? { "X-MU-Local-Owner": token } : {};
}

// ---------------------------------------------------------------------------------------------------------------
// CLI:  bun scripts/identity/local-owner-token.ts path     prints the token FILE PATH (never the value)
//       bun scripts/identity/local-owner-token.ts ensure   creates the file if missing, prints the path
if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "path") console.log(localOwnerTokenPath(REPO_ROOT));
  else if (cmd === "ensure") console.log(ensureLocalOwnerToken(REPO_ROOT));
  else {
    console.error("usage: bun scripts/identity/local-owner-token.ts path|ensure   (prints the token file path, never the token)");
    process.exit(2);
  }
}
