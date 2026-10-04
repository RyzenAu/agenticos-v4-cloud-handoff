// Saved results (round 7): a finished job's output is reachable, openable and downloadable, and a job never reads "working" because of a slow delivery;
// a result the hub could not keep is not called complete. SYNTHETIC: in-process computer with the real Linux executors, the real hub routes and artifact store.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinuxExecutors } from "../../companion/linux/executors-linux";
import { createArtifactStore, downloadDisposition } from "./artifacts";
import { runResearch, type CallResult, type ResearchIO } from "./research";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(40_000);

let hub: ComputersHub | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bizprepHub(over: { deliver?: NonNullable<Parameters<typeof startComputersHub>[0]>["research"] extends infer R ? (R extends { deliver: infer D } ? D : never) : never; deliverTimeoutMs?: number; deliverRetryMs?: number } = {}) {
  const delivered: string[] = [];
  hub = await startComputersHub({
    artifacts: true,
    deliverTimeoutMs: over.deliverTimeoutMs,
    deliverRetryMs: over.deliverRetryMs,
    workflows: { delegate: null, hostLabel: () => "synthetic in-process computer" },
    research: { search: null, delegate: null, deliver: over.deliver ?? (async (i) => (delivered.push(i.jobId), { delivered: true, where: "your conversation" })) },
  });
  const dir = mkdtempSync(join(tmpdir(), "r7-results-"));
  dirs.push(dir);
  hub.host.executorsFor = (name) => createLinuxExecutors({ name, workdir: join(dir, name) });
  expect((await hub.api("usman", "POST", "/", { name: "builder" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("builder").state === "online");
  return { h: hub, delivered };
}
const ended = (h: ComputersHub, id: string) => h.waitFor("the job to end", () => (["succeeded", "failed", "cancelled", "unknown", "interrupted"].includes(h.computers.jobView(id)?.state ?? "") ? h.computers.jobView(id) : null), 20_000);
const get = (h: ComputersHub, who: "usman" | "mehroz", path: string) => fetch(`${h.base}/__computers${path}`, { headers: h.headers(who, false) });

describe("a saved result opens and downloads, for its owner only", () => {
  test("the file route serves the right type and, when asked, as a named attachment; another founder gets nothing", async () => {
    const { h } = await bizprepHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    expect(r.status).toBe(200);
    expect((await ended(h, r.json.jobId))!.state).toBe("succeeded");
    const id = r.json.jobId as string;

    const open = await get(h, "usman", `/artifacts/${id}/f/comparison.csv`);
    expect(open.status).toBe(200);
    expect(open.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(open.headers.get("content-disposition")).toBeNull(); // opening is not downloading

    const dl = await get(h, "usman", `/artifacts/${id}/f/comparison.csv?download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="comparison\.csv"/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Number(dl.headers.get("content-length"))).toBe((await dl.arrayBuffer()).byteLength);
    expect((await get(h, "usman", `/artifacts/${id}/f/comparison.md?download=1`)).headers.get("content-type")).toMatch(/^text\/markdown/);

    // identity-gated: the other founder can neither open nor download it
    for (const who of ["mehroz"] as const) {
      expect((await get(h, who, `/artifacts/${id}/f/comparison.csv?download=1`)).status).toBe(404);
      expect((await get(h, who, `/artifacts/${id}`)).status).toBe(404);
    }
    // a file that is not in the result, or a path out of it
    expect((await get(h, "usman", `/artifacts/${id}/f/nope.csv?download=1`)).status).toBe(404);
    expect((await get(h, "usman", `/artifacts/${id}/f/..%2Fmeta.json?download=1`)).status).toBe(404);

    // the result page lists every file with a Download link
    const page = await (await get(h, "usman", `/artifacts/${id}`)).text();
    expect(page).toContain(`/__computers/artifacts/${id}/f/comparison.csv?download=1`);
    expect(page).toContain("Download");
  });

  test("a file name is made safe for the header, whatever it holds", () => {
    expect(downloadDisposition("report-20261003T101010.md")).toBe(`attachment; filename="report-20261003T101010.md"; filename*=UTF-8''report-20261003T101010.md`);
    const evil = downloadDisposition('a"b\r\nSet-Cookie: x=1.md');
    expect(evil).not.toMatch(/[\r\n]/);
    expect(evil.split(";")[1]).toBe(' filename="a_b__Set-Cookie__x_1.md"');
  });

  test("RFC 5987: ' ( ) * are escaped in filename*, and a long name is trimmed BEFORE encoding so an escape is never cut in half", () => {
    const d = downloadDisposition("it's (a) *report*.md");
    expect(d).toContain("filename*=UTF-8''it%27s%20%28a%29%20%2Areport%2A.md");
    expect(d.split("filename*=UTF-8''")[1]).not.toMatch(/['()*]/);
    const long = downloadDisposition(`${"é".repeat(200)}.md`);
    const star = long.split("filename*=UTF-8''")[1];
    expect(star).toMatch(/^(?:%[0-9A-F]{2})+$/); // whole escapes only
    expect(decodeURIComponent(star)).toBe("é".repeat(120)); // a whole number of characters, no URIError
    expect(downloadDisposition("😀".repeat(130)).split("''")[1]).toMatch(/^(?:%[0-9A-F]{2})+$/); // surrogate pairs are not split
  });

  test("a saved result outlives the computer: it still lists and opens after the computer is destroyed", async () => {
    const { h } = await bizprepHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    await ended(h, r.json.jobId);
    expect((await h.api("usman", "POST", "/builder/action", { action: "destroy" })).status).toBe(200);
    expect((await get(h, "usman", `/artifacts/${r.json.jobId}/f/comparison.md?download=1`)).status).toBe(200);
    expect((await h.api("usman", "GET", "/artifacts")).json.artifacts.map((a: { id: string }) => a.id)).toEqual([r.json.jobId]);
  });
});

describe("a finished job settles", () => {
  test("a conversation that never answers does not hold the job open: it settles succeeded, with its result saved and listed", async () => {
    const { h } = await bizprepHub({ deliver: () => new Promise(() => undefined), deliverTimeoutMs: 300 });
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    const t0 = Date.now();
    const job = await ended(h, r.json.jobId);
    expect(job!.state).toBe("succeeded"); // before the fix this never left "running"
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(h.artifacts!.get(r.json.jobId, "usman")).toMatchObject({ kind: "bizprep", outcome: "complete" });
    expect(h.computers.view("builder").controller.kind).toBeNull(); // and the computer was freed
  });

  test("a delivery that lands AFTER the job settled corrects the job's note (it had said the result was not delivered)", async () => {
    const { h } = await bizprepHub({ deliver: () => new Promise((r) => setTimeout(() => r({ delivered: true, where: "your conversation" }), 700)), deliverTimeoutMs: 200, deliverRetryMs: 5_000 });
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    expect((await ended(h, r.json.jobId))!.state).toBe("succeeded");
    await h.waitFor("the note to be corrected", () => /reached your conversation after the job ended/.test(h.jobs.get(r.json.jobId)?.note ?? ""));
    expect(h.jobs.get(r.json.jobId)?.state).toBe("succeeded"); // the state is never changed
  });

  test("a delivery that never lands is tried once more later, and a landing then corrects the note", async () => {
    let calls = 0;
    const { h } = await bizprepHub({ deliver: () => (++calls === 1 ? new Promise(() => undefined) : Promise.resolve({ delivered: true, where: "your conversation" })), deliverTimeoutMs: 200, deliverRetryMs: 300 });
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    expect((await ended(h, r.json.jobId))!.state).toBe("succeeded");
    await h.waitFor("the retry", () => /reached your conversation after the job ended/.test(h.jobs.get(r.json.jobId)?.note ?? ""));
    expect(calls).toBe(2); // once more, not a loop
  });

  test("a conversation that throws does not fail the job either", async () => {
    const { h } = await bizprepHub({ deliver: async () => { throw new Error("store is locked"); } });
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    expect((await ended(h, r.json.jobId))!.state).toBe("succeeded");
    expect(h.artifacts!.get(r.json.jobId, "usman")).not.toBeNull();
  });
});

describe("a result the hub could not keep is not called complete", () => {
  const PAGE = "Canberra was founded in 1913 when the capital was formally named on 12 March 1913 by Lady Denman. Canberra is the planned capital of Australia.";
  function web(artifact: ResearchIO["artifact"]) {
    let cur = "";
    const call = async (executor: string, args: Record<string, unknown>): Promise<CallResult> => {
      if (executor === "browser.navigate") return (cur = String(args.url)), { kind: "ok", ok: true, said: "Opened", verified: true, data: { title: "History of Canberra | NCA", url: cur, tabId: "t" } };
      if (executor === "page.text") return { kind: "ok", ok: true, said: "Read", verified: true, data: { title: "History of Canberra | NCA", url: cur, total: PAGE.length, offset: 0, text: PAGE.slice(0, Number(args.limit)), links: [] } };
      return { kind: "ok", ok: true, said: "Wrote", verified: true };
    };
    const io: ResearchIO = {
      signal: new AbortController().signal, call, step: () => undefined, boundary: async () => "go", ask: null, delegate: null, retryDelayMs: 0,
      search: async () => [{ title: "History of Canberra | NCA", url: "https://www.nca.gov.au/history", snippet: "Canberra founded named history" }],
      deliver: async () => ({ delivered: true, where: "your conversation" }),
      artifact,
    };
    return io;
  }
  const goal = "when Canberra was founded and named";

  test("kept: complete. Not kept: partial, and the note says it could not be kept as a saved result", async () => {
    const kept = await runResearch({ goal, io: web(() => ({ saved: true, title: "Research: Canberra" })), limits: { maxPages: 2 } });
    expect(kept.ok).toBe(true);
    expect(kept.outcome).toBe("complete");
    const lost = await runResearch({ goal, io: web(() => ({ saved: false, title: "" })), limits: { maxPages: 2 } });
    expect(lost.ok).toBe(true);
    expect(lost.outcome).toBe("partial"); // before the fix: "complete", and nobody could open the result
    expect(lost.note).toMatch(/could not be kept as a saved result/);
    const threw = await runResearch({ goal, io: web(() => { throw new Error("disk full"); }), limits: { maxPages: 2 } });
    expect(threw.outcome).toBe("partial");
  });

  test("the artifact store refuses what it cannot keep, loudly (too many files, a bad name, no main file), and keeps nothing half-made", () => {
    const d = mkdtempSync(join(tmpdir(), "r7-art-"));
    dirs.push(d);
    const s = createArtifactStore(d);
    const base = { jobId: "11111111-2222-4333-8444-555555555555", personId: "usman", kind: "research" as const, title: "t", summary: "s", host: "h", computer: "c", outcome: "complete", main: "a.md" };
    expect(s.save({ ...base, files: [{ name: "../a.md", data: "x" }] })).toMatchObject({ ok: false });
    expect(s.save({ ...base, files: [{ name: "b.md", data: "x" }] })).toMatchObject({ ok: false });
    expect(s.list("usman")).toEqual([]);
    expect(s.save({ ...base, files: [{ name: "a.md", data: "x" }] })).toMatchObject({ ok: true, created: true });
  });
});
