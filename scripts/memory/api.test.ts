// Memory API units: settings default OFF, guards, vault scanning + ids, app-owned store,
// conflict-safe vault writes. TEMP copies of the synthetic mini-wiki only.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryApi } from "./api";
import { screenFact, screenNote } from "./guard";
import { loopbackUrl, resolveMemorySettings } from "./settings";
import { createStore } from "./store";
import { assignNoteIds, globToRegExp, scanVault } from "./vault";
import { VaultConflictError, noteHash, writeNoteIfUnchanged } from "./wiki-store";
import { cleanup, FIXTURE, setup, snapshot, usman } from "./testing/harness";

afterEach(cleanup);

describe("settings: ONE switch (MU_MEMORY_WRITES), default OFF, with a clear enabled path", () => {
  test("nothing set → writes off, Hindsight not contacted, default bank is the shared pool (not the pilot)", () => {
    const s = resolveMemorySettings({}, "C:/app");
    expect(s.mode).toBe("off");
    expect(s.writes).toBe(false);
    expect(s.hindsight.enabled).toBe(false);
    expect(s.hindsight.reason).toBe("MU_MEMORY_WRITES is off");
    expect(s.hindsight.bank).toBe("mu-shared");
    expect(s.hindsight.url).toBe("http://127.0.0.1:8878"); // the client proxy, never the API port
    expect(s.stateDir.replace(/\\/g, "/")).toBe("C:/app/.operator-data/memory");
  });
  test("only exactly on / read count; anything else is off", () => {
    for (const v of ["1", "true", "yes", "ON ", "enabled", ""]) expect(resolveMemorySettings({ MU_MEMORY_WRITES: v }).writes).toBe(v.trim().toLowerCase() === "on");
    const read = resolveMemorySettings({ MU_MEMORY_WRITES: "read" });
    expect([read.mode, read.writes, read.hindsight.enabled]).toEqual(["read", false, true]);
    const on = resolveMemorySettings({ MU_MEMORY_WRITES: "on" });
    expect([on.mode, on.writes, on.hindsight.enabled, on.hindsight.url]).toEqual(["on", true, true, "http://127.0.0.1:8878"]);
  });
  test("the connector's retired switches do nothing, and are reported if set", () => {
    const s = resolveMemorySettings({ MEMORY_WRITES: "1", HINDSIGHT_ENABLED: "1" });
    expect(s.writes).toBe(false);
    expect(s.hindsight.enabled).toBe(false);
    expect(s.retired).toEqual(["MEMORY_WRITES", "HINDSIGHT_ENABLED"]);
  });
  test("HINDSIGHT_URL: loopback only; 'off' keeps Hindsight out with writes still on", () => {
    const on = resolveMemorySettings({ MU_MEMORY_WRITES: "on", HINDSIGHT_URL: "http://127.0.0.1:8879" });
    expect(on.writes && on.hindsight.enabled).toBe(true);
    expect(on.hindsight.url).toBe("http://127.0.0.1:8879");
    for (const bad of ["http://192.168.1.5:8888", "http://desktop.tailnet-name.ts.net:8888", "http://user:pw@127.0.0.1:8888", "ftp://127.0.0.1"]) {
      expect(loopbackUrl(bad)).toBeNull();
      const s = resolveMemorySettings({ MU_MEMORY_WRITES: "on", HINDSIGHT_URL: bad });
      expect(s.hindsight.enabled).toBe(false);
    }
    expect(loopbackUrl("http://[::1]:8888/")).toBe("http://[::1]:8888");
    const vaultOnly = resolveMemorySettings({ MU_MEMORY_WRITES: "on", HINDSIGHT_URL: "off" });
    expect([vaultOnly.writes, vaultOnly.hindsight.enabled]).toEqual([true, false]);
  });
  test("the app store is git-ignored in this repo", () => {
    expect(readFileSync(join(import.meta.dir, "..", "..", ".gitignore"), "utf8")).toMatch(/^\.operator-data\/$/m);
  });
});

