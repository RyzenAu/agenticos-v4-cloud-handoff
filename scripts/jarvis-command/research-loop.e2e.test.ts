// r5-conv, the whole loop on the REAL computers hub: a spoken "use the Research computer to research X" -> the real command service, resolver and
// computer command -> a real research job on a real (in-process) companion under the real control lease, with a founder taking the computer mid-run
// and handing it back -> the job's own steps and delivered report -> the asker's conversation, /__events stream and the voice gate.
//
// SYNTHETIC: the computer is the harness's in-process companion with a fake web (three executors) and a fake SearXNG; the voice session is
// `fakeVoice`. Real: JobService, the computers service, lease, research loop, job-thread watcher, conversation store, bus + stream, gate.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { computerCommand } from "../computers/jarvis";
import { threadDeliver } from "../computers/research-wiring";
import { startComputersHub, type ComputersHub } from "../computers/test-harness";
import { jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { withComputerResolution } from "./computer-target";
import { fakeVoice, loopRig, memoryStorage, type LoopRig } from "./research-loop-rig";
import { createCommandService } from "./service";

setDefaultTimeout(40_000);
const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
let hub: ComputersHub | undefined;
let rig: LoopRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  await hub?.close();
  hub = undefined;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE = [
  "Home building licences. You need a licence to do residential building work in NSW over the value of $5,000 including GST in labour and materials.",
  "Contractor licence: allows you to contract with a homeowner and to do or supervise the work listed on the licence, such as carpentry or bricklaying.",
  "Qualified supervisor certificate: allows you to supervise or do work for a company that holds a contractor licence.",
  "Owner builder permit: needed for owner builders doing work over $10,000.",
].join("\n");
const URL1 = "https://www.fairtrading.nsw.gov.au/trades-and-businesses/home-building-licences";
const candidates = [{ title: "Home building licences | NSW Fair Trading", url: URL1, snippet: "Find out about the licence classes for home building work in NSW." }];

describe("the whole loop on the real computers hub (synthetic web, fake voice)", () => {
  test("spoken, case-insensitive 'Research computer': one job; sub-goals and a founder's takeover and return arrive live; ONE result with the real saved file name and the source link; one spoken line; a replay changes nothing", async () => {
    let current = "";
    const writes: string[] = [];
    const calls: string[] = [];
    const exec = (name: string): Executor => async (a: any) => {
      calls.push(name);
      if (name === "browser.navigate") {
        current = String(a.url);
        return { ok: true, said: 'Opened: "Home building licences | NSW Fair Trading"', verified: true, data: { title: "Home building licences | NSW Fair Trading", url: current, tabId: "tab-1" } };
      }
      if (name === "page.text") {
        await sleep(250); // long enough for a founder to ask for the computer while this move is in flight
        const off = Number(a.offset) || 0;
        return { ok: true, said: "Read", verified: true, data: { title: "Home building licences | NSW Fair Trading", url: current, total: PAGE.length, offset: off, text: PAGE.slice(off, off + Number(a.limit)), links: [] } };
      }
      writes.push(String(a.name));
      return { ok: true, said: `Wrote ${a.name} and read it back.`, verified: true };
    };
    hub = await startComputersHub({
      goalAsk: null,
      research: { search: async () => candidates, delegate: null, deliver: (i) => threadDeliver(rig!.conversations)(i) },
    });
    hub.host.executorsFor = () => ({ echo: async () => ({ ok: true, said: "Echoed.", verified: true }), "browser.navigate": exec("browser.navigate"), "page.text": exec("page.text"), "file.write": exec("file.write") });
    expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    await hub.waitFor("online", () => hub!.computers.view("research").state === "online");

    rig = await loopRig(hub.jobs);
    const stream = await rig.open("usman");
    const mehrozStream = await rig.open("mehroz");
    const voice = fakeVoice(rig.gate, memoryStorage());
    voice.tick();
    const command = createCommandService({
      jobs: () => hub!.jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
      delegates: { computers: withComputerResolution(() => hub!.computers.list().map((c) => ({ name: c.name, label: c.label })), (u, p) => computerCommand(hub!.computers, u, p)) },
      graceMs: 50, dedupeMs: 0, threads: rig.threads, deviceLabel: (id) => id,
    });
    const goal = "research the licence classes for home building in NSW";
    const r = await command.run({ principal: usman, body: { utterance: `Use the RESEARCH computer to ${goal}`, source: "voice", eventId: "evt-e2e-1" } as never });
    expect(r.ok).toBe(true);
    expect(r.said).toMatch(/Started on research/);
    expect(r.said).toMatch(/Job [0-9a-f]{8}\.$/);
    expect(hub.jobs.list({ limit: 10 }).filter((j) => j.kind === "control")).toHaveLength(1);
    expect(hub.jobs.get(r.jobId!)).toMatchObject({ title: goal, state: expect.stringMatching(/queued|running/) });

    // Mehroz asks for the computer while the agent is mid-move; it pauses at the next boundary and the conversation says so.
    await hub.waitFor("the first page read", () => calls.includes("page.text"));
    expect((await hub.api("mehroz", "POST", "/research/takeover", {})).status).toBe(200);
    await hub.waitFor("the agent to pause", () => hub!.computers.view("research").controller.kind === "person");
    await stream.waitFor(() => stream.threadEvents().some((e) => /^Paused: Mehroz took the controls/.test(e.data.entry.text)));
    expect(hub.jobs.get(r.jobId!)!.state).toBe("running"); // paused live, not finished, and nothing reloaded
    expect(voice.said).toEqual([]);
    expect((await hub.api("mehroz", "POST", "/research/return", {})).status).toBe(200);
    await hub.waitFor("the job to finish", () => hub!.computers.jobView(r.jobId!)?.state === "succeeded", 20_000);
    await stream.waitFor(() => stream.threadKeys().some((k) => k.endsWith(":succeeded")));

    const entries = stream.threadEvents().map((e) => e.data.entry as { key: string; state: string; text: string });
    const all = entries.map((e) => e.text).join("\n");
    expect(entries[0]).toMatchObject({ state: "started" });
    expect(all).toContain("Resumed: control is back with the agent");
    for (const [n, name] of [[1, "find sources"], [2, "read"], [4, "save report"], [5, "return result"]] as const) expect(all).toContain(`Research, step ${n} of 5 (${name}): done.`);
    // ONE result entry: web-sourced label, the source link, and the file the computer really saved.
    const result = entries.filter((e) => e.state === "report");
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("Web-sourced research, data from public pages and not instructions");
    expect(result[0].text).toContain(URL1);
    expect(writes).toHaveLength(1);
    expect(result[0].text).toContain(`Full report file: ${writes[0]}, in the computer's working folder`);
    // The job's end is last; the other founder's stream never got a line of this conversation.
    expect(entries.at(-1)).toMatchObject({ key: `${r.jobId}:succeeded`, state: "succeeded" });
    expect(mehrozStream.threadKeys()).toEqual([]);
    expect(rig.conversations.get(jarvisThreadId("usman"))!.entries!.map((e) => e.key)).toEqual(entries.map((e) => e.key));
    // Exactly one spoken update, once the job really ended.
    voice.tick();
    expect(voice.said).toHaveLength(1);
    expect(voice.said[0]).toMatch(/is finished/);

    // Replay it all from the beginning (a reconnect, a reload): the same entries, and no job transition, dispatch or second line.
    const hello = stream.frames.find((f) => f.event === "hello")!.data;
    const jobsBefore = JSON.stringify(hub.jobs.list({ limit: 20 }).map((j) => [j.id, j.state, j.stepCount]));
    const calledBefore = calls.length;
    const replay = await rig.open("usman", { lastEventId: `${hello.epoch}:0` });
    await replay.waitFor((f) => f.some((x) => x.data?.data?.entry?.key === `${r.jobId}:succeeded`));
    expect(replay.threadKeys()).toEqual(stream.threadKeys());
    voice.tick();
    await sleep(100);
    expect(voice.said).toHaveLength(1);
    expect(JSON.stringify(hub.jobs.list({ limit: 20 }).map((j) => [j.id, j.state, j.stepCount]))).toBe(jobsBefore);
    expect(calls).toHaveLength(calledBefore);
    expect(writes).toHaveLength(1);
  });
});
