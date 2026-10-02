// Track 2 pure pieces: page context, reference resolution, rule plans, spoken targets, thresholds and
// calibration, the voice routing rule, and the route's body validation. Synthetic only.
import { describe, expect, test } from "bun:test";
import { parsePageContext, referenceIn, resolveReference, safeHref } from "./context";
import { blankDeckTitle, followOnStep, notepadLine, notepadParts, osPageIn, planRules, splitSpokenTarget } from "./plan";
import { appNameIn, builtinRegistry } from "./registry";
import { calibrate, DEFAULT_THRESHOLDS, policyFor, thresholdsFor, wilsonLower, type LoggedDecision } from "./thresholds";
import { commandIntent } from "./words";
import { parseCommandBody } from "./route";
import { isExecutorResult } from "./contracts";

describe("page context", () => {
  test("only OS-internal hrefs survive; malformed items are dropped, never repaired", () => {
    expect(safeHref("/receptionist?call=c1")).toBe("/receptionist?call=c1");
    for (const bad of ["https://evil.example/x", "//evil.example", "/a/../b", "javascript:alert(1)", " /x y"]) expect(safeHref(bad)).toBeUndefined();
    const ctx = parsePageContext({ page: "/leads", visible: [{ kind: "lead", id: "1", label: "Synthetic Dental" }, { kind: "BAD KIND", id: "2", label: "x" }, { kind: "lead", id: "", label: "no id" }], focused: { kind: "lead", id: "1", label: "Synthetic Dental", href: "https://x" } });
    expect(ctx?.visible).toHaveLength(1);
    expect(ctx?.focused?.href).toBeUndefined();
    expect(parsePageContext({ page: "https://x" })).toBeNull();
    expect(parsePageContext("nope")).toBeNull();
  });
  test("Track 1's snapshot shape is accepted and mapped (selection, to+search, facts)", () => {
    const ctx = parsePageContext({
      version: 1,
      page: { path: "/operations", destination: "operations", title: "Operations" },
      selection: { kind: "package", id: "receptionist-professional", label: "Professional package", facts: { contributionMarginPct: "71.2%" } },
      focused: { kind: "call", id: "c1", label: "Call 1", to: "/receptionist", search: { call: "c1" } },
      visible: [],
      sources: [{ id: "econ", label: "Economics model", state: "live", source: "src/lib/business-economics.ts", lastSuccess: null }],
      job: null,
      providers: ["operations"],
      at: 5,
    });
    expect(ctx).toMatchObject({ page: "/operations", title: "Operations", selected: [{ kind: "package", data: { contributionMarginPct: "71.2%" } }], focused: { href: "/receptionist?call=c1" }, source: { name: "Economics model", state: "live" }, capturedAt: 5 });
  });
  test("references: a noun names kinds; a bare pronoun only when the whole request is verb + pronoun", () => {
    expect(referenceIn("explain this margin")).toMatchObject({ noun: "margin", kinds: ["margin", "package", "metric"] });
    expect(referenceIn("open that call")).toMatchObject({ noun: "call", kinds: ["call"] });
    expect(referenceIn("open it")).toMatchObject({ noun: null });
    expect(referenceIn("create a deck called x and show it")).toBeNull();
    expect(referenceIn("open this weekend's calendar")).toBeNull();
  });
  test("resolution: focused → selected → visible; several → ask; none → ask; no context → says so", () => {
    const call = (id: string) => ({ kind: "call", id, label: `Call ${id}` });
    const ref = referenceIn("open that call")!;
    expect(resolveReference(ref, { page: "/receptionist", focused: call("f"), visible: [call("a"), call("b")] })).toMatchObject({ kind: "resolved", item: { id: "f" }, tier: "focused" });
    expect(resolveReference(ref, { page: "/receptionist", visible: [call("a")] })).toMatchObject({ kind: "resolved", tier: "visible" });
    const amb = resolveReference(ref, { page: "/receptionist", visible: [call("a"), call("b")] });
    expect(amb).toMatchObject({ kind: "ambiguous" });
    expect(amb.kind === "ambiguous" && amb.said).toMatch(/Which one/);
    expect(resolveReference(ref, { page: "/receptionist", visible: [{ kind: "lead", id: "1", label: "Lead" }] }).kind).toBe("none");
    expect(resolveReference(ref, null)).toMatchObject({ kind: "none", said: expect.stringContaining("can't see which page") });
  });
});

