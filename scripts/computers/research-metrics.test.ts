import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPage, createArtifactStore } from "./artifacts";
import { runResearch, type CallResult, type Metrics, type ResearchIO } from "./research";
import { researchArtifact } from "./workflows";
import { startComputersHub, type ComputersHub } from "./test-harness";

// Synthetic public-page data. All asynchronous work below is local; no web/model calls.
const GOAL = "when Canberra was founded and named";
const PAGE = "Canberra was founded in 1913 when the capital was formally named on 12 March 1913 by Lady Denman. Canberra is the planned capital of Australia.";
const SOURCE = { title: "History of Canberra | NCA", url: "https://www.nca.gov.au/history", snippet: "Canberra founded named history" };
const JOB = "11111111-2222-4333-8444-555555555555";
const START = Date.parse("2026-10-05T00:00:00.000Z");

function pageCall(executor: string, args: Record<string, unknown>): CallResult {
  if (executor === "browser.navigate") return { kind: "ok", ok: true, said: "Opened", verified: true, data: { title: SOURCE.title, url: SOURCE.url, tabId: "t" } };
  if (executor === "page.text") return { kind: "ok", ok: true, said: "Read", verified: true, data: { title: SOURCE.title, url: SOURCE.url, total: PAGE.length, offset: 0, text: PAGE.slice(0, Number(args.limit)), links: [] } };
  return { kind: "ok", ok: true, said: "Wrote and read back", verified: true };
}

