/**
 * Python environment isolation (round 6). Reads config/python-envs.json and enforces, in code and in the test suite, that experimental
 * environments stay apart from operational ones.
 *
 * Why this exists: on 2 Oct 2026 the OpenShell experiment upgraded the Kali distro's Python from 3.13 to 3.14. SearXNG's virtualenv, which
 * borrows the distro interpreter, was orphaned, so research and lead discovery silently searched nothing. The rules below make that
 * class of failure a failing test instead of a surprise:
 *
 *  1. every environment is classed `operational` or `experimental`;
 *  2. no two operational environments share a path;
 *  3. an experimental environment never sits at or under an operational path (and the reverse);
 *  4. an experimental WSL environment lives under the declared experiments folder (~/experiments/), never in the distro's own site-packages;
 *  5. repo scripts (not docs) never install into a system Python (`--break-system-packages`, `sudo pip`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type PythonEnv = {
  id: string;
  class: "operational" | "experimental";
  where: "windows" | `wsl:${string}`;
  path: string;
  usedBy: string[];
  interpreterPinned: boolean;
  knownRisk?: string;
  verifiedBy?: string;
  rule?: string;
};
export type PythonEnvRegistry = {
  environments: PythonEnv[];
  rules: { experimentalWslEnvsLiveUnder: string; [k: string]: unknown };
};

export const REGISTRY_PATH = "config/python-envs.json";

export function loadRegistry(root: string): PythonEnvRegistry {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8")) as PythonEnvRegistry;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/** Pure. Returns one plain sentence per violation; an empty list is a pass. */
export function validateRegistry(registry: PythonEnvRegistry): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const env of registry.environments) {
    if (seen.has(env.id)) problems.push(`duplicate environment id "${env.id}"`);
    seen.add(env.id);
    if (env.class !== "operational" && env.class !== "experimental") problems.push(`"${env.id}" has no class (operational or experimental)`);
    if (!env.path) problems.push(`"${env.id}" has no path`);
  }
  const key = (e: PythonEnv) => `${e.where}|${norm(e.path)}`;
  const ops = registry.environments.filter((e) => e.class === "operational");
  const exps = registry.environments.filter((e) => e.class === "experimental");
  const opKeys = new Set<string>();
  for (const o of ops) {
    if (opKeys.has(key(o))) problems.push(`two operational environments share the path ${o.path}`);
    opKeys.add(key(o));
  }
  for (const x of exps) {
    for (const o of ops) {
      if (x.where !== o.where) continue;
      const a = norm(x.path);
      const b = norm(o.path);
      if (within(a, b) || within(b, a)) problems.push(`experimental "${x.id}" (${x.path}) overlaps operational "${o.id}" (${o.path})`);
    }
    if (x.where.startsWith("wsl:")) {
      const home = norm(registry.rules.experimentalWslEnvsLiveUnder);
      if (!within(norm(x.path), home.replace(/\/$/, ""))) problems.push(`experimental WSL environment "${x.id}" must live under ${registry.rules.experimentalWslEnvsLiveUnder}`);
    }
  }
  return problems;
}

const SYSTEM_INSTALL = /--break-system-packages|\bsudo\s+(?:-H\s+)?pip3?\b|\bsudo\s+python3?\s+-m\s+pip\b/;

function walk(dir: string, out: string[], skip: Set<string>) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (skip.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out, skip);
    else if (/\.(ps1|sh|bat|cmd|vbs|py|ts)$/i.test(name)) out.push(path);
  }
}

/**
 * Repo scripts that would install into a system Python. Comments that explain history are ignored (a line that starts with a comment marker),
 * and test files and this file's own pattern are exempt. Docs are not scanned: they record what happened.
 */
export function findSystemPythonInstalls(root: string): string[] {
  const files: string[] = [];
  for (const dir of ["scripts", "deploy", "companion"]) walk(join(root, dir), files, new Set(["node_modules", "__pycache__", "fixtures"]));
  const hits: string[] = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    if (/\.test\.[tj]sx?$/.test(rel) || rel === "scripts/ops/python-envs.ts") continue;
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(?:#|\/\/|\*|\/\*|<#|REM\b|')/.test(line)) return;
      if (SYSTEM_INSTALL.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

export function describeRegistry(registry: PythonEnvRegistry): string[] {
  return registry.environments.map((e) => `${e.class === "operational" ? "operational " : "experimental"} ${e.id.padEnd(16)} ${e.where.padEnd(14)} ${e.path}${e.interpreterPinned ? "" : "  (interpreter not pinned)"}`);
}

export const registryExists = (root: string) => existsSync(join(root, REGISTRY_PATH));
