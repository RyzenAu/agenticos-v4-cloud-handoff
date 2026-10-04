// R12 Departments: the pure mapping, status language, hand-off inference, journey parsing and the Jarvis thread grouping. Synthetic only.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { BOT_DEPARTMENT, departmentOfBot, inferHandoffs, journeyHandoffs, journeyNow, parseJourney, workStatus, type DeptTask } from "./departments";
import { deptTaskFrom, deptResultFrom } from "../components/departments/use-departments";
import { queueOrder, openSummary } from "../components/departments/department-page";
import { groupThread, handedFrom, jobCardState, type JobFacts } from "../components/shell/pages/jarvis-work";

const task = (over: Partial<DeptTask>): DeptTask => ({ id: "t", title: "Task", state: "working", stateWord: "Working", botId: "research", department: "research", startedAt: 1000, endedAt: null, subjects: [], kind: "computer", progress: null, blocker: null, result: null, jobHref: "/activity#job-t", ...over });

describe("departments: which department a bot works in", () => {
  test("the typed table decides first: Research -> Research, Builder -> Engineering", () => {
    expect(BOT_DEPARTMENT.research).toBe("research");
    expect(departmentOfBot({ id: "builder", name: "Builder" })).toEqual({ id: "engineering", by: "table" });
  });
  test("an unlisted bot is placed by its id or name, else Operations", () => {
    expect(departmentOfBot({ id: "lead-caller", name: "Lead caller" })).toEqual({ id: "sales", by: "name" });
    expect(departmentOfBot({ id: "bookkeeper", name: "Bookkeeper" })).toEqual({ id: "finance", by: "name" });
    expect(departmentOfBot({ id: "helper", name: "Helper" })).toEqual({ id: "operations", by: "default" });
  });
});

describe("status language", () => {
  test("running, waiting/blocked, failed and completed are four different looks", () => {
    const looks = (["working", "needs-you", "failed", "finished"] as const).map((s) => workStatus(s).state);
    expect(new Set(looks).size).toBe(4);
    expect(workStatus("queued")).toEqual({ state: "pending", label: "Queued" });
    expect(workStatus("interrupted").state).toBe("unknown");
  });
});

describe("hand-offs inferred from jobs", () => {
  test("a later task in another department about the same CRM record, after the first finished, is a hand-off", () => {
    const research = task({ id: "r", department: "research", botId: "research", state: "finished", startedAt: 100, endedAt: 200, subjects: ["crm:company:a"] });
    const design = task({ id: "d", department: "design", botId: "designer", startedAt: 300, subjects: ["crm:company:a"], title: "Homepage concept for Synthetic Dental" });
    const [h] = inferHandoffs([research, design]);
    expect(h).toMatchObject({ from: { department: "research" }, to: { department: "design" }, label: "homepage concept for Synthetic Dental", basis: "inferred", taskId: "d" });
  });
  test("no hand-off when the earlier work hadn't finished, shares no record, or is the same department", () => {
    const running = task({ id: "r", department: "research", state: "working", startedAt: 100, subjects: ["crm:company:a"] });
    const other = task({ id: "x", department: "research", state: "finished", startedAt: 100, endedAt: 150, subjects: ["crm:company:a"] });
    const design = task({ id: "d", department: "design", startedAt: 300, subjects: ["crm:company:b"] });
    expect(inferHandoffs([running, design])).toEqual([]);
    expect(inferHandoffs([other, task({ id: "y", department: "research", startedAt: 300, subjects: ["crm:company:a"] })])).toEqual([]);
  });
});

describe("journeys (GET /__journeys, planned)", () => {
  const raw = {
    id: "j1", kind: "lead-to-proposal", title: "Lead to proposal: Synthetic Dental", state: "running", subjects: ["crm:company:a"], createdAt: 10, updatedAt: 20,
    steps: [
      { id: "research", index: 0, title: "Research the business", owner: { department: "research", agent: "research" }, state: "completed", jobId: "job-1", completion: { at: 15, jobId: "job-1", summary: "Done", outputs: [{ label: "Report", href: "/__computers/artifacts/job-1" }, { label: "bad", href: "https://evil.example" }] } },
      { id: "concept", index: 1, title: "Make a homepage concept", owner: { department: "design", agent: "designer" }, state: "running", jobId: "job-2" },
      { id: "broken", index: 2, title: "No owner", state: "queued" },
    ],
  };
  test("a usable journey parses; a step without an owner is dropped; only in-app output links are kept", () => {
    const j = parseJourney(raw)!;
    expect(j.steps.map((s) => s.id)).toEqual(["research", "concept"]);
    expect(j.steps[0].completion?.outputs).toEqual([{ label: "Report", href: "/__computers/artifacts/job-1" }]);
    expect(parseJourney({ ...raw, state: "nonsense" })).toBeNull();
  });
  test("each step is a hand-off from the step before it (the first from Jarvis), and 'now' is the moving step", () => {
    const j = parseJourney(raw)!;
    expect(journeyHandoffs(j).map((h) => `${h.from.department}>${h.to.department}:${h.state}`)).toEqual(["jarvis>research:finished", "research>design:working"]);
    expect(journeyNow(j).line).toBe("Step 2 of 2: Make a homepage concept");
  });
});

