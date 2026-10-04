// Reconciliation recommendation 2 (R7): "what needs me?" by voice includes the coding drafts and decisions waiting on the person, read from the
// coding store with the coding page's own "needs you" set. The Home page's number is unchanged (it counts approvals, emails and agent runs);
// coding is said as its own sentence so Jarvis never contradicts the page and never hides waiting coding work.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CodingJob, GitSha, IsoTime, RepoId, TaskSpec, Uuid } from "../coding/contracts";
import { CodingStore } from "../coding/store";
import { cleanup, tempRoot } from "../coding/test-fixtures";
import { needsYouFrom } from "./needs-you";
import { codingWaiting, needsYouSaid, type NeedsYouSources } from "./needs-you-voice";

const roots: string[] = [];
const stores: CodingStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) cleanup(r);
});
const person = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "s" } as never;
const spec = (objective: string): TaskSpec => ({
  schema: "coding.taskspec", version: 1, id: randomUUID() as Uuid, revision: 1, createdAt: new Date().toISOString() as IsoTime, requestedBy: person,
  source: { channel: "typed", utteranceDigest: "0".repeat(64) as never },
  repo: { repoId: "fixture" as RepoId, baseRef: "main", baseSha: "a".repeat(40) as GitSha, jobBranch: "coding/x-abcdef", excludesUncommittedCanonicalChanges: true },
  objective, nonGoals: [], doneWhen: [], roleTemplate: "build-only", roles: [], checks: [], baselineChecks: [], approvalPoints: [],
  allowDependencyChange: false, dataClass: "synthetic", jobLimits: { maxWallMinutes: 60, maxConcurrentAgents: 2 }, jev: null, planner: null,
  confirmation: { state: "unconfirmed" },
});
const store = () => {
  const r = tempRoot("needs-voice-");
  roots.push(r);
  const s = CodingStore.open(join(r, "coding"), {});
  stores.push(s);
  return s;
};
const job = (s: CodingStore, objective: string, path: string[] = []): CodingJob => {
  const j = s.createJob({ id: randomUUID() as Uuid, spec: spec(objective), state: "draft", headSha: null, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc" as never });
  for (const to of path) s.transitionJob(j.id, to as never);
  return j;
};

const ok = <T,>(data: T) => ({ ok: true as const, data, updatedAt: "2026-10-03T02:00:00Z", ms: 5 });
const today = (approvals: Array<{ id: string; title: string }>) => ok({ now: "x", callingWindow: {} as never, approvals: approvals as never, approvalsErrors: [], derivedError: null });
const email = ok({ connected: true, needsReplyCount: 0 } as never);
const sources = (approvals: Array<{ id: string; title: string }>, coding?: NeedsYouSources["coding"]): NeedsYouSources => {
  const t = today(approvals);
  return { needsYou: ok(needsYouFrom({ today: t as never, email: email as never, agent: { ok: true, count: 0, at: null } })), today: t as never, ...(coding !== undefined ? { coding } : {}) };
};

describe("the coding store's waiting jobs", () => {
  test("a draft, a plan waiting for Start and a job needing its owner are waiting; a job that is building, or finished, is not; one row each", () => {
    const s = store();
    job(s, "draft the dental page");
    job(s, "add the booking form", ["awaiting_confirmation"]);
    job(s, "fix the footer", ["awaiting_confirmation", "preparing", "building", "needs_owner"]);
    job(s, "keep going quietly", ["awaiting_confirmation", "preparing", "building"]);
    const waiting = codingWaiting(s);
    expect(waiting.map((w) => w.title).sort()).toEqual(["add the booking form", "draft the dental page", "fix the footer"]);
    expect(new Set(waiting.map((w) => w.id)).size).toBe(3);
    expect(waiting.find((w) => w.title === "fix the footer")!.state).toBe("needs_owner");
  });
});

describe("what needs me, said aloud", () => {
  test("coding drafts and decisions are named, with where to go; the page's own count and breakdown are unchanged", () => {
    const withCoding = needsYouSaid(sources([{ id: "a1", title: "Approve the invoice" }], [
      { id: "j1", state: "draft", title: "x" }, { id: "j2", state: "awaiting_confirmation", title: "y" }, { id: "j3", state: "needs_owner", title: "z" },
    ]));
    const without = needsYouSaid(sources([{ id: "a1", title: "Approve the invoice" }]));
    expect(withCoding.startsWith(without)).toBe(true);
    expect(withCoding).toContain("2 coding drafts waiting for your review and Start, and 1 coding decision waiting in Coding.");
    expect(withCoding).toContain("Open Coding to review; nothing starts on its own.");
  });

  test("a coding store that can't be read is said, never counted as zero; a caller with no coding source says nothing about it", () => {
    expect(needsYouSaid(sources([], null))).toContain("Coding decisions couldn't be read.");
    expect(needsYouSaid(sources([]))).not.toMatch(/coding/i);
  });

  test("nothing else waiting but coding work: it does not say 'Nothing needs you' and then list something", () => {
    const said = needsYouSaid(sources([], [{ id: "j1", state: "draft", title: "x" }]));
    expect(said).not.toContain("Nothing needs you");
    expect(said).toContain("No decisions or emails need you right now.");
    expect(said).toContain("1 coding draft waiting for your review and Start.");
  });

  test("with nothing waiting anywhere it still says so", () => {
    expect(needsYouSaid(sources([], []))).toBe("Nothing needs you right now.");
  });
});
