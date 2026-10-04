// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAgentBots, seedBots, type Bot } from "@/lib/agent-bots";
import { ComputerSection, ConflictNotice, MemorySection, ModelSection, PurposeSection, ReadinessCard, RoutinesSection, SkillsSection } from "./sections";
import { BotSetup } from "./bot-setup";
import { ACCOUNTS, MEMORY_OFF, MEMORY_ON, ROUTER, ROUTINES, SKILLS, computer } from "./setup-fixtures";

const research = seedBots()[0]! as Bot;
const builder = seedBots()[1]! as Bot;
const idle: { saving: boolean; savedAt: number | null; error: string | null } = { saving: false, savedAt: null, error: null };
const common = (bot: Bot, over: Partial<{ busy: boolean; locked: boolean; status: typeof idle }> = {}) => ({ bot, busy: false, locked: false, status: idle, save: () => {}, ...over });
const navigate = () => {};

function dom(el: ReactElement) {
  const html = renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return { html, document, text: document.body.textContent ?? "" };
}
const isDisabled = (el: Element | null) => !!el && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");

const okRouter = { status: "ok", router: ROUTER } as const;
const okAccounts = { status: "ok", accounts: ACCOUNTS } as const;
const okMem = (m = MEMORY_ON) => ({ status: "ok", memory: m }) as const;

