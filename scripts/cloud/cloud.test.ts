import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crmPath, goal, openCrm, setGoal } from "../leads/crm";
import { JobService } from "../jobs/service";
import { storePaths } from "../jobs/runtime";
import { resolveMemorySettings } from "../memory/settings";
import { DeviceStore } from "../devices/store";
import { dataDirFor, dataDirOverride } from "./data-dir";
import { hubRole, hubRoleGate, pcOnlyCapabilityFor, PC_ONLY_CAPABILITIES } from "./hub-role";
import { collectHealth } from "./health";
import { backupDataDir, MANIFEST_NAME, pruneBackups, readManifest, restoreBackup, verifyAgainstManifest } from "./backup";

// Temp data lives on D: (the C: drive is nearly full); falls back to the OS temp dir elsewhere.
const TMP_BASE = existsSync("D:/") ? "D:/tmp" : undefined;
let work: string;
beforeEach(() => {
  if (TMP_BASE) mkdirSync(TMP_BASE, { recursive: true });
  work = mkdtempSync(join(TMP_BASE ?? require("node:os").tmpdir(), "mu-cloud-"));
});
afterEach(() => {
  delete process.env.MU_DATA_DIR;
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows keeps a just-closed SQLite file locked until GC; the folder is under D:/tmp */
  }
});

const norm = (p: string) => p.replace(/\\/g, "/");

describe("MU_DATA_DIR", () => {
  test("unset or blank: the default is <root>/.operator-data, exactly as before", () => {
    expect(norm(dataDirFor("/repo", {}))).toBe("/repo/.operator-data");
    expect(norm(dataDirFor("/repo", { MU_DATA_DIR: "   " }))).toBe("/repo/.operator-data");
    expect(dataDirOverride({})).toBeNull();
  });

  test("set: every root maps to the override", () => {
    expect(norm(dataDirFor("/repo", { MU_DATA_DIR: "/srv/mu/data" }))).toMatch(/\/srv\/mu\/data$/);
    expect(dataDirFor("/repo-a", { MU_DATA_DIR: "/srv/x" })).toBe(dataDirFor("/repo-b", { MU_DATA_DIR: "/srv/x" }));
  });

  test("default behaviour unchanged for the real stores", () => {
    delete process.env.MU_DATA_DIR;
    const root = join(work, "repo");
    expect(norm(crmPath(root))).toBe(`${norm(root)}/.operator-data/crm.sqlite`);
    expect(norm(storePaths(root).jobs)).toBe(`${norm(root)}/.operator-data/jobs.sqlite`);
    expect(norm(storePaths(root).approvals)).toBe(`${norm(root)}/.operator-data/approvals.sqlite`);
    expect(norm(resolveMemorySettings({}, root).stateDir)).toBe(`${norm(root)}/.operator-data/memory`);
    expect(norm(new DeviceStore(root)["file"])).toBe(`${norm(root)}/.operator-data/devices.json`);
  });

  test("with the override every store follows it", () => {
    const data = join(work, "data");
    process.env.MU_DATA_DIR = data;
    const root = join(work, "repo");
    for (const p of [crmPath(root), storePaths(root).jobs, storePaths(root).approvals, new DeviceStore(root)["file"], new DeviceStore(root)["secretFile"]])
      expect(norm(p).startsWith(norm(data) + "/")).toBe(true);
    expect(norm(resolveMemorySettings(process.env, root).stateDir)).toBe(`${norm(data)}/memory`);
    expect(existsSync(join(root, ".operator-data"))).toBe(false);
  });
});

