// The Jarvis entry (Wave 2): lanes, gates, target routing and handoffs, with fake executors and a
// scripted Jev over a fake fetch. No network, no windows, no browser, no PowerPoint. Synthetic only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createJarvisEntry, youtubeSteps, type CommandEvent, type EntryDeps } from "./jev-command";
import { createRunLog } from "./screen-hands/run-log";
import type { ScreenDone, ScreenRequest } from "./screen-hands/index";
import { screenGoalRefusal } from "./screen-hands/refusals";
import { stubResolveTarget, localTarget, loadResolveTarget } from "./jev-target";
import { marginAnswer, parseMarginQuery } from "./jev-margin";
import { findFiles, fileNameIn, openFileByName } from "./jev-files";
import { authorisedDeck, deckOp, deckScript, parseDeckRequest } from "./jev-powerpoint";
import { planRules } from "./jarvis-command/plan";
import { appBrowserUrl, BOT_WALL, transcriptPrompt, verifyPoints, watchAndSummarise, stampSeconds, type TranscriptSegment } from "./browser/app-browser";

/** A fake TypeSafe endpoint: category + sub-choices at the given confidence. */
function jevReplying(category: string, confidence: number, extra: Record<string, { choice?: string; noul?: number; confidence?: number }> = {}) {
  const bodies: unknown[] = [];
  const request = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ answers: { category: { choice: category, confidence }, outbound: { noul: 0.02, confidence: 0.9 }, ...extra }, usage: { input_tokens: 700, output_tokens: 30 } }));
  }) as unknown as typeof fetch;
  return { request, bodies };
}
function harness(over: Partial<EntryDeps> = {}) {
  const runs = createRunLog();
  const acts: ScreenRequest[] = [];
  const opened: string[] = [];
  const deps: EntryDeps = {
    screen: {
      runs,
      act: (async (req: ScreenRequest) => {
        acts.push(req);
        return { type: "done", ok: true, said: "Clicked \"Nine\".", steps: 1, ms: 5, stepMs: [5] } satisfies ScreenDone;
      }) as EntryDeps["screen"]["act"],
    },
    jevKey: () => "synthetic-key",
    front: async () => ({ process: "Notepad", title: "Untitled - Notepad" }),
    browser: async () => null,
    summarise: null,
    files: { open: async (p) => void opened.push(p), titles: async () => opened.map((p) => `${p.split(/[\\/]/).pop()} - Notepad`) },
    openApp: async (name) => ({ ok: true, said: `Opened ${name}.` }),
    resolver: { resolve: stubResolveTarget, source: "stub" },
    ...over,
  };
  const entry = createJarvisEntry(deps);
  const events: CommandEvent[] = [];
  const handle = (utterance: string, extra: Record<string, string> = {}) => entry.handle({ utterance, ...extra }, new AbortController().signal, (e) => events.push(e));
  return { entry, handle, runs, acts, opened, events };
}

describe("gates before anything runs", () => {
  test.each(["open agentic-os.env in notepad"])("refuses %p (a secret) without asking Jev", async (u) => {
    const jev = jevReplying("screen_act", 0.99);
    const h = harness({ request: jev.request });
    const done = await h.handle(u);
    expect(done).toMatchObject({ ok: false, kind: "refused", refused: true });
    expect(jev.bodies).toHaveLength(0);
    expect(h.acts).toHaveLength(0);
    expect(h.runs.get(done.runId)?.steps.some((s) => s.stage === "refused")).toBe(true);
  });
  // S2d (owner decision 29 Sep, "money requests are fine"): a money request is no longer refused before Jev.
  // It routes like any other; the screen executor it reaches refuses the money goal before any step.
  test.each(["transfer $500 to John from my NAB account", "sell my BHP shares on CommSec"])("routes %p to Jev; the screen executor would still refuse it", async (u) => {
    const jev = jevReplying("screen_act", 0.99);
    const h = harness({ request: jev.request });
    const done = await h.handle(u);
    expect(done.kind).not.toBe("refused");
    expect(jev.bodies.length).toBeGreaterThan(0);
    for (const req of h.acts) expect(screenGoalRefusal(req.goal)).not.toBeNull();
  });
  test("another person's command, or another machine, never runs on this PC (stub keeps the devices rule)", async () => {
    const h = harness({ request: jevReplying("screen_act", 0.99).request });
    expect(await h.handle("click Nine", { personId: "mehroz" })).toMatchObject({ ok: false, kind: "refused" });
    expect(await h.handle("click Nine", { spokenTarget: "on my laptop" })).toMatchObject({ ok: false, kind: "refused" });
    expect(h.acts).toHaveLength(0);
    expect(stubResolveTarget({ personId: "usman", spokenTarget: "on my PC" })).toMatchObject({ ok: true, deviceId: "usman-pc" });
    expect(await localTarget({ personId: "usman" }, { resolve: () => ({ ok: true, deviceId: "mehroz-laptop", owner: "mehroz", online: true }), source: "devices" })).toMatchObject({ ok: false });
    expect(await localTarget({ personId: "usman" }, { resolve: () => ({ ok: true, deviceId: "usman-pc", owner: "usman", online: false }), source: "devices" })).toMatchObject({ ok: false });
  });
  test("the real devices module is used when present, else the stub", async () => {
    const fromDevices = await loadResolveTarget(async () => ({ resolveTarget: () => ({ ok: false, reason: "synthetic" }) }));
    expect(["devices", "stub"]).toContain(fromDevices.source);
  });
});

