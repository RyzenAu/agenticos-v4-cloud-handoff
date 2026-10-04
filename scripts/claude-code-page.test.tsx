// W-B (29 Sep 2026): "the Claude Code section doesn't open". Root cause: the page opened onto a copy of
// Hermes' Mission Control and nothing about Claude Code, and that panel's only read had no timeout (a
// stalled /__hermes_missions left skeletons forever; a non-JSON reply was an unhandled rejection; a
// hand-written missions.json without mini_goals threw in render). These tests pin the fix.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchMission, normaliseMission } from "../src/components/hermes-mission-control";
import { claudeVerdict, usesClaude } from "../src/lib/claude-code-status";

const ROOT = join(import.meta.dir, "..");

describe("Mission Control's read can't hang or crash the page", () => {
  test("a server that never answers gives an honest error after the timeout, not endless skeletons", async () => {
    const never = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
    const t0 = Date.now();
    const out = await fetchMission(never, 50);
    expect(out).toEqual({ ok: false, error: "no answer within 0 s" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  test("a non-JSON or error reply is an error the page shows, not an unhandled rejection", async () => {
    const html = (async () => new Response("<!doctype html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMission(html)).toEqual({ ok: false, error: "the server answered HTTP 200" });
    const forbidden = (async () => new Response(JSON.stringify({ error: "loopback only" }), { status: 403 })) as unknown as typeof fetch;
    expect(await fetchMission(forbidden)).toEqual({ ok: false, error: "loopback only" });
  });
  test("no mission is null; a good mission passes through", async () => {
    const empty = (async () => new Response(JSON.stringify({ mission: null }))) as unknown as typeof fetch;
    expect(await fetchMission(empty)).toEqual({ ok: true, mission: null });
    const mission = { id: "m1", title: "Synthetic mission", deadline_days: 14, deadline_iso: "2026-10-13T00:00:00.000Z", created_at: "2026-09-29T00:00:00.000Z", mini_goals: [{ id: "g1", num: 1, title: "One", actor: "human", status: "done" }], image_path: null };
    const ok = (async () => new Response(JSON.stringify({ mission }))) as unknown as typeof fetch;
    const out = await fetchMission(ok);
    expect(out.ok && out.mission?.mini_goals[0]).toMatchObject({ id: "g1", actor: "human", status: "done" });
  });
  test("a hand-written or half-written missions.json never reaches render in a shape that throws", () => {
    expect(normaliseMission(null)).toBeNull();
    expect(normaliseMission({ title: "No goals list" })).toBeNull(); // mission.mini_goals.length threw before
    expect(normaliseMission({ mini_goals: [] })).toBeNull();
    const m = normaliseMission({ title: "Loose", mini_goals: [null, { title: 5 }, { status: "weird", actor: "robot" }], deadline_iso: "not a date" })!;
    expect(m.mini_goals).toHaveLength(2);
    expect(m.mini_goals[0]).toMatchObject({ id: "goal-1", title: "Goal 1", actor: "hermes", status: "queued" });
    expect(m.deadline_iso).toBe("");
  });
  test("the panel uses the guarded read and shows a retry on failure", () => {
    const src = readFileSync(join(ROOT, "src/components/hermes-mission-control.tsx"), "utf8");
    expect(src).toContain("const out = await fetchMission();");
    expect(src).toContain("Couldn't read the long-term mission");
    expect(src).not.toMatch(/const r = await fetch\("\/__hermes_missions"\);\s*const j = await r\.json\(\);/);
  });
});

describe("the Claude Code page answers what it's for", () => {
  const claude = (installed: boolean, limitReached = false) => ({ accounts: [{ accountSlot: "claude:max" as const, installed, cliVersion: installed ? "2.1.280" : null, allowance: { windows: [], limitReached }, models: [] }] });
  test("installed / not installed / at the limit / unknown", () => {
    expect(claudeVerdict(claude(true), false)).toMatchObject({ tone: "ok", title: "Claude Code is installed" });
    expect(claudeVerdict(claude(false), false)).toMatchObject({ tone: "warn", title: "Claude Code isn't installed here" });
    expect(claudeVerdict(claude(true, true), false)).toMatchObject({ tone: "warn", title: "Claude Code is at its plan limit" });
    // Unknown is never "ready".
    expect(claudeVerdict(null, true)).toMatchObject({ tone: "neutral", title: "Couldn't check Claude Code" });
    expect(claudeVerdict(undefined, false).tone).toBe("neutral");
  });
  test("its jobs are the coding jobs with a Claude role", () => {
    const job = (route: string) => ({ spec: { roles: [{ agent: { route } }] }, runs: [] }) as never;
    expect(usesClaude(job("claude-code-cli"))).toBe(true);
    expect(usesClaude(job("codex-app-server"))).toBe(false);
  });
  test("the page leads with Claude Code's state and actions; Mission Control is folded, not the page", () => {
    const src = readFileSync(join(ROOT, "src/routes/agents.claude-code.tsx"), "utf8");
    // L2: the verdict is the first widget of the grid (was a VerdictCard); its sentence is the line.
    expect(src).toContain("<WidgetGrid");
    expect(src).toContain('id="claude-code-verdict"');
    expect(src).toContain("line={stateLine}");
    expect(src).toContain("Give it a coding job");
    expect(src).toContain('summary={<span className="text-base font-medium">Long-term missions</span>}');
    expect(src.indexOf('id="claude-code-verdict"')).toBeLessThan(src.indexOf("<HermesMissionControl"));
    expect(src.indexOf('id="claude-code-verdict"')).toBeLessThan(src.indexOf("<PageFoot"));
    // Route files export only Route (TanStack code splitting): helpers live in src/lib.
    expect(/export (function|const) (?!Route\b)/.test(src)).toBe(false);
  });
});
