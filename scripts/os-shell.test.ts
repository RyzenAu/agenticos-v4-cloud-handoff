// OS shell (27 Sep 2026): the eight destinations cover every route, old URLs still resolve, the
// Jarvis progress contract rejects malformed events, and the economics workbench starts from the
// catalogue. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DESTINATIONS, REDIRECTS, drilldownHref, locate, visibleDrilldowns } from "../src/components/shell/destinations";
import { parseProgress, progressFromFeed, LINGER_MS } from "../src/components/shell/jarvis-progress";
import { EconomicsWorkbench } from "../src/components/business/economics-workbench";
import { FEED_STATUS_LABEL, addStep, endTask, feedStatus, maskGoal, maskLine, readFeed, resetFeed, startTask, type FeedTask } from "../src/lib/agent-feed";
import { inspectorEntryKey, mergeInspectorEntry, type InspectorEntry } from "../src/components/shell/inspector";
import { SignalTile } from "../src/components/shell/page-parts";
import { capabilitiesPendingText, fmtDuration, restartTile } from "../src/components/shell/system-facts";
import { tileState, todayFacts, todayTiles, uniqueBy } from "../src/components/shell/today-facts";
import { needsYouFrom } from "./workspace/needs-you";

const ROUTES = join(import.meta.dir, "..", "src", "routes");

/** Every route path declared by a file in src/routes (createFileRoute("...")). */
function routePaths(): { file: string; path: string }[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith(".tsx") && f !== "__root.tsx")
    .map((file) => {
      const m = /createFileRoute\("([^"]+)"\)/.exec(readFileSync(join(ROUTES, file), "utf8"));
      return { file, path: m ? m[1].replace(/\/memory_\//, "/memory/").replace(/\$[a-z]+/i, "sample").replace(/\/$/, "") || "/" : "" };
    })
    .filter((r) => r.path);
}

