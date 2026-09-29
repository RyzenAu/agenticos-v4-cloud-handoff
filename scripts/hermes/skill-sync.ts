// Give Hermes the owner's Claude Code skills (W-C, 29 Sep 2026; the owner asked for this directly).
//
// Copies every SKILL.md skill from ~/.claude/skills (and installed Claude Code plugins) into Hermes'
// own skills folder under one category, `claude-skills`. Rules:
// - A skill that needs Claude-only tools (the Skill tool, AskUserQuestion, Claude in Chrome, …) is
//   skipped with the reason. So is anything Hermes already has under the same name, and the
//   Anthropic-managed account skills (licensed for Claude).
// - Nothing secret is copied: .env/key/credential files are withheld, and so is any text file that
//   looks like it holds a key or token. A skill whose SKILL.md looks secret is skipped whole.
// - Idempotent: a manifest records what was copied and the hashes on both sides. An unchanged
//   source is left alone; a copy that Hermes itself edited since the last sync is kept, not
//   overwritten; a skill whose source disappeared is left in Hermes (nothing is deleted).
// - Before the first write of a run, Hermes' skills folder is backed up (newest three kept).
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";

export const SYNC_CATEGORY = "claude-skills";
export const MANIFEST_NAME = ".agentic-os-sync.json";
export const REPORT_NAME = ".agentic-os-last-report.json";
const BACKUP_DIR = join("backups", "agentic-os-skill-sync");
const BACKUPS_KEPT = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".pytest_cache", ".mypy_cache"]);

export type SkillSource = { name: string; dir: string; origin: string };
export type SkipEntry = { name: string; origin: string; reason: string };
export type SkillFile = { rel: string; abs: string; size: number };
export type ManifestEntry = {
  name: string;
  origin: string;
  source: string;
  sourceHash: string;
  destHash: string;
  files: number;
  withheld: Array<{ file: string; reason: string }>;
  syncedAt: string;
};
export type Manifest = { version: 1; category: string; updatedAt: string; skills: Record<string, ManifestEntry> };
export type SyncOutcome = "added" | "updated" | "unchanged" | "kept-hermes-edit" | "would-add" | "would-update";
export type SyncReport = {
  dryRun: boolean;
  hermesSkillsDir: string;
  category: string;
  backup: string | null;
  results: Array<{ name: string; origin: string; outcome: SyncOutcome; files: number; withheld: Array<{ file: string; reason: string }> }>;
  skipped: SkipEntry[];
  /** Synced earlier, but the source is gone or now skipped: left in Hermes untouched. */
  orphaned: string[];
  counts: { added: number; updated: number; unchanged: number; kept: number; skipped: number };
  finishedAt: string;
};

// ── What Hermes can't run ────────────────────────────────────────────────────────────────────
// Each rule names a Claude Code feature a skill DEPENDS on, not one it merely mentions: "works in
// Claude Code, Codex, …" is fine; "Call the Skill tool" or "use AskUserQuestion" is not.
const CLAUDE_ONLY: Array<{ test: (text: string, frontmatter: string) => boolean; reason: string }> = [
  { test: (_t, fm) => /^disable-model-invocation:\s*true/m.test(fm), reason: "a Claude Code slash-command wrapper (disable-model-invocation)" },
  { test: (t) => /\bSkill tool\b/.test(t), reason: "chains other skills through Claude Code's Skill tool" },
  { test: (t) => /\bAskUserQuestion\b/.test(t), reason: "asks its questions through Claude Code's AskUserQuestion tool" },
  { test: (t) => /mcp__claude-in-chrome|\bClaude in Chrome\b/.test(t), reason: "drives the browser through the Claude in Chrome extension" },
  { test: (t) => /mcp__computer-use/.test(t), reason: "uses Claude's computer-use tools" },
  { test: (t) => /\$\{CLAUDE_PLUGIN_ROOT\}/.test(t), reason: "runs files through Claude Code's plugin root" },
  { test: (t) => /\b(?:ExitPlanMode|TodoWrite|NotebookEdit)\b/.test(t), reason: "depends on Claude Code-only tools (plan mode / todo list)" },
  { test: (t) => /\bArtifact tool\b|\bArtifactData\b/.test(t), reason: "publishes through claude.ai Artifacts" },
  { test: (t) => /\bmcp__(?:plugin_)?stripe\b|\bStripe MCP\b/i.test(t), reason: "needs the Stripe MCP server that only Claude Code's plugin provides" },
];

