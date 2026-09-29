import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openCrm, upsertLead } from "../leads/crm";
import { draftSiteV2 } from "./orchestrator";

const dirs: string[] = [];
const openDbs: Database[] = [];
function tempDir(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const db of openDbs) db.close();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows can hold a WAL file handle open briefly after close(); not worth failing the
      // whole suite over a leftover temp-dir cleanup.
    }
  }
});

function seedDb(): Database {
  const dbDir = tempDir("site-draft-orch-db-");
  const db = openCrm(join(dbDir, "crm.sqlite"));
  openDbs.push(db);
  upsertLead(db, {
    placeId: "place-orch-1",
    vertical: "dental",
    area: "Mount Druitt NSW",
    name: "Orchestrator Test Dental",
    phone: "+61 2 9670 1111",
    address: "1 Test St, Mount Druitt NSW",
    website: "",
    mapsUrl: "https://maps.google.com/?cid=1",
    rating: null,
    reviews: null,
    emails: [],
    emailOk: false,
    score: 10,
    pitch: "",
    reasons: [],
    googleAt: new Date().toISOString(),
    source: "google",
    attribution: "",
  } as any);
  return db;
}

describe("draftSiteV2", () => {
  test("skipBuild writes evidence.json and direction.md without invoking Claude", async () => {
    const db = seedDb();
    const draftsRoot = tempDir("site-draft-orch-out-");
    const result = await draftSiteV2(db, "Orchestrator Test Dental", { draftsRoot, skipBuild: true, skipHiggsfield: true });
    expect(existsSync(join(result.dir, "evidence.json"))).toBe(true);
    expect(existsSync(join(result.dir, "direction.md"))).toBe(true);
    expect(result.qa).toBeNull();
  });

  test("a mocked successful build + passing QA logs a CRM note and returns qa.pass", async () => {
    const db = seedDb();
    const draftsRoot = tempDir("site-draft-orch-out-");
    const run = async () => JSON.stringify({ is_error: false, result: "built", usage: { input_tokens: 1, output_tokens: 1 } });
    const qaRunner = async (args: string[]) => {
      if (args.includes("errors")) return { ok: true, stdout: "[]" };
      if (args.includes("a11y")) return { ok: true, stdout: JSON.stringify({ violations: [] }) };
      return { ok: true, stdout: "" };
    };
    const result = await draftSiteV2(db, "Orchestrator Test Dental", {
      draftsRoot,
      skipHiggsfield: true,
      buildOptions: { run },
      qaOptions: { runner: qaRunner },
    });
    // The mocked refine pass changes nothing, so the premium scaffold is what QA sees.
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.qa).not.toBeNull();
    expect(existsSync(join(result.dir, "scaffold.html"))).toBe(true);
    expect(readFileSync(result.indexPath, "utf8")).toContain("INTERNAL DRAFT");
    const activities = db.query("SELECT note FROM activities ORDER BY id DESC LIMIT 1").get() as { note: string };
    expect(activities.note).toMatch(/draft site v4 ready/);
    expect(activities.note).toMatch(/Nothing published or sent/);
  }, 20_000);

  test("a build failure is recorded and does not crash the pipeline", async () => {
    const db = seedDb();
    const draftsRoot = tempDir("site-draft-orch-out-");
    const run = async () => {
      throw new Error("simulated Claude Code failure");
    };
    const qaRunner = async (args: string[]) => (args.includes("a11y") ? { ok: true, stdout: JSON.stringify({ violations: [] }) } : { ok: true, stdout: "[]" });
    const result = await draftSiteV2(db, "Orchestrator Test Dental", { draftsRoot, buildOptions: { run }, skipHiggsfield: true, qaOptions: { runner: qaRunner } });
    // A failed refine pass still ships the premium scaffold, and says so.
    expect(existsSync(join(result.dir, "BUILD-ERROR.md"))).toBe(true);
    expect(readFileSync(result.indexPath, "utf8")).toContain("INTERNAL DRAFT");
    expect(result.qa).not.toBeNull();
    const activities = db.query("SELECT note FROM activities ORDER BY id DESC LIMIT 1").get() as { note: string };
    expect(activities.note).toMatch(/build failed/);
  });

  test("a refine pass that rewrites the locked headline keeps its other polish but not the new headline", async () => {
    const db = seedDb();
    const draftsRoot = tempDir("site-draft-orch-out-");
    const run = async (_args: string[], _stdin: string, _env: unknown, cwd: string) => {
      const p = join(cwd, "index.html");
      const html = readFileSync(p, "utf8").replace(/(<h1 class="display" data-lock="h1">)[^<]+(<\/h1>)/, "$1Dental care on Test St.$2").replace("<title>", "<title>Polished ");
      writeFileSync(p, html);
      return JSON.stringify({ is_error: false, result: "polished" });
    };
    const qaRunner = async (args: string[]) => (args.includes("a11y") ? { ok: true, stdout: JSON.stringify({ violations: [] }) } : { ok: true, stdout: "[]" });
    const result = await draftSiteV2(db, "Orchestrator Test Dental", { draftsRoot, buildOptions: { run: run as any }, skipHiggsfield: true, qaOptions: { runner: qaRunner } });
    const html = readFileSync(result.indexPath, "utf8");
    expect(html).not.toContain("Dental care on Test St.");
    expect(html).toContain("Book the check‑up you&#39;ve been putting off.");
    expect(html).toContain("<title>Polished ");
    const activities = db.query("SELECT note FROM activities ORDER BY id DESC LIMIT 1").get() as { note: string };
    expect(activities.note).toMatch(/re-locked/);
  });

  test("a refine pass that strips a guarded element is discarded for the scaffold", async () => {
    const db = seedDb();
    const draftsRoot = tempDir("site-draft-orch-out-");
    const run = async (_args: string[], _stdin: string, _env: unknown, cwd: string) => {
      writeFileSync(join(cwd, "index.html"), "<html><body><h1>Five-star dentist, award-winning</h1></body></html>");
      return JSON.stringify({ is_error: false, result: "rewrote it" });
    };
    const qaRunner = async (args: string[]) => (args.includes("a11y") ? { ok: true, stdout: JSON.stringify({ violations: [] }) } : { ok: true, stdout: "[]" });
    const result = await draftSiteV2(db, "Orchestrator Test Dental", { draftsRoot, buildOptions: { run: run as any }, skipHiggsfield: true, qaOptions: { runner: qaRunner } });
    const html = readFileSync(result.indexPath, "utf8");
    expect(html).toContain("INTERNAL DRAFT");
    expect(html).not.toContain("Five-star");
    const activities = db.query("SELECT note FROM activities ORDER BY id DESC LIMIT 1").get() as { note: string };
    expect(activities.note).toMatch(/scaffold restored/);
  });
});
