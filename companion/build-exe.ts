#!/usr/bin/env bun
/**
 * Build the companion as ONE Windows program for a person's own PC (no Bun, no checkout, no node_modules needed there):
 *
 *   bun companion/build-exe.ts [--out D:\prog-scratch\dist]
 *
 * Produces <out>\mu-companion.exe (bun build --compile) and <out>\mu-companion.exe.sha256 (SHA-256 of the exe, in the
 * `certutil`/sha256sum-friendly "<hash> *file" form), and prints both. It never signs, uploads or sends anything: the file is
 * handed over by the owner, who reads the checksum out separately.
 *
 * The app browser (Playwright) is left out of the package on purpose (a large browser download and a separate trust decision):
 * browser goals that need it say so plainly; everything else (apps, windows, files, PowerPoint, the Jev-first screen loop over
 * UI Automation) is inside the exe. Keys are read the way the hub reads them (environment, .env.local, ~/.config/agentic-os.env);
 * none is baked into the file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { COMPANION_VERSION } from "./worker";

const argv = process.argv.slice(2);
const out = resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "D:\\prog-scratch\\dist");
const exe = join(out, "mu-companion.exe");
mkdirSync(out, { recursive: true });

const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "main.ts")],
  compile: { outfile: exe },
  external: ["playwright", "playwright-core", "chromium-bidi", "chromium-bidi/*", "electron"],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!build.success) {
  for (const log of build.logs) console.error(String(log));
  process.exit(1);
}
const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
writeFileSync(`${exe}.sha256`, `${sha} *${basename(exe)}\n`);
console.log(`built ${exe}  (${(statSync(exe).size / 1_048_576).toFixed(1)} MB, worker ${COMPANION_VERSION})`);
console.log(`sha256 ${sha}`);
