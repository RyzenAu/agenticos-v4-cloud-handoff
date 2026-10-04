import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinuxExecutors } from "../../companion/linux/executors-linux";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(60_000);

/**
 * Working files persist (X15): a file a job writes into a computer's own working folder survives a restart of that computer
 * (stop and start, suspend and resume, a recovery after a crash) AND a restart of the hub. The computers here run the real Linux
 * executors (file.write / file.read / file.list) over real folders; only the host is simulated. Destroy is the one thing that removes
 * files, and only because a founder asked.
 */

let hub: ComputersHub | undefined;
let work = "";
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  if (work) rmSync(work, { recursive: true, force: true });
  work = "";
});

const settled = (h: ComputersHub, id: string) => ["succeeded", "failed", "unknown", "cancelled"].includes(h.computers.jobView(id)?.state ?? "");

async function run(h: ComputersHub, steps: { executor: string; args?: Record<string, unknown> }[], who: "usman" | "mehroz" = "usman") {
  const r = await h.api(who, "POST", "/research/jobs", { agent: "files", steps });
  expect(r.status).toBe(200);
  await h.waitFor("job settled", () => settled(h, r.json.jobId));
  return h.computers.jobView(r.json.jobId)!;
}

async function setup() {
  work = mkdtempSync(join(tmpdir(), "computer-work-"));
  hub = await startComputersHub();
  hub.host.executorsFor = (name) => createLinuxExecutors({ name, workdir: join(work, name) });
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  return hub;
}

describe("a computer's working files persist", () => {
  test("a file written by a job survives stop and start, suspend and resume, and a crash with recovery", async () => {
    const h = await setup();
    const wrote = await run(h, [{ executor: "file.write", args: { name: "notes.txt", text: "kept across restarts" } }]);
    expect(wrote.state).toBe("succeeded");
    expect(readFileSync(join(work, "research", "notes.txt"), "utf8")).toBe("kept across restarts");

    // stop and start
    expect((await h.api("usman", "POST", "/research/action", { action: "stop" })).json.computer.state).toBe("offline");
    expect((await h.api("usman", "POST", "/research/action", { action: "start" })).status).toBe(200);
    await h.waitFor("online", () => h.computers.view("research").state === "online");
    const afterStop = await run(h, [{ executor: "file.read", args: { name: "notes.txt" } }]);
    expect(afterStop.state).toBe("succeeded");
    expect(afterStop.steps[0].intent).toMatch(/Read notes.txt \(20 bytes\)/);

    // suspend and resume (a job wakes it)
    expect((await h.api("usman", "POST", "/research/action", { action: "suspend" })).json.computer.state).toBe("asleep");
    const afterSleep = await run(h, [{ executor: "file.list" }, { executor: "file.read", args: { name: "notes.txt" } }], "mehroz");
    expect(afterSleep.state).toBe("succeeded");
    expect(afterSleep.steps.map((s) => s.intent).join("|")).toMatch(/1 file in the working folder.*Read notes.txt/);

    // a crash and recovery
    h.host.crash("research");
    await h.computers.tick();
    await h.waitFor("failed", () => h.computers.view("research").state === "failed");
    await h.api("usman", "POST", "/research/action", { action: "recover" });
    await h.waitFor("online", () => h.computers.view("research").state === "online");
    const afterCrash = await run(h, [{ executor: "file.read", args: { name: "notes.txt" } }]);
    expect(afterCrash.state).toBe("succeeded");
  });

  test("a file survives a restart of the hub: the computer is remembered, reconnects, and its files are still there", async () => {
    const h = await setup();
    await run(h, [{ executor: "file.write", args: { name: "before-hub-restart.txt", text: "still here" } }]);
    const id = h.computers.view("research").id;
    const { root, port, host } = h;

    await h.close({ root: true, host: true }); // the hub process goes away; the computer's own process and folder stay
    hub = undefined;
    const again = await startComputersHub({ restart: { root, port }, host });
    hub = again;
    // remembered from the data folder, same device, reconnects on its own
    expect(again.computers.list().map((c) => c.name)).toEqual(["research"]);
    await again.waitFor("the computer to reconnect", () => again.computers.view("research").state === "online", 15_000);
    expect(again.computers.view("research").id).toBe(id);
    const read = await run(again, [{ executor: "file.read", args: { name: "before-hub-restart.txt" } }]);
    expect(read.state).toBe("succeeded");
    expect(read.steps[0].intent).toMatch(/Read before-hub-restart.txt \(10 bytes\)/);
    const both = await run(again, [{ executor: "file.write", args: { name: "after-hub-restart.txt", text: "new" } }, { executor: "file.list" }]);
    expect(both.state).toBe("succeeded");
    expect(existsSync(join(work, "research", "before-hub-restart.txt"))).toBe(true);
    expect(existsSync(join(work, "research", "after-hub-restart.txt"))).toBe(true);
  });

  test("files are per computer: another computer never sees them", async () => {
    const h = await setup();
    expect((await h.api("mehroz", "POST", "/", { name: "builder" })).status).toBe(200);
    await h.waitFor("both online", () => h.computers.list().every((c) => c.state === "online"));
    await run(h, [{ executor: "file.write", args: { name: "private.txt", text: "research only" } }]);
    const r = await h.api("usman", "POST", "/builder/jobs", { steps: [{ executor: "file.read", args: { name: "private.txt" } }] });
    await h.waitFor("settled", () => settled(h, r.json.jobId));
    expect(h.computers.jobView(r.json.jobId)!.state).toBe("failed");
    expect(existsSync(join(work, "builder", "private.txt"))).toBe(false);
  });
});
