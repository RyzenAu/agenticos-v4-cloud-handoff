// Regression tests for audit 1's findings in the Agents workspace (F-05, F-06, F-07, F-08, F-12, F-15, F-16).
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAgentBots, seedBots, type BotView } from "@/lib/agent-bots";
import { Composer } from "./chat/composer";
import { ManageSection } from "./setup/manage-section";
import { SetupNav, SkillsSection, ModelSection } from "./setup/sections";
import { createSetupController } from "./setup/setup-controller";
import { cardReasons, linkedRoutineNames, routeDisclosure, routeGroups, skillsSectionShown } from "./setup/setup-model";
import { computer, fixtureSources } from "./setup/setup-fixtures";
import { chatBannerStatus, inputOff } from "./workspace/slots";
import { deriveBotStatus, shortStatus, statusAction } from "./workspace/status";
import type { Bot } from "./workspace/bots";

const dom = (el: ReactElement) => {
  const { document } = parseHTML(`<!doctype html><html><body>${renderToStaticMarkup(el).replace(/<!-- -->/g, "")}</body></html>`);
  return { document, text: document.body.textContent ?? "" };
};
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const bot = (over: Partial<Bot> = {}): Bot => ({ id: "research", name: "Research", purpose: "p", computer: null, coding: { enabled: false, accountSlot: null, model: null }, ...over });
const research = seedBots()[0]! as BotView;
const builder = seedBots()[1]! as BotView;
const idle = { saving: false, savedAt: null, error: null };

