// r6: "Open job" in a conversation used to land on the Activity LIST, not on the job it named. It now lands on that job (/activity#job-<id>), shows its
// state and steps even when it is older than the list, and offers the saved result of a workflow job. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ActivityView, jobIdFromHash, savedResultFor, type SelectedRead } from "../src/components/activity/activity-view";
import { ENTRY_LABEL, entryKind, hasSavedResult, jobIdOf, viaFor } from "../src/lib/thread-events";
import type { Job, JobSummary } from "./jobs/types";

const withRouter = (node: ReactNode) => renderToStaticMarkup(<RouterContextProvider router={createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) })}>{node}</RouterContextProvider>);
const ID = "3f2a9c1e-5b7d-4e86-9a10-c4d2e8f61b73";
const OTHER = "9b1d7a40-2c3e-4f58-8d61-0a7e5c9b2f14";
const summary = (id: string, title: string): JobSummary => ({ id, kind: "control", state: "succeeded", title, createdAt: "2026-10-02T01:00:00.000Z", updatedAt: "2026-10-02T01:02:00.000Z", stepCount: 2, lastStep: null } as unknown as JobSummary);
const job = (over: Partial<Job> = {}): Job => ({ id: ID, kind: "control", state: "succeeded", title: "Audit the demo clinic fixture", note: "Audit ready", createdAt: "2026-10-02T01:00:00.000Z", updatedAt: "2026-10-02T01:02:00.000Z", steps: [{ seq: 1, at: 1, intent: "sub-goal 1 of 5, open the site: done.", executor: "audit", ms: 0, outcome: "ok" }, { seq: 2, at: 2, intent: "audit complete: 8 findings", executor: "audit", ms: 0, outcome: "ok" }], ...over } as unknown as Job);

describe("Open job lands on the job it names", () => {
  test("the hash names a job id; anything else is not a job link", () => {
    expect(jobIdFromHash(`#job-${ID}`)).toBe(ID);
    expect(jobIdFromHash(`job-${ID.toUpperCase()}`)).toBe(ID);
    expect(jobIdFromHash("#job-12345678")).toBeNull();
    expect(jobIdFromHash("#jobs")).toBeNull();
    expect(jobIdFromHash("")).toBeNull();
    expect(jobIdFromHash(`#job-${ID}-extra`)).toBeNull();
  });

  test("the named job is shown above the list with its state, steps and saved result, and its row is marked", () => {
    const sel: SelectedRead = { id: ID, status: "ok", job: job() };
    const html = withRouter(<ActivityView read={{ status: "ok", jobs: [summary(ID, "Audit the demo clinic fixture"), summary(OTHER, "Something else")] }} selected={sel} />);
    expect(html).toContain('data-testid="selected-job"');
    expect(html).toContain("Audit the demo clinic fixture");
    expect(html).toContain("sub-goal 1 of 5, open the site: done.");
    expect(html).toContain(`href="/__computers/artifacts/${ID}"`);
    expect(html).toContain("Open saved result");
    expect(html).toContain(`id="job-${ID}"`);
    expect(html).toContain('data-selected="true"');
    expect(html.match(/data-selected="true"/g)).toHaveLength(1); // only the named row
  });

  test("a job older than the list, still loading, missing, or unreadable says so instead of showing the list as if nothing was asked", () => {
    const list = { status: "ok", jobs: [summary(OTHER, "Newer job")] } as const;
    expect(withRouter(<ActivityView read={list} selected={{ id: ID, status: "loading" }} />)).toContain("Reading job 3f2a9c1e");
    const missing = withRouter(<ActivityView read={list} selected={{ id: ID, status: "missing" }} />);
    expect(missing).toContain("isn&#x27;t in the job history");
    expect(missing).toContain("Newer job");
    expect(withRouter(<ActivityView read={list} selected={{ id: ID, status: "error", message: "The job couldn't be read" }} />)).toContain("couldn&#x27;t be read");
    // an older job that is NOT in the recent list is still shown, and an empty list does not hide it
    const older = withRouter(<ActivityView read={{ status: "ok", jobs: [] }} selected={{ id: ID, status: "ok", job: job() }} />);
    expect(older).toContain("Audit the demo clinic fixture");
    expect(older).not.toContain("The job history is empty");
  });

  test("a saved result is offered only for a finished workflow job; a running or failed one, or an ordinary job, has none", () => {
    expect(savedResultFor(job())).toBe(`/__computers/artifacts/${ID}`);
    expect(savedResultFor(job({ state: "running" } as Partial<Job>))).toBeNull();
    expect(savedResultFor(job({ state: "failed" } as Partial<Job>))).toBeNull();
    expect(savedResultFor(job({ steps: [{ seq: 1, at: 1, intent: "open", executor: "companion", ms: 0, outcome: "ok" }] } as Partial<Job>))).toBeNull();
  });

  test("the conversation's button and the route are wired to it", () => {
    const oracle = readFileSync(join(import.meta.dir, "..", "src/components/floating-oracle.tsx"), "utf8");
    expect(oracle).toContain("openJobHref(t.via, t.text)");
    expect(readFileSync(join(import.meta.dir, "..", "src/lib/thread-events.ts"), "utf8")).toContain("`/activity#job-${id}`");
    expect(oracle).toContain("/__computers/artifacts/${jobIdOf(t.via)}");
    const route = readFileSync(join(import.meta.dir, "..", "src/routes/activity.tsx"), "utf8");
    expect(route).toContain("jobIdFromHash(hash)");
    expect(route).toContain("fetchJob(selectedId!)");
  });

  test("an entry offers 'Open saved result' only when it says the hub kept one", () => {
    const via = viaFor(`${ID}:report:1`);
    expect(entryKind(via)).toBe("result");
    expect(jobIdOf(via)).toBe(ID);
    expect(ENTRY_LABEL.result).toBe("Result");
    expect(hasSavedResult("Builder: X\nSaved result: Builder: X\n(job 3f2a9c1e)")).toBe(true);
    expect(hasSavedResult("Web-sourced research...\nFull report file: report-1.md\n(job 3f2a9c1e)")).toBe(false);
    expect(hasSavedResult(undefined)).toBe(false);
  });
});
