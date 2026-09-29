import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCodexJob } from "../agent-jobs-codex";
import { approvalFile, ensureCodexIsolation, missingReason, pathReason, readApproval, ROLLBACK_RECORD_STUCK } from "./codex-isolation";
import { applyDenyAcls, applyIsolation, checkCodexIsolation, childDenied, rollbackIsolation, explicitlyDenied, isolationRefusal, parseIcacls, parseIcaclsTree, planDenyAcls, planRollback, protectedPaths, rollbackDenyAcls, workspaceUnderProtected, worktreeRefusal } from "./codex-isolation";
import { cleanup, tempRoot } from "./test-fixtures";

/** A SYNTHETIC home: credential-shaped files with fake contents. Nothing here reads the real profile or runs Codex. */
const root = tempRoot("coding-isolation-");
const home = join(root, "home");
const live = join(root, "live-os");
for (const d of [join(home, ".claude-os"), join(home, ".codex", "secrets"), join(home, ".claude"), join(home, ".config"), join(home, "AppData", "Local", "hermes"), join(live, ".operator-data")]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, ".claude-os", "dev-token"), "synthetic");
writeFileSync(join(home, ".codex", "auth.json"), "{}");
writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
writeFileSync(join(home, ".config", "agentic-os.env"), "X=synthetic");
writeFileSync(join(home, ".git-credentials"), "https://user:synthetic@example.invalid");
writeFileSync(join(live, ".env"), "SYNTHETIC=1");
writeFileSync(join(live, ".env.example"), "EXAMPLE=1");
const env = { LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming") };
afterAll(() => cleanup(root));

const ALLOW_ONLY = (p: string) => `${p} DESKTOP-X\\CodexSandboxUsers:(OI)(CI)(RX)\n    NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\n    DESKTOP-X\\Usman:(I)(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
const DENIED = (p: string) => `${p} DESKTOP-X\\CodexSandboxUsers:(DENY)(OI)(CI)(R)\n    DESKTOP-X\\CodexSandboxUsers:(OI)(CI)(RX)\n    DESKTOP-X\\Usman:(I)(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
const INHERITED_DENY = (p: string) => `${p} DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)\n    DESKTOP-X\\CodexSandboxUsers:(RX)\n\nSuccessfully processed 1 files\n`;

describe("A1-6: Codex sandbox isolation (synthetic home)", () => {
  test("the protected list covers the OS secret dir, CLI logins, Hermes, provider keys and the live .env/.operator-data", async () => {
    const paths = protectedPaths({ home, env, liveRoot: live }).map((p) => p.path);
    for (const want of [join(home, ".claude-os"), join(home, ".codex", "auth.json"), join(home, ".codex", "secrets"), join(home, ".claude", ".credentials.json"), join(home, "AppData", "Local", "hermes"), join(home, ".config", "agentic-os.env"), join(home, ".git-credentials"), join(live, ".operator-data"), join(live, ".env")])
      expect(paths).toContain(want);
    expect(paths).not.toContain(join(live, ".env.example"));
  });
  test("icacls parsing: explicit deny passes; allow-only and inherited deny fail", async () => {
    const p = "C:\\x";
    expect(explicitlyDenied(parseIcacls(DENIED(p), p))).toBe(true);
    expect(explicitlyDenied(parseIcacls(ALLOW_ONLY(p), p))).toBe(false);
    expect(explicitlyDenied(parseIcacls(INHERITED_DENY(p), p))).toBe(false);
    expect(explicitlyDenied(parseIcacls(`${p} DESKTOP-X\\CodexSandboxUsers:(OI)(CI)(N)\n`, p))).toBe(true);
  });
  test("a Codex role is refused while any credential path lacks the explicit deny (the audit's live state)", async () => {
    const report = (await checkCodexIsolation({ home, env, liveRoot: live, platform: "win32", readAcl: ALLOW_ONLY }));
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(report.checked);
    expect(report.remedy[0]).toContain("/deny CodexSandboxUsers:");
    expect(isolationRefusal(report)).toContain("A1-6");
  });
  test("it passes once every path explicitly denies the sandbox group", async () => {
    expect((await checkCodexIsolation({ home, env, liveRoot: live, platform: "win32", readAcl: DENIED })).ok).toBe(true);
    // An unreadable ACL fails closed.
    expect((await checkCodexIsolation({ home, env, liveRoot: live, platform: "win32", readAcl: () => null })).ok).toBe(false);
  });
  test("a Codex workspace inside a protected tree is refused", async () => {
    expect(workspaceUnderProtected(join(home, ".claude-os", "work"), { home, env })?.path).toBe(join(home, ".claude-os"));
    expect(workspaceUnderProtected(join(root, "wt", "coding-abc123-builder-1"), { home, env })).toBeNull();
  });
  test("the C1 agent-jobs Codex path refuses to start when isolation fails (no process is spawned)", async () => {
    let spawned = false;
    const events: unknown[] = [];
    const job = startCodexJob(
      { cwd: join(root, "task"), prompt: "x", signal: new AbortController().signal, onEvent: (e) => events.push(e) },
      { binary: "C:/fake/codex.exe", launch: (() => { spawned = true; throw new Error("no"); }) as never, isolation: () => ({ ok: false, message: "Codex roles are paused (A1-6)." }) },
    );
    await job.done;
    expect(spawned).toBe(false);
    expect(JSON.stringify(events)).toContain("A1-6");
  });
  test.skipIf(process.platform !== "win32")("apply on a SYNTHETIC folder adds an explicit deny that the check then sees (real icacls, no Codex)", async () => {
    const hasGroup = spawnSync("net", ["localgroup", "CodexSandboxUsers"], { windowsHide: true }).status === 0;
    if (!hasGroup) return; // the group exists only where Codex's elevated sandbox was set up
    const synthetic = join(root, "acl-home");
    mkdirSync(join(synthetic, ".claude-os"), { recursive: true });
    writeFileSync(join(synthetic, ".git-credentials"), "synthetic");
    const paths = protectedPaths({ home: synthetic, env: { LOCALAPPDATA: join(synthetic, "L"), APPDATA: join(synthetic, "R") } });
    expect(paths.length).toBe(2);
    expect((await checkCodexIsolation({ home: synthetic, env: { LOCALAPPDATA: join(synthetic, "L"), APPDATA: join(synthetic, "R") } })).ok).toBe(false);
    expect(planDenyAcls(paths)).toHaveLength(2);
    expect((await applyDenyAcls(paths)).every((r) => r.ok)).toBe(true);
    expect((await checkCodexIsolation({ home: synthetic, env: { LOCALAPPDATA: join(synthetic, "L"), APPDATA: join(synthetic, "R") } })).ok).toBe(true);
    // --rollback removes exactly those Deny entries again, and the check fails closed once more.
    expect(planRollback(paths)[0]).toContain("/remove:d CodexSandboxUsers");
    expect((await rollbackDenyAcls(paths)).every((r) => r.ok)).toBe(true);
    expect((await checkCodexIsolation({ home: synthetic, env: { LOCALAPPDATA: join(synthetic, "L"), APPDATA: join(synthetic, "R") } })).ok).toBe(false);
  }, 60_000);
});

describe("A1-6 follow-ups (REVIEW-T3): children, rollback, live checkout only", () => {
  const kidsHome = join(root, "kids-home");
  const ssh = join(kidsHome, ".ssh");
  mkdirSync(join(ssh, "keys"), { recursive: true });
  writeFileSync(join(ssh, "id_synthetic"), "synthetic");
  writeFileSync(join(ssh, "keys", "deploy key"), "synthetic");
  const kidsEnv = { LOCALAPPDATA: join(kidsHome, "L"), APPDATA: join(kidsHome, "R") };
  const block = (p: string, aces: string[]) => `${p} ${aces[0]}\n${aces.slice(1).map((a) => " ".repeat(p.length + 1) + a).join("\n")}\n`;
  const tree = (childAces: (p: string) => string[]) => (dir: string) =>
    [block(dir, ["DESKTOP-X\\CodexSandboxUsers:(DENY)(OI)(CI)(R)"]), ...[join(ssh, "id_synthetic"), join(ssh, "keys"), join(ssh, "keys", "deploy key")].map((p) => block(p, childAces(p)))].join("\n") + "\nSuccessfully processed 4 files; Failed processing 0 files\n";

  test("icacls tree output is split per path, including paths with spaces", async () => {
    const out = tree(() => ["DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)", "NT AUTHORITY\\SYSTEM:(I)(F)"])(ssh);
    const acls = parseIcaclsTree(out, [ssh, join(ssh, "id_synthetic"), join(ssh, "keys"), join(ssh, "keys", "deploy key")]);
    expect(acls.has("")).toBe(false);
    expect(childDenied(acls.get(join(ssh, "keys", "deploy key"))!)).toBe(true);
    // An unknown block (a file that appeared after the walk) is kept apart so the check fails closed.
    expect(parseIcaclsTree(out, [ssh]).has("")).toBe(true);
  });
  test("a child that inherits the folder's Deny passes; one with its own Allow, or inheritance off, is caught", async () => {
    const base = { home: kidsHome, env: kidsEnv, platform: "win32" as const, readAcl: DENIED };
    expect((await checkCodexIsolation({ ...base, readTreeAcl: tree(() => ["DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)", "NT AUTHORITY\\SYSTEM:(I)(F)"]) })).ok).toBe(true);
    const allowed = (await checkCodexIsolation({ ...base, readTreeAcl: tree((p) => p.endsWith("deploy key") ? ["DESKTOP-X\\CodexSandboxUsers:(RX)", "DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)"] : ["DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)"]) }));
    expect(allowed.ok).toBe(false);
    expect(allowed.missing.map((m) => m.path)).toEqual([join(ssh, "keys", "deploy key")]);
    expect(allowed.remedy.some((c) => c.includes("deploy key"))).toBe(true);
    const noInherit = (await checkCodexIsolation({ ...base, readTreeAcl: tree((p) => p.endsWith("id_synthetic") ? ["DESKTOP-X\\Usman:(F)"] : ["DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)"]) }));
    expect(noInherit.missing.map((m) => m.path)).toEqual([join(ssh, "id_synthetic")]);
    // An inherit-only Deny on a subfolder doesn't protect the subfolder itself.
    const ioOnly = (await checkCodexIsolation({ ...base, readTreeAcl: tree((p) => p.endsWith("keys") ? ["DESKTOP-X\\CodexSandboxUsers:(I)(OI)(CI)(IO)(DENY)(R)"] : ["DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)"]) }));
    expect(ioOnly.missing.map((m) => m.path)).toEqual([join(ssh, "keys")]);
    // Unreadable children fail closed.
    expect((await checkCodexIsolation({ ...base, readTreeAcl: () => null })).ok).toBe(false);
  });
  test("the CLI acts only from the live checkout: a worktree (.git is a file) is refused with the reason", async () => {
    const wt = join(root, "wt-cli");
    const liveCo = join(root, "live-cli");
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(liveCo, ".git"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: C:/somewhere/.git/worktrees/x\n");
    expect(worktreeRefusal(wt)).toContain("worktree");
    expect(worktreeRefusal(wt)).toContain("Nothing was changed");
    expect(worktreeRefusal(liveCo)).toBeNull();
    // And the real CLI, run from this worktree, refuses before reading or changing any ACL.
    const self = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "codex-isolation.ts"), "--rollback"], { encoding: "utf8", windowsHide: true });
    const here = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: import.meta.dir, encoding: "utf8", windowsHide: true }).stdout.trim();
    if (/[\\/]worktrees[\\/]/.test(here)) {
      expect(self.status).toBe(2);
      expect(self.stderr).toContain("not the live checkout");
    }
  }, 120_000);
});

