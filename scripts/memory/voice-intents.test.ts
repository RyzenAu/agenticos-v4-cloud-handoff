// Voice memory intents + tool surface, over a TEMP mini-wiki and the FAKE Hindsight.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySpokenCorrection, handleMemoryUtterance, MEMORY_VOICE_TOOLS, parseMemoryIntent, runMemoryTool } from "./voice-intents";
import { cleanup, mehroz, setup, snapshot, usman } from "./testing/harness";
import type { Harness } from "./testing/harness";

/** Jarvis's voice channel: the spoken-yes event the voice pipeline recorded for this turn (after the question). */
const voice = (h: Harness, yes = false) => {
  if (!yes) return { channel: "voice" as const };
  h.advance(1000);
  const ev = h.spoken.record("yes")!;
  return { channel: "voice" as const, spokenYes: () => ev.id };
};
const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

afterEach(cleanup);
const T = { timeout: 30_000 };

describe("parseMemoryIntent", () => {
  const cases: [string, unknown][] = [
    ["Remember that the Essential package is A$699 a month", { intent: "remember", text: "The Essential package is A$699 a month." }],
    ["Hey Jarvis, remember Brooke prefers email", { intent: "remember", text: "Brooke prefers email." }],
    ["make a note that demos run in Mode A", { intent: "remember", text: "Demos run in Mode A." }],
    ["Save this to the vault: proposals are valid for 30 days", { intent: "vault", text: "Proposals are valid for 30 days." }],
    ["add to the wiki: kickoff calls run 30 minutes", { intent: "vault", text: "Kickoff calls run 30 minutes." }],
    ["save that to the vault", { intent: "vault", text: null }],
    ["What do we know about Harbourview Dental?", { intent: "recall", query: "Harbourview Dental" }],
    ["what did we decide about the premium price", { intent: "recall", query: "the premium price" }],
    ["correct that: it's A$1,999", { intent: "correct", target: null, text: "A$1,999" }],
    ["update the kickoff call fact to 30 minutes", { intent: "correct", target: "kickoff call", text: "30 minutes" }],
    ["forget that", { intent: "forget", target: null, unindex: false }],
    ["remove that from the index", { intent: "forget", target: null, unindex: true }],
    ["Forget about the lighthouse theme", { intent: "forget", target: "the lighthouse theme", unindex: false }],
    ["remove the invoice terms from memory", { intent: "forget", target: "invoice terms", unindex: false }],
  ];
  for (const [utterance, expected] of cases) test(utterance, () => expect(parseMemoryIntent(utterance)).toEqual(expected as never));

  test("not memory intents", () => {
    for (const u of ["remember to call Brooke tomorrow", "remove the banner from the dental site", "what's the weather", "open the receptionist page", ""])
      expect(parseMemoryIntent(u)).toBeNull();
  });
});

describe("applySpokenCorrection", () => {
  test("a bare value replaces the single value; ambiguous fragments ask for the full fact", () => {
    expect(applySpokenCorrection("The Premium package is A$1,500 a month.", "A$1,999")).toBe("The Premium package is A$1,999 a month.");
    expect(applySpokenCorrection("Essential is A$699 and Professional is A$1,099.", "A$749")).toBeNull();
    expect(applySpokenCorrection("Brooke prefers email.", "phone")).toBeNull();
  });
});