describe("MU_HUB_ROLE", () => {
  test("default and unknown values are the PC", () => {
    expect(hubRole({})).toBe("pc");
    expect(hubRole({ MU_HUB_ROLE: "pc" })).toBe("pc");
    expect(hubRole({ MU_HUB_ROLE: "banana" })).toBe("pc");
    expect(hubRole({ MU_HUB_ROLE: " Cloud " })).toBe("cloud");
  });

  function run(role: "pc" | "cloud", url: string) {
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: string) { this.body = b ?? ""; } };
    let nexted = false;
    hubRoleGate(role)({ url } as never, res as never, () => { nexted = true; });
    return { res, nexted };
  }

  test("PC role: every request passes through untouched", () => {
    expect(PC_ONLY_CAPABILITIES.length).toBeGreaterThan(3);
    expect(run("pc", "/__operator/pc/act").nexted).toBe(true);
    expect(run("pc", "/__claude_chat").nexted).toBe(true);
    expect(run("pc", "/__operator/screen/act").res.statusCode).toBe(200);
  });

  test("cloud role: PC-only routes answer 501 needs-companion, never a success shape", () => {
    for (const url of ["/__operator/screen/act", "/__operator/pc/act?x=1", "/__operator/browser/act", "/__operator/agent-jobs/status", "/__claude_chat", "/__hermes_status", "/__cline/v1/models", "/__start_voice", "/__trigger_dream"]) {
      const { res, nexted } = run("cloud", url);
      expect([url, nexted]).toEqual([url, false]);
      expect(res.statusCode).toBe(501);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.status).toBe("needs-companion");
      expect(body.error).toMatch(/runs on your PC/i);
      expect(body.error).toMatch(/companion/i);
    }
  });

  test("cloud role: business routes keep working", () => {
    for (const url of ["/__operator/leads", "/__operator/coding/jobs", "/__jobs", "/__approvals/abc", "/__memory/buckets", "/__receptionist/dashboard", "/__finance_manual/status", "/__devices/me", "/__health", "/__version", "/__operator/state"]) {
      expect([url, run("cloud", url).nexted]).toEqual([url, true]);
      expect(pcOnlyCapabilityFor(url.split("?")[0])).toBeNull();
    }
  });
});

