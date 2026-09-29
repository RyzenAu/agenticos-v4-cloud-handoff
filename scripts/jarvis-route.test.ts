// Registry-first Jarvis routing (AUDIT-F4 F2/F3/F9): the typed box (routeJarvisText) and the spoken turn
// (registryVoiceRoute, scripts/free-voice.ts) land in the same place; all 15 F4 navigation commands open
// their page; margins and prices are deterministic; "explain this margin" uses the page's own figures.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { localRuleAnswerIntent, overrideRuleAnswerIntent } from "../src/lib/commands/rule-guard";

// These tests pin this branch's own rule matchers, so they mean the same with or without Track 2 merged
// (Track 2's detector also claims margins and prices; its own tests cover that path).
beforeAll(() => overrideRuleAnswerIntent(localRuleAnswerIntent));
afterAll(() => overrideRuleAnswerIntent(null));
import { explainFromContext, routeHref, routeJarvisText, type JarvisRoute } from "../src/lib/commands/jarvis-route";
import { registryVoiceRoute } from "./commands/voice-route";
import { voiceDestination } from "../src/lib/voice-actions";
import { publishPageContext, readPageContext, resetPageContext, setActivePage } from "../src/lib/page-context";
import { freeVoiceTools } from "./free-voice";
import { DESTINATIONS } from "../src/components/shell/destinations";

afterEach(() => resetPageContext());

const apps = () => [{ name: "Notepad", id: "n" }, { name: "Settings", id: "s" }, { name: "Google Chrome", id: "c" }];
const typedDest = (r: JarvisRoute | null) =>
  !r ? "fallthrough" : r.kind === "navigate" ? `navigate ${routeHref(r)}` : r.kind === "open-url" ? `open ${r.url}` : r.kind === "device" ? `device ${r.plan.request.utterance}` : `say:${r.kind}`;
const spokenDest = async (text: string) => {
  const v = await registryVoiceRoute(text, apps);
  if (!v) return "fallthrough";
  if (v.tool?.name === "navigate") return `navigate ${v.tool.args.path}`;
  if (v.tool?.name === "open_url") return `open ${v.tool.args.url}`;
  return `say:${v.route.intent.startsWith("registry.answer") ? "answer" : v.route.intent.replace("registry.", "")}`;
};

// The F4 navigation block (AUDIT-F4-JARVIS.md §4.1), with the page each must open.
const CODING_PAGE = DESTINATIONS.some((d) => d.drilldowns.some((dd) => dd.to === "/coding"));
const F4_NAV: Array<[string, string, string]> = [
  ["N01", "open Today", "/business"], // Today is Home, the Business brief (29 Sep 2026)
  ["N02", "go to the Jarvis page", "/jarvis"],
  ["N03", "open the receptionist", "/receptionist"],
  ["N04", "take me to Work", "/work"],
  ["N05", "open memory", "/memory"],
  ["N06", "open finance", "/finance"],
  ["N07", "open Studio", "/studio"],
  ["N08", "open System", "/system"],
  ["N09", "open my leads", "/leads"],
  ["N10", "show me the calendar", "/calendar"],
  ["N11", "open operations", "/operations"],
  ["N12", "open the models page", "/models"],
  // Track 3 owns /coding (its registry contract moves the coding phrases there); without it merged the
  // request falls through the same way typed and spoken, never to the Claude Code sessions page.
  ["N13", "open the coding workspace", CODING_PAGE ? "/coding" : ""],
  ["N14", "go to settings", "/settings"],
  ["N15", "open the inbox", "/inbox"],
];

describe("F4 navigation: typed and spoken open the same page (15 of 15)", () => {
  for (const [id, text, path] of F4_NAV) {
    test(`${id} ${text}`, async () => {
      const typed = typedDest(routeJarvisText(text));
      const spoken = await spokenDest(text);
      if (!path) {
        expect(typed).toBe("fallthrough");
        expect(spoken).toBe("fallthrough");
        return;
      }
      expect(typed).toBe(`navigate ${path}`);
      expect(spoken).toBe(typed);
      // The client accepts the path (voice-companion navigate → voiceDestination).
      expect(voiceDestination(path)).toBeDefined();
    });
  }
});

