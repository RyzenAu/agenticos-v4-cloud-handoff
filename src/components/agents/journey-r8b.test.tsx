// Round 8 (track C, second round): the Computers page named a paused job by the bot's id, the Stop question said "Stop this computer?" while a job
// started from outside the page was already running, and Badge dropped data-testid (the Computer tab's state chip was never in the DOM).
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerView } from "@/lib/computers-client";
import { agentDisplay, computerSummary } from "@/lib/agent-workspace";
import { Badge } from "@/components/ds";
import { doingText } from "@/components/computers/computers-page";
import { stopQuestion } from "./computer/computer-controls";

const computer = (over: Partial<ComputerView> = {}): ComputerView => ({
  name: "research", id: "d1", label: "Research", kind: "cloud-computer", owner: "shared", adapter: "wsl-local", state: "online", desired: "running", desktop: true, browser: true, capabilities: ["echo"], assigned: null,
  controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, lastJob: null, resource: null, lastSeen: 1, failure: null, recoveries: 0,
  createdBy: "usman", createdAt: 1, viewer: { snapshot: true, vnc: true }, usable: true, ...over,
});

describe("the Computers page names a paused job by its bot", () => {
  const held = computer({ state: "busy", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 9, epoch: 2 }, paused: { jobId: "j", agent: "research" } });
  test("summary and its waiting line: the bot's name when known, else the id capitalised; never the bare id", () => {
    const named = computerSummary(held, "usman", (id) => id, null, (id) => (id === "research" ? "Research" : agentDisplay(id)));
    expect(named.headline).toBe("Research — you have the controls, Research's job is paused");
    expect(named.waiting).toBe("Waiting for you — return the controls so Research's job can carry on");
    expect(computerSummary(held, "usman").headline).not.toMatch(/\bresearch's/);
  });
  test("the Doing line", () => {
    expect(doingText({ assigned: null, paused: { jobId: "j", agent: "research" } } as never, () => "Research")).toBe("Paused: Research's job is waiting for the controls back");
    expect(doingText({ assigned: { jobId: "j", title: "Fix X", agent: "builder", by: "usman" }, paused: null } as never)).toBe("Fix X · Builder");
  });
});

describe("the Stop question never sounds like an idle computer while something runs", () => {
  test("busy (or a paused job) before the job is named: what's running stops too; idle: the plain question; a named job: named", () => {
    expect(stopQuestion({ name: "research", assigned: null, state: "busy", paused: null }, [])).toBe("Stop this computer and what's running on it? Nothing runs after this.");
    expect(stopQuestion({ name: "research", assigned: null, state: "online", paused: { jobId: "j", agent: "research" } }, [])).toMatch(/what's running on it/);
    expect(stopQuestion({ name: "research", assigned: null, state: "online", paused: null }, [])).toBe("Stop this computer?");
    expect(stopQuestion({ name: "research", assigned: { jobId: "j", agent: "research", by: "usman", title: "x" }, state: "busy" }, [])).toBe("Stop this computer and cancel its job? Nothing runs after this.");
  });
});

describe("Badge forwards data-testid", () => {
  test("a state chip and a plain tag both carry it; without one nothing is added", () => {
    expect(renderToStaticMarkup(<Badge tone="success" data-testid="computer-state">Online</Badge>)).toContain('data-testid="computer-state"');
    expect(renderToStaticMarkup(<Badge tone="neutral" data-testid="tag">Tag</Badge>)).toContain('data-testid="tag"');
    expect(renderToStaticMarkup(<Badge tone="info">Busy</Badge>)).not.toContain("data-testid");
  });
});
