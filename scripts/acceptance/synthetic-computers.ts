import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Executor } from "../../companion/executors";
import { startComputersHub } from "../computers/test-harness";
import type { Ctx } from "./types";

/**
 * Task 2 at the synthetic-integration level: the REAL computers service, job store, device registry, leases and worker,
 * over HTTP, with an in-process host standing in for WSL. A computer's working folder is a real folder on disk; the
 * executors write and read real files in it. The observation is read straight from the folder, not from a job's words:
 * write the synthetic client note, suspend the computer (its session and worker are stopped), wake it with a new job, and
 * read the same file again.
 */
export async function filesAcrossSuspend(ctx: Ctx) {
  const workRoot = join(ctx.scratch, "synthetic-computer-work");
  mkdirSync(workRoot, { recursive: true });
  const hub = await startComputersHub();
  try {
    const work = join(workRoot, "research");
    mkdirSync(work, { recursive: true });
    const executors: Record<string, Executor> = {
      "file.write": async (args: any) => {
        writeFileSync(join(work, String(args.name)), String(args.text));
        return { ok: true, said: `Wrote ${args.name}.`, verified: true };
      },
      "file.read": async (args: any) => ({ ok: true, said: `Read ${args.name}.`, verified: true, data: { text: readFileSync(join(work, String(args.name)), "utf8") } }),
    };
    hub.host.executorsFor = () => executors;
    const made = await hub.api("usman", "POST", "/", { name: "research" });
    if (made.status !== 200) throw new Error(`provisioning failed: ${JSON.stringify(made.json).slice(0, 160)}`);
    await hub.waitFor("research online", () => hub.computers.view("research")?.state === "online");

    const name = ctx.fixtures.clientNote.file;
    const text = ctx.fixtures.clientNote.text;
    const w = await hub.api("usman", "POST", "/research/jobs", { agent: "note-taker", steps: [{ executor: "file.write", args: { name, text } }] });
    await hub.waitFor("the write job done", () => hub.computers.jobView(w.json.jobId)?.state === "succeeded");
    const before = existsSync(join(work, name)) ? { name, text: readFileSync(join(work, name), "utf8") } : null;

    const s = await hub.api("usman", "POST", "/research/action", { action: "suspend" });
    if (s.status !== 200) throw new Error(`suspend refused: ${JSON.stringify(s.json).slice(0, 160)}`);
    const asleep = hub.computers.view("research").state === "asleep";

    const r = await hub.api("mehroz", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "file.read", args: { name } }] });
    await hub.waitFor("the read job done", () => hub.computers.jobView(r.json.jobId)?.state === "succeeded");
    const after = existsSync(join(work, name)) ? { name, text: readFileSync(join(work, name), "utf8") } : null;
    return { before, after, restarted: asleep && hub.host.calls.suspend.length === 1 && hub.host.calls.resume.length === 1, expectedText: text };
  } finally {
    await hub.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}
