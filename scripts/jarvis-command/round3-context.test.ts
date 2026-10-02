// Round 3, item 1: typed and spoken commands go through the SAME client function to the SAME server route and make the
// SAME kind of job record, and the page he is looking at (lead, finance figure, job) is passed and used.
// Real client (src/lib/jarvis-command.ts, src/lib/page-context.ts), real command service and job store, synthetic device
// (scripts/devices/synthetic.ts). No network, no model, no real device.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { COMMAND_PATH, runJarvisCommand, runTypedCommand, commandPageContext, voiceRouteFor } from "../../src/lib/jarvis-command";
import { publishPageContext, resetPageContext, setActivePage, setContextJob } from "../../src/lib/page-context";
import type { CommandBody } from "./contracts";
import type { JobService } from "../jobs/service";
import { rig as rigWith, SYNTHETIC_MEHROZ_PC_ID, type Lead } from "./r3-rig";

const cleanups: Array<() => Promise<void> | void> = [];
// Server-side rigs: run without any global DOM another test file may have left installed (seen in the full suite).
const g = globalThis as { window?: unknown };
let savedWindow: unknown;
beforeEach(() => {
  savedWindow = g.window;
  delete g.window;
});
afterEach(() => {
  if (savedWindow !== undefined) g.window = savedWindow;
});
afterEach(async () => {
  resetPageContext();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const rig = (leads: Record<string, Lead> = {}) => rigWith(leads, cleanups);

const publishLead = (id = "7", name = "Harbour Dental", facts?: Record<string, string>) => {
  setActivePage({ path: "/leads", destination: "work", title: "Leads" });
  publishPageContext("leads:drawer", { selection: { kind: "lead", id, label: name, to: "/leads", search: { lead: id }, ...(facts ? { facts } : {}) } });
};
const jobSummary = (jobs: JobService) => jobs.list().map((s) => jobs.get(s.id)!).map((j) => ({ kind: j.kind === "voice" ? "command" : j.kind, state: j.state, target: j.targetDeviceId, steps: j.steps.map((s) => `${s.executor}:${s.action ?? ""}:${s.outcome}`) }));

describe("typed and spoken: one client function, one route, one kind of job", () => {
  test("the same words and page context, typed in one rig and spoken in another, post the same body to the same path and leave the same job", async () => {
    const page = () => publishLead("7", "Harbour Dental");
    const typedRig = rig({ "7": { name: "Harbour Dental", website: "https://harbour.example.com.au/" } });
    page();
    const typed = await runTypedCommand("open this lead's website", { post: typedRig.post });
    resetPageContext();
    const spokenRig = rig({ "7": { name: "Harbour Dental", website: "https://harbour.example.com.au/" } });
    page();
    const spoken = await runJarvisCommand({ utterance: "open this lead's website", source: "voice", post: spokenRig.post });

    expect(typedRig.wire.map((w) => w.path)).toEqual([COMMAND_PATH]);
    expect(spokenRig.wire.map((w) => w.path)).toEqual([COMMAND_PATH]);
    const strip = (b: CommandBody) => ({ ...b, source: undefined, eventId: undefined, pageContext: { ...(b.pageContext as object), at: undefined } });
    expect(strip(spokenRig.wire[0].body)).toEqual(strip(typedRig.wire[0].body));
    expect(typedRig.wire[0].body.source).toBe("typed");
    expect(spokenRig.wire[0].body.source).toBe("voice");
    expect(typed).toMatchObject({ ok: true, kind: "remote", verified: true, targetDeviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(spoken).toMatchObject({ ok: spoken.ok, kind: typed.kind, targetDeviceId: typed.targetDeviceId });
    expect(spoken.said).toBe(typed.said);
    expect(jobSummary(spokenRig.jobs)).toEqual(jobSummary(typedRig.jobs));
    expect(jobSummary(typedRig.jobs)).toHaveLength(1);
    expect([typedRig.jobs.list()[0].kind, spokenRig.jobs.list()[0].kind]).toEqual(["command", "voice"]); // the job records which surface it came from, and nothing else differs
  });

  test("a typed echo of a spoken command is the same job, dispatched once", async () => {
    const r = rig({ "7": { name: "Harbour Dental", website: "https://harbour.example.com.au/" } });
    publishLead();
    const spoken = await runJarvisCommand({ utterance: "open this lead's website", source: "voice", post: r.post });
    const echo = await runTypedCommand("open this lead's website", { post: r.post });
    expect(echo.jobId).toBe(spoken.jobId);
    expect(r.ran.filter((c) => c.executor === "browser.navigate")).toHaveLength(1);
  });
});

describe("open this lead's website", () => {
  test("the address comes from the CRM by the page's lead id, is opened on his own device, and the outcome is read back", async () => {
    const r = rig({ "7": { name: "Harbour Dental", website: "harbourdental.example.com.au" } });
    // The page tries to name a different address; it is ignored: only the lead id is taken from the page.
    publishLead("7", "Harbour Dental", { website: "https://evil.example.net/" });
    const done = await runJarvisCommand({ utterance: "open this lead's website", source: "voice", post: r.post });
    expect(r.leadLookups).toEqual(["7"]);
    expect(r.ran).toEqual([{ executor: "browser.navigate", args: { url: "https://harbourdental.example.com.au/" }, personId: "mehroz" }]);
    expect(done).toMatchObject({ ok: true, verified: true, targetDeviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(done.said.length).toBeLessThan(120);
  });

  test("a lead with no website on file: said plainly, nothing opened anywhere", async () => {
    const r = rig({ "8": { name: "No Site Plumbing", website: null } });
    publishLead("8", "No Site Plumbing");
    const done = await runTypedCommand("open this lead's website", { post: r.post });
    expect(done).toMatchObject({ ok: false, refused: true, said: "No Site Plumbing has no website on file, so I didn't open anything." });
    expect(r.ran).toEqual([]);
  });

  test("a lead the CRM doesn't have: said, nothing opened", async () => {
    const r = rig({});
    publishLead("404", "Ghost Co");
    expect(await runTypedCommand("open this lead's website", { post: r.post })).toMatchObject({ ok: false, refused: true, said: "I can't find Ghost Co in the CRM, so I didn't open anything." });
    expect(r.ran).toEqual([]);
  });

  test("an address that is not a public web page is never opened", async () => {
    const r = rig({ "9": { name: "Local Co", website: "http://192.168.1.5/admin" }, "10": { name: "Script Co", website: "javascript:alert(1)" } });
    for (const [id, name] of [["9", "Local Co"], ["10", "Script Co"]]) {
      resetPageContext();
      publishLead(id, name);
      expect(await runTypedCommand("open this lead's website", { post: r.post })).toMatchObject({ ok: false, refused: true });
    }
    expect(r.ran).toEqual([]);
  });

  test("no lead on the page: Jarvis asks, nothing is guessed or opened", async () => {
    const r = rig();
    setActivePage({ path: "/leads", destination: "work", title: "Leads" });
    const done = await runJarvisCommand({ utterance: "open this lead's website", source: "voice", post: r.post });
    expect(done).toMatchObject({ ok: false, ask: true });
    expect(r.ran).toEqual([]);
  });

  test("the voice client's local resolver does not steal it: it still goes to the server with the page", () => {
    publishLead("7", "Harbour Dental");
    const route = voiceRouteFor("open this lead's website", JSON.parse(JSON.stringify(commandPageContext())));
    expect(route.route).toBe("server");
  });
});

describe("explain this margin, from the page's own snapshot", () => {
  test("typed and spoken get the same figures, source and caveat from a snapshot the client built", async () => {
    setActivePage({ path: "/operations", destination: "work", title: "Operations" });
    publishPageContext("operations:economics", {
      selection: { kind: "package", id: "receptionist-professional", label: "Professional package", to: "/operations", facts: { "Contribution margin pct": "71.2" } },
      sources: [{ id: "eco", label: "Economics model", state: "live", source: "business-economics.ts", lastSuccess: null }],
    });
    const r = rig();
    const typed = await runTypedCommand("explain this margin", { post: r.post });
    const spoken = await runJarvisCommand({ utterance: "explain this margin", source: "voice", post: r.post });
    expect(typed.ok).toBe(true);
    expect(typed.said).toContain("Professional package");
    expect(spoken.said).toBe(typed.said);
    expect(r.ran).toEqual([]);
  });
});

describe("continue that job, on a job page", () => {
  const onJobPage = (id: string) => {
    setActivePage({ path: "/jobs", destination: "work", title: "Jobs" });
    setContextJob({ id, title: "Open PowerPoint", state: "running" });
  };
  test("a finished job is reported, never re-run: nothing is dispatched", async () => {
    const r = rig();
    const first = await runTypedCommand("open PowerPoint here", { post: r.post });
    expect(first.ok).toBe(true);
    const before = r.ran.length;
    onJobPage(first.jobId!);
    const done = await runJarvisCommand({ utterance: "continue that job", source: "voice", post: r.post });
    expect(done).toMatchObject({ ok: true, kind: "answer" });
    expect(done.said).toMatch(/already finished/);
    expect(r.ran.length).toBe(before);
  });

  test("an interrupted or unknown job says how it ended and asks for the next goal; nothing re-runs", async () => {
    const r = rig();
    const first = await runTypedCommand("open PowerPoint here", { post: r.post });
    const job = r.jobs.get(first.jobId!)!;
    expect(job.state).toBe("succeeded");
    const pretend = r.jobs.create({ kind: "command", principal: { personId: "mehroz", via: "tailnet-person", actor: "human" }, targetDeviceId: SYNTHETIC_MEHROZ_PC_ID, title: "Searched YouTube" });
    await r.jobs.run(pretend.id, async () => ({ ok: false, settle: "unknown", note: "The PC went offline while it ran" }));
    expect(r.jobs.get(pretend.id)!.state).toBe("unknown");
    onJobPage(pretend.id);
    const before = r.ran.length;
    const done = await runTypedCommand("continue that job", { post: r.post });
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/unknown outcome/);
    expect(done.said).toMatch(/won't run it again blindly/);
    expect(r.ran.length).toBe(before);
  });

  test("a job that is not in the log: asks which one", async () => {
    const r = rig();
    onJobPage("nope");
    expect(await runTypedCommand("continue that job", { post: r.post })).toMatchObject({ ok: false, ask: true });
  });
});