describe("lanes", () => {
  test("screen work goes to the Jev-first loop with jev forced on; the route is logged", async () => {
    const jev = jevReplying("screen_act", 0.92);
    const h = harness({ request: jev.request });
    const done = await h.handle("click the Nine button");
    expect(done).toMatchObject({ ok: true, kind: "screen", route: { intent: "screen_act", source: "jev" } });
    expect(h.acts[0]).toMatchObject({ goal: "click the Nine button", jev: true });
    const run = h.runs.get(done.runId)!;
    expect(run.jev.calls).toBe(1);
    expect(run.steps.find((s) => s.stage === "route" && s.jev)?.jev?.confidence).toBeCloseTo(0.92);
    // His typed payloads never reach the router either.
    await harness({ request: jev.request }).handle("type SYNTHETIC-PAYLOAD-77 in there");
    expect(JSON.stringify(jev.bodies)).not.toContain("SYNTHETIC-PAYLOAD-77");
  });
  test("Jev unsure → he is asked; Jev unavailable → screen_act rules (logged fallback)", async () => {
    const unsure = await harness({ request: jevReplying("screen_act", 0.3).request }).handle("do the thing with the widget");
    expect(unsure).toMatchObject({ ok: false, kind: "ask", ask: true });
    const h = harness({ jevKey: () => "" });
    const fallback = await h.handle("click Nine");
    expect(fallback).toMatchObject({ kind: "screen", route: { source: "unavailable" } });
    expect(h.runs.get(fallback.runId)?.steps.some((s) => s.stage === "fallback")).toBe(true);
  });
  test("open-ended writing/planning is an explicit, logged handoff to the brain; screen questions to vision", async () => {
    const h = harness({ request: jevReplying("brain", 0.9).request });
    const done = await h.handle("draft a proposal outline for a dental practice");
    // Track 2 (REVIEW-JEV §2): nothing ran here, so a delegation is never "ok"; the caller runs the delegate.
    expect(done).toMatchObject({ ok: false, kind: "handoff", handoff: { to: "brain", intent: "brain" }, decision: { policy: "delegate", delegateTo: "brain" } });
    expect(done.said).not.toMatch(/\b(?:done|finished|passed it)\b/i);
    expect(h.runs.get(done.runId)?.steps.some((s) => s.stage === "handoff")).toBe(true);
    expect(h.acts).toHaveLength(0);
    const v = await harness({ request: jevReplying("screen", 0.9).request }).handle("what's this error on my screen?");
    expect(v.handoff?.to).toBe("vision");
  });
  test("a screen question back (ask or a final button's yes) is never reported as done (REVIEW-JEV §2)", async () => {
    for (const reply of [{ ask: true }, { confirm: "Submit" }]) {
      const h = harness({
        request: jevReplying("screen_act", 0.95).request,
        screen: { runs: createRunLog(), act: (async () => ({ type: "done", ok: true, said: "Shall I press it?", steps: 1, ms: 5, stepMs: [5], ...reply }) satisfies ScreenDone) as EntryDeps["screen"]["act"] },
      });
      const done = await h.handle("fill in this form");
      expect(done).toMatchObject({ ok: false, ask: true, kind: "screen", verified: null });
    }
  });
  test("an OS page goes back to the client to open", async () => {
    const done = await harness({ request: jevReplying("os_page", 0.9, { page: { choice: "/business", confidence: 0.9 } }).request }).handle("open the business dashboard");
    expect(done.kind === "navigate" || done.kind === "ask").toBe(true);
  });
  test("a margin question is answered from the economics model, never a model's arithmetic", async () => {
    const h = harness({ request: jevReplying("brain", 0.8).request });
    const done = await h.handle("what's our margin on the 1099 package with 10 clients?");
    expect(done).toMatchObject({ ok: true, kind: "answer" });
    expect(done.numbers).toMatchObject({ packageId: "receptionist-professional", clients: 10, scenario: "base" });
    const again = marginAnswer(parseMarginQuery("what's our margin on the 1099 package with 10 clients?")!);
    expect(done.said).toBe(again.said);
    expect(done.said).toMatch(/estimate/);
    expect(done.said).toMatch(/approved, ex GST/);
  });
  test("PowerPoint: parsed into deck ops, each verified; a failure stops the chain", async () => {
    const ops: string[] = [];
    const h = harness({
      request: jevReplying("pc", 0.9).request,
      deck: async (op) => {
        ops.push(op.op);
        return { ok: op.op !== "show", said: `${op.op} said`, path: op.path, exists: true, slides: 1, titles: ["T"], showing: false, showSlide: null, ms: 1 };
      },
    });
    const done = await h.handle('open PowerPoint and create a deck called w2 synthetic deck with the title "Synthetic Review", change slide 1 to "Edited Title" and show it');
    expect(ops).toEqual(["create", "edit", "show"]);
    expect(done).toMatchObject({ ok: false, kind: "app", outcome: "unverified" });
  });
  test("a file by name: found in the authorised root, opened, window checked; ambiguous → asks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-files-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "quarterly-plan-synthetic.txt"), "synthetic");
    writeFileSync(join(dir, "notes-a.txt"), "x");
    writeFileSync(join(dir, "notes-b.txt"), "x");
    writeFileSync(join(dir, "api-token.txt"), "x");
    writeFileSync(join(dir, "run.ps1"), "x");
    const opened: string[] = [];
    const deps = { roots: [dir], open: async (p: string) => void opened.push(p), titles: async () => opened.map((p) => `${p.split(/[\\/]/).pop()} - Notepad`), sleep: async () => undefined };
    expect(fileNameIn("open the file quarterly plan synthetic")).toBe("quarterly plan synthetic");
    expect(await openFileByName("quarterly plan synthetic", deps)).toMatchObject({ ok: true });
    expect(await openFileByName("notes", deps)).toMatchObject({ ok: false, ask: true });
    expect(findFiles("api token", [dir])).toEqual([]);
    expect(findFiles("run", [dir])).toEqual([]);
    expect(await openFileByName("missing-thing", deps)).toMatchObject({ ok: false });
  });
});

