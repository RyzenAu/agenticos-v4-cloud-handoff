// W-B (29 Sep 2026): Work passes the five-second test (what waits on you, the next step, what needs
// attention) from the same panel reads, and folds detail without removing anything true.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workSummary } from "../src/lib/work-summary";

const ROOT = join(import.meta.dir, "..");
const at = "2026-09-29T00:00:00.000Z";
const okr = <T,>(data: T) => ({ ok: true as const, data, updatedAt: at }) as never;
const fail = { ok: false, error: "source down", updatedAt: at } as never;
const approval = (id: string) => ({ id, title: `Decision ${id}`, area: "sales", detail: "d", href: "/leads", since: null, source: "s" });
const pipeline = (patch = {}) => ({ stages: [], total: 8, open: 7, excluded: 0, merged: 0, lost: 0, closed: 1, demosBooked: 1, upcomingMeetings: [], followUps: { overdue: 0, dueToday: 1 }, proposals: { count: 1, valueCents: 150_000 }, newLeads7d: 7, stuck: 0, hunt: null, ...patch });
const site = (tone: "ok" | "warn" | "bad") => ({ id: tone, name: tone, url: "https://x.example", tone, status: tone === "bad" ? null : 200, ms: 50 });

describe("Work's answer card", () => {
  test("decisions waiting → says how many and points at them", () => {
    const v = workSummary({ today: okr({ approvals: [approval("a"), approval("b")], approvalsErrors: ["bad entry"] }), calls: okr({ total: 1, items: [] }), pipeline: okr(pipeline()), sites: okr({ sites: [site("ok"), site("ok")], local: [], localNotRunning: [], checkedAt: at }), loading: false });
    expect(v).toMatchObject({ tone: "warn", title: "2 decisions wait on you", next: "approvals", approvals: 2 });
    expect(v.why).toContain("1 entry in the approvals file need fixing");
    expect(v.facts[0]).toBe("1 call due today or overdue");
    expect(v.facts[2]).toBe("All 2 sites answering");
    expect(v.facts[1]).toMatch(/^7 open leads · 1 proposal out \(A\$1,500/);
  });
  test("nothing waiting → calm, and the call queue is the next step when calls are due", () => {
    const v = workSummary({ today: okr({ approvals: [], approvalsErrors: [] }), calls: okr({ total: 3, items: [] }), pipeline: okr(pipeline()), sites: okr({ sites: [site("ok")], local: [], localNotRunning: [], checkedAt: at }), loading: false });
    expect(v).toMatchObject({ tone: "ok", title: "Nothing waits on you", next: "calls" });
  });
  test("a site down with no decisions is the attention item", () => {
    const v = workSummary({ today: okr({ approvals: [], approvalsErrors: [] }), calls: okr({ total: 0, items: [] }), pipeline: okr(pipeline()), sites: okr({ sites: [site("ok"), site("bad")], local: [], localNotRunning: [], checkedAt: at }), loading: false });
    expect(v).toMatchObject({ tone: "warn", title: "1 site down" });
    expect(v.facts[2]).toBe("1 of 2 sites down");
  });
  test("unread sources say so: never a zero, never 'nothing waits'", () => {
    const v = workSummary({ today: fail, calls: undefined, pipeline: fail, sites: undefined, loading: false });
    expect(v).toMatchObject({ tone: "neutral", title: "Couldn't read your approvals", approvals: null });
    expect(v.facts).toEqual(["Call queue not read", "Pipeline not read", "Sites not checked"]);
    expect(workSummary({ today: undefined, calls: undefined, pipeline: undefined, sites: undefined, loading: true }).title).toBe("Reading what waits on you…");
  });
});

describe("Work keeps its structure and folds detail", () => {
  const page = readFileSync(join(ROOT, "src/components/shell/pages/work-page.tsx"), "utf8");
  const panels = readFileSync(join(ROOT, "src/components/workspace/other-panels.tsx"), "utf8");
  const today = readFileSync(join(ROOT, "src/components/workspace/today-panel.tsx"), "utf8");
  test("answer first, then approvals, calls, pipeline, sites, drilldowns", () => {
    const order = ["<WorkAnswer", "<TodayPanel", "<CallQueuePanel", "<PipelinePanel", "<WebsitesPanel", "<DrilldownList"].map((s) => page.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  test("approvals: three at a time, skipped entries behind a disclosure (still listed in full)", () => {
    expect(today).toContain("const FIRST = 3;");
    expect(today).toContain("Some approvals were skipped ({data.approvalsErrors.length})");
    expect(today).toContain("data.approvalsErrors.map((e) => <li key={e}>{fmtProse(e)}</li>)");
  });
  test("sites needing a look stay visible; healthy ones fold; empty stages are named, not drawn", () => {
    expect(panels).toContain('aria-label="Sites that need a look"');
    expect(panels).toContain("answering normally</span>}");
    expect(panels).toContain("No leads in: {empty.map((s) => cap(s.stage)).join(\", \")}");
  });
});
