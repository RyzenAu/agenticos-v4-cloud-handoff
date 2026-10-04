/**
 * Files for the Dot gateway: read and write inside a SHORT list of approved roots, and nowhere else.
 *
 * There is no arbitrary filesystem access. A request names a root by its NAME (never a path) and a relative path made of
 * plain segments; the answer never contains an absolute path. Roots:
 *
 *   drafts    <hub data>/gateway/files/drafts     Dot's own working drafts. Always there.
 *   designs   MU_DESIGN_PROJECTS_DIR              the design projects folder the founders' Design page reads, ONLY when the
 *                                                 hub sets that variable (the Ryzen hub does: its designs folder). When it is
 *                                                 unset the default is a founder's Desktop, which is never opened to the gateway.
 *   <name>    MU_GATEWAY_FILE_ROOTS               more project roots the OWNER lists on the hub: "name=path;name=path"
 *                                                 (append "|ro" for read-only). Unset: none.
 *
 * Never, in any root: a name that looks secret-bearing (.env, credentials, tokens, keys, sign-in and session files: the
 * DENIED lists below), databases, backups, dot files and dot folders, links and junctions (every path
 * component is lstat'ed and the real path must be the written path), and a root that is, contains or sits inside the hub's
 * data folder, a vault, a backup folder or a home folder. Writes are size-capped, type-limited and atomic; nothing is deleted.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { gatewayDir } from "./config";

export const FILE_LIMITS = { readBytes: 2 * 1024 * 1024, writeBytes: 512 * 1024, segments: 12, listEntries: 500 } as const;

export type FileRoot = { name: string; path: string; writable: boolean; what: string };
export type RootState = { name: string; writable: boolean; what: string; ready: boolean; note?: string };

export class FileRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

const ROOT_NAME = /^[a-z][a-z0-9-]{1,23}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 ._()-]{0,99}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** Names never read, listed or written, whatever the root. */
const DENIED_NAME = /(?:^|\.)env(?:\.|$)|\.(?:pem|key|pfx|p12|ppk|kdbx|keychain|sqlite|sqlite-wal|sqlite-shm|db|token|bak|backup|log)(?:\.|$)|^(?:backups?|node_modules)$|^id_(?:rsa|ed25519|ecdsa|dsa)|\.bak-|^config\.ya?ml$|^(?:auth|oauth[\w-]*|tokens?|session[\w-]*)\.json$/i;
/** Words that mark a secret wherever they sit in a name. */
const DENIED_WORD = /token|secret|passw|credential|api[-_ ]?key|private[-_ ]?key/i;
/** What may be written: documents and web assets. Not scripts for a shell, not executables, not archives. */
const WRITABLE_EXT = new Set(["html", "htm", "css", "js", "mjs", "json", "md", "txt", "csv", "svg", "png", "jpg", "jpeg", "webp", "gif", "avif", "pdf", "woff2"]);
const TEXT_EXT = new Set(["html", "htm", "css", "js", "mjs", "json", "md", "txt", "csv", "svg", "ts", "tsx", "jsx", "xml", "yml", "yaml", "toml"]);
/** A root is refused when its path has one of these folders in it: vaults, backups and tool or credential homes. */
const ROOT_DENIED_SEGMENT = /^(?:\.[^\\/]*|backups?|.*backup.*|.*vault.*|obsidian.*|appdata|node_modules)$/i;

const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function deniedName(name: string): boolean {
  return DENIED_NAME.test(name) || DENIED_WORD.test(name);
}

/** Why a folder may not be an approved root, or null. */
export function rootRefusal(path: string, dataDir: string, home = homedir()): string | null {
  if (!isAbsolute(path)) return "not an absolute path";
  const full = resolve(path);
  if (full === parse(full).root) return "a drive or filesystem root";
  if (same(full, resolve(home)) || inside(resolve(home), full)) return "a home folder (or a folder that contains one)";
  if (inside(full, dataDir) || inside(dataDir, full)) return "the hub's data folder (or a folder around it)";
  for (const segment of full.slice(parse(full).root.length).split(/[\\/]+/)) if (ROOT_DENIED_SEGMENT.test(segment)) return `a "${segment}" folder (vaults, backups and tool folders are never roots)`;
  return null;
}

/** The approved roots for this hub, from its data folder and the two owner-set variables (names only are ever shown). */
export function approvedRoots(root: string, env: Record<string, string | undefined> = process.env): { roots: FileRoot[]; refused: { name: string; why: string }[] } {
  const dataDir = resolve(dataDirFor(root, env));
  const roots: FileRoot[] = [{ name: "drafts", path: join(gatewayDir(root, env), "files", "drafts"), writable: true, what: "Dot's own working drafts (kept in the hub's data folder)" }];
  const refused: { name: string; why: string }[] = [];
  const add = (name: string, path: string, writable: boolean, what: string) => {
    if (!ROOT_NAME.test(name) || roots.some((r) => r.name === name)) return void refused.push({ name: name.slice(0, 24), why: "the name must be unique, lower case, 2 to 24 letters, digits or hyphens" });
    const why = rootRefusal(path, dataDir);
    if (why) return void refused.push({ name, why });
    roots.push({ name, path: resolve(path), writable, what });
  };
  const designs = (env.MU_DESIGN_PROJECTS_DIR ?? "").trim();
  if (designs) add("designs", designs, true, "the design projects folder the Design page reads");
  for (const part of (env.MU_GATEWAY_FILE_ROOTS ?? "").split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 1) {
      refused.push({ name: entry.slice(0, 24), why: 'write it as "name=path"' });
      continue;
    }
    const readOnly = /\|ro$/i.test(entry);
    add(entry.slice(0, eq).trim(), entry.slice(eq + 1).replace(/\|ro$/i, "").trim(), !readOnly, "a project folder the owner listed for the gateway");
  }
  return { roots, refused };
}

