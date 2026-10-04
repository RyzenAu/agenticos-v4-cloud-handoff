// F-01 (audit 1): every Open, file and Download link in Tasks & Files used the service's label `artifact:<jobId>` and returned 404. The href must be one the real
// artifacts route accepts. SYNTHETIC: the in-process computer and the real hub routes.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinuxExecutors } from "../../../../companion/linux/executors-linux";
import { startComputersHub, type ComputersHub } from "../../../../scripts/computers/test-harness";
import { fileHref, serviceFiles } from "./tasks";

setDefaultTimeout(40_000);
let hub: ComputersHub | undefined;
let dir = "";
afterEach(async () => { await hub?.close(); hub = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("saved-result links match what the artifacts route accepts", () => {
  test("the href built from a service row (artifact:<jobId>) opens, and its file downloads, on the real route; the old href 404s", async () => {
    hub = await startComputersHub({ artifacts: true, workflows: { delegate: null, hostLabel: () => "synthetic in-process computer" }, research: { search: null, delegate: null, deliver: async () => ({ delivered: true, where: "your conversation" }) } });
    dir = mkdtempSync(join(tmpdir(), "r7-links-"));
    hub.host.executorsFor = (name) => createLinuxExecutors({ name, workdir: join(dir, name) });
    expect((await hub.api("usman", "POST", "/", { name: "builder" })).status).toBe(200);
    await hub.waitFor("online", () => hub!.computers.view("builder").state === "online");
    const r = await hub.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    const jobId = r.json.jobId as string;
    await hub.waitFor("the job to end", () => ["succeeded", "failed"].includes(hub!.computers.jobView(jobId)?.state ?? ""));
    // The row exactly as the agents service labels it.
    const [file] = serviceFiles([{ artifact: `artifact:${jobId}`, title: "Comparison", jobId, createdAt: Date.now(), source: "computer", files: [{ name: "comparison.csv", bytes: 10 }] }]);
    expect(file.id).toBe(jobId);
    const get = (href: string) => fetch(`${hub!.base}${href.replace(/^\/__computers/, "/__computers")}`, { headers: hub!.headers("usman", false) });
    expect((await get(fileHref(file.id))).status).toBe(200);
    expect((await get(fileHref(file.id, "comparison.csv"))).status).toBe(200);
    const dl = await get(fileHref(file.id, "comparison.csv", true));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/attachment/);
    // The label itself is never put in an address, whichever way it reaches fileHref.
    expect(fileHref(`artifact:${jobId}`, "comparison.csv")).toBe(fileHref(jobId, "comparison.csv"));
    expect((await get(`/__computers/artifacts/${encodeURIComponent(`artifact:${jobId}`)}`)).status).toBe(404);
  });
});
