/**
 * Thin hub adapters for the OS pages Dot opens through the gateway (docs/gateway/DOT-UI-ROUTES.md).
 *
 * The pages fetch their data from founder routes (/__crm/snapshot, /__finance_manual/summary, /__jobs, /__computers). Those
 * stay closed to the gateway (most are in policy.ts NEVER). Instead the gateway's UI bundle sends the same request to
 * /__gateway/ui/<same path> (src/lib/dot-gateway.ts), and these adapters answer with the SAME response shape, filtered for the
 * gateway principal exactly as its /__gateway routes are:
 *
 *   crm/snapshot, crm/record      crm.read     the CRM's own operations under the gateway actor (the CRM guard), exactly
 *                                              what POST /__gateway/crm/read returns for crm.snapshot / crm.record.get
 *   crm/finance                   finance.read a company's Stripe invoice links, from the CRM snapshot under the gateway actor
 *   finance/summary|status|transactions   finance.read   the founders' own handler over a BUSINESS-ONLY view of the ledger:
 *                                              personal and unreviewed rows do not exist in it; no audit, no vendor rules
 *   jobs, jobs/events, jobs/<id>  ops.read     the redacted job log (review B1): Dot's own jobs in full; founders' jobs as id,
 *                                              kind, state and timing only; events only for Dot's own jobs
 *   computers                     bots.operate shared bot computers only; no personal device or target list
 */
import { SHARED_LEDGER, type ManualFinanceStore } from "../finance/manual-store";
import { isGatewayActor } from "./actor";

type Row = Record<string, unknown> & { id?: unknown; principal?: unknown };

const own = (j: { principal?: unknown }) => isGatewayActor({ ...(j?.principal as object), actor: "process" } as never);

/** A founder's job as Dot may see it: its shape only, never its words or Jarvis's reply. Dot's own job in full. */
export function jobShape(j: Row): Row {
  if (own(j)) return { ...j, yours: true };
  return { id: j.id, kind: j.kind, state: j.state, title: "Founder's job (details not available to Dot)", targetDeviceId: "", cancelRequested: false, quarantined: false, createdAt: j.createdAt, updatedAt: j.updatedAt, stepCount: j.stepCount ?? (Array.isArray(j.steps) ? j.steps.length : 0), lastStep: null, steps: [], receipts: [], principal: { personId: "founder", via: "hidden", actor: "hidden" } };
}

/** Job events Dot may follow: only its own jobs' (a founder's event carries his words). */
export function jobEventsFor(events: Array<{ jobId?: string; seq: number }>, isOwn: (jobId: string) => boolean) {
  return events.filter((e) => typeof e.jobId === "string" && isOwn(e.jobId));
}

/**
 * The manual ledger with ONLY its business rows. Every read the founders' handler makes for /summary, /status and
 * /transactions goes through this view; anything that could write is refused.
 */
export function businessOnlyLedger(store: ManualFinanceStore): ManualFinanceStore {
  const business = () => store.rows(SHARED_LEDGER).filter((r) => r.scope === "business");
  const ids = () => new Set(business().map((r) => r.id));
  const refuse = () => {
    throw Object.assign(new Error("Not available to Dot: the gateway reads business finance only."), { code: "READ_ONLY" });
  };
  return {
    ...store,
    rows: () => business(),
    row: (_owner: string, txId: string) => (ids().has(txId) ? store.row(SHARED_LEDGER, txId) : null),
    baseRows: (owner: string) => store.baseRows(owner).filter((r) => ids().has(r.id)),
    count: () => business().length,
    audit: () => [],
    editLog: (owner: string, limit = 50) => store.editLog(owner, 500).filter((e) => e.target === "tx" && ids().has(e.targetId)).slice(0, limit),
    vendorOverrides: () => [],
    setTxOverride: refuse,
    setVendorOverride: refuse,
    importCsv: refuse,
    previewCsv: refuse,
    importLegacyRows: refuse,
    clear: refuse,
  } as ManualFinanceStore;
}

/** The founders' GET /__computers answer, for Dot: the shared bot computers only, and no targets (a target list names devices). */
export function sharedComputers(list: Array<Record<string, unknown>>) {
  return { computers: list.filter((v) => v.kind === "cloud-computer" && v.owner === "shared"), targets: [] };
}
