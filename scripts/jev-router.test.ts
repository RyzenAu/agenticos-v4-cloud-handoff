import { describe, expect, test } from "bun:test";
import { BENCH_CASES } from "./jev-bench-cases";
import { JEV_URL } from "./jev";
import {
  COMPLETE_MIN,
  DecisionCache,
  HERMES_MIN,
  JevWarmer,
  OUTBOUND_MAX,
  THRESHOLDS,
  decide,
  extractApp,
  extractClickTarget,
  extractFolder,
  extractPage,
  extractSearch,
  extractSite,
  extractWebApp,
  normaliseUtterance,
  outboundBeyondApps,
  prefetchRoute,
  resolveIntent,
  routeUtterance,
  routerQuestions,
  speculativeCall,
  tierOf,
  type JevAnswers,
  type RouterSkill,
} from "./jev-router";

const APPS = ["Notepad", "Calculator", "Discord", "Obsidian", "Visual Studio Code", "Google Chrome", "WhatsApp", "Settings", "Free Claude Code", "File Explorer", "Microsoft Store"].map((name, i) => ({ name, id: `app${i}` }));
const ctx = (extra: Partial<{ ms: number; cached: boolean; skills: RouterSkill[] }> = {}) => ({ apps: APPS, skills: [], ms: 250, cached: false, ...extra });

/** Jev answers for the tree design: category + sub-choice + nouls. */
function tree(category: string, confidence = 0.99, sub: Record<string, { choice: string; confidence?: number }> = {}, nouls: Record<string, number> = {}): JevAnswers {
  const answers: JevAnswers = { category: { type: "choice", choice: category, confidence } };
  for (const [name, value] of Object.entries(sub)) answers[name] = { type: "choice", choice: value.choice, confidence: value.confidence ?? 0.99 };
  for (const [name, value] of Object.entries({ outbound: 0.02, multi: 0.05, complete: 0.95, listen: 0.05, ...nouls })) answers[name] = { type: "noul", noul: value };
  return answers;
}

const fakeJev = (answers: JevAnswers, calls: { n: number; body?: any } = { n: 0 }, status = 200) =>
  (async (_url: string, init: any) => {
    calls.n++;
    calls.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: "jev-latest", answers }), { status });
  }) as unknown as typeof fetch;

describe("normalising", () => {
  test("strips wake words, politeness and punctuation so repeats share a cache key", () => {
    expect(normaliseUtterance("Hey Jarvis, turn it down a bit, please.")).toBe("turn it down a bit");
    expect(normaliseUtterance("  Could you   turn it down a bit?  ")).toBe("turn it down a bit");
    expect(normaliseUtterance("What’s on screen?")).toBe("what's on screen");
  });
});

describe("slot extractors", () => {
  test("apps: exact names in paraphrases, aliases, prefixes and small typos", () => {
    expect(extractApp("fire up discord", APPS)?.name).toBe("Discord");
    expect(extractApp("can you get notepad going", APPS)?.name).toBe("Notepad");
    expect(extractApp("pop open the calculator", APPS)?.name).toBe("Calculator");
    expect(extractApp("boot up vs code", APPS)?.name).toBe("Visual Studio Code");
    expect(extractApp("get obsidan open", APPS)?.name).toBe("Obsidian");
    expect(extractApp("open the calculater", APPS)?.name).toBe("Calculator");
  });
  test("apps: nothing for OS pages, websites, filler or unknown names", () => {
    expect(extractApp("get me to my inbox", APPS)).toBeNull();
    expect(extractApp("open github", APPS)).toBeNull();
    expect(extractApp("fire it up", APPS)).toBeNull();
    expect(extractApp("fire up spotify", APPS)).toBeNull();
    expect(extractApp("open notepad", [])).toBeNull();
  });
  test("web apps stand in for apps that aren't installed", () => {
    expect(extractWebApp("fire up spotify")).toBe("https://open.spotify.com");
    expect(extractWebApp("fire up the thing")).toBeNull();
  });
  test("folders, pages and sites need the words to be there", () => {
    expect(extractFolder("show me my downloads folder")).toBe("Downloads");
    expect(extractFolder("open my downloads and documents")).toBeNull();
    expect(extractPage("get me to my inbox", "/inbox", 0.9)).toBe("/inbox");
    expect(extractPage("take me to the business dashboard")).toBe("/business");
    expect(extractPage("take me there", "/calendar", 0.6)).toBeNull();
    expect(extractPage("take me there", "/calendar", 0.95)).toBe("/calendar");
    expect(extractSite("put YouTube on", "https://www.youtube.com", 0.8)).toBe("https://www.youtube.com");
    expect(extractSite("go to muventures dot com dot au")).toBe("https://muventures.com.au");
    expect(extractSite("play lofi on youtube", "https://www.youtube.com", 0.99)).toBeNull();
    expect(extractSite("open that site", "https://github.com", 0.7)).toBeNull();
  });
  test("click targets and page search words", () => {
    expect(extractClickTarget("hit the subscribe button")).toBe("the subscribe button");
    expect(extractClickTarget("play the second result")).toBe("the second result");
    expect(extractClickTarget("click")).toBeNull();
    expect(extractClickTarget("that looks nice")).toBeNull();
    expect(extractSearch("search for lofi hip hop")).toBe("lofi hip hop");
    expect(extractSearch("search youtube for lofi")).toBeNull();
    expect(extractSearch("what's this")).toBeNull();
  });
});

