// scripts/model-router/defaults.ts — the receipt sink and health store a call site gets when it
// doesn't pass its own. Production: the shared files under .operator-data/model-router. Under
// `bun test` (NODE_ENV=test) a call site's own tests must never write the real receipts file or mark a
// real model limited (a fake 429 in one test would otherwise sideline that model for the next), so
// they get an in-memory sink (one per process, inspectable) and a fresh in-memory health store.
import { MemoryHealthStore, routerHealthStore, type HealthStore } from "./health";
import { MemoryReceiptSink, routerReceiptSink, type ReceiptSink } from "./receipts";

export const inTests = () => process.env.NODE_ENV === "test" && process.env.MU_ROUTER_REAL_FILES !== "1";

/** Receipts written by call sites under test that passed no sink of their own. */
export const testReceipts = new MemoryReceiptSink();

export function defaultReceiptSink(root: string): ReceiptSink {
  return inTests() ? testReceipts : routerReceiptSink(root);
}

export function defaultHealthStore(root: string): HealthStore {
  return inTests() ? new MemoryHealthStore() : routerHealthStore(root);
}

/**
 * REVIEW-E12 BL1/M1: a health view for sites that tried every engine on every call before the router
 * (Jev, vision, pointing, meeting notes, CAD, inbox, Gemini flash). It starts empty for each call, so no
 * other surface's failure (and no failure from an earlier call) makes this call skip a model. Failures it
 * records are MIRRORED to the shared store after the reply (setImmediate), so the Models page still shows
 * them; it never reads the shared store.
 */
export class CallHealth extends MemoryHealthStore {
  constructor(private mirror: (() => HealthStore) | null) {
    super();
  }
  override markModel(id: string, patch: Parameters<HealthStore["markModel"]>[1]) {
    super.markModel(id, patch);
    const mirror = this.mirror;
    if (mirror)
      setImmediate(() => {
        try {
          mirror().markModel(id, patch);
        } catch {
          /* health is advisory */
        }
      });
  }
}

export function callHealth(root: string): HealthStore {
  return new CallHealth(inTests() ? null : () => routerHealthStore(root));
}

/** Under test, a call site that forgot to inject its transport gets this instead of the network:
 *  no test can make a real (possibly paid) model call by accident. */
export const offlineInTests: typeof fetch = (async () => {
  throw Object.assign(new Error("ECONNREFUSED: no real model calls under bun test (inject a fake request)"), { code: "ECONNREFUSED" });
}) as unknown as typeof fetch;

export function defaultRequest(request?: typeof fetch): typeof fetch {
  return request ?? (inTests() ? offlineInTests : fetch);
}
