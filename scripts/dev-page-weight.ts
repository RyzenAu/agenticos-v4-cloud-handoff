/**
 * Dev-server page weight (client environment only; `vite build` is untouched).
 *
 * lucideSubset — serve the browser ONE small module holding just the lucide icons the app imports,
 * instead of Vite's pre-bundle of the whole `lucide-react` barrel (~1,900 icons, ~980 KB that
 * every page downloaded and evaluated).
 *
 * At server start it scans `src/` for `import { … } from "lucide-react"`, maps each name to its
 * icon file through the barrel's own export list, and bundles those files (esbuild, react left
 * external) into a virtual module. Client imports of "lucide-react" resolve to it. An edit that
 * imports an icon not in the set rebuilds it and reloads the page. Files that need the whole
 * barrel (namespace/default/dynamic imports) keep the normal pre-bundle, and SSR and
 * `vite build` are untouched (Rollup already tree-shakes the barrel for production).
 * AGENTIC_LUCIDE_SUBSET=0 turns it off. Measured 28 Sep (docs/native-perf-20260928): hydration on
 * /today, /finance, /jarvis 2007/1422/1276 ms with the barrel, 1198/1247/1332 ms with one import
 * per icon file (~120 extra requests), 973/1062/794 ms with this subset.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import type { Plugin, ViteDevServer } from "vite";

const VIRTUAL_ID = "\0agentic-lucide-subset";
const NAMED_RE = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g;
const WHOLE_BARREL_RE =
  /import\s+(?:\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s*["']lucide-react["']|import\(\s*["']lucide-react["']\s*\)/;

/** Value names imported (or re-exported) from "lucide-react"; type-only specifiers are skipped. */
export function lucideValueImports(code: string): string[] {
  const names = new Set<string>();
  for (const match of code.matchAll(NAMED_RE)) {
    if (match[1]) continue;
    for (const raw of match[2].split(",")) {
      const spec = raw.trim();
      if (!spec || spec.startsWith("type ")) continue;
      names.add(spec.split(/\s+as\s+/)[0].trim());
    }
  }
  return [...names];
}

/** True when a module needs the whole barrel: `import * as`, a default import, or `import("lucide-react")`. */
export function needsWholeBarrel(code: string): boolean {
  return WHOLE_BARREL_RE.test(code);
}

/** Export name → the barrel-relative file that defines it (e.g. "Plus" → "./icons/plus.js"). */
export function lucideExportMap(barrel: string): Map<string, { file: string; name: string }> {
  const map = new Map<string, { file: string; name: string }>();
  for (const match of barrel.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const raw of match[1].split(",")) {
      const [local, exported] = raw.trim().split(/\s+as\s+/);
      if (!local) continue;
      map.set((exported ?? local).trim(), { file: match[2], name: local.trim() });
    }
  }
  return map;
}

/** The esbuild entry: one re-export per used name, straight from its icon file. */
export function subsetEntry(names: Iterable<string>, map: Map<string, { file: string; name: string }>, barrelDir: string): string {
  const lines: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    const hit = map.get(name);
    if (!hit) continue; // a type (LucideIcon, LucideProps …) or a name the barrel does not have
    const file = join(barrelDir, hit.file).split(sep).join("/");
    lines.push(`export { ${hit.name === "default" ? "default" : hit.name} as ${name} } from ${JSON.stringify(file)};`);
  }
  return lines.join("\n") + "\n";
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