describe("questions", () => {
  test("one request: category plus speculative sub-choices and safety nouls", () => {
    const q = routerQuestions("open example.com");
    expect(Object.keys(q)).toEqual(["category", "pc_action", "browser_action", "page", "site", "routine", "listen", "outbound", "multi", "complete"]);
    expect((q as any).category.criteria.skill).toBeUndefined();
    expect(Object.keys((q as any).site.criteria)).toContain("https://example.com");
  });
  test("skills add a category and a skill choice; flat design lists every intent", () => {
    const skills: RouterSkill[] = [{ id: "timer", description: "Set a countdown timer.", extract: () => null }];
    const q = routerQuestions("set a timer", skills) as any;
    expect(q.category.criteria.skill).toBeDefined();
    expect(Object.keys(q.skill.criteria)).toEqual(["timer", "none"]);
    const flat = routerQuestions("set a timer", skills, "flat") as any;
    expect(Object.keys(flat.intent.criteria)).toContain("pc.volume_down");
    expect(Object.keys(flat.intent.criteria)).toContain("skill.timer");
    expect(flat.category).toBeUndefined();
  });
  test("resolving: tree confidence is the weaker of category and action", () => {
    expect(resolveIntent(tree("pc", 0.9, { pc_action: { choice: "volume_down", confidence: 0.7 } }))).toEqual({ intent: "pc.volume_down", confidence: 0.7 });
    expect(resolveIntent(tree("pc", 0.9, { pc_action: { choice: "none" } })).confidence).toBe(0);
    expect(resolveIntent({ intent: { choice: "routine", confidence: 0.9 }, routine: { choice: "shutdown", confidence: 0.95 } })).toEqual({ intent: "routine.shutdown", confidence: 0.9 });
  });
});

describe("thresholds and gates", () => {
  test("each tier acts at its threshold and not below", () => {
    const at = (c: number) => decide("turn it down a bit", tree("pc", c, { pc_action: { choice: "volume_down" } }), ctx());
    expect(at(THRESHOLDS.act).kind).toBe("act");
    expect(at(THRESHOLDS.act - 0.01).kind).toBe("brain");
    const page = (c: number) => decide("get me to my inbox", tree("os_page", c, { page: { choice: "/inbox" } }), ctx());
    expect(page(THRESHOLDS.show)).toMatchObject({ kind: "act", call: { name: "navigate", arguments: { path: "/inbox" } } });
    expect(page(THRESHOLDS.show - 0.01).kind).toBe("brain");
    const lock = (c: number) => decide("lock the computer", tree("pc", c, { pc_action: { choice: "lock" } }), ctx());
    expect(lock(THRESHOLDS.strong).kind).toBe("act");
    expect(lock(THRESHOLDS.strong - 0.01).kind).toBe("brain");
    const hermes = (c: number) => decide("rename the screenshots on my desktop by date", tree("hermes", c), ctx());
    expect(hermes(HERMES_MIN)).toMatchObject({ kind: "act", call: { name: "control_pc" } });
    expect(hermes(HERMES_MIN - 0.01).kind).toBe("brain");
    expect(tierOf("pc.lock")).toBe("strong");
    expect(tierOf("routine.shutdown")).toBe("strong");
    expect(tierOf("website")).toBe("show");
  });
  test("outbound, incomplete and multi-step requests fall through to the brain", () => {
    const vol = (nouls: Record<string, number>, text = "turn it down a bit") => decide(text, tree("pc", 0.99, { pc_action: { choice: "volume_down" } }, nouls), ctx());
    expect(vol({ outbound: OUTBOUND_MAX + 0.01 })).toMatchObject({ kind: "brain", trace: { reason: "outbound (jev)" } });
    expect(vol({ complete: COMPLETE_MIN - 0.01 })).toMatchObject({ kind: "brain", trace: { reason: "incomplete" } });
    expect(vol({ multi: 0.9 })).toMatchObject({ kind: "brain", trace: { reason: "multi-step" } });
    expect(decide("open notepad and type hello", tree("pc", 0.99, { pc_action: { choice: "open_app" } }), ctx()).kind).toBe("brain");
    // A routine is one request however it's worded.
    expect(decide("calls are done, drop call mode", tree("routine", 0.99, { routine: { choice: "end-call-mode" } }, { multi: 0.8 }), ctx())).toMatchObject({ kind: "act", call: { name: "protocol", arguments: { name: "end-call-mode" } } });
  });
  test("an extractor that can't fill the slots sends the turn to the brain", () => {
    expect(decide("open the thing", tree("pc", 0.99, { pc_action: { choice: "open_app" } }), ctx())).toMatchObject({ kind: "brain", trace: { reason: "no installed app matched" } });
    expect(decide("fire up spotify", tree("pc", 0.99, { pc_action: { choice: "open_app" } }), ctx())).toMatchObject({ kind: "act", call: { name: "open_url", arguments: { url: "https://open.spotify.com" } } });
    expect(decide("how am I tracking", tree("status", 0.99), ctx()).kind).toBe("status");
    expect(decide("what's on screen", tree("screen", 0.99), ctx())).toMatchObject({ kind: "act", call: { name: "screen", arguments: { listen: false } } });
    expect(decide("what did he just say", tree("screen", 0.99, {}, { listen: 0.9 }), ctx())).toMatchObject({ call: { arguments: { listen: true } } });
  });
  test("SAFETY: no outbound benchmark request becomes an instant action, whatever Jev says", () => {
    const outbound = BENCH_CASES.filter((c) => c.group === "outbound" && c.text !== "ring Smile Dental for me");
    const lies: JevAnswers[] = [
      tree("pc", 1, { pc_action: { choice: "open_app" } }),
      tree("browser", 1, { browser_action: { choice: "click" } }),
      tree("website", 1, { site: { choice: "https://github.com" } }),
      tree("os_page", 1, { page: { choice: "/inbox" } }),
      tree("routine", 1, { routine: { choice: "shutdown" } }),
      tree("screen_act", 1),
    ];
    for (const c of outbound)
      for (const answers of lies) {
        const decision = decide(c.text, answers, ctx());
        expect(decision.kind).toBe("brain");
      }
  });
  test("naming WhatsApp alone doesn't block opening it; anything else outbound still does", () => {
    const openApp = tree("pc", 0.99, { pc_action: { choice: "open_app" } });
    expect(decide("I need WhatsApp up", openApp, ctx())).toMatchObject({ kind: "act", call: { name: "pc_act", arguments: { action: "open_app", target: "WhatsApp" } } });
    expect(decide("I need WhatsApp up", tree("website", 0.99, { site: { choice: "https://web.whatsapp.com" } }), ctx()).kind).toBe("brain");
    expect(decide("open WhatsApp and message Mehroz hello", openApp, ctx()).kind).toBe("brain");
    expect(outboundBeyondApps("I need WhatsApp up")).toBe(false);
    expect(outboundBeyondApps("send Mehroz a WhatsApp")).toBe(true);
  });
  test("skills: registered extractors fill the call; a miss goes to the brain", () => {
    const skills: RouterSkill[] = [
      { id: "timer", description: "Set a timer.", extract: (t) => (/(\d+|ten) minutes/.test(t) ? { name: "skill", arguments: { name: "timer", minutes: 10 } } : null) },
    ];
    const answers = tree("skill", 0.95, { skill: { choice: "timer" } });
    expect(decide("set a timer for ten minutes", answers, ctx({ skills }))).toMatchObject({ kind: "act", call: { name: "skill", arguments: { name: "timer" } } });
    expect(decide("set a timer", answers, ctx({ skills }))).toMatchObject({ kind: "brain", trace: { reason: "skill slots not filled" } });
  });
  test("cad: a spoken CAD spec becomes a cad call with his words as the spec", () => {
    const answers = tree("cad", 0.95);
    expect(decide("make a 40 by 20 by 5 mil bracket with two m4 holes 30 mil apart", answers, ctx())).toMatchObject({
      kind: "act",
      call: { name: "cad", arguments: { spec: "make a 40 by 20 by 5 mil bracket with two m4 holes 30 mil apart" } },
    });
    expect(decide("design me an enclosure for a raspberry pi", answers, ctx())).toMatchObject({ kind: "act", call: { name: "cad" } });
    expect(decide("open that model in FreeCAD", answers, ctx())).toMatchObject({ kind: "act", call: { name: "cad" } });
    // Below the act threshold it falls through like any other category.
    expect(decide("make a bracket", tree("cad", THRESHOLDS.act - 0.01), ctx()).kind).toBe("brain");
  });
});

