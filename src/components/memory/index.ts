// Memory destination. os-shell mounts <MemoryVault /> at the Memory destination;
// any Jarvis answer can render <FactsUsedPanel refs={reply.facts_used} />.
export { MemoryVault } from "./memory-vault";
export { FactsUsedPanel, useFactsUsed } from "./facts-used";
export { createHttpMemoryClient, BUCKET_LABEL, DESTINATION_LABEL, INDEX_LABEL, HINDSIGHT_LABEL, type MemoryClient, type FactsUsed, type StatusView } from "./client";
export { createSyntheticMemoryClient, syntheticRows } from "./synthetic-client";
