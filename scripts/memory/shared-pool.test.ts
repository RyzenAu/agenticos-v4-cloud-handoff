// V7/V8: ONE shared business-memory pool. No per-person memory permissions: the person is provenance
// ("saved by"), never an access boundary; "personal" is a topic label. TEMP synthetic vault only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { memoryMiddleware, memoryPrincipalFrom } from "./plugin";
import { cleanup, mehroz, setup, usman } from "./testing/harness";

afterEach(cleanup);
const T = { timeout: 30_000 };

/** A legacy per-person fact page, as the old wiki-canonical vault wrote it (scope "usman"). */
const LEGACY = `---
title: Memory Personal Usman
bucket: personal
memory_scope: usman
---

# Memory Personal Usman

<!-- memory:begin mf-00000000c1 -->
## Quiet study room
<!-- memory:meta {"wiki_ref":"mf-00000000c1","chain":"mf-00000000c1","version":1,"scope":"usman","bucket":"personal","status":"current","created":"2026-09-21T01:00:00.000Z","updated":"2026-09-21T01:00:00.000Z","saved_by":"usman","origin":{"kind":"ui"},"supersedes":null,"superseded_by":null} -->
The synthetic founders prefer the quiet study room on Thursdays. ^mf-00000000c1

*Saved 2026-09-21 by Usman · ui*
<!-- memory:end mf-00000000c1 -->
`;

describe("one shared pool", () => {
  test(
    "a legacy per-person page is merged into the pool: the other founder reads and corrects it; saved-by is provenance",
    async () => {
      const h = await setup({ proxy: true });
      mkdirSync(join(h.vault, "wiki", "topics", "personal"), { recursive: true });
      writeFileSync(join(h.vault, "wiki", "topics", "personal", "memory-personal-usman.md"), LEGACY);
      await h.api.sync({ force: true });
      const seen = await h.api.recall(mehroz, "quiet study room Thursdays");
      expect(seen.facts[0]?.id).toBe("mf-00000000c1");
      expect(h.api.item("mf-00000000c1")!.row.actor).toBe("Usman"); // provenance, shown as a name
      const c = await h.api.correct(mehroz, "mf-00000000c1", { text: "The synthetic founders prefer the quiet study room on Fridays." });
      expect(c.ok).toBe(true);
      if (c.ok) expect(h.api.item(c.id)!.row.actor).toBe("Mehroz");
      // New saves go to the shared page; "personal" is only the topic label.
      const v = await h.api.saveToVault(usman, { text: "The synthetic founders' family lunch is on Sundays.", bucket: "personal" });
      expect(v.ok && v.fact.source.path).toBe("wiki/topics/personal/memory-personal-shared.md");
      expect((await h.api.recall(mehroz, "family lunch Sundays")).facts.map((f) => f.id)).toContain(v.ok ? v.fact.wiki_ref : "");
    },
    T,
  );

  test(
    "ordinary personal details are stored and synced like anything else (owner, 28 Sep)",
    async () => {
      const h = await setup({ proxy: true });
      const m = await h.api.remember(usman, { text: "The synthetic courier Dana's mobile is 0412 555 019.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("confirmed");
      expect(h.bankDocs().get(m.memory.id)?.content).toContain("0412 555 019");
      const v = await h.api.saveToVault(usman, { from_memory: m.memory.id });
      expect(v.ok).toBe(true);
    },
    T,
  );

  test("GET /__memory/buckets says whether writes are on, and counts per topic bucket", async () => {
    for (const writes of [true, false]) {
      const h = await setup({ proxy: true, writes });
      await h.api.sync({ force: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => mehroz });
      const r = await new Promise<{ status: number; body: any }>((resolve) => {
        const req = Object.assign(Readable.from([]), { method: "GET", url: "/buckets", headers: { host: "localhost:8081" }, socket: { remoteAddress: "127.0.0.1" } });
        let status = 200;
        mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end(b: string) { resolve({ status, body: JSON.parse(b) }); } } as never, () => resolve({ status: 404, body: null }));
      });
      expect(r.status).toBe(200);
      expect(r.body.writes).toBe(writes ? "on" : "off");
      expect(r.body.buckets.map((b: { bucket: string }) => b.bucket)).toEqual(["business", "finance", "deen", "research", "personal", "general"]);
      expect(r.body.buckets.find((b: { bucket: string }) => b.bucket === "business").current).toBeGreaterThan(0);
      await cleanup();
    }
  });

  test("the OS Principal (resolvePrincipal) maps to provenance only", () => {
    // Provenance: id, name, via (and B1's actor). B1's own principal rides along server-side only (`os`),
    // for the approval service (Track 6); it never widens or narrows what anyone can read.
    expect(memoryPrincipalFrom({ personId: "mehroz", via: "tailnet-person" })).toEqual({ id: "mehroz", name: "Mehroz", via: "tailnet", os: { personId: "mehroz", via: "tailnet-person" } });
    expect(memoryPrincipalFrom({ personId: "usman", via: "loopback-owner", displayName: "Usman" })).toEqual({ id: "usman", name: "Usman", via: "local", os: { personId: "usman", via: "loopback-owner" } });
    expect(memoryPrincipalFrom({ personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-00000001" } as never)?.os).toEqual({
      personId: "usman",
      via: "loopback-owner",
      actor: "human",
      sessionId: "sess-usman-00000001",
    });
    expect(memoryPrincipalFrom({ personId: "", via: "loopback-owner" })).toBeNull();
    expect(memoryPrincipalFrom(null)).toBeNull();
  });
});