describe("the three starter commands", () => {
  test("flagged calls: same page and section, typed and spoken", async () => {
    const r = routeJarvisText("open the receptionist's flagged calls");
    expect(r).toMatchObject({ kind: "navigate", path: "/receptionist", focus: "rx-flagged-calls" });
    const v = await registryVoiceRoute("open the receptionist's flagged calls", apps);
    expect(v?.tool).toEqual({ name: "navigate", args: { path: "/receptionist", focus: "rx-flagged-calls" } });
  });
  test("the Professional margin: the economics page for that package, with the deterministic figure", async () => {
    const r = routeJarvisText("show the Professional margin");
    expect(r && r.kind === "navigate" && routeHref(r)).toBe("/operations?package=receptionist-professional");
    expect(r?.said).toContain("contribution margin 80.8%");
    expect(await spokenDest("show the Professional margin")).toBe("navigate /operations?package=receptionist-professional");
    expect(voiceDestination("/operations?package=receptionist-professional")).toEqual({ path: "/operations", label: "Packages & economics", search: { package: "receptionist-professional" } });
  });
  test("open PowerPoint here: a device plan when typed; the voice turn's own PC rules when spoken", async () => {
    const index = { entries: [], sources: [], builtAt: 0 } as never;
    expect(routeJarvisText("open PowerPoint here", { index })).toBeNull();
    const withApps = routeJarvisText("open PowerPoint here", {
      index: (require("../src/lib/commands/registry") as typeof import("../src/lib/commands/registry")).buildCommandIndex({ apps: { state: "live", items: [{ name: "PowerPoint" }] } }),
    });
    expect(withApps).toMatchObject({ kind: "device", plan: { request: { utterance: "open PowerPoint" }, needsTargetPreview: true } });
    expect(await spokenDest("open PowerPoint here")).toBe("fallthrough");
  });
});

describe("margins and prices never come from a model", () => {
  test("F4 P01 'what's our margin on the Professional package': deterministic, typed and spoken", async () => {
    const t = routeJarvisText("what's our margin on the Professional package");
    expect(t?.kind).toBe("answer");
    expect(t?.said).toContain("80.8%");
    expect(t?.said).toMatch(/estimate/i);
    expect(await spokenDest("what's our margin on the Professional package")).toBe("say:answer");
  });
  test("F4 P04 'how much is the Premium package': the catalogue price first", async () => {
    const t = routeJarvisText("how much is the Premium package");
    expect(t?.said).toMatch(/^Premium is A\$1,999\.00/);
  });
});

describe("'explain this margin' uses the page's own figures, never a guess", () => {
  test("no page context → says it can't see which, and asks", async () => {
    const r = explainFromContext("explain this margin", readPageContext());
    expect(r?.said).toContain("won't guess");
  });
  test("Operations with Professional selected → its figures and source", async () => {
    setActivePage({ path: "/operations", destination: "receptionist", title: "Packages & economics" });
    publishPageContext("operations:economics", {
      selection: { kind: "package", id: "receptionist-professional", label: "Professional package", source: "src/lib/receptionist-packages.ts + src/lib/business-economics.ts", facts: { "Contribution margin": "80.8%", "Operating margin": "69.4%" } },
      sources: [{ id: "economics-model", label: "Package economics (estimate)", state: "simulated", source: "catalogue + model", lastSuccess: "2026-09-28" }],
    });
    const r = routeJarvisText("explain this margin", { context: readPageContext() });
    expect(r?.kind).toBe("explain");
    expect(r?.said).toContain("Contribution margin: 80.8%");
    expect(r?.said).toContain("Source: src/lib/receptionist-packages.ts");
    expect(r?.said).toContain("estimates");
  });
});

describe("what the registry leaves alone", () => {
  test("apps and folders stay with the PC rules; chat and questions fall through", async () => {
    for (const text of ["open notepad", "open windows settings", "open my Downloads folder", "write an email to Bianca", "what's on today", "status", "pay the Telstra bill", "yes", "okay open notepad instead"])
      expect(await spokenDest(text)).toBe("fallthrough");
    expect(routeJarvisText("write an email to Bianca")).toBeNull();
  });
  test("the voice navigate tool lists every destination (F3)", async () => {
    const nav = freeVoiceTools().find((t) => t.function.name === "navigate");
    const desc = JSON.stringify(nav);
    for (const p of ["/business", "/jarvis", "/receptionist", "/work", "/finance", "/studio", "/system", "/operations", "/models"]) expect(desc).toContain(p);
  });
  test("an unknown query on a known page is refused", async () => {
    expect(voiceDestination("/operations?package=../../x")).toBeUndefined();
    expect(voiceDestination("/today?redirect=https://example.com")).toBeUndefined();
  });
});

