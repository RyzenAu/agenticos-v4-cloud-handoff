// T8c lead decision: a page read never starts Codex or Claude. Three read paths used to:
//  - GET /setup/connections (Settings -> AI tools) ran `codex app-server` and `claude mcp list` on a cold or expired cache;
//  - GET /__operator/models built the catalogue (codex app-server, claude auth status, Claude's model list);
//  - GET /calendar/native ran a Codex calendar discovery.
// Each now answers with the last check or "not checked yet"; the check is an explicit click (a hub-only POST)
// or the server's own schedule. (The model check's old "GET ?refresh=1" is gone too: follow-up L6.)
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { nativeConnectionDiscovery } from "./native-connection-discovery";
import { modelKeyFingerprint, peekAssistantCatalog } from "./assistant-adapters";
import { nativeCalendarSync } from "./native-calendar-sync";
import { withConnectedRead } from "./codex-connected-read";

const base = mkdtempSync(join(tmpdir(), "t8c-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

// ── /setup/connections ───────────────────────────────────────────────────────
function countedDiscovery(root: string) {
  const launches: string[] = [];
  const refuse = (what: string) => {
    launches.push(what);
    throw new Error(`would start ${what}`);
  };
  const service = nativeConnectionDiscovery(root, {
    binary: "codex-synthetic",
    claudeBinary: "claude-synthetic",
    start: (() => refuse("codex app-server")) as never,
    // A child that fails to start, as a real spawn reports it (an "error" event), counted.
    claudeStart: (() => {
      launches.push("claude mcp list");
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true, exitCode: 1, signalCode: null, pid: undefined });
      queueMicrotask(() => child.emit("error", new Error("refused")));
      return child;
    }) as never,
  });
  return { service, launches };
}

test("/setup/connections: a read starts neither Codex nor Claude and says 'unchecked'", async () => {
  const root = join(base, "setup-cold");
  const { service, launches } = countedDiscovery(root);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) {
    const v = service.peek();
    expect(v).toMatchObject({ status: "unchecked", checkedAt: null, expiresAt: null, apps: [] });
  }
  expect(performance.now() - t0).toBeLessThan(100);
  expect(launches).toEqual([]);
  service.close();
});

test("/setup/connections: the explicit check asks both, is kept on disk, and later reads (and a restart) answer from it", async () => {
  const root = join(base, "setup-checked");
  const first = countedDiscovery(root);
  const checked = await first.service.read(true);
  expect(first.launches.sort()).toEqual(["claude mcp list", "codex app-server"]);
  expect(checked.status).toBe("unavailable"); // our launchers refused, and it says so rather than claiming apps
  const launchesAfterCheck = first.launches.length;
  expect(first.service.peek()).toMatchObject({ status: "unavailable", checkedAt: checked.checkedAt });
  expect(first.launches.length).toBe(launchesAfterCheck);
  first.service.close();
  const restarted = countedDiscovery(root);
  expect(restarted.service.peek()).toMatchObject({ status: "unavailable", checkedAt: checked.checkedAt });
  expect(restarted.launches).toEqual([]);
  restarted.service.close();
});

test("/setup/connections: routes and UI: GET peeks, POST /setup/connections/check (hub-only) is the click", () => {
  const plugin = read("scripts/operator-plugin.ts");
  expect(plugin).toContain('if (method === "GET" && path === "/setup/connections") return send(existingConnections.peek());');
  expect(plugin).toContain('if (method === "POST" && path === "/setup/connections/check") return send(await existingConnections.read(true));');
  expect(plugin).toMatch(/HUB_CONNECTOR_WRITE =\s*\/\^[^\n]*setup\\\/connections\\\/check/);
  const summary = read("src/components/operator/setup-connections-summary.tsx");
  expect(summary).toContain('operatorRequest<ConnectionDiscovery>("/setup/connections/check", {})');
  expect(summary).toContain("onClick={() => void check()}");
  expect(summary).not.toContain("discovery.refetch()");
  const scan = read("src/components/operator/setup-scan-connections.tsx");
  expect(scan).toContain('operatorRequest<ConnectionDiscovery>("/setup/connections/check", {})');
  expect(scan).not.toContain("/setup/connections?refresh=1");
});

