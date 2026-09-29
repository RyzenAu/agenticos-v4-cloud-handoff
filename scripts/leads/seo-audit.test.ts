import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSeoAudit,
  runSeoAudit,
  SeoAuditBusyError,
  SeoAuditConfigError,
  seoOpenerHook,
  seoVerifiedFacts,
  topFindings,
} from "./seo-audit";

const SAMPLE_ACTIONS = [
  { id: "JEV-001", severity: "high", priority: "P1", category: "performance", title: "Slow server response (TTFB above 0.8 s)", evidence: "3 pages" },
  { id: "JEV-002", severity: "high", priority: "P1", category: "crawl", title: "Pages blocked from Google", evidence: "the services page returns noindex" },
  { id: "JEV-003", severity: "medium", priority: "P2", category: "onpage", title: "Very short or very long titles", evidence: "5 pages" },
  { id: "JEV-004", severity: "low", priority: "P3", category: "links", title: "Internal links with generic anchor text", evidence: "12 links" },
];

describe("topFindings", () => {
  test("takes the first n actions as-is (jev-seo's scorer already ranks them)", () => {
    const found = topFindings({ actions: SAMPLE_ACTIONS }, 3);
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.id)).toEqual(["JEV-001", "JEV-002", "JEV-003"]);
    expect(found[0]).toEqual({
      id: "JEV-001", severity: "high", priority: "P1", category: "performance",
      title: "Slow server response (TTFB above 0.8 s)", evidence: "3 pages",
    });
  });
  test("copes with a missing or empty actions array", () => {
    expect(topFindings({}, 3)).toEqual([]);
    expect(topFindings({ actions: [] }, 3)).toEqual([]);
  });
});

describe("seoOpenerHook", () => {
  test("joins the top two finding titles naturally", () => {
    const hook = seoOpenerHook(topFindings({ actions: SAMPLE_ACTIONS }, 3));
    expect(hook).toBe("slow server response (ttfb above 0.8 s) and pages blocked from google");
  });
  test("a single finding is not joined", () => {
    expect(seoOpenerHook(topFindings({ actions: SAMPLE_ACTIONS.slice(0, 1) }, 3))).toBe("slow server response (ttfb above 0.8 s)");
  });
  test("no findings gives an empty string", () => {
    expect(seoOpenerHook([])).toBe("");
  });
});

describe("seoVerifiedFacts", () => {
  test("pairs each title with its own evidence", () => {
    const facts = seoVerifiedFacts(topFindings({ actions: SAMPLE_ACTIONS }, 2));
    expect(facts).toEqual([
      "Slow server response (TTFB above 0.8 s) (3 pages)",
      "Pages blocked from Google (the services page returns noindex)",
    ]);
  });
  test("a finding with no evidence keeps just its title", () => {
    expect(seoVerifiedFacts([{ id: "x", severity: "low", priority: "P3", category: "c", title: "No favicon declared", evidence: "" }]))
      .toEqual(["No favicon declared"]);
  });
});

describe("runSeoAudit guards", () => {
  function fakeSpawn(): any {
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit("close", 0), 5);
    return child;
  }

  test("refuses a lead with no website", async () => {
    await expect(runSeoAudit({ id: 1, website: "" }, { root: "." })).rejects.toThrow("This lead has no website on file.");
  });

  test("refuses when neither TYPESAFE_API_KEY nor JEV_API_KEY is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-audit-"));
    try {
      // env: {} and home: dir isolate providerKey's lookup from this machine's real process.env
      // and ~/.config/agentic-os.env, which do carry a real key -- that's the whole point of this
      // feature, but it means the "missing key" guard can only be tested with an isolated lookup.
      await expect(
        runSeoAudit({ id: 1, website: "https://example.com" }, { root: dir, spawnFn: fakeSpawn as any, env: {}, home: dir }),
      ).rejects.toBeInstanceOf(SeoAuditConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only one audit can run at a time, regardless of lead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-audit-"));
    writeFileSync(join(dir, ".env.local"), "TYPESAFE_API_KEY=test-key-not-real\n");
    try {
      function slowSpawn(): any {
        const child = new EventEmitter() as any;
        child.stderr = new EventEmitter();
        child.kill = () => {};
        // Never closes on its own -- simulates a long-running crawl so the second call observes
        // the module-wide lock before the first one finishes. A short timeoutMs cleans it up fast.
        return child;
      }
      const first = runSeoAudit({ id: 1, website: "https://example.com" }, { root: dir, spawnFn: slowSpawn as any, timeoutMs: 50 });
      await new Promise((r) => setTimeout(r, 10));
      await expect(runSeoAudit({ id: 2, website: "https://example.org" }, { root: dir, spawnFn: fakeSpawn as any }))
        .rejects.toBeInstanceOf(SeoAuditBusyError);
      first.catch(() => {}); // leave the first to time out/be killed in the background; not this test's concern
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSeoAudit returns null when no audit has run yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-audit-"));
    try {
      expect(readSeoAudit(dir, 999)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
