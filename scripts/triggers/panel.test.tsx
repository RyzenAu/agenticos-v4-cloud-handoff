// The Triggers panel on the Automations page: state words, last delivery, linked jobs and the controls. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { canRetry, deliveryLine, routineLine, sourceText, TriggersPanel, type TriggerRow } from "../../src/components/operator/triggers-panel";

const base: TriggerRow = {
  id: "trg-synthetic-enquiry", name: "New enquiry: draft a reply", kind: "event", source: "synthetic.enquiry", action: "lead.process", mode: "draft", state: "active", health: "active", retryLimit: 3,
  stats: { delivered: 2, duplicates: 3, ignored: 1, failed: 0, pending: 1 }, lastRun: null, nextRunAt: null,
  lastDelivery: { id: 1, status: "awaiting-approval", reason: null, attempts: 1, repeats: 3, receivedAt: "2026-10-01T01:00:00.000Z", jobId: "11111111-1111-4111-8111-111111111111", jobs: [{ attempt: 1, jobId: "11111111-1111-4111-8111-111111111111" }] },
};
const render = (rows: TriggerRow[]) => {
  const client = new QueryClient();
  client.setQueryData(["triggers"], { triggers: rows });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <QueryClientProvider client={client}>
        <TriggersPanel />
      </QueryClientProvider>
    </RouterContextProvider>,
  );
};

describe("TriggersPanel", () => {
  test("shows nothing until there is a trigger", () => {
    expect(render([])).toBe("");
  });

  test("an active trigger: state, last delivery, linked job and the pause control", () => {
    const html = render([base]);
    expect(html).toContain('data-trigger="trg-synthetic-enquiry"');
    expect(html).toContain('data-state="active"');
    expect(html).toContain("waiting for your approval");
    expect(html).toContain("11111111");
    expect(html).toContain("Pause");
    expect(html).not.toContain(">Retry<");
    expect(html).toContain("Nothing here sends a message");
  });

  test("a failing trigger offers Retry; a paused one offers Resume; a disabled one Enable", () => {
    const failing: TriggerRow = { ...base, health: "failing", lastDelivery: { ...base.lastDelivery!, status: "failed", reason: "action-failed" } };
    const html = render([failing, { ...base, id: "trg-b", state: "paused", health: "paused" }, { ...base, id: "trg-c", state: "disabled", health: "disabled" }]);
    expect(html).toContain("Failing");
    expect(html).toContain("failed, needs you");
    expect(html).toContain("the action failed");
    expect(html).toContain("Retry");
    expect(html).toContain("Resume");
    expect(html).toContain("Enable");
  });

  test("pure helpers", () => {
    expect(deliveryLine(null)).toBe("No events yet.");
    expect(canRetry({ ...base.lastDelivery!, status: "unknown" })).toBe(true);
    expect(canRetry({ ...base.lastDelivery!, status: "succeeded" })).toBe(false);
    expect(routineLine({ offlinePolicy: "run-once", lastRun: { slot: "s", outcome: "ran-on-return", jobId: null, at: "x", missed: 1 }, nextRunAt: null })).toBe(
      "If the PC is off at the time it runs it once on return. Last: ran late, once, after the PC was off.",
    );
    expect(sourceText({ kind: "routine", source: "routine.schedule", schedule: { kind: "daily", at: "07:30", tz: "Australia/Sydney" } })).toBe("Every day at 07:30 (Sydney)");
  });
});