describe("REVIEW-T3 R2: one --apply run, a complete --rollback (real icacls, SYNTHETIC home only)", () => {
  const hasGroup = process.platform === "win32" && spawnSync("net", ["localgroup", "CodexSandboxUsers"], { windowsHide: true }).status === 0;
  test.skipIf(!hasGroup)("known_hosts with inheritance off is denied in the same run; rollback removes every Deny and the check fails again", async () => {
    const synthetic = join(root, "r2-home");
    const env = { LOCALAPPDATA: join(synthetic, "L"), APPDATA: join(synthetic, "R") };
    mkdirSync(join(synthetic, ".ssh"), { recursive: true });
    writeFileSync(join(synthetic, ".ssh", "id_synthetic"), "synthetic");
    const knownHosts = join(synthetic, ".ssh", "known_hosts");
    writeFileSync(knownHosts, "synthetic.example ssh-ed25519 AAAA");
    writeFileSync(join(synthetic, ".git-credentials"), "synthetic");
    // Like OpenSSH hardening: known_hosts keeps only its own entries (no inherited ACEs).
    const me = spawnSync("whoami", [], { encoding: "utf8", windowsHide: true }).stdout.trim();
    expect(spawnSync("icacls", [knownHosts, "/inheritance:r", "/grant:r", `${me}:(F)`], { windowsHide: true }).status).toBe(0);
    const opts = { home: synthetic, env };
    expect((await checkCodexIsolation(opts)).ok).toBe(false);

    const applied = (await applyIsolation(opts));
    expect(applied.ok).toBe(true);
    expect(applied.rounds).toBeGreaterThanOrEqual(2); // the folder first, then the child that doesn't inherit
    expect(applied.results.map((r) => r.path)).toContain(knownHosts);
    expect((await checkCodexIsolation(opts)).ok).toBe(true);

    const rolled = (await rollbackIsolation(opts));
    expect(rolled.ok).toBe(true);
    for (const p of [join(synthetic, ".ssh"), join(synthetic, ".git-credentials")]) {
      const acl = spawnSync("icacls", [p, "/T"], { encoding: "utf8", windowsHide: true }).stdout;
      expect([p, /CodexSandboxUsers/i.test(acl)]).toEqual([p, false]);
    }
    expect((await checkCodexIsolation(opts)).ok).toBe(false);
  }, 120_000);
  test.skipIf(process.platform !== "win32")("a rollback that can't process a path reports failure (the CLI exits non-zero)", async () => {
    const gone = join(root, "r2-missing", ".git-credentials");
    const r = (await rollbackDenyAcls([{ path: gone, kind: "file", why: "synthetic" }]));
    expect(r).toEqual([{ path: gone, ok: false }]);
    expect(planRollback([{ path: join(root, ".ssh"), kind: "dir", why: "x" }])[0]).toContain("/remove:d CodexSandboxUsers /T /C");
  }, 60_000);
});