describe("rule plans and spoken targets", () => {
  test("spoken targets split off the end of his words", () => {
    expect(splitSpokenTarget("open notepad on my laptop")).toEqual({ utterance: "open notepad", spokenTarget: "my laptop" });
    expect(splitSpokenTarget("Open Notepad on Usman's PC")).toEqual({ utterance: "Open Notepad", spokenTarget: "Usman's PC" });
    expect(splitSpokenTarget("open powerpoint here")).toEqual({ utterance: "open powerpoint", spokenTarget: "this pc" });
    expect(splitSpokenTarget("click on the button")).toEqual({ utterance: "click on the button" });
  });
  test("typed executor shapes: only when code can fill the arguments exactly", () => {
    expect(notepadLine("Open Notepad and type 'hello there'")).toBe("hello there");
    expect(notepadLine("open notepad and type the line saying good morning")).toBe("good morning");
    expect(notepadLine("open notepad")).toBeNull();
    expect(blankDeckTitle("open a new PowerPoint and add a title slide 'Q3'")).toBe("Q3");
    expect(blankDeckTitle("create a new deck called board")).toBeNull(); // a named deck is saved under a root: jev-powerpoint's
    expect(planRules("open notepad")).toMatchObject({ lane: "executor", executor: "app.open", args: { name: "notepad" } });
    expect(planRules("open photoshop")).toBeNull(); // not on the allow-list
    expect(planRules("open https://example.com")).toMatchObject({ executor: "open-url", target: "example.com" });
    expect(planRules("ask codex to fix the login bug")).toBeNull(); // Track 3 owns coding words
    expect(planRules("how's the receptionist today")).toMatchObject({ lane: "delegate", to: "receptionist" });
    expect(planRules("remember that the synthetic clinic opens at 8")).toMatchObject({ lane: "delegate", to: "memory" });
    expect(appNameIn("launch power point")).toBe("powerpoint");
    expect(osPageIn("open the receptionist page")).toEqual({ path: "/receptionist", label: "Receptionist" });
    expect(osPageIn("open the file receptionist notes")).toBeNull();
    expect(builtinRegistry().resolve("take me to leads")[0]).toMatchObject({ kind: "os-page", ref: "/leads" });
  });
  test("coding words are Track 3's: no rule here claims them (REVIEW-T2 #3)", () => {
    expect(planRules("Ask Codex to fix the flaky login test")).toBeNull();
    expect(planRules("assign Codex to fix the failing tests in AgenticOS")).toBeNull();
  });
  test("compound commands: a further step is named, never silently dropped (REVIEW-T2 #2)", () => {
    expect(notepadParts("open notepad and type 'hi John' then email it to John")).toEqual({ line: "hi John", extra: "email it to John" });
    expect(notepadParts("open notepad and type hello and save it as report.txt")).toEqual({ line: "hello", extra: "save it as report.txt" });
    expect(notepadParts("open notepad and type 'hello' then press enter")).toEqual({ line: "hello", extra: "press enter" });
    expect(notepadParts("open notepad and type fish and chips")).toEqual({ line: "fish and chips", extra: null });
    expect(notepadParts("open notepad and type 'send it later'")).toEqual({ line: "send it later", extra: null });
    for (const u of ["open notepad and type 'hi John' then email it to John", "open notepad and type hello and save it as report.txt", "open a new PowerPoint with the title 'Q3' and send it to Mehroz"]) {
      const r = planRules(u);
      expect(r).toMatchObject({ lane: "unsupported" });
      expect(r && "said" in r && r.said).toMatch(/haven't done any of it/);
    }
    // R2: a step BEFORE the executor's part, or after a URL or file name, is caught too.
    for (const [u, step] of [
      ["email John and then open notepad and type hi", "email John"],
      ["send the report to Mehroz then open notepad and type hi", "send the report to Mehroz"],
      ["open https://example.com and then click the first link", "click the first link"],
      ["open https://example.com then log in", "log in"],
      ["open the file quarterly plan and email it to John", "email it to John"],
      ["open github.com and sign in", "sign in"],
      ["open https://example.com and open notepad", "open notepad"],
      ["email John and then type hi in notepad", "email John"],
    ] as const) {
      const r = planRules(u);
      expect({ u, lane: r?.lane }).toEqual({ u, lane: "unsupported" });
      expect(r && "said" in r && r.said).toContain(`"${step}"`);
    }
    // Still fine: one action, or text that merely mentions a verb.
    expect(planRules("open notepad and then type hello")).toMatchObject({ lane: "executor", args: { text: "hello" } });
    expect(planRules("open notepad and type 'email John tomorrow'")).toMatchObject({ lane: "executor", args: { text: "email John tomorrow" } });
    expect(planRules("open https://example.com")).toMatchObject({ lane: "executor", executor: "open-url" });
    expect(planRules("open a new PowerPoint and add a title slide 'Q3'")).toMatchObject({ lane: "executor", executor: "deck.blank" });
    expect(followOnStep(" then press enter")).toBe("press enter");
    expect(followOnStep(" for Mehroz")).toBeNull();
    expect(commandIntent("open notepad and type 'hi' then email it to John")).not.toBeNull();
  });
});

describe("thresholds are per surface, carry their calibration run id, and are never permission", () => {
  test("policy bands", () => {
    const t = thresholdsFor("voice");
    expect(t.calibrationRunId).toBe("w2-inherited-20260927");
    expect([policyFor(0.95, t), policyFor(0.5, t), policyFor(0.1, t)]).toEqual(["act", "look-again", "ask"]);
    expect(thresholdsFor("typed").surface).toBe("command.typed");
  });
  test("calibration keeps the current set without enough checked outcomes, and says why", () => {
    const few: LoggedDecision[] = Array.from({ length: 20 }, () => ({ surface: "command.voice", verified: true, decision: { confidence: 0.95, source: "jev", policy: "act" } }));
    const r = calibrate(few, "command.voice", DEFAULT_THRESHOLDS["command.voice"]);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/Not enough checked outcomes/);
  });
  test("calibration proposes a new act threshold only where every band upward is well evidenced", () => {
    const rows: LoggedDecision[] = [];
    for (const c of [0.72, 0.85, 0.95]) for (let i = 0; i < 60; i++) rows.push({ surface: "command.voice", verified: true, decision: { confidence: c, source: "jev", policy: "act" } });
    for (let i = 0; i < 40; i++) rows.push({ surface: "command.voice", verified: i < 20, decision: { confidence: 0.65, source: "jev", policy: "act" } });
    const r = calibrate(rows, "command.voice", DEFAULT_THRESHOLDS["command.voice"]);
    expect(r.proposed.act).toBe(0.7);
    expect(r.proposed.calibrationRunId).toMatch(/^cal-command\.voice-/);
    expect(wilsonLower(20, 40)).toBeLessThan(0.5);
  });
});

