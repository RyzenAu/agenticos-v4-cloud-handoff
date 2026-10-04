// Round 10 UI audit: the gaps found on a synthetic hub at 1440 and 390 px (docs/programme-20261001/evidence/r10-ui/).
//   - a header status sentence was cut off mid-word ("Nothing was replaye...") with no way to read the rest;
//   - the command box's reason did not fit one line on a phone, and the empty conversation still said "Type it or say it" over a box that was off;
//   - a draft that has not started said "Ran on: No model or account was recorded" and offered "Stop";
//   - the bot list showed status only: no recent work, no way to its result.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import type { CodingJob } from "@/lib/coding-client";
import type { ComputerView } from "@/lib/computers-client";
import { TaskRow, ranText } from "./tasks/tasks-tab";
import { codingTask, serviceTask } from "./tasks/tasks";
import { deriveBotStatus } from "./workspace/status";
import { PAIRING_HREF, UnconfirmedChat, inputOff } from "./workspace/slots";
import { PAIRING_LINK } from "@/components/shell/pairing-notice";
import { recentWork } from "./workspace/recent";
import { RecentWork } from "./workspace/recent-work";
import type { Bot } from "./workspace/bots";
import { ComputerWork } from "./workspace-parts";

const dom = (el: ReactElement) => {
  const html = renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return { html, document, text: document.body.textContent ?? "" };
};
const at = "2026-10-03T00:00:00.000Z";
const binding = { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2.1.280" };
function job(o: Partial<CodingJob> & { state: CodingJob["state"] }): CodingJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    spec: { objective: "Fix the booking form", roles: [{ roleId: "builder-1", role: "builder", agent: binding }], doneWhen: [], nonGoals: [], checks: [], repo: { repoId: "app", baseSha: "b".repeat(40), jobBranch: "coding/app-111111" } },
    runs: [], headSha: "c".repeat(40) as never, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc", createdAt: at, updatedAt: at, lastSeq: 3, ...o,
  } as unknown as CodingJob;
}
const bot = (id: string, over: Partial<Bot> = {}): Bot => ({ id, name: id[0]!.toUpperCase() + id.slice(1), purpose: "p", computer: id, coding: { enabled: false, accountSlot: null, model: null }, ...over });
const builder = bot("builder", { computer: null, coding: { enabled: true, accountSlot: null, model: null } });

describe("the header status says the whole sentence", () => {
  test("a restarted job's explanation is not cut off", () => {
    const message = "The hub restarted while the reviewer was working. Nothing was replayed. Resume continues from the last step that finished.";
    const interrupted = job({ state: "interrupted", stoppedBecause: { code: "restart", message, at } as never });
    const s = deriveBotStatus({ bot: builder, computer: null, coding: [interrupted], me: "usman" });
    expect(s.kind).toBe("needs-you");
    expect(s.text).not.toContain("…");
    expect(s.text).toContain("Nothing was replayed");
  });
});

describe("a bot with nothing to run on", () => {
  test("the reason fits one line of a phone box", () => {
    const why = inputOff({ lifecycle: "active", computer: null, coding: { enabled: false, accountSlot: null, model: null } }, { kind: "unconfigured" });
    expect(why).toBe("Choose a computer in Setup first");
    expect(why!.length).toBeLessThanOrEqual(36);
  });
});

describe("a draft has not run on anything", () => {
  test("ranText says what it will use, never 'ran on' nothing", () => {
    expect(ranText({ notStarted: true, ran: { text: "No model or account was recorded for this task.", used: false } })).toBe("Chosen when you start it.");
    expect(ranText({ notStarted: true, ran: { text: "Nothing has run yet. It is set to use Claude Max, Claude Opus 5.5.", used: false } })).toBe("It is set to use Claude Max, Claude Opus 5.5.");
    expect(ranText({ notStarted: true, ran: { text: "Nothing has run yet.", used: false } })).toBe("Chosen when you start it.");
    // a finished or running task keeps the receipt's own words
    expect(ranText({ notStarted: false, ran: { text: "No model or account was recorded for this task.", used: false } })).toBe("No model or account was recorded for this task.");
    expect(ranText({ notStarted: true, ran: { text: "Builder: Claude Max", used: true } })).toBe("Builder: Claude Max");
  });
  test("its row says Will run on, and Discard instead of Stop", () => {
    const t = serviceTask({ id: "j1", title: "Tidy the dashboard empty state", state: "draft", phase: "waiting", kind: "coding", blocker: "Waiting for you to start it." })!;
    expect(t.notStarted).toBe(true);
    const r = dom(<TaskRow task={t} onTab={() => {}} onChanged={() => {}} />);
    const labels = [...r.document.querySelectorAll("dt")].map((x) => x.textContent);
    expect(labels).toContain("Will run on");
    expect(labels).not.toContain("Ran on");
    const buttons = [...r.document.querySelectorAll("button")].map((x) => x.textContent?.trim());
    expect(buttons).toContain("Discard");
    expect(buttons).not.toContain("Stop");
  });
  test("a running job still says Ran on and Stop", () => {
    const t = codingTask(job({ state: "building" as never }), null);
    expect(t.notStarted).toBeFalsy();
    const r = dom(<TaskRow task={t} onTab={() => {}} onChanged={() => {}} />);
    expect([...r.document.querySelectorAll("dt")].map((x) => x.textContent)).toContain("Ran on");
    expect([...r.document.querySelectorAll("button")].map((x) => x.textContent?.trim())).toContain("Stop");
  });
});