describe("T3e: a rewrite drops the Deny; the harness re-applies it (deny-only) on approved paths (real icacls, SYNTHETIC home only)", () => {
  const hasGroup = process.platform === "win32" && spawnSync("net", ["localgroup", "CodexSandboxUsers"], { windowsHide: true }).status === 0;
  const aclOf = (p: string) => spawnSync("icacls", [p], { encoding: "utf8", windowsHide: true }).stdout;
  const sandboxDenied = (p: string) => /CodexSandboxUsers:(?:\([^)]*\))*\(DENY\)/i.test(aclOf(p)) || /CodexSandboxUsers:\(DENY\)/i.test(aclOf(p));
  /** Claude Code's rewrite: a new temp file renamed over the original. */
  const rewrite = (file: string, content: string) => { const tmp = `${file}.tmp.${process.pid}`; writeFileSync(tmp, content); renameSync(tmp, file); };
  function home(name: string) {
    const h = join(root, name);
    mkdirSync(join(h, ".claude-os"), { recursive: true });
    writeFileSync(join(h, ".claude-os", "dev-token"), "synthetic");
    writeFileSync(join(h, ".claude.json"), "{}");
    return { h, opts: { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") } } };
  }

  test.skipIf(!hasGroup)("the mechanism: an in-place write keeps an explicit Deny; write-temp-then-rename loses it", async () => {
    const { h } = home("t3e-mechanism");
    const file = join(h, ".claude.json");
    expect((await applyDenyAcls([{ path: file, kind: "file", why: "synthetic" }]))[0].ok).toBe(true);
    expect(sandboxDenied(file)).toBe(true);
    writeFileSync(file, '{"inPlace":true}');
    expect(sandboxDenied(file)).toBe(true);
    rewrite(file, '{"renamed":true}');
    expect(sandboxDenied(file)).toBe(false);
  }, 120_000);

  test.skipIf(!hasGroup)("after --apply, a rewritten .claude.json is reported as rewritten and re-applied before Codex, deny-only", async () => {
    const { h, opts } = home("t3e-reapply");
    const file = join(h, ".claude.json");
    const applied = (await applyIsolation(opts));
    expect(applied.ok).toBe(true);
    const approval = readApproval(opts)!;
    expect(approval.paths.map((p) => p.toLowerCase())).toContain(file.toLowerCase());
    expect(existsSync(approvalFile(opts))).toBe(true);
    Bun.sleepSync(1100); // the rewrite is later than the approval
    rewrite(file, '{"numStartups":2}');
    const before = (await checkCodexIsolation(opts));
    expect(before.ok).toBe(false);
    expect(before.missing.map((m) => m.path)).toEqual([file]);
    expect(missingReason(file, approval)).toMatchObject({ rewritten: true });
    const otherAces = aclOf(file).split(/\r?\n/).map((l) => l.replace(/^.*?\s(?=\S+:\()/, "").trim()).filter((l) => /:\(/.test(l));
    const done = (await ensureCodexIsolation(opts));
    expect(done.ok).toBe(true);
    expect(done.reapplied).toEqual([{ path: file, ok: true, rewritten: true }]);
    expect(sandboxDenied(file)).toBe(true);
    // Deny-only: every entry that was there is still there.
    const after = aclOf(file);
    for (const ace of otherAces) expect([ace, after.includes(ace)]).toEqual([ace, true]);
    expect((await checkCodexIsolation(opts)).ok).toBe(true);
  }, 120_000);

  test.skipIf(!hasGroup)("nothing is re-applied without the owner's approval, on a path he didn't approve, or after --rollback", async () => {
    // No --apply ever: Codex stays paused, no ACL changes.
    const fresh = home("t3e-unapproved");
    const none = (await ensureCodexIsolation(fresh.opts));
    expect(none.ok).toBe(false);
    expect(none.reapplied).toEqual([]);
    expect(sandboxDenied(join(fresh.h, ".claude.json"))).toBe(false);
    expect(none.message).toContain("never protected");

    // Approved, then a NEW protected path appears: not auto-applied, the owner is asked.
    const { h, opts } = home("t3e-newpath");
    expect((await applyIsolation(opts)).ok).toBe(true);
    writeFileSync(join(h, ".git-credentials"), "synthetic");
    const newer = (await ensureCodexIsolation(opts));
    expect(newer.ok).toBe(false);
    expect(newer.reapplied).toEqual([]);
    expect(newer.message).toContain("not in the approved list");
    expect(sandboxDenied(join(h, ".git-credentials"))).toBe(false);

    // --rollback withdraws the approval, so a later rewrite is not re-applied.
    const rolled = home("t3e-rolledback");
    expect((await applyIsolation(rolled.opts)).ok).toBe(true);
    expect((await rollbackIsolation(rolled.opts)).ok).toBe(true);
    expect(readApproval(rolled.opts)).toBeNull();
    rewrite(join(rolled.h, ".claude.json"), "{}");
    const after = (await ensureCodexIsolation(rolled.opts));
    expect(after.reapplied).toEqual([]);
    expect(after.ok).toBe(false);
  }, 180_000);
});

describe("REVIEW-T3 R6: rollback is verified, the approval is re-read before each batch, links are never touched (SYNTHETIC home only)", () => {
  const hasGroup = process.platform === "win32" && spawnSync("net", ["localgroup", "CodexSandboxUsers"], { windowsHide: true }).status === 0;
  const aclOf = (p: string) => spawnSync("icacls", [p], { encoding: "utf8", windowsHide: true }).stdout;
  const denied = (p: string) => /CodexSandboxUsers:[^\n]*DENY/i.test(aclOf(p));
  const writeApproval = (h: string, paths: string[]) => {
    mkdirSync(join(h, ".claude-os"), { recursive: true });
    writeFileSync(approvalFile({ home: h }), JSON.stringify({ version: 1, group: "CodexSandboxUsers", approvedAt: new Date(Date.now() - 60_000).toISOString(), paths }));
  };

  test("R6-1: a rollback whose approval record can't be removed reports failure and names why (the CLI exits 1)", async () => {
    const h = join(root, "r6-stuck");
    writeApproval(h, [join(h, ".claude-os")]);
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") }, platform: "win32" as const };
    // The record is held open by another process: the delete doesn't happen.
    const done = await rollbackIsolation(opts, () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); });
    expect(done.recordGone).toBe(false);
    expect(done.ok).toBe(false);
    expect(done.message).toBe(ROLLBACK_RECORD_STUCK);
    expect(existsSync(approvalFile(opts))).toBe(true);
    // A delete that "succeeds" but leaves the file (another handle keeps it) is caught the same way.
    const quiet = await rollbackIsolation(opts, () => {});
    expect(quiet).toMatchObject({ ok: false, recordGone: false });
  });

  test("R6-1: a rollback during a preflight stops it at once: the approval is re-read right before the icacls batch", async () => {
    const h = join(root, "r6-midway");
    const file = join(h, ".claude.json");
    mkdirSync(h, { recursive: true });
    writeFileSync(file, "{}");
    writeApproval(h, [file, join(h, ".claude-os")]);
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") }, platform: "win32" as const };
    let reads = 0;
    const done = await ensureCodexIsolation({
      ...opts,
      // The check sees .claude.json without its Deny; meanwhile the owner's --rollback removes the record.
      readAcl: (p: string) => {
        reads++;
        if (reads === 1) rmSync(approvalFile(opts), { force: true });
        return p === file ? ALLOW_ONLY(p) : DENIED(p);
      },
      readTreeAcl: () => "",
    });
    expect(done.reapplied).toEqual([]);
    expect(done.ok).toBe(false);
  });

  test.skipIf(!hasGroup)("R6-1: a rollback between two re-apply batches stops the second one (the record is re-read before each batch)", async () => {
    const h = join(root, "r6-between");
    const ssh = join(h, ".ssh");
    const child = join(ssh, "id_synthetic");
    mkdirSync(ssh, { recursive: true });
    writeFileSync(child, "synthetic");
    writeApproval(h, [ssh, join(h, ".claude-os")]);
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") } };
    let checks = 0;
    const done = await ensureCodexIsolation({
      ...opts,
      // Round 1: .ssh itself lacks its Deny (re-applied for real, on the synthetic folder).
      // The re-check then finds a child that doesn't inherit it, while the owner's --rollback removes the record.
      readAcl: (p: string) => {
        if (p === ssh) { checks++; return checks === 1 ? ALLOW_ONLY(p) : DENIED(p); }
        return DENIED(p);
      },
      readTreeAcl: (dir: string) => {
        if (dir !== ssh) return readdirSync(dir).map((n) => `${join(dir, n)} DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)\n`).join("\n");
        rmSync(approvalFile(opts), { force: true });
        return `${dir} DESKTOP-X\\CodexSandboxUsers:(DENY)(OI)(CI)(R)\n\n${child} DESKTOP-X\\Usman:(F)\n\nSuccessfully processed 2 files; Failed processing 0 files\n`;
      },
    });
    expect(done.reapplied.map((r) => r.path)).toEqual([ssh]);
    expect(done.ok).toBe(false);
    expect(denied(child)).toBe(true); // inherited from .ssh's Deny, nothing explicit was added to it
    expect(/CodexSandboxUsers:\(DENY\)\(R\)/i.test(aclOf(child))).toBe(false);
    await rollbackDenyAcls([{ path: ssh, kind: "dir", why: "synthetic" }]);
  }, 120_000);

  test.skipIf(!hasGroup)("a hard link or junction planted inside a protected folder is named and never re-applied; the target outside gets no Deny", async () => {
    const h = join(root, "r6-links");
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") } };
    mkdirSync(join(h, ".ssh"), { recursive: true });
    writeFileSync(join(h, ".ssh", "id_synthetic"), "synthetic");
    writeFileSync(join(h, ".claude.json"), "{}");
    expect((await applyIsolation(opts)).ok).toBe(true);
    // Outside the approved set: a file and a folder.
    const outside = join(root, "r6-outside");
    mkdirSync(join(outside, "dir"), { recursive: true });
    writeFileSync(join(outside, "notes.txt"), "outside");
    linkSync(join(outside, "notes.txt"), join(h, ".ssh", "planted-hardlink"));
    expect(spawnSync("cmd", ["/c", "mklink", "/J", join(h, ".ssh", "planted-junction"), join(outside, "dir")], { windowsHide: true }).status).toBe(0);
    try {
      const done = await ensureCodexIsolation(opts);
      expect(done.ok).toBe(false);
      expect(done.reapplied.map((r) => r.path)).not.toContain(join(h, ".ssh", "planted-hardlink"));
      expect(done.links.map((l) => l.path)).toContain(join(h, ".ssh", "planted-hardlink"));
      expect(done.message).toContain("planted-hardlink is a hard link");
      expect(denied(join(outside, "notes.txt"))).toBe(false);
      expect(denied(join(outside, "dir"))).toBe(false);
    } finally {
      // Junction first (never recursive through it), then the rest.
      spawnSync("cmd", ["/c", "rmdir", join(h, ".ssh", "planted-junction")], { windowsHide: true });
      expect(existsSync(join(h, ".ssh", "planted-junction"))).toBe(false);
      await rollbackIsolation(opts);
    }
  }, 180_000);
});

describe("M1 (REVIEW-T3 R7 minors): a junction in .ssh is named; a stuck rollback leaves the Deny entries in place (SYNTHETIC home only)", () => {
  const hasGroup = process.platform === "win32" && spawnSync("net", ["localgroup", "CodexSandboxUsers"], { windowsHide: true }).status === 0;
  const aclOf = (p: string) => spawnSync("icacls", [p], { encoding: "utf8", windowsHide: true }).stdout;
  const denied = (p: string) => /CodexSandboxUsers:[^\n]*DENY/i.test(aclOf(p));
  const writeApproval = (h: string, paths: string[]) => {
    mkdirSync(join(h, ".claude-os"), { recursive: true });
    writeFileSync(approvalFile({ home: h }), JSON.stringify({ version: 1, group: "CodexSandboxUsers", approvedAt: new Date(Date.now() - 60_000).toISOString(), paths }));
  };
  /** A home whose .ssh holds a key and a junction to a NON-empty folder outside (icacls /T follows it). */
  function plantedHome(name: string) {
    const h = join(root, name);
    const ssh = join(h, ".ssh");
    const outside = join(root, `${name}-outside`);
    mkdirSync(join(ssh, "keys"), { recursive: true });
    mkdirSync(join(outside, "dir"), { recursive: true });
    writeFileSync(join(ssh, "id_synthetic"), "synthetic");
    writeFileSync(join(outside, "dir", "notes.txt"), "outside");
    const junction = join(ssh, "planted-junction");
    symlinkSync(join(outside, "dir"), junction, "junction");
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") } };
    /** Junction first (never recursive through it). */
    const unplant = () => { try { unlinkSync(junction); } catch { /* gone */ } expect(existsSync(junction)).toBe(false); };
    return { h, ssh, junction, outside, opts, unplant };
  }

  test("minor 1: the check names the junction, not the folder, and never plans an icacls through it", async () => {
    const { ssh, junction, opts, unplant } = plantedHome("m1-named");
    try {
      const treeReads: string[] = [];
      const report = await checkCodexIsolation({ ...opts, platform: "win32", readAcl: DENIED, readTreeAcl: (dir) => { treeReads.push(dir); return null; } });
      expect(report.ok).toBe(false);
      expect(report.unreadable).toEqual([]); // .ssh is no longer "unreadable"
      expect(report.missing).toEqual([{ path: junction, kind: "dir", why: `inside ${ssh} (SSH keys)`, link: "a junction or symlink" }]);
      expect(treeReads).not.toContain(ssh); // the tree read that followed the link never runs
      expect(report.remedy.some((c) => c.includes("planted-junction"))).toBe(false);
      const refusal = isolationRefusal(report);
      expect(refusal).toContain(`${junction} (a junction or symlink inside ${ssh} (SSH keys) that points elsewhere; it is never written through, so remove it)`);
      // .ssh itself isn't listed as a path the sandbox could read: only the junction is.
      expect(refusal).not.toContain(`could read ${ssh} (`);
      expect(refusal).not.toContain(`; ${ssh} (`);
      expect(refusal).not.toContain("can't be read");
      expect(pathReason(report.missing[0], null)).toContain("a junction or symlink");
      // The rest of .ssh is still checked, path by path: a key with inheritance off is caught beside the junction.
      const key = join(ssh, "id_synthetic");
      const both = await checkCodexIsolation({ ...opts, platform: "win32", readAcl: (p) => (p === key ? `${p} DESKTOP-X\\Usman:(F)\n` : DENIED(p)), readTreeAcl: () => null });
      expect(both.missing.map((m) => m.path).sort()).toEqual([junction, key].sort());
      expect(both.unreadable).toEqual([]);
      expect(both.remedy.some((c) => c.includes("id_synthetic"))).toBe(true);
    } finally { unplant(); }
  });

  test("minor 1: the preflight pauses Codex naming the junction, and neither it nor --apply writes through it", async () => {
    const { h, ssh, junction, opts, unplant } = plantedHome("m1-ensure");
    writeApproval(h, [ssh, join(h, ".claude-os")]);
    try {
      // Every other folder's children inherit its Deny; only the planted junction is wrong.
      const inherits = (dir: string) => readdirSync(dir).map((n) => `${join(dir, n)} DESKTOP-X\\CodexSandboxUsers:(I)(DENY)(R)\n`).join("\n");
      const fake = { ...opts, platform: "win32" as const, readAcl: DENIED, readTreeAcl: inherits };
      const done = await ensureCodexIsolation(fake);
      expect(done.ok).toBe(false);
      expect(done.reapplied).toEqual([]);
      expect(done.links).toEqual([{ path: junction, kind: "a junction or symlink", removeOnly: true }]);
      expect(done.message).toContain(`${junction} is a junction or symlink inside a protected folder and points elsewhere`);
      expect(done.message).toContain("Remove it; Codex stays paused while it's there.");
      expect(done.message).not.toContain("run --apply if it belongs there");
      const applied = await applyIsolation(fake);
      expect(applied.ok).toBe(false);
      expect(applied.results).toEqual([]); // nothing to apply but the link, and a link is never applied
    } finally { unplant(); }
  });

  test.skipIf(!hasGroup)("minor 1, real icacls: a junction to a non-empty folder outside is named; the target gets no Deny", async () => {
    const { h, junction, outside, opts, unplant } = plantedHome("m1-real");
    unplant(); // --apply first, on the clean home
    expect((await applyIsolation(opts)).ok).toBe(true);
    symlinkSync(join(outside, "dir"), junction, "junction");
    try {
      const done = await ensureCodexIsolation(opts);
      expect(done.ok).toBe(false);
      expect(done.report.unreadable.map((p) => p.path)).not.toContain(join(h, ".ssh"));
      expect(done.links.map((l) => l.path)).toEqual([junction]);
      expect(done.message).toContain("planted-junction is a junction or symlink");
      expect(done.reapplied).toEqual([]);
      expect(denied(join(outside, "dir"))).toBe(false);
      expect(denied(join(outside, "dir", "notes.txt"))).toBe(false);
    } finally {
      unplant();
      await rollbackIsolation(opts);
    }
  }, 180_000);

  test("minor 2: a rollback that can't remove the approval record removes no Deny entry and says so", async () => {
    const h = join(root, "m1-stuck-unit");
    writeApproval(h, [join(h, ".claude-os")]);
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") }, platform: "win32" as const };
    const done = await rollbackIsolation(opts, () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); });
    expect(done).toEqual({ ok: false, results: [], recordGone: false, message: ROLLBACK_RECORD_STUCK });
    expect(done.message).toContain("no Deny entry was removed");
    expect(done.message).toContain("run --rollback again");
  });

  test.skipIf(!hasGroup)("minor 2, real icacls: the Deny entries stay while the record is stuck, nothing is re-applied, and a full rollback then removes them", async () => {
    const h = join(root, "m1-stuck-real");
    mkdirSync(join(h, ".ssh"), { recursive: true });
    writeFileSync(join(h, ".ssh", "id_synthetic"), "synthetic");
    writeFileSync(join(h, ".claude.json"), "{}");
    const opts = { home: h, env: { LOCALAPPDATA: join(h, "L"), APPDATA: join(h, "R") } };
    expect((await applyIsolation(opts)).ok).toBe(true);
    const guarded = [join(h, ".ssh"), join(h, ".claude.json"), join(h, ".claude-os")];
    for (const p of guarded) expect([p, denied(p)]).toEqual([p, true]);

    const stuck = await rollbackIsolation(opts, () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); });
    expect(stuck).toMatchObject({ ok: false, recordGone: false, results: [] });
    for (const p of guarded) expect([p, denied(p)]).toEqual([p, true]);
    // State is consistent: the approval stands and so do its Deny entries, so the preflight has nothing to re-apply.
    const pre = await ensureCodexIsolation(opts);
    expect(pre.ok).toBe(true);
    expect(pre.reapplied).toEqual([]);

    const full = await rollbackIsolation(opts);
    expect(full.ok).toBe(true);
    expect(readApproval(opts)).toBeNull();
    for (const p of guarded) expect([p, denied(p)]).toEqual([p, false]);
  }, 180_000);
});