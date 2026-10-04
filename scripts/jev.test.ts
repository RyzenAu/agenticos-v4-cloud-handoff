import { describe, expect, test } from "bun:test";
import { JEV_URL, jevReflex, reflexHint, reflexQuestions, reflexToolCall, speculativeToolCall, spokenUrls, type Reflex } from "./jev";

const reply = (answers: Record<string, unknown>, status = 200) =>
  (async () => new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 40, output_tokens: 0 } }), { status })) as unknown as typeof fetch;

const base: Reflex = { lane: "navigate", laneConfidence: 0.95, page: "/calendar", pageConfidence: 0.93, siteConfidence: 0, complete: 0.9, addressed: 0.95, stakes: 0.02, ms: 240 };

describe("request", () => {
  test("one fan-out request in TypeSafe's documented shape", async () => {
    let sent: any;
    const fake = (async (url: string, init: any) => {
      sent = { url, init };
      return new Response(JSON.stringify({ answers: { lane: { type: "choice", choice: "open_url", confidence: 0.97 }, site: { type: "choice", choice: "https://www.youtube.com", confidence: 0.96 }, page: { type: "choice", choice: "none", confidence: 0.9 }, complete: { type: "noul", noul: 0.93 }, addressed: { type: "noul", noul: 0.97 }, stakes: { type: "noul", noul: 0.01 } } }));
    }) as unknown as typeof fetch;
    const reflex = await jevReflex("open YouTube", "key-123", fake);
    expect(sent.url).toBe(JEV_URL);
    expect(sent.init.headers.Authorization).toBe("Bearer key-123");
    const body = JSON.parse(sent.init.body);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["lane", "page", "site", "complete", "addressed", "stakes"]);
    expect(body.questions.lane.type).toBe("choice");
    expect(body.questions.stakes.type).toBe("noul");
    expect(reflex).toMatchObject({ lane: "open_url", site: "https://www.youtube.com", page: undefined });
  });
  test("no key, HTTP errors, unknown lanes and network failures mean no reflex", async () => {
    expect(await jevReflex("open YouTube", "", reply({}))).toBeNull();
    expect(await jevReflex("open YouTube", "k", reply({}, 429))).toBeNull();
    expect(await jevReflex("open YouTube", "k", reply({ lane: { type: "choice", choice: "format_disk", confidence: 1 } }))).toBeNull();
    expect(await jevReflex("open YouTube", "k", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
  test("spoken addresses become candidate sites", () => {
    expect(spokenUrls("open muventures dot com dot au please")).toEqual(["https://muventures.com.au"]);
    expect(spokenUrls("go to https://example.com/path and github.com")).toEqual(["https://example.com/path", "https://github.com"]);
    expect(Object.keys(reflexQuestions("open example.com").sites)).toContain("https://example.com");
  });
});

describe("fast path", () => {
  test("confident navigation, sites, PC tasks, email and memory act straight away", () => {
    expect(reflexToolCall(base, "open my calendar")).toEqual({ name: "navigate", arguments: { path: "/calendar" } });
    expect(reflexToolCall({ ...base, lane: "open_url", site: "https://www.youtube.com", siteConfidence: 0.95 }, "open YouTube")).toEqual({ name: "open_url", arguments: { url: "https://www.youtube.com" } });
    expect(reflexToolCall({ ...base, lane: "control_pc" }, "open Notepad")).toEqual({ name: "control_pc", arguments: { task: "open Notepad" } });
    expect(reflexToolCall({ ...base, lane: "get_recent_emails" }, "any new emails?")).toEqual({ name: "get_recent_emails", arguments: {} });
    expect(reflexToolCall({ ...base, lane: "search_memory" }, "what did we decide on pricing")).toEqual({ name: "search_memory", arguments: { query: "what did we decide on pricing" } });
  });
  test("the brain decides when Jev is unsure, he hasn't finished, it isn't for Jarvis, or text must be written", () => {
    expect(reflexToolCall({ ...base, laneConfidence: 0.7 }, "open my calendar")).toBeNull();
    expect(reflexToolCall({ ...base, complete: 0.3 }, "open my")).toBeNull();
    expect(reflexToolCall({ ...base, addressed: 0.2 }, "open my calendar")).toBeNull();
    expect(reflexToolCall({ ...base, pageConfidence: 0.6 }, "open my calendar")).toBeNull();
    expect(reflexToolCall({ ...base, lane: "search_saved_emails" }, "show Brooke's email")).toBeNull();
    expect(reflexToolCall({ ...base, lane: "chat" }, "tell me a joke")).toBeNull();
    expect(reflexToolCall(null, "anything")).toBeNull();
  });
  test("searches keep their words: no fast path to a site's home page", () => {
    const youtube = { ...base, lane: "open_url" as const, site: "https://www.youtube.com", siteConfidence: 0.97 };
    expect(reflexToolCall(youtube, "search YouTube for Road to Apex Predator")).toBeNull();
    expect(reflexToolCall(youtube, "play that video")).toBeNull();
    expect(reflexToolCall(youtube, "open YouTube")).toEqual({ name: "open_url", arguments: { url: "https://www.youtube.com" } });
  });
  test("a consequential PC task still goes to control_pc unconfirmed, so the spoken-yes gate asks", () => {
    const call = reflexToolCall({ ...base, lane: "control_pc", stakes: 0.97 }, "send Mehroz a WhatsApp");
    expect(call).toEqual({ name: "control_pc", arguments: { task: "send Mehroz a WhatsApp" } });
    expect(reflexHint({ ...base, stakes: 0.97 })).toContain("needs his yes");
  });
});

describe("speculative (act while he speaks)", () => {
  test("only show-only actions, only when Jev is sure and the request sounds finished", () => {
    expect(speculativeToolCall(base, "open my calendar")).toEqual({ name: "navigate", arguments: { path: "/calendar" } });
    const site: Reflex = { ...base, lane: "open_url", page: undefined, pageConfidence: 0, site: "https://www.youtube.com", siteConfidence: 0.96 };
    expect(speculativeToolCall(site, "open youtube")).toEqual({ name: "open_url", arguments: { url: "https://www.youtube.com" } });
    // Stricter than the end-of-speech fast path on every axis.
    expect(speculativeToolCall({ ...base, laneConfidence: 0.88 }, "open my calendar")).toBeNull();
    expect(speculativeToolCall({ ...base, pageConfidence: 0.88 }, "open my calendar")).toBeNull();
    expect(speculativeToolCall({ ...base, complete: 0.7 }, "open my")).toBeNull();
    expect(speculativeToolCall({ ...base, addressed: 0.6 }, "open my calendar")).toBeNull();
    expect(speculativeToolCall({ ...base, stakes: 0.3 }, "open my calendar")).toBeNull();
    // Anything that runs a task or reads data waits for the end of speech.
    expect(speculativeToolCall({ ...base, lane: "control_pc" }, "open WhatsApp")).toBeNull();
    expect(speculativeToolCall({ ...base, lane: "get_recent_emails" }, "any new emails")).toBeNull();
    expect(speculativeToolCall({ ...site }, "search youtube for cats")).toBeNull();
    expect(speculativeToolCall(null, "open my calendar")).toBeNull();
  });
});