export function lucideSubset(options: { root: string; srcDir?: string }): Plugin {
  const srcDir = options.srcDir ?? join(options.root, "src");
  const used = new Set<string>();
  const wholeBarrel = new Set<string>();
  let map: Map<string, { file: string; name: string }> | undefined;
  let barrelDir = "";
  let bundle: Promise<string> | undefined;
  let server: ViteDevServer | undefined;

  const build = () => {
    const entry = subsetEntry(used, map!, barrelDir);
    bundle = import("esbuild").then(async (esbuild) => {
      const result = await esbuild.build({
        stdin: { contents: entry, resolveDir: barrelDir, loader: "js", sourcefile: "lucide-subset.js" },
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        external: ["react", "react/*"],
        logLevel: "silent",
      });
      return result.outputFiles[0].text;
    });
    bundle.catch(() => undefined);
    return bundle;
  };
  const clientOnly = (plugin: { environment?: { name: string } }) => plugin.environment?.name === "client";
  const norm = (id: string) => id.split("?")[0].split(sep).join("/");

  return {
    name: "agentic-lucide-subset",
    apply: "serve",
    enforce: "pre",
    configureServer(devServer) {
      server = devServer;
      if (process.env.AGENTIC_LUCIDE_SUBSET === "0") return; // escape hatch: back to the whole-barrel pre-bundle
      try {
        const require = createRequire(join(options.root, "package.json"));
        const barrelPath = join(dirname(require.resolve("lucide-react/package.json")), "dist", "esm", "lucide-react.js");
        barrelDir = dirname(barrelPath);
        map = lucideExportMap(readFileSync(barrelPath, "utf8"));
      } catch {
        map = undefined; // no lucide-react: the plugin stays out of the way
        return;
      }
      for (const file of sourceFiles(srcDir)) {
        const code = readFileSync(file, "utf8");
        if (!code.includes("lucide-react")) continue;
        for (const name of lucideValueImports(code)) used.add(name);
        if (needsWholeBarrel(code)) wholeBarrel.add(norm(file));
      }
      void build();
    },
    resolveId(id, importer) {
      if (id !== "lucide-react" || !map || !clientOnly(this as never)) return null;
      if (importer && wholeBarrel.has(norm(importer))) return null;
      return VIRTUAL_ID;
    },
    async load(id) {
      if (id !== VIRTUAL_ID) return null;
      return { code: await (bundle ?? build()), map: { mappings: "" } };
    },
    async transform(code, id) {
      if (!map || !clientOnly(this as never) || id.includes("/node_modules/") || !code.includes("lucide-react")) return null;
      if (needsWholeBarrel(code)) wholeBarrel.add(norm(id));
      const missing = lucideValueImports(code).filter((name) => !used.has(name) && map!.has(name));
      if (!missing.length) return null;
      for (const name of missing) used.add(name);
      await build();
      const graph = (this as unknown as { environment: { moduleGraph: ViteDevServer["environments"]["client"]["moduleGraph"] } }).environment.moduleGraph;
      const mod = graph.getModuleById(VIRTUAL_ID);
      if (mod?.transformResult) {
        // Already served with the old icon set: browsers cache ES modules per URL, so reload.
        graph.invalidateModule(mod);
        server?.environments.client.hot.send({ type: "full-reload" });
      }
      return null;
    },
  };
}

/**
 * A route file's "reference" module (what src/routeTree.gen.ts imports for every page) is a few
 * lines once TanStack's code splitter has moved the component out, but in dev Vite still inlines a
 * source map carrying the file's whole original source: src/routes/design.tsx alone sent ~525 KB
 * of base64 to every page. The split component modules keep their maps; only these small
 * route-options stubs (head, validateSearch, beforeLoad) are served without one.
 */
export function isRouteReferenceModule(id: string, routesDir: string): boolean {
  const [path, query = ""] = id.split("?");
  if (query.includes("tsr-split")) return false;
  const file = path.split("\\").join("/");
  const dir = routesDir.split("\\").join("/").replace(/\/$/, "");
  if (!file.startsWith(`${dir}/`) || !/\.[jt]sx?$/.test(file)) return false;
  return !file.slice(dir.length + 1).startsWith("__root.");
}

export function routeReferenceMaps(options: { root: string; routesDir?: string }): Plugin {
  const routesDir = options.routesDir ?? join(options.root, "src", "routes");
  return {
    name: "agentic-route-reference-maps",
    apply: "serve",
    enforce: "post",
    transform(code, id) {
      if ((this as { environment?: { name: string } }).environment?.name !== "client") return null;
      if (!isRouteReferenceModule(id, routesDir)) return null;
      return { code, map: { mappings: "" } };
    },
  };
}

/**
 * Round 6: every app module (src/**) is served without its inline source map in dev. Vite embeds the whole original
 * file as base64 in each module, so a first load carried about as much map as code (floating-oracle.tsx 560 KB,
 * voice-companion.tsx 557 KB, business.tsx 275 KB). Stack traces in the browser console then point at the served
 * module instead of the original line; set AGENTIC_DEV_SOURCEMAPS=1 to keep the maps while debugging UI.
 * Node modules keep theirs (they are small once pre-bundled) and `vite build` is untouched.
 */
export function isAppSourceModule(id: string, srcDir: string): boolean {
  const [path, query = ""] = id.split("?");
  if (query.includes("raw") || query.includes("url") || query.includes("inline")) return false;
  const file = path.split("\\").join("/");
  const dir = srcDir.split("\\").join("/").replace(/\/$/, "");
  return file.startsWith(`${dir}/`) && !file.includes("/node_modules/") && /\.[cm]?[jt]sx?$/.test(file);
}

export function appSourceMapsOff(options: { root: string; srcDir?: string }): Plugin {
  const srcDir = options.srcDir ?? join(options.root, "src");
  return {
    name: "agentic-app-source-maps-off",
    apply: "serve",
    enforce: "post",
    transform(code, id) {
      if (process.env.AGENTIC_DEV_SOURCEMAPS === "1") return null;
      if ((this as { environment?: { name: string } }).environment?.name !== "client") return null;
      if (!isAppSourceModule(id, srcDir)) return null;
      return { code, map: { mappings: "" } };
    },
  };
}
