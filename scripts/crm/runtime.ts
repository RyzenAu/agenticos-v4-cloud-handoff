/** One CRM runtime per hub root. Both HTTP and Claude's Jarvis/provider adapters import this. */
import { activityFor } from "../events/plugin";
import { jobsRuntime } from "../jobs/runtime";
import { backgroundJobsDisabled } from "../preview-guard";
import { CrmAutomations } from "./automation";
import { createCrmOperations, type CrmOperationsOptions } from "./ops";
import { openCrmStore } from "./store";

/** Trusted server readers, never request-body claims or memory recall. Claude supplies these
 * from the owning Jobs/provider adapters once their recorded subjects/evidence are available. */
export type CrmIntegrationReaders = Pick<
  CrmOperationsOptions,
  "verifyAgent" | "verifyCommunicationEvidence"
>;
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
    verifyAgent: (by, principal, ref) =>
      readers.get(root)?.verifyAgent?.(by, principal, ref) === true,
    verifyCommunicationEvidence: (evidence, principal, ref) =>
      readers.get(root)?.verifyCommunicationEvidence?.(evidence, principal, ref) === true,
  });
  const unsubscribe = store.subscribe((change) => activityFor(root)?.crmChanged(change));
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
