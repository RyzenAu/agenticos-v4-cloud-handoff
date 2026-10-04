/**
 * Build the UI bundle the Dot gateway serves (an SPA-mode client build) and write its exact file manifest.
 *
 *   bun scripts/gateway/build-ui.ts            builds into dist/client and writes dist/client/gateway-ui-manifest.json
 *
 * Run it in the checkout the gateway will serve from (staging: the clean `git archive` export). It sets
 * MU_GATEWAY_SPA_BUILD=1 for this one build (vite.config.ts: TanStack Start SPA mode, no Cloudflare worker), so the
 * output has a prerendered /_shell.html and no server is needed to render a page. Source maps are not produced, and are
 * left out of the manifest if a future config adds them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { routePaths, writeUiManifest } from "./ui";

const ROOT = resolve(import.meta.dir, "..", "..");

if (import.meta.main) {
  // The shell prerender runs the app's server code once, which opens its stores: point them at a throwaway folder so a build
  // never creates or reads data in the checkout (or anywhere real).
  const scratch = mkdtempSync(join(tmpdir(), "gw-ui-build-"));
  const build = spawnSync(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "build", "--configLoader", "native"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, MU_GATEWAY_SPA_BUILD: "1", MU_DATA_DIR: scratch },
  });
  rmSync(scratch, { recursive: true, force: true });
  if (build.status !== 0) {
    console.error(`the UI build failed (exit ${build.status})`);
    process.exit(1);
  }
  // A staging export (git archive) has no .git: dot-gateway-staging.ps1 writes the revision beside it.
  let revision: string | null = null;
  try {
    revision = readFileSync(join(ROOT, ".staging-revision"), "utf8").trim() || null;
  } catch {
    const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    revision = rev.status === 0 ? rev.stdout.trim() : null;
  }
  const pages = routePaths(readFileSync(join(ROOT, "src", "routeTree.gen.ts"), "utf8"));
  const manifest = writeUiManifest(join(ROOT, "dist", "client"), revision, pages);
  console.log(`gateway UI manifest: ${Object.keys(manifest.files).length} files, ${pages.length} pages, shell ${manifest.shell}`);
}
