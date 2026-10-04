// T8b lead decision: GET /__operator/native-connections never starts Codex. status() answers from the
// last discovery or the last-known saved state ("not checked yet"); check() (POST, an explicit action)
// and sync() (the refresh button, inbox triage's schedule) are the only paths to Codex.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConnectedRead } from "./codex-connected-read";
import { nativeInboxSync } from "./native-inbox-sync";

const base = mkdtempSync(join(tmpdir(), "t8b-native-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

type View = { providers: Array<{ id: string; available: boolean; enabled?: boolean; account?: string; lastKnown?: boolean }>; notChecked?: boolean; error?: string; discovery: { checkedAt: string | null; refreshing: boolean; error: string | null } };
const tool = (name: string, email: string) => ({ name, annotations: { readOnlyHint: true }, _meta: { link_owner_profile: { email } } });
const noopArchive = { importMetadata: () => [] } as never;

function api(root: string, connectedRead: (...a: any[]) => Promise<any>) {
  return nativeInboxSync(root, { load: () => ({ inbox: [] }) as never, save: () => {}, archive: noopArchive, connectedRead: connectedRead as never });
}

test("a read never reaches Codex's launcher, even with nothing cached; it says 'not checked yet'", async () => {
  const root = join(base, "cold");
  let launches = 0;
  // The REAL connected-read, with its process launcher counted: any path to Codex would show here.
  const connectedRead = (r: string, work: any, o: any = {}) => withConnectedRead(r, work, { ...o, launch: ((...args: any[]) => { launches++; throw new Error(`would spawn ${String(args[0])}`); }) as never });
  const nat = api(root, connectedRead);
  const t0 = performance.now();
  const reads = await Promise.all(Array.from({ length: 5 }, () => nat.status() as Promise<View>));
  expect(performance.now() - t0).toBeLessThan(200);
  expect(launches).toBe(0);
  for (const v of reads) {
    expect(v.discovery.checkedAt).toBeNull();
    expect(v.notChecked).toBe(true);
    expect(v.discovery.refreshing).toBe(false);
    expect(v.providers.map((p) => [p.id, p.available])).toEqual([["gmail", false], ["outlook", false], ["slack", false]]);
  }
});

test("before any check, the last-known saved selection is shown (a mailbox last refreshed cleanly counts as readable)", async () => {
  const root = join(base, "saved");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  writeFileSync(join(root, ".operator-data", "native-connections.json"), JSON.stringify({
    gmail: { enabled: true, account: "owner@example.test", lastSync: "2026-09-28T09:00:00.000Z", count: 12 },
    slack: { enabled: true, account: "T123", lastSync: "2026-09-28T09:00:00.000Z", error: "Slack is not available through this Codex sign-in." },
  }));
  let calls = 0;
  const v = (await api(root, async () => (calls++, [])).status()) as View;
  expect(calls).toBe(0);
  expect(v.notChecked).toBe(true);
  expect(v.providers.find((p) => p.id === "gmail")).toMatchObject({ available: true, enabled: true, account: "owner@example.test", lastKnown: true });
  expect(v.providers.find((p) => p.id === "slack")).toMatchObject({ available: false, lastKnown: true }); // its last refresh failed
  expect(v.providers.find((p) => p.id === "outlook")).toMatchObject({ available: false });
});

test("check() asks Codex once, is persisted, and a restarted server reads it without asking again", async () => {
  const root = join(base, "checked");
  let calls = 0;
  const connectedRead = async (_r: string, work: (c: unknown) => unknown) => (calls++, work({ tools: { "gmail.search_emails": tool("gmail.search_emails", "owner@example.test") } }));
  const first = api(root, connectedRead);
  const checked = (await first.check()) as View;
  expect(calls).toBe(1);
  expect(checked.discovery.checkedAt).not.toBeNull();
  expect(checked.providers.find((p) => p.id === "gmail")).toMatchObject({ available: true, account: "owner@example.test" });
  expect(existsSync(join(root, ".operator-data", "native-discovery.json"))).toBe(true);
  expect(readFileSync(join(root, ".operator-data", "native-discovery.json"), "utf8")).not.toMatch(/token|secret/i);
  // Reads after a check, and after a restart, are answered from it.
  for (let i = 0; i < 3; i++) await first.status();
  const restarted = api(root, connectedRead);
  const again = (await restarted.status()) as View;
  expect(calls).toBe(1);
  expect(again.discovery.checkedAt).toBe(checked.discovery.checkedAt);
  expect(again.notChecked).toBeUndefined();
});

test("a failed check is reported by the next read, which still doesn't retry", async () => {
  const root = join(base, "failing");
  let calls = 0;
  const nat = api(root, async () => { calls++; throw new Error("Codex is not signed in"); });
  const r = (await nat.check()) as View;
  expect(r.error).toBe("Codex is not signed in");
  const v = (await nat.status()) as View;
  expect(v.discovery.error).toBe("Codex is not signed in");
  expect(calls).toBe(1);
});

test("a check that fails in the same millisecond as the last good one is still reported", async () => {
  const realNow = Date.now;
  Date.now = () => 1_790_000_000_000; // frozen clock: success and failure share a timestamp
  try {
    let fail = false;
    const nat = api(join(base, "same-ms"), async (_r: string, work: (c: unknown) => unknown) => { if (fail) throw new Error("Codex connector unavailable"); return work({ tools: {} }); });
    await nat.check();
    fail = true;
    await nat.check();
    expect(((await nat.status()) as View).discovery.error).toBe("Codex connector unavailable");
  } finally {
    Date.now = realNow;
  }
});

test("the refresh button's sync records what its Codex session saw as the new check", async () => {
  const root = join(base, "synced");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  writeFileSync(join(root, ".operator-data", "native-connections.json"), JSON.stringify({ outlook: { enabled: true, account: "owner@example.test" } }));
  const client = { tools: { "microsoft_outlook_email.get_recent_emails": tool("microsoft_outlook_email.get_recent_emails", "owner@example.test") }, call: async () => ({ value: [] }) };
  const nat = api(root, async (_r: string, work: (c: unknown) => unknown) => work(client));
  await nat.sync();
  const v = (await nat.status()) as View;
  expect(v.discovery.checkedAt).not.toBeNull();
  expect(v.providers.find((p) => p.id === "outlook")).toMatchObject({ available: true, enabled: true });
});

test("the operator routes: GET reads status, POST /native-connections/check is the explicit check (hub-only)", () => {
  const src = readFileSync(join(import.meta.dir, "operator-plugin.ts"), "utf8");
  expect(src).toContain('if (method === "GET" && path === "/native-connections") return send(await nativeInbox.status());');
  expect(src).toContain('if (method === "POST" && path === "/native-connections/check") return send(await nativeInbox.check());');
  expect(src).toContain("native-connections\\/(?:sync|check)");
  const ui = readFileSync(join(import.meta.dir, "..", "src/components/operator/account-connections.tsx"), "utf8");
  expect(ui).toContain('operatorRequest("/native-connections/check", {})'); // "Check connections" is a click
  expect(readFileSync(join(import.meta.dir, "..", "src/components/operator/setup-scan-connections.tsx"), "utf8")).toContain('"/native-connections/check", {}'); // the setup scan is a click
});