// ── The model catalogue ──────────────────────────────────────────────────────
test("models: a read with no build yet is 'not checked' at once, with no process", () => {
  const t0 = performance.now();
  const v = peekAssistantCatalog(join(base, "models-cold"));
  expect(performance.now() - t0).toBeLessThan(50);
  expect(v).toMatchObject({ models: [], statuses: [], notChecked: true, checking: false, error: null });
});

test("models: a read answers from the last build kept on disk (model names and statuses only, never the key)", () => {
  const root = join(base, "models-saved");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  const builtAt = "2026-09-29T00:00:00.000Z";
  writeFileSync(join(root, ".operator-data", "model-catalog.json"), JSON.stringify({ version: 1, models: [{ key: "codex|openai|gpt-6-sol", name: "gpt-6-sol" }], statuses: [{ id: "codex", ready: true, detail: "ok" }], builtAt }));
  const v = peekAssistantCatalog(root);
  expect(v).toMatchObject({ builtAt, checking: false, models: [{ name: "gpt-6-sol" }] });
  expect(v.notChecked).toBeUndefined();
  const src = read("scripts/assistant-adapters.ts");
  expect(src).toContain("JSON.stringify({ version: 1, models: value.models, statuses: value.statuses, builtAt: value.builtAt, keyFp: fp })");
});