describe("with the switches off", () => {
  test("writes off: capture, vault save, correct and forget refuse; Hindsight is never called for writes", async () => {
    const h = await setup({ writes: false });
    const before = snapshot(h.vault);
    const r = await h.api.remember(usman, { text: "The synthetic Kea clinic opens at 7am.", channel: "voice" });
    expect(!r.ok && r.code).toBe("writes-disabled");
    const v = await h.api.saveToVault(usman, { text: "The synthetic Kea clinic opens at 7am." });
    expect(!v.ok && v.code).toBe("writes-disabled");
    expect(!(await h.api.forget(usman, { kind: "unindex", target: "n-proposal-terms" })).ok).toBe(true);
    await h.api.sync({ force: true });
    expect(h.fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(h.api.status().hindsight).toBe("writes-off");
    expect(snapshot(h.vault)).toEqual(before);
    // Recall still works from the local index (and Hindsight, which is enabled for reads).
    const rec = await h.api.recall(usman, "Osprey proposals valid");
    expect(rec.facts[0].id).toBe("n-proposal-terms");
  });

  test("Hindsight disabled: no network call at all, recall says disabled", async () => {
    const h = await setup({ hindsight: false });
    let fetched = 0;
    const api = createMemoryApi({
      settings: resolveMemorySettings(h.env, h.base),
      env: h.env,
      fetch: (async () => {
        fetched++;
        throw new Error("no network expected");
      }) as unknown as typeof fetch,
    });
    await api.sync({ force: true });
    const m = await api.remember(usman, { text: "The synthetic Kea clinic opens at 7am.", channel: "voice" });
    expect(m.ok && m.destination.indexed).toBe("disabled");
    expect(m.ok && m.message).toContain("Hindsight is off");
    const rec = await api.recall(usman, "Kea clinic opens");
    expect(rec.hindsight).toBe("disabled");
    expect(rec.facts[0].source.kind).toBe("memory");
    expect(fetched).toBe(0);
  });
});

describe("guards", () => {
  test("notes: credential/transcript/bank/audio shapes are refused; FAQs, email templates and declared scripts pass", () => {
    expect(screenNote("The staging password: Synth3tic!pass").ok).toBe(false);
    expect(screenNote("Caller: hello\nReceptionist: hi there").ok).toBe(false);
    expect(screenNote("Caller: hello\nReceptionist: hi there", { script: true }).ok).toBe(true);
    expect(screenNote("[00:01:02] hello\n[00:01:09] hi").ok).toBe(false);
    expect(screenNote("BSB 062-000 account number 1234 5678").ok).toBe(false);
    expect(screenNote("Q: Do you open Saturdays?\nA: No, weekdays only.").ok).toBe(true);
    expect(screenNote("Hi team,\nThe demo moved to Friday.\nThanks,").ok).toBe(true);
  });
  test("facts: same screens as before; ordinary personal data is not screened (owner, 28 Sep)", () => {
    expect(screenFact("User: hi\nAssistant: hello").ok).toBe(false);
    expect(screenFact("Proposals go out as PDF only.").ok).toBe(true);
    expect(screenFact("Call the synthetic contact on 0412 345 678.").ok).toBe(true);
  });
  test("ordinary personal details can be saved to the vault and remembered", async () => {
    const h = await setup();
    const v = await h.api.saveToVault(usman, { text: "The synthetic Kea contact's mobile is 0412 345 678." });
    expect(v.ok).toBe(true);
    const r = await h.api.remember(usman, { text: "The synthetic Kea contact's email is kea@example.com.", channel: "voice" });
    expect(r.ok).toBe(true);
  });
});

describe("vault scanning", () => {
  test("allow/deny globs, opt-out frontmatter, guard skips", () => {
    const { notes, skipped } = scanVault(FIXTURE, resolveMemorySettings({}).sync);
    const paths = notes.map((n) => n.path);
    expect(paths).toContain("wiki/topics/business/booking-script.md");
    expect(paths).not.toContain("wiki/templates/concept.md");
    expect(paths.some((p) => p.startsWith("raw/"))).toBe(false);
    const reason = (p: string) => skipped.find((s) => s.path === p)?.reason;
    expect(reason("wiki/templates/concept.md")).toBe("denied path");
    expect(reason("wiki/topics/general/staging-setup.md")).toBe("secret-shaped content");
    expect(reason("wiki/topics/business/tuesday-call.md")).toBe("call-transcript-shaped content");
    expect(reason("wiki/topics/general/draft-ideas.md")).toBe("opted out in frontmatter");
  });
  test("globs", () => {
    expect(globToRegExp("wiki/**/*.md").test("wiki/a/b/c.md")).toBe(true);
    expect(globToRegExp("wiki/**/*.md").test("wiki/c.md")).toBe(true);
    expect(globToRegExp("**/templates/**").test("wiki/templates/x.md")).toBe(true);
    expect(globToRegExp("raw/**").test("wiki/raw.md")).toBe(false);
    expect(globToRegExp("**/*credential*").test("wiki/topics/My-Credentials.md")).toBe(true);
  });
  test("ids: frontmatter id wins; a path keeps its id; a rename is detected by content", () => {
    const { notes } = scanVault(FIXTURE, resolveMemorySettings({}).sync);
    const first = assignNoteIds(notes, {}).map;
    expect(first["wiki/topics/business/proposal-terms.md"].id).toBe("n-proposal-terms");
    const again = assignNoteIds(notes, first).map;
    expect(again).toEqual(first);
    const moved = notes.map((n) => (n.path === "wiki/entities/harbourview-dental.md" ? { ...n, path: "wiki/entities/harbourview.md" } : n));
    const r = assignNoteIds(moved, first);
    expect(r.renames).toEqual([{ from: "wiki/entities/harbourview-dental.md", to: "wiki/entities/harbourview.md", id: first["wiki/entities/harbourview-dental.md"].id }]);
  });
});

describe("app-owned store and conflict-safe vault writes", () => {
  test("the store refuses to live inside the vault", () => {
    expect(() => createStore(join(FIXTURE, "wiki", ".memory"), FIXTURE)).toThrow(/outside the vault/);
  });
  test("compare-and-swap: a note edited since it was read is never overwritten", async () => {
    const h = await setup();
    const rel = "wiki/topics/business/proposal-terms.md";
    const read = readFileSync(join(h.vault, rel), "utf8");
    writeFileSync(join(h.vault, rel), read + "\nEdited in Obsidian.\n");
    expect(() => writeNoteIfUnchanged(h.vault, rel, noteHash(read), "overwrite")).toThrow(VaultConflictError);
    expect(readFileSync(join(h.vault, rel), "utf8")).toContain("Edited in Obsidian.");
  });
  test("save to the vault with a stale expected hash surfaces a conflict and writes nothing", async () => {
    const h = await setup();
    const before = snapshot(h.vault);
    const r = await h.api.saveToVault(usman, { text: "Synthetic Kea proposals include a site audit.", bucket: "business", expected_hash: "0".repeat(64) });
    expect(!r.ok && r.code).toBe("vault-conflict");
    expect(snapshot(h.vault)).toEqual(before);
  });
  test("a vault fact correction with a stale version hash is refused", async () => {
    const h = await setup();
    const r = await h.api.correct(usman, "mf-00000000a1", { text: "The synthetic demo line answers from 6am to 9pm Sydney time.", expected_version_hash: "f".repeat(64) });
    expect(!r.ok && r.code).toBe("vault-conflict");
  });
  test("duplicates and conflicts are surfaced, not merged silently", async () => {
    const h = await setup();
    const a = await h.api.remember(usman, { text: "Synthetic Kea proposals go out as PDF only.", channel: "voice" });
    const b = await h.api.remember(usman, { text: "Synthetic Kea proposals go out as PDF only.", channel: "voice" });
    expect(b.ok && b.duplicate).toBe(true);
    expect(a.ok && b.ok && a.memory.id === b.memory.id).toBe(true);
    const c = await h.api.remember(usman, { text: "Synthetic Kea proposals go out as Word files only.", channel: "voice" });
    expect(!c.ok && c.code).toBe("conflict");
    const d = await h.api.remember(usman, { text: "Synthetic Kea proposals go out as Word files only.", channel: "voice", onConflict: "keep-both" });
    expect(d.ok).toBe(true);
  });
});