describe("destinations", () => {
  test("nine destinations in the owner's order (R12: Departments after Jarvis); Memory, Studio and System fold under More", () => {
    expect(DESTINATIONS.map((d) => d.label)).toEqual(["Home", "Jarvis", "Departments", "Receptionist", "Work", "Memory", "Finance", "Studio", "System"]);
    expect(DESTINATIONS.filter((d) => d.more).map((d) => d.label)).toEqual(["Memory", "Studio", "System"]);
    expect(locate("/departments/research")?.destination.id).toBe("departments");
  });

  test("every routable page has exactly one home", () => {
    const homeless = routePaths().filter((r) => !locate(r.path));
    expect(homeless).toEqual([]);
  });

  test("no page is listed under two destinations", () => {
    const hrefs = DESTINATIONS.flatMap((d) => [d.to, ...d.drilldowns.map(drilldownHref)]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("landing routes exist as route files", () => {
    const paths = new Set(routePaths().map((r) => r.path));
    for (const d of DESTINATIONS) expect(paths.has(d.to)).toBe(true);
    for (const d of DESTINATIONS) for (const dd of d.drilldowns) expect(paths.has(dd.to)).toBe(true);
  });

  test("old URLs resolve to the right destination and drilldown", () => {
    const where = (path: string, view?: string) => {
      const r = locate(path, view);
      return r ? `${r.destination.id}${r.drilldown ? `>${r.drilldown.label}` : ""}` : null;
    };
    expect(where("/")).toBe("today"); // the Home destination keeps the id "today"
    expect(where("/workspace")).toBe("today");
    expect(where("/inbox")).toBe("today>Inbox");
    expect(where("/business")).toBe("today"); // Home is the Business brief (29 Sep 2026)
    expect(where("/today")).toBe("today");
    expect(where("/business", "finance")).toBe("finance>Finances");
    expect(where("/business", "progress")).toBe("work>Goals");
    expect(where("/workspaces/abc")).toBe("work>Workspaces");
    expect(where("/workspaces/receptionist")).toBe("work>Workspaces");
    expect(where("/operations")).toBe("receptionist>Packages & economics");
    expect(where("/agents/hermes")).toBe("jarvis>Hermes");
    expect(where("/hud")).toBe("jarvis");
    expect(where("/memory/vault")).toBe("memory>Vault");
    expect(where("/setup")).toBe("system");
    expect(where("/no-such-page")).toBeNull();
  });

  test("/, /today and /workspace redirect to Home (the Business brief)", () => {
    for (const file of ["index.tsx", "today.tsx", "workspace.tsx"]) {
      const src = readFileSync(join(ROUTES, file), "utf8");
      expect(src).toContain("redirect(");
      expect(src).toContain('to: "/business"');
    }
    // /today keeps its search, so ?scene=1 (the Command scene) still opens.
    expect(readFileSync(join(ROUTES, "today.tsx"), "utf8")).toContain("search: location.search");
    expect(REDIRECTS).toMatchObject({ "/": "/business", "/today": "/business", "/workspace": "/business" });
  });

  test("settings-gated pages follow their toggles", () => {
    // OpenClaw lives under System (connections) since 29 Sep 2026, still behind its toggle.
    const system = DESTINATIONS.find((d) => d.id === "system")!;
    const jarvis = DESTINATIONS.find((d) => d.id === "jarvis")!;
    expect(visibleDrilldowns(system, {}).some((d) => d.label === "OpenClaw")).toBe(false);
    expect(visibleDrilldowns(system, { openclaw: true }).some((d) => d.label === "OpenClaw")).toBe(true);
    expect(visibleDrilldowns(jarvis, { openclaw: true }).some((d) => d.label === "OpenClaw")).toBe(false);
    expect(locate("/agents/openclaw")?.destination.id).toBe("system");
  });
});

describe("Jarvis progress contract", () => {
  test("accepts a well-formed event and trims it", () => {
    const p = parseProgress({ phase: "acting", label: "  Opening   Chrome ", step: { index: 2, total: 5, text: "Clicking Sign in" }, source: "jev", at: 10 }, 99);
    expect(p).toEqual({ phase: "acting", label: "Opening Chrome", step: { index: 2, total: 5, text: "Clicking Sign in" }, startedAt: undefined, taskId: undefined, source: "jev", at: 10 });
  });
  test("rejects unknown phases and non-objects", () => {
    expect(parseProgress({ phase: "hacking", label: "x" })).toBeNull();
    expect(parseProgress("acting")).toBeNull();
    expect(parseProgress(null)).toBeNull();
  });
  test("fills a missing label and caps long text", () => {
    expect(parseProgress({ phase: "needs-you" }, 1)!.label).toBe("Needs your yes");
    expect(parseProgress({ phase: "acting", label: "word ".repeat(100) }, 1)!.label.length).toBe(60);
  });
  test("derives progress from the agent feed, then lets a finished task fade", () => {
    const task: FeedTask = { id: "t1", kind: "hermes", title: "Book a demo slot", agent: "Hermes", startedAt: 1000, steps: [{ at: new Date(2000).toISOString(), kind: "tool", text: "Opened calendar" }] };
    expect(progressFromFeed([task], 3000)).toMatchObject({ phase: "acting", label: "Book a demo slot", step: { index: 1, text: "Opened calendar" }, source: "agent-feed" });
    const done = { ...task, endedAt: 5000, ok: true };
    expect(progressFromFeed([done], 6000)?.phase).toBe("done");
    expect(progressFromFeed([done], 5000 + LINGER_MS + 1)).toBeNull();
    expect(progressFromFeed([], 1)).toBeNull();
  });
});

describe("economics workbench", () => {
  test("starts on Essential at A$699 ex GST, with no old price or GST-inclusive label", () => {
    const html = renderToStaticMarkup(createElement(EconomicsWorkbench));
    expect(html).toContain('value="699"');
    expect(html).toContain("Monthly price (A$, ex GST)");
    expect(html).not.toContain("GST-inclusive");
    expect(html).not.toContain("549");
    expect(html).not.toContain("Explore proposed");
    expect(html).toContain("Essential");
  });
});

describe("mount points", () => {
  test("each documented mount file is the one the shell globs", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "components", "shell", "mounts.tsx"), "utf8");
    for (const [area, dir] of [["receptionist", "receptionist"], ["finance", "finance"], ["memory", "memory"], ["devices", "profile"]]) {
      expect(src).toContain(`${area}: import.meta.glob<MountModule>("../${dir}/destination.tsx")`);
      expect(src).toContain(`file: "src/components/${dir}/destination.tsx"`);
    }
  });
});

