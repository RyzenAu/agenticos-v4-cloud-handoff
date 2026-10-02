import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { codingActivity } from "../../src/lib/coding-activity";
import { Progress } from "../../src/components/coding/job-detail";
import type { CodingEvent } from "../../src/lib/coding-client";

const base = { jobId: "synthetic-job", at: "2026-09-30T00:00:00Z", roleId: null };
const events: CodingEvent[] = [
  { ...base, seq: 1, type: "text", payload: { text: "Partial output noise", final: false } },
  { ...base, seq: 2, type: "error", payload: { code: "unknown" as never, message: "Synthetic failure" } },
  { ...base, seq: 3, type: "text", payload: { text: "Final summary", final: true } },
  { ...base, seq: 4, type: "approval_resolved", payload: { approvalId: "synthetic-approval", state: "granted" as never } },
];
test("milestones retain errors, final summaries and approval outcomes; full activity stays available", () => {
  expect(codingActivity(events, "milestones").map((e) => e.seq)).toEqual([4, 3, 2]);
  expect(codingActivity(events, "agent").map((e) => e.seq)).toEqual([3, 1]);
  expect(codingActivity(events, "all").map((e) => e.seq)).toEqual([4, 3, 2, 1]);
  expect(events[0].seq).toBe(1);
});
test("default progress is readable and shows the other views", () => {
  const html = renderToStaticMarkup(createElement(Progress, { events }));
  expect(html).toContain("Synthetic failure");
  expect(html).toContain("Final summary");
  expect(html).not.toContain("Partial output noise");
  expect(html).toContain("All activity");
  expect(html).toContain("matching loaded events");
});
