/**
 * Production-style first-load weight of a route, from `bun run build` output (dist/).
 *
 *   bun scripts/perf/dist-first-load.ts [--route /business] [--json]
 *
 * The hub itself is a dev server (the /__* API routes are Vite plugins), so a built bundle cannot be driven end
 * to end here. This reads the TanStack manifest the build wrote (the exact list of scripts and styles a server
 * response preloads for the route) and adds each chunk's static import closure, then reports raw and gzip bytes.
 * That is what a browser downloads before the route is interactive. Dynamic imports are not counted (lazy).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const route = process.argv.includes("--route") ? process.argv[process.argv.indexOf("--route") + 1] : "/business";
const dist = join(import.meta.dir, "../../dist");
const manifestFile = readdirSync(join(dist, "server/assets")).find((f) => f.startsWith("_tanstack-start-manifest"));
if (!manifestFile) throw new Error("no manifest: run `bun run build` first");
const manifest = (await import(pathToFileURL(join(dist, "server/assets", manifestFile)).href)).tsrStartManifest();
const entries = (id: string) => manifest.routes[id] ?? { assets: [], preloads: [] };
const files = new Set<string>();
const css = new Set<string>();
files.add(manifest.clientEntry);
for (const id of ["__root__", route]) {
  for (const p of entries(id).preloads ?? []) files.add(p);
  for (const a of entries(id).assets ?? []) if (a?.attrs?.href) css.add(a.attrs.href);
}
// static import closure
const queue = [...files];
while (queue.length) {
  const f = queue.pop()!;
  const path = join(dist, "client", f);
  if (!existsSync(path)) continue;
  const src = readFileSync(path, "utf8");
  for (const m of src.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    const dep = "/assets/" + m[1];
    if (!files.has(dep)) { files.add(dep); queue.push(dep); }
  }
}
const size = (f: string) => {
  const b = readFileSync(join(dist, "client", f));
  return { f, raw: b.length, gz: gzipSync(b).length };
};
const js = [...files].filter((f) => existsSync(join(dist, "client", f))).map(size).sort((a, b) => b.raw - a.raw);
const sheets = [...css].filter((f) => existsSync(join(dist, "client", f))).map(size);
const tot = (xs: { raw: number; gz: number }[]) => ({ raw: Math.round(xs.reduce((s, x) => s + x.raw, 0) / 1024), gz: Math.round(xs.reduce((s, x) => s + x.gz, 0) / 1024) });
const result = { route, scripts: { count: js.length, kbRaw: tot(js).raw, kbGzip: tot(js).gz }, css: { count: sheets.length, kbRaw: tot(sheets).raw, kbGzip: tot(sheets).gz }, biggest: js.slice(0, 8).map((x) => `${x.f.replace("/assets/", "")} ${Math.round(x.raw / 1024)} KB`) };
console.log(JSON.stringify(result, null, 1));
