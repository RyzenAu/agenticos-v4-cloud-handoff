// Server-only readers for the three-basis economics (usage-economics.ts): the NAB CSV ledger's
// month and the router receipts' month. Both fail to "unknown, with the reason", never to zero, and
// neither creates a store just to say there is nothing in it.
import { existsSync } from "node:fs";
import { SHARED_LEDGER, manualFinanceDbPath, sharedManualStore } from "../finance/manual-store";
import { summary } from "../finance/manual-summary";
import { readAllReceipts } from "../model-router/receipts";
import { ledgerMonthFrom, receiptsForEconomics, sydneyMonthStartIso, type LedgerMonth, type UsageEconomicsInput } from "./usage-economics";

/** This calendar month from the one shared NAB CSV ledger (Finance's store). */
export function readLedgerMonth(root: string): LedgerMonth {
  if (!existsSync(manualFinanceDbPath(root))) return { state: "none-imported" };
  try {
    return ledgerMonthFrom(summary(SHARED_LEDGER, "this-month", { store: sharedManualStore(root) }));
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "the finance store couldn't be opened" };
  }
}

/** Router receipts since the start of this Sydney month. null when they can't be read. */
export function readReceiptsMonth(root: string, now: number): UsageEconomicsInput["receipts"] {
  try {
    const since = sydneyMonthStartIso(now);
    return receiptsForEconomics(readAllReceipts(root, { since: Date.parse(since) }), since, new Date(now).toISOString());
  } catch {
    return null;
  }
}
