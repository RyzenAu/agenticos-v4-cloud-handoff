// UI-truth review, Stage A (28 Sep 2026): Today / sidebar / HUD findings H1, H3, M4, M5, M6, M8,
// M9 and the low items L2, L5, L6. Synthetic fixtures only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsYouBadge, needsYouBreakdown, needsYouFrom } from "./workspace/needs-you";
import { needsReplyThreads, projectEmail, projectHunt, projectPipeline } from "./workspace/projections";
import { createWorkspace, FRESH_REUSE_MS, SERVE_STALE_MAX_MS } from "./workspace/sources";
import { MAX_PENDING_DAYS, validateApprovals } from "./workspace/approvals";
import { fromRegistry, httpPing, serviceDots } from "./hud-feed";
import { openCrm, upsertLead, mergeLead } from "./leads/crm";
import { leadPipeline, pipelineContext, pipelineSummary } from "./leads/lead-pipeline";
import { findLead } from "./leads/crm";
import { upsertPreview } from "./lead-sites/registry";
import { buildSnapshot, createProviderCache, higgsfieldTopUpNote, higgsfieldUnknownLabel } from "./ai-usage/snapshot";
import { DEFAULT_PRICES } from "./ai-usage/prices";
import { todayFacts, todayTiles } from "../src/components/shell/today-facts";
import { panelSignalState } from "../src/components/shell/page-parts";
import { agentJobsAdapter, mergeRunning, runningFromFeed } from "../src/lib/running-now";
import type { FeedTask } from "../src/lib/agent-feed";