/** A synthetic data directory: real store classes, fake rows, no live data. */
function seed(dir: string) {
  mkdirSync(join(dir, "coding"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const crm = openCrm(join(dir, "crm.sqlite"));
  setGoal(crm, "usman", 5);
  setGoal(crm, "mehroz", 7);
  crm.close();
  const jobs = new JobService({ path: join(dir, "jobs.sqlite") });
  const principal = { personId: "usman", via: "loopback-owner", actor: "human" } as const;
  jobs.create({ kind: "voice", principal, targetDeviceId: "usman-pc", title: "Synthetic job one" });
  jobs.create({ kind: "voice", principal, targetDeviceId: "usman-pc", title: "Synthetic job two" });
  jobs.close?.();
  const misc = new Database(join(dir, "coding", "coding.sqlite"), { create: true });
  misc.run("CREATE TABLE runs (id INTEGER PRIMARY KEY, note TEXT)");
  for (let i = 0; i < 25; i++) misc.run("INSERT INTO runs (note) VALUES (?)", [`row ${i}`]);
  misc.close();
  writeFileSync(join(dir, "people.json"), JSON.stringify({ people: [{ id: "usman" }, { id: "mehroz" }] }));
  writeFileSync(join(dir, "cache", "junk.json"), "{}"); // excluded: a cache
}

describe("backup and restore", () => {
  test("backup -> restore into an isolated temp dir -> stores open with identical row counts", () => {
    const live = join(work, "live");
    seed(live);
    // Keep a writer connection open with WAL pending, like a running hub.
    const writer = new Database(join(live, "coding", "coding.sqlite"));
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("INSERT INTO runs (note) VALUES ('written just before the backup')");

    const { dir, manifest } = backupDataDir({ dataDir: live, outRoot: join(work, "backups"), gitSha: "abc1234", hubRole: "cloud" });
    writer.close();

    expect(manifest.files.map((f) => f.path).sort()).toEqual(["coding/coding.sqlite", "crm.sqlite", "jobs.sqlite", "people.json"]);
    expect(manifest.files.some((f) => f.path.startsWith("cache/"))).toBe(false);
    expect(manifest.files.every((f) => !/-(wal|shm)$/.test(f.path))).toBe(true);
    expect(readdirSync(dir).includes(MANIFEST_NAME)).toBe(true);
    const coding = manifest.files.find((f) => f.path === "coding/coding.sqlite")!;
    expect(coding.tables?.runs).toBe(26); // the WAL row is in the snapshot
    expect(verifyAgainstManifest(readManifest(dir), dir).ok).toBe(true);

    const restored = join(work, "restored");
    const r = restoreBackup({ backupDir: dir, targetDir: restored });
    expect(r.verified.ok).toBe(true);
    expect(r.stores.length).toBe(manifest.totals.sqliteStores);
    expect(r.stores.every((s) => s.matches)).toBe(true);

    // The hub's own store classes open the restored copy through MU_DATA_DIR.
    process.env.MU_DATA_DIR = restored;
    const crm = openCrm(crmPath("/anywhere"));
    expect(goal(crm, "usman")).toBe(5);
    expect(goal(crm, "mehroz")).toBe(7);
    crm.close();
    const jobs = new JobService({ path: storePaths("/anywhere").jobs, readOnly: true });
    expect(jobs.list().length).toBe(2);
    jobs.close();
    expect(readFileSync(join(restored, "people.json"), "utf8")).toContain("mehroz");
  });

  test("restore refuses a non-empty target and never touches it", () => {
    const live = join(work, "live");
    seed(live);
    const { dir } = backupDataDir({ dataDir: live, outRoot: join(work, "backups") });
    expect(() => restoreBackup({ backupDir: dir, targetDir: live })).toThrow(/not empty/);
    expect(() => restoreBackup({ backupDir: dir, targetDir: join(dir, "inside") })).toThrow(/separate/);
  });

  test("a tampered backup is refused before anything is written", () => {
    const live = join(work, "live");
    seed(live);
    const { dir } = backupDataDir({ dataDir: live, outRoot: join(work, "backups") });
    writeFileSync(join(dir, "people.json"), "{\"tampered\":true}");
    const target = join(work, "restored");
    expect(() => restoreBackup({ backupDir: dir, targetDir: target })).toThrow(/verification/);
    expect(existsSync(target)).toBe(false);
  });

  test("refuses to write a backup inside the data directory; prune keeps the newest", () => {
    const live = join(work, "live");
    seed(live);
    expect(() => backupDataDir({ dataDir: live, outRoot: join(live, "b") })).toThrow(/inside/);
    const out = join(work, "backups");
    for (let i = 0; i < 3; i++) backupDataDir({ dataDir: live, outRoot: out, now: () => new Date(Date.UTC(2026, 9, 1, 3, 0, i)) });
    expect(pruneBackups(out, 2).length).toBe(1);
    expect(readdirSync(out).length).toBe(2);
  });
});

describe("/__health", () => {
  const okFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const downFetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  const base = { version: async () => ({ version: "9.9.9", gitSha: "abc1234", dirty: false, buildTime: "" }), jobs: () => ({ owner: true }), companions: () => ({ online: 1, total: 2 }) };

  test("healthy cloud hub: every component ok, versions and role reported", async () => {
    const data = join(work, "data");
    seed(data);
    const h = await collectHealth({ ...base, root: work, env: { MU_DATA_DIR: data, MU_HUB_ROLE: "cloud", HINDSIGHT_URL: "http://127.0.0.1:8878" }, fetchImpl: okFetch });
    expect(h.status).toBe("ok");
    expect(h.hubRole).toBe("cloud");
    expect(h.gitSha).toBe("abc1234");
    expect(h.dataDir.writable).toBe(true);
    expect(h.components.companions.online).toBe(1);
    expect(h.components.stores.stores.find((s) => s.name === "crm.sqlite")?.status).toBe("ok");
    expect(h.pcOnly.every((c) => c.status === "runs-on-your-pc")).toBe(true);
    expect(h.failed).toEqual([]);
    expect(JSON.stringify(h)).not.toMatch(/token|secret|password|api.?key/i);
  });

  test("Hindsight down: degraded with a recovery hint", async () => {
    const data = join(work, "data");
    seed(data);
    const h = await collectHealth({ ...base, root: work, env: { MU_DATA_DIR: data }, fetchImpl: downFetch });
    expect(h.status).toBe("degraded");
    expect(h.hubRole).toBe("pc");
    expect(h.failed[0].component).toBe("hindsight");
    expect(h.failed[0].recovery.length).toBeGreaterThan(10);
  });

  test("a store that will not open is a failed component with a restore hint", async () => {
    const data = join(work, "data");
    seed(data);
    writeFileSync(join(data, "finance.sqlite"), "this is not a database, just text padding ".repeat(20));
    const h = await collectHealth({ ...base, root: work, env: { MU_DATA_DIR: data, HINDSIGHT_URL: "off" }, fetchImpl: okFetch });
    expect(h.status).toBe("failed");
    expect(h.failed.map((f) => f.component)).toContain("stores");
    expect(h.components.stores.detail).toContain("finance.sqlite");
    expect(h.components.stores.recovery).toMatch(/restore/i);
  });

  test("a quiet read-only copy with no job stores yet is degraded, not failed", async () => {
    const data = join(work, "data");
    mkdirSync(data, { recursive: true });
    const h = await collectHealth({ ...base, jobs: () => { throw new Error("The job and approval stores aren't created yet"); }, root: work, env: { MU_DATA_DIR: data, AGENTIC_OS_NO_BACKGROUND: "1", HINDSIGHT_URL: "off" }, fetchImpl: okFetch });
    expect(h.components.jobsWorker.status).toBe("degraded");
    expect(h.status).toBe("degraded");
  });

  test("an unwritable data dir is reported as failed", async () => {
    const blocker = join(work, "afile");
    writeFileSync(blocker, "x");
    const h = await collectHealth({ ...base, root: work, env: { MU_DATA_DIR: join(blocker, "sub"), HINDSIGHT_URL: "off" }, fetchImpl: okFetch });
    expect(h.dataDir.writable).toBe(false);
    expect(h.components.dataDir.status).toBe("failed");
    expect(h.status).toBe("failed");
  });
});

describe("deploy folder", () => {
  const root = join(import.meta.dir, "..", "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const all = files(join(root, "deploy"));

  test("shell scripts are syntactically valid bash with LF endings", () => {
    for (const f of all.filter((p) => p.endsWith(".sh"))) {
      const text = readFileSync(f, "utf8");
      expect([f, text.includes("\r")]).toEqual([f, false]);
      expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
      const r = Bun.spawnSync(["bash", "-n", f.split("\\").join("/")]);
      if (r.exitCode !== 0 && /not found|cannot find/i.test(String(r.stderr))) continue; // no bash on this machine
      expect([f, r.exitCode]).toEqual([f, 0]);
    }
  });

  test("the unit runs one cloud-role process under bun --bun with its own data dir, tailnet-only", () => {
    const unit = readFileSync(join(root, "deploy/systemd/mu-hub@.service"), "utf8");
    expect(unit).toContain("Environment=MU_HUB_ROLE=cloud");
    expect(unit).toContain("Environment=MU_DATA_DIR=/var/lib/mu-hub/%i");
    expect(unit).toMatch(/ExecStart=\/opt\/mu-hub\/bun\/bin\/bun --bun node_modules\/vite\/bin\/vite\.js dev --port \$\{ARGENTIC_PORT\} --strictPort/);
    expect(unit).toContain("User=muhub");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).not.toMatch(/--host/); // the app binds loopback itself; Serve is the only way in
  });

  test("staging and production differ in port and data dir; no example holds a secret value", () => {
    const prod = readFileSync(join(root, "deploy/env/production.env.example"), "utf8");
    const stag = readFileSync(join(root, "deploy/env/staging.env.example"), "utf8");
    expect(prod).toContain("ARGENTIC_PORT=8081");
    expect(stag).toContain("ARGENTIC_PORT=8082");
    expect(stag).toContain("MU_MEMORY_WRITES=off");
    for (const text of [prod, stag]) {
      for (const line of text.split("\n").filter((l) => /^[A-Z_]+=/.test(l))) {
        const [k, v] = [line.split("=")[0], line.slice(line.indexOf("=") + 1)];
        expect(["MU_HUB_ROLE", "ARGENTIC_PORT", "MU_MEMORY_WRITES", "HINDSIGHT_URL", "HINDSIGHT_BANK", "MU_WIKI_ROOT"]).toContain(k);
        expect(v).not.toMatch(/sk-|xox|AKIA|Bearer/);
      }
    }
    expect(readFileSync(join(root, "deploy/tailscale/serve.sh"), "utf8")).not.toMatch(/^\s*(?:exec\s+)?tailscale funnel\b/m);
  });

  test("no deploy file embeds a credential or a real env file", () => {
    for (const f of all) {
      expect(f.split("\\").join("/")).not.toMatch(/(^|\/)\.env(\.|$)/);
      expect(readFileSync(f, "utf8")).not.toMatch(/sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|tskey-/);
    }
  });

  test("a git-archive release reports its SHA from RELEASE_SHA", async () => {
    const { createVersionInfo } = await import("../version");
    writeFileSync(join(work, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(work, "RELEASE_SHA"), "0123456789abcdef0123456789abcdef01234567\n");
    const info = await createVersionInfo(work, async () => "")();
    expect(info.gitSha).toBe("0123456");
    expect(info.version).toBe("1.2.3");
  });
});

describe("cloud role keeps the Jarvis command path (lead fix, 1 Oct)", () => {
  test("/screen/command and its attach/cancel stay mounted; direct PC control stays blocked", async () => {
    const { pcOnlyCapabilityFor } = await import("./hub-role");
    for (const p of ["/__operator/screen/command", "/__operator/screen/command/attach", "/__operator/screen/command/cancel"])
      expect(pcOnlyCapabilityFor(p)).toBeNull();
    for (const p of ["/__operator/screen/act", "/__operator/pc/act", "/__operator/open-url"]) expect(pcOnlyCapabilityFor(p)?.id).toBe("windows-control");
  });
});