let hub: ComputersHub | undefined;
let restoreClock: (() => void) | undefined;
const dirs: string[] = [];
afterEach(async () => {
  try { await hub?.close(); } finally {
    hub = undefined;
    restoreClock?.();
    restoreClock = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("research metrics at the saved-report boundary", () => {
  test("the real service persists measured research time before delivery, distinct from the whole Activity", async () => {
    let time = START;
    const clock = spyOn(Date, "now").mockImplementation(() => time);
    restoreClock = () => clock.mockRestore();
    const stages: string[] = [];
    const advance = async (name: string, ms: number) => {
      await Promise.resolve();
      stages.push(name);
      time += ms;
    };
    hub = await startComputersHub({
      goalAsk: null, artifacts: true,
      research: {
        search: async () => { await advance("search", 4_000); return [SOURCE]; },
        delegate: null,
        deliver: async () => { await advance("deliver", 6_000); return { delivered: true, where: "your conversation" }; },
      },
    });
    const h = hub;
    h.host.executorsFor = () => Object.fromEntries(([
      ["echo", 3_000], ["browser.navigate", 5_000], ["page.text", 6_000], ["file.write", 2_000],
    ] as const).map(([name, ms]) => [name, async (args: Record<string, unknown>) => {
      await advance(name, ms);
      const r = pageCall(name, args);
      if (r.kind !== "ok") throw new Error("Unexpected synthetic page result");
      return { ok: r.ok, said: r.said, verified: r.verified, ...(r.data ? { data: r.data } : {}) };
    }]));
    expect((await h.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    await h.waitFor("online", () => h.computers.view("research").state === "online");
    const started = await h.api("usman", "POST", "/research/jobs", { agent: "researcher", steps: [
      { executor: "echo", args: {} },
      { executor: "research", args: { goal: GOAL } },
    ] });
    expect(started.status).toBe(200);
    const id = started.json.jobId as string;
    await h.waitFor("job done", () => ["succeeded", "failed", "unknown", "cancelled"].includes(h.jobs.get(id)?.state ?? ""), 30_000);
    const job = h.jobs.get(id)!;
    expect(job.state).toBe("succeeded");
    expect(stages).toEqual(["echo", "search", "browser.navigate", "page.text", "file.write", "deliver"]);
    expect(Date.parse(job.updatedAt) - Date.parse(job.createdAt)).toBe(26_000);
    expect(job.steps.find((s) => s.verification?.method === "research")?.ms).toBe(23_000);
    const file = h.artifacts!.file(id, "usman", "report.md")!;
    expect(file.data.toString()).toContain("17 s research elapsed.");
    // Read the persisted bytes through a fresh store and the actual HTML renderer, not a mutable Metrics reference.
    const reopened = createArtifactStore(h.artifacts!.dir);
    const persisted = reopened.file(id, "usman", "report.md")!;
    const html = artifactPage(persisted.meta, persisted.data.toString(), `/__computers/artifacts/${id}`);
    expect(html).toContain("17 s research elapsed.");
    expect(persisted.data.equals(file.data)).toBe(true);
  });

  test("artifact metrics and the completion note include accumulated model cost before finish returns", async () => {
    let time = START;
    let delegateCost = 0;
    let jevTokens = 0;
    let atSave = 0;
    let snapshot: Metrics | undefined;
    const steps: string[] = [];
    const io: ResearchIO = {
      signal: new AbortController().signal, now: () => time, retryDelayMs: 0,
      boundary: async () => "go", step: (s) => void steps.push(s.intent),
      search: async () => { await Promise.resolve(); time += 1_000; return [SOURCE]; },
      call: async (e, a) => { await Promise.resolve(); time += 2_000; return pageCall(e, a); },
      ask: async (body) => {
        await Promise.resolve(); time += 500; jevTokens += 1_000;
        const pick = body.questions.pick as { criteria: Record<string, string> };
        const choice = Object.keys(pick.criteria)[0];
        return { ms: 500, inputTokens: 1_000, outputTokens: 1, model: "synthetic-jev", answers: { pick: { choice, confidence: 0.9 } } };
      },
      delegate: async (req) => {
        await Promise.resolve(); time += 1_000; delegateCost += 0.002;
        const text = req.label === "extract" ? JSON.stringify({ relevant: true, complete: true, facts: [{ claim: PAGE.split(". ")[0], quote: "Canberra was founded in 1913 when the capital was formally named on 12 March 1913 by Lady Denman." }] }) : req.label === "write" ? "- Canberra was founded and named on 12 March 1913 [1]" : "{}";
        return { text, model: "synthetic-model", inputTokens: 20, outputTokens: 10, costUsd: 0.002 };
      },
      artifact: (input) => { atSave = time; snapshot = structuredClone(input.metrics); return { saved: true, title: "Research" }; },
      deliver: async () => { await Promise.resolve(); time += 7_000; return { delivered: true, where: "your conversation" }; },
    };
    const result = await runResearch({ goal: GOAL, io });
    expect(result.ok).toBe(true);
    expect(snapshot).toBeDefined();
    expect(snapshot!.wallMs).toBe(atSave - START);
    expect(result.metrics.wallMs).toBe(snapshot!.wallMs + 7_000);
    const expectedCost = delegateCost + jevTokens * 0.042 / 1e6;
    expect(expectedCost).toBeGreaterThan(0);
    expect(snapshot!.estCostUsd).toBeCloseTo(expectedCost, 10);
    expect(result.metrics.estCostUsd).toBeCloseTo(expectedCost, 10);
    expect(steps.find((s) => /^research (complete|partial):/.test(s))).toContain(`est. cost US$${expectedCost.toFixed(4)}`);
  });

  test.each([0, 120])("an actual %i ms report is not padded to a made-up nonzero duration", async (duration) => {
    let time = START;
    let savedMs = -1;
    const dir = mkdtempSync(join(tmpdir(), "research-metrics-"));
    dirs.push(dir);
    const store = createArtifactStore(dir, () => time);
    const result = await runResearch({ goal: GOAL, io: {
      signal: new AbortController().signal, now: () => time,
      boundary: async () => "go", step: () => undefined, ask: null, delegate: null,
      search: async () => { await Promise.resolve(); time += duration; return [SOURCE]; },
      call: async (e, a) => pageCall(e, a),
      artifact: (input) => {
        savedMs = input.metrics.wallMs;
        const saved = store.save({ jobId: JOB, personId: "usman", computer: "synthetic", host: "synthetic", ...researchArtifact(input) });
        return { saved: saved.ok, title: "Research" };
      },
      deliver: async () => ({ delivered: true, where: "your conversation" }),
    } });
    expect(result.ok).toBe(true);
    expect(savedMs).toBe(duration);
    expect(result.metrics.wallMs).toBe(duration);
    expect(store.file(JOB, "usman", "report.md")!.data.toString()).toContain("0 s research elapsed.");
  });
});
