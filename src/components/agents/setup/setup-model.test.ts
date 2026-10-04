// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import type { ComputersRead } from "@/lib/computers-client";
import { seedBots } from "@/lib/agent-bots";
import {
  accountInfo,
  accountOptions,
  codingGate,
  computerOptions,
  computerStateLine,
  memoryGate,
  modelOptions,
  poolLine,
  readinessItems,
  recoveryFor,
  routeDisclosure,
  routeGroups,
  routineItems,
  routinesGate,
  scheduleText,
  skillAbilities,
  computerAbilities,
} from "./setup-model";
import { ACCOUNTS, MEMORY_OFF, MEMORY_ON, ROUTER, ROUTINES, SKILLS, claudeAccount, computer } from "./setup-fixtures";

const okRouter = { status: "ok", router: ROUTER } as const;
const okMem = (m = MEMORY_ON) => ({ status: "ok", memory: m }) as const;
const research = seedBots()[0]!;
const builder = seedBots()[1]!;

describe("computer", () => {
  test("lists the real computers with their state and always allows 'No computer'", () => {
    const { options, gate } = computerOptions({ status: "ok", computers: [computer("research"), computer("builder", { state: "offline" })] }, "research");
    expect(options.map((o) => o.label)).toEqual(["No computer", "Research (online)", "Builder (offline)"]);
    expect(gate.disabled).toBe(false);
  });
  test("an unreadable service disables the control and says why; the current value stays visible", () => {
    const { options, gate } = computerOptions({ status: "unavailable", reason: "Shared agent computers aren't available on this hub." }, "research");
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("aren't available");
    expect(options.some((o) => o.value === "research")).toBe(true);
  });
  test("no computers at all and none assigned: disabled with the way forward; one assigned: can still be cleared", () => {
    expect(computerOptions({ status: "ok", computers: [] }, null).gate.reason).toContain("Add one in Computers");
    expect(computerOptions({ status: "ok", computers: [] }, "gone").gate.disabled).toBe(false);
    expect(computerOptions({ status: "ok", computers: [] }, "gone").options.at(-1)?.label).toBe("gone (not on this hub)");
  });
  test("state words come from the computer itself", () => {
    expect(computerStateLine(computer("a")).text).toBe("Online and idle.");
    expect(computerStateLine(computer("a", { state: "failed", failure: { at: 1, reason: "display died" } })).text).toContain("display died");
    expect(computerStateLine(computer("a", { state: "busy", assigned: { agent: "Builder", jobId: "j", by: "u" as never, title: "Fix it" } })).text).toBe("Busy: Builder is working on “Fix it”.");
    expect(computerStateLine(computer("a", { state: "offline" })).tone).toBe("warn");
  });
});