// ── Wave-2 Stage A (27 Sep 2026): Today counts once, tiles tell zero / unknown / stale / failed
// apart, the Inspector dedupes, System shows measured timings, the chip says "Needs your yes". ──
describe("Today facts: one place per fact, keyed by stable id", () => {
  const NOW = Date.parse("2026-09-27T10:00:00Z");
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const ok = <T,>(data: T, msAgo = 60_000) => ({ data: { ok: true as const, data, updatedAt: at(msAgo), ms: 12 } });
  const failedSource = (msAgo = 60_000) => ({ data: { ok: false as const, error: "approvals.json unreadable", timedOut: false, updatedAt: at(msAgo), ms: 30 } });
  const approval = (id: string) => ({ id, title: `Decide ${id}`, area: "receptionist", detail: "Synthetic", href: "/receptionist", since: null, source: "test" }) as never;
  const lead = (id: number, overdue: boolean) => ({ id, name: `Lead ${id}`, vertical: null, area: null, status: "new", score: null, nextAt: null, nextAction: null, callback: false, overdue, phone: null });
  const today = (approvals: string[]) => ok({ now: at(0), callingWindow: {} as never, approvals: approvals.map(approval), approvalsErrors: [], derivedError: null });
  // UI-truth H1: "Waiting on you" is the server's one needs-you count (decisions + email threads + agent approvals).
  const inbox = (needsReplyCount: number) => ({ ok: true as const, data: { connected: true as const, sources: [], window: { hours: 24, total: needsReplyCount, urgent: 0, today: 0, fyi: 0, ignore: 0 }, lastTriagedAt: null, needsReplyCount, needsReply: [] }, updatedAt: at(0), ms: 5 });
  const needs = (approvals: string[], msAgo = 60_000, emails = 0) => ok(needsYouFrom({ today: today(approvals).data, email: inbox(emails), agent: { ok: true, count: 0, at: at(0) } }), msAgo);

  test("a duplicated approval and a duplicated overdue lead each count once", () => {
    const src = { today: today(["a1", "a2", "a1"]), needsYou: needs(["a1", "a2", "a1"]), callQueue: ok({ total: 3, items: [lead(7, true), lead(7, true), lead(9, false)] }) };
    const facts = todayFacts(src);
    expect(facts.approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(facts.overdueCallIds).toEqual([7]);
    const tiles = todayTiles(src, facts, NOW);
    expect(tiles.find((t) => t.key === "needsYou")).toMatchObject({ value: "2", state: "ok", tone: "warn" });
    expect(tiles.find((t) => t.key === "callQueue")!.hint).toBe("1 overdue");
  });

  test("overdue calls live on the calls tile only; overdue follow-ups never join the exception list", () => {
    const pipeline = ok({ stages: [], total: 5, closed: 0, demosBooked: 0, upcomingMeetings: [], followUps: { overdue: 4, dueToday: 1 }, proposals: { count: null, valueCents: null }, newLeads7d: 0, stuck: 0 });
    const callQueue = ok({ total: 12, items: [lead(1, true), lead(2, true)] });
    const facts = todayFacts({ callQueue, pipeline });
    const text = facts.exceptions.map((e) => String(e.text)).join(" | ");
    expect(text).not.toMatch(/overdue in the queue|follow-up/i);
    expect(facts.overdueCallsAtLeast).toBe(true);
    expect(todayTiles({ callQueue }, facts, NOW).find((t) => t.key === "callQueue")!.hint).toBe("2+ overdue");
  });

  test("failed approvals show once: a failed tile with a retry, never success, never an exception row", () => {
    const src = { today: failedSource(), needsYou: failedSource() };
    const facts = todayFacts(src);
    expect(facts.failed).toEqual(["needsYou", "today"]);
    expect(facts.approvals).toEqual([]);
    expect(facts.exceptions).toEqual([]);
    const tile = todayTiles(src, facts, NOW).find((t) => t.key === "needsYou")!;
    expect(tile).toMatchObject({ state: "failed", value: null, recovery: { kind: "retry" } });
    expect(tile.tone).not.toBe("success");
    const html = renderToStaticMarkup(
      createElement(SignalTile, { label: tile.label, value: tile.value, state: tile.state, tone: tile.tone, hint: tile.hint, updatedAt: tile.updatedAt, now: NOW, recovery: { label: "Retry", onClick: () => {} } }),
    );
    expect(html).toContain("Couldn&#x27;t read");
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-tone="success"');
  });

  test("a request that threw is failed too, not an empty zero", () => {
    expect(tileState({ isError: true }, NOW)).toBe("failed");
    expect(todayFacts({ email: { isError: true, errorUpdatedAt: NOW - 5_000 } }).failed).toEqual(["email"]);
    expect(tileState(undefined, NOW)).toBeUndefined();
  });

  test("tile states: zero, unknown (inbox not connected), stale and ok are distinct", () => {
    const zero = needs([]);
    expect(todayTiles({ needsYou: zero }, todayFacts({ needsYou: zero }), NOW)[0]).toMatchObject({ state: "zero", value: "0", tone: "success" });
    const email = ok({ connected: false as const, reason: "No inbox linked" });
    const emailTile = todayTiles({ email }, todayFacts({ email }), NOW).find((t) => t.key === "email")!;
    expect(emailTile).toMatchObject({ state: "unknown", value: null, hint: "Inbox not connected", recovery: { kind: "link", to: "/inbox" } });
    const old = needs(["a1"], 20 * 60_000);
    expect(todayTiles({ needsYou: old }, todayFacts({ needsYou: old }), NOW)[0].state).toBe("stale");
    expect(todayTiles({ needsYou: needs(["a1"]) }, todayFacts({ needsYou: needs(["a1"]) }), NOW)[0].state).toBe("ok");
    // every tile whose source answered carries a last-update time
    const all = { needsYou: needs([]), callQueue: ok({ total: 0, items: [] }), email };
    const answered = todayTiles(all, todayFacts(all), NOW).filter((t) => t.key in all);
    expect(answered).toHaveLength(3);
    for (const t of answered) expect(t.updatedAt).not.toBeNull();
  });

  test("stale never shows success colour; unknown shows no number", () => {
    const stale = renderToStaticMarkup(createElement(SignalTile, { label: "x", value: 0, state: "stale", tone: "success" }));
    expect(stale).not.toContain('data-tone="success"');
    const unknown = renderToStaticMarkup(createElement(SignalTile, { label: "x", value: 0, state: "unknown" }));
    expect(unknown).toContain("Unknown");
    expect(unknown).not.toContain(">0<");
  });

  test("exceptions are deduped by id (a site listed twice is one row)", () => {
    const site = { id: "marketing", name: "M&U Ventures", tone: "bad", ok: false, status: 503 };
    const websites = ok({ checkedAt: at(0), sites: [site, site], local: [], localNotRunning: [] } as never);
    const facts = todayFacts({ websites });
    expect(facts.exceptions.filter((e) => e.id === "site-marketing")).toHaveLength(1);
    expect(uniqueBy([{ id: 1 }, { id: 1 }, { id: 2 }], (x) => x.id)).toHaveLength(2);
  });
});

describe("Inspector dedupe", () => {
  const entry = (over: Partial<InspectorEntry>): InspectorEntry => ({ id: "i1", at: 1, title: "Approvals source failed", detail: "x (10 ms)", source: "Today", path: "/today", key: "", ...over });
  test("a keyed entry replaces its older copy instead of stacking (remounts, refetches)", () => {
    let list: InspectorEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const e = entry({ id: `i${i}`, at: i, detail: `x (${i} ms)` });
      list = mergeInspectorEntry(list, { ...e, key: inspectorEntryKey({ key: "today:source:today", title: e.title, detail: e.detail, source: e.source }) });
    }
    expect(list).toHaveLength(1);
    expect(list[0].detail).toBe("x (4 ms)");
  });
  test("unkeyed entries dedupe by source + title + detail; different facts both stay", () => {
    const k = (e: InspectorEntry) => ({ ...e, key: inspectorEntryKey(e) });
    let list = mergeInspectorEntry([], k(entry({ id: "a" })));
    list = mergeInspectorEntry(list, k(entry({ id: "b" })));
    list = mergeInspectorEntry(list, k(entry({ id: "c", title: "Email source failed" })));
    expect(list.map((e) => e.id)).toEqual(["c", "b"]);
  });
});

