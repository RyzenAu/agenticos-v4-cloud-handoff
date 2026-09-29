import { describe, expect, test } from "bun:test";
import { agentAlerts, createAgentWatch, parseLiveChats, taskLabel, type WatchState, type WatchedJob } from "./agent-watch";

const job = (status: WatchedJob["runs"][number]["status"], extra: Partial<WatchedJob["runs"][number]> = {}, prompt = "Fix the dental hero image on mobile"): WatchedJob => ({
  id: "job1",
  prompt,
  kind: "task",
  runs: [{ agent: "codex", status, ...extra }],
});
const blank: WatchState = { seeded: false, runs: {}, chats: {} };

describe("task labels", () => {
  test("his words, trimmed; never links, emails or secrets", () => {
    expect(taskLabel("Please fix the dental hero image on mobile")).toBe("fix the dental hero image on mobile");
    expect(taskLabel("Update https://example.com/a/very/long/path the copy for usman@example.com now please and more words here")).toBe("Update the copy for now please and more…");
    expect(taskLabel("rotate sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("rotate");
    expect(taskLabel("")).toBeNull();
  });
});

describe("agent alerts", () => {
  test("the first poll only records (no replay after a restart)", () => {
    const { alerts, state } = agentAlerts(blank, [job("completed")], [], 0);
    expect(alerts).toEqual([]);
    expect(state.seeded).toBe(true);
  });
  test("finished, waiting and failed each alert once, status only", () => {
    let state = agentAlerts(blank, [job("running")], [], 0).state;
    let result = agentAlerts(state, [job("needs_input", { pending: { id: "p1", kind: "question" } })], [], 0);
    expect(result.alerts).toEqual([
      { source: "agent-watch", text: "Codex is waiting for your answer on your task, “Fix the dental hero image on mobile”. It's in Tasks.", priority: "normal", dedupeKey: "agent:job1:codex:input:p1" },
    ]);
    state = result.state;
    // Same pending request on the next poll: nothing new.
    expect(agentAlerts(state, [job("needs_input", { pending: { id: "p1", kind: "question" } })], [], 0).alerts).toEqual([]);
    result = agentAlerts(state, [job("completed")], [], 0);
    expect(result.alerts).toEqual([{ source: "agent-watch", text: "Codex has finished your task, “Fix the dental hero image on mobile”.", priority: "normal", dedupeKey: "agent:job1:codex:completed" }]);
    expect(agentAlerts(state, [job("failed")], [], 0).alerts[0].text).toBe("Codex couldn't finish your task, “Fix the dental hero image on mobile”. The details are in Tasks.");
    expect(agentAlerts(state, [job("interrupted")], [], 0).alerts[0]).toMatchObject({ text: "Codex was interrupted on your task, “Fix the dental hero image on mobile”. Nothing was repeated; it's in Tasks.", dedupeKey: "agent:job1:codex:interrupted" });
    // Cancelled by him, or a health check: silent.
    expect(agentAlerts(state, [job("cancelled")], [], 0).alerts).toEqual([]);
    expect(agentAlerts(state, [{ ...job("completed"), kind: "check" }], [], 0).alerts).toEqual([]);
  });
  test("chat: waiting on a card alerts; a long run finishing alerts; a short one doesn't", () => {
    let state = agentAlerts(blank, [], [{ chatId: "c1", model: "claude-opus", startedAt: 0 }], 0).state;
    let result = agentAlerts(state, [], [{ chatId: "c1", model: "claude-opus", startedAt: 0, waiting: 1 }], 10_000);
    expect(result.alerts).toEqual([{ source: "agent-watch", text: "Claude is waiting for your answer in chat.", priority: "normal", dedupeKey: "chat:c1:0:wait:1" }]);
    state = result.state;
    expect(agentAlerts(state, [], [{ chatId: "c1", model: "claude-opus", startedAt: 0, waiting: 1 }], 20_000).alerts).toEqual([]);
    result = agentAlerts(state, [], [], 5 * 60_000);
    expect(result.alerts).toEqual([{ source: "agent-watch", text: "Claude has finished in chat.", priority: "normal", dedupeKey: "chat:c1:0:done" }]);
    const quick = agentAlerts(agentAlerts(blank, [], [{ chatId: "c2", model: "gpt-5", startedAt: 0 }], 0).state, [], [], 30_000);
    expect(quick.alerts).toEqual([]);
  });
  test("the poller submits, and a failed chat read never fakes a finish", async () => {
    const sent: any[] = [];
    let chats: any = [{ chatId: "c1", startedAt: 0, model: "claude" }];
    let jobs = [job("running")];
    const watch = createAgentWatch({ jobs: () => ({ jobs }), chats: async () => chats, submit: (a) => void sent.push(a), now: () => 10 * 60_000 });
    await watch.poll();
    jobs = [job("completed")];
    chats = null;
    await watch.poll();
    expect(sent.map((a) => a.dedupeKey)).toEqual(["agent:job1:codex:completed"]);
    chats = [];
    await watch.poll();
    expect(sent.map((a) => a.dedupeKey)).toEqual(["agent:job1:codex:completed", "chat:c1:0:done"]);
  });
  test("parses /__sessions_live defensively", () => {
    expect(parseLiveChats({ runs: [{ chatId: "a", startedAt: 5, model: "m", waiting: 2, sessionId: "s" }, { chatId: 3 }, null] })).toEqual([{ chatId: "a", startedAt: 5, model: "m", waiting: 2 }]);
    expect(parseLiveChats("nope")).toEqual([]);
  });
});
