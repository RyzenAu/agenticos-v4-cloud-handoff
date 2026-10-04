import { beforeAll, afterAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operatorPlugin } from "./operator-plugin";
let root: string, base: string, server: Server, close: () => void;
const token = "memory-storage-fixture";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "memory-storage-"));
  const plugin = operatorPlugin({ root, token, memoryHome: join(root, "fake-home") });
  close = () => (plugin.closeBundle as any)?.();
  let middleware: any;
  (plugin.configureServer as any)({
    middlewares: { use: (_: string, fn: any) => (middleware = fn) },
  });
  server = createServer((req, res) => middleware(req, res, () => res.end()));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
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
        console.warn(`[memory-storage.test] leaving temp dir for the OS to reclaim: ${path}`);
        return;
      }
      if (typeof Bun !== "undefined" && Bun.gc) Bun.gc(true);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
afterAll(async () => {
  close();
  await new Promise<void>((done) => server.close(() => done()));
  await safeRm(root);
});
async function req(path: string, body?: any) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as any;
}
test("observed dashboard balances stay out of searchable memory; only a sourced, dated finance note enters it, and it stays gated", async () => {
  await req("/business/finances", {
    accounts: [
      { name: "Finance fixture", balance: 9876, currency: "USD" },
      { name: "Unknown currency", balance: 20 },
    ],
    recordedAt: "2026-09-15",
    sourceLabel: "Verified fixture export",
  });
  let context = await req("/brain/context");
  expect(context.business.evidence.finances.measurement).toBe("account_balances");
  expect(context.business.evidence.finances.recordedAt).toBe("2026-09-15T00:00:00.000Z");
  // Finance never enters memory as figures: no balance, no account name.
  expect((await req("/search?q=9876")).results).toHaveLength(0);
  expect((await req("/search?q=Finance%20fixture")).results.filter((r: any) => r.excerpt?.includes("9876"))).toHaveLength(0);
  const found = (await req("/search?q=Verified%20fixture%20export")).results;
  expect(found[0].title).toBe("Finance summary (sourced)");
  const text = (await req(`/memory/${found[0].id}`)).source.text as string;
  expect(text).toContain("The figures stay in Finance and are not copied into memory");
  expect(text).toContain("No NAB CSV imported: bank cash flow is unknown, not zero.");
  expect(text).not.toMatch(/9876|Finance fixture/);
  expect((await req("/memory/business/sync", {})).unchanged).toBe(1);
  await req("/brain/sources", { id: "business", enabled: false });
  context = await req("/brain/context");
  expect(context.business).toBeNull();
  expect((await req("/search?q=Verified%20fixture%20export")).results).toHaveLength(0);
  await req("/brain/sources", { id: "business", enabled: true });
  await req("/business/finances", {
    accounts: [{ name: "Finance fixture", balance: 4321, currency: "USD" }],
    recordedAt: "2026-09-16",
    sourceLabel: "Next observed export",
  });
  expect((await req("/search?q=4321")).results).toHaveLength(0);
  expect((await req("/search?q=Next%20observed%20export")).results[0].id).toBe(found[0].id);
}, 30_000);
test("complete comparable audience history is retrieved beyond UI excerpts and exported as readable Markdown", async () => {
  await req("/business/snapshots", {
    snapshots: Array.from({ length: 80 }, (_, i) => ({
      platform: "youtube",
      recordedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      metrics: { followers: 1000 + i },
      sourceLabel: i === 70 ? "Historicalneedle791" : "Recorded audience export",
      measurementScope: "youtube-channel-totals-v1",
      sourceUrl: `https://www.youtube.com/channel/UC${"a".repeat(22)}`,
      origin: "import",
    })),
  });
  const found = (await req("/search?q=Historicalneedle791")).results[0];
  expect(found.title).toBe("Youtube audience history");
  expect(found.excerpt).toContain("Historicalneedle791");
  const state = await req("/state"),
    preview = state.sources.find((s: any) => s.id === found.id);
  expect(preview.textTruncated).toBe(true);
  expect(preview.text).not.toContain("Historicalneedle791");
  const storage = await req("/memory/storage/export", {});
  expect(storage.mirrored).toBe(2);
  expect(storage.conflicts).toBe(0);
  expect(storage.pending).toBe(false);
  const markdown = readFileSync(join(storage.path, `business/${found.id}.md`), "utf8");
  expect(markdown).toContain("Historicalneedle791");
  expect(markdown).toContain('source_provider: "business-dashboard"');
  expect((await req("/memory/storage")).path).toBe(storage.path);
});

test("a newly saved memory is immediately available to voice recall and source toggles remove its evidence", async () => {
  await req("/brain/sources", { id: "manual", enabled: true });
  const saved = await req("/memory", { title: "Demo recall fixture", text: "The synthetic demo launch code is violet-lantern-731.", origin: "manual", collection: "personal", kind: "note" });
  expect((await req("/search?q=violet-lantern-731")).results.some((s: any) => s.id === saved.source.id && s.excerpt.includes("violet-lantern-731"))).toBe(true);
  expect((await req("/search?recent=1")).results.some((s: any) => s.id === saved.source.id)).toBe(true);
  const recalled = await req("/voice/memory/read", { id: saved.source.id, query: "launch code" });
  expect(recalled.text).toContain("violet-lantern-731");
  expect(recalled.status).toBe("ready");
  await req("/brain/sources", { id: "manual", enabled: false });
  expect((await req("/search?q=violet-lantern-731")).results).toHaveLength(0);
  expect((await req("/search?recent=1")).results.some((s: any) => s.id === saved.source.id)).toBe(false);
  await expect(req("/voice/memory/read", { id: saved.source.id })).rejects.toThrow("switched off");
  await req("/brain/sources", { id: "manual", enabled: true });
});

test("email and Granola inclusion switches gate saved evidence immediately", async () => {
  for (const origin of ["email", "meetings"]) {
    await req("/brain/sources", { id: origin, enabled: true });
    const needle = `source-gating-${origin}-743`;
    const saved = await req("/memory", { title: `${origin} fixture`, text: `Synthetic recall evidence: ${needle}`, origin, collection: "business", kind: "note" });
    expect((await req(`/search?q=${needle}`)).results.some((s: any) => s.id === saved.source.id)).toBe(true);
    await req("/brain/sources", { id: origin, enabled: false });
    expect((await req(`/search?q=${needle}`)).results.some((s: any) => s.id === saved.source.id)).toBe(false);
    expect((await req("/search?recent=1")).results.some((s: any) => s.id === saved.source.id)).toBe(false);
    expect((await req("/brain/context")).sources.some((s: any) => s.id === saved.source.id)).toBe(false);
    await req("/brain/sources", { id: origin, enabled: true });
    expect((await req(`/search?q=${needle}`)).results.some((s: any) => s.id === saved.source.id)).toBe(true);
  }
});