describe("routing and cache", () => {
  const volume = tree("pc", 0.99, { pc_action: { choice: "volume_down" } });
  test("one Jev request in the documented shape, then a cache hit with no request", async () => {
    const calls = { n: 0 } as { n: number; body?: any };
    const cache = new DecisionCache();
    const first = await routeUtterance("Turn it down a bit.", { key: "k", request: fakeJev(volume, calls), apps: APPS, cache });
    expect(first).toMatchObject({ kind: "act", call: { name: "pc_act", arguments: { action: "volume", target: "down" } }, trace: { cached: false } });
    expect(calls.body.model).toBe("jev-latest");
    expect(calls.body.state).toEqual({ utterance: "Turn it down a bit." });
    const second = await routeUtterance("hey jarvis, turn it down a bit please", { key: "k", request: fakeJev(volume, calls), apps: APPS, cache });
    expect(second).toMatchObject({ kind: "act", trace: { cached: true, ms: 0 } });
    expect(calls.n).toBe(1);
  });
  test("no key, HTTP errors, timeouts and junk all mean the brain", async () => {
    const cache = new DecisionCache();
    expect((await routeUtterance("turn it down", { key: "", request: fakeJev(volume), cache })).kind).toBe("brain");
    expect((await routeUtterance("turn it down", { key: "k", request: fakeJev(volume, { n: 0 }, 429), cache })).kind).toBe("brain");
    const slow = (async (_u: string, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect((await routeUtterance("turn it down", { key: "k", request: slow, cache, timeoutMs: 20 })).kind).toBe("brain");
    const junk = (async () => new Response("not json")) as unknown as typeof fetch;
    expect((await routeUtterance("turn it down", { key: "k", request: junk, cache })).kind).toBe("brain");
    expect(cache.size).toBe(0);
  });
  test("outbound words skip Jev entirely", async () => {
    const calls = { n: 0 };
    const decision = await routeUtterance("send Mehroz a WhatsApp saying I'm late", { key: "k", request: fakeJev(volume, calls), cache: new DecisionCache() });
    expect(decision.kind).toBe("brain");
    expect(calls.n).toBe(0);
  });
  test("the request goes to TypeSafe with the key as a bearer token", async () => {
    let seen: any;
    const request = (async (url: string, init: any) => {
      seen = { url, auth: init.headers.Authorization };
      return new Response(JSON.stringify({ answers: volume }));
    }) as unknown as typeof fetch;
    await routeUtterance("turn it down", { key: "secret", request, cache: null });
    expect(seen).toEqual({ url: JEV_URL, auth: "Bearer secret" });
  });
  test("prefetch from a partial transcript makes the final turn free", async () => {
    const calls = { n: 0 };
    const cache = new DecisionCache();
    await prefetchRoute("turn it down a bit", { key: "k", request: fakeJev(volume, calls), cache });
    await prefetchRoute("turn it down a bit", { key: "k", request: fakeJev(volume, calls), cache });
    const decision = await routeUtterance("Turn it down a bit.", { key: "k", request: fakeJev(volume, calls), apps: APPS, cache });
    expect(decision).toMatchObject({ kind: "act", trace: { cached: true } });
    expect(calls.n).toBe(1);
  });
  test("speculative calls: show-only, confident, complete, no stakes", () => {
    const page = (c: number, nouls: Record<string, number> = {}) => decide("get me to my inbox", tree("os_page", c, { page: { choice: "/inbox" } }, nouls), ctx());
    expect(speculativeCall(page(0.95))).toEqual({ name: "navigate", arguments: { path: "/inbox" } });
    expect(speculativeCall(page(0.85))).toBeNull();
    expect(speculativeCall(page(0.95, { complete: 0.7 }))).toBeNull();
    expect(speculativeCall(page(0.95, { outbound: 0.25 }))).toBeNull();
    expect(speculativeCall(decide("turn it down a bit", volume, ctx()))).toBeNull();
    expect(speculativeCall({ kind: "brain", hint: "", trace: null })).toBeNull();
  });
  test("warmer: free HEAD pings to the API host while active, none once idle, never the key", async () => {
    let now = 0;
    const seen: Array<{ url: string; init: any }> = [];
    const warmer = new JevWarmer((async (url: string, init: any) => (seen.push({ url, init }), new Response(null, { status: 404 }))) as unknown as typeof fetch, 60_000, 1000, () => now);
    warmer.touch();
    expect(warmer.running).toBe(true);
    await warmer.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.typesafe.ai/");
    expect(seen[0].init.method).toBe("HEAD");
    expect(seen[0].init.headers).toBeUndefined();
    now = 5000;
    await warmer.tick();
    expect(seen).toHaveLength(1);
    expect(warmer.running).toBe(false);
  });
  test("warmer: every configured host gets its HEAD", async () => {
    const seen: string[] = [];
    const warmer = new JevWarmer((async (url: string) => (seen.push(url), new Response(null, { status: 404 }))) as unknown as typeof fetch, 60_000, 1000, Date.now, () => ["https://api.typesafe.ai", "https://api.groq.com"]);
    warmer.touch();
    await warmer.tick();
    warmer.stop();
    expect(seen.sort()).toEqual(["https://api.groq.com/", "https://api.typesafe.ai/"]);
  });
  test("cache: TTL expiry and least-recently-used eviction", () => {
    let now = 0;
    const cache = new DecisionCache(2, 1000, () => now);
    cache.set("a", volume);
    cache.set("b", volume);
    expect(cache.get("a")).not.toBeNull(); // a is now most recent
    cache.set("c", volume);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    now = 5000;
    expect(cache.get("a")).toBeNull();
  });
});

describe("screen_act: his real screen (scripts/screen-hands)", () => {
  test("a screen_act decision passes the whole utterance as the goal, even multi-step", () => {
    const out = decide("click the Name field and type Test", tree("screen_act", 0.9, {}, { multi: 0.9 }), ctx());
    expect(out).toMatchObject({ kind: "act", call: { name: "screen_act", arguments: { goal: "click the Name field and type Test" } } });
    expect(tierOf("screen_act")).toBe("act");
    expect(Object.keys(routerQuestions("x").category.criteria)).toContain("screen_act");
  });
  test("while he shares his screen, page actions mean that screen, not Jarvis Chrome", () => {
    const sharing = { ...ctx(), sharing: true };
    expect(decide("scroll down a bit", tree("browser", 0.95, { browser_action: { choice: "scroll_down" } }), sharing)).toMatchObject({ kind: "act", call: { name: "screen_act", arguments: { goal: "scroll down a bit" } } });
    expect(decide("hold the video there", tree("browser", 0.95, { browser_action: { choice: "pause" } }), sharing)).toMatchObject({ kind: "act", call: { name: "pc_act", arguments: { action: "media", target: "play_pause" } } });
    // Not sharing: unchanged.
    expect(decide("scroll down a bit", tree("browser", 0.95, { browser_action: { choice: "scroll_down" } }), ctx())).toMatchObject({ kind: "act", call: { name: "browser_act" } });
    // A site he names is still a website, sharing or not.
    expect(decide("open github", tree("website", 0.95, { site: { choice: "https://github.com" } }), sharing)).toMatchObject({ kind: "act", call: { name: "open_url" } });
  });
  test("outbound words still never reach an instant screen action through the router", () => {
    expect(decide("click send on this email to Brooke", tree("screen_act", 1), ctx()).kind).toBe("brain");
  });
});