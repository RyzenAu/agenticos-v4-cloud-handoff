import { expect, test } from "bun:test";
import { gateControlTask, mayRunWithYolo, runControlTask, runHermesTask, type ControlApproval } from "../../src/lib/jarvis-control";

// External-effect (needs his yes) but not a hard refusal: money/bank/secret tasks never get this far.
const task = "Delete the synthetic draft";
function approval(at = Date.now()) {
  const decision = gateControlTask({ task, confirmed: true, pending: { task, at }, lastUserUtterance: "yes", spokenYes: crypto.randomUUID(), now: at });
  if (decision.action !== "run") throw new Error("Synthetic confirmation refused");
  return decision.approval;
}
test("stale, future and fabricated approvals are refused by real executor gate", () => {
  const stale: ControlApproval = { task, tier: "external-effect", method: "spoken-yes", at: 0 };
  expect(mayRunWithYolo(task, stale).ok).toBe(false);
  expect(mayRunWithYolo(task, approval(Date.now() - 120_001)).ok).toBe(false);
  expect(mayRunWithYolo(task, approval(Date.now() + 1000)).ok).toBe(false);
  expect(mayRunWithYolo(task, { ...approval(), nonce: crypto.randomUUID() }).ok).toBe(false);
});
test("real runControlTask consumes approval once before awaiting executor", async () => {
  const grant = approval();
  let runs = 0;
  const execute = async () => { runs++; return "Synthetic result"; };
  const options = { signal: new AbortController().signal, session: {}, approval: grant, execute };
  const first = runControlTask(task, options);
  const second = runControlTask(task, options);
  expect(await first).toMatchObject({ outcome: "unverified" });
  expect(await second).toMatchObject({ outcome: "failed" });
  expect(runs).toBe(1);
  expect(mayRunWithYolo(task, grant).ok).toBe(false);
});
test("approval cannot be rebound to another task or extended", () => {
  const grant = approval();
  expect(mayRunWithYolo("Delete a different synthetic draft", grant).ok).toBe(false);
  expect(mayRunWithYolo(task, { ...grant, expiresAt: Date.now() + 600_000 }).ok).toBe(false);
});
test("late success after cancellation cannot become verified success", async () => {
  const controller = new AbortController();
  const result = await runControlTask("Open Notepad", {
    signal: controller.signal, session: {}, approval: null,
    execute: async () => { controller.abort(); return "Done"; },
    verifier: { name: "must not run", verify: async () => { throw new Error("unexpected"); } },
  });
  expect(result).toMatchObject({ outcome: "cancelled" });
});
test("direct runHermesTask cannot reuse a grant after transport failure", async () => {
  const grant = approval();
  let attempted = 0;
  const options = { signal: new AbortController().signal, session: {}, approval: grant,
    fetch: (async () => { attempted++; throw new Error("synthetic unavailable"); }) as typeof fetch };
  await expect(runHermesTask(task, options)).rejects.toThrow("synthetic unavailable");
  expect(await runHermesTask(task, options)).toMatch(/^Not run:/);
  expect(attempted).toBe(1);
});
