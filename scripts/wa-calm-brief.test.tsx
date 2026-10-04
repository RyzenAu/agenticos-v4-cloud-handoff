// W-A (29 Sep 2026): calm Today / Mission Control, and the Business brief and Goals wired to the
// owner's own data. All fixtures are SYNTHETIC; nothing here reads the real wiki, ledger or CRM.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { parseClient, parseGoals, parseRevenueTarget, readWikiFacts, wikiFactsFrom } from "./business-wiki-facts";
import { deriveBrief, type BriefInputs, type NabSummary } from "../src/lib/business-facts";
import { goalTheme, orderGoals, stepsFor, themeOfWikiGoal } from "../src/components/business/north-star-goals";
import { currentGoalPeriod } from "../src/lib/goal-periods";
import { focusLine } from "../src/components/shell/today-facts";
import { CalmSection, InCalmSection } from "../src/components/calm/calm";

const SRC = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const source = { page: "wiki/x.md", updated: "2026-09-22" };

const GOALS_MD = `---
title: Shared Goals
updated: 2026-09-22
---

# Shared Goals

- **Strengthen the Quran.** SYNTHETIC: revision, not learning.
- **Grow [[mu-ventures]] to $100k/month**, in shā' Allāh.
- **Become closest to Allah.**
- **Marry.**

Plain paragraph with $5/month that is not a goal bullet.
`;

const CLIENT_MD = `---
title: Synthetic Harbour Realty
updated: 2026-09-24
---

# Synthetic Harbour Realty

**M&U Ventures' first paying client.** A SYNTHETIC agency.
Phone 0491 570 006, email office@harbour.example.test, 1 Example Street, Testville NSW 2000.

## The deal
A website build, signed agreement dated **17 Sep 2026**. **A$1,650 incl. GST total**: a 50%
deposit (**A$825, paid 22 Sep 2026**, invoice ref SYN1) and A$825 due at approved launch.
A care plan of $110/month starts at launch. Target launch is **~13 Oct 2026**.
Contact: 0491 570 006.

## Related
- nothing
`;

