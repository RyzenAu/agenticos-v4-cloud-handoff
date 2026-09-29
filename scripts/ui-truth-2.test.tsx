// UI-truth round 2 (merge review "should fix", 28 Sep 2026): Refresh reads the source again, /work
// marks stale reads, the System tools tile never turns green over unknowns, and the sidebar badge
// tells zero from unknown. Synthetic fixtures only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { createWorkspace, FRESH_REUSE_MS, SWR_WAIT_MS } from "./workspace/sources";
import { projectEmail } from "./workspace/projections";
import { nativeInboxSync } from "./native-inbox-sync";
import { emailHint } from "../src/components/shell/today-facts";
import { crmChangeKey } from "./workspace/plugin";
import { needsYouBadge, needsYouBreakdown, needsYouFrom, sidebarBadge } from "./workspace/needs-you";
import { panelUrl, refreshPanels } from "../src/components/workspace/api";
import { panelFreshness } from "../src/components/workspace/panel-shell";
import { toolsTile, type Capabilities } from "../src/components/shell/system-facts";

const root = mkdtempSync(join(tmpdir(), "ui-truth-2-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.parse("2026-09-28T01:00:00Z");
const at = (ago = 0) => new Date(NOW - ago).toISOString();

describe("Refresh and a changed CRM read the source again", () => {
  function workspace(changeKey?: () => string | null) {
    let clock = NOW;
    let reads = 0;
    const ws = createWorkspace({
      get: async (path: string) => {
        if (path.startsWith("/__operator/leads/pipeline")) {
          reads++;
          return { total: 3, open: reads, counts: {} };
        }
        return null;
      },
      approvalsFile: join(root, "none.json"),
      sites: { check: async () => ({}) as never },
      now: () => clock,
      changeKey: changeKey ? () => changeKey() : undefined,
    });
    return { ws, reads: () => reads, tick: (ms: number) => (clock += ms) };
  }

  test("a recent read is reused, marked reused, keeping its real time and duration", async () => {
    const w = workspace();
    const first = await w.ws.panel("pipeline");
    w.tick(5_000);
    const again = await w.ws.panel("pipeline");
    expect(w.reads()).toBe(1);
    if (!first.ok || !again.ok) throw new Error("pipeline");
    expect(again.reused).toBe(true);
    expect(again.ms).toBe(first.ms); // not a fake 0 ms
    expect(again.updatedAt).toBe(first.updatedAt);
  });

  test("Refresh (fresh) always reads the source again", async () => {
    const w = workspace();
    await w.ws.panel("pipeline");
    const refreshed = await w.ws.panel("pipeline", { fresh: true });
    expect(w.reads()).toBe(2);
    if (!refreshed.ok) throw new Error("pipeline");
    expect(refreshed.data.open).toBe(2);
    expect(refreshed.reused).toBeFalsy();
  });

  test("a changed source (a call logged on /leads) is read again within the reuse window", async () => {
    let key = "crm:1";
    const w = workspace(() => key);
    await w.ws.panel("pipeline");
    w.tick(1_000);
    await w.ws.panel("pipeline");
    expect(w.reads()).toBe(1);
    key = "crm:2";
    const after = await w.ws.panel("pipeline");
    expect(w.reads()).toBe(2);
    if (!after.ok) throw new Error("pipeline");
    expect(after.data.open).toBe(2);
    w.tick(FRESH_REUSE_MS + 1);
    await w.ws.panel("pipeline");
    expect(w.reads()).toBe(3);
  });

  test("crmChangeKey follows the CRM file and its WAL, and only for CRM panels", () => {
    const dir = join(root, "crm");
    mkdirSync(join(dir, ".operator-data"), { recursive: true });
    const key = crmChangeKey(dir);
    const before = key("pipeline");
    writeFileSync(join(dir, ".operator-data", "crm.sqlite-wal"), "change");
    expect(key("pipeline")).not.toBe(before);
    expect(key("callQueue")).toBe(key("pipeline"));
    expect(key("email")).toBeNull();
  });

  test("the route passes ?fresh=1 through", () => {
    const plugin = readFileSync(join(import.meta.dir, "workspace/plugin.ts"), "utf8");
    expect(plugin).toContain('.get("fresh") === "1"');
    expect(plugin).toContain("workspace.panel(ROUTES[route], { fresh })");
  });

  test("Refresh/Retry ask the server for a fresh read once; background refetches don't", async () => {
    expect(panelUrl("pipeline")).toBe("/__workspace/pipeline");
    await refreshPanels(new QueryClient(), ["pipeline", "needsYou"]);
    expect(panelUrl("pipeline")).toBe("/__workspace/pipeline?fresh=1");
    expect(panelUrl("pipeline")).toBe("/__workspace/pipeline"); // consumed
    expect(panelUrl("needsYou")).toBe("/__workspace/needs-you?fresh=1");
    await refreshPanels(new QueryClient());
    expect(panelUrl("email")).toBe("/__workspace/email?fresh=1");
    const today = readFileSync(join(import.meta.dir, "../src/components/shell/pages/today-page.tsx"), "utf8");
    expect(today).toContain("refreshPanels(client)");
    expect(today).not.toContain('invalidateQueries({ queryKey: ["workspace"] })');
  });
});

describe("/work marks a stale read as stale", () => {
  const ok = { ok: true as const, data: {}, updatedAt: at(3 * 3_600_000), ms: 10 };
  test("freshness line", () => {
    expect(panelFreshness(ok, ok.updatedAt, NOW, false, false)).toBe("Updated 3 h ago");
    const stale = { ...ok, stale: { error: "Timed out after 9 s", timedOut: true, failedAt: at() } };
    expect(panelFreshness(stale, stale.updatedAt, NOW, false, false)).toBe("Stale · last good read 3 h ago");
    expect(panelFreshness(stale, stale.updatedAt, NOW, true, false)).toBe("Refreshing…");
  });
  test("the card shows the stale notice with the failure", () => {
    const shell = readFileSync(join(import.meta.dir, "../src/components/workspace/panel-shell.tsx"), "utf8");
    expect(shell).toContain('title="Stale: showing the last good read"');
    expect(shell).toContain("result.stale.error");
  });
});

describe("System tools tile: unknown is never green", () => {
  const caps = (statuses: string[]): Capabilities =>
    ({ generatedAt: at(), capabilities: statuses.map((status, i) => ({ id: `t${i}`, name: `Tool ${i}`, status })) }) as unknown as Capabilities;
  test("all known and fine: zero, green", () => {
    expect(toolsTile(caps(["working", "available"]), null)).toEqual({ value: 0, tone: "success", state: "zero" });
  });
  test("an unknown status with nothing else: a floor, neutral, not zero", () => {
    expect(toolsTile(caps(["working", "mystery"]), null)).toEqual({ value: "0+", tone: undefined, state: "ok" });
  });
  test("unknown alongside setup: a floor with the warn tone", () => {
    expect(toolsTile(caps(["setup-required", "mystery"]), null)).toEqual({ value: "1+", tone: "warn", state: "ok" });
  });
  test("failed, not built, not loaded", () => {
    expect(toolsTile(undefined, new Error("x")).state).toBe("failed");
    expect(toolsTile({ generatedAt: null, capabilities: [] } as unknown as Capabilities, null).state).toBe("unknown");
    expect(toolsTile(undefined, null).state).toBeUndefined();
  });
});

describe("Sidebar badge: zero and unknown differ", () => {
  const email = {
    ok: true as const,
    data: { connected: true as const, sources: [], window: { hours: 24, total: 0, urgent: 0, today: 0, fyi: 0, ignore: 0 }, lastTriagedAt: null, needsReplyCount: 0, needsReply: [] },
    updatedAt: at(),
    ms: 1,
  };
  const today = (ids: string[]) => ({ ok: true as const, data: { approvals: ids.map((id) => ({ id })), derivedError: null }, updatedAt: at(), ms: 1 });
  const panel = (ids: string[], agentOk = true) =>
    needsYouFrom({ today: today(ids), email, agent: agentOk ? { ok: true, count: 0, at: at() } : { ok: false, error: "down" } });
  test("loading: nothing yet", () => {
    expect(sidebarBadge({ loading: true, failed: false, panel: null })).toBeNull();
  });
  test("complete zero: no badge (nothing needs you)", () => {
    expect(sidebarBadge({ loading: false, failed: false, panel: panel([]) })).toBeNull();
  });
  test("read failed: a muted '?' that says unknown", () => {
    expect(sidebarBadge({ loading: false, failed: true, panel: null })).toMatchObject({ text: "?", unknown: true });
  });
  test("known parts zero, others unknown ('0+'): '?' not zero", () => {
    const b = sidebarBadge({ loading: false, failed: false, panel: panel([], false) });
    expect(b).toMatchObject({ text: "?", unknown: true });
    expect(b!.label).toContain("agent approvals unknown");
  });
  test("a count, and a lower bound, show as counts", () => {
    expect(sidebarBadge({ loading: false, failed: false, panel: panel(["a", "b"]) })).toMatchObject({ text: "2", unknown: false });
    expect(sidebarBadge({ loading: false, failed: false, panel: panel(["a"], false) })).toMatchObject({ text: "1+", unknown: false });
  });
  test("the sidebar styles the unknown badge differently", () => {
    const css = readFileSync(join(import.meta.dir, "../src/components/shell/shell.css"), "utf8");
    expect(css).toContain(".sh-dest-link b[data-unknown]");
    expect(readFileSync(join(import.meta.dir, "../src/components/app-sidebar.tsx"), "utf8")).toContain("data-unknown={view?.unknown || undefined}");
  });
});

describe("A stale needs-you part makes the total a floor", () => {
  const today = (ids: string[], stale = false) => ({
    ok: true as const,
    data: { approvals: ids.map((id) => ({ id })), derivedError: null },
    updatedAt: at(),
    ms: 1,
    ...(stale ? { stale: { error: "Timed out", timedOut: true, failedAt: at() } } : {}),
  });
  const email = (stale = false) => ({
    ok: true as const,
    data: { connected: true as const, sources: [], window: { hours: 24, total: 3, urgent: 0, today: 0, fyi: 0, ignore: 0 }, lastTriagedAt: null, mailboxes: null, needsReplyCount: 3, needsReply: [] },
    updatedAt: at(),
    ms: 1,
    ...(stale ? { stale: { error: "Timed out after 9 s", timedOut: true, failedAt: at() } } : {}),
  });
  const agent = { ok: true as const, count: 1, at: at() };
  test("all current: exact", () => {
    const p = needsYouFrom({ today: today(["a", "b"]), email: email(), agent });
    expect(p.complete).toBe(true);
    expect(needsYouBadge(p)).toBe("6");
  });
  test("stale email: '6+', and the breakdown says which part is stale", () => {
    const p = needsYouFrom({ today: today(["a", "b"]), email: email(true), agent });
    expect(p.complete).toBe(false);
    expect(needsYouBadge(p)).toBe("6+");
    expect(needsYouBreakdown(p)).toContain("3 emails (stale)");
  });
  test("stale decisions: a floor too", () => {
    expect(needsYouBadge(needsYouFrom({ today: today(["a"], true), email: email(), agent }))).toBe("5+");
  });
});

describe("Email stale-while-revalidate, finished", () => {
  function workspace() {
    let clock = NOW;
    let triageReads = 0;
    let mode: "ok" | "slow" | "fail" = "ok";
    let release: (() => void) | null = null;
    const ws = createWorkspace({
      get: async (path: string) => {
        if (path === "/__operator/inbox/triage") {
          triageReads++;
          if (mode === "fail") throw new Error("native discovery timed out");
          if (mode === "slow") await new Promise<void>((r) => (release = r));
          return { rows: [], digest: { hours: 24, total: triageReads }, counts: { lastLoggedAt: at(20 * 60_000) } };
        }
        if (path === "/__operator/connections") return { accounts: [{ id: "google", connected: true }] };
        if (path === "/__operator/native-connections") return { providers: [], discovery: { checkedAt: at(5 * 60_000), refreshing: false, error: null } };
        throw new Error(path);
      },
      approvalsFile: join(root, "none.json"),
      sites: { check: async () => ({}) as never },
      now: () => clock,
    });
    return { ws, reads: () => triageReads, tick: (ms: number) => (clock += ms), set: (m: typeof mode) => (mode = m), release: () => release?.() };
  }

  test("a slow refresh serves the last good read at once, marked refreshing; the next read has the fresh data", async () => {
    const w = workspace();
    const first = await w.ws.panel("email");
    if (!first.ok || !first.data.connected) throw new Error("email");
    w.tick(FRESH_REUSE_MS + 1);
    w.set("slow");
    const t0 = performance.now();
    const served = await w.ws.panel("email");
    expect(performance.now() - t0).toBeLessThan(SWR_WAIT_MS + 1_000);
    if (!served.ok || !served.data.connected) throw new Error("email");
    expect(served.refreshing).toBe(true);
    expect(served.updatedAt).toBe(first.updatedAt); // the real read time, not now
    expect(served.stale).toBeUndefined();
    w.release();
    await new Promise((r) => setTimeout(r, 20));
    w.set("ok");
    const next = await w.ws.panel("email");
    if (!next.ok || !next.data.connected) throw new Error("email");
    expect(next.data.window.total).toBe(2); // the background read, reused
    expect(next.refreshing).toBeUndefined();
    expect(w.reads()).toBe(2);
  });

  test("a failed background refresh isn't swallowed: the next answer says stale, with the failure", async () => {
    const w = workspace();
    await w.ws.panel("email");
    w.tick(FRESH_REUSE_MS + 1);
    w.set("fail");
    const failed = await w.ws.panel("email");
    if (!failed.ok) throw new Error("expected last good");
    expect(failed.stale?.error).toContain("triage log");
    // while the next attempt is still running, the served last-good read keeps the earlier failure
    w.set("slow");
    const again = await w.ws.panel("email");
    if (!again.ok) throw new Error("expected last good");
    expect(again.refreshing).toBe(true);
    expect(again.stale?.error).toContain("triage log");
    w.release();
  });

  test("the mailbox list's check time, re-check and failure travel to the panel", () => {
    const p = projectEmail({ triage: { rows: [], counts: { lastLoggedAt: at(3_600_000) } }, accounts: { accounts: [{ id: "google", connected: true }] }, native: { providers: [], discovery: { checkedAt: at(600_000), refreshing: true, error: "Codex sign-in expired" } } });
    if (!p.connected) throw new Error("email");
    expect(p.mailboxes).toEqual({ checkedAt: at(600_000), refreshing: true, error: "Codex sign-in expired" });
    expect(p.lastTriagedAt).toBe(at(3_600_000));
  });

  test("native mailbox discovery reports its check time, a running check and a failed one (checks are explicit, T8b)", async () => {
    let calls = 0;
    let fail = false;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const connectedRead = async (_root: string, work: (client: unknown) => unknown) => {
      calls++;
      await gate;
      if (fail) throw new Error("Codex connector unavailable");
      return work({ tools: {} });
    };
    type S = { discovery: { checkedAt: string | null; refreshing: boolean; error: string | null } };
    const api = nativeInboxSync(join(root, "native"), { load: () => ({}) as never, save: () => {}, archive: {} as never, connectedRead: connectedRead as never });
    const cold = (await api.status()) as S;
    expect(cold.discovery.checkedAt).toBeNull(); // not checked yet, and the read didn't start one
    expect(calls).toBe(0);
    const first = (await api.check()) as S;
    expect(first.discovery.checkedAt).not.toBeNull();
    expect(first.discovery.error).toBeNull();
    gate = new Promise<void>((r) => (release = r));
    fail = true;
    const running = api.check();
    const during = (await api.status()) as S;
    expect(during.discovery.refreshing).toBe(true); // the last answer is served while a check runs
    expect(during.discovery.checkedAt).toBe(first.discovery.checkedAt);
    release();
    const after = (await running) as S & { error?: string };
    expect(after.error).toBe("Codex connector unavailable");
    expect(((await api.status()) as S).discovery.error).toBe("Codex connector unavailable");
    expect(calls).toBe(2); // only the two explicit checks ever reached Codex
  });

  test("the Today email tile says when mail was last triaged and whether it's refreshing", () => {
    const panel = projectEmail({ triage: { rows: [], digest: { hours: 24, total: 9 }, counts: { lastLoggedAt: at(20 * 60_000) } }, accounts: { accounts: [{ id: "google", connected: true }] }, native: null });
    if (!panel.connected) throw new Error("email");
    const base = { ok: true as const, data: panel, updatedAt: at(), ms: 5 };
    expect(emailHint(base, panel, NOW)).toBe("Threads · 9 emails in 24 h · last email triaged 20 min ago");
    expect(emailHint({ ...base, refreshing: true }, panel, NOW)).toMatch(/^Refreshing · /);
    expect(emailHint({ ...base, stale: { error: "x", timedOut: true, failedAt: at() } }, panel, NOW)).toMatch(/^Last good read; refresh failed · /);
    expect(emailHint(base, { ...panel, lastTriagedAt: null, mailboxes: { checkedAt: null, refreshing: false, error: "down" } }, NOW)).toContain("nothing triaged yet · mailbox re-check failed");
  });

  test("/work cards say 'refreshing' for a last good read served while re-reading", () => {
    const ok = { ok: true as const, data: {}, updatedAt: at(2 * 60_000), ms: 10, refreshing: true };
    expect(panelFreshness(ok, ok.updatedAt, NOW, false, false)).toBe("Updated 2 min ago · refreshing");
  });
});