describe("Purpose and instructions", () => {
  const purpose = (drafts = {}, over = {}) => dom(<PurposeSection {...common(research, over)} drafts={drafts} onDraft={() => {}} onDiscard={() => {}} onSave={() => {}} />);

  test("Save is disabled with the reason when nothing changed, enabled once there is a valid change", () => {
    const clean = purpose();
    const save = [...clean.document.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(isDisabled(save)).toBe(true);
    expect(clean.text).toContain("Nothing to save yet.");
    const dirty = purpose({ purpose: "A better purpose." });
    const save2 = [...dirty.document.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(isDisabled(save2)).toBe(false);
    expect(dirty.text).toContain("Unsaved changes");
    expect(dirty.text).toContain("Discard changes");
  });

  test("an empty purpose or an over-long instruction is refused on the page, with its message, and Save stays disabled", () => {
    const empty = purpose({ purpose: "   " });
    expect(empty.text).toContain("Say what this bot is for");
    expect(isDisabled([...empty.document.querySelectorAll("button")].find((b) => b.textContent === "Save")!)).toBe(true);
    const long = purpose({ instructions: "x".repeat(8001) });
    expect(long.text).toContain("Instructions can be up to 8,000 characters");
    expect(long.document.querySelector("#bot-instructions")?.getAttribute("aria-invalid")).toBe("true");
  });

  test("the typed draft is what the box shows, not the saved text, and the limit is stated", () => {
    const d = purpose({ instructions: "Typed but unsaved." });
    expect(d.document.querySelector("#bot-instructions")?.textContent).toBe("Typed but unsaved.");
    expect(d.text).toContain("of 8,000 characters");
  });

  test("a conflict or a write in flight stops Save and the fields; the conflict says why", () => {
    const locked = purpose({ purpose: "Edit." }, { locked: true });
    expect(locked.text).toContain("Reload the latest first");
    expect(isDisabled([...locked.document.querySelectorAll("button")].find((b) => b.textContent === "Save")!)).toBe(true);
    const busy = purpose({ purpose: "Edit." }, { busy: true });
    expect(isDisabled(busy.document.querySelector("#bot-purpose"))).toBe(true);
  });

  test("the receipt says Saved with the time, or Saving, or the error", () => {
    const saved = dom(<PurposeSection {...common(research, { status: { saving: false, savedAt: Date.parse("2026-10-02T04:05:00Z"), error: null } })} drafts={{}} onDraft={() => {}} onDiscard={() => {}} onSave={() => {}} />);
    expect(saved.document.querySelector('[data-testid="receipt"]')?.textContent).toMatch(/^Saved \d{1,2}:\d{2}/);
    const err = dom(<PurposeSection {...common(research, { status: { saving: false, savedAt: null, error: "The Agents service couldn't be reached." } })} drafts={{ purpose: "x" }} onDraft={() => {}} onDiscard={() => {}} onSave={() => {}} />);
    expect(err.document.querySelector('[role="alert"]')?.textContent).toContain("couldn't be reached");
    expect(err.document.querySelector("#bot-purpose")?.textContent).toBe("x");
  });
});

describe("Computer", () => {
  test("lists real computers, shows the chosen one's state, and links to Computers", () => {
    const r = dom(<ComputerSection {...common(research)} computers={{ status: "ok", computers: [computer("research"), computer("builder")] }} navigate={navigate} />);
    expect([...r.document.querySelectorAll("#bot-computer option")].map((o) => o.textContent)).toEqual(["No computer", "Research (online)", "Builder (online)"]);
    expect(r.document.querySelector('[data-testid="computer-state"]')?.textContent).toBe("Research: Online and idle.");
    expect(r.document.querySelector('a[href="/computers"]')).not.toBeNull();
  });
  test("no computer assigned is not said a second time here (the header says it); an unreadable service disables the select with the reason", () => {
    expect(dom(<ComputerSection {...common({ ...research, computer: null })} computers={{ status: "ok", computers: [computer("research")] }} navigate={navigate} />).text).not.toContain("nowhere to work");
    const down = dom(<ComputerSection {...common(research)} computers={{ status: "unavailable", reason: "The computers service couldn't be reached." }} navigate={navigate} />);
    expect(isDisabled(down.document.querySelector("#bot-computer"))).toBe(true);
    expect(down.text).toContain("couldn't be reached");
  });
  test("an assigned computer the hub doesn't have is called out", () => {
    expect(dom(<ComputerSection {...common({ ...research, computer: "ghost" })} computers={{ status: "ok", computers: [computer("research")] }} navigate={navigate} />).text).toContain("“ghost” isn't one of this hub's shared computers");
  });
});

describe("Model and account", () => {
  const model = (bot: Bot, over = {}, router = okRouter as never, accounts = okAccounts as never) => dom(<ModelSection {...common(bot, over)} router={router} accounts={accounts} />);

  test("a bot that doesn't code has no coding controls and doesn't say so; the route stays usable", () => {
    const r = model(research);
    expect(r.document.querySelector("#bot-account")).toBeNull();
    expect(r.document.querySelector("#bot-coding-model")).toBeNull();
    expect(r.text).not.toContain("doesn't run coding jobs");
    expect(r.text).not.toContain("Coding jobs");
    expect(isDisabled(r.document.querySelector("#bot-route"))).toBe(false);
  });

  test("Builder: accounts come from the accounts service with their real state; unusable ones can't be picked", () => {
    const r = model(builder);
    const opts = [...r.document.querySelectorAll("#bot-account option")];
    expect(opts[0]!.textContent).toContain("Automatic");
    expect(opts.find((o) => o.getAttribute("value") === "claude:max")?.textContent).toMatch(/^Claude Max 1: at its weekly limit until /);
    expect(isDisabled(opts.find((o) => o.getAttribute("value") === "claude:max-3")!)).toBe(true);
    expect(isDisabled(r.document.querySelector("#bot-account"))).toBe(false);
  });

  test("a chosen account shows its state and paid-vs-free line, and its own models only", () => {
    const b = { ...builder, coding: { enabled: true, accountSlot: "claude:max-2", model: null } };
    const r = model(b);
    expect(r.document.querySelector('[data-testid="account-state"]')?.textContent).toBe("Claude Max 2: ready, 41% of its allowance used.");
    expect(r.document.querySelector('[data-testid="account-paid"]')?.textContent).toContain("no per-call charge");
    expect([...r.document.querySelectorAll("#bot-coding-model option")].map((o) => o.getAttribute("value"))).toEqual(["", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(isDisabled(r.document.querySelector("#bot-coding-model"))).toBe(false);
  });

  test("with the account on automatic the model list is disabled and says why", () => {
    const r = model(builder);
    expect(isDisabled(r.document.querySelector("#bot-coding-model"))).toBe(true);
    expect(r.text).toContain("Choose an account first");
  });

  test("a paid route says it costs money; free says no charge", () => {
    expect(model({ ...research, modelPreference: { route: "openrouter/deepseek-v4-pro" } }).document.querySelector('[data-testid="route-disclosure"]')?.textContent).toContain("Paid per use");
    expect(model({ ...research, modelPreference: { route: "free-only" } }).document.querySelector('[data-testid="route-disclosure"]')?.textContent).toContain("Only models verified as free");
  });

  test("the router's real health is in the options; an unreadable router leaves only the automatic choices and says why", () => {
    const r = model(research);
    expect([...r.document.querySelectorAll("#bot-route option")].map((o) => o.textContent)).toContain("groq/gpt-oss-120b: working");
    const down = model(research, {}, { status: "unavailable", reason: "The model router: HTTP 403" } as never);
    expect([...down.document.querySelectorAll("#bot-route option")].map((o) => o.getAttribute("value"))).toEqual(["auto", "free-only"]);
    expect(down.text).toContain("HTTP 403");
  });

  test("accounts unreadable: coding controls disabled with the reason", () => {
    const r = model(builder, {}, okRouter as never, { status: "unavailable", reason: "The coding accounts: offline" } as never);
    expect(isDisabled(r.document.querySelector("#bot-account"))).toBe(true);
    expect(r.text).toContain("The coding accounts: offline");
  });
});

describe("What this bot can do (read-only)", () => {
  const abilities = (bot: Bot, skills = { status: "ok", skills: SKILLS } as never, computers = { status: "ok", computers: [computer("research", { capabilities: ["browser", "files"] })] } as never) => dom(<SkillsSection bot={bot} status={idle} skills={skills} computers={computers} />);
  test("lists the bot's skills with descriptions, its computer's abilities and its coding state, with nothing to toggle", () => {
    const r = abilities({ ...research, skills: ["seo"] });
    expect(r.text).toContain("What this bot can do");
    expect(r.document.querySelector('[data-testid="skills-list"]')?.textContent).toContain("Audit a page's search basics.");
    expect(r.document.querySelector('[data-testid="computer-abilities"]')?.textContent).toBe("browser, files");
    expect(r.document.querySelector('[data-testid="coding-abilities"]')).toBeNull(); // it doesn't code: nothing to say
    expect(r.document.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(r.text).toContain("Set by the hub");
  });
  test("a builder says it runs coding jobs; no skills and no computer are said plainly", () => {
    const r = abilities({ ...builder, computer: null });
    expect(r.document.querySelector('[data-testid="coding-abilities"]')?.textContent).toContain("can run Claude and Codex coding jobs");
    expect(r.document.querySelector('[data-testid="skills-count"]')).toBeNull();
    expect(r.document.querySelector('[data-testid="computer-abilities"]')).toBeNull();
  });
  test("an unreadable skills list still shows the names and says descriptions are missing", () => {
    const r = abilities({ ...research, skills: ["seo"] }, { status: "unavailable", reason: "The hub can't list its skills yet." } as never);
    expect(r.text).toContain("seo");
    expect(r.text).toContain("Descriptions aren't shown");
  });
});

describe("Effect lines say only what the hub does", () => {
  test("model route, memory and routines carry the agreed sentences", () => {
    const m = dom(<ModelSection {...common(research)} router={okRouter} accounts={okAccounts} />).text;
    expect(m).toContain("Tried first for its writing and web reading. The receipt shows the model that answered.");
    const mem = dom(<MemorySection {...common(research)} memory={okMem() as never} />).text;
    expect(mem).toContain("Each new computer task starts with up to 5 relevant facts, each with its source");
    expect(mem).toContain("Coding jobs don't use this.");
    expect(mem).toContain("Each finished computer task adds one short memory of its saved result.");
    const r = dom(<RoutinesSection {...common(research)} routines={{ status: "ok", routines: ROUTINES }} navigate={navigate} />).text;
    expect(r).toContain("Linked routines run as Research; their progress appears in the conversation with it of the founder who linked them");
  });
});

describe("Routines", () => {
  test("each routine shows its schedule with its timezone; Create routine deep-links to Automations", () => {
    const r = dom(<RoutinesSection {...common({ ...research, routines: ["daily-leads"] })} routines={{ status: "ok", routines: ROUTINES }} navigate={navigate} />);
    expect(r.text).toContain("Every day at 08:30 (Australia/Sydney)");
    expect(r.text).toContain("Every 1 hour.");
    expect(r.text).toContain("paused");
    expect(r.document.querySelector('a[href="/automations"]')?.textContent).toContain("Create a routine in Automations");
    expect(r.document.querySelector('[data-testid="routines-count"]')?.textContent).toBe("1 linked.");
  });
  test("no routines yet says so and points to Automations; unreadable disables linking with the reason", () => {
    expect(dom(<RoutinesSection {...common(research)} routines={{ status: "ok", routines: [] }} navigate={navigate} />).text).toContain("There are no routines yet.");
    const down = dom(<RoutinesSection {...common({ ...research, routines: ["daily-leads"] })} routines={{ status: "unavailable", reason: "Automations: x" }} navigate={navigate} />);
    expect(down.text).toContain("Automations: x");
  });
});

describe("Memory", () => {
  const memory = (bot: Bot, m = okMem(), over = {}) => dom(<MemorySection {...common(bot, over)} memory={m as never} />);
  test("two switches with their effect lines, the pool's status and the CRM note", () => {
    const r = memory(research);
    expect(r.document.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(r.text).toContain("Recall from shared memory");
    expect(r.text).toContain("Save results to shared memory");
    expect(r.document.querySelector('[data-testid="pool-status"]')?.textContent).toContain("Shared memory is saving.");
    expect(r.text).not.toContain("screened like every save");
  });
  test("with the pool off both switches are unavailable with the reason, and never shown On", () => {
    const off = memory({ ...research, memory: { recall: false, saveResults: false } }, okMem(MEMORY_OFF));
    expect(isDisabled(off.document.querySelector("#bot-recall"))).toBe(true);
    expect(isDisabled(off.document.querySelector("#bot-save"))).toBe(true);
    expect(off.text).toContain("nothing would be saved");
    const on = memory({ ...research, memory: { recall: true, saveResults: true } }, okMem(MEMORY_OFF));
    expect(isDisabled(on.document.querySelector("#bot-recall"))).toBe(true);
    expect(isDisabled(on.document.querySelector("#bot-save"))).toBe(true);
    expect([...on.document.querySelectorAll('[role="switch"]')].map((x) => x.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(on.text).toContain("nothing would be saved");
  });
});

describe("Readiness and conflict notices", () => {
  const view = (b: Bot, readiness: { state: never; reasons: { code: string; text: string; fix?: { kind: string; target?: string } }[] }) => ({ ...b, readiness }) as never;
  test("reasons are plain sentences, each with its recovery action", () => {
    const r = dom(<ReadinessCard bot={view(builder, { state: "needs-you" as never, reasons: [{ code: "a", text: "Coding jobs have no account chosen.", fix: { kind: "open-setup-section", target: "model" } }, { code: "b", text: "Its computer is offline.", fix: { kind: "open-computer" } }, { code: "c", text: "A note with no fix." }] })} stale={false} onAction={() => {}} />);
    expect(r.document.querySelector('[data-testid="readiness-word"]')?.textContent).toBe("Needs you");
    expect(r.text).toContain("Coding jobs have no account chosen.");
    const buttons = [...r.document.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Choose another model or account", "Open Computers"]);
  });
  test("ready says nothing needs doing; a stale refresh is admitted", () => {
    const r = dom(<ReadinessCard bot={view(research, { state: "ready" as never, reasons: [] })} stale onAction={() => {}} />);
    expect(r.text).toContain("Nothing needs doing");
    expect(r.text).toContain("couldn't be refreshed");
  });
  test("the section links are real links with targets", () => {
    const r = dom(<ReadinessCard bot={view(research, { state: "ready" as never, reasons: [] })} stale={false} onAction={() => {}} />);
    expect([...r.document.querySelectorAll('nav[aria-label="Setup sections"] a')].map((a) => a.getAttribute("href"))).toEqual(["#setup-purpose", "#setup-computer", "#setup-model", "#setup-skills", "#setup-routines", "#setup-memory", "#setup-manage"]);
  });
  test("the conflict notice says Changed elsewhere, lists what changed with the server's values and offers Reload", () => {
    const fake = createFakeAgentBots();
    const mine = seedBots()[0]!;
    const theirs = { ...mine, computer: null, rev: 2 };
    const r = dom(<ConflictNotice conflict={{ section: "computer", current: theirs, attempted: { computer: "builder" } }} bot={mine} hasDrafts onReload={() => {}} />);
    void fake;
    expect(r.text).toContain("Changed elsewhere — reload to see the latest");
    expect(r.document.querySelector('[data-testid="conflict-diffs"]')?.textContent).toContain("Computer is now: none");
    expect(r.text).toContain("The text you were typing stays where it is.");
    expect([...r.document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Reload latest"]);
  });
});

describe("accessibility basics", () => {
  const all = () =>
    dom(
      <>
        <PurposeSection {...common(builder)} drafts={{}} onDraft={() => {}} onDiscard={() => {}} onSave={() => {}} />
        <ComputerSection {...common(builder)} computers={{ status: "ok", computers: [computer("builder")] }} navigate={navigate} />
        <ModelSection {...common(builder)} router={okRouter} accounts={okAccounts} />
        <SkillsSection bot={builder} status={idle} skills={{ status: "ok", skills: SKILLS }} computers={{ status: "ok", computers: [computer("builder")] }} />
        <RoutinesSection {...common(builder)} routines={{ status: "ok", routines: ROUTINES }} navigate={navigate} />
        <MemorySection {...common(builder)} memory={okMem()} />
      </>,
    );

  test("every field has a label wired to it; every switch is named", () => {
    const { document } = all();
    const fields = [...document.querySelectorAll("select, textarea, input:not([aria-hidden])")];
    expect(fields.length).toBeGreaterThan(8);
    for (const f of fields) {
      const id = f.getAttribute("id");
      expect(id, f.outerHTML.slice(0, 160)).toBeTruthy();
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
    for (const s of document.querySelectorAll('[role="switch"]')) {
      const by = s.getAttribute("aria-labelledby");
      expect(by && document.getElementById(by)).toBeTruthy();
    }
  });

  test("each section is a landmark named by its own heading, in order", () => {
    const { document } = all();
    const sections = [...document.querySelectorAll("section[aria-labelledby]")];
    expect(sections.map((s) => document.getElementById(s.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["Purpose and instructions", "Computer", "Model and account", "What this bot can do", "Routines", "Memory"]);
  });

  test("a disabled control's reason is attached to it with aria-describedby", () => {
    const { document } = dom(<ModelSection {...common(builder)} router={okRouter} accounts={{ status: "unavailable", reason: "The coding accounts: offline" } as never} />);
    const sel = document.querySelector("#bot-account")!;
    expect(isDisabled(sel)).toBe(true);
    const reason = document.getElementById(sel.getAttribute("aria-describedby")!.split(" ").find((x) => x.endsWith("-reason"))!);
    expect(reason?.textContent).toContain("The coding accounts: offline");
  });

  test("no text is set below the 13px floor", () => {
    const { html } = all();
    expect(html).not.toMatch(/text-\[(?:[0-9]|1[0-2])px\]/);
    expect(html).not.toContain("text-2xs");
  });
});

describe("BotSetup shell", () => {
  test("renders a labelled loading state before the bot arrives, never a form of guesses", () => {
    const fake = createFakeAgentBots();
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <BotSetup botId="research" client={fake.client} />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-testid="bot-setup"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<textarea");
  });
});
