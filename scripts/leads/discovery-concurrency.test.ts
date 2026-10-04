import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm } from "./crm";
import { findLeadsOsm } from "./osm";
import { SEARXNG_URL } from "./discovery";

test("parallel discovery cannot borrow another lead's successful empty search as absence evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-concurrency-"));
  const oldHermesHome = process.env.HERMES_HOME;
  // Guaranteed empty scratch location: the real Hermes helper sees no configured key.
  process.env.HERMES_HOME = join(dir, "unconfigured-hermes");
  const db = openCrm(join(dir, "crm.sqlite"));
  let releaseFailed!: () => void;
  let markFailedStarted!: () => void;
  const failedGate = new Promise<void>((resolve) => { releaseFailed = resolve; });
  const failedStarted = new Promise<void>((resolve) => { markFailedStarted = resolve; });
  const requests: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.href);
    if (url.hostname === "overpass-api.de") {
      return Response.json({ elements: ["Failed Dental", "Answered Dental"].map((name, index) => ({
        type: "node", id: index + 1,
        tags: { name, "addr:suburb": "Mount Druitt", "addr:postcode": "2770" },
      })) });
    }
    if (url.origin === SEARXNG_URL && url.pathname === "/search") {
      if (url.searchParams.get("q")?.startsWith("Failed Dental")) {
        markFailedStarted();
        await failedGate;
        return new Response("Unavailable", { status: 503 });
      }
      await failedStarted;
      return Response.json({ results: [] });
    }
    if (url.href === "https://html.duckduckgo.com/robots.txt") {
      // This request follows the answered lead's counted SearXNG response. Only
      // then let the failed lead finish its own unavailable-provider cascade.
      releaseFailed();
      return new Response("User-agent: *\nDisallow: /\n");
    }
    throw new Error(`Unexpected synthetic request: ${url.href}`);
  }) as typeof fetch;
  try {
    const result = await findLeadsOsm(db, {
      vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing",
      request, concurrency: 2, enrichMax: 0, discovery: { guessSearch: async () => null },
    });
    expect(result.added).toHaveLength(2);
    expect(result.unverifiable).toBe(1);
    expect(result.added.find((lead) => lead.name === "Failed Dental")).toMatchObject({
      website: "", websiteCheckedAt: null, pitch: "audit_pending", score: 0,
    });
    const answered = result.added.find((lead) => lead.name === "Answered Dental");
    expect(answered?.websiteCheckedAt).toBeTruthy();
    expect(answered?.pitch).toBe("website");
    expect(requests).toHaveLength(5);
  } finally {
    releaseFailed();
    db.close();
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round 6 review: a Hermes reply alone never certifies 'no website'", async () => {
  const { discoverWebsiteDetailed } = await import("./discovery");
  const dir = mkdtempSync(join(tmpdir(), "discovery-hermes-only-"));
  const oldHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  await Bun.write(join(dir, ".env"), "API_SERVER_KEY=synthetic-test-key\n"); // fake key: nothing real is contacted
  const request = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === SEARXNG_URL) return new Response("Unavailable", { status: 503 }); // SearXNG down
    if (url.href === "https://html.duckduckgo.com/robots.txt") return new Response("User-agent: *\nDisallow: /\n"); // DuckDuckGo not usable
    if (url.pathname === "/health") return Response.json({ ok: true }); // Hermes is up ...
    if (url.pathname === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: '{"url": null, "confidence": 0}' } }] }); // ... and answers "none"
    throw new Error(`Unexpected synthetic request: ${url.href}`);
  }) as typeof fetch;
  try {
    const outcome = await discoverWebsiteDetailed({ name: "Quiet Dental", suburb: "Mount Druitt", vertical: "dental", phone: "" } as never, { request, guessSearch: async () => null });
    expect(outcome.kind).toBe("unverifiable"); // before: "none", which became the green "No website (verified)"
  } finally {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = oldHermesHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