describe("wiki facts (allow-listed, contact-free)", () => {
  test("goals: one per bold bullet, plain text, classed business / deen / personal", () => {
    const goals = parseGoals(GOALS_MD, source);
    expect(goals.map((g) => g.title)).toEqual(["Strengthen the Quran", "Grow M&U Ventures to $100k/month", "Become closest to Allah", "Marry"]);
    expect(goals.map((g) => g.kind)).toEqual(["deen", "business", "deen", "personal"]);
    expect(goals[0].detail).toBe("SYNTHETIC: revision, not learning.");
  });
  test("the monthly target is read as written, never guessed", () => {
    expect(parseRevenueTarget(GOALS_MD, source)).toEqual({ monthly: 100_000, text: "A$100k/month", source });
    expect(parseRevenueTarget("# Nothing here", source)).toBeNull();
  });
  test("a client's deal figures are parsed; contact lines never leave the server", () => {
    const c = parseClient("synthetic-harbour-realty", CLIENT_MD, source);
    expect(c.name).toBe("Synthetic Harbour Realty");
    expect(c.summary).toBe("M&U Ventures' first paying client");
    expect(c.deal).toEqual({ totalAud: 1650, depositAud: 825, depositPaidOn: "22 Sep 2026", balanceAud: 825, carePlanMonthlyAud: 110, targetLaunch: "13 Oct 2026", signedOn: "17 Sep 2026" });
    const json = JSON.stringify(c);
    expect(json).not.toContain("0491");
    expect(json).not.toContain("@");
    expect(json).not.toContain("Example Street");
  });
  test("a deal the page doesn't state stays null", () => {
    const c = parseClient("x", "---\ntitle: X\n---\n\n# X\n\nNo deal yet.\n", source);
    expect(c.deal).toEqual({ totalAud: null, depositAud: null, depositPaidOn: null, balanceAud: null, carePlanMonthlyAud: null, targetLaunch: null, signedOn: null });
  });

  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  test("reads only the allow-listed pages and linked client slugs from a vault on disk", () => {
    dir = mkdtempSync(join(tmpdir(), "wa-wiki-"));
    const w = join(dir, "wiki");
    for (const d of ["topics/personal", "topics/business", "entities"]) mkdirSync(join(w, d), { recursive: true });
    writeFileSync(join(w, "topics/personal/shared-goals.md"), GOALS_MD);
    writeFileSync(join(w, "topics/business/clients.md"), "---\ntitle: Clients\n---\n\n## The pieces\n- [[synthetic-harbour-realty]] — agency\n- [[missing-client]]\n");
    writeFileSync(join(w, "entities/synthetic-harbour-realty.md"), CLIENT_MD);
    const facts = readWikiFacts(dir, new Date("2026-09-29T00:00:00Z"));
    expect(facts.found).toBe(true);
    expect(facts.vault).toBe(dir.split(/[\\/]/).pop());
    expect(facts.goals).toHaveLength(4);
    expect(facts.revenueTarget?.monthly).toBe(100_000);
    expect(facts.clients.map((c) => c.slug)).toEqual(["synthetic-harbour-realty"]);
    expect(facts.missing).toEqual(["wiki/entities/mu-ventures.md", "wiki/entities/missing-client.md"]);
    expect(facts.business).toBeNull();
  });
  test("no vault: found false, nothing read, nothing listed as missing", () => {
    const facts = readWikiFacts(join(tmpdir(), "wa-no-such-vault-xyz"));
    expect(facts.found).toBe(false);
    expect(facts.goals).toEqual([]);
    expect(facts.missing).toEqual([]);
  });
  test("the reader refuses anything outside wiki/topics and wiki/entities", () => {
    const asked: string[] = [];
    wikiFactsFrom((rel) => (asked.push(rel), null), "v", true);
    expect(asked.every((rel) => /^wiki\/(topics|entities)\//.test(rel))).toBe(true);
    expect(asked.some((rel) => /usman|mehroz|raw\//i.test(rel))).toBe(false);
  });
  test("the operator route serves it read-only", () => {
    expect(SRC("scripts/operator-plugin.ts")).toContain('method === "GET" && path === "/business/wiki-facts"');
  });
});

const nab = (over: Partial<NabSummary> = {}): NabSummary => ({
  period: { from: "2026-09-01", to: "2026-09-29", label: "This month" },
  asOf: "2026-09-26",
  sourceLabel: "NAB CSV imported, as of 26 Sep 2026",
  stale: false,
  periodCoverage: "partial",
  coverageNote: "Imported NAB data covers 1 Sep 2026 – 27 Sep 2026.",
  cashInCents: 90_000,
  rowCount: 24,
  byScope: { business: { inCents: 82_500, outCents: 20_000, count: 10 }, personal: { inCents: 0, outCents: 0, count: 0 }, unreviewed: { inCents: 7_500, outCents: 0, count: 1 } },
  ...over,
});
const wikiFacts = wikiFactsFrom(
  (rel) =>
    rel.endsWith("shared-goals.md")
      ? GOALS_MD
      : rel.endsWith("clients.md")
        ? "## The pieces\n- [[synthetic-harbour-realty]]\n"
        : rel.endsWith("synthetic-harbour-realty.md")
          ? CLIENT_MD
          : null,
  "synthetic",
  true,
);
const NOW = Date.parse("2026-09-29T01:00:00Z"); // 11 am Sydney
const base = (over: Partial<BriefInputs> = {}): BriefInputs => ({
  wiki: { data: wikiFacts },
  nabThisMonth: { data: nab() },
  nabLastMonth: { data: nab({ periodCoverage: "none", rowCount: 24 }) },
  stripe: { data: { configured: false, revenueThisMonthAud: 0, mrrAud: null, lastSyncedAt: null } },
  pipeline: {
    data: {
      ok: true,
      updatedAt: new Date(NOW).toISOString(),
      ms: 5,
      data: {
        stages: [{ stage: "contacted", count: 4 }, { stage: "proposal", count: 1 }, { stage: "won", count: 1 }, { stage: "building", count: 1 }],
        total: 20, open: 7, excluded: 1, merged: 0, lost: 2, closed: 2, demosBooked: 1, upcomingMeetings: [],
        followUps: { overdue: 0, dueToday: 1 }, proposals: { count: 1, valueCents: 150_000 }, newLeads7d: 3, stuck: 0, hunt: null,
      },
    } as never,
  },
  overview: { data: { sentence: "SYNTHETIC: 2 on today's call sheet.", callsToday: 2, tiles: { invoices: { count: 1, cents: 82_500, invoicedCount: 0, label: "1 payment due at launch", source: "receivables" }, builds: { active: 1, tasksDue: 0 } } } },
  receptionist: { loading: true },
  websites: { data: { sites: [{ id: "harbour", kind: "client", name: "Synthetic Harbour", url: "https://harbour.example.test", brief: { status: "Building", updated: null, previewDue: null, launchTarget: "13 Oct 2026", checklist: { done: 3, total: 9, next: "Listings admin" } } }], previews: [], templates: [], drafts: [] } as never },
  events: [
    { id: "e1", title: "SYNTHETIC call", start: "2026-09-29T03:00:00Z", end: "2026-09-29T03:30:00Z", allDay: false, notes: "", source: "local", actions: [] },
    { id: "e2", title: "Yesterday", start: "2026-09-27T03:00:00Z", end: "2026-09-27T03:30:00Z", allDay: false, notes: "", source: "local", actions: [] },
  ],
  profileTarget: null,
  now: NOW,
  ...over,
});

describe("deriveBrief: the owner's numbers from the owner's sources", () => {
  test("revenue towards the wiki target from business-marked NAB cash in", () => {
    const m = deriveBrief(base());
    expect(m.revenue.thisMonthCents).toBe(82_500);
    expect(m.revenue.unreviewedCents).toBe(7_500);
    expect(m.revenue.target).toBe(100_000);
    expect(m.revenue.targetSource).toBe("wiki");
    expect(m.revenue.ratio).toBeCloseTo(0.00825, 6);
    expect(m.revenue.basis).toContain("part of the month");
    expect(m.revenue.lastMonthCents).toBeNull(); // no coverage is unknown, never zero
    expect(m.revenue.empty).toBeNull();
  });
  test("a saved profile target wins over the wiki's", () => {
    const m = deriveBrief(base({ profileTarget: 20_000 }));
    expect(m.revenue.targetSource).toBe("profile");
    expect(m.revenue.ratio).toBeCloseTo(0.04125, 6);
  });
  test("Stripe revenue adds on (payouts are excluded from NAB cash in, so nothing counts twice)", () => {
    const m = deriveBrief(base({ stripe: { data: { configured: true, revenueThisMonthAud: 100, mrrAud: null, lastSyncedAt: null } } }));
    expect(m.revenue.thisMonthCents).toBe(92_500);
    expect(m.revenue.stripeCents).toBe(10_000);
  });
  test("no NAB import: unknown, with where it comes from and the one step", () => {
    const m = deriveBrief(base({ nabThisMonth: { data: nab({ rowCount: 0, periodCoverage: "none" }) } }));
    expect(m.revenue.thisMonthCents).toBeNull();
    expect(m.revenue.ratio).toBeNull();
    expect(m.revenue.empty?.step).toBe("Import a NAB CSV on Finance → Import");
    expect(m.sources.find((s) => s.id === "nab")?.state).toBe("setup-required");
  });
  test("an import that doesn't cover this month asks for this month's CSV", () => {
    const m = deriveBrief(base({ nabThisMonth: { data: nab({ periodCoverage: "none" }) } }));
    expect(m.revenue.thisMonthCents).toBeNull();
    expect(m.revenue.empty?.step).toBe("Import this month's NAB CSV on Finance → Import");
  });
  test("the owner-only ledger refusing a non-owner is said as such, not as zero", () => {
    const m = deriveBrief(base({ nabThisMonth: { error: "403 Forbidden" } }));
    expect(m.revenue.thisMonthCents).toBeNull();
    expect(m.revenue.empty?.why).toContain("only opens for the owner");
    expect(m.sources.find((s) => s.id === "nab")?.state).toBe("failed");
  });
  test("clients: the wiki's deal matched to its site; CRM clients from won-or-later stages", () => {
    const m = deriveBrief(base());
    expect(m.clients).toHaveLength(1);
    expect(m.clients[0].deal?.depositAud).toBe(825);
    expect(m.clients[0].site?.checklist).toEqual({ done: 3, total: 9, next: "Listings admin" });
    expect(m.crmClients).toBe(2);
    expect(m.owed).toEqual({ cents: 82_500, count: 1, label: "1 payment due at launch" });
    expect(m.pipeline).toEqual({ open: 7, proposals: 1, proposalsCents: 150_000, followUpsOverdue: 0, followUpsToday: 1, newLeads7d: 3, newLeads7dNote: null });
  });
  test("a failed CRM panel is unknown, not zero", () => {
    const m = deriveBrief(base({ pipeline: { data: { ok: false, error: "Timed out", timedOut: true, updatedAt: "", ms: 9000 } as never } }));
    expect(m.pipeline).toBeNull();
    expect(m.crmClients).toBeNull();
    expect(m.sources.find((s) => s.id === "pipeline")?.state).toBe("failed");
  });
  test("calendar counts today's events in Sydney", () => {
    const m = deriveBrief(base());
    expect(m.calendar?.today).toBe(1);
    expect(m.calendar?.next?.title).toBe("SYNTHETIC call");
  });
  test("no wiki: goals, target and clients say where they come from", () => {
    const m = deriveBrief(base({ wiki: { data: { ...wikiFacts, found: false, goals: [], clients: [], revenueTarget: null, business: null } } }));
    expect(m.revenue.target).toBeNull();
    expect(m.revenue.ratio).toBeNull();
    expect(m.sources.find((s) => s.id === "wiki")?.state).toBe("setup-required");
    expect(m.clients.map((c) => c.source)).toEqual(["Websites catalogue"]);
  });
});

describe("Goals: long-term goals, respectfully", () => {
  const g = (id: string, title: string, horizon: "week" | "month" | "quarter", status = "active") =>
    ({ id, title, horizon, status, notes: "", updatedAt: "2026-09-20T00:00:00Z", period: currentGoalPeriod(horizon, new Date("2026-09-29T01:00:00Z"), "Australia/Sydney") }) as never;
  test("themes from words", () => {
    expect(goalTheme("revise the Quran daily")).toBe("quran");
    expect(goalTheme("become closer to Allah")).toBe("allah");
    expect(goalTheme("thoughts about marriage")).toBe("marry");
    expect(goalTheme("hit 5k a month")).toBe("business");
    expect(goalTheme("tidy the garage")).toBeNull();
    expect(themeOfWikiGoal({ title: "Grow M&U Ventures to $100k/month", kind: "business" })).toBe("business");
  });
  test("a horizon goal with several clauses is a step for each goal it names; done and past goals aren't", () => {
    const goals = [g("m", "SYNTHETIC: hit 5k a month, and revise the Quran", "month"), g("w", "launch the site", "week"), g("d", "revise the Quran", "week", "done")];
    const now = new Date("2026-09-29T01:00:00Z");
    expect(stepsFor("quran", goals, now).map((x: { id: string }) => x.id)).toEqual(["m"]);
    expect(stepsFor("business", goals, now).map((x: { id: string }) => x.id)).toEqual(["m"]);
    expect(stepsFor("marry", goals, now)).toEqual([]);
  });
  test("the business goal leads; the rest keep the wiki's order", () => {
    expect(orderGoals(parseGoals(GOALS_MD, source)).map((x) => x.title)).toEqual(["Grow M&U Ventures to $100k/month", "Strengthen the Quran", "Become closest to Allah", "Marry"]);
  });
  test("deen and personal goals carry no progress numbers", () => {
    const page = SRC("src/components/business/north-star-goals.tsx");
    expect(page).toContain("held as a goal, not measured here");
    expect(page).toContain("RevenueRing"); // only the business goal gets a ring
    expect(page.match(/RevenueRing model=/g)).toHaveLength(1);
  });
});

describe("Today: the five-second focus line", () => {
  test("says what's waiting from the tiles' own numbers", () => {
    expect(focusLine({ needsYou: { value: "7+", state: "ok" }, callQueue: { value: 1, state: "ok" } }, 1, false).headline).toBe("7+ waiting on you, 1 call to make and 1 thing to look at.");
    expect(focusLine({ needsYou: { value: 0, state: "zero" }, callQueue: { value: 0, state: "zero" } }, 0, false).headline).toBe("You're clear for now.");
  });
  test("an unreadable source is never 'clear'", () => {
    const f = focusLine({ needsYou: { value: null, state: "failed" }, callQueue: { value: 0, state: "zero" } }, 0, false);
    expect(f.headline).toBe("Nothing waiting in the sources that answered.");
    expect(f.detail).toContain("couldn't be read");
  });
  test("still loading says so", () => {
    expect(focusLine({}, 0, true).headline).toBe("Checking what needs you…");
  });
  test("details fold away; honest states and sources stay on the page", () => {
    const page = SRC("src/components/shell/pages/today-page.tsx");
    expect(page).toContain('title="Where these numbers come from"');
    expect(page).toContain("Source: {PANEL_SOURCE[k]}");
    expect(page).toContain('title="Pipeline"');
  });
});

describe("CalmSection: folded, lazy, remembered", () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
  });
  const Heavy = () => <p id="heavy">heavy content</p>;
  test("collapsed by default: a named region, an aria-expanded button, and the body not mounted", () => {
    const out = renderToStaticMarkup(
      <CalmSection title="Model intelligence" summary="Which models lead">
        <Heavy />
      </CalmSection>,
    );
    expect(out).toContain('aria-label="Model intelligence"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("Which models lead");
    expect(out).not.toContain("heavy content");
  });
  test("opening mounts the body once, tells children they're folded, and remembers the choice", () => {
    const { document, window } = parseHTML("<!doctype html><html><body><div id=app></div></body></html>");
    const store = new Map<string, string>();
    Object.assign(globalThis, { document, window, localStorage: undefined, IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    const Probe = () => <span id="probe">{React.useContext(InCalmSection) ? "inside" : "outside"}</span>;
    root = createRoot(document.getElementById("app")!);
    act(() =>
      root!.render(
        <CalmSection title="Leads" persistKey="t-leads">
          <Probe />
        </CalmSection>,
      ),
    );
    const button = document.querySelector("button")!;
    expect(document.getElementById("probe")).toBeNull();
    act(() => button.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("probe")?.textContent).toBe("inside");
    expect(store.get("calm-open:t-leads")).toBe("1");
  });
});

describe("Mission Control: the top stays, the rest folds", () => {
  const page = SRC("src/routes/-pages/dashboard.tsx");
  test("key numbers are not folded; every lower section is", () => {
    const top = page.indexOf('aria-label="Key numbers"');
    const firstFold = page.indexOf("<McSection");
    expect(top).toBeGreaterThan(0);
    expect(firstFold).toBeGreaterThan(top);
    for (const key of ["mc-leads", "mc-away", "mc-usage", "mc-trends", "mc-dream", "mc-skills", "mc-memory", "mc-graph", "mc-integrations", "mc-vectors", "mc-automations", "mc-models", "mc-recommender"])
      expect(page).toContain(`persistKey="${key}"`);
    expect(page.match(/<McSection /g)!.length).toBe(page.match(/<\/McSection>/g)!.length);
    expect(page).toContain("<DeckGrid"); // the sections are widgets in a dense grid; Open reveals the section under its row
    expect(page).not.toContain("Everything else");
  });
});
