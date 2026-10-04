import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { abortableSleep } from "../executors/windows";
import { resolveTarget } from "../devices/route";
import type { Principal } from "../identity/principal";
import { createCommandService } from "../jarvis-command/service";
import { computerCommand, parseComputerCommand, planSteps } from "./jarvis";
import type { ControlAsk } from "./goal-loop";
import { pairPersonalPc, startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(40_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const names = ["research", "builder"];

describe("what counts as a computer request", () => {
  test("use / have / on the ..., show, and continue", () => {
    const p = (u: string) => parseComputerCommand(u, names);
    expect(p("use the research computer to find the contact page")).toEqual({ kind: "use", name: "research", goal: "find the contact page" });
    expect(p("Please have the builder bot run the checks")).toEqual({ kind: "use", name: "builder", goal: "run the checks" });
    expect(p("ask the research agent to open example.com")).toEqual({ kind: "use", name: "research", goal: "open example.com" });
    expect(p("go to example.com on the research computer")).toEqual({ kind: "use", name: "research", goal: "go to example.com" });
    expect(p("show me the research bot")).toEqual({ kind: "show", name: "research" });
    expect(p("how is the builder computer doing?")).toEqual({ kind: "show", name: "builder" });
    expect(p("continue that job on its cloud computer")).toEqual({ kind: "continue", name: null });
    expect(p("continue that job on the builder computer")).toEqual({ kind: "continue", name: "builder" });
    expect(p("continue the research job")).toEqual({ kind: "continue", name: "research" });
  });

  test("not a computer request: personal PCs, apps, and unknown names without 'cloud'", () => {
    const p = (u: string) => parseComputerCommand(u, names);
    for (const u of ["use my computer to open notepad", "use the pc to open chrome", "open notepad on my laptop", "use the calculator to add 2 and 2", "show me the leads", "use Usman's computer to print it", "continue my reading"]) expect(p(u)).toBeNull();
    // Round 3: a command verb naming a machine that is not there is refused BY NAME too (it must not fall through to a lane that would act on a different machine).
    expect(p("use the research computer to open example.com")).toEqual({ kind: "use", name: "research", goal: "open example.com" });
    expect(p("open example.com on the research computer")).toEqual({ kind: "use", name: "research", goal: "open example.com" });
    for (const u of ["use the remote machine to open example.com", "use the windows computer to open notepad", "how is the nosuch computer doing", "show me the nosuch computer"]) expect(p(u)).toBeNull();
    // but a phrase that says "cloud" names a shared computer even if it doesn't exist (so it is refused by name, not sent elsewhere)
    expect(p("use the nosuch cloud computer to open example.com")).toEqual({ kind: "use", name: "nosuch", goal: "open example.com" });
  });

  test("plans: one page to open is a typed, verified step; anything else is the hub goal loop (or typed only, without Jev)", () => {
    expect(planSteps("go to example.com and check the title is Example Domain", true)).toEqual([{ executor: "screen.goal", args: { goal: "go to example.com and check the title is Example Domain" } }]);
    expect(planSteps("find the contact page", true)).toEqual([{ executor: "goal", args: { goal: "find the contact page" } }]);
    expect(planSteps("find the contact page", false)[0].executor).toBe("screen.goal");
  });
});

const principalOf = (who: "usman" | "mehroz"): Principal => ({ personId: who, via: "paired-session", actor: "human", sessionId: `sk1.${who}-session-key`, displayName: who }) as Principal;

function executors(ran: string[]): Record<string, Executor> {
  return {
    echo: async () => ({ ok: true, said: "Echoed.", verified: true }),
    wait: async (a, c) => (await abortableSleep(Number(a.ms) || 0, c.signal), { ok: true, said: "Waited.", verified: true }),
    "screen.goal": async (a, c) => (ran.push(`goal:${String(a.goal)}`), await abortableSleep(Number(a.ms) || 150, c.signal), { ok: true, said: "Opened example.com: the page title reads \"Example Domain\".", verified: true }),
    "observe.page": async () => ({ ok: true, said: "Page", verified: true, data: { title: "Example Domain", url: "https://example.com/", viewport: { w: 1280, h: 800 }, elements: [{ type: "Hyperlink", name: "More information...", x: 100, y: 100, w: 200, h: 24, password: false, enabled: true, focused: false, hasValue: false }] } }),
    "input.click": async (a) => (ran.push(`click:${a.x},${a.y}`), { ok: true, said: "Clicked.", verified: null }),
  };
}

async function setup(opts: { goalAsk?: ControlAsk | null } = {}) {
  const ran: string[] = [];
  hub = await startComputersHub({ goalAsk: opts.goalAsk });
  hub.host.executorsFor = () => executors(ran);
  await hub.api("usman", "POST", "/", { name: "research" });
  await hub.api("mehroz", "POST", "/", { name: "builder" });
  await hub.waitFor("both online", () => hub!.computers.list().length === 2 && hub!.computers.list().every((c) => c.state === "online"));
  const service = createCommandService({
    jobs: () => hub!.jobs, entry: () => null, hubDeviceId: "",
    resolveTarget: (ctx) => resolveTarget(ctx, hub!.devices.registry),
    dispatcher: hub.devices.dispatcher,
    delegates: { computers: (u, p) => computerCommand(hub!.computers, u, p) },
  });
  const say = (who: "usman" | "mehroz", utterance: string) => service.run({ principal: principalOf(who), body: { utterance, source: "typed" } as never });
  return { hub, ran, say };
}
const settled = (id: string) => ["succeeded", "failed", "unknown", "cancelled"].includes(hub!.computers.jobView(id)?.state ?? "");

describe("Jarvis to computers, through the one command path", () => {
  test("'use the research computer to ...' starts a computer job for the asking founder, on that computer only", async () => {
    const { hub, ran, say } = await setup();
    const done = await say("usman", "use the research computer to go to example.com and check the title is Example Domain");
    expect(done).toMatchObject({ ok: true, kind: "remote" });
    expect(done.said).toMatch(/Started on research/);
    expect(done.jobId).toBeTruthy();
    await hub.waitFor("job done", () => settled(done.jobId!));
    const job = hub.computers.jobView(done.jobId!)!;
    expect(job).toMatchObject({ state: "succeeded", computer: "research", agent: "jarvis" });
    expect(hub.jobs.get(done.jobId!)!.principal.personId).toBe("usman");
    expect(ran).toEqual(["goal:go to example.com and check the title is Example Domain"]);
    // the command went to research only: builder saw nothing
    expect(hub.devices.dispatcher.recent(20).every((r) => r.deviceId === hub.computers.view("research").id)).toBe(true);
  });

  test("the other founder can use the same computer; each founder's agent inherits that founder", async () => {
    const { hub, say } = await setup();
    const a = await say("mehroz", "have the research bot go to example.com");
    expect(a.ok).toBe(true);
    await hub.waitFor("done", () => settled(a.jobId!));
    expect(hub.jobs.get(a.jobId!)!.principal.personId).toBe("mehroz");
  });

  test("an open-ended goal runs the hub-side goal loop (Jev on the hub); without a Jev key it says so and runs nothing", async () => {
    let asked = 0;
    const ask: ControlAsk = async (body) => {
      asked++;
      const crit = (body.questions as any).target.criteria as Record<string, string>;
      const key = Object.keys(crit).find((k) => crit[k].includes("More information")) ?? "none";
      return { ms: 50, inputTokens: 1, outputTokens: 1, model: "t", answers: asked === 1 ? { action: { choice: "click", confidence: 0.95 }, target: { choice: key, confidence: 0.9 }, complete: { noul: 0.1 }, key: { choice: "none", confidence: 0.9 } } : { action: { choice: "done", confidence: 0.95 }, target: { choice: "none", confidence: 0.9 }, complete: { noul: 0.95 }, key: { choice: "none", confidence: 0.9 } } };
    };
    const first = await setup({ goalAsk: ask });
    const d = await first.say("usman", "use the research computer to find more information about the page");
    expect(d.ok).toBe(true);
    await first.hub.waitFor("done", () => settled(d.jobId!));
    expect(first.hub.computers.jobView(d.jobId!)!.steps.some((s) => s.executor === "goal")).toBe(true);
    expect(first.ran.some((r) => r.startsWith("click:"))).toBe(true);
    await hub!.close();
    const none = await setup({ goalAsk: null });
    const refused = await none.say("usman", "use the research computer to find more information about the page");
    expect(refused.ok).toBe(true); // falls to the typed lane, which refuses an open-ended goal on the computer itself
    await none.hub.waitFor("settled", () => settled(refused.jobId!));
    expect(none.ran).toEqual(["goal:find more information about the page"]); // the computer's rule lane, never a guess from the hub
  });

  test("a computer that doesn't exist is refused by name; nothing runs on any other machine, including the person's own PC", async () => {
    const { hub, say } = await setup();
    const pc = await pairPersonalPc(hub, "usman");
    const r = await say("usman", "use the nosuch cloud computer to open example.com");
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/no shared computer called "nosuch"/);
    expect(r.said).toMatch(/research, builder/);
    expect(pc.ran).toEqual([]);
    expect(hub.devices.dispatcher.recent(10)).toHaveLength(0);
    await pc.worker.stop();
  });

  test("'show me the research bot' reports state, who has it and its job, and opens the Computers page", async () => {
    const { hub, say } = await setup();
    const started = await say("usman", "use the research computer to go to example.com");
    const shown = await say("mehroz", "show me the research bot");
    expect(shown).toMatchObject({ ok: true, kind: "navigate", navigate: { path: "/computers" } });
    expect(shown.said).toMatch(/research computer is in use; agent jarvis is using it/);
    await hub.waitFor("done", () => settled(started.jobId!));
    const idle = await say("mehroz", "show me the research bot");
    expect(idle.said).toMatch(/idle and ready; nobody is using it/);
  });

  test("'continue that job on its cloud computer' attaches to a running job, and never re-runs one that ended", async () => {
    const { hub, say } = await setup();
    hub.host.executorsFor = () => ({ ...executors([]), "screen.goal": async (_a, c) => (await abortableSleep(1_200, c.signal), { ok: true, said: "Done.", verified: true }) });
    // a stop and a start brings up a new companion with the executors above (a display restart would leave the running one alone)
    await hub.api("usman", "POST", "/research/action", { action: "stop", force: true });
    await hub.api("usman", "POST", "/research/action", { action: "start" });
    await hub.waitFor("online again", () => hub!.computers.view("research").state === "online");
    const started = await say("usman", "use the research computer to go to example.com");
    expect(started.ok).toBe(true);
    const attach = await say("usman", "continue that job on its cloud computer");
    expect(attach).toMatchObject({ ok: true, jobId: started.jobId });
    expect(attach.said).toMatch(/still running on research/);
    // the other founder has no job of their own to continue
    const other = await say("mehroz", "continue that job");
    expect(other.ok).toBe(false);
    expect(other.said).toMatch(/haven't started a computer job/);
    await hub.waitFor("done", () => settled(started.jobId!));
    const after = await say("usman", "continue that job");
    expect(after.ok).toBe(false);
    expect(after.said).toMatch(/finished.*won't run it again blindly/);
  });

  test("an interrupted job is reported as unknown, not re-run", async () => {
    const { hub, say } = await setup();
    hub.host.executorsFor = () => ({ ...executors([]), "screen.goal": async (_a, c) => (await abortableSleep(30_000, c.signal), { ok: true, said: "Done.", verified: true }) });
    await hub.api("usman", "POST", "/research/action", { action: "stop", force: true });
    await hub.api("usman", "POST", "/research/action", { action: "start" });
    await hub.waitFor("online again", () => hub!.computers.view("research").state === "online");
    const started = await say("usman", "use the research computer to go to example.com");
    await hub.waitFor("running", () => hub!.computers.view("research").state === "busy");
    await new Promise((r) => setTimeout(r, 300));
    hub.host.crash("research");
    await hub.computers.tick();
    await hub.waitFor("unknown", () => hub!.jobs.get(started.jobId!)?.state === "unknown", 10_000);
    const again = await say("usman", "continue that job");
    expect(again.ok).toBe(false);
    expect(again.said).toMatch(/unknown outcome: one step may or may not have happened.*won't run it again blindly/);
  });
});
