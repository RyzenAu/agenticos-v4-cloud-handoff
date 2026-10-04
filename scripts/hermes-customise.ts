// Customise Hermes from the command line (W-C, 29 Sep 2026). The Hermes page's buttons run this.
//
//   bun run scripts/hermes-customise.ts skills  [--dry-run] [--json]   copy Claude Code skills into Hermes
//   bun run scripts/hermes-customise.ts profile [--dry-run] [--json]   refresh the owner profile in USER.md
//
// Paths: HERMES_HOME (else ~/.hermes), ~/.claude, MU_WIKI_ROOT (else ~/source/repos/mu-ventures-obsidian-wiki).
// Nothing is printed from any .env, key or credential file; skills never copy them.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hermesHomeDir } from "./hermes/fast-status";
import { syncSkillsToHermes } from "./hermes/skill-sync";
import { hermesMemoryScan, ownerProfileState, writeOwnerProfile } from "./hermes/owner-profile";
import { runCapture } from "./nonblocking-exec";
import { existsSync, realpathSync } from "node:fs";
import { guardVaultRoot } from "./memory/synthetic-guard";

export function customiseRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return {
    hermesHome: hermesHomeDir(env, home),
    claudeHome: join(home, ".claude"),
    // A synthetic (test) hub never reads the real vault (round 10): refused and replaced by its own synthetic one.
    wikiRoot: guardVaultRoot((env.MU_WIKI_ROOT ?? "").trim() || join(home, "source", "repos", "mu-ventures-obsidian-wiki"), env).root,
    claudeMdPath: join(home, ".claude", "CLAUDE.md"),
  };
}

/** Hermes' install (the folder holding hermes_cli/ and venv/), for its own memory scan. */
export function hermesAgentDir(hermesHome: string, binPath?: string | null): string {
  const fromBin = binPath ? join(dirname(dirname(binPath)), "hermes-agent") : "";
  if (fromBin && existsSync(join(fromBin, "tools"))) return fromBin;
  const home = existsSync(hermesHome) ? realpathSync(hermesHome) : hermesHome;
  return join(home, "hermes-agent");
}

export async function runProfile(roots: ReturnType<typeof customiseRoots>, dryRun: boolean, binPath?: string | null) {
  const state = ownerProfileState(roots);
  if (dryRun) return { dryRun: true, ok: true, changed: false, state };
  const findings = await hermesMemoryScan(state.proposed, hermesAgentDir(roots.hermesHome, binPath), (file, args, input) =>
    runCapture(file, args, { input, timeout: 30_000 }),
  );
  const flagged = findings?.find((f) => f);
  if (flagged) return { dryRun: false, ok: false, changed: false, error: `Hermes' memory scan refused the profile: ${flagged}`, state };
  const res = writeOwnerProfile(roots);
  return { dryRun: false, ...res, scanned: findings !== null };
}

if (import.meta.main) {
  const [cmd, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const json = flags.includes("--json");
  const roots = customiseRoots();
  if (cmd === "skills") {
    const report = syncSkillsToHermes({ claudeHome: roots.claudeHome, hermesHome: roots.hermesHome, dryRun });
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`${dryRun ? "Dry run" : "Synced"} into ${report.hermesSkillsDir}\\${report.category}`);
      console.log(`added ${report.counts.added} · updated ${report.counts.updated} · unchanged ${report.counts.unchanged} · kept Hermes edits ${report.counts.kept} · skipped ${report.counts.skipped}`);
      if (report.backup) console.log(`backup: ${report.backup}`);
      for (const r of report.results) if (r.outcome !== "unchanged") console.log(`  ${r.outcome.padEnd(16)} ${r.name} (${r.files} files${r.withheld.length ? `, ${r.withheld.length} withheld` : ""})`);
      for (const s of report.skipped) console.log(`  skipped          ${s.name} [${s.origin}]: ${s.reason}`);
      for (const o of report.orphaned) console.log(`  left in Hermes   ${o} (source gone or now skipped)`);
    }
  } else if (cmd === "profile") {
    const res = await runProfile(roots, dryRun);
    if (json) console.log(JSON.stringify(res));
    else {
      console.log(res.ok ? (res.changed ? "USER.md updated" : dryRun ? "Dry run" : "Already up to date") : `Not written: ${"error" in res ? res.error : ""}`);
      console.log(`${res.state.path}: ${res.state.usageAfter}/${res.state.limit} chars after refresh`);
      for (const e of res.state.proposed) console.log(`\n${e}`);
      for (const w of res.state.warnings) console.log(`warning: ${w}`);
    }
    if (!res.ok) process.exitCode = 1;
  } else {
    console.log("usage: bun run scripts/hermes-customise.ts <skills|profile> [--dry-run] [--json]");
    process.exitCode = 2;
  }
}