export function frontmatterOf(text: string): string {
  const t = text.replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return "";
  const end = t.indexOf("\n---", 4);
  return end === -1 ? "" : t.slice(4, end);
}

/** Why Hermes can't use this skill, or null when it can. */
export function claudeOnlyReason(skillMd: string): string | null {
  const fm = frontmatterOf(skillMd);
  // The money policy: an agent never sends or transfers money (owner rule), so a skill whose job
  // is moving money stays out of Hermes.
  if (/\bstripe pay\b|\bsend (?:funds|money)\b|\btransfer (?:money|funds)\b|\bpayouts? to\b/i.test(fm) || /^#\s+`?stripe pay`?/m.test(skillMd))
    return "moves money (the money policy keeps payment actions out of Hermes)";
  for (const rule of CLAUDE_ONLY) if (rule.test(skillMd, fm)) return rule.reason;
  return null;
}

/** The skill's own name (frontmatter `name:`), else its folder name. */
export function skillNameOf(skillMd: string, folder: string): string {
  const raw = /^name:\s*["']?([^"'\n]+)/m.exec(frontmatterOf(skillMd))?.[1]?.trim();
  return raw && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw) ? raw : folder;
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────
const SECRET_FILE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|auth\.json|token(?:s)?\.json|cookies?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks|token)|.*secret.*)$/i;
const SECRET_TEXT: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/,
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{28,}/i,
];

/** Why a file must not be copied (never includes the matched text), or null. */
export function secretReason(fileName: string, content: Buffer | null): string | null {
  if (SECRET_FILE_NAME.test(fileName)) return "a credential or environment file";
  if (!content) return null;
  if (content.includes(0)) return null; // binary: images, fonts
  const text = content.toString("utf-8");
  return SECRET_TEXT.some((re) => re.test(text)) ? "looks like it contains a key or token" : null;
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────
function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every SKILL.md skill Claude Code can see, plus what was skipped at discovery and why. */
export function discoverClaudeSkills(claudeHome: string): { sources: SkillSource[]; skipped: SkipEntry[] } {
  const sources: SkillSource[] = [];
  const skipped: SkipEntry[] = [];
  const root = join(claudeHome, "skills");
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    /* no skills folder */
  }
  for (const entry of entries.sort()) {
    const dir = join(root, entry);
    if (!isDir(dir) || entry.startsWith(".")) continue;
    if (entry === "synced") {
      skipped.push({ name: "synced/*", origin: "claude.ai account", reason: "Anthropic-managed account skills (licensed for Claude only)" });
      continue;
    }
    if (!existsSync(join(dir, "SKILL.md"))) {
      skipped.push({ name: entry, origin: "claude", reason: "no SKILL.md" });
      continue;
    }
    sources.push({ name: entry, dir, origin: "claude" });
  }
  // Installed Claude Code plugins: ~/.claude/plugins/installed_plugins.json → installPath/skills/*.
  try {
    const installed = JSON.parse(readFileSync(join(claudeHome, "plugins", "installed_plugins.json"), "utf-8")) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    for (const [id, installs] of Object.entries(installed.plugins ?? {})) {
      const installPath = installs?.[0]?.installPath;
      if (!installPath) continue;
      const pluginName = id.split("@")[0];
      const skillsDir = join(installPath, "skills");
      let names: string[] = [];
      try {
        names = readdirSync(skillsDir);
      } catch {
        continue;
      }
      for (const n of names.sort()) {
        const dir = join(skillsDir, n);
        if (isDir(dir) && existsSync(join(dir, "SKILL.md"))) sources.push({ name: n, dir, origin: `plugin ${pluginName}` });
      }
    }
  } catch {
    /* no plugins */
  }
  return { sources, skipped };
}

/** Files to copy for one skill (sorted), and the ones withheld with a reason. Links inside are not followed. */
export function collectSkillFiles(dir: string): { files: SkillFile[]; withheld: Array<{ file: string; reason: string }> } {
  const files: SkillFile[] = [];
  const withheld: Array<{ file: string; reason: string }> = [];
  const root = realpathSync(dir); // a junctioned skill folder is copied from its target
  const walk = (abs: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const child = join(abs, name);
      const rel = relative(root, child).split(sep).join("/");
      let st;
      try {
        st = lstatSync(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        withheld.push({ file: rel, reason: "a link to somewhere else (not followed)" });
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(child);
        continue;
      }
      if (!st.isFile()) continue;
      if (name === ".DS_Store") continue;
      if (st.size > MAX_FILE_BYTES) {
        withheld.push({ file: rel, reason: "larger than 2 MB" });
        continue;
      }
      const early = secretReason(name, null);
      if (early) {
        withheld.push({ file: rel, reason: early });
        continue;
      }
      let content: Buffer;
      try {
        content = readFileSync(child);
      } catch {
        continue;
      }
      const why = secretReason(name, content);
      if (why) {
        withheld.push({ file: rel, reason: why });
        continue;
      }
      files.push({ rel, abs: child, size: st.size });
    }
  };
  walk(root);
  return { files, withheld };
}