/** A relative path as plain segments, or a refusal. "" and "." are the root itself. */
export function cleanRelative(input: unknown): string[] {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "" || raw === "." || raw === "/") return [];
  if (raw.length > 600 || /[\u0000-\u001f\u007f\\:*?"<>|]/.test(raw)) throw new FileRefusal(400, "Use a plain relative path with forward slashes.");
  const segments = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length > FILE_LIMITS.segments) throw new FileRefusal(400, "That path is too deep.");
  for (const s of segments) {
    if (!SEGMENT.test(s) || /[. ]$/.test(s) || RESERVED.test(s)) throw new FileRefusal(400, "Use plain names: letters, digits, spaces, dots, hyphens and underscores, not starting with a dot.");
    if (deniedName(s)) throw new FileRefusal(403, "That name is never read or written through the gateway (secrets, keys, databases, backups).");
  }
  return segments;
}

export type FileEntry = { name: string; kind: "file" | "folder"; bytes?: number; modifiedAt?: string };

export function createGatewayFiles(options: { root: string; env?: Record<string, string | undefined> }) {
  const env = () => options.env ?? process.env;
  const roots = () => approvedRoots(options.root, env());

  function rootOf(name: unknown, forWrite: boolean): FileRoot & { real: string } {
    const r = roots().roots.find((x) => x.name === name);
    if (!r) throw new FileRefusal(404, "No approved file root has that name. GET /__gateway/files/roots lists them.");
    if (forWrite && !r.writable) throw new FileRefusal(403, `The "${r.name}" root is read-only.`);
    // The drafts root is the gateway's own: made on first use. Any other root must already exist (the owner made it).
    if (r.name === "drafts" && !existsSync(r.path)) mkdirSync(r.path, { recursive: true });
    let st;
    try {
      st = lstatSync(r.path);
    } catch {
      throw new FileRefusal(409, `The "${r.name}" root is not set up on this hub.`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new FileRefusal(409, `The "${r.name}" root is not a plain folder on this hub.`);
    return { ...r, real: realpathSync(r.path) };
  }

  /**
   * Walk from the root to the target, one component at a time: each existing one must be a plain folder (the last may be a
   * plain file), never a link or junction, and the real path must be exactly the path that was written.
   */
  function walk(root: { real: string; name: string }, segments: string[], opts: { makeFolders?: boolean } = {}): { full: string; exists: boolean; isFile: boolean } {
    let at = root.real;
    for (let i = 0; i < segments.length; i++) {
      at = join(at, segments[i]);
      const last = i === segments.length - 1;
      let st;
      try {
        st = lstatSync(at);
      } catch {
        if (last) return { full: at, exists: false, isFile: false };
        if (!opts.makeFolders) throw new FileRefusal(404, "No such folder.");
        mkdirSync(at);
        continue;
      }
      if (st.isSymbolicLink()) throw new FileRefusal(403, "That path goes through a link, which the gateway never follows.");
      if (!same(realpathSync(at), at)) throw new FileRefusal(403, "That path goes through a link, which the gateway never follows.");
      if (last) {
        if (st.isFile()) {
          if (st.nlink > 1) throw new FileRefusal(403, "That file has more than one name on disk (a hard link), so it is not read or written.");
          return { full: at, exists: true, isFile: true };
        }
        if (!st.isDirectory()) throw new FileRefusal(403, "That is not a plain file or folder.");
        return { full: at, exists: true, isFile: false };
      }
      if (!st.isDirectory()) throw new FileRefusal(404, "No such folder.");
    }
    return { full: at, exists: true, isFile: false };
  }

  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  return {
    /** The roots by name, and whether each exists on this hub. No paths. */
    roots(): { roots: RootState[]; refused: { name: string; why: string }[] } {
      const { roots: list, refused } = roots();
      return {
        roots: list.map((r) => {
          let ready = r.name === "drafts";
          try {
            const st = lstatSync(r.path);
            ready = st.isDirectory() && !st.isSymbolicLink();
          } catch {
            /* drafts is made on first use; any other root that is missing is "not set up" */
          }
          return { name: r.name, writable: r.writable, what: r.what, ready, ...(ready ? {} : { note: "The folder does not exist on this hub (owner action)." }) };
        }),
        refused,
      };
    },

    list(rootName: unknown, path: unknown): { root: string; path: string; entries: FileEntry[]; truncated: boolean } {
      const root = rootOf(rootName, false);
      const segments = cleanRelative(path);
      const at = walk(root, segments);
      if (!at.exists) throw new FileRefusal(404, "No such folder.");
      if (at.isFile) throw new FileRefusal(400, "That is a file; read it instead.");
      const entries: FileEntry[] = [];
      let truncated = false;
      for (const d of readdirSync(at.full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        // Links, dot names, denied names and odd names are simply not there for the gateway.
        if (d.isSymbolicLink() || !SEGMENT.test(d.name) || /[. ]$/.test(d.name) || deniedName(d.name)) continue;
        if (entries.length >= FILE_LIMITS.listEntries) {
          truncated = true;
          break;
        }
        try {
          const st = lstatSync(join(at.full, d.name));
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) entries.push({ name: d.name, kind: "folder" });
          else if (st.isFile() && st.nlink === 1) entries.push({ name: d.name, kind: "file", bytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() });
        } catch {
          /* vanished between the listing and the stat */
        }
      }
      return { root: root.name, path: segments.join("/"), entries, truncated };
    },

    read(rootName: unknown, path: unknown): { root: string; path: string; bytes: number; sha256: string; encoding: "utf8" | "base64"; content: string; modifiedAt: string } {
      const root = rootOf(rootName, false);
      const segments = cleanRelative(path);
      if (!segments.length) throw new FileRefusal(400, "Name a file.");
      const at = walk(root, segments);
      if (!at.exists) throw new FileRefusal(404, "No such file.");
      if (!at.isFile) throw new FileRefusal(400, "That is a folder; list it instead.");
      const st = lstatSync(at.full);
      if (st.size > FILE_LIMITS.readBytes) throw new FileRefusal(413, `That file is larger than ${FILE_LIMITS.readBytes / 1024 / 1024} MB, the most the gateway reads.`);
      const bytes = readFileSync(at.full);
      const text = TEXT_EXT.has(extOf(segments[segments.length - 1])) && !bytes.includes(0);
      return { root: root.name, path: segments.join("/"), bytes: bytes.length, sha256: sha(bytes), encoding: text ? "utf8" : "base64", content: text ? bytes.toString("utf8") : bytes.toString("base64"), modifiedAt: new Date(st.mtimeMs).toISOString() };
    },

    /**
     * Write one file. `expectedSha256`: the content hash the caller last read ("absent" = the file must not exist yet); a
     * mismatch is a 409 and nothing is written, so two writers never silently overwrite each other. The previous hash comes
     * back so a change can be reversed by writing the earlier content again.
     */
    write(rootName: unknown, path: unknown, input: { content: unknown; encoding?: unknown; expectedSha256?: unknown }): { root: string; path: string; bytes: number; sha256: string; previousSha256: string | null; created: boolean } {
      const root = rootOf(rootName, true);
      const segments = cleanRelative(path);
      if (!segments.length) throw new FileRefusal(400, "Name a file.");
      const name = segments[segments.length - 1];
      if (!WRITABLE_EXT.has(extOf(name))) throw new FileRefusal(403, `Only documents and web assets are written through the gateway (${[...WRITABLE_EXT].join(", ")}).`);
      if (typeof input.content !== "string") throw new FileRefusal(400, "content must be a string (utf8 text, or base64 with encoding: \"base64\").");
      const bytes = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
      if (input.encoding === "base64" && bytes.toString("base64").replace(/=+$/, "") !== input.content.replace(/\s+/g, "").replace(/=+$/, "")) throw new FileRefusal(400, "content is not valid base64.");
      if (bytes.length > FILE_LIMITS.writeBytes) throw new FileRefusal(413, `That is larger than ${FILE_LIMITS.writeBytes / 1024} KB, the most the gateway writes in one file.`);
      const at = walk(root, segments, { makeFolders: true });
      if (at.exists && !at.isFile) throw new FileRefusal(409, "A folder has that name.");
      const previous = at.exists ? sha(readFileSync(at.full)) : null;
      if (input.expectedSha256 !== undefined) {
        const want = String(input.expectedSha256);
        if (want === "absent" ? previous !== null : want !== previous) throw new FileRefusal(409, "The file changed since you read it (or already exists), so nothing was written. Read it again.");
      }
      // A temp file beside the target (a dot name: never listed or readable through the gateway), then a rename into place.
      const temp = join(at.full, "..", `.gw-${randomBytes(6).toString("hex")}.tmp`);
      writeFileSync(temp, bytes, { flag: "wx" });
      try {
        renameSync(temp, at.full);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      // The write must have landed inside the root, as a plain file (a folder swapped for a link mid-write is caught here).
      if (!inside(realpathSync(at.full), root.real) || !same(realpathSync(at.full), at.full)) throw new FileRefusal(403, "That path goes through a link, which the gateway never follows.");
      return { root: root.name, path: segments.join("/"), bytes: bytes.length, sha256: sha(bytes), previousSha256: previous, created: previous === null };
    },
  };
}

export type GatewayFiles = ReturnType<typeof createGatewayFiles>;
