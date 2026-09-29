// Track 6 · the writer capability, OS side: the memory writer registers ONE per-process capability with
// the proxy before its first write, sends it on every write, re-registers once after a proxy restart, and
// writes as before to an old proxy. A refusal is visible (queued, "writer-refused"), never silent.
// TEMP synthetic vault + FAKE Hindsight in proxy mode. The PID rule itself is tested in Python
// (scripts/hindsight/tests/test_writer_capability.py): the fake can't see which process connects.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { cleanup, setup, usman } from "./testing/harness";
import { resetWriterRegistrations } from "./hindsight-client";

afterEach(async () => {
  resetWriterRegistrations({ newCapability: true });
  await cleanup();
});
const T = { timeout: 30_000 };

describe("Track 6 · writer capability (OS side)", () => {
  test(
    "the writer registers before its first write and every write carries the capability; the capability is never logged",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      const m = await h.api.remember(usman, { text: "The synthetic Pelican desk opens at 8.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("confirmed");
      expect(h.fake.writerLog.map((x) => x.event)).toEqual(["registered", "ok"]);
      expect(h.bankDocs().has(m.memory.id)).toBe(true);
      // A correction (a write and a routine delete) uses the same registration.
      const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Pelican desk opens at 9.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      expect(h.fake.writerLog.filter((x) => x.event === "registered")).toHaveLength(1);
      expect(h.fake.writerLog.every((x) => x.event === "registered" || x.event === "ok")).toBe(true);
      // Nothing on disk or in the status carries a capability-shaped value.
      const { allText } = await import("./testing/harness");
      expect(allText(h.state)).not.toMatch(/X-MU-Writer|capability_sha256/i);
    },
    T,
  );

  test(
    "a proxy restart (it forgot the capability): the next write re-registers once and goes through",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      await h.api.remember(usman, { text: "The synthetic Ibis clinic opens at 7.", channel: "voice" });
      h.fake.forgetWriter();
      const n = await h.api.remember(usman, { text: "The synthetic Spoonbill courier comes at noon.", channel: "voice" });
      if (!n.ok) throw new Error(n.message);
      expect(n.destination.indexed).toBe("confirmed");
      expect(h.fake.writerLog.map((x) => x.event)).toEqual(["registered", "ok", "unregistered", "registered", "ok"]);
    },
    T,
  );

  test(
    "an old proxy without the route: registration 404s and writes go on as before (the OS can be deployed first)",
    async () => {
      const h = await setup({ proxy: true }); // writerCapability undefined: an old proxy
      const m = await h.api.remember(usman, { text: "The synthetic Stilt account renews in May.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("confirmed");
      expect(h.fake.calls.some((c) => c.path === "/_mu/writer/register" && c.status === 404)).toBe(true);
    },
    T,
  );

  test(
    "refused as the writer (no secret to prove itself): the save is kept and queued, the status says why, nothing is silent",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      rmSync(h.env.HINDSIGHT_APPROVAL_SECRET_FILE); // this copy can't prove itself: it can't register
      const m = await h.api.remember(usman, { text: "The synthetic Avocet desk opens at 10.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("queued");
      expect(m.message).toContain("didn't accept this OS as the memory writer");
      const st = h.api.status();
      expect(st.hindsight).toBe("writer-refused");
      expect(st.pending).toBeGreaterThan(0);
      expect(st.errors.some((e) => /writer/i.test(e.error))).toBe(true);
      expect(h.bankDocs().has(m.memory.id)).toBe(false);
    },
    T,
  );

  test("a copy that isn't the writer never registers (read-only copies don't claim the capability)", async () => {
    const h = await setup({ proxy: true, writerCapability: true, writes: false });
    await h.api.recall(usman, "anything synthetic");
    expect(h.fake.calls.some((c) => c.path === "/_mu/writer/register")).toBe(false);
  });
});
