import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createArtifactStore } from "../computers/artifacts";
import { conversationStore, jarvisThreadId } from "../conversations";
import { CodingStore } from "../coding/store";
import { JobService } from "../jobs/service";
import { hostEnv, refusal, seedCold, seedLive } from "./seed-gate-hub";

const made: string[] = [];
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "gate-seed-"));
  made.push(root);
  return join(root, "data");
};
afterEach(() => {
  for (const d of made.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* sqlite handles close at GC on Windows */ }
});

describe("the gate seed refuses what it must", () => {
  test("a junction to a .operator-data folder, a folder that does not exist yet inside it, and the repository's own data folder are refused (real path, not the typed one)", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-seed-"));
    made.push(root);
    const real = join(root, ".operator-data");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link, "junction");
    expect(refusal(join(link, "gate"))).toMatch(/real data/); // not yet existing, reached through the junction
    expect(refusal(link)).toMatch(/real data/);
    expect(() => seedCold(join(link, "gate"), "none")).toThrow(/real data/);
    expect(existsSync(join(real, "gate"))).toBe(false); // nothing was created inside the real data
    expect(refusal(join(import.meta.dir, "..", "..", ".operator-data", "gate"))).toMatch(/real data/);
    // a junction to an ordinary empty folder is fine
    const ok = join(root, "ok");
    mkdirSync(ok);
    const okLink = join(root, "okLink");
    symlinkSync(ok, okLink, "junction");
    expect(refusal(join(okLink, "gate"))).toBeNull();
  });

  test("a Windows short name (OPERAT~1) for a .operator-data folder is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-seed-"));
    made.push(root);
    const real = join(root, ".operator-data");
    mkdirSync(real);
    const short = process.platform === "win32" ? spawnSync("cmd", ["/c", "for", "%I", "in", ("\"" + real + "\""), "do", "@echo", "%~sI"], { encoding: "utf8" }).stdout.trim() : "";
    if (!/~d/.test(short)) return; // 8.3 names are switched off on this volume: nothing to test
    expect(refusal(join(short, "gate"))).toMatch(/real data/);
  });

  test("the real .operator-data, anything inside it, and any folder that already has files", () => {
    expect(refusal("C:/x/AgenticOS-v4/.operator-data")).toMatch(/real data/);
    expect(refusal("C:/x/AgenticOS-v4/.operator-data/coding")).toMatch(/real data/);
    const dir = fresh();
    expect(refusal(dir)).toBeNull(); // does not exist yet: fine
    mkdirSync(dir, { recursive: true });
    expect(refusal(dir)).toBeNull(); // empty: fine
    writeFileSync(join(dir, "x.json"), "{}");
    expect(refusal(dir)).toMatch(/not empty/);
    expect(() => seedCold(dir, "none")).toThrow(/not empty/);
    expect(refusal(dir, "live")).toMatch(/this seed made/);
    expect(() => seedLive(dir)).toThrow(/this seed made/);
  });

  test("the host option writes only non-secret values, and nothing for 'none'", () => {
    expect(hostEnv("none")).toEqual({});
    expect(hostEnv("local-wsl")).toEqual({ MU_COMPUTERS_WSL_DISTRO: "kali-linux" });
    const r = hostEnv("ryzen", { remotePort: 18153, displayBase: 60 });
    expect(Object.keys(r).every((k) => k.startsWith("MU_COMPUTERS_"))).toBe(true);
    expect(r.MU_COMPUTERS_SSH_ALIAS).toBe("ryzen-bots");
    expect(JSON.stringify(r)).not.toMatch(/key|token|password|secret|BEGIN/i);
  });
});

describe("a seeded hub has what the gate needs to see", () => {
  test("jobs in each persistent state, saved results that open, a conversation with results, leads, coding jobs (one superseded), and the host file", () => {
    const dir = fresh();
    const before = process.env.MU_DATA_DIR;
    const r = seedCold(dir, "ryzen");
    expect(process.env.MU_DATA_DIR).toBe(before); // the environment is put back
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, readOnly: true });
    const states = new Set(jobs.list({ limit: 50 }).map((j) => j.state));
    for (const s of ["succeeded", "failed", "cancelled", "unknown", "interrupted"]) expect(states.has(s as never)).toBe(true);
    // saved results are real folders owned by the asker, and the job's steps say which workflow made them
    const artifacts = createArtifactStore(join(dir, "computers", "artifacts"));
    expect(r.artifacts).toHaveLength(3);
    for (const id of r.artifacts) {
      expect(artifacts.get(id, "usman")?.main).toBe("report.md");
      expect(artifacts.get(id, "mehroz")).toBeNull();
      expect(jobs.get(id)!.steps.some((s) => ["audit", "research", "builder"].includes(s.executor))).toBe(true);
    }
    // the conversation: each done job has a started, a result entry that offers the saved result, and an end entry
    process.env.MU_DATA_DIR = dir;
    const thread = conversationStore(dir).get(jarvisThreadId("usman"))!;
    delete process.env.MU_DATA_DIR;
    for (const id of r.artifacts) {
      const keys = (thread.entries ?? []).filter((e) => e.jobId === id).map((e) => e.key.split(":").slice(1).join(":"));
      expect(keys).toEqual(expect.arrayContaining(["started", "report:1", "succeeded"]));
      expect((thread.entries ?? []).find((e) => e.key === `${id}:report:1`)!.text).toMatch(/\nSaved result: .+\n\(job [0-9a-f]{8}\)$/);
    }
    expect((thread.jobs ?? []).length).toBeGreaterThanOrEqual(7);
    const crm = new Database(join(dir, "crm.sqlite"), { readonly: true });
    expect((crm.query("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n).toBe(6);
    crm.close();
    const coding = CodingStore.open(join(dir, "coding"));
    const all = coding.listJobs({ limit: 50 });
    expect(all.length).toBe(r.coding);
    expect(new Set(all.map((j) => j.state)).size).toBeGreaterThan(5);
    expect(all.filter((j) => j.supersededBy)).toHaveLength(1);
    expect(all.every((j) => j.spec.dataClass === "synthetic")).toBe(true);
    coding.close();
    const host = JSON.parse(readFileSync(join(dir, "gate-host.json"), "utf8"));
    expect(host.host).toBe("ryzen");
    expect(host.env.MU_COMPUTERS_SSH_ALIAS).toBe("ryzen-bots");
    jobs.close();
  });

  test("the live phase adds a running and a waiting job once, and only on a folder the seed made", () => {
    const dir = fresh();
    seedCold(dir, "none");
    const out = seedLive(dir);
    expect(out.map((o) => o.state).sort()).toEqual(["awaiting-approval", "running"]);
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, readOnly: true });
    expect(jobs.get(out.find((o) => o.state === "running")!.jobId)!.state).toBe("running");
    expect(jobs.get(out.find((o) => o.state === "awaiting-approval")!.jobId)!.state).toBe("awaiting-approval");
    jobs.close();
    expect(() => seedLive(dir)).toThrow(/already seeded/);
    expect(existsSync(join(dir, "gate-host.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "gate-host.json"), "utf8")).env).toEqual({});
  });
});