const root = mkdtempSync(join(tmpdir(), "ui-truth-today-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-09-28T01:00:00Z");
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString();
const ok = <T,>(data: T, msAgo = 0) => ({ ok: true as const, data, updatedAt: at(msAgo), ms: 5 });
const failed = (error = "boom") => ({ ok: false as const, error, timedOut: false, updatedAt: at(), ms: 5 });
const approval = (id: string) => ({ id, title: `Decide ${id}`, area: "sales" as const, detail: "Synthetic", href: "/leads", since: "2026-09-27", source: "test" });
const todayPanel = (ids: string[], derivedError: string | null = null) => ({ now: at(), callingWindow: {} as never, approvals: ids.map(approval), approvalsErrors: [], derivedError });
const row = (messageId: string, threadId: string, over: Record<string, unknown> = {}) => ({
  messageId,
  threadId,
  account: "owner@example.test",
  receivedAt: at(),
  category: "client",
  importance: "today",
  senderName: "Client",
  subject: "Question",
  ...over,
});
const connected = { accounts: { accounts: [{ id: "google", connected: true }] }, native: null };

// ── H1: one "needs you" count ──────────────────────────────────────────────────────────────────
describe("H1: one needs-you definition, deduped by thread and item", () => {
  test("emails to answer count one per thread, not per message (15 duplicate threads collapse)", () => {
    const rows = [row("m1", "t1"), row("m2", "t1"), row("m3", "t1", { importance: "urgent" }), row("m4", "t2"), row("m5", "t3", { category: "newsletter" })];
    const threads = needsReplyThreads(rows);
    expect(threads.map((r) => r.threadId)).toEqual(["t1", "t2"]);
    expect(threads[0].messageId).toBe("m3"); // the thread's most important message speaks for it
    const panel = projectEmail({ triage: { rows }, ...connected });
    if (!panel.connected) throw new Error("expected connected");
    expect(panel.needsReplyCount).toBe(2);
    // the same thread id in two mailboxes is two threads
    expect(needsReplyThreads([row("a", "t1"), row("b", "t1", { account: "other@example.test" })])).toHaveLength(2);
  });

  test("decisions dedupe by id; total adds decisions, email threads and agent approvals", () => {
    const email = projectEmail({ triage: { rows: [row("m1", "t1"), row("m2", "t1"), row("m3", "t2")] }, ...connected });
    const panel = needsYouFrom({ today: ok(todayPanel(["a", "b", "a"])), email: ok(email), agent: { ok: true, count: 1, at: at() } });
    expect(panel.parts.decisions.count).toBe(2);
    expect(panel.parts.email.count).toBe(2);
    expect(panel.parts.agentApprovals.count).toBe(1);
    expect(panel.total).toBe(5);
    expect(panel.complete).toBe(true);
    expect(needsYouBadge(panel)).toBe("5");
    expect(needsYouBreakdown(panel)).toBe("2 decisions · 2 emails · 1 agent approval");
  });

  test("an unreadable part is unknown, never zero: the total becomes a lower bound", () => {
    const panel = needsYouFrom({ today: ok(todayPanel(["a", "b"])), email: failed("Timed out after 9 s"), agent: { ok: false, error: "task store down" } });
    expect(panel.parts.email).toMatchObject({ count: null, state: "failed" });
    expect(panel.complete).toBe(false);
    expect(needsYouBadge(panel)).toBe("2+");
    expect(needsYouBreakdown(panel)).toBe("2 decisions · emails unknown · agent approvals unknown");
    const none = needsYouFrom({ today: failed(), email: failed(), agent: { ok: false, error: "x" } });
    expect(needsYouBadge(none)).toBeNull();
    expect(needsYouBadge({ total: 160, complete: true, parts: panel.parts })).toBe("99+");
    // inbox not connected = setup required, not "0 emails"
    const notConnected = needsYouFrom({ today: ok(todayPanel([])), email: ok({ connected: false, reason: "No mailbox" }), agent: { ok: true, count: 0, at: null } });
    expect(notConnected.parts.email.state).toBe("setup-required");
    expect(needsYouBadge(notConnected)).toBe("0+");
    // live receptionist gates unreadable: file decisions still count, but only as a floor
    const partial = needsYouFrom({ today: ok(todayPanel(["a"], "Receptionist gates unavailable")), email: ok(email0()), agent: { ok: true, count: 0, at: null } });
    expect(partial.complete).toBe(false);
    expect(needsYouBreakdown(partial)).toContain("1+ decisions");
  });

  test("the server panel feeds the sidebar, Today and the HUD the same number", async () => {
    const dir = mkdtempSync(join(root, "ws-"));
    writeFileSync(join(dir, "approvals.json"), JSON.stringify({ version: 1, items: [approval("x-one"), approval("x-two")] }));
    const get = async (path: string) => {
      if (path === "/__receptionist") return { readiness: { blockers: [] } };
      if (path === "/__operator/inbox/triage") return { rows: [row("m1", "t1"), row("m2", "t1"), row("m3", "t9")], digest: { hours: 24, total: 3 } };
      if (path === "/__operator/connections") return connected.accounts;
      if (path === "/__operator/native-connections") return { providers: [] };
      if (path === "/__operator/jarvis/status") return { approvals: { ok: true, at: at(), data: { count: 3 } } };
      throw new Error(`unexpected ${path}`);
    };
    const ws = createWorkspace({ get, approvalsFile: join(dir, "approvals.json"), sites: { check: async () => ({}) as never }, now: () => NOW });
    const needs = await ws.panel("needsYou");
    if (!needs.ok) throw new Error(needs.error);
    expect(needs.data.total).toBe(2 + 2 + 3);
    const email = await ws.panel("email");
    if (!email.ok || !email.data.connected) throw new Error("email");
    // Today's "Emails to answer" tile and the needs-you email part are the same figure
    expect(needs.data.parts.email.count).toBe(email.data.needsReplyCount);
    const tile = todayTiles({ needsYou: { data: needs } }, todayFacts({ needsYou: { data: needs } }), NOW).find((t) => t.key === "needsYou")!;
    expect(tile).toMatchObject({ label: "Waiting on you", value: needsYouBadge(needs.data), state: "ok" });
    expect(String(tile.hint)).toBe("2 decisions · 2 emails · 3 agent approvals");
    // The sidebar (sidebarBadge, built on needsYouBadge) and the HUD render from this same response.
    const sidebar = readFileSync(join(import.meta.dir, "../src/components/app-sidebar.tsx"), "utf8");
    const hud = readFileSync(join(import.meta.dir, "../src/components/operator/jarvis-hud.tsx"), "utf8");
    for (const src of [sidebar, hud]) expect(src).toContain('useWorkspacePanel("needsYou")');
    expect(sidebar).toContain("sidebarBadge(");
    expect(hud).toContain("needsYouBadge(");
    expect(sidebar).not.toContain('i.category === "needs-you"');
    expect(hud).not.toContain("status.approvals.data.count");
  });
});

function email0() {
  const p = projectEmail({ triage: { rows: [] }, ...connected });
  return p;
}

// ── M9: email source caches and serves stale honestly ─────────────────────────────────────────
describe("M9: a slow or failing source serves its last good read, marked stale", () => {
  test("concurrent reads share one request; a recent good read is reused; a failure serves stale", async () => {
    let clock = NOW;
    let calls = 0;
    let fail = false;
    const get = async (path: string) => {
      if (path === "/__operator/inbox/triage") {
        calls++;
        if (fail) throw new Error("native discovery timed out");
        return { rows: [row("m1", "t1")], digest: { hours: 24, total: 1 } };
      }
      if (path === "/__operator/connections") return connected.accounts;
      if (path === "/__operator/native-connections") return { providers: [] };
      throw new Error(path);
    };
    const ws = createWorkspace({ get, approvalsFile: join(root, "none.json"), sites: { check: async () => ({}) as never }, now: () => clock });
    const [a, b] = await Promise.all([ws.panel("email"), ws.panel("email")]);
    expect(calls).toBe(1);
    expect(a.ok && b.ok).toBe(true);
    clock += FRESH_REUSE_MS - 1;
    await ws.panel("email");
    expect(calls).toBe(1); // reused, still showing its real read time
    clock += 2;
    fail = true;
    const stale = await ws.panel("email");
    expect(calls).toBe(2);
    if (!stale.ok) throw new Error("expected the last good read");
    expect(stale.stale?.error).toContain("triage log couldn't be read"); // the fresh read's failure rides along
    expect(stale.updatedAt).toBe(at()); // the time the data was actually read, not now
    expect(panelSignalState(stale, clock)).toBe("stale");
    const tile = todayTiles({ email: { data: stale } }, todayFacts({ email: { data: stale } }), clock).find((t) => t.key === "email")!;
    expect(tile.state).toBe("stale");
    expect(String(tile.hint)).toContain("Last good read; refresh failed");
    clock += SERVE_STALE_MAX_MS + 1;
    const gone = await ws.panel("email");
    expect(gone.ok).toBe(false); // too old to vouch for: failed, never an old number
  });

  test("email gets enough time for a cold mailbox discovery", async () => {
    const { TIMEOUTS } = await import("./workspace/sources");
    expect(TIMEOUTS.email).toBeGreaterThanOrEqual(9_000);
  });

  test("native mailbox discovery serves its last answer and never starts Codex from a read (T8b)", () => {
    const src = readFileSync(join(import.meta.dir, "native-inbox-sync.ts"), "utf8");
    expect(src).toContain("A READ never starts Codex");
    const status = src.slice(src.indexOf("async status()"), src.indexOf("async check()"));
    expect(status).not.toContain("connectedRead");
    expect(status).not.toContain("check(");
  });
});

// ── H3: open leads exclude closed, excluded and merged ────────────────────────────────────────
describe("H3: Open leads counts only open, unexcluded, unmerged leads", () => {
  test("pipeline summary splits every record into open / lost / excluded / merged", () => {
    const dir = mkdtempSync(join(root, "crm-"));
    const db = openCrm(join(dir, ".operator-data", "crm.sqlite"));
    try {
      const add = (name: string, extra: Record<string, unknown> = {}) => {
        upsertLead(db, { placeId: `osm:node/${name}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental", area: "Parramatta NSW", name, phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch: "website", reasons: [], ...extra } as never);
        return (db.query("SELECT max(id) AS id FROM leads").get() as { id: number }).id;
      };
      const keep = add("Open A");
      add("Open B");
      const dupe = add("Duplicate of A");
      add("Excluded", { excluded: true, excludedReason: "chain" });
      const lost = add("Lost");
      db.run("UPDATE leads SET status = 'lost' WHERE id = ?", [lost]);
      mergeLead(db, keep, dupe);
      const s = pipelineSummary(dir, db);
      expect(s.total).toBe(5);
      expect(s).toMatchObject({ open: 2, lost: 1, excluded: 1, merged: 1 });
      expect(s.open + s.lost + s.excluded + s.merged).toBe(s.total);
      expect(Object.values(s.openCounts).reduce((a, b) => a + b, 0)).toBe(2);
      const panel = projectPipeline({ summary: s, statusCounts: null, overview: null });
      expect(panel.open).toBe(2);
      expect(panel.total).toBe(5);
    } finally {
      db.close();
    }
  });

  test("M10: the batched summary gives every lead the same stage as the per-lead read, far faster", () => {
    const dir = mkdtempSync(join(root, "crm-fast-"));
    const db = openCrm(join(dir, ".operator-data", "crm.sqlite"));
    try {
      for (let i = 0; i < 400; i++)
        upsertLead(db, { placeId: `osm:node/f${i}`, source: "osm", attribution: "x", vertical: "dental", area: "A", name: `Lead ${i}`, phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: i % 3, pitch: "website", reasons: [] } as never);
      // a preview, a proposal draft and a completed audit on a few leads
      upsertPreview(dir, { leadId: 5, business: "Lead 4", vertical: "dental", slug: "lead-4", domain: "x.test", url: "https://x.test", project: "p", dir: "d", status: "live", generatedAt: at() } as never);
      mkdirSync(join(dir, ".operator-data", "drafts", "7"), { recursive: true });
      writeFileSync(join(dir, ".operator-data", "drafts", "7", "proposal.md"), "DRAFT");
      mkdirSync(join(dir, ".operator-data", "seo-audits", "9"), { recursive: true });
      writeFileSync(join(dir, ".operator-data", "seo-audits", "9", "run.json"), JSON.stringify({ ok: true }));
      const ctx = pipelineContext(dir);
      for (let id = 1; id <= 400; id++) {
        const lead = findLead(db, id)!;
        expect(leadPipeline(dir, db, lead, ctx)).toEqual(leadPipeline(dir, db, lead));
      }
      expect(leadPipeline(dir, db, findLead(db, 7)!, ctx).stage).toBe("proposal");
      expect(leadPipeline(dir, db, findLead(db, 5)!, ctx).stage).toBe("preview");
      expect(leadPipeline(dir, db, findLead(db, 9)!, ctx).stage).toBe("audited");
      const t0 = performance.now();
      pipelineSummary(dir, db);
      expect(performance.now() - t0).toBeLessThan(1500);
    } finally {
      db.close();
    }
  });

  test("Today labels open leads from `open`, never the all-records total", () => {
    const page = readFileSync(join(import.meta.dir, "../src/components/shell/pages/today-page.tsx"), "utf8");
    expect(page).toContain('value={q.pipeline.isLoading ? "…" : pipeline ? pipeline.open : null}');
    expect(page).not.toContain('["Open leads", pipeline.total]');
    // an older server without `open` shows unknown (null), not the inflated total
    expect(projectPipeline({ summary: { total: 963, counts: {} }, statusCounts: null, overview: null }).open).toBeNull();
  });
});

// ── M4: key present is not "up" ───────────────────────────────────────────────────────────────
describe("M4: HUD service dots — configured is unknown, a 4xx is failed", () => {
  test("registry: working = up, available (key present) = unknown, setup = warn, broken = down", () => {
    const caps = [
      { id: "a", status: "working" as const, evidence: "acceptance PASS" },
      { id: "b", status: "available" as const, evidence: "TypeSafe key present" },
      { id: "c", status: "setup-required" as const },
      { id: "d", status: "broken" as const },
    ];
    expect(["a", "b", "c", "d", "e"].map((id) => fromRegistry(caps, id, id).state)).toEqual(["up", "unknown", "warn", "down", "unknown"]);
    expect(fromRegistry(caps, "b", "b").detail).toContain("configured, not verified");
  });

  test("a 4xx health answer is failed, not up", async () => {
    const f = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;
    expect(await httpPing("http://127.0.0.1:1/health", f(200))).toEqual({ up: true, status: 200 });
    expect(await httpPing("http://127.0.0.1:1/health", f(401))).toEqual({ up: false, status: 401 });
    expect(await httpPing("http://127.0.0.1:1/health", f(404))).toEqual({ up: false, status: 404 });
    const dots = await serviceDots([], (async (url: string) => new Response("", { status: String(url).includes("8888") ? 401 : 200 })) as unknown as typeof fetch);
    const hindsight = dots.find((d) => d.id === "hindsight")!;
    expect(hindsight.state).toBe("down");
    expect(hindsight.detail).toContain("HTTP 401");
  });
});

// ── M5: the failing lead hunt is shown ────────────────────────────────────────────────────────
describe("M5: a failing lead hunt reaches Today and the HUD", () => {
  const hunt = { status: "failed", ranAt: "2026-09-28T01:30:56", problem: "OpenStreetMap's Overpass server rate-limited tonight's hunt", failingSince: "2026-09-27T01:57:01", overdue: false };
  test("Today's Needs attention names it", () => {
    const pipeline = ok(projectPipeline({ summary: { total: 1, counts: {} }, statusCounts: null, overview: null, hunt }));
    const facts = todayFacts({ pipeline: { data: pipeline } });
    const row = facts.exceptions.find((e) => e.id === "lead-hunt")!;
    expect(row).toMatchObject({ tone: "danger", to: "/leads" });
    expect(String(row.text)).toMatch(/^Lead hunt failing since 27 Sept?/);
    // an ok hunt adds nothing; an unknown hunt is not invented
    expect(todayFacts({ pipeline: { data: ok(projectPipeline({ summary: null, statusCounts: null, overview: null, hunt: { ...hunt, status: "ok" } })) } }).exceptions).toEqual([]);
    expect(projectHunt({ status: "weird" })).toBeNull();
  });
  test("the HUD renders the calls source's headline", () => {
    const hud = readFileSync(join(import.meta.dir, "../src/components/operator/jarvis-hud.tsx"), "utf8");
    expect(hud).toMatch(/calls\?\.headline && \(/);
    expect(hud).toContain("{calls.headline}");
  });
});

// ── M6: decided items stop waiting; pending items expire ──────────────────────────────────────
describe("M6: approvals resolve or expire", () => {
  const base = approval("item");
  test("a decided item records the decision and leaves the waiting list", () => {
    const out = validateApprovals({ version: 1, items: [{ ...base, status: "decided", decision: "Scotty narrates", decidedOn: "2026-09-28" }] }, NOW);
    expect(out).toMatchObject({ items: [], decided: 1, errors: [] });
    const missing = validateApprovals({ version: 1, items: [{ ...base, status: "decided", decision: "x" }] }, NOW);
    expect(missing.errors.join()).toContain("decidedOn is required");
    expect(missing.items).toEqual([]);
  });
  test("the narration voice is decided in the seeded file", () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, "workspace/approvals.json"), "utf8"));
    const voice = file.items.find((i: { id: string }) => i.id === "video-narration-voice");
    expect(voice).toMatchObject({ status: "decided", decidedOn: "2026-09-28" });
    expect(validateApprovals(file, NOW).items.map((a) => a.id)).not.toContain("video-narration-voice");
  });
  test("pending items expire on their date or after MAX_PENDING_DAYS, and are named", () => {
    const dated = { ...base, id: "dated", expires: "2026-09-28" };
    const old = { ...base, id: "old", since: "2026-09-01" };
    const fresh = { ...base, id: "fresh" };
    const onTheDay = validateApprovals({ version: 1, items: [dated, old, fresh] }, Date.parse("2026-09-28T05:00:00Z"));
    expect(onTheDay.items.map((a) => a.id)).toEqual(["dated", "fresh"]);
    expect(onTheDay.expired).toEqual([{ id: "old", title: "Decide item", expiredOn: `2026-09-${String(1 + MAX_PENDING_DAYS).padStart(2, "0")}` }]);
    const nextDay = validateApprovals({ version: 1, items: [dated, fresh] }, Date.parse("2026-09-29T05:00:00Z"));
    expect(nextDay.items.map((a) => a.id)).toEqual(["fresh"]);
    expect(nextDay.expired.map((x) => x.id)).toEqual(["dated"]);
  });
  test("an expired item is surfaced on the Today panel for closing or renewal", async () => {
    const dir = mkdtempSync(join(root, "exp-"));
    writeFileSync(join(dir, "approvals.json"), JSON.stringify({ version: 1, items: [{ ...base, expires: "2026-09-20" }] }));
    const ws = createWorkspace({ get: async () => ({ readiness: { blockers: [] } }), approvalsFile: join(dir, "approvals.json"), sites: { check: async () => ({}) as never }, now: () => NOW });
    const today = await ws.panel("today");
    if (!today.ok) throw new Error(today.error);
    expect(today.data.approvals).toEqual([]);
    expect(today.data.approvalsErrors.join()).toContain("expired unreviewed on 2026-09-20");
  });
});

// ── M8: Running now reads the server ──────────────────────────────────────────────────────────
describe("M8: Running now lists the server's agent jobs, not only this tab", () => {
  const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, prompt: `Job ${id}`, createdAt: at(), runs: [{ agent: "codex", status, events: [{ label: "Editing files" }], ...extra }] });
  test("active runs become rows; finished ones don't", () => {
    const rows = agentJobsAdapter.parse({ jobs: [job("1", "running"), job("2", "completed"), job("3", "needs_input", { pending: { title: "Approve npm install" } }), job("4", "queued")] });
    expect(rows.map((r) => [r.id, r.state])).toEqual([["job:1", "running"], ["job:3", "needs-you"], ["job:4", "queued"]]);
    expect(rows[0]).toMatchObject({ agent: "Codex", detail: "Editing files", source: "Agent jobs (server)" });
    expect(rows[1].detail).toBe("Waiting for your answer: Approve npm install");
    expect(agentJobsAdapter.parse({ nope: true })).toEqual([]);
  });
  test("a job the tab also follows is one row; tab-only hand-offs still show", () => {
    const task = (id: string, jobId?: string): FeedTask => ({ id, kind: "agent-job", title: `Tab ${id}`, agent: "Codex", startedAt: NOW, steps: [], jobId });
    const merged = mergeRunning(agentJobsAdapter.parse({ jobs: [job("1", "running")] }), runningFromFeed([task("a", "1"), task("b"), { ...task("c"), endedAt: NOW }]));
    expect(merged.map((r) => r.id)).toEqual(["job:1", "feed:b"]);
  });
  test("Today never says 'Nothing running' when the server list couldn't be read", () => {
    const page = readFileSync(join(import.meta.dir, "../src/components/shell/pages/today-page.tsx"), "utf8");
    expect(page).toContain("Unknown: the server's job list couldn't be read");
    expect(page).toContain("RUNNING_SOURCES");
  });
});

// ── L2, L5, L6 ────────────────────────────────────────────────────────────────────────────────
describe("L2: the margin table says what its numbers are", () => {
  test("known-costs caveat is visible and the minutes column is the base usage scenario", () => {
    const page = readFileSync(join(import.meta.dir, "../src/components/shell/pages/finance-page.tsx"), "utf8");
    expect(page).not.toContain('sr-only"> (known costs only)');
    expect(page).toContain("known costs only</span>");
    expect(page).toContain("Base usage scenario minutes");
    expect(page).not.toMatch(/>Base minutes</);
  });
});

describe("L5: Higgsfield is an auto top-up, not a monthly plan", () => {
  test("default label and wording", () => {
    const p = DEFAULT_PRICES.find((x) => x.id === "higgsfield-plan")!;
    expect(p.label).toBe("Higgsfield auto top-up (each)");
    expect(higgsfieldTopUpNote({ amount: 15, currency: "USD" })).toContain("US$15 is charged each time the API balance falls below US$1");
    expect(higgsfieldUnknownLabel({ amount: 15, currency: "USD" })).toContain("US$15 each");
  });
  test("a saved top-up amount is not counted as a fixed monthly cost; it's named as unknown", async () => {
    const home = join(root, "aiu-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsFile = join(root, "ai-usage.json");
    writeFileSync(settingsFile, JSON.stringify({ version: 1, prices: { "higgsfield-plan": { amount: 15, currency: "USD", gstIncluded: false } } }));
    const ledger = join(root, "ledger.jsonl");
    writeFileSync(ledger, `${JSON.stringify({ at: new Date(2026, 8, 20).toISOString(), provider: "higgsfield", costCredits: 4 })}\n`);
    const request = (async (url: string) =>
      String(url).startsWith("https://open.er-api.com")
        ? new Response(JSON.stringify({ result: "success", time_last_update_utc: "Thu, 24 Sep 2026 00:00:00 +0000", rates: { AUD: 1.5 } }), { headers: { "Content-Type": "application/json" } })
        : new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const snap = await buildSnapshot({ settingsFile, cache: createProviderCache(), counts: () => null, transcripts: () => null, transcriptsScanning: () => false, providerKey: () => "", request, now: () => new Date(2026, 8, 24, 12), home, hermesHome: join(root, "no-hermes"), env: {}, designLedger: ledger });
    expect(snap.totals.fixedAud).toBe(snap.subscriptions.reduce((n, s) => n + (s.monthly?.aud ?? 0), 0));
    expect(snap.totals.unknown.join(" | ")).toContain("Higgsfield auto top-ups (US$15 each");
    expect(snap.prices.find((p) => p.id === "higgsfield-plan")!.label).toBe("Higgsfield auto top-up (each)");
  });
});

describe("L6: storage wording names no platform", () => {
  test("memory capture no longer says 'this Mac'", () => {
    for (const file of ["memory-capture.tsx", "memory-capture-feedback.ts", "memory-storage.tsx", "memory-setup.tsx"]) {
      expect(readFileSync(join(import.meta.dir, "../src/components/operator", file), "utf8")).not.toMatch(/this Mac/i);
    }
  });
});
