import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { ActivityBus } from "../events/bus";
import { startActivitySources } from "../events/sources";
import {
  activeCrmRef,
  crmIntentIn,
  crmSubjectsFrom,
  crmWriteRefusal,
  runCrmIntent,
  type CrmRunDeps,
} from "./crm";
import { planRules } from "./plan";
import { parsePageContext } from "./context";

const usman: Principal = {
  personId: "usman",
  via: "loopback-owner",
  actor: "human",
  displayName: "Usman",
};
const bare: Principal = {
  personId: "mehroz",
  via: "tailnet-person",
  actor: "process",
  displayName: "Mehroz",
};
const gateway: Principal = {
  personId: "usman",
  via: "routine",
  actor: "process",
  displayName: "Usman",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeCrmRuntime(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* locked until GC on Windows */
    }
  }
});
function rig(over: Partial<CrmRunDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "crm-jarvis-"));
  roots.push(root);
  const rt = crmRuntime(root);
  const company = rt.store.createCompany({ name: "Synthetic Jarvis Co" }, { personId: "usman" });
  const deps: CrmRunDeps = {
    operations: () => rt.operations,
    role: () => "pc",
    readOnly: () => false,
    ...over,
  };
  return { rt, company, deps };
}

test("spoken and typed CRM words are recognised, and ordinary speech is not", () => {
  expect(crmIntentIn("what follow-ups are overdue")).toEqual({ kind: "overdue", mine: false });
  expect(crmIntentIn("My overdue follow-ups")).toEqual({ kind: "overdue", mine: true });
  expect(crmIntentIn("what have we promised this client?")).toEqual({ kind: "promises" });
  expect(crmIntentIn("add a note to this deal: sent the revised scope")).toEqual({
    kind: "note",
    text: "sent the revised scope",
  });
  expect(crmIntentIn('crm.task.complete {"id":"t1","expectedVersion":2}')).toEqual({
    kind: "typed",
    name: "crm.task.complete",
    input: { id: "t1", expectedVersion: 2 },
  });
  expect(crmIntentIn("crm.task.complete {nope")).toMatchObject({ kind: "invalid" });
  expect(crmIntentIn("open notepad")).toBeNull();
  expect(planRules("overdue follow-ups")).toMatchObject({ lane: "delegate", to: "crm" });
  // The existing Leads rule keeps its words.
  expect(planRules("mark Synthetic Dental Co as won")).toMatchObject({ to: "leads" });
});

test("the open record comes only from an explicit CRM selection, in either context shape", () => {
  const snapshot = { selection: { to: "/crm", search: { ref: "crm:deal:d1", tab: "deals" } } };
  expect(activeCrmRef(snapshot)).toEqual({ kind: "deal", id: "d1" });
  // What the command service sees after parsePageContext: the selection is an item with an href.
  const wire = parsePageContext({
    version: 1,
    page: { path: "/crm", destination: "work", title: "CRM" },
    selection: {
      kind: "client",
      id: "c1",
      label: "Synthetic Jarvis Co",
      to: "/crm",
      search: { ref: "crm:company:c1", tab: "overview" },
    },
    focused: null,
    visible: [],
    sources: [],
    job: null,
    providers: [],
    at: Date.now(),
  });
  expect(activeCrmRef(wire as never)).toEqual({ kind: "company", id: "c1" });
  expect(crmSubjectsFrom(wire as never, ["crm:lead:9", "not-a-ref"])).toEqual([
    "crm:lead:9",
    "crm:company:c1",
  ]);
  expect(
    activeCrmRef({ selection: { to: "/finance", search: { ref: "crm:deal:d1" } } }),
  ).toBeNull();
  expect(activeCrmRef(null)).toBeNull();
});

test("a note goes through crm.activity.add for the verified person and the open record; a repeat is one activity", async () => {
  const { rt, company, deps } = rig();
  const ctx = { selection: { to: "/crm", search: { ref: `crm:company:${company.id}` } } };
  const intent = crmIntentIn("add a note to this client: wants the quote by Friday")!;
  const first = await runCrmIntent(deps, intent, usman, ctx, { eventId: "evt-123456" });
  expect(first).toMatchObject({ ok: true, verified: true });
  const again = await runCrmIntent(deps, intent, usman, ctx, { eventId: "evt-123456" });
  expect(again.ok).toBe(true);
  const notes = rt.store.snapshot().activities.filter((a) => a.eventId === "jarvis:evt-123456");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: "note", companyId: company.id });
  // No open record: it asks, and writes nothing.
  const none = await runCrmIntent(deps, intent, usman, null, { eventId: "evt-999999" });
  expect(none).toMatchObject({ ok: false, verified: null });
  expect(
    rt.store.snapshot().activities.filter((a) => a.eventId === "jarvis:evt-999999"),
  ).toHaveLength(0);
});

