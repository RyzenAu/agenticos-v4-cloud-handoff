// Round 7 C follow-ups: (1) a shared bot's saved result opens for BOTH founders while a personal one stays its owner's; (2) the same person in a second window:
// the viewer says which window holds the controls, and "Take them here" moves them (explicit, recorded, a new epoch).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { PAGE_TOKEN } from "../devices/test-harness";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(30_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const JOB_BOT = "11111111-2222-4333-8444-aaaaaaaaaaaa";
const PRINCIPAL = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" } as never;

async function artifactsHub() {
  hub = await startComputersHub({ artifacts: true });
  const bot = hub.jobs.create({ kind: "control", principal: PRINCIPAL, targetDeviceId: "computer-x", title: "Research for the bot", bot: "research" });
  const own = hub.jobs.create({ kind: "control", principal: PRINCIPAL, targetDeviceId: "computer-x", title: "Usman's own task" });
  for (const [id, title] of [[bot.id, "Bot result"], [own.id, "Personal result"]] as const) {
    const r = hub.artifacts!.save({ jobId: id, personId: "usman", kind: "research", title, summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: `# ${title}\n\nbody` }] });
    expect(r.ok).toBe(true);
  }
  return { h: hub, botId: bot.id, ownId: own.id };
}
const get = (h: ComputersHub, who: "usman" | "mehroz", path: string, strip = false) => {
  const headers = h.headers(who, false);
  if (strip) delete (headers as Record<string, string>).cookie; // an unpaired browser: no session cookie
  return fetch(`${h.base}/__computers${path}`, { headers });
};

describe("a shared bot's saved result opens for both founders; a personal one stays its owner's", () => {
  test("Mehroz opens Research's result (page, file, download) and sees it listed; the owner still does", async () => {
    const { h, botId } = await artifactsHub();
    const page = await get(h, "mehroz", `/artifacts/${botId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Bot result");
    expect((await get(h, "mehroz", `/artifacts/${botId}/f/report.md`)).status).toBe(200);
    const dl = await get(h, "mehroz", `/artifacts/${botId}/f/report.md?download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="report\.md"/);
    expect((await get(h, "usman", `/artifacts/${botId}`)).status).toBe(200);
    const list = await h.api("mehroz", "GET", "/artifacts");
    expect(list.json.artifacts.map((a: { title: string }) => a.title)).toEqual(["Bot result"]);
  });

  test("Mehroz is refused Usman's personal artifact in every form, and the path checks still apply", async () => {
    const { h, ownId, botId } = await artifactsHub();
    for (const p of [`/artifacts/${ownId}`, `/artifacts/${ownId}/f/report.md`, `/artifacts/${ownId}/f/report.md?download=1`]) expect((await get(h, "mehroz", p)).status).toBe(404);
    expect((await get(h, "mehroz", `/artifacts/${botId}/f/..%2Fmeta.json`)).status).toBe(404);
    expect((await get(h, "mehroz", `/artifacts/${botId}/f/nope.md`)).status).toBe(404);
    expect((await get(h, "usman", `/artifacts/${ownId}`)).status).toBe(200);
    expect((await h.api("mehroz", "GET", "/artifacts")).json.artifacts.some((a: { title: string }) => a.title === "Personal result")).toBe(false);
  });

  test("an unpaired browser (no session) is refused, even for a shared bot's result", async () => {
    const { h, botId } = await artifactsHub();
    const r = await get(h, "mehroz", `/artifacts/${botId}`, true);
    expect([401, 403, 404]).toContain(r.status); // a bare Tailscale login is not a paired person: the result is not found for them
    expect(await r.text()).not.toContain("Bot result");
  });
});

// ------------------------------------------------------------------------------------------------------------- a second window of the same person
const executors = (): Record<string, Executor> => ({ echo: async () => ({ ok: true, said: "Echoed.", verified: true }), "file.write": async () => ({ ok: true, said: "Wrote.", verified: true }) });