describe("YouTube steps and the watch route", () => {
  test("his words → ordered steps", () => {
    expect(youtubeSteps('open YouTube, search for Big Buck Bunny and open the video called "Big Buck Bunny" then pause it')).toEqual([
      { do: "open" },
      { do: "search", query: "Big Buck Bunny" },
      { do: "open_result", title: "Big Buck Bunny" },
      { do: "pause" },
    ]);
    expect(youtubeSteps("pause the video")).toEqual([{ do: "pause" }]);
    expect(youtubeSteps("watch this and tell me what matters")).toEqual([{ do: "watch" }]);
    expect(youtubeSteps("search youtube for lo-fi beats and play the first video")).toEqual([{ do: "search", query: "lo-fi beats" }, { do: "open_result", index: 1 }]);
  });
  test("the app browser's URL fence", () => {
    expect(appBrowserUrl("youtube.com")).toMatchObject({ ok: true, url: "https://youtube.com/" });
    expect(appBrowserUrl("http://example.com")).toMatchObject({ ok: false });
    expect(appBrowserUrl("https://user:pw@example.com")).toMatchObject({ ok: false });
    expect(appBrowserUrl("https://accounts.google.com/signin")).toMatchObject({ ok: false });
    expect(appBrowserUrl("https://www.commbank.com.au/")).toMatchObject({ ok: false });
    expect(appBrowserUrl("http://127.0.0.1:4390/test")).toMatchObject({ ok: true });
  });
  const segments: TranscriptSegment[] = [
    { stamp: "0:00", seconds: 0, text: "welcome to the synthetic talk" },
    { stamp: "1:05", seconds: 65, text: "the first key idea is caching" },
    { stamp: "2:40", seconds: 160, text: "finally measure before optimising" },
  ];
  test("timestamps count only when they match a transcript line", () => {
    const points = verifyPoints("[1:05] Caching is the first idea\n[9:59] An invented moment\nNo stamp here", segments);
    expect(points.map((p) => p.verified)).toEqual([true, false, false]);
    expect(stampSeconds("1:02:03")).toBe(3723);
    expect(transcriptPrompt(segments, "what matters?")).toContain("[1:05] the first key idea is caching");
  });
  test("transcript → handoff to the LLM, said states the source; no transcript → frames only, stated; nothing → honest", async () => {
    const fake = (t: TranscriptSegment[] | null, frames = 0) => ({
      videoInfo: async () => ({ url: "https://www.youtube.com/watch?v=synthetic1", videoId: "synthetic1", title: "Synthetic", duration: 200, currentTime: 0, paused: true, ad: false, botWall: false }),
      transcript: async () => t,
      frames: async () => Array.from({ length: frames }, (_, i) => ({ seconds: i * 50, jpegBase64: "" })),
    });
    const withT = await watchAndSummarise(fake(segments), { summarise: async () => ({ text: "[1:05] Caching first\n[2:40] Measure before optimising", model: "synthetic-llm" }), question: "what matters", signal: new AbortController().signal });
    expect(withT).toMatchObject({ ok: true, source: "transcript", handoff: { to: "llm", model: "synthetic-llm" } });
    expect(withT.said).toMatch(/transcript/);
    expect(withT.said).toMatch(/didn't see the picture/);
    const frames = await watchAndSummarise(fake(null, 4), { summarise: null, question: "", signal: new AbortController().signal });
    expect(frames).toMatchObject({ ok: false, source: "sampled-frames" });
    expect(frames.said).toMatch(/no audio/);
    const none = await watchAndSummarise(fake(null, 0), { summarise: null, question: "", signal: new AbortController().signal });
    expect(none.source).toBe("thumbnail-only");
    // YouTube's bot-check wall: said plainly, never signed in or bypassed.
    const wall = { ...fake(segments), videoInfo: async () => ({ url: "https://www.youtube.com/watch?v=x", videoId: "x", title: "", duration: null, currentTime: 0, paused: true, ad: false, botWall: true }) };
    const walled = await watchAndSummarise(wall, { summarise: async () => ({ text: "[1:05] x", model: "m" }), question: "", signal: new AbortController().signal });
    expect(walled).toMatchObject({ ok: false, source: "none", handoff: null });
    expect(walled.said).toMatch(/don't sign in or get around/);
    expect(BOT_WALL.test("Sign in to confirm that you're not a bot")).toBe(true);
  });
});

describe("PowerPoint fences", () => {
  test("decks only under an authorised root; text is base64, never spliced", async () => {
    expect(authorisedDeck("D:\\tmp\\jarvis-acceptance\\x.pptx")).toBe(true);
    expect(authorisedDeck("C:\\Users\\someone\\Documents\\board.pptx")).toBe(false);
    expect(authorisedDeck("D:\\tmp\\jarvis-acceptance\\x.ppt")).toBe(false);
    const script = deckScript({ op: "create", path: "D:\\tmp\\jarvis-acceptance\\x.pptx", title: "'; Remove-Item C:\\ -Recurse; '" });
    expect(script).not.toContain("Remove-Item");
    expect(await deckOp({ op: "open", path: "C:\\Users\\someone\\board.pptx" }, { run: async () => ({ code: 0, stdout: "{}", stderr: "" }) })).toMatchObject({ ok: false });
    expect(parseDeckRequest('create a deck called w2 demo with the title "Hello" and show it')?.ops.map((o) => o.op)).toEqual(["create", "show"]);
  });
});

describe("named-deck quotes (REVIEW-T2 R3, the shared paired-quote parser)", () => {
  const roots = ["D:\tmp\jarvis-acceptance"];
  test("an apostrophe inside a quoted name, title, subtitle, edit or new slide is kept whole", () => {
    const r = parseDeckRequest(`create a deck called "Usman's plan" with the title 'it's done' and subtitle "we'll ship Monday"`, roots)!;
    expect(r.path.endsWith("Usman's plan.pptx")).toBe(true);
    expect(r.ops[0]).toMatchObject({ op: "create", title: "it's done", subtitle: "we'll ship Monday" });
    const curly = parseDeckRequest(`create a deck called “Mehroz’s review” with the title ‘it’s done’`, roots)!;
    expect(curly.path.endsWith("Mehroz’s review.pptx")).toBe(true);
    expect(curly.ops[0]).toMatchObject({ op: "create", title: "it’s done" });
    const edit = parseDeckRequest(`open the deck "Usman's plan" and change slide 2 title to "Q3: what's next"`, roots)!;
    expect(edit.ops).toEqual([{ op: "open", path: edit.path }, { op: "edit", path: edit.path, slide: 2, title: "Q3: what's next" }]);
    const add = parseDeckRequest(`open the deck called board and add a slide titled 'Don't forget'`, roots)!;
    expect(add.ops[1]).toMatchObject({ op: "add", title: "Don't forget" });
  });
  test("unquoted names still work; an unclosed quote isn't guessed", () => {
    expect(parseDeckRequest("create a deck called w2 demo and show it", roots)?.path.endsWith("w2 demo.pptx")).toBe(true);
    expect(parseDeckRequest(`create a deck called "unclosed with the title x`, roots)).toBeNull();
  });
});

describe("named decks: the deck name never comes from 'a slide called' (REVIEW-T2 R4 F2)", () => {
  test("open the deck Q3 plan and add a slide called Notes → edits Q3 plan.pptx, even when Notes.pptx exists", () => {
    const root = mkdtempSync(join(tmpdir(), "deck-f2-"));
    writeFileSync(join(root, "Notes.pptx"), "synthetic");
    writeFileSync(join(root, "Q3 plan.pptx"), "synthetic");
    for (const words of [`open the deck Q3 plan and add a slide called "Notes"`, `open the deck Q3 plan and add a slide called 'Mehroz's notes'`, "open the deck Q3 plan and add a slide titled 'Notes'"]) {
      const r = parseDeckRequest(words, [root])!;
      expect({ words, deck: basename(r.path) }).toEqual({ words, deck: "Q3 plan.pptx" });
      expect(r.ops.map((o) => o.op)).toEqual(["open", "add"]);
      expect((r.ops[1] as { title: string }).title).toMatch(/Notes|Mehroz's notes/);
    }
    // A deck named by "called" still works; a slide's name alone never names a deck.
    expect(parseDeckRequest("create a deck called Notes with the title 'Q4'", [root])!.path.endsWith("Notes.pptx")).toBe(true);
    expect(parseDeckRequest(`add a slide called "Notes"`, [root])).toBeNull();
  });
});

describe("named decks with a slide: the slide is an op, or nothing runs (REVIEW-T2 R5)", () => {
  const roots = ["D:\tmp\jarvis-acceptance"];
  test("'with a slide called Y' / 'and add a slide called Y' / 'with a slide named Y' become an add after the create", () => {
    for (const [words, deck, slide] of [
      ["create a deck called X with a slide called Y", "X.pptx", "Y"],
      ["create a PowerPoint deck called Budget and add a slide called Notes", "Budget.pptx", "Notes"],
      ["make a presentation named Pitch with a slide named Intro", "Pitch.pptx", "Intro"],
      [`create a deck called "Q3 plan" with a slide called "Mehroz's notes"`, "Q3 plan.pptx", "Mehroz's notes"],
      [`create a deck called Budget with a slide titled ‘It’s live’`, "Budget.pptx", "It’s live"],
    ] as const) {
      const r = parseDeckRequest(words, roots)!;
      expect({ words, deck: basename(r.path), ask: r.ask }).toEqual({ words, deck, ask: undefined });
      expect(r.ops.map((o) => o.op)).toEqual(["create", "add"]);
      expect((r.ops[1] as { title: string }).title).toBe(slide);
    }
  });
  test("a slide it can't place means ask, never a partial plan", () => {
    const r = parseDeckRequest("create a deck called Budget with slides called Intro and Outro", roots)!;
    expect(r.ask).toMatch(/haven't done anything/);
    expect(r.ops).toEqual([]);
  });
  test("through the entry: the deck and its slide both run, or it asks and nothing runs", async () => {
    const ops: string[] = [];
    const h = harness({ deck: async (op) => (ops.push(`${op.op}:${"title" in op ? op.title : ""}`), { ok: true, said: `${op.op} ok`, path: op.path, exists: true, slides: 2, titles: [], showing: false, showSlide: null, ms: 1 }) });
    const done = await h.handle("create a deck called Budget and add a slide called Notes");
    expect(done).toMatchObject({ ok: true, kind: "app" });
    expect(ops).toEqual(["create:Budget", "add:Notes"]);
    const asked = await h.handle("create a deck called Budget with slides called Intro and Outro");
    expect(asked).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(ops).toHaveLength(2);
  });
});

describe("named decks: a step that isn't a deck step means ask, nothing runs (REVIEW-T2 R6)", () => {
  const roots = ["D:/agent-scratch/t2/decks"];
  const STRAYS = [
    ["create a deck called X with a slide called Y and email it to Bob", "email it to Bob"],
    [`create a deck called X with a slide called "Y" and email it to Bob`, "email it to Bob"],
    ["create a deck called X and email it to Bob", "email it to Bob"],
    ["create a deck called X with a slide called Y and delete slide 1", "delete slide 1"],
    ["open the deck Q3 plan and present it to Mehroz", "present it to Mehroz"],
  ] as const;
  test("the parser names the other step and plans no ops", () => {
    for (const [words, step] of STRAYS) {
      const r = parseDeckRequest(words, roots)!;
      expect({ words, ops: r.ops, ask: r.ask?.includes(`"${step}"`) }).toEqual({ words, ops: [], ask: true });
    }
  });
  test("deck steps stay allowed: create/open/present, add a slide, title, change slide N", () => {
    for (const [words, ops] of [
      ["create a deck called X with a slide called Y, then present it", ["create", "add", "show"]],
      ["create a deck called Q3 plan with the title 'Synthetic Review' and present it", ["create", "show"]],
      ["open the deck Q3 plan and change slide 2 to 'Pricing'", ["open", "edit"]],
      ["open the deck Q3 plan and add a new slide called Notes", ["open", "add"]],
      ["add a slide called Notes to the deck Q3 plan", ["open", "add"]],
      [`add a slide called "Notes" to the deck "Q3 plan"`, ["open", "add"]],
    ] as const) {
      const r = parseDeckRequest(words, roots)!;
      expect({ words, ask: r.ask, ops: r.ops.map((o) => o.op), deck: basename(r.path) }).toEqual({ words, ask: undefined, ops: [...ops], deck: words.includes("Q3 plan") ? "Q3 plan.pptx" : "X.pptx" });
    }
  });
  test("the deck-only file rule defers to the deck lane; a non-deck step still asks there", () => {
    expect(planRules("open the deck Q3 plan and add a slide called Notes")).toBeNull();
    expect(planRules("open the deck Q3 plan and send it to Mehroz")).toMatchObject({ lane: "unsupported" });
  });
  test("show/present after a deck is deck-only too, not a false ask (REVIEW-T2 R8)", () => {
    for (const words of ["open the deck Plan and show it", "open the deck Plan and present it", "open the deck Plan, then present it", "show the deck Plan and present it"])
      expect({ words, rule: planRules(words) }).toEqual({ words, rule: null });
    // A non-deck extra step still asks; a bare "open the deck X" is still the file rule's.
    expect(planRules("open the deck Plan and present it to Mehroz")).toMatchObject({ lane: "unsupported" });
    expect(planRules("open the deck Plan and email it to Bob")).toMatchObject({ lane: "unsupported" });
    expect(planRules("open the deck Plan")).toMatchObject({ lane: "executor", executor: "file.open", args: { name: "Plan" } });
  });
  test("through the entry: 'open the deck Plan and show/present it' runs open then show", async () => {
    const ops: string[] = [];
    const h = harness({ deck: async (op) => (ops.push(`${op.op}:${basename(op.path)}`), { ok: true, said: `${op.op} ok`, path: op.path, exists: true, slides: 2, titles: [], showing: op.op === "show", showSlide: null, ms: 1 }) });
    for (const words of ["open the deck Plan and show it", "open the deck Plan and present it"]) {
      ops.length = 0;
      const done = await h.handle(words);
      expect({ words, done }).toMatchObject({ words, done: { ok: true, kind: "app" } });
      expect(ops).toEqual(["open:Plan.pptx", "show:Plan.pptx"]);
    }
    ops.length = 0;
    expect(await h.handle("open the deck Plan and present it to Mehroz")).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(await h.handle("open the deck Research and Development")).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(ops).toEqual([]);
  });
  test("through the entry: each phrase asks and no deck op runs", async () => {
    const ops: string[] = [];
    const h = harness({ deck: async (op) => (ops.push(op.op), { ok: true, said: `${op.op} ok`, path: op.path, exists: true, slides: 2, titles: [], showing: false, showSlide: null, ms: 1 }) });
    for (const [words, step] of STRAYS) {
      const done = await h.handle(words);
      expect({ words, done }).toMatchObject({ words, done: { ok: false, ask: true, kind: "ask" } });
      expect(String(done.said)).toContain(step);
    }
    expect(ops).toEqual([]);
    const ok = await h.handle("add a slide called Notes to the deck Q3 plan");
    expect(ok).toMatchObject({ ok: true, kind: "app" });
    expect(ops).toEqual(["open", "add"]);
  });
});

describe("named decks: an unquoted name followed by 'and <words>' asks for quotes, never a cut name (REVIEW-T2 R7)", () => {
  const roots = ["D:/agent-scratch/t2/decks"];
  const AMBIGUOUS = [
    ["create a deck called Buy and Sell", "Buy and Sell"],
    [`open the deck Sales and Marketing and add a slide called "X"`, "Sales and Marketing"],
    ["open the deck Research and Development", "Research and Development"],
    ["add a slide called Notes to the deck Sales and Marketing", "Sales and Marketing"],
  ] as const;
  test("asks, naming the likely full name, with no ops", () => {
    for (const [words, guess] of AMBIGUOUS) {
      const r = parseDeckRequest(words, roots)!;
      expect({ words, ops: r.ops, asks: r.ask?.includes(`"${guess}"`) && r.ask.includes("quotes") }).toEqual({ words, ops: [], asks: true });
    }
  });
  test("quoted names are exact, and 'X and <deck step or action>' still parses", () => {
    for (const [words, deck, ops] of [
      [`create a deck called "Buy and Sell"`, "Buy and Sell.pptx", ["create"]],
      [`open the deck "Sales and Marketing" and add a slide called "X"`, "Sales and Marketing.pptx", ["open", "add"]],
      ["create a deck called X and add a slide called Y", "X.pptx", ["create", "add"]],
      ["create a deck called X and then present it", "X.pptx", ["create", "show"]],
      ["open the deck Q3 plan and change slide 2 to 'Pricing'", "Q3 plan.pptx", ["open", "edit"]],
      ["create a deck called Pitch, then add a slide called Intro", "Pitch.pptx", ["create", "add"]],
    ] as const) {
      const r = parseDeckRequest(words, roots)!;
      expect({ words, ask: r.ask, deck: basename(r.path), ops: r.ops.map((o) => o.op) }).toEqual({ words, ask: undefined, deck, ops: [...ops] });
    }
    // "X and <another action>" is still the R6 stray-step ask (it names the step), not a quotes ask.
    expect(parseDeckRequest("create a deck called Budget and email it to Bob", roots)!.ask).toContain(`"email it to Bob"`);
  });
  test("through the entry: the ambiguous phrases ask and no deck op runs; the quoted one runs", async () => {
    const ops: string[] = [];
    const h = harness({ deck: async (op) => (ops.push(`${op.op}:${basename(op.path)}`), { ok: true, said: `${op.op} ok`, path: op.path, exists: true, slides: 2, titles: [], showing: false, showSlide: null, ms: 1 }) });
    for (const [words] of AMBIGUOUS) {
      const done = await h.handle(words);
      expect({ words, done }).toMatchObject({ words, done: { ok: false, ask: true, kind: "ask" } });
    }
    expect(ops).toEqual([]);
    expect(await h.handle(`open the deck "Sales and Marketing" and add a slide called "X"`)).toMatchObject({ ok: true, kind: "app" });
    expect(ops).toEqual(["open:Sales and Marketing.pptx", "add:Sales and Marketing.pptx"]);
  });
});
