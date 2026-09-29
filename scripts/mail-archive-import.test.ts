import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestMailStage } from "./mail-archive-import";
import { mailArchive } from "./mail-archive";
const roots: string[] = [];
// Windows can keep a native handle on a closed SQLite FTS5 database pinned by
// a not-yet-collected JS Statement wrapper, independent of db.close(); retry
// the removal, and treat a still-locked temp dir as a harmless OS cleanup
// delay rather than a test failure once the test's own assertions have run.
async function safeRm(path: string) {
  const attempts = 20, delayMs = 150;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EBUSY") throw error;
      if (attempt === attempts - 1) {
        console.warn(`[mail-archive-import.test] leaving temp dir for the OS to reclaim: ${path}`);
        return;
      }
      if (typeof Bun !== "undefined" && Bun.gc) Bun.gc(true);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
afterEach(async () => { for (const root of roots.splice(0)) await safeRm(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mail-stage-")); roots.push(root);
  const stage = join(root, ".operator-data/mail-staging"); mkdirSync(join(stage, "gmail"), { recursive: true });
  return { root, stage, page: join(stage, "gmail/000001.json") };
}
const message = (id: string) => ({ id, internalDate: "1609459200000", payload: { mimeType: "text/plain", body: { data: Buffer.from("Test mail").toString("base64url") } } });
test("large staged pages use bounded batches and replays deduplicate after a missing checkpoint", () => {
  const f = fixture();
  writeFileSync(f.page, JSON.stringify({ account: "owner@example.com", responses: Array.from({ length: 205 }, (_, i) => message(String(i))) }));
  expect(ingestMailStage(f.root)).toMatchObject({ processed: 205, total: 205 });
  expect(ingestMailStage(f.root)).toMatchObject({ processed: 0, total: 205 });
  writeFileSync(join(f.stage, "ingested-pages.json"), "[]");
  expect(ingestMailStage(f.root)).toMatchObject({ processed: 205, total: 205 });
  expect(existsSync(join(f.stage, "import.lock"))).toBe(false);
});
test("a failed later batch is not checkpointed and retries preserve earlier committed messages", () => {
  const f = fixture(), records = Array.from({ length: 101 }, (_, i) => message(String(i)));
  writeFileSync(f.page, JSON.stringify({ account: "owner@example.com", responses: [...records.slice(0, 100), { id: "bad" }] }));
  expect(() => ingestMailStage(f.root)).toThrow("valid received date");
  expect(existsSync(join(f.stage, "ingested-pages.json"))).toBe(false);
  const archive = mailArchive(f.root); expect(archive.stats().total).toBe(100); archive.close(); archive.close();
  writeFileSync(f.page, JSON.stringify({ account: "owner@example.com", responses: records }));
  expect(ingestMailStage(f.root)).toMatchObject({ total: 101 });
  expect(JSON.parse(readFileSync(join(f.stage, "ingested-pages.json"), "utf8"))).toHaveLength(1);
});
test("active staging imports stay locked and an abandoned pre-PID lock is recoverable", () => {
  const f = fixture(), lock = join(f.stage, "import.lock"); mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  expect(ingestMailStage(f.root)).toEqual({ busy: true });
  rmSync(join(lock, "pid")); utimesSync(lock, new Date(0), new Date(0));
  expect(ingestMailStage(f.root)).toMatchObject({ processed: 0, total: 0 });
  expect(existsSync(lock)).toBe(false);
});