async function twoWindows() {
  hub = await startComputersHub();
  hub.host.executorsFor = executors;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  const cookie = encodeURIComponent(hub.devices.store.mintSession("usman", "Usman's second window", "hub").cookie);
  const second = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${hub!.base}/__computers${path}`, { method, headers: { host: `127.0.0.1:${hub!.port}`, cookie: `mu_session=${cookie}`, ...(method !== "GET" ? { "x-claude-os-token": PAGE_TOKEN, "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return { h: hub, second };
}

describe("the same person in a second window", () => {
  test("viewer-state says which window holds the controls; the other is view-only", async () => {
    const { h, second } = await twoWindows();
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    const first = (await h.api("usman", "GET", "/research/viewer-state")).json;
    expect(first).toMatchObject({ canControl: true, heldByThisSession: true, heldByYouElsewhere: false });
    const other = (await second("GET", "/research/viewer-state")).json;
    expect(other).toMatchObject({ canControl: false, heldByThisSession: false, heldByYouElsewhere: true, me: "usman" });
    // the list a window reads says the same, per window
    expect((await h.api("usman", "GET", "/")).json.computers[0]).toMatchObject({ heldByThisSession: true, heldByYouElsewhere: false });
    expect((await second("GET", "/")).json.computers[0]).toMatchObject({ heldByThisSession: false, heldByYouElsewhere: true });
    // and the second window's input is refused
    expect((await second("POST", "/research/input", { executor: "file.write", args: { name: "x.txt", text: "x" } })).status).toBe(409);
    // the other founder sees neither flag as theirs
    expect((await h.api("mehroz", "GET", "/research/viewer-state")).json).toMatchObject({ heldByThisSession: false, heldByYouElsewhere: false });
  });

  test("'Take them here' moves the controls to this window: recorded, a new epoch, the old window stops at once", async () => {
    const { h, second } = await twoWindows();
    await h.api("usman", "POST", "/research/takeover", {});
    const epoch = h.computers.view("research").controller.epoch!;
    const moved = await second("POST", "/research/take-here", {});
    expect(moved.status).toBe(200);
    expect(moved.json.state).toBe("held");
    expect(h.computers.view("research").controller.epoch!).toBeGreaterThan(epoch);
    expect(h.computers.events().some((e) => e.type === "controls-moved")).toBe(true);
    expect((await second("GET", "/research/viewer-state")).json).toMatchObject({ heldByThisSession: true, heldByYouElsewhere: false });
    expect((await h.api("usman", "GET", "/research/viewer-state")).json).toMatchObject({ heldByThisSession: false, heldByYouElsewhere: true });
    // the old window's late input and heartbeat are refused; the new one's input works
    expect((await h.api("usman", "POST", "/research/input", { executor: "file.write", args: { name: "old.txt", text: "x" } })).status).toBe(409);
    expect((await h.api("usman", "POST", "/research/lease/renew", {})).json.ok).toBe(false);
    expect((await second("POST", "/research/input", { executor: "file.write", args: { name: "new.txt", text: "x" } })).status).toBe(200);
  });

  test("it is only ever the person's OWN controls: the other founder, a free computer, an agent's computer and a program are refused", async () => {
    const { h, second } = await twoWindows();
    // free computer: nothing to move
    expect((await second("POST", "/research/take-here", {})).status).toBe(409);
    await h.api("usman", "POST", "/research/takeover", {});
    expect((await h.api("mehroz", "POST", "/research/take-here", {})).status).toBe(409); // Usman's controls are not Mehroz's to move
    expect((await h.api("program", "POST", "/research/take-here", {})).status).toBe(403);
    expect(h.computers.view("research").controller.who).toBe("usman");
    await h.api("usman", "POST", "/research/return", {});
    // an agent holds it: that is what Take over (which pauses it at a safe step) is for
    const job = await h.api("usman", "POST", "/research/jobs", { agent: "t", title: "busy", steps: [{ executor: "echo", args: {} }, { executor: "file.write", args: { name: "a", text: "b" } }] });
    expect(job.status).toBe(200);
    const refused = await second("POST", "/research/take-here", {});
    expect([409]).toContain(refused.status);
  });
});