describe("F-05: a bot with no computer says so once, in one word and one sentence", () => {
  test("none chosen, or a chosen one that isn't on the hub: the same state, the same words, one action", () => {
    const none = deriveBotStatus({ bot: bot(), computer: null, me: "usman" });
    const gone = deriveBotStatus({ bot: bot({ computer: "research" }), computer: null, me: "usman" });
    expect([none.kind, gone.kind]).toEqual(["unconfigured", "unconfigured"]);
    expect(none.text).toBe("No computer yet. Choose one in Setup");
    expect(gone.text).toBe('No computer: "research" isn\'t on this hub. Choose one in Setup');
    expect(shortStatus(none, bot())).toBe("No computer");
    expect(statusAction(none, bot())).toEqual({ label: "Choose a computer", tab: "setup" });
    for (const t of [none.text, gone.text, shortStatus(none, bot())]) expect(t).not.toMatch(/Offline|Not set up/);
  });
  test("the conversation adds no 'not set up' banner of its own, only a box that is off", () => {
    const slots = read("./workspace/slots.tsx");
    expect(slots).not.toMatch(/status=\{chatStatusFrom/);
    expect(slots).toContain("inputDisabled={inputOff(bot, status)}");
    expect(chatBannerStatus(bot({ computer: null }), { kind: "unconfigured" })).toBeUndefined();
    expect(inputOff(bot(), { kind: "unconfigured" })).toContain("Choose a computer");
  });
  test("Setup's card keeps only reasons the header can't say; the computer ones are dropped", () => {
    const left = cardReasons([
      { code: "computer-missing", text: "no computer", fix: { kind: "open-computer" } },
      { code: "coding-no-account", text: "Coding jobs have no account chosen.", fix: { kind: "open-setup-section", target: "model" } },
    ]);
    expect(left.map((r) => r.code)).toEqual(["coding-no-account"]);
    // the hub's own wording for a bot with nothing to run on is about the computer too, whatever its code or fix
    expect(cardReasons([{ code: "nowhere-to-work", text: "Scout copy has no computer and coding is off, so there is nowhere for it to work. Pick a computer in Setup.", fix: { kind: "open-setup-section", target: "computer" } }])).toEqual([]);
  });
});

describe("F-06: Reconnect is not a dead button", () => {
  test("the banner's Reconnect is wired to the real reconnect; the banner never shows for an archived bot or one with no computer", () => {
    const slots = read("./workspace/slots.tsx");
    expect(slots).toContain("reconnectComputer(computer, bot.computer)");
    expect(chatBannerStatus(bot({ computer: "research" }), { kind: "offline" })).toEqual({ state: "offline" });
    expect(chatBannerStatus(bot({ computer: "research", lifecycle: "archived" }), { kind: "offline" })).toBeUndefined();
    expect(chatBannerStatus(bot({ computer: null }), { kind: "offline" })).toBeUndefined();
    expect(chatBannerStatus(bot({ computer: "research" }), { kind: "ready" })).toBeUndefined();
    const archived = deriveBotStatus({ bot: bot({ lifecycle: "archived" }), computer: null, me: "usman" });
    expect(statusAction(archived, bot({ lifecycle: "archived" }))).toEqual({ label: "Open Setup", tab: "setup" });
    expect(archived.text).not.toMatch(/Reconnect|offline/i);
    const offline = deriveBotStatus({ bot: bot({ computer: "research" }), computer: computer("research", { state: "offline" }), me: "usman" });
    expect(statusAction(offline, bot({ computer: "research" }))).toEqual({ label: "Show computer", tab: "computer" });
  });
});

describe("F-07: the archive confirmation names only this bot's routines", () => {
  const ROUTINES = [
    { id: "daily", name: "Morning summary", kind: "routine", source: "x", state: "active", nextRunAt: null },
    { id: "flag", name: "QA flag", kind: "event", source: "y", state: "active", nextRunAt: null },
  ] as never;
  test("listed routines the bot isn't linked to are not its routines", () => {
    expect(linkedRoutineNames({ status: "ok", routines: ROUTINES }, [])).toEqual([]);
    expect(linkedRoutineNames({ status: "ok", routines: ROUTINES }, ["flag"])).toEqual(["QA flag"]);
  });
  const confirm = (routines: string[]) =>
    dom(<ManageSection bot={research} manage={{ confirming: "archive", busy: null, blocked: null, error: null, duplicated: null }} locked={false} status={idle} routines={routines} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />);
  test("no routines linked: nothing about releasing any; some linked: the real count and names", () => {
    expect(confirm([]).text).not.toMatch(/releases/);
    const two = confirm(["Morning summary", "QA flag"]).document.querySelector('[data-testid="archive-releases"]')!.textContent!;
    expect(two).toContain("these 2 routines: Morning summary, QA flag");
  });
});

describe("F-08: unsaved Setup text survives leaving the tab", () => {
  test("a controller made again for the same bot finds the text; saving or discarding clears it", async () => {
    const store = new Map();
    const fake = createFakeAgentBots();
    const a = createSetupController({ botId: "research", client: fake.client, draftStore: store });
    await a.load();
    a.setDraft("purpose", "A new purpose, not saved yet");
    const b = createSetupController({ botId: "research", client: fake.client, draftStore: store }); // the tab switched away and back
    expect(b.getState().drafts.purpose).toBe("A new purpose, not saved yet");
    await b.load();
    expect(b.getState().drafts.purpose).toBe("A new purpose, not saved yet");
    b.discardDraft("purpose");
    expect(store.has("research")).toBe(false);
    expect(createSetupController({ botId: "research", client: fake.client, draftStore: store }).getState().drafts).toEqual({});
  });
  test("a different bot's text is not mixed in, and the page really passes the store", () => {
    const store = new Map([["scout", { name: "Scout 2" }]]);
    expect(createSetupController({ botId: "research", client: createFakeAgentBots().client, draftStore: store }).getState().drafts).toEqual({});
    expect(read("./setup/bot-setup.tsx")).toContain("draftStore: workspaceDrafts");
  });
});

describe("F-12: an archived bot's chat is off, in words", () => {
  test("the box is disabled with the reason as its text, no voice, no offline banner", () => {
    expect(inputOff(bot({ lifecycle: "archived" }))).toBe("Archived: unarchive it to talk to it");
    expect(inputOff(bot({ lifecycle: "archiving" }))).toBe("Archived: unarchive it to talk to it");
    expect(inputOff(bot())).toBeUndefined();
    const r = dom(<Composer botName="Research" onSend={() => {}} disabled="Archived: unarchive it to talk to it" />);
    const box = r.document.querySelector("textarea")!;
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(box.getAttribute("placeholder")).toBe("Archived: unarchive it to talk to it");
    expect(r.document.querySelector('button[type="submit"]')!.hasAttribute("disabled")).toBe(true);
    const live = dom(<Composer botName="Research" onSend={() => {}} />).document.querySelector("textarea")!;
    expect(live.hasAttribute("disabled")).toBe(false);
  });
});

describe("F-15: the model picker offers models that can do the work, by name", () => {
  const model = (id: string, over = {}) => ({ id, provider: id.split("/")[0], route: "free", verifiedFree: true, status: "verified", health: { state: "ok", until: null, detail: null }, ...over });
  const router = {
    status: "ok",
    router: {
      healthAt: null,
      models: [
        model("cline/deepseek-v4.1-flash", { label: "DeepSeek V4.1 Flash", text: true }),
        model("elevenlabs/flash-v2-5", { label: "Flash v2.5", text: false }),
        model("higgsfield/media", { route: "metered", text: false }),
        model("openai/gpt-realtime", { route: "metered", text: false }),
        model("gemini/flash", { status: "not-configured", text: true }),
        model("codex/gpt-6-sol", { route: "subscription", label: "GPT-6 Sol", text: true }),
      ],
    },
  } as never;
  test("voice and media models, and ones not set up here, are not offered; names, not raw ids", () => {
    const { groups } = routeGroups(router, "auto");
    const all = groups.flatMap((g) => g.options);
    expect(all.map((o) => o.value)).toEqual(["auto", "free-only", "cline/deepseek-v4.1-flash", "codex/gpt-6-sol"]);
    expect(all.find((o) => o.value === "cline/deepseek-v4.1-flash")!.label).toBe("DeepSeek V4.1 Flash: working");
    expect(all.some((o) => /elevenlabs|higgsfield|realtime/.test(o.label))).toBe(false);
  });
  test("a model already chosen stays listed even if it no longer qualifies; the raw id is secondary text under the picker", () => {
    expect(routeGroups(router, "openai/gpt-realtime").groups.flatMap((g) => g.options).some((o) => o.value === "openai/gpt-realtime")).toBe(true);
    expect(routeDisclosure(router, "cline/deepseek-v4.1-flash").text).toContain("(cline/deepseek-v4.1-flash)");
  });
});

describe("F-16: Setup says each thing once", () => {
  test("a bot that neither codes nor has skills has no Skills section, and its nav has no dead link", () => {
    expect(skillsSectionShown(research)).toBe(false);
    expect(skillsSectionShown({ ...research, skills: ["seo"] })).toBe(true);
    expect(skillsSectionShown(builder)).toBe(builder.coding.enabled);
    const none = dom(<SkillsSection bot={research} status={idle} skills={{ status: "ok", skills: [] }} computers={{ status: "ok", computers: [computer("research")] }} />);
    expect(none.text).toBe("");
    const nav = dom(<SetupNav omit={["skills"]} onAction={() => {}} />);
    expect([...nav.document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).not.toContain("#setup-skills");
  });
  test("the coding block appears once, only for a bot that codes; no 'doesn't run coding jobs' anywhere", () => {
    const m = (b: BotView) => dom(<ModelSection bot={b} busy={false} locked={false} status={idle} save={() => {}} router={{ status: "ok", router: { models: [], healthAt: null } } as never} accounts={{ status: "ok", accounts: [] } as never} />).text;
    expect(m(research)).not.toMatch(/Coding jobs|coding account|doesn't run coding/i);
    expect(m({ ...research, coding: { enabled: true, accountSlot: null, model: null } })).toContain("Coding jobs");
  });
  test("no internal words: control lease, the screening note, raw routine sources", () => {
    const sources = [read("./setup/sections.tsx"), read("./setup/setup-model.ts"), read("./setup/manage-section.tsx")].join("\n");
    expect(sources).not.toMatch(/control lease: it runs|one control lease|screened like every save|Set up with the hub/);
    void fixtureSources;
  });
});