describe("AUDIT-F3 F3-01: Models, AI usage, Setup and System by typing and voice", () => {
  for (const [text, path] of [["open usage", "/usage"], ["open models", "/models"], ["go to setup", "/setup"], ["open system", "/system"], ["show usage", "/usage"]] as const) {
    test(text, async () => {
      expect(typedDest(routeJarvisText(text))).toBe(`navigate ${path}`);
      expect(await spokenDest(text)).toBe(`navigate ${path}`);
      expect(voiceDestination(path)).toBeDefined();
    });
  }
  test("'which models are free' and 'what needs setup' are answered from page data, typed and spoken (no chat)", async () => {
    expect(routeJarvisText("which models are free")).toMatchObject({ kind: "page-answer", query: "models.free" });
    expect((await registryVoiceRoute("which models are free", apps))?.tool).toEqual({ name: "page_answer", args: { query: "models.free" } });
    expect(routeJarvisText("what needs setup?")).toMatchObject({ kind: "page-answer", query: "setup.needed" });
    expect((await registryVoiceRoute("Jarvis, what needs setup", apps))?.tool).toEqual({ name: "page_answer", args: { query: "setup.needed" } });
  });
});

describe("AUDIT-F1 F1-06: Today, Work, Operations, Projects, Goals and a named lead", () => {
  for (const [text, path] of [["open today", "/business"], ["open work", "/work"], ["open operations", "/operations"], ["open projects", "/workspaces"], ["open goals", "/business?view=progress"]] as const) {
    test(text, async () => {
      expect(typedDest(routeJarvisText(text))).toBe(`navigate ${path}`);
      expect(await spokenDest(text)).toBe(`navigate ${path}`);
      expect(voiceDestination(path)).toBeDefined();
    });
  }
  test("'open the lead Harbour Test Dental' → the CRM search; several matches ask which, never the first", async () => {
    const { leadNameIn, pickLead } = await import("../src/lib/commands/jarvis-route");
    expect(leadNameIn("open the lead Harbour Test Dental")).toBe("Harbour Test Dental");
    expect(leadNameIn("show lead #12")).toBe("#12");
    expect((await registryVoiceRoute("open the lead Harbour Test Dental", apps))?.tool).toEqual({ name: "open_lead", args: { name: "Harbour Test Dental" } });
    expect(routeJarvisText("open the lead Harbour Test Dental")).toMatchObject({ kind: "open-lead", name: "Harbour Test Dental" });
    expect(pickLead("Harbour Test Dental", [{ leadId: 4, title: "Harbour Test Dental" }, { leadId: 9, title: "Harbour Test Dental Annex" }])).toEqual({ open: 4, title: "Harbour Test Dental" });
    expect(pickLead("Harbour", [{ leadId: 4, title: "Harbour Test Dental" }, { leadId: 9, title: "Harbour Physio" }])).toEqual({ ask: "Which one? Harbour Test Dental (#4), Harbour Physio (#9)." });
    expect(pickLead("Nobody", [])).toEqual({ none: 'No lead matches "Nobody".' });
  });
});

describe("page answers are built from the page's own data", () => {
  test("setup needed lists the attention tools; an unbuilt registry says so", async () => {
    const { setupNeededAnswer } = await import("../src/lib/commands/page-answers");
    expect(setupNeededAnswer({ generatedAt: null, capabilities: [] }).said).toContain("hasn't run");
    const said = setupNeededAnswer({ generatedAt: "2026-09-28T02:00:00Z", capabilities: [
      { id: "gmail", name: "Gmail", category: "mail", status: "setup-required", ownerAction: "connect it in Settings" },
      { id: "ok", name: "Calendar", category: "cal", status: "working" },
      { id: "x", name: "Hermes", category: "agent", status: "broken" },
    ] }).said;
    expect(said).toMatch(/^1 needs setup · 1 broken\. Hermes \(broken\); Gmail \(needs setup: connect it in Settings\)\.$/);
  });
});