describe("service rows", () => {
  test("a task row keeps its CRM subjects and times; a finished row without a result is never 'Completed'", () => {
    const t = deptTaskFrom({ id: "a", title: "Research: X", state: "succeeded", phase: "done", startedAt: 5, endedAt: 9, subjects: ["crm:deal:d"] }, "research", "research")!;
    expect(t.subjects).toEqual(["crm:deal:d"]);
    expect(t.state).toBe("unknown");
    const done = deptTaskFrom({ id: "b", title: "Research: Y", state: "succeeded", startedAt: 5, endedAt: 9, resultArtifact: "artifact:b" }, "research", "research")!;
    expect(done.state).toBe("finished");
  });
  test("a saved result opens on the artifacts route by its bare job id", () => {
    expect(deptResultFrom({ artifact: "artifact:abc", jobId: "abc", title: "Report", createdAt: 7 }, "research", "research")?.href).toBe("/__computers/artifacts/abc");
  });
  test("the queue shows needs-you, running, queued, then recent ended work; the summary counts what is open", () => {
    const q = queueOrder([task({ id: "e", state: "finished", endedAt: 50 }), task({ id: "q", state: "queued" }), task({ id: "n", state: "needs-you" }), task({ id: "w", state: "working" })]);
    expect(q.map((t) => t.id)).toEqual(["n", "w", "q", "e"]);
    expect(openSummary(q)).toBe("1 needs you · 1 running · 1 queued");
  });
});

describe("Jarvis thread: progress and results inline", () => {
  const id1 = "11111111-1111-4111-8111-111111111111";
  const id2 = "22222222-2222-4222-8222-222222222222";
  const msgs = [
    { role: "user", text: "Research the competitors" },
    { role: "oracle", text: `Started: Research (job 11111111).`, via: `job:${id1}:started` },
    { role: "oracle", text: "Step 1 of 2: searched", via: `job:${id1}:step:1` },
    { role: "oracle", text: `Started: concept (job 22222222).`, via: `job:${id2}:started` },
    { role: "oracle", text: `Finished: Research (job 11111111)`, via: `job:${id1}:succeeded` },
  ];
  test("one card per job at its first entry; plain messages stay in place", () => {
    const items = groupThread(msgs);
    expect(items.map((i) => (i.type === "job" ? `job:${i.jobId.slice(0, 1)}:${i.entries.length}` : i.type))).toEqual(["message", "job:1:3", "job:2:1"]);
  });
  test("a journey replaces the cards of the jobs it ran", () => {
    const j = parseJourney({ id: "j", state: "running", steps: [{ id: "s", title: "Research", owner: { department: "research" }, state: "completed", jobId: id1 }] })!;
    expect(groupThread(msgs, [j]).map((i) => i.type)).toEqual(["message", "journey", "job"]);
  });
  test("the card's state comes from the jobs API when it knows, else the newest entry; the step count is the job's own", () => {
    const facts: JobFacts = { id: id1, title: "Research", state: "running", bot: "research", subjects: [], stepCount: 31, createdAt: 1, updatedAt: 2 };
    expect(jobCardState(msgs.slice(1, 3), facts)).toBe("working");
    expect(jobCardState([msgs[1], msgs[4]], null)).toBe("finished");
  });
  test("Research -> Design shows when Design's job is about the same record and started after Research finished", () => {
    const r: JobFacts = { id: id1, title: "Research", state: "succeeded", bot: "research", subjects: ["crm:company:a"], stepCount: 3, createdAt: 1, updatedAt: 5 };
    const d: JobFacts = { id: id2, title: "Concept", state: "running", bot: "designer", subjects: ["crm:company:a"], stepCount: 1, createdAt: 6, updatedAt: 7 };
    const all = new Map([[r.id, r], [d.id, d]]);
    expect(handedFrom(d, all)?.bot).toBe("research");
    expect(handedFrom(r, all)).toBeNull();
  });
});