describe("voice routing (free-voice asks this before its older rules)", () => {
  test("device actions, answers, named files/decks, YouTube work, page references and named machines", () => {
    for (const u of [
      "open notepad",
      "open notepad and type 'hi'",
      "open a new powerpoint and add a title slide 'x'",
      "what's our margin on the professional package",
      "open the file quarterly-plan",
      "create a deck called board and show it",
      "search youtube for lo-fi and play the first video",
      "explain this margin",
      "open that call",
      "open notepad on my laptop",
    ])
      expect(commandIntent(u)).not.toBeNull();
  });
  test("not claimed: a bare 'open YouTube', memory, chat, and 'this' while he's sharing his screen", () => {
    // OS pages stay with the Jev router's navigate (same page; typed ones resolve in Track 1's registry).
    for (const u of ["open youtube", "remember that the gate code is synthetic", "write me a poem", "click the save button", "take me to my calendar"]) expect(commandIntent(u)).toBeNull();
    expect(commandIntent("explain this margin", { sharing: true })).toBeNull();
  });
});

describe("the route's body", () => {
  test("personId in the body is ignored; spokenYes must be a server event id shape", () => {
    const b = parseCommandBody({ utterance: " open notepad ", personId: "mehroz", source: "voice", spokenYes: "not-an-id", spokenTarget: " my laptop " });
    expect(b).toEqual({ utterance: "open notepad", source: "voice", spokenTarget: "my laptop" });
    expect(() => parseCommandBody({})).toThrow();
    expect(isExecutorResult({ ok: true, said: "x", verified: null })).toBe(true);
    expect(isExecutorResult({ ok: true, said: "x" })).toBe(false);
  });
});