/** One hash over a file list's paths and bytes. */
export function hashFiles(files: Array<{ rel: string; abs: string }>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel);
    h.update("\0");
    try {
      h.update(readFileSync(f.abs));
    } catch {
      h.update("<unreadable>");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

/** Every file under a directory, for hashing a Hermes-side copy (the manifest itself excluded). */
function listTree(dir: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = (abs: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const child = join(abs, name);
      let st;
      try {
        st = lstatSync(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(child);
      else if (st.isFile() && name !== MANIFEST_NAME) out.push({ rel: relative(dir, child).split(sep).join("/"), abs: child });
    }
  };
  walk(dir);
  return out;
}

/** Skill names Hermes already has anywhere in its skills tree, outside our category. */
export function existingHermesSkillNames(skillsDir: string, category = SYNC_CATEGORY): Map<string, string> {
  const names = new Map<string, string>();
  const walk = (abs: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = join(abs, name);
      if (depth === 0 && name === category) continue;
      if (!isDir(child)) continue;
      const skillMd = join(child, "SKILL.md");
      if (existsSync(skillMd)) {
        const rel = relative(skillsDir, child).split(sep).join("/");
        let text = "";
        try {
          text = readFileSync(skillMd, "utf-8");
        } catch {
          /* name from folder */
        }
        names.set(name, rel);
        names.set(skillNameOf(text, name), rel);
      }
      walk(child, depth + 1);
    }
  };
  walk(skillsDir, 0);
  return names;
}

export function readManifest(categoryDir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(categoryDir, MANIFEST_NAME), "utf-8")) as Manifest;
    if (m && m.version === 1 && m.skills && typeof m.skills === "object") return m;
  } catch {
    /* first run */
  }
  return { version: 1, category: SYNC_CATEGORY, updatedAt: "", skills: {} };
}

function writeFileLf(path: string, text: string) {
  writeFileSync(path, text.replace(/\r\n/g, "\n"), "utf-8");
}

/** Copy a tree we own (no links: listTree/collect skip them) for the backup. */
function copyTree(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(src, dst);
    else if (st.isFile()) copyFileSync(src, dst);
  }
}

/** Remove a folder this sync created, refusing links/junctions at the top (never delete through one). */
function removeOwnedDir(path: string) {
  try {
    const st = lstatSync(path);
    // lstat reports a symlink or a Windows junction as a link: never delete through one.
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* leave it */
  }
}

