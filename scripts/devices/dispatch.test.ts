import { expect, test } from "bun:test";
import { Dispatcher } from "./dispatch";
import { defaultHub, staticRegistry } from "./registry";
import type { TargetDevice } from "./types";

// Long-poll edge cases, synthetic devices only.
const pc: TargetDevice = { id: "mehroz-pc", owner: "mehroz", kind: "companion", label: "Mehroz's PC", aliases: ["pc"], primary: true };

function setup(observeWaitMs = 50) {
  const registry = staticRegistry([defaultHub(), pc]);
  registry.heartbeat(pc.id);
  return new Dispatcher(registry, Date.now, observeWaitMs);
}

test("a reconnecting companion's new poll releases the old one empty; the command goes to the new one", async () => {
  const d = setup();
  const oldPoll = d.next(pc.id, 5_000);
  const newPoll = d.next(pc.id, 5_000);
  expect(await oldPoll).toBeNull();
  const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
  const item = await newPoll;
  expect(item?.type).toBe("command");
  d.complete(pc.id, (item as any).command.id, { ok: true, output: "ok" });
  expect(await pending).toMatchObject({ ok: true, result: "ok" });
  d.close();
});

test("an item written to a closed connection is put back for the next poll", async () => {
  const d = setup();
  const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
  const lost = await d.next(pc.id, 0);
  expect(lost?.type).toBe("command");
  d.undeliver(pc.id, lost!);
  const again = await d.next(pc.id, 0);
  expect(again).toEqual(lost);
  d.complete(pc.id, (again as any).command.id, { ok: true });
  expect((await pending).ok).toBe(true);
  d.close();
});

test("the hub resolves locally for Usman and never queues for his PC", async () => {
  const d = setup();
  expect(await d.submit({ personId: "usman", executor: "echo" })).toEqual({ ok: true, local: true, deviceId: "usman-pc" });
  expect(await d.next("usman-pc", 0)).toBeNull();
  d.close();
});

test("only the device a command was sent to can complete it", async () => {
  const d = setup();
  const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 300 });
  const item = await d.next(pc.id, 0);
  expect(d.complete("usman-pc", (item as any).command.id, { ok: true, output: "forged" })).toBe(false);
  // Delivered, then silence (no result, no answer to "what happened?"): uncertain, never "done" and never "it didn't run".
  expect(await pending).toMatchObject({ ok: false, uncertain: true, reason: expect.stringContaining("Timed out") });
  d.close();
});