describe("a spoken session", () => {
  test(
    "remember → recall → correct that → forget that (a spoken yes grants the server-held approval)",
    async () => {
      const h = await setup();
      const before = snapshot(h.vault);
      const r = await handleMemoryUtterance(h.api, usman, "remember that the synthetic Premium package is A$1,500 a month");
      expect(r.outcome).toBe("remembered");
      const askFix = await handleMemoryUtterance(h.api, usman, "correct that: it's A$1,999", { lastFactsUsed: r.facts_used });
      expect(askFix.outcome).toBe("needs-confirm");
      expect(askFix.spoken).toContain('to "The synthetic Premium package is A$1,999 a month."?');
      expect(h.api.item(r.facts_used[0])!.row.status).toBe("current"); // nothing superseded before the yes
      const c = await handleMemoryUtterance(h.api, usman, "yes", { pending: askFix.pending });
      expect(c.outcome).toBe("corrected");
      expect(h.api.item(c.facts_used[0])!.row.text).toBe("The synthetic Premium package is A$1,999 a month.");
      const rec = await handleMemoryUtterance(h.api, mehroz, "what do we know about the Premium package");
      expect(rec.facts_used[0]).toBe(c.facts_used[0]);

      const ask = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: rec.facts_used }, voice(h));
      expect(ask.outcome).toBe("needs-confirm");
      expect(ask.pending?.action).toBe("forget");
      expect(ask.spoken).toContain("Say yes");
      expect(h.bankDocs().has(c.facts_used[0])).toBe(true);
      // Anything but yes cancels, and an explicit no refuses the approval (it can't be approved later).
      const no = await handleMemoryUtterance(h.api, usman, "no, leave it", { pending: ask.pending }, voice(h));
      expect(no.outcome).toBe("cancelled");
      expect(h.bankDocs().has(c.facts_used[0])).toBe(true);
      expect(h.api.approvals.pending()).toHaveLength(0);
      // The approval id never leaves the server; a client context can't point a "yes" elsewhere.
      expect(JSON.stringify(ask)).not.toMatch(UUID);
      const again = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: rec.facts_used }, voice(h));
      const forged = await handleMemoryUtterance(h.api, usman, "yes", { pending: { ...again.pending!, target: "mem-0000000000" } as never }, voice(h, true));
      expect(forged.outcome).toBe("refused");
      expect(h.bankDocs().has(c.facts_used[0])).toBe(true);
      // Another person's yes can't use Usman's pending question either.
      const ask2 = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: rec.facts_used }, voice(h));
      expect((await handleMemoryUtterance(h.api, mehroz, "yes", { pending: ask2.pending }, voice(h, true))).outcome).toBe("refused");
      // A typed yes (the Memory page's box) never approves.
      const ask3 = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: rec.facts_used }, voice(h));
      const typed = await handleMemoryUtterance(h.api, usman, "yes", { pending: ask3.pending }, { channel: "ui" });
      expect(typed.outcome).toBe("needs-confirm");
      expect(h.bankDocs().has(c.facts_used[0])).toBe(true);
      const ask4 = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: rec.facts_used }, voice(h));
      const yes = await handleMemoryUtterance(h.api, usman, "yes", { pending: ask4.pending }, voice(h, true));
      expect(yes.outcome).toBe("forgotten");
      expect(h.bankDocs().has(c.facts_used[0])).toBe(false);
      expect(yes.spoken).toContain("backups");
      expect(snapshot(h.vault)).toEqual(before);
    },
    T,
  );

  test(
    "forgetting vault content by voice is a full forget unless you say 'remove that from the index'",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const rec = await handleMemoryUtterance(h.api, usman, "what do we know about Osprey proposals");
      expect(rec.facts_used[0]).toBe("n-proposal-terms");
      const unindex = await handleMemoryUtterance(h.api, usman, "remove that from the index", { lastFactsUsed: rec.facts_used });
      expect(unindex.outcome).toBe("unindexed");
      expect(h.bankDocs().has("n-proposal-terms")).toBe(false);
      expect(readFileSync(join(h.vault, "wiki/topics/business/proposal-terms.md"), "utf8")).toContain("21 days");

      const demo = await handleMemoryUtterance(h.api, usman, "what do we know about the demo line hours");
      const full = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: demo.facts_used }, voice(h));
      expect(full.pending?.action === "forget" && full.pending.kind).toBe("full");
      expect(full.spoken).toContain("Git history");
    },
    T,
  );

  test("a spoken conflict asks, then 'replace it' corrects instead of duplicating", async () => {
    const h = await setup();
    await handleMemoryUtterance(h.api, usman, "remember that synthetic kickoff calls run 45 minutes");
    const c = await handleMemoryUtterance(h.api, usman, "remember that synthetic kickoff calls run 30 minutes");
    expect(c.outcome).toBe("needs-confirm");
    const r = await handleMemoryUtterance(h.api, usman, "replace it", { pending: c.pending });
    expect(r.outcome).toBe("corrected");
    expect(h.api.list({ kind: "memory" }).map((x) => x.text)).toEqual(["Synthetic kickoff calls run 30 minutes."]);
  });

  test("voice refuses prohibited content without echoing it", async () => {
    const h = await setup();
    const r = await handleMemoryUtterance(h.api, usman, "remember that the API key is sk-proj-SYNTHETICabcdefghijklmnop0123");
    expect(r.outcome).toBe("refused");
    expect(r.spoken).not.toContain("sk-proj");
  });
});