describe("F4 re-run regressions: the registry never claims apps, files, folders or searches", () => {
  test("open Notepad, open my Downloads folder, open the file X, find my notes → not an OS page", async () => {
    for (const text of ["open Notepad", "open my Downloads folder", "open the file Synthetic Proposal", "find my notes about pricing"]) expect(routeJarvisText(text)).toBeNull();
  });
  test("F4 P03: a margin question with its own scenario gets the deterministic Jarvis margin answer", async () => {
    const r = routeJarvisText("what's the margin on Essential with 10 clients in a busy month");
    expect(r?.kind).toBe("answer");
    expect(r?.said).toContain("Essential");
    expect(r?.said).toContain("high usage, 10 clients");
    expect(await spokenDest("what's the margin on Essential with 10 clients in a busy month")).toBe("say:answer");
  });
});

describe("rules answer first (Track 2's request): the registry never turns them into a page", () => {
  test("receptionist status, spending and memory fall through to the rules, typed and spoken", async () => {
    const { ruleAnswerFirst } = await import("../src/lib/commands/rule-guard");
    for (const text of ["receptionist status", "what did I spend this month", "remember that Synthetic Dental Co prefers calls before 10 am"]) {
      expect(ruleAnswerFirst(text)).not.toBeNull();
      expect(routeJarvisText(text)).toBeNull();
      expect(await spokenDest(text)).toBe("fallthrough");
    }
    // Track 2's detector replaces this branch's when present (it also claims margins, prices, leads, reminders).
    overrideRuleAnswerIntent((t) => (/margin/i.test(t) ? "margin" : null));
    expect(routeJarvisText("show the Professional margin")).toBeNull();
    overrideRuleAnswerIntent(localRuleAnswerIntent);
    expect(routeJarvisText("show the Professional margin")?.kind).toBe("navigate");
  });
});

// REVIEW-T1 fix 2: money and action words are never dropped; typed and spoken match on the reviewer's probes.
describe("money, action and compound words go whole to the gated turn", () => {
  const withApps = async () => (await import("../src/lib/commands/registry")).buildCommandIndex({
    apps: { state: "live", items: [{ name: "Telstra" }, { name: "Send to OneNote" }, { name: "Microsoft Store" }, { name: "Gmail" }, { name: "PowerPoint" }] },
    sites: { state: "live", items: [{ id: "a", name: "Aldergate", url: "https://aldergate.muventures.com.au", kind: "flagship" }] },
  });
  const probes = [
    "press send", "click send", "click submit", "click delete", "click post", "press the publish button",
    "pay the Telstra bill", "buy it", "type my card number", "open stake.com",
    "open Telstra and pay the bill", "open microsoft store and buy minecraft", "open finance and pay Telstra",
    "open the inbox and send it", "open leads and delete them", "open gmail and delete everything", "open notepad and type hello",
  ];
  for (const text of probes) {
    test(text, async () => {
      const { actsOrPays } = await import("../src/lib/commands/action-guard");
      expect(actsOrPays(text)).not.toBeNull();
      expect(routeJarvisText(text, { index: await withApps() })).toBeNull();
      expect(await spokenDest(text)).toBe("fallthrough");
    });
  }
  test("the palette can't run a device or site entry on a partial match", async () => {
    const { searchCommands, mayRunEntry, parseCommandText } = await import("../src/lib/commands/registry");
    const index = await withApps();
    for (const text of ["pay the Telstra bill", "press send", "open stake.com"]) {
      const top = searchCommands(text, index, 3)[0];
      if (top) expect(mayRunEntry(top, parseCommandText(text).object)).toBe(false);
    }
    const ok = searchCommands("open PowerPoint here", index, 3)[0];
    expect(ok.entry.id).toBe("app:PowerPoint");
    expect(mayRunEntry(ok, parseCommandText("open PowerPoint here").object)).toBe(true);
  });
  test("plain opens still work: pages, a named site, an app, the starter commands", async () => {
    const index = await withApps();
    expect(routeJarvisText("open finance", { index })?.kind).toBe("navigate");
    expect(routeJarvisText("open aldergate", { index })?.kind).toBe("open-url");
    expect(routeJarvisText("open PowerPoint here", { index })?.kind).toBe("device");
    expect(routeJarvisText("open the receptionist's flagged calls", { index })?.kind).toBe("navigate");
  });
  test("review item 8: 'that call' with nothing on the page asks, typed and spoken", async () => {
    const r = routeJarvisText("open that call", { context: readPageContext() });
    expect(r).toMatchObject({ kind: "ask" });
    expect(await spokenDest("open that call")).toBe("say:ask");
  });
});