export function syncSkillsToHermes(options: {
  claudeHome: string;
  hermesHome: string;
  dryRun?: boolean;
  now?: () => Date;
}): SyncReport {
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  // ~/.hermes is usually a junction: work on the real folder so every path below is a plain one.
  const hermesHome = existsSync(options.hermesHome) ? realpathSync(options.hermesHome) : options.hermesHome;
  const skillsDir = join(hermesHome, "skills");
  const categoryDir = join(skillsDir, SYNC_CATEGORY);
  const manifest = readManifest(categoryDir);
  const { sources, skipped } = discoverClaudeSkills(options.claudeHome);
  const existing = existingHermesSkillNames(skillsDir);
  const results: SyncReport["results"] = [];
  const seen = new Set<string>();
  let backup: string | null = null;

  const ensureBackup = () => {
    if (backup || dryRun) return;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const root = join(hermesHome, BACKUP_DIR);
    backup = join(root, stamp);
    if (existsSync(skillsDir)) copyTree(skillsDir, join(backup, "skills"));
    else mkdirSync(backup, { recursive: true });
    // Keep the newest few backups; each one is a folder this sync made.
    const all = readdirSync(root).filter((n) => isDir(join(root, n))).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) removeOwnedDir(join(root, old));
  };

  for (const src of sources) {
    let skillMd = "";
    try {
      skillMd = readFileSync(join(src.dir, "SKILL.md"), "utf-8");
    } catch {
      skipped.push({ name: src.name, origin: src.origin, reason: "SKILL.md unreadable" });
      continue;
    }
    const name = skillNameOf(skillMd, basename(src.dir));
    if (seen.has(name)) {
      skipped.push({ name, origin: src.origin, reason: "a skill with this name was already taken from another source" });
      continue;
    }
    const claudeOnly = claudeOnlyReason(skillMd);
    if (claudeOnly) {
      skipped.push({ name, origin: src.origin, reason: claudeOnly });
      continue;
    }
    const clash = existing.get(name) ?? existing.get(basename(src.dir));
    if (clash) {
      skipped.push({ name, origin: src.origin, reason: `Hermes already has it (${clash})` });
      continue;
    }
    const { files, withheld } = collectSkillFiles(src.dir);
    if (withheld.some((w) => w.file === "SKILL.md")) {
      skipped.push({ name, origin: src.origin, reason: "its SKILL.md looks like it contains a key or token" });
      continue;
    }
    seen.add(name);
    const sourceHash = hashFiles(files);
    const dest = join(categoryDir, name);
    const prior = manifest.skills[name];
    const destExists = existsSync(dest);
    const destHash = destExists ? hashFiles(listTree(dest)) : "";
    let outcome: SyncOutcome;
    if (prior && destExists && prior.sourceHash === sourceHash && prior.destHash === destHash) outcome = "unchanged";
    else if (prior && destExists && prior.destHash !== destHash) outcome = "kept-hermes-edit";
    else if (!destExists && !prior) outcome = dryRun ? "would-add" : "added";
    else if (destExists && !prior) {
      // A folder we never wrote: Hermes (or someone) made it. Leave it.
      outcome = "kept-hermes-edit";
    } else outcome = dryRun ? "would-update" : "updated";

    if (outcome === "added" || outcome === "updated") {
      ensureBackup();
      const tmp = `${dest}.sync-${process.pid}`;
      removeOwnedDir(tmp);
      for (const f of files) {
        const to = join(tmp, ...f.rel.split("/"));
        mkdirSync(join(to, ".."), { recursive: true });
        copyFileSync(f.abs, to);
      }
      mkdirSync(categoryDir, { recursive: true });
      if (destExists) {
        const old = `${dest}.old-${process.pid}`;
        renameSync(dest, old);
        renameSync(tmp, dest);
        removeOwnedDir(old);
      } else renameSync(tmp, dest);
      manifest.skills[name] = {
        name,
        origin: src.origin,
        source: src.dir,
        sourceHash,
        destHash: hashFiles(listTree(dest)),
        files: files.length,
        withheld,
        syncedAt: now().toISOString(),
      };
    }
    results.push({ name, origin: src.origin, outcome, files: files.length, withheld });
  }

  const orphaned = Object.keys(manifest.skills).filter((n) => !seen.has(n)).sort();
  const changed = results.some((r) => r.outcome === "added" || r.outcome === "updated");
  if (!dryRun && changed) {
    mkdirSync(categoryDir, { recursive: true });
    const desc = join(categoryDir, "DESCRIPTION.md");
    if (!existsSync(desc))
      writeFileLf(
        desc,
        "---\ndescription: The owner's Claude Code skills, copied here by Agentic OS (Hermes page, Sync skills). Re-syncing updates them; a skill edited here is kept.\n---\n\n# Claude Code skills\n\nCopied from ~/.claude/skills by Agentic OS. The manifest (.agentic-os-sync.json) lists each skill's source and what was withheld.\n",
      );
    manifest.updatedAt = now().toISOString();
    writeFileLf(join(categoryDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  }
  const count = (o: SyncOutcome[]) => results.filter((r) => o.includes(r.outcome)).length;
  const report: SyncReport = {
    dryRun,
    hermesSkillsDir: skillsDir,
    category: SYNC_CATEGORY,
    backup,
    results,
    skipped,
    orphaned,
    counts: {
      added: count(["added", "would-add"]),
      updated: count(["updated", "would-update"]),
      unchanged: count(["unchanged"]),
      kept: count(["kept-hermes-edit"]),
      skipped: skipped.length,
    },
    finishedAt: now().toISOString(),
  };
  if (!dryRun) {
    try {
      mkdirSync(categoryDir, { recursive: true });
      writeFileLf(join(categoryDir, REPORT_NAME), JSON.stringify(report, null, 2) + "\n");
    } catch {
      /* the returned report still says what happened */
    }
  }
  return report;
}

/** The last real run's report (what the Hermes page shows), or null before the first sync. */
export function readLastReport(hermesHome: string): SyncReport | null {
  try {
    return JSON.parse(readFileSync(join(hermesHome, "skills", SYNC_CATEGORY, REPORT_NAME), "utf-8")) as SyncReport;
  } catch {
    return null;
  }
}
