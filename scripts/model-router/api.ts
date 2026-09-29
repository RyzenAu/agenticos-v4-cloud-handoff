// scripts/model-router/api.ts — GET /__operator/model-router (+ POST /model-router/probe) for System > Models.
//
// Registered inside the operator middleware, after its socket/Host checks. A local caller needs the
// page token; a remote caller must already be a verified tailnet person (both founders have full
// access, V7). The body is metadata only: catalogue facts, health, per-model receipt totals. No keys,
// prompts, outputs or provider error text. Balances and subscription windows come from /usage.
import { catalogue } from "./catalogue";
import { routerHealthStore } from "./health";
import { probeCatalogue, type ProbeOutcome } from "./probe";
import {
  meteredSpendByProvider,
  readAllReceipts,
  summariseReceipts,
  type RouterReceipt,
} from "./receipts";

export type ModelRouterView = {
  generatedAt: string;
  catalogue: ReturnType<typeof catalogue>;
  health: ReturnType<ReturnType<typeof routerHealthStore>["snapshot"]>;
  /** Last 30 days, per catalogue model id (router receipts + reconciled MiMo/Cline ledgers). */
  usage: ReturnType<typeof summariseReceipts>;
  /** This calendar month, metered routes only (a floor: calls outside the router aren't counted). */
  meteredThisMonth: ReturnType<typeof meteredSpendByProvider>;
  recent: RouterReceipt[];
  receiptSource: string;
  probes?: ProbeOutcome[];
};

export function modelRouterView(root: string, now = Date.now()): ModelRouterView {
  const month = new Date(now);
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const receipts = readAllReceipts(root, { since: now - 30 * 86_400_000 });
  return {
    generatedAt: new Date(now).toISOString(),
    catalogue: catalogue(),
    health: routerHealthStore(root).snapshot(),
    usage: summariseReceipts(receipts),
    meteredThisMonth: meteredSpendByProvider(
      receipts.filter((r) => Date.parse(r.startedAt) >= monthStart),
    ),
    recent: receipts.slice(-40).reverse(),
    receiptSource:
      "Router receipts (.operator-data/model-router/receipts.jsonl) plus the reconciled MiMo ledger and Cline fleet receipts. Job-store sink replaces the JSONL at merge.",
  };
}

export async function modelRouterRoute(
  input: { path: string; method: string; remote: boolean; authenticated: boolean },
  root: string,
  deps: { probe?: typeof probeCatalogue } = {},
): Promise<{ status: number; body: unknown } | null> {
  if (input.path !== "/model-router" && input.path !== "/model-router/probe") return null;
  if (!input.remote && !input.authenticated)
    return { status: 403, body: { error: "Sign-in required." } };
  // The probe makes outbound reads with the hub's own keys: the owner at this PC only (REVIEW-E12 H2;
  // identity routes: /__operator/model-router/probe is local-owner).
  if (input.remote && input.path === "/model-router/probe")
    return { status: 403, body: { error: "The model probe runs only at this PC." } };
  try {
    if (input.path === "/model-router") {
      if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      return { status: 200, body: modelRouterView(root) };
    }
    if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
    const probes = await (deps.probe ?? probeCatalogue)({ root, force: true });
    return { status: 200, body: { ...modelRouterView(root), probes } };
  } catch {
    return { status: 500, body: { error: "Model router data unavailable." } };
  }
}
