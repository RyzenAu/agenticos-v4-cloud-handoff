import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateCache, deepFreeze, filesStamp } from "./workspace-state-cache";
import { filterWorkspaceMemory } from "./operator-plugin";

const dir = mkdtempSync(join(tmpdir(), "t8-state-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// What the plugin's save() does: write a temp file, then rename it into place.
function saveJson(file: string, value: unknown) {
  const tmp = `${file}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

test("peek parses once per file version, however many readers poll", () => {
  const file = join(dir, "workspace.json");
  saveJson(file, { sources: [{ id: "a", text: "x".repeat(10) }] });
  let parses = 0;
  const cache = createStateCache([file], () => {
    parses++;
    return JSON.parse(readFileSync(file, "utf8"));
  });
  for (let i = 0; i < 50; i++) expect(cache.peek().sources[0].id).toBe("a");
  expect(parses).toBe(1);
  saveJson(file, { sources: [{ id: "b", text: "y" }] }); // a save: new file renamed into place
  expect(cache.peek().sources[0].id).toBe("b");
  expect(parses).toBe(2);
  cache.invalidate();
  cache.peek();
  expect(parses).toBe(3);
  expect(cache.reads).toBe(3);
});

test("a change to any watched file (the brain preferences too) is a new version", () => {
  const file = join(dir, "ws2.json");
  const prefs = join(dir, "prefs.json");
  saveJson(file, { n: 1 });
  let parses = 0;
  const cache = createStateCache([file, prefs], () => (parses++, { n: 1 }));
  cache.peek();
  cache.peek();
  expect(parses).toBe(1);
  saveJson(prefs, { version: 1 }); // appears
  cache.peek();
  expect(parses).toBe(2);
  expect(filesStamp([join(dir, "missing.json")])).toBe("-");
});

test("body() serialises once per version and key, and follows a save", () => {
  const file = join(dir, "ws3.json");
  saveJson(file, { v: 1 });
  const cache = createStateCache([file], () => JSON.parse(readFileSync(file, "utf8")));
  let builds = 0;
  const make = (s: { v: number }) => (builds++, JSON.stringify({ reply: s.v }));
  expect(cache.body("state", make)).toBe('{"reply":1}');
  expect(cache.body("state", make)).toBe('{"reply":1}');
  expect(builds).toBe(1);
  saveJson(file, { v: 2 });
  expect(cache.body("state", make)).toBe('{"reply":2}');
  expect(builds).toBe(2);
});

test("the shared copy is deep-frozen: a read path that mutated it would throw, not corrupt it", () => {
  const file = join(dir, "ws4.json");
  saveJson(file, { sources: [{ id: "a", status: "indexing" }], settings: { mission: false } });
  const cache = createStateCache([file], () => JSON.parse(readFileSync(file, "utf8")));
  const state = cache.peek() as { sources: { status: string }[]; settings: { mission: boolean } };
  expect(() => {
    state.sources[0].status = "error";
  }).toThrow();
  expect(() => {
    state.sources.push({ status: "x" });
  }).toThrow();
  expect(() => {
    state.settings.mission = true;
  }).toThrow();
  expect(cache.peek()).toBe(state);
  expect(state.sources[0].status).toBe("indexing");
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  expect(Object.isFrozen(deepFreeze(cyclic))).toBe(true);
});

test("filterWorkspaceMemory reads hidden titles once per workspace version, and still follows edits", () => {
  const root = join(dir, "root");
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  const ws = join(root, ".operator-data", "workspace.json");
  const live = JSON.stringify({ memory: { nodes: [{ id: "n1", name: "Secret plan" }, { id: "n2", name: "Open" }], links: [{ source: "n1", target: "n2" }] } });
  saveJson(ws, { hiddenMemoryTitles: ["Secret plan"] });
  const names = (raw: string) => JSON.parse(raw).memory.nodes.map((n: { name: string }) => n.name);
  expect(names(filterWorkspaceMemory(live, root))).toEqual(["Open"]);
  expect(JSON.parse(filterWorkspaceMemory(live, root)).memory.links).toEqual([]);
  saveJson(ws, { hiddenMemoryTitles: ["Open"] });
  expect(names(filterWorkspaceMemory(live, root))).toEqual(["Secret plan"]);
  saveJson(ws, { hiddenMemoryTitles: [] });
  expect(filterWorkspaceMemory(live, root)).toBe(live);
});
