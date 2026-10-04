import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { abortableSleep } from "../executors/windows";
import type { ControlAsk } from "./goal-loop";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(40_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

type El = { type: string; name: string; x: number; y: number; w: number; h: number };
type Page = { title: string; url: string; elements: El[] };
const el = (type: string, name: string, x: number, y: number): El => ({ type, name, x, y, w: 200, h: 24 });

/** A tiny browser: a start page whose link leads to a second page; clicking a control at its centre follows it. */
function browserModel(pages: Record<string, Page>, links: Record<string, string>, start: string) {
  const state = { page: start, clicks: [] as [number, number][], typed: [] as string[], keys: [] as string[], observes: 0, dropClicks: false };
  const current = () => pages[state.page];
  const executors: Record<string, Executor> = {
    echo: async () => ({ ok: true, said: "Echoed.", verified: true }),
    wait: async (a, c) => (await abortableSleep(Number(a.ms) || 0, c.signal), { ok: true, said: "Waited.", verified: true }),
    "observe.page": async (a) => {
      state.observes++;
      const p = current();
      return {
        ok: true, said: `Page: "${p.title}"`, verified: true,
        data: { title: p.title, url: p.url, frame: { bytes: 5, sha256: "x" }, ...(a.elements ? { viewport: { w: 1280, h: 800 }, elements: p.elements.map((e) => ({ ...e, password: /password/i.test(e.name), enabled: true, focused: false, hasValue: false })) } : {}) },
      };
    },
    "input.click": async (a, ctx) => {
      state.clicks.push([Number(a.x), Number(a.y)]);
      if (state.dropClicks) await abortableSleep(30_000, ctx.signal);
      const hit = current().elements.find((e) => Number(a.x) >= e.x && Number(a.x) <= e.x + e.w && Number(a.y) >= e.y && Number(a.y) <= e.y + e.h);
      if (hit && links[`${state.page}|${hit.name}`]) state.page = links[`${state.page}|${hit.name}`];
      return { ok: true, said: `Clicked at ${a.x},${a.y} (sent; not checked).`, verified: null };
    },
    "input.type": async (a) => (state.typed.push(String(a.text)), { ok: true, said: "Typed.", verified: null }),
    "input.key": async (a) => (state.keys.push(String(a.key)), { ok: true, said: "Pressed.", verified: null }),
    "input.scroll": async () => ({ ok: true, said: "Scrolled.", verified: null }),
  };
  return { state, executors };
}

const pages: Record<string, Page> = {
  start: { title: "Example Domain", url: "https://example.com/", elements: [el("Hyperlink", "More information...", 100, 100), el("Button", "Place order", 100, 300)] },
  iana: { title: "Example Domains", url: "https://www.iana.org/domains/example", elements: [el("Hyperlink", "Domains", 100, 100)] },
};
const links = { "start|More information...": "iana" };

/** A scripted Jev: clicks the control whose label contains `label` until the page it names is showing, then says done. Records every request. */
function scriptedJev(label: string, doneWhen: string, opts: { delayMs?: number; answer?: (n: number) => "click" | "null" } = {}) {
  const seen: { state: Record<string, string>; questions: Record<string, any> }[] = [];
  const ask: ControlAsk = async (body, signal) => {
    seen.push({ state: body.state as Record<string, string>, questions: body.questions as Record<string, any> });
    if (opts.delayMs) await abortableSleep(opts.delayMs, signal);
    if (signal.aborted) throw new Error("aborted");
    if (opts.answer?.(seen.length) === "null") return null;
    const crit = (body.questions as any).target.criteria as Record<string, string>;
    const key = Object.keys(crit).find((k) => crit[k].toLowerCase().includes(label.toLowerCase())) ?? "none";
    const done = String((body.state as any).window).includes(doneWhen);
    return {
      ms: 120, inputTokens: 100, outputTokens: 8, model: "jev-test",
      answers: done
        ? { action: { choice: "done", confidence: 0.95 }, target: { choice: "none", confidence: 0.9 }, complete: { noul: 0.95 }, key: { choice: "none", confidence: 0.9 } }
        : { action: { choice: "click", confidence: 0.95 }, target: { choice: key, confidence: 0.92 }, complete: { noul: 0.05 }, key: { choice: "none", confidence: 0.9 }, last_ok: { noul: 0.8 } },
    };
  };
  return { ask, seen };
}

async function setup(jev: ReturnType<typeof scriptedJev> | null, browser = browserModel(pages, links, "start")) {
  hub = await startComputersHub({ goalAsk: jev?.ask ?? null });
  hub.host.executorsFor = () => browser.executors;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  return { hub, browser };
}
const goalJob = (goal: string) => ({ agent: "goal-agent", steps: [{ executor: "goal", args: { goal } }] });
const ended = ["succeeded", "failed", "unknown", "cancelled"];

describe("the hub-side goal loop for a cloud computer", () => {
  test("observe, Jev decides on the hub, the computer acts, each move is a verified job step, and it finishes when Jev says done", async () => {
    const jev = scriptedJev("More information", "Example Domains");
    const { hub, browser } = await setup(jev);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the More information link on the page"));
    expect(r.status).toBe(200);
    await hub.waitFor("job done", () => ended.includes(hub.computers.jobView(r.json.jobId)?.state ?? ""));
    const view = hub.computers.jobView(r.json.jobId)!;
    expect(view.state).toBe("succeeded");
    expect(browser.state.clicks).toEqual([[200, 112]]); // the centre of the link Jev chose; once
    expect(browser.state.page).toBe("iana");
    const text = view.steps.map((s) => `${s.outcome}|${s.executor}|${s.intent}`);
    expect(text.some((t) => /Jev: click .*More information/.test(t))).toBe(true);
    expect(text.some((t) => /move click .*Clicked at 200,112/.test(t))).toBe(true);
    expect(text.some((t) => /check: after "click.*" the page reads "Example Domains"/.test(t))).toBe(true);
    expect(text.some((t) => /Jev says the task is complete/.test(t))).toBe(true);
    expect(view.steps.find((s) => /page reads "Example Domains"/.test(s.intent))!.verification).toMatchObject({ method: "page-changed", ok: true });
    expect(jev.seen.length).toBe(2);
    expect(hub.computers.view("research")).toMatchObject({ controller: { kind: null } });
  });

  test("no Jev key on the hub: a goal step is refused up front and nothing runs", async () => {
    const { hub, browser } = await setup(null);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the link"));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no Jev key/);
    expect(browser.state.observes).toBe(0);
  });

  test("Jev unavailable mid-goal: it stops and says so, it does not guess", async () => {
    const jev = scriptedJev("More information", "never", { answer: () => "null" });
    const { hub, browser } = await setup(jev);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the link"));
    await hub.waitFor("job ended", () => hub.computers.jobView(r.json.jobId)?.state === "failed");
    expect(hub.computers.jobView(r.json.jobId)!.note).toMatch(/Jev didn't answer, so I stopped rather than guess/);
    expect(browser.state.clicks).toEqual([]);
  });

  test("a final button is never pressed", async () => {
    const jev = scriptedJev("Place order", "never");
    const { hub, browser } = await setup(jev);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("buy it"));
    await hub.waitFor("job ended", () => hub.computers.jobView(r.json.jobId)?.state === "failed");
    expect(hub.computers.jobView(r.json.jobId)!.note).toMatch(/final action/);
    expect(hub.computers.jobView(r.json.jobId)!.steps.some((s) => s.outcome === "refused")).toBe(true);
    expect(browser.state.clicks).toEqual([]);
  });

  test("bounded: three moves in a row that change nothing stop the goal", async () => {
    const stuckPages: Record<string, Page> = { start: { title: "Stuck", url: "https://example.com/", elements: [el("Button", "Next", 100, 100)] } };
    const jev = scriptedJev("Next", "never");
    const { hub, browser } = await setup(jev, browserModel(stuckPages, {}, "start"));
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("keep pressing next"));
    await hub.waitFor("job ended", () => hub.computers.jobView(r.json.jobId)?.state === "failed");
    expect(hub.computers.jobView(r.json.jobId)!.note).toMatch(/Three moves in a row changed nothing/);
    expect(browser.state.clicks).toHaveLength(3);
  });

  test("Jev never sees what he dictated: typed text becomes a placeholder in every request", async () => {
    const secret = "hunter2-very-secret";
    const seenAll: string[] = [];
    const inner = scriptedJev("More information", "Example Domains");
    const ask: ControlAsk = async (body, signal) => (seenAll.push(JSON.stringify(body)), inner.ask(body, signal));
    hub = await startComputersHub({ goalAsk: ask });
    const browser = browserModel(pages, links, "start");
    hub.host.executorsFor = () => browser.executors;
    await hub.api("usman", "POST", "/", { name: "research" });
    await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob(`open the More information link, then type "${secret}" into the search box`));
    await hub.waitFor("job ended", () => ended.includes(hub!.computers.jobView(r.json.jobId)?.state ?? ""));
    expect(seenAll.length).toBeGreaterThan(0);
    expect(seenAll.join("\n")).not.toContain(secret);
    expect(JSON.stringify(hub.computers.jobView(r.json.jobId))).not.toContain(secret);
  });

  test("cancel stops the loop at once, even while Jev is being asked; no move is made", async () => {
    const jev = scriptedJev("More information", "never", { delayMs: 10_000 });
    const { hub, browser } = await setup(jev);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the link"));
    await hub.waitFor("Jev being asked", () => jev.seen.length === 1);
    expect((await hub.api("mehroz", "POST", `/jobs/${r.json.jobId}/cancel`, {})).status).toBe(200);
    await hub.waitFor("cancelled", () => hub!.jobs.get(r.json.jobId)?.state === "cancelled");
    expect(browser.state.clicks).toEqual([]);
    expect(hub.computers.view("research")).toMatchObject({ state: "online", controller: { kind: null } });
  });

  test("a takeover pauses the loop at a move boundary; return resumes it after a fresh read, and the move already made is not repeated", async () => {
    const jev = scriptedJev("More information", "Example Domains", { delayMs: 300 });
    const { hub, browser } = await setup(jev);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the More information link"));
    await hub.waitFor("Jev being asked", () => jev.seen.length === 1);
    expect((await hub.api("mehroz", "POST", "/research/takeover", {})).json.state).toBe("pending");
    // honoured at the next boundary: after the first move is made and checked, before the next observation
    await hub.waitFor("the loop to pause", () => hub!.computers.view("research").controller.kind === "person");
    expect(browser.state.clicks).toHaveLength(1);
    const before = browser.state.observes;
    await new Promise((res) => setTimeout(res, 400));
    expect(browser.state.observes).toBe(before); // nothing moves while the person holds it
    expect(hub.computers.jobView(r.json.jobId)!.paused).toBe(true);
    expect((await hub.api("mehroz", "POST", "/research/return", {})).json.resumed).toBe(r.json.jobId);
    await hub.waitFor("job done", () => hub!.computers.jobView(r.json.jobId)?.state === "succeeded");
    expect(browser.state.clicks).toHaveLength(1); // the click was not replayed
    const steps = hub.computers.jobView(r.json.jobId)!.steps.map((s) => s.intent);
    expect(steps.some((s) => /paused before the next move/.test(s))).toBe(true);
    expect(steps.some((s) => /refreshed state after the handover/.test(s))).toBe(true);
  });

  test("a move whose computer drops mid-click ends the goal unknown: nothing is retried or replayed", async () => {
    const jev = scriptedJev("More information", "never");
    const browser = browserModel(pages, links, "start");
    browser.state.dropClicks = true;
    const { hub } = await setup(jev, browser);
    const r = await hub.api("usman", "POST", "/research/jobs", goalJob("open the link"));
    await hub.waitFor("the click to start", () => browser.state.clicks.length === 1);
    hub.host.crash("research");
    await hub.computers.tick();
    await hub.waitFor("job unknown", () => hub!.jobs.get(r.json.jobId)?.state === "unknown", 10_000);
    expect(hub.jobs.get(r.json.jobId)!.note).toMatch(/may or may not have happened/);
    expect(browser.state.clicks).toHaveLength(1);
    expect(jev.seen.length).toBe(1); // no further decision after the drop
  });
});
