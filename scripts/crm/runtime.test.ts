import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCrmIntegrations, crmRuntime, closeCrmRuntime } from "./runtime";
import { closeJobsRuntime } from "../jobs/runtime";
import type { Principal } from "../identity/principal";
const founder: Principal = {
  personId: "usman",
  via: "paired-session",
  actor: "human",
  displayName: "Usman",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeCrmRuntime(root);
    closeJobsRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("trusted integrations are explicit, removable and shared with an already-open runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "crm-runtime-"));
  roots.push(root);
  const r = crmRuntime(root);
  expect(crmRuntime(root)).toBe(r);
  const company = r.store.createCompany(
    { name: "Synthetic integration company" },
    { personId: "usman" },
  );
  const ref = { kind: "company" as const, id: company.id };
  const activity = {
    ref,
    eventId: "synthetic-job:result",
    kind: "agent-result",
    title: "Synthetic research completed",
    by: { agent: "synthetic-researcher", jobId: "synthetic-job" },
    artifact: "artifact:synthetic-job/report.txt",
  };
  expect(r.operations.run("crm.activity.add", activity, founder).ok).toBe(false);
  const remove = configureCrmIntegrations(root, {
    verifyAgent: (by, p, subject) =>
      by.jobId === "synthetic-job" &&
      by.agent === "synthetic-researcher" &&
      p.personId === "usman" &&
      subject.id === company.id,
    verifyCommunicationEvidence: (e, p, subject) =>
      e.provider === "synthetic-provider" &&
      e.eventId === "synthetic-message" &&
      p.personId === "usman" &&
      subject.id === company.id,
  });
  const first = r.operations.run("crm.activity.add", activity, founder);
  expect(first.ok).toBe(true);
  expect(r.operations.run("crm.activity.add", activity, founder).activityId).toBe(first.activityId);
  expect(
    r.operations.run(
      "crm.activity.add",
      {
        ref,
        eventId: "synthetic-provider:message",
        kind: "email",
        title: "Synthetic sent evidence",
        communicationState: "sent",
        providerEvidence: {
          provider: "synthetic-provider",
          eventId: "synthetic-message",
          observedAt: "2026-10-02T08:00:00Z",
          state: "sent",
        },
      },
      founder,
    ).ok,
  ).toBe(true);
  const other = r.store.createCompany({ name: "Other synthetic company" }, { personId: "usman" });
  expect(
    r.operations.run(
      "crm.activity.add",
      {
        ref: { kind: "company", id: other.id },
        eventId: "wrong-client-message",
        kind: "email",
        title: "Synthetic sent evidence",
        communicationState: "sent",
        providerEvidence: {
          provider: "synthetic-provider",
          eventId: "synthetic-message",
          observedAt: "2026-10-02T08:00:00Z",
          state: "sent",
        },
      },
      founder,
    ).ok,
  ).toBe(false);
  remove();
  expect(
    r.operations.run("crm.activity.add", { ...activity, eventId: "another-result" }, founder).ok,
  ).toBe(false);
  expect(r.store.snapshot().activities).toHaveLength(2);
});
