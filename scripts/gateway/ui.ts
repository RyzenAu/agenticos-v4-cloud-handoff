/**
 * The UI the gateway serves ITSELF: a built client bundle (scripts/gateway/build-ui.ts) and its exact file manifest.
 *
 * The gateway never forwards a non-/__ request to the hub (a Vite dev server whose file serving can read the checkout).
 * A request for the UI is answered from this bundle: a path that is a manifest key, byte for byte, gets that file; a page
 * path gets the SPA shell; anything else is 404. The manifest is written at build time, lists every file with its size and
 * SHA-256, and leaves out source maps and dot files. At start-up every listed file must exist inside the bundle folder
 * with the listed size, or the UI is not served at all.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export const UI_MANIFEST = "gateway-ui-manifest.json";
/** TanStack Start's SPA-mode shell (tanstackStart.spa: prerendered to /_shell.html). */
export const UI_SHELL = "/_shell.html";

export type UiFile = { size: number; sha256: string; type: string };
/** `pages`: the app's route paths (TanStack's fullPaths), e.g. "/leads", "/coding/$jobId". Only these get the shell. */
export type UiManifest = { version: 1; builtAt: string; revision: string | null; shell: string; pages: string[]; files: Record<string, UiFile> };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};
export const contentTypeFor = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** A manifest key: "/" then plain segments (letters, digits, "-", "_", "."; never starting with "."), no ":" or "%". */
const KEY = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,159})+$/;
const EXCLUDE = (rel: string) => /(?:^|\/)\./.test(rel) || /\.map$/i.test(rel) || rel === UI_MANIFEST;

/**
 * Folders of the build output that are NOT part of the gateway's UI, by default. Keep this list small and say why.
 *   /mu-creative-20261001   unapproved films and the creative brief (which also names a local path): not for a collaborator.
 */
export const UI_EXCLUDED_PREFIXES: readonly string[] = ["/mu-creative-20261001"];
const under = (key: string, prefixes: readonly string[]) => prefixes.some((p) => key === p || key.startsWith(`${p}/`));

const ROUTE = /^\/(?:[A-Za-z0-9_-]+|\$[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9_-]+|\$[A-Za-z][A-Za-z0-9]*))*\/?$|^\/$/;

/** The app's route paths, read from TanStack Router's generated route tree (its `fullPaths` union). */
export function routePaths(routeTreeSource: string): string[] {
  const block = /fullPaths:\s*((?:\s*\|\s*'[^']*')+)/.exec(routeTreeSource)?.[1] ?? "";
  const paths = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  for (const p of paths) if (!ROUTE.test(p)) throw new Error(`A route path the gateway does not understand: ${p}`);
  if (!paths.includes("/")) throw new Error("The route tree has no root route.");
  return paths;
}

/** Does a request path name one of the app's routes? A "$param" is one plain segment; a trailing slash is allowed. */
export function matchesPage(path: string, pages: readonly string[]): boolean {
  const have = path.replace(/\/$/, "").split("/");
  return pages.some((page) => {
    const want = page.replace(/\/$/, "").split("/");
    return want.length === have.length && want.every((w, i) => (w.startsWith("$") ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(have[i]) : w === have[i]));
  });
}

/** Write the manifest for a built client folder. Returns it. */
export function writeUiManifest(dir: string, revision: string | null = null, pages: string[] = ["/"], excluded: readonly string[] = UI_EXCLUDED_PREFIXES): UiManifest {
  const root = resolve(dir);
  const files: Record<string, UiFile> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name);
      const rel = relative(root, full).split(sep).join("/");
      if (EXCLUDE(rel) || under(`/${rel}`, excluded)) continue;
      // lstat: a link or junction inside the build output is never followed or listed.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const key = `/${rel}`;
        if (!KEY.test(key)) throw new Error(`A built file has a name the gateway will not serve: ${key}`);
        files[key] = { size: st.size, sha256: createHash("sha256").update(readFileSync(full)).digest("hex"), type: contentTypeFor(key) };
      }
    }
  };
  walk(root);
  if (!files[UI_SHELL]) throw new Error(`The build has no ${UI_SHELL}: it was not an SPA-mode build (MU_GATEWAY_SPA_BUILD=1).`);
  const manifest: UiManifest = { version: 1, builtAt: new Date().toISOString(), revision, shell: UI_SHELL, pages, files };
  writeFileSync(join(root, UI_MANIFEST), JSON.stringify(manifest, null, 1));
  return manifest;
}

export type UiBundle = { dir: string; shell: string; pages: readonly string[]; files: ReadonlyMap<string, UiFile & { path: string }> };

/** Load and check a bundle. Throws when anything does not match, so a tampered bundle is never half-served. */
export function loadUi(dir: string): UiBundle {
  const root = resolve(dir);
  const manifest = JSON.parse(readFileSync(join(root, UI_MANIFEST), "utf8")) as UiManifest;
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object") throw new Error("The UI manifest is not one this gateway reads.");
  const files = new Map<string, UiFile & { path: string }>();
  if (lstatSync(root).isSymbolicLink()) throw new Error("The UI bundle folder is a link.");
  const realRoot = realpathSync(root);
  for (const [key, f] of Object.entries(manifest.files)) {
    if (!KEY.test(key) || key.split("/").some((s) => s === "." || s === "..") || EXCLUDE(key.slice(1))) throw new Error(`The UI manifest lists a path the gateway will not serve: ${key}`);
    const full = resolve(root, `.${key}`);
    if (!full.startsWith(root + sep)) throw new Error(`The UI manifest lists a path outside the bundle: ${key}`);
    if (typeof f?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.size !== "number") throw new Error(`The UI manifest has no hash for ${key}.`);
    // A plain file, reached through plain folders: no symlink, junction or other reparse point anywhere on the way.
    let st;
    try {
      st = lstatSync(full);
    } catch {
      throw new Error(`The UI bundle is missing ${key}.`);
    }
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`The UI bundle has something other than a plain file at ${key}.`);
    if (realpathSync(full).toLowerCase() !== join(realRoot, ...key.split("/").slice(1)).toLowerCase()) throw new Error(`The UI bundle reaches ${key} through a link.`);
    // The content is the content that was built: size and SHA-256, checked now, before anything is served.
    if (st.size !== f.size || createHash("sha256").update(readFileSync(full)).digest("hex") !== f.sha256) throw new Error(`The UI bundle does not match its manifest at ${key}.`);
    files.set(key, { ...f, type: contentTypeFor(key), path: full });
  }
  if (!files.has(manifest.shell) || manifest.shell !== UI_SHELL) throw new Error("The UI manifest has no SPA shell.");
  const pages = Array.isArray(manifest.pages) ? manifest.pages : ["/"];
  for (const p of pages) if (typeof p !== "string" || !ROUTE.test(p)) throw new Error(`The UI manifest lists a page the gateway will not serve: ${p}`);
  return { dir: root, shell: manifest.shell, pages, files };
}