describe("coding accounts are described from the accounts service, never invented", () => {
  test("a Claude account at its limit says which window and when it resets", () => {
    const i = accountInfo(ACCOUNTS[0]!);
    expect(i.label).toBe("Claude Max 1");
    expect(i.text).toMatch(/^at its weekly limit until .+/);
    expect(i.text).not.toContain("2026-10-06T"); // formatted, not a raw ISO string
    expect(i.selectable).toBe(true);
    expect(i.tone).toBe("warn");
  });
  test("limit reached with no reset time says so", () => {
    const i = accountInfo(claudeAccount("claude:max", "Claude Max", { allowance: { windows: [], limitReached: true } }));
    expect(i.text).toBe("at its usage limit (reset time not reported)");
  });
  test("ready shows the peak usage reported; signed out and not installed cannot be chosen", () => {
    expect(accountInfo(ACCOUNTS[1]!).text).toBe("ready, 41% of its allowance used");
    const out = accountInfo(ACCOUNTS[2]!);
    expect(out).toMatchObject({ selectable: false, tone: "danger" });
    expect(out.text).toContain("signed out");
    expect(accountInfo(claudeAccount("claude:x", "X", { installed: false })).selectable).toBe(false);
    expect(accountInfo({ ...ACCOUNTS[3]!, installed: false } as never).text).toContain("isn't installed");
  });
  test("Codex with its sandbox isolation paused is not ready, whatever its allowance says, and can't be newly chosen", () => {
    const iso = { state: "paused", label: "Paused", detail: "x", approvedAt: null, protectedPaths: null } as const;
    const i = accountInfo(ACCOUNTS[3]!, iso);
    expect(i.text).toContain("paused until its sandbox isolation is applied");
    expect(i.selectable).toBe(false);
    expect(accountInfo(ACCOUNTS[3]!, { ...iso, state: "protected" }).text).toBe("ready, 12% of its allowance used");
    expect(accountOptions({ status: "ok", accounts: ACCOUNTS, codexIsolation: iso }, null).options.find((o) => o.value === "codex:a")?.disabled).toBe(true);
  });
  test("paid-vs-free disclosure: a plan is no per-call charge; Codex credits are stated", () => {
    expect(accountInfo(ACCOUNTS[1]!).paid).toContain("no per-call charge");
    expect(accountInfo(ACCOUNTS[3]!).paid).toContain("no extra charge");
    expect(accountInfo({ ...ACCOUNTS[3]!, creditsAllowed: true } as never).paid).toContain("may spend paid credits");
  });
  test("options: automatic first, unusable accounts disabled unless they are the current choice, unknown current kept", () => {
    const { options } = accountOptions({ status: "ok", accounts: ACCOUNTS }, "claude:max-3");
    expect(options[0]!.value).toBe("");
    expect(options.find((o) => o.value === "claude:max-3")?.disabled).toBe(false);
    expect(accountOptions({ status: "ok", accounts: ACCOUNTS }, null).options.find((o) => o.value === "claude:max-3")?.disabled).toBe(true);
    expect(accountOptions({ status: "ok", accounts: ACCOUNTS }, "claude:old").options.at(-1)?.label).toBe("claude:old (no longer on this hub)");
  });
  test("unreadable accounts disable the control with the reason", () => {
    const r = accountOptions({ status: "unavailable", reason: "The coding accounts: HTTP 500" }, null);
    expect(r.gate.disabled).toBe(true);
    expect(r.gate.reason).toContain("HTTP 500");
  });
  test("models come only from the chosen account's real list; no account or no models disables with a reason", () => {
    const info = accountInfo(ACCOUNTS[1]!);
    const m = modelOptions(info, null, true);
    expect(m.options.map((o) => o.value)).toEqual(["", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(m.options[2]!.label).toBe("claude-sonnet-5-5 (has run here)");
    expect(modelOptions(null, null, true).gate.reason).toContain("Choose an account first");
    expect(modelOptions({ ...info, models: [] }, null, true).gate.reason).toContain("didn't report any models");
    expect(modelOptions(info, "gpt-x", true).options.at(-1)?.label).toContain("not offered by Claude Max 2");
    expect(modelOptions(null, null, false).gate.disabled).toBe(true);
  });
  test("a bot without coding has no coding controls: disabled with the reason", () => {
    expect(codingGate(research).disabled).toBe(true);
    expect(codingGate(research).reason).toContain("doesn't run coding jobs");
    expect(codingGate(builder).disabled).toBe(false);
  });
});

describe("model route", () => {
  test("auto and free-only are always offered; models are grouped by what they cost, with live health", () => {
    const { groups, note } = routeGroups(okRouter, "auto");
    expect(note).toBeNull();
    expect(groups.map((g) => g.label)).toEqual(["Let the hub decide", "Free", "Subscription", "Paid per use"]);
    const free = groups.find((g) => g.label === "Free")!.options;
    expect(free.find((o) => o.value === "groq/gpt-oss-120b")?.label).toBe("groq/gpt-oss-120b: working");
    expect(free.find((o) => o.value === "cline/mimo-v2.6-flash")?.label).toMatch(/limited until/);
    expect(free.find((o) => o.value === "gemini/flash")).toBeUndefined(); // not set up here: not offered
  });
  test("router unreadable: only the two automatic choices (plus the current one) and a note", () => {
    const { groups, note } = routeGroups({ status: "unavailable", reason: "The model router: HTTP 403" }, "codex/gpt-6-sol");
    expect(groups.flatMap((g) => g.options.map((o) => o.value))).toEqual(["auto", "free-only", "codex/gpt-6-sol"]);
    expect(note).toContain("HTTP 403");
  });
  test("a current route the router no longer lists is kept and labelled", () => {
    expect(routeGroups(okRouter, "old/model").groups.at(-1)?.options[0]?.label).toBe("old/model (not in the router's list)");
  });
  test("every route discloses what it costs", () => {
    expect(routeDisclosure(okRouter, "auto").text).toContain("never picks a paid-per-use one");
    expect(routeDisclosure(okRouter, "free-only").text).toContain("never falls back to a paid one");
    expect(routeDisclosure(okRouter, "groq/gpt-oss-120b").text).toContain("Free: no charge");
    expect(routeDisclosure(okRouter, "gemini/flash").text).toContain("hasn't verified");
    expect(routeDisclosure(okRouter, "codex/gpt-6-sol").text).toContain("no per-call charge");
    const paid = routeDisclosure(okRouter, "openrouter/deepseek-v4-pro");
    expect(paid.text).toContain("Paid per use");
    expect(paid.tone).toBe("warn");
    expect(routeDisclosure(okRouter, "nope").text).toContain("cost can't be stated");
  });
});

describe("what the bot can do (read-only)", () => {
  test("the bot's skills get the hub's descriptions; one the hub no longer lists is flagged", () => {
    const rows = skillAbilities({ status: "ok", skills: SKILLS }, ["seo", "retired"]);
    expect(rows).toEqual([{ name: "retired", missing: true }, { name: "seo", description: "Audit a page's search basics.", missing: false }]);
  });
  test("with the list unreadable the names still show, never flagged as missing", () => {
    expect(skillAbilities({ status: "unavailable", reason: "x" }, ["seo"])).toEqual([{ name: "seo", missing: false }]);
  });
  test("the computer's own capabilities, honestly when unknown", () => {
    const ok = { status: "ok", computers: [computer("research", { capabilities: ["browser", "files"] }), computer("x", { capabilities: null })] } satisfies ComputersRead;
    expect(computerAbilities(ok, "research")).toBe("browser, files");
    expect(computerAbilities(ok, "x")).toContain("hasn't reported");
    expect(computerAbilities(ok, "ghost")).toContain("isn't one of this hub's shared computers");
    expect(computerAbilities(ok, null)).toBeNull();
    expect(computerAbilities({ status: "unavailable", reason: "x" }, "research")).toContain("couldn't be read");
  });
});

describe("routines", () => {
  test("every schedule is shown with its named timezone", () => {
    expect(scheduleText(ROUTINES[0]!)).toMatch(/^Every day at 08:30 \(Australia\/Sydney\)\. Next: .+\.$/);
    expect(scheduleText(ROUTINES[0]!)).toContain("(Australia/Sydney)");
    expect(scheduleText(ROUTINES[1]!)).toBe("Every 1 hour.");
    expect(scheduleText({ kind: "routine", source: "x", nextRunAt: null, schedule: { kind: "interval", everyMinutes: 120 } })).toBe("Every 2 hours.");
    expect(scheduleText({ kind: "routine", source: "x", nextRunAt: null, schedule: { kind: "interval", everyMinutes: 45 } })).toBe("Every 45 minutes.");
    expect(scheduleText(ROUTINES[2]!)).toBe("Runs when something it watches reports an event.");
    expect(scheduleText({ kind: "routine", source: "x", nextRunAt: null })).toBe("No schedule reported.");
  });
  test("a linked routine that no longer exists is kept so it can be unlinked", () => {
    const items = routineItems({ status: "ok", routines: ROUTINES }, ["gone"]);
    expect(items.at(-1)).toMatchObject({ id: "gone", missing: true });
    expect(routinesGate({ status: "unavailable", reason: "Automations: x" }).disabled).toBe(true);
  });
});

describe("memory", () => {
  test("recall can't be turned on when the pool is off; save can't when writes are off or read-only", () => {
    expect(memoryGate("recall", false, okMem(MEMORY_OFF)).reason).toContain("nothing to recall from");
    expect(memoryGate("saveResults", false, okMem(MEMORY_OFF)).reason).toContain("nothing would be saved");
    expect(memoryGate("saveResults", false, okMem({ ...MEMORY_ON, mode: "read" })).reason).toContain("read-only");
    expect(memoryGate("recall", false, okMem()).disabled).toBe(false);
    expect(memoryGate("saveResults", false, okMem()).disabled).toBe(false);
  });
  test("a switch the pool can't honour is unavailable even when stored On: it is never shown as working", () => {
    expect(memoryGate("recall", true, okMem(MEMORY_OFF)).disabled).toBe(true);
    expect(memoryGate("saveResults", true, okMem(MEMORY_OFF)).disabled).toBe(true);
  });
  test("status unreadable: switches stay usable, the line says the effect is unknown", () => {
    const r = { status: "unavailable", reason: "The memory service couldn't be reached." } as const;
    expect(memoryGate("recall", false, r).disabled).toBe(false);
    expect(poolLine(r).text).toContain("unknown");
  });
  test("the pool line states mode, recall and pending/last save", () => {
    expect(poolLine(okMem()).text).toContain("Shared memory is saving.");
    expect(poolLine(okMem(MEMORY_OFF)).text).toContain("writes are off");
    expect(poolLine(okMem(MEMORY_OFF)).text).toContain("switched off, so there is nothing to recall");
    expect(poolLine(okMem({ ...MEMORY_ON, pending: 3 })).text).toContain("3 waiting to be saved");
  });
});

describe("readiness reasons: the hub's structured fix decides the button", () => {
  const r = (code: string, fix?: { kind: string; target?: string }) => ({ code, text: "t", ...(fix ? { fix } : {}) }) as never;
  test("each fix kind maps to its action; no fix means no button", () => {
    expect(recoveryFor(r("a", { kind: "open-setup-section", target: "computer" }))).toEqual({ label: "Choose a computer", section: "computer" });
    expect(recoveryFor(r("a", { kind: "open-setup-section", target: "model" }))).toMatchObject({ section: "model" });
    expect(recoveryFor(r("a", { kind: "open-setup-section", target: "nonsense" }))).toBeNull();
    expect(recoveryFor(r("a", { kind: "open-computer" }))).toEqual({ label: "Open Computers", to: "/computers" });
    expect(recoveryFor(r("a", { kind: "take-over" }))).toEqual({ label: "Open Computers", to: "/computers" });
    expect(recoveryFor(r("a", { kind: "sign-in", target: "claude:max" }))).toEqual({ label: "Sign in", to: "/coding" });
    expect(recoveryFor(r("a", { kind: "retry" }))).toEqual({ label: "Check again", retry: true });
    expect(recoveryFor(r("a"))).toBeNull();
  });
  test("it never guesses from the words: a sentence about a computer with no fix gets no button", () => {
    expect(recoveryFor({ code: "x", text: "The computer is offline and the account is signed out." })).toBeNull();
  });
  test("items carry the sentence and a stable key", () => {
    const items = readinessItems({ state: "needs-you", reasons: [{ code: "c1", text: "One.", fix: { kind: "retry" } }, { code: "c1", text: "Two." }] });
    expect(items.map((i) => i.key)).toEqual(["c1:0", "c1:1"]);
    expect(items[0]!.action?.retry).toBe(true);
    expect(items[1]!.action).toBeNull();
  });
});
