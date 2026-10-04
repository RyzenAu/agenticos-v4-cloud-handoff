import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock, claudeWeeklyPercent, clientBuildDir, DreamBudget, dreamLimits, normaliseDream, parseModelJson, releaseLock, renderReportMarkdown,
  summaryLine, sydneyDate, updateDreamState, usageGate,
} from "./core";
import { buildBundle, clientHubs, jarvisDigest, scrub, summariseBunTest, summariseTsc } from "./inputs";
import { windowsRegisterScript, windowsWrapperLines } from "../install-dream-cron";

const tmp = () => mkdtempSync(join(tmpdir(), "dream-test-"));

describe("sydneyDate", () => {
  test("1:30 am Sydney is still the previous day in UTC but stamps the Sydney date", () => {
    // 2026-09-25 01:30 AEST = 2026-09-24 15:30 UTC
    expect(sydneyDate(new Date("2026-09-24T15:30:00Z"))).toBe("2026-09-25");
  });
});

describe("guardrails", () => {
  test("budget caps calls and tokens", () => {
    const b = new DreamBudget({ maxClaudeCalls: 2, maxTokens: 100_000 });
    expect(b.allows(60_000).ok).toBe(true);
    b.record(60_000);
    expect(b.allows(60_000).ok).toBe(false);
    expect(b.allows(30_000).ok).toBe(true);
    b.record(30_000);
    expect(b.allows(1).reason).toContain("2/2 Claude calls");
  });

  test("weekly usage gate skips at or above the threshold", () => {
    expect(usageGate(85, 85).skip).toBe(true);
    expect(usageGate(84, 85).skip).toBe(false);
    expect(usageGate(null, 85).skip).toBe(false);
  });

  test("weekly percent comes from the AI usage snapshot, then live-data", () => {
    const snap = { subscriptions: [{ provider: "anthropic", status: { ok: true, windows: [{ label: "Session (5-hour)", usedPercent: 3 }, { label: "Weekly · all models", usedPercent: 67 }, { label: "Weekly · Fable", usedPercent: 10 }] } }] };
    expect(claudeWeeklyPercent(snap, null)).toEqual({ percent: 67, source: "AI usage snapshot" });
    const ld = { usage: { claudeWindow: { authoritative: { seven_day: { utilization: 41 } } } } };
    expect(claudeWeeklyPercent(null, ld).percent).toBe(41);
    expect(claudeWeeklyPercent(null, null).percent).toBeNull();
  });

  test("limits ignore out-of-range config", () => {
    const l = dreamLimits({ dream: { maxClaudeCalls: 99, maxTokens: 50_000, model: "bad model!" } });
    expect(l.maxClaudeCalls).toBe(2);
    expect(l.maxTokens).toBe(50_000);
    expect(l.model).toBe("claude/sonnet-5"); // the catalogue's dream.nightly first candidate
  });

  test("lock blocks a second dream and takes over a dead one", () => {
    const dir = tmp();
    const file = join(dir, "dream.lock");
    expect(acquireLock(file, Date.now(), () => true).ok).toBe(true);
    const second = acquireLock(file, Date.now(), () => true);
    expect(second.ok).toBe(false);
    // Holder process gone: stale, taken over.
    expect(acquireLock(file, Date.now(), () => false).ok).toBe(true);
    releaseLock(file);
    expect(existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("output", () => {
  const raw = {
    prescriptions: [
      { id: "Workflow Fix!", cat: "workflow", headline: "Chain the lead calls", prescription: "Do it.", evidence: ["a", "b", "c", "d"], command: "bun x", dollarImpact: 120.4 },
      { id: "bad", cat: "NOPE", headline: "", prescription: "" },
    ],
    report: {
      summaryLine: "Preview for Bianca is due Friday; tests green.",
      improved: ["tests 1988 pass"],
      broke: [],
      topActions: [{ title: "Send Brooke the preview", why: "Due 26 Sep" }, { title: "Call 8 dental leads", why: "0 calls yesterday" }, "Fix the lock"],
      salesCoaching: "No scored calls.",
      clientDeadlines: [{ client: "Bianca Brown Realty", item: "Preview", due: "2026-09-26" }],
    },
    proposals: [{ id: "p1", kind: "code", title: "Add X", why: "Because", brief: "Do X in scripts/x.ts", acceptance: ["tests pass"], effort: "S", risk: "low" }, { title: "no brief" }],
    skillCandidates: [
      { id: "Lead Triage!", name: "Lead source triage", evidence: ["Done by hand 6 times in 30 days"], steps: ["Pull the lead", "Tag the source"], route: "cli", effort: "S", jevFit: { fits: true, decision: "lead-source-classification" } },
      { name: "no evidence, dropped" },
    ],
  };

  test("normalises prescriptions, report and proposals", () => {
    const doc = normaliseDream(raw, { date: "2026-09-25", model: "claude-sonnet-5", engine: "claude", now: new Date("2026-09-24T16:00:00Z") });
    expect(doc.prescriptions).toHaveLength(1);
    expect(doc.prescriptions[0]).toMatchObject({ id: "workflow-fix", cat: "WORKFLOW", tone: "yellow", dollarImpact: 120 });
    expect(doc.prescriptions[0].evidence).toHaveLength(3);
    expect(doc.report.topActions.map((a) => a.title)).toEqual(["Send Brooke the preview", "Call 8 dental leads", "Fix the lock"]);
    expect(doc.proposals).toHaveLength(1);
    expect(doc.skillCandidates).toHaveLength(1);
    expect(doc.skillCandidates[0]).toMatchObject({ id: "lead-triage", name: "Lead source triage", route: "cli", effort: "S", jevFit: { fits: true, decision: "lead-source-classification" } });
    expect(summaryLine(doc)).toBe("Preview for Bianca is due Friday; tests green. (1 proposal on the dashboard)");
    const md = renderReportMarkdown(doc, { checks: "Tests: 1 pass." });
    expect(md).toContain("## Three highest-leverage actions today");
    expect(md).toContain("## Skill candidates (last 30 days)");
    expect(md).toContain("Lead source triage");
    expect(md).toContain('Say "build skill candidate N" to approve one.');
    expect(md).toContain("nothing was changed, deployed or sent");
  });

  test("an empty reply is a failure, not an empty success", () => {
    expect(() => normaliseDream({}, { date: "d", model: "m", engine: "claude" })).toThrow();
    expect(() => normaliseDream("nope", { date: "d", model: "m", engine: "claude" })).toThrow();
  });

  test("parses fenced or prefixed JSON", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
  });

  test("state keeps verdicts and marks repeats as recurring", () => {
    const s = updateDreamState({ actions: { a: { status: "new", firstSeenAt: "x" }, b: { status: "dismissed", firstSeenAt: "y" } } }, ["a", "b", "c"], "now");
    expect(s.actions.a.status).toBe("recurring");
    expect(s.actions.b.status).toBe("dismissed");
    expect(s.actions.c).toMatchObject({ status: "new", firstSeenAt: "now" });
    expect(s.currentTop4).toEqual(["a", "b", "c"]);
  });
});

describe("inputs", () => {
  test("scrub removes emails, AU phone numbers and token-shaped strings", () => {
    const out = scrub("mail javery@gmail.com or 0412 345 678, key sk-abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("@gmail.com");
    expect(out).toContain("[phone]");
    expect(out).toContain("[secret]");
  });

  test("summarises bun test and tsc output", () => {
    const t = summariseBunTest("(fail) crm > logs a call [12.00ms]\n 1987 pass\n 1 skip\n 1 fail\n", 1);
    expect(t).toMatchObject({ ok: false, pass: 1987, fail: 1, failures: ["crm > logs a call"] });
    const c = summariseTsc("src/a.ts(1,2): error TS2322: bad\nsrc/a.ts(3,4): error TS2345: worse\n", 2);
    expect(c).toMatchObject({ ok: false, errors: 2, byFile: { "src/a.ts": 2 } });
    expect(summariseTsc("", 0).ok).toBe(true);
  });

  test("bundle drops the lowest-priority sections to fit the cap", () => {
    const b = buildBundle([["first", "x".repeat(50)], ["second", "y".repeat(50)], ["third", "z".repeat(500)]], 200);
    expect(b.dropped).toEqual(["third"]);
    expect(b.text).toContain("## first");
    expect(b.text.length).toBeLessThanOrEqual(200);
  });

  test("client hubs: unchecked items, next actions and dated rows, scrubbed", () => {
    const root = tmp();
    mkdirSync(join(root, "acme-realty"));
    writeFileSync(join(root, "acme-realty", "CLIENT.md"), [
      "# Acme Realty — Client Hub", "| **~26 Sep 2026** | **Preview due** |", "- [x] done thing", "- [ ] Preview to Jo by Fri 26 Sep 2026",
      "- [ ] Bill jo@acme.com.au", "## 6 · Next actions", "1. Build listing page", "## 7 · Rules", "- never this",
    ].join("\n"));
    const hubs = clientHubs(root) as any[];
    expect(hubs).toHaveLength(1);
    expect(hubs[0].client).toBe("Acme Realty — Client Hub");
    expect(hubs[0].openChecklist).toEqual(["Preview to Jo by Fri 26 Sep 2026", "Bill [email]"]);
    expect(hubs[0].nextActions).toEqual(["1. Build listing page"]);
    expect(hubs[0].timeline[0]).toContain("26 Sep 2026");
    rmSync(root, { recursive: true, force: true });
  });

  test("jarvis digest counts low-confidence routes without any utterance text", () => {
    const dir = tmp();
    const now = Date.parse("2026-09-25T00:00:00Z");
    writeFileSync(join(dir, "laya-shadow.jsonl"), [
      { at: "2026-09-24T12:00:00Z", jevIntent: "hermes", jevConfidence: 0.4, jevMs: 300, agree: false },
      { at: "2026-09-24T13:00:00Z", jevIntent: "pc.open_app", jevConfidence: 1, jevMs: 500, agree: true },
      { at: "2026-09-20T13:00:00Z", jevIntent: "old", jevConfidence: 0.1, jevMs: 500, agree: false },
    ].map((r) => JSON.stringify(r)).join("\n"));
    const d = jarvisDigest(dir, now) as any;
    expect(d.routing24h).toMatchObject({ decisions: 2, lowConfidence: 1, lowConfidenceByIntent: { hermes: 1 }, shadowDisagreements: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("client build for QA", () => {
  test("prefers a CLIENT.md path, then preview-build, and skips a dist the hub calls an earlier concept", () => {
    const hub = tmp();
    mkdirSync(join(hub, "dist"));
    const oldDist = "- `dist/` — the earlier published concept. **Do not modify.**";
    expect(clientBuildDir(hub, oldDist)).toBeNull();
    expect(clientBuildDir(hub, "- `dist/` — the live site")).toMatchObject({ source: "dist" });
    mkdirSync(join(hub, "brooke-draft", "preview-build"), { recursive: true });
    expect(clientBuildDir(hub, oldDist)).toEqual({ dir: join(hub, "brooke-draft/preview-build"), source: "brooke-draft/preview-build" });
    mkdirSync(join(hub, "site", "out"), { recursive: true });
    expect(clientBuildDir(hub, `${oldDist}\n- Client build: \`site/out\``)).toEqual({ dir: join(hub, "site/out"), source: "CLIENT.md" });
    rmSync(hub, { recursive: true, force: true });
  });
});

describe("scheduled task", () => {
  test("the wrapper CALLs bun, so the Dream line is actually reached", () => {
    const lines = windowsWrapperLines("C:\\npm\\bun.cmd", "C:\\repo", "C:\\log.txt");
    const bunLines = lines.filter((l) => l.includes("bun.cmd"));
    expect(bunLines.length).toBeGreaterThan(0);
    for (const l of bunLines) expect(l.startsWith("call ")).toBe(true);
    expect(lines.join("\n")).toContain("run-dream.ts");
    expect(lines).toContain("exit /b %DREAM_RC%");
  });

  test("registration wakes the PC, runs only when logged on, and never overlaps", () => {
    const ps = windowsRegisterScript("C:\\Users\\O'Brien\\dream-run.cmd", "ClaudeOS Dream", "01:30");
    expect(ps).toContain("-WakeToRun");
    expect(ps).toContain("-StartWhenAvailable");
    expect(ps).toContain("-MultipleInstances IgnoreNew");
    expect(ps).toContain("-LogonType Interactive");
    expect(ps).toContain("-At '01:30'");
    expect(ps).toContain("O''Brien");
  });
});

// Keep an eye on the shape the dashboard renders: a real dream file written by run-dream.ts
// must round-trip through the normaliser unchanged.
test("normalised docs are stable when re-normalised", () => {
  const dir = tmp();
  const doc = normaliseDream({ report: { summaryLine: "x", topActions: [{ title: "t" }] } }, { date: "2026-09-25", model: "m", engine: "claude" });
  writeFileSync(join(dir, "d.json"), JSON.stringify(doc));
  const again = normaliseDream(JSON.parse(readFileSync(join(dir, "d.json"), "utf-8")), { date: "2026-09-25", model: "m", engine: "claude", now: new Date(doc.generatedAt) });
  expect(again.report).toEqual(doc.report);
  rmSync(dir, { recursive: true, force: true });
});
