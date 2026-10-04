import { test, expect } from "bun:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NabConnection } from "../../src/components/finance/nab-connection";
import { createNabSyntheticScheduler, type NabTimers } from "./lifecycle";
import { createNabSyntheticService } from "./service";

const ctx = { tenantId: "synthetic-preview", ownerId: "synthetic-owner" };
function fakeClock() {
  let now = Date.parse("2026-09-27T00:00:00Z"), sequence = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const timers: NabTimers = { now: () => now, set: (fn, delay) => { const id = ++sequence; tasks.set(id, { at: now + delay, fn }); return id; }, clear: id => { tasks.delete(id as number); } };
  return { timers, jump: (ms: number) => { now += ms; }, advance(ms: number) {
    const end = now + ms; let turns = 0;
    while (true) {
      const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break; if (++turns > 10000) throw new Error("timer loop");
      now = next[1].at; tasks.delete(next[0]); next[1].fn();
    } now = end;
  }, count: () => tasks.size };
}
function seeded(clock: ReturnType<typeof fakeClock>, days = 1) {
  const service = createNabSyntheticService({ now: clock.timers.now });
  const c = service.consent(ctx, { acknowledgement: "synthetic-only", purpose: "cash-flow-review", scopes: ["accounts", "balances", "transactions"], accountIds: ["syn-business"], durationDays: days });
  service.importFixture(ctx, { fixtureId: "cashflow-v1", ownerInitiated: true, generation: c.generation });
  return { service, generation: c.generation };
}

test("actual mounted component hides expired amounts on timer, focus and visibility, and cleans up", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  try {
    for (const trigger of ["timer", "focus", "visibilitychange"]) {
      const clock = fakeClock(), { service } = seeded(clock);
      const root = createRoot(document.getElementById("root")!);
      await act(async () => { root.render(createElement(NabConnection, { timers: clock.timers, syntheticService: service })); });
      expect(document.body.textContent).toContain("$2,315.00");
      await act(async () => {
        if (trigger === "timer") clock.advance(86400000);
        else { clock.jump(86400000); (trigger === "focus" ? window : document).dispatchEvent(new window.Event(trigger)); }
      });
      expect(document.body.textContent).toContain("expired"); expect(document.body.textContent).not.toContain("$2,315.00");
      expect(document.body.textContent).not.toContain("$915.00");
      await act(async () => { root.unmount(); }); expect(clock.count()).toBe(0);
    }
  } finally {
    for (const [name, descriptor] of [["window", priorWindow], ["document", priorDocument], ["IS_REACT_ACT_ENVIRONMENT", priorAct]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("opt-in synthetic scheduler refreshes once due, stops on revoke/expiry and creates no job on construction", () => {
  const clock = fakeClock(), { service, generation } = seeded(clock, 3);
  const scheduler = createNabSyntheticScheduler(service, ctx, clock.timers);
  expect(clock.count()).toBe(0);
  scheduler.start({ acknowledgement: "synthetic-only", generation }); expect(scheduler.running()).toBe(true);
  clock.advance(86400000); expect(service.audit(ctx).filter(x => x.action === "refresh")).toHaveLength(1);
  service.revoke(ctx); clock.advance(60000); expect(scheduler.running()).toBe(false); expect(clock.count()).toBe(0);
  const another = seeded(clock, 1); const expiry = createNabSyntheticScheduler(another.service, ctx, clock.timers);
  expiry.start({ acknowledgement: "synthetic-only", generation: another.generation }); clock.advance(86400000);
  expect(expiry.running()).toBe(false); expect(another.service.status(ctx).phase).toBe("expired");
  expect(another.service.audit(ctx).filter(x => x.action === "refresh")).toHaveLength(0);
});

test("mounted manual import and scheduler controls are idempotent and stop on revoke/unmount", async () => {
  const names = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [name, value] of [["window", window], ["document", document], ["IS_REACT_ACT_ENVIRONMENT", true]] as const)
    Object.defineProperty(globalThis, name, { value, configurable: true });
  const clock = fakeClock(), { service } = seeded(clock, 7);
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(NabConnection, { timers: clock.timers, syntheticService: service })); });
    const click = async (label: string) => {
      const button = [...document.querySelectorAll("button")].find(node => node.textContent === label);
      expect(button).toBeDefined();
      await act(async () => { button!.dispatchEvent(new window.Event("click", { bubbles: true })); });
    };
    expect(clock.count()).toBe(1); // Status invalidation only; no automatic import.
    await click("Import built-in sample");
    expect(document.body.textContent).toContain("0 changed entries");
    expect(service.status(ctx).cashFlow?.netCashMinor).toBe(91500);
    await click("Start automatic sample refresh");
    expect(clock.count()).toBe(2);
    await act(async () => { clock.advance(86400000); });
    expect(service.audit(ctx).filter(event => event.action === "refresh")).toHaveLength(1);
    expect(service.status(ctx).cashFlow?.netCashMinor).toBe(91500);
    await click("Stop automatic sample refresh"); expect(clock.count()).toBe(1);
    await click("Start automatic sample refresh");
    await click("Revoke and clear sample"); expect(clock.count()).toBe(1);
    expect(document.body.textContent).not.toContain("$2,315.00");
    expect(document.body.textContent).not.toContain("$915.00");
    expect(service.status(ctx).phase).toBe("revoked");
  } finally {
    await act(async () => { root.unmount(); }); expect(clock.count()).toBe(0);
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("the NAB connection view points real statements to the one Finance importer and reads no file itself", async () => {
  const names = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [name, value] of [["window", window], ["document", document], ["IS_REACT_ACT_ENVIRONMENT", true]] as const)
    Object.defineProperty(globalThis, name, { value, configurable: true });
  const root = createRoot(document.getElementById("root")!);
  const clock = fakeClock();
  try {
    await act(async () => { root.render(createElement(NabConnection, { timers: clock.timers })); });
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).toContain("Import your NAB CSV export on the Finance page");
    expect(document.body.textContent).not.toContain("nab-manual-v1");
    expect(document.querySelector('a[href="/finance"]')).not.toBeNull();
  } finally {
    await act(async () => { root.unmount(); }); expect(clock.count()).toBe(0);
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name);
    });
  }
});
