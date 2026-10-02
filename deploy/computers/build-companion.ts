#!/usr/bin/env bun
/**
 * Build the shared-computer companion into ONE file that runs under plain Node 22 on the computer's host (no Bun, no npm install
 * there): `bun deploy/computers/build-companion.ts [outfile]`. Every computer on a host runs that one file.
 *
 * companion/worker.ts reaches the Windows PC executors (PowerShell, the screen loop, the Jarvis model router) through
 * companion/executors.ts. A computer never calls them, so the build swaps those three modules for stubs
 * (deploy/computers/stubs/pc-only.ts): the file stays small and loads on Linux without Windows-only or UI packages.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export async function buildCompanion(outfile: string, root = resolve(import.meta.dir, "..", "..")): Promise<{ bytes: number }> {
  mkdirSync(dirname(outfile), { recursive: true });
  const stub = join(root, "deploy", "computers", "stubs", "pc-only.ts");
  const tmpDir = `${outfile}.build`;
  rmSync(tmpDir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, "companion", "linux", "main.ts")],
    target: "node",
    outdir: tmpDir,
    naming: "companion.mjs",
    plugins: [
      {
        name: "pc-only-stubs",
        setup(b) {
          b.onResolve({ filter: /(^|[\/])executors[\/](windows|desktop|screen-goal)$/ }, () => ({ path: stub }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(`companion build failed: ${result.logs.map((l) => l.message).join("; ").slice(0, 300)}`);
  const built = readFileSync(join(tmpDir, "companion.mjs"));
  writeFileSync(`${outfile}.tmp`, built);
  renameSync(`${outfile}.tmp`, outfile);
  rmSync(tmpDir, { recursive: true, force: true });
  return { bytes: built.length };
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? join(import.meta.dir, "dist", "companion.mjs"));
  const { bytes } = await buildCompanion(out);
  console.log(`built ${out} (${Math.round(bytes / 1024)} KB)`);
}