test("writes are refused for a bare tailnet login, a gateway principal, a read-only copy and an unconfirmed server-role caller", async () => {
  const { rt, company, deps } = rig();
  const write = crmIntentIn(
    `crm.company.update {"id":"${company.id}","expectedVersion":1,"patch":{"notes":"x"}}`,
  )!;
  // The /__crm gate in every role: a bare tailnet login and a paired session on a pc hub never write; only the owner at the hub does.
  expect((await runCrmIntent(deps, write, bare, null)).ok).toBe(false);
  const paired: Principal = {
    personId: "usman",
    via: "paired-session",
    actor: "human",
    displayName: "Usman",
  };
  expect((await runCrmIntent(deps, write, paired, null)).said).toContain("at the hub itself");
  expect(crmWriteRefusal(paired, "cloud", false)).toContain("at the hub itself");
  expect((await runCrmIntent(deps, write, usman, null)).ok).toBe(true);
  const gw = await runCrmIntent(deps, write, gateway, null);
  expect(gw.ok).toBe(false);
  expect(gw.said).toContain("nothing changed");
  expect(
    (await runCrmIntent({ ...deps, readOnly: () => true }, write, usman, null)).said,
  ).toContain("read-only");
  expect(crmWriteRefusal(bare, "server", false)).toContain("confirmed sign-in");
  expect(
    crmWriteRefusal({ ...bare, via: "paired-session", actor: "human" }, "server", false),
  ).toBeNull();
  expect(crmWriteRefusal(usman, "server", false)).toBeNull();
  expect(crmWriteRefusal(usman, "pc", false)).toBeNull();
  // Reads match /__crm too: Telegram, a routine and a gateway are refused; the owner and a signed-in founder read.
  const telegram: Principal = {
    personId: "usman",
    via: "telegram-owner",
    actor: "human",
    displayName: "Usman",
  };
  const overdue = { kind: "overdue" as const, mine: false };
  expect((await runCrmIntent(deps, overdue, telegram, null)).ok).toBe(false);
  expect((await runCrmIntent(deps, overdue, gateway, null)).ok).toBe(false);
  expect((await runCrmIntent(deps, overdue, bare, null)).ok).toBe(true);
  expect((await runCrmIntent(deps, overdue, usman, null)).ok).toBe(true);
  expect(rt.store.getCompany(company.id)!.version).toBe(2); // exactly one write went through
});

test("typed operations are limited to the narrow list; bulk and configuration operations stay in the page", async () => {
  const { company, deps } = rig();
  for (const name of [
    "crm.csv.commit",
    "crm.duplicates.merge",
    "crm.automations.configure",
    "crm.pipeline.update",
    "crm.workflow.update",
    "crm.nonsense",
  ]) {
    const r = await runCrmIntent(deps, { kind: "typed", name, input: {} }, usman, null);
    expect(r.ok).toBe(false);
    expect(r.said).toContain("isn't something I run from here");
  }
  const read = await runCrmIntent(
    deps,
    { kind: "typed", name: "crm.record.get", input: { ref: { kind: "company", id: company.id } } },
    usman,
    null,
  );
  expect(read.ok).toBe(true);
  // Validation comes from the CRM's own schema, not from here.
  const bad = await runCrmIntent(
    deps,
    { kind: "typed", name: "crm.company.create", input: { name: "" } },
    usman,
    null,
  );
  expect(bad).toMatchObject({ ok: false, verified: false });
});

test("an un-upgraded CRM is a plain sentence, not a crash", async () => {
  const deps: CrmRunDeps = {
    operations: () => {
      throw Object.assign(new Error("CRM needs its one-time upgrade."), { code: "needs-upgrade" });
    },
    role: () => "pc",
    readOnly: () => false,
  };
  const r = await runCrmIntent(deps, { kind: "overdue", mine: false }, usman, null);
  expect(r).toEqual({ ok: false, said: "CRM needs its one-time upgrade.", verified: null });
});

test("the activity stream carries crm changes as references only, to both founders", () => {
  const bus = new ActivityBus();
  const sources = startActivitySources({
    bus,
    registry: () => ({ all: () => [], isOnline: () => false }) as never,
    sampleMs: 60_000,
  });
  try {
    sources.crmChanged({
      ref: { kind: "deal", id: "d1" },
      change: "updated",
      at: "2026-10-03T00:00:00.000Z",
    });
    sources.crmChanged({ ref: undefined as never, change: "updated", at: "x" });
    const entries = bus.since(0, (e) => e.topic === "crm")!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      topic: "crm",
      type: "updated",
      scope: "shared",
      final: false,
    });
    expect(JSON.parse(entries[0].frame.split("data: ")[1]).data).toEqual({
      ref: { kind: "deal", id: "d1" },
      change: "updated",
      at: "2026-10-03T00:00:00.000Z",
    });
  } finally {
    sources.stop();
  }
});
