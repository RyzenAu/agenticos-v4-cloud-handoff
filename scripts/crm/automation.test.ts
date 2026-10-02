import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CrmStore } from "./store";
import { CrmAutomations } from "./automation";
import { JobService } from "../jobs/service";
import type { Principal } from "../identity/principal";
const principal: Principal = {
  personId: "usman",
  via: "paired-session",
  actor: "human",
  displayName: "Usman",
};
const by = { personId: "usman" as const };
const now = "2026-10-02T08:00:00.000Z";
const close: (() => void)[] = [];
function fixture() {
  const db = new Database(":memory:");
  const store = new CrmStore(db, { now: () => now });
  const jobs = new JobService({ path: ":memory:" });
  close.push(() => {
    jobs.close();
    db.close();
  });
  return { db, store, jobs, automation: new CrmAutomations({ store, jobs, now: () => now }) };
}
afterEach(() => {
  for (const fn of close.splice(0)) fn();
});
describe("CRM durable event adapter", () => {
  test("new enquiry records company/contact/task exactly once across adapter restart", () => {
    const { store, jobs, automation } = fixture();
    const event = {
      eventId: "enquiry:one",
      trigger: "enquiry.received" as const,
      at: now,
      payload: {
        companyName: "Synthetic enquiry",
        contactName: "Sarah Example",
        email: "sarah@example.test",
        provider: "synthetic-form",
        providerEventId: "form-1",
      },
    };
    const first = automation.accept(event, principal);
    expect(first.ok, first.text).toBe(true);
    const restarted = new CrmAutomations({ store, jobs });
    expect(restarted.accept(event, principal).duplicate).toBe(true);
    expect(store.snapshot().companies).toHaveLength(1);
    expect(store.snapshot().contacts).toHaveLength(1);
    expect(store.snapshot().tasks).toHaveLength(1);
    expect(jobs.list({ kind: "trigger" })).toHaveLength(1);
    expect(jobs.get(first.jobId!)?.state).toBe("succeeded");
    expect(() =>
      automation.accept(
        { ...event, payload: { ...event.payload, companyName: "Different content" } },
        principal,
      ),
    ).toThrow();
  });
  test("Won opens onboarding once even under different event IDs and never records payment", () => {
    const { store, automation } = fixture();
    const c = store.createCompany({ name: "Win account" }, by);
    const d = store.createDeal(
      {
        companyId: c.id,
        title: "Website",
        service: "website",
        commercialBasis: "agreed",
        scope: "Approved scope",
        stageId: "won",
      },
      by,
    );
    const event = {
      eventId: "win:1",
      trigger: "deal.won" as const,
      at: now,
      ref: { kind: "deal" as const, id: d.id },
      payload: {},
    };
    const first = automation.accept(event, principal);
    expect(first.ok, first.text).toBe(true);
    expect(automation.accept({ ...event, eventId: "win:other" }, principal).duplicate).toBe(true);
    expect(store.snapshot().projects).toHaveLength(1);
    expect(store.snapshot().tasks).toHaveLength(1);
    expect(first.text).toContain("Payment remains unconfirmed");
    expect(store.snapshot().documents).toHaveLength(0);
  });
  test("rule failure is visible, does not partially persist, and retry uses existing jobs", () => {
    const { store, automation, jobs } = fixture();
    const c = store.createCompany({ name: "Reply account" }, by);
    const missing = {
      eventId: "reply:missing",
      trigger: "reply.received" as const,
      at: now,
      ref: { kind: "company" as const, id: c.id },
      payload: {},
    };
    expect(automation.accept(missing, principal).ok).toBe(false);
    expect(store.snapshot().tasks).toHaveLength(0);
    expect(automation.list().find((r) => r.id === "reply.received")?.lastError).toContain(
      "provider",
    );
    // Content on an ID is immutable. A corrected source event uses a new provider event ID.
    const reply = {
      ...missing,
      eventId: "reply:valid",
      payload: { provider: "synthetic-mail", providerEventId: "mail-1" },
    };
    expect(automation.accept(reply, principal).ok).toBe(true);
    expect(automation.accept(reply, principal).duplicate).toBe(true);
    expect(store.snapshot().tasks).toHaveLength(1);
    expect(
      jobs
        .list({ kind: "trigger" })
        .map((j) => j.state)
        .sort(),
    ).toEqual(["failed", "succeeded"]);
  });
  test("transient failure rolls back the whole action and replay completes only once", () => {
    const { store, jobs, automation } = fixture();
    const event = {
      eventId: "retry:1",
      trigger: "enquiry.received" as const,
      at: now,
      payload: {
        companyName: "Retry account",
        contactName: "Example Person",
        provider: "synthetic-form",
        providerEventId: "retry-provider-1",
      },
    };
    const createTask = store.createTask.bind(store);
    store.createTask = () => {
      throw new Error("Synthetic storage outage");
    };
    expect(automation.accept(event, principal).ok).toBe(false);
    expect(store.snapshot().companies).toHaveLength(0);
    expect(store.snapshot().contacts).toHaveLength(0);
    expect(store.snapshot().activities).toHaveLength(0);
    store.createTask = createTask;
    expect(automation.accept(event, principal).ok).toBe(true);
    expect(automation.accept(event, principal).duplicate).toBe(true);
    expect(store.snapshot().companies).toHaveLength(1);
    expect(store.snapshot().tasks).toHaveLength(1);
    expect(
      jobs
        .list({ kind: "trigger" })
        .map((j) => j.state)
        .sort(),
    ).toEqual(["failed", "succeeded"]);
    expect(automation.list().find((r) => r.id === "enquiry.received")?.lastError).toBeNull();
  });
  test("CRM commit survives a lost Jobs completion acknowledgement", () => {
    const { store, jobs, automation } = fixture();
    const c = store.createCompany({ name: "Acknowledgement account" }, by);
    const event = {
      eventId: "ack:1",
      trigger: "meeting.completed" as const,
      at: now,
      ref: { kind: "company" as const, id: c.id },
      payload: { nextAction: "Review the saved notes" },
    };
    const finish = jobs.finish.bind(jobs);
    jobs.finish = () => {
      throw new Error("Synthetic acknowledgement outage");
    };
    expect(automation.accept(event, principal).ok).toBe(true);
    expect(store.snapshot().tasks).toHaveLength(1);
    jobs.finish = finish;
    jobs.recover();
    const restarted = new CrmAutomations({ store, jobs });
    expect(restarted.accept(event, principal).duplicate).toBe(true);
    expect(store.snapshot().tasks).toHaveLength(1);
  });
  test("meeting next action and renewal occurrence are idempotent", () => {
    const { store, automation } = fixture();
    const c = store.createCompany({ name: "Delivery account" }, by);
    const meeting = {
      eventId: "meeting:1",
      trigger: "meeting.completed" as const,
      at: now,
      ref: { kind: "company" as const, id: c.id },
      payload: { nextAction: "Provide the promised sitemap", dueAt: "2026-10-05T08:00:00.000Z" },
    };
    expect(automation.accept(meeting, principal).ok).toBe(true);
    expect(automation.accept(meeting, principal).duplicate).toBe(true);
    const project = store.createProject(
      { companyId: c.id, name: "Ongoing site", renewalAt: "2026-11-01T00:00:00.000Z" },
      by,
    );
    const renewal = {
      eventId: "renewal:1",
      trigger: "renewal.approaching" as const,
      at: now,
      ref: { kind: "project" as const, id: project.id },
      payload: { renewalDate: project.renewalAt! },
    };
    expect(automation.accept(renewal, principal).ok).toBe(true);
    expect(automation.accept({ ...renewal, eventId: "renewal:2" }, principal).duplicate).toBe(true);
    expect(store.snapshot().tasks).toHaveLength(2);
  });
  test("disabled, disconnected and receptionist-on-hold states are explicit", () => {
    const { store, automation } = fixture();
    automation.setEnabled("enquiry.received", false);
    const event = {
      eventId: "disabled:1",
      trigger: "enquiry.received" as const,
      at: now,
      payload: { companyName: "No creation", provider: "synthetic", providerEventId: "1" },
    };
    expect(automation.accept(event, principal)).toMatchObject({
      ok: true,
      skipped: true,
      outcome: "disabled",
    });
    expect(store.snapshot().companies).toHaveLength(0);
    const disconnected = new CrmAutomations({ store });
    expect(
      disconnected.accept(
        { ...event, eventId: "disconnected", trigger: "meeting.completed" },
        principal,
      ),
    ).toMatchObject({ ok: false, outcome: "blocked" });
    const c = store.createCompany({ name: "Paused service" }, by);
    const d = store.createDeal(
      { companyId: c.id, title: "Paused", service: "receptionist", stageId: "won" },
      by,
    );
    expect(
      automation.accept(
        {
          eventId: "paused",
          trigger: "deal.won",
          at: now,
          ref: { kind: "deal", id: d.id },
          payload: {},
        },
        principal,
      ),
    ).toMatchObject({ ok: true, skipped: true, outcome: "receptionist-on-hold" });
    expect(store.snapshot().projects).toHaveLength(0);
  });
});