describe("Jarvis audit F12 regressions (Track 6)", () => {
  test("a spoken correction keeps the entity of the fact it corrects (\"they prefer…\" never drops the business)", async () => {
    expect(applySpokenCorrection("Synthetic Dental Co prefers calls before 10 am.", "they prefer calls after 2 pm")).toBe("Synthetic Dental Co prefers calls after 2 pm.");
    expect(applySpokenCorrection("The Kestrel clinic is open until 5pm on weekdays.", "it's open until 6pm on weekdays")).toBe("The Kestrel clinic is open until 6pm on weekdays.");
    expect(applySpokenCorrection("Proposals are valid for 21 days.", "they are valid for 45 days")).toBe("Proposals are valid for 45 days.");
    // A fragment that drops every entity and can't be lined up asks for the whole fact instead.
    expect(applySpokenCorrection("Synthetic Dental Co prefers calls before 10 am.", "calls after 2 pm are better")).toBeNull();
    expect(applySpokenCorrection("Synthetic Dental Co prefers calls before 10 am.", "it's closed on Mondays now")).toBeNull();
    // Naming a subject is taken as said.
    expect(applySpokenCorrection("Synthetic Dental Co prefers calls before 10 am.", "Harbourview Dental prefers calls after 2 pm")).toBe("Harbourview Dental prefers calls after 2 pm.");
    expect(applySpokenCorrection("Synthetic Dental Co prefers calls before 10 am.", "Mehroz prefers calls after 2 pm")).toBe("Mehroz prefers calls after 2 pm.");
  });

  test("the audit's spoken sequence: remember → correct that: they prefer… → yes → recall still finds the business", async () => {
    const h = await setup({ hindsight: false });
    const r = await handleMemoryUtterance(h.api, usman, "remember that Synthetic Dental Co prefers calls before 10 am", {}, voice(h));
    expect(r.outcome).toBe("remembered");
    const ask = await handleMemoryUtterance(h.api, usman, "correct that: they prefer calls after 2 pm", { lastFactsUsed: r.facts_used }, voice(h));
    expect(ask.spoken).toContain('to "Synthetic Dental Co prefers calls after 2 pm."?');
    const c = await handleMemoryUtterance(h.api, usman, "yes", { pending: ask.pending }, voice(h));
    expect(c.outcome).toBe("corrected");
    const rec = await handleMemoryUtterance(h.api, usman, "what do we know about Synthetic Dental Co", {}, voice(h));
    expect(rec.spoken).toContain("Synthetic Dental Co prefers calls after 2 pm.");
  });

  test("forget states what happened in each store: Hindsight off, unreachable, and reachable", async () => {
    // Hindsight off: nothing was ever there, and the reply says so (never "deleted from Hindsight").
    const off = await setup({ hindsight: false });
    const m = await off.api.remember(usman, { text: "The synthetic Plover account prefers email.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    const ask = await off.api.forget(usman, { kind: "memory", target: m.memory.id });
    if (ask.ok || !ask.approval) throw new Error("expected approval-required");
    const g = await off.approveUi(off.api, ask.approval.id, usman);
    if (!g.ok || !g.result.ok) throw new Error("expected the forget to run");
    expect(g.result.message).toContain("Hindsight is off here");
    expect(g.result.message).not.toMatch(/deleted from Hindsight|Hindsight document\(s\) deleted/);
    expect("hindsight" in g.result && g.result.hindsight).toBe("disabled");

    // Hindsight unreachable: the delete is queued, and the reply says why.
    const down = await setup();
    const m2 = await down.api.remember(usman, { text: "The synthetic Gannet account prefers SMS.", channel: "voice" });
    if (!m2.ok) throw new Error(m2.message);
    await down.api.sync({ force: true });
    const ask2 = await down.api.forget(usman, { kind: "memory", target: m2.memory.id });
    if (ask2.ok || !ask2.approval) throw new Error("expected approval-required");
    await down.fake.down();
    const g2 = await down.approveUi(down.api, ask2.approval.id, usman);
    if (!g2.ok || !g2.result.ok) throw new Error("expected the forget to run");
    expect(g2.result.message).toContain("queued for deletion");
    expect(g2.result.message).toContain("isn't reachable");
    expect("hindsight" in g2.result && g2.result.hindsight).toBe("queued");
    await down.fake.up();

    // Reachable: deleted, and it says how many documents.
    const up = await setup();
    const m3 = await up.api.remember(usman, { text: "The synthetic Tern account prefers calls.", channel: "voice" });
    if (!m3.ok) throw new Error(m3.message);
    const ask3 = await up.api.forget(usman, { kind: "memory", target: m3.memory.id });
    if (ask3.ok || !ask3.approval) throw new Error("expected approval-required");
    const g3 = await up.approveUi(up.api, ask3.approval.id, usman);
    if (!g3.ok || !g3.result.ok) throw new Error("expected the forget to run");
    expect(g3.result.message).toContain("1 Hindsight document(s) deleted");
  });
});

describe("tool-calling surface", () => {
  test("five tools; the model can ask to forget but never approve", async () => {
    expect(MEMORY_VOICE_TOOLS.map((t) => t.name)).toEqual(["remember_fact", "save_to_vault", "recall_memory", "correct_fact", "forget_memory"]);
    const h = await setup();
    const r = (await runMemoryTool(h.api, usman, "remember_fact", { text: "The synthetic Kiwi account prefers SMS." })) as { ok: boolean; id: string; destination: { kind: string } };
    expect(r.ok && r.destination.kind).toBe("hindsight");
    const f = (await runMemoryTool(h.api, usman, "forget_memory", { id: r.id, kind: "memory" })) as { ok: boolean; code?: string };
    expect(f.code).toBe("approval-required");
    const rec = (await runMemoryTool(h.api, usman, "recall_memory", { query: "Kiwi account SMS" })) as { facts: { id: string; source: { kind: string } }[] };
    expect(rec.facts[0].id).toBe(r.id);
    expect(rec.facts[0].source.kind).toBe("memory");
  });
});