describe("recent work in the bot list", () => {
  const verified = job({ state: "completed", id: "22222222-2222-4222-8222-222222222222" as never, updatedAt: "2026-10-03T02:00:00.000Z" as never, spec: { ...job({ state: "draft" }).spec, objective: "Add the booking page" } as never, gate: { sha: "c".repeat(40), passed: true, checks: [] } as never });
  const unverified = job({ state: "completed", id: "33333333-3333-4333-8333-333333333333", updatedAt: "2026-10-03T03:00:00.000Z" as never, gate: { sha: "d".repeat(40), passed: false, checks: [] } as never } as never);
  const research = bot("research");
  const computer = { name: "research", kind: "cloud-computer", owner: "shared", assigned: null, lastJob: { jobId: "cj1", title: "Compare three pricing pages", agent: "research", by: "usman" } } as unknown as ComputerView;

  test("a result link only when the job truly has one", () => {
    const items = recentWork({ bots: [research, builder], computers: [computer], coding: [verified, unverified] });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey["coding:" + verified.id]!.label).toBe("Open result");
    expect(byKey["coding:" + verified.id]!.href).toBe(`/coding/${verified.id}?tab=changes`);
    // completed but the final check did not pass: not a result
    expect(byKey["coding:" + unverified.id]!.label).toBe("Open job");
    expect(byKey["coding:" + unverified.id]!.stateWord).not.toBe("Finished");
    expect(items[0]!.key).toBe("coding:" + unverified.id);
  });
  test("a computer job leads to that bot's Tasks, and is limited and deduplicated", () => {
    const items = recentWork({ bots: [research, bot("scout", { computer: "research" })], computers: [computer], coding: null });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId: "research", label: "Open tasks", href: "/agents/workspace/research?tab=tasks", stateWord: "Last job" });
    expect(recentWork({ bots: [builder], computers: [], coding: [verified, unverified] }, 1)).toHaveLength(1);
  });
  test("archived bots and superseded jobs add nothing; no work means no section", () => {
    const old = { ...builder, lifecycle: "archived" as const };
    expect(recentWork({ bots: [old], computers: [], coding: [verified] })).toEqual([]);
    expect(recentWork({ bots: [builder], computers: [], coding: [{ ...verified, supersededBy: "x" } as unknown as CodingJob] })).toEqual([]);
    expect(dom(<RecentWork items={[]} />).html).toBe("");
  });
  test("each item is a real link with its bot, state and where it goes", () => {
    const items = recentWork({ bots: [builder], computers: [], coding: [verified] });
    const r = dom(<RecentWork items={items} />);
    const a = r.document.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`/coding/${verified.id}?tab=changes`);
    expect(a.textContent).toContain("Add the booking page");
    expect(a.textContent).toContain("Builder");
    expect(a.textContent).toContain("Open result");
    expect(r.document.querySelector("h3")!.textContent).toBe("Recent work");
  });
});

describe("an unconfirmed browser", () => {
  test("sees no conversation, and gets the real next step as a link", () => {
    const r = dom(<UnconfirmedChat />);
    const a = r.document.querySelector("a")!;
    expect(a.textContent).toBe("Confirm this browser");
    // the same place the banner at the top of every page sends it (System, Devices and people)
    expect(a.getAttribute("href")).toBe(`${PAIRING_LINK.to}#${PAIRING_LINK.hash}`);
    expect(PAIRING_HREF).toBe(`${PAIRING_LINK.to}#${PAIRING_LINK.hash}`);
    expect(r.document.querySelector("textarea")).toBeNull();
    expect(r.text).not.toMatch(/pairing page/);
  });
});

describe("who decided a step, in a computer job's progress", () => {
  const c = { name: "research", assigned: null, lastJob: { jobId: "j1", title: "Check the page", agent: "research", by: "usman" } } as never;
  const step = (seq: number, jev?: unknown) => ({ seq, executor: "companion", action: null, outcome: "ok", ms: 1, intent: `step ${seq} navigate: open the page`, verification: null, ...(jev ? { jev } : {}) });
  test("a recorded decision is labelled by the shared helper (a rule is never Jev); an unrecorded one claims nothing", () => {
    const job = { id: "j1", state: "succeeded", note: null, title: "t", computer: "research", agent: "research", paused: false, steps: [step(1, { decidedBy: "rule", op: "navigate" }), step(2, { decidedBy: "jev", op: "navigate", confidence: 0.93 }), step(3)] } as never;
    const r = dom(<ComputerWork c={c} job={job} />);
    const marks = [...r.document.querySelectorAll("[data-decided-by]")].map((x) => x.getAttribute("data-decided-by"));
    expect(marks).toEqual(["Rule", "Jev"]);
    expect(r.text).toContain("decided by Rule");
    expect(r.document.querySelectorAll("li")).toHaveLength(3);
  });
});