describe("System shows measured timings", () => {
  test("the restart tile says 'Saves automatically', not a raw quiet-window length (audit P2-8)", () => {
    expect(restartTile({ pending: false, waitingFor: [], requestedAt: null, restartsAfter: null, quietMs: 2_500 }, null).hint).toBe("Saves automatically");
    expect(restartTile({ pending: false, waitingFor: [], requestedAt: null, restartsAfter: null }, null).hint).toBe("Saves automatically");
    expect(restartTile({ pending: true, waitingFor: ["1 chat turn running"], requestedAt: 1, restartsAfter: null, quietMs: 4_000 }, null)).toMatchObject({ value: "Waiting", hint: "Held for 1 chat turn running" });
    expect(restartTile(undefined, new Error("Local access only"))).toMatchObject({ value: null, failed: true });
    expect(fmtDuration(4_000)).toBe("4 s");
    expect(fmtDuration(600_000)).toBe("10 min");
  });
  test("the tool-check line never invents a start-up delay", () => {
    const pending = { generatedAt: null, capabilities: [], note: "Registry not built yet; it builds 20 s after start-up." };
    expect(capabilitiesPendingText(pending, null)).not.toMatch(/\d+ s\b/);
    expect(capabilitiesPendingText({ ...pending, firstBuildAfterMs: 15_000 }, null)).toContain("15 s after start-up");
    expect(capabilitiesPendingText({ ...pending, firstBuildAfterMs: null }, null)).toContain("Background jobs are off");
  });
  test("the System page has no hard-coded 4 s or 20 s", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "components", "shell", "pages", "system-page.tsx"), "utf8");
    expect(src).not.toMatch(/\b(?:4|20) s\b/);
  });
});

