/** One CRM runtime per hub root. Both HTTP and Claude's Jarvis/provider adapters import this. */
import { jobsRuntime } from "../jobs/runtime";
import { backgroundJobsDisabled } from "../preview-guard";
import { listDeals } from "../leads/deal-desk-store";
import { draftPackageQuote } from "../leads/deal-desk-quote";
import { CrmAutomations } from "./automation";
import { createCrmOperations, type CrmOperationsOptions } from "./ops";
import { openCrmStore, type CrmChange } from "./store";
import { assertCrmUpgraded } from "./upgrade-guard";

/** Trusted server readers, never request-body claims or memory recall. Claude supplies these
 * from the owning Jobs/provider adapters once their recorded subjects/evidence are available. */
export type CrmIntegrationReaders = Pick<
  CrmOperationsOptions,
  "verifyAgent" | "verifyCommunicationEvidence"
> & {
  /** Claude connects this to the existing event publisher. It carries no business field values. */
  publishChange?: (change: CrmChange) => void;
};
const readers = new Map<string, CrmIntegrationReaders>();
export function configureCrmIntegrations(
  root: string,
  integrations: CrmIntegrationReaders,
): () => void {
  readers.set(root, integrations);
  return () => {
    if (readers.get(root) === integrations) readers.delete(root);
  };
}

function open(root: string) {
  // Integration: never let the first open of a real crm.sqlite run the schema v1 migration (owner-run, with a backup).
  assertCrmUpgraded(root);
  const store = openCrmStore(root);
  let automations: CrmAutomations;
  try {
    automations = new CrmAutomations({
      store,
      jobs: backgroundJobsDisabled() ? undefined : jobsRuntime(root).jobs,
    });
  } catch {
    automations = new CrmAutomations({ store });
  }
  const operations = createCrmOperations({
    store,
    automations,
    // The deal desk's own saved workbooks (read for search by name) and its quote calculator (a draft from an approved package price).
    workbooks: () =>
      listDeals(root).deals.flatMap((row) =>
        row.status === "damaged"
          ? []
          : [{ id: row.id, name: row.name, status: row.status, archived: row.archived, crmDealRef: row.crmDealRef }],
      ),
    deskQuote: (input) => draftPackageQuote(root, input),
    verifyAgent: (by, principal, ref) =>
      readers.get(root)?.verifyAgent?.(by, principal, ref) === true,
    verifyCommunicationEvidence: (evidence, principal, ref) =>
      readers.get(root)?.verifyCommunicationEvidence?.(evidence, principal, ref) === true,
  });
  const unsubscribe = store.subscribe((change) => readers.get(root)?.publishChange?.(change));
  return {
    store,
    automations,
    operations,
    close() {
      unsubscribe();
      store.close();
    },
  };
}
export type CrmRuntime = ReturnType<typeof open>;
const runtimes = new Map<string, CrmRuntime>();
/** Lazy: importing the contract never opens a database, starts a timer or contacts a provider. */
export function crmRuntime(root: string): CrmRuntime {
  let runtime = runtimes.get(root);
  if (!runtime) {
    runtime = open(root);
    runtimes.set(root, runtime);
  }
  return runtime;
}
export function closeCrmRuntime(root: string) {
  const runtime = runtimes.get(root);
  if (runtime) {
    runtimes.delete(root);
    runtime.close();
  }
}