describe("calibration reads the job log", () => {
  test("only Jev-routed jobs that acted and were checked count; asks and cancels don't", async () => {
    const { rowsFromJobs } = await import("./calibrate");
    const step = (intent: string, extra: Record<string, unknown> = {}) => ({ seq: 1, at: 1, intent, executor: "x", ms: 0, outcome: "note", ...extra });
    const job = (state: string, steps: unknown[], kind = "voice") => ({ id: state, kind, principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", state, title: "t", cancelRequested: false, quarantined: false, steps, receipts: [], createdAt: "", updatedAt: "" });
    const jevRoute = step("route: Jev: screen_act 83% (screen)", { jev: { op: "screen_act", confidence: 0.83, policy: "act" } });
    const acted = step("decision: Decision: screen.act → act", { jev: { op: "screen.act", confidence: 0.83, policy: "act" } });
    const asked = step("decision: Decision: ask → ask", { jev: { op: "ask", confidence: 0.45, policy: "ask" } });
    const ok = step("check: typed and read back", { verification: { method: "deterministic-check", ok: true } });
    const bad = step("check: didn't land", { verification: { method: "deterministic-check", ok: false } });
    const rows = rowsFromJobs([job("succeeded", [jevRoute, acted, ok]), job("failed", [jevRoute, acted, bad], "command"), job("failed", [jevRoute, asked]), job("cancelled", [jevRoute, acted, ok])] as never);
    expect(rows).toEqual([
      { surface: "command.voice", verified: true, decision: { confidence: 0.83, source: "jev", policy: "act" } },
      { surface: "command.typed", verified: false, decision: { confidence: 0.83, source: "jev", policy: "act" } },
    ]);
  });
});

describe("AUDIT-F4 rows owned by Track 2 (pure)", () => {
  test("F11 lead actions: log, status and next; unknown outcomes are not guessed", async () => {
    const { leadActionIn } = await import("./plan");
    expect(leadActionIn("log a call to Synthetic Dental Co as no answer")).toEqual({ action: "log", lead: "Synthetic Dental Co", outcome: "no_answer" });
    expect(leadActionIn("mark Synthetic Physio Studio as won")).toEqual({ action: "status", lead: "Synthetic Physio Studio", outcome: "won" });
    expect(leadActionIn("who should I call next?")).toEqual({ action: "next" });
    expect(leadActionIn("mark Synthetic Physio Studio as fabulous")).toBeNull();
    expect(planRules("mark Synthetic Physio Studio as won")).toMatchObject({ lane: "delegate", to: "leads" });
  });
  test("F11 runLeadAction: one match writes and reads back; several ask; none says so", async () => {
    const { runLeadAction } = await import("./leads");
    const writes: unknown[] = [];
    let status = "new";
    const api = (hits: Array<{ group: string; leadId: number; title: string }>, readBack = true) => ({
      handle: async (path: string, _m: string, body: unknown, params: URLSearchParams) => {
        if (path === "/leads/search") return { hits };
        if (path === "/leads/log") return (writes.push(body), (status = (body as { outcome: string }).outcome), { lead: {} });
        if (path === "/leads/list") return { leads: readBack && params.get("status") === status ? [{ id: 7 }] : [] };
        if (path === "/leads/cards") return { cards: [{ leadId: 7, name: "Synthetic Dental Co", vertical: "dental", area: "Parramatta" }] };
        throw new Error(path);
      },
    });
    const one = [{ group: "leads", leadId: 7, title: "Synthetic Physio Studio" }];
    expect(await runLeadAction(api(one), { action: "status", lead: "Synthetic Physio Studio", outcome: "won" }, { personId: "mehroz" })).toEqual({ ok: true, said: "Marked Synthetic Physio Studio as won.", verified: true });
    expect(writes).toEqual([{ lead: 7, outcome: "won", kind: "note", by: "mehroz" }]);
    const two = [...one, { group: "leads", leadId: 8, title: "Synthetic Physio Studio North" }];
    expect((await runLeadAction(api(two), { action: "log", lead: "physio", outcome: "no_answer" }, { personId: "usman" })).said).toMatch(/Which one\?/);
    expect((await runLeadAction(api([]), { action: "log", lead: "Nobody", outcome: "no_answer" }, { personId: "usman" })).said).toMatch(/can't find a lead called Nobody/);
    const unverified = await runLeadAction(api(one, false), { action: "log", lead: "Synthetic Physio Studio", outcome: "interested" }, { personId: "usman" });
    expect(unverified).toMatchObject({ ok: false, verified: false });
    expect((await runLeadAction(api(one), { action: "next" }, { personId: "usman" })).said).toBe("Next to call: Synthetic Dental Co (dental, Parramatta). Its call card is in Leads.");
  });
  test("F13 'remember to …' is a reminder; 'remember that …' stays memory", async () => {
    const { rememberToReminder } = await import("./plan");
    expect(rememberToReminder("remember to call Mehroz at 5 pm")).toBe("remind me to call Mehroz at 5 pm");
    expect(rememberToReminder("remember that the clinic opens at 8")).toBeNull();
    expect(planRules("remember to call Mehroz at 5 pm")).toMatchObject({ lane: "delegate", to: "reminder" });
    expect(planRules("remember that the clinic opens at 8")).toMatchObject({ lane: "delegate", to: "memory" });
  });
  test("F9 prices come from the catalogue with their approval status; setup fees are never quoted", async () => {
    const { parsePriceQuery, priceAnswer } = await import("./answers");
    const pkgs = parsePriceQuery("how much is the Premium package");
    expect(pkgs?.map((p) => p.shortName)).toEqual(["Premium"]);
    const a = priceAnswer(pkgs!);
    expect(a.said).toMatch(/^Premium: A\$1,999\.00 a month ex GST \(approved\), 1,800 minutes included, then A\$0\.70 a minute\. Invoices add 10% GST\. Setup fees aren't approved yet/);
    expect(parsePriceQuery("what's our margin on premium")).toBeNull();
    expect(parsePriceQuery("how much is the weather")).toBeNull();
    expect(commandIntent("how much is the Premium package")).not.toBeNull();
  });
  test("F15 the file lane doesn't misfire; F7-adjacent: domains open as sites, file names don't", () => {
    expect(planRules("open File Explorer")).toMatchObject({ executor: "app.open", args: { name: "explorer" } });
    expect(planRules("find my notes about pricing")).toBeNull();
    expect(planRules("open the file synthetic proposal")).toMatchObject({ executor: "file.open", args: { name: "synthetic proposal" } });
    expect(planRules("open github.com")).toMatchObject({ executor: "open-url", args: { url: "https://github.com/" } });
    expect(planRules("open report.pdf")).toBeNull();
  });
  test("F14 a whole-request stop is a stop; a longer request isn't", async () => {
    const { STOP_WORDS } = await import("./service");
    for (const u of ["stop", "cancel that", "never mind", "Jarvis, stop.", "hold on", "stop that task", "cancel the task", "stop the job."]) expect(STOP_WORDS.test(u)).toBe(true);
    for (const u of ["stop the music and open notepad", "cancel my 3pm meeting", "stop everything"]) expect(STOP_WORDS.test(u)).toBe(false);
  });
});

describe("AUDIT-F2 receptionist questions (pure)", () => {
  test("which question: flagged, today, bookings, safe to sell; his own calls and the page are not receptionist questions", async () => {
    const { receptionistQuestion } = await import("./receptionist");
    expect(receptionistQuestion("any flagged calls?")).toBe("flagged");
    expect(receptionistQuestion("any receptionist calls today")).toBe("calls-today");
    expect(receptionistQuestion("how many bookings did the receptionist make this week")).toBe("bookings");
    expect(receptionistQuestion("is the receptionist ready to sell")).toBe("safe-to-sell");
    expect(receptionistQuestion("how's the receptionist")).toBe("status");
    for (const u of ["how many calls have I made today", "open the receptionist page", "what's the margin on the receptionist package", "any bookings for dinner"]) expect(receptionistQuestion(u)).toBeNull();
  });
  test("an unreadable source is unknown, never zero; every answer names its source", async () => {
    const { receptionistAnswer } = await import("./receptionist");
    const snap = { generatedAt: "2026-09-28T01:30:00.000Z", sentence: "Status unknown.", verdict: { decision: "Status unknown", facts: [], next: "" }, incidents: [], calls: { ok: false, reason: "Retell not configured" }, feed: { ok: false, reason: "feed token missing" } } as never;
    const today = receptionistAnswer("calls-today", snap);
    expect(today).toMatchObject({ verified: false });
    expect(today.said).toMatch(/unknown, not zero\. Source: receptionist dashboard/);
    expect(receptionistAnswer("bookings", snap).said).toMatch(/bookings are unknown, not zero/);
    expect(receptionistAnswer("flagged", snap).said).toMatch(/^No flagged calls are open\. Source:/);
  });
});

describe("memory outcomes are only done when stored or found (REVIEW-T2 #1)", () => {
  test("stored/found → done; a question → waits; writes off, not found, cancelled → not done", async () => {
    const { memoryOutcome } = await import("./service");
    for (const o of ["remembered", "saved-to-vault", "duplicate", "corrected", "forgotten", "recalled"]) expect(memoryOutcome(o).kind).toBe("done");
    expect(memoryOutcome("needs-confirm").kind).toBe("question");
    for (const o of ["refused", "not-found", "unindexed", "cancelled"]) expect(memoryOutcome(o).kind).toBe("not-done");
    expect(memoryOutcome("handled").kind).toBe("unknown");
  });
});

describe("REVIEW-T2 R3 parser fixes", () => {
  test("anything after a URL is another step; trailing punctuation isn't part of the URL", () => {
    for (const [u, step] of [
      ["open https://example.com and scroll down", "scroll down"],
      ["open https://example.com and zoom in", "zoom in"],
      ["open https://example.com and read it to me", "read it to me"],
      ["open https://example.com, then scroll down", "scroll down"],
      ["open example.com and scroll down", "scroll down"],
      ["open github.com and scroll down", "scroll down"],
    ] as const) {
      const r = planRules(u);
      expect({ u, lane: r?.lane }).toEqual({ u, lane: "unsupported" });
      expect(r && "said" in r && r.said).toContain(`"${step}"`);
    }
    expect(planRules("open https://example.com.")).toMatchObject({ lane: "executor", args: { url: "https://example.com" } });
    expect(planRules("open https://example.com/docs?page=2")).toMatchObject({ lane: "executor", args: { url: "https://example.com/docs?page=2" } });
  });
  test("paired quotes: an apostrophe inside never cuts the text short (straight and curly)", async () => {
    const { findQuoted } = await import("./plan");
    const cases: Array<[string, string]> = [
      [`open notepad and type "I'll call you back"`, "I'll call you back"],
      [`open notepad and type "don't forget the milk"`, "don't forget the milk"],
      [`open notepad and type 'don't forget the milk'`, "don't forget the milk"],
      [`open notepad and type “it’s done”`, "it’s done"],
      [`open notepad and type ‘Usman’s plan’`, "Usman’s plan"],
      [`open notepad and type "we'll pay then go"`, "we'll pay then go"],
    ];
    for (const [u, line] of cases) expect({ u, plan: planRules(u) }).toMatchObject({ u, plan: { lane: "executor", executor: "notepad.type", args: { text: line } } });
    expect(planRules(`open a new PowerPoint and add a title slide "Usman's plan"`)).toMatchObject({ lane: "executor", executor: "deck.blank", args: { title: "Usman's plan" } });
    expect(findQuoted(`the title "Usman's plan" please`)).toMatchObject({ text: "Usman's plan" });
    // A trailing step after a quote that holds an apostrophe is still caught.
    expect(planRules(`open notepad and type "I'll call you back" then email it to John`)).toMatchObject({ lane: "unsupported" });
  });
});

describe("REVIEW-T2 R4 optional: politeness after a URL isn't a step", () => {
  test("'please', 'thanks' after the address still opens it; a real step still doesn't", () => {
    expect(planRules("open https://example.com/path?q=1, please")).toMatchObject({ lane: "executor", args: { url: "https://example.com/path?q=1" } });
    expect(planRules("open https://example.com please")).toMatchObject({ lane: "executor" });
    expect(planRules("open https://example.com, thanks")).toMatchObject({ lane: "executor" });
    expect(planRules("open https://example.com please and scroll down")).toMatchObject({ lane: "unsupported" });
  });
});

describe("blankTabIn: the whole request is one blank tab", () => {
  test("the phrasings that mean it, with or without the polite words", async () => {
    const { blankTabIn, planRules } = await import("./plan");
    for (const t of ["open Chrome and create a new tab", "Open Chrome, then make a new tab", "please open google chrome and open a new tab.", "open chrome and create a new tab please", "create a new tab", "open a new Chrome tab", "open a new tab in Chrome", "Jarvis, can you open Chrome and create a new tab?"]) expect(blankTabIn(t)).toBe(true);
    expect(planRules("open Chrome and create a new tab")).toMatchObject({ lane: "executor", executor: "browser.navigate", args: { blank: true } });
  });
  test("anything more in the same breath is not this rule", async () => {
    const { blankTabIn } = await import("./plan");
    for (const t of ["open a new Chrome tab, go to YouTube and search for Sydney weather", "open Chrome and go to example.com", "create a new tab and send an email", "open Chrome", "open a new tab for the lead's website"]) expect(blankTabIn(t)).toBe(false);
  });
});