describe("Jarvis chip: needs your yes, masked like the run log", () => {
  (globalThis as { window?: EventTarget }).window ??= new EventTarget();
  const base: FeedTask = { id: "s1", kind: "screen", title: "Send the invoice", agent: "Screen hands", startedAt: 1000, steps: [] };

  test("a screen run stopped for confirmation is needs-you, never done", () => {
    const waiting: FeedTask = { ...base, endedAt: 5000, ok: false, needsYou: { what: "Send", until: 5000 + 120_000 } };
    const p = progressFromFeed([waiting], 6000)!;
    expect(p.phase).toBe("needs-you");
    expect(p.label).toBe("Needs your yes");
    expect(feedStatus(waiting)).toBe("needs-you");
    expect(FEED_STATUS_LABEL[feedStatus(waiting)]).toBe("Needs your yes");
    // still asking past the normal linger, until the confirm window closes; then gone, not "done"
    expect(progressFromFeed([waiting], 5000 + LINGER_MS + 1)?.phase).toBe("needs-you");
    expect(progressFromFeed([waiting], 5000 + 120_001)).toBeNull();
    // even a task marked ok can't turn a waiting run into done
    expect(progressFromFeed([{ ...waiting, ok: true }], 6000)?.phase).toBe("needs-you");
  });

  test("endTask records the marker and never stores a waiting run as ok", () => {
    resetFeed();
    const id = startTask({ kind: "screen", title: "click Send", agent: "Screen hands" });
    endTask(id, { ok: true, needsYou: { what: "Send", until: Date.now() + 60_000 }, result: "Waiting for your yes" });
    const t = readFeed()[0];
    expect(t.ok).toBe(false);
    expect(t.needsYou?.what).toBe("Send");
    expect(progressFromFeed(readFeed(), Date.now())?.phase).toBe("needs-you");
    resetFeed();
  });

  test("the voice companion's confirm hunk marks the run as needing a yes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "components", "operator", "voice-companion.tsx"), "utf8");
    expect(src).toContain("needsYou: { what: done.confirm, until: Date.now() + CONFIRM_TTL_MS }");
    expect(src).not.toMatch(/feedOutcome = \{ ok: true, result: `Waiting for your yes/);
  });

  test("dictated text, files, e-mail addresses and long numbers are masked in titles and the chip", () => {
    expect(maskGoal("type see you at 3pm, Jane into the message box then press enter")).toBe("type ⟨text 1⟩ into the message box then press enter");
    expect(maskGoal("fill in the email field with jane.doe@example.com")).toBe("fill in the email field with ⟨text 1⟩");
    expect(maskGoal("save it as D:\\tmp\\plans.txt")).toBe("save it as ⟨file 1⟩");
    // a web address is not a file path: the "s:/" of "https://" is not a drive letter
    expect(maskGoal("audit https://dental-care-plus.muventures.com.au (running)")).toBe("audit https://dental-care-plus.muventures.com.au (running)");
    // a goal reaches the chip without redactText in some callers: secrets in a web address never show
    for (const q of ["token=abc123def456", "key=abc123def456", "code=abc123def456", "sig=abc123def456", "access_token=abc123def456&x=1"]) {
      const shown = maskGoal(`open https://x.example/reset?${q}`);
      expect(shown).toBe("open https://x.example/reset");
      expect(shown).not.toContain("abc123def456");
    }
    expect(maskGoal("open https://x.example/a#access_token=abc123def456 now")).toBe("open https://x.example/a now");
    expect(maskGoal("run with API_KEY=sk-abcdefgh12345678 please")).not.toContain("abcdefgh12345678");
    expect(maskGoal('call 0412 345 678 and write "meet me at the station" here')).toBe("call [number] and write ⟨text 1⟩ here");
    expect(maskGoal("open the Settings app on 2026-09-27")).toBe("open the Settings app on 2026-09-27");
    expect(maskLine("mail jane@example.com re 4111 1111 1111 1111")).toBe("mail [email] re [number]");

    resetFeed();
    const id = startTask({ kind: "screen", title: "type my PIN 99887766 into the box", agent: "Screen hands" });
    expect(readFeed().find((t) => t.id === id)!.title).not.toContain("99887766");
    addStep(id, { kind: "tool", text: "Typed into jane@example.com" });
    expect(readFeed()[0].steps[0].text).toBe("Typed into [email]");
    resetFeed();

    // the chip masks even a raw title that reached the feed some other way
    const raw: FeedTask = { ...base, title: "write I owe Sam 250 dollars into the note field" };
    const p = progressFromFeed([raw], 2000)!;
    expect(p.label).not.toContain("owe Sam");
    expect(p.label).toContain("⟨text 1⟩");
    expect(parseProgress({ phase: "acting", label: "type hunter2 password here" }, 1)!.label).not.toContain("hunter2");
  });
});