test("models: GET /models only peeks (?refresh=1 is ignored); the click is the hub-only POST /models/refresh; the server re-checks on its own schedule", () => {
  const plugin = read("scripts/operator-plugin.ts");
  const start = plugin.indexOf('if (method === "GET" && path === "/models" && url.searchParams.get("snapshot") === "1")');
  const route = plugin.slice(start, plugin.indexOf('if (path === "/conversations" && method === "GET")'));
  const post = route.slice(route.indexOf('if (method === "POST" && path === "/models/refresh")'));
  const gets = route.slice(0, route.indexOf('if (method === "POST" && path === "/models/refresh")'));
  expect(gets).toContain("peekAssistantCatalog(root, modelKey())");
  // No GET branch can build, and none reads the "refresh" parameter at all.
  expect(gets).not.toMatch(/assistantCatalog\(|refresh: true|searchParams\.get\("refresh"\)/);
  // The only builder in the read routes is the POST, and remote callers are refused before it (hub-only).
  expect([...route.matchAll(/assistantCatalog\(root, modelKey\(\), \{ refresh: true \}\)/g)].length).toBe(1);
  expect(post.indexOf("assistantCatalog(")).toBeGreaterThan(-1);
  expect(plugin).toMatch(/HUB_CONNECTOR_WRITE =\s*\/\^[^\n]*models\\\/refresh/);
  expect(plugin).toContain("if (remote && method === \"POST\" && HUB_CONNECTOR_WRITE.test(path))");
  expect(plugin).toContain("setInterval(() => void assistantCatalog(root, modelKey()).catch(() => undefined), 30 * 60_000)");
  // Every UI caller of ?refresh=1 is a click.
  expect(read("src/components/floating-oracle.tsx")).toMatch(/onClick=\{\(\) => void refreshModels\(true\)\}/);
  const system = read("src/components/shell/pages/system-page.tsx");
  expect(system).toContain('operatorRequest<ModelSnapshot>("/models/refresh", { background: true })');
  expect(system).not.toContain("refresh=1");
  expect([...system.matchAll(/checkModels/g)].length).toBe(3); // defined once, used only in two onClicks
  expect([...system.matchAll(/onClick=\{checkModels\}/g)].length).toBe(2);
});

// ── The model cache belongs to the key it was built with (follow-up L6) ──────────
test("models: the key fingerprint is one-way, stable and never the key", () => {
  const key = "sk-synthetic-not-a-real-key-0123456789";
  const fp = modelKeyFingerprint(key);
  expect(fp).toMatch(/^[0-9a-f]{16}$/);
  expect(fp).toBe(modelKeyFingerprint(key));
  expect(fp).not.toBe(modelKeyFingerprint(key + "x"));
  expect(fp).not.toContain(key.slice(3, 12));
  expect(modelKeyFingerprint("")).toBe("none");
});

test("models: a build made with one key is not served after the key changes (disk and memory), and the key is never written", () => {
  const key = "sk-synthetic-old-key-aaaaaaaaaaaaaaaa";
  const root = join(base, "models-key");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  const file = join(root, ".operator-data", "model-catalog.json");
  const builtAt = "2026-09-29T00:00:00.000Z";
  writeFileSync(file, JSON.stringify({ version: 1, models: [{ key: "hermes|openrouter|vendor/x", name: "vendor/x" }], statuses: [], builtAt, keyFp: modelKeyFingerprint(key) }));
  expect(readFileSync(file, "utf8")).not.toContain(key);
  // The same key reads it; a rotated key, or no key, sees "not checked" instead of the old key's list.
  expect(peekAssistantCatalog(root, key)).toMatchObject({ builtAt, models: [{ name: "vendor/x" }] });
  const rotated = peekAssistantCatalog(root, "sk-synthetic-new-key-bbbbbbbbbbbbbbbb");
  expect(rotated).toMatchObject({ models: [], statuses: [], notChecked: true });
  expect(peekAssistantCatalog(root, "")).toMatchObject({ models: [], notChecked: true });
  // ...and going back to the old key serves it again (the memory copy was not overwritten by the miss).
  expect(peekAssistantCatalog(root, key).models).toHaveLength(1);
  // A build kept on disk before fingerprints existed is not trusted for a key.
  const legacy = join(base, "models-legacy");
  mkdirSync(join(legacy, ".operator-data"), { recursive: true });
  writeFileSync(join(legacy, ".operator-data", "model-catalog.json"), JSON.stringify({ version: 1, models: [{ key: "a", name: "a" }], statuses: [], builtAt }));
  expect(peekAssistantCatalog(legacy, key)).toMatchObject({ notChecked: true });
});

test("models: the cache ids and the disk file carry the fingerprint, never the raw key", () => {
  const src = read("scripts/assistant-adapters.ts");
  expect(src).toContain("catalogCache(JSON.stringify([root, fp])");
  expect(src).not.toContain("JSON.stringify([root, key])");
  expect(src).toContain("keyFp: fp");
  expect(src).toMatch(/remoteCatalog\.fp !== fp/);
  expect(src).not.toMatch(/keyFp: key|fp: key\b|console\.\w+\([^)]*\bkey\b/);
});

// ── /calendar/native ─────────────────────────────────────────────────────────
function calendar(root: string, quiet = false) {
  let launches = 0;
  const connectedRead = (r: string, work: any, o: any = {}) =>
    withConnectedRead(r, work, { ...o, launch: ((...args: any[]) => { launches++; throw new Error(`would spawn ${String(args[0])}`); }) as never });
  const api = nativeCalendarSync(root, { load: () => ({ events: [] }) as never, save: () => {}, connectedRead: connectedRead as never, quiet });
  return { api, launches: () => launches };
}

test("/calendar/native: a read never reaches Codex's launcher (the real connected-read, launcher counted)", async () => {
  const root = join(base, "cal");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  writeFileSync(join(root, ".operator-data", "native-calendar.json"), JSON.stringify({ enabled: true, account: "owner@example.test" }));
  const c = calendar(root);
  for (let i = 0; i < 5; i++) expect(await c.api.status()).toMatchObject({ checked: false, canCheck: true, enabled: true, savedAccount: "owner@example.test" });
  expect(c.launches()).toBe(0);
  await c.api.check(); // the explicit check does go to Codex (Codex may be absent here, so 0 or 1 launch)
  expect(await c.api.status()).toBeDefined();
  const quiet = calendar(join(base, "cal-quiet"), true);
  expect(await quiet.api.check()).toMatchObject({ checked: false, canCheck: false });
  expect(quiet.launches()).toBe(0); // a quiet preview never checks, even when asked
});

test("/calendar: loading or paging the calendar never syncs by itself; checking is a click", () => {
  const ui = read("src/components/operator/native-calendar-connection.tsx");
  expect(ui).not.toMatch(/if \(!covered\) void sync\(\)/);
  expect(ui).toContain('operatorRequest("/calendar/native/check", {})');
  expect(ui).toContain('primary = { label: "Check Codex", icon: "refresh", run: () => void check() };');
  const plugin = read("scripts/operator-plugin.ts");
  expect(plugin).toContain('if (method === "GET" && path === "/calendar/native") return send(await nativeCalendar.status());');
  expect(plugin).toContain('if (method === "POST" && path === "/calendar/native/check") return send(await nativeCalendar.check());');
  expect(plugin).toContain("calendar\\/native\\/(?:sync|disconnect|check)");
  const cal = read("scripts/native-calendar-sync.ts");
  const status = cal.slice(cal.indexOf("    async status() {"), cal.indexOf("    async check() {"));
  expect(status).not.toMatch(/discover\(|connectedRead\(/);
});
