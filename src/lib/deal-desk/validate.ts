/**
 * A deal is saveable only if it can be calculated, quoted and rendered. The UI refuses to persist a deal that
 * fails this (review F01: a half-finished edit must never reach storage), and reopening applies it per deal.
 */
import { renderAgreementHtml } from "./agreement";
import type { Deal } from "./deal";
import { buildQuote, renderQuoteHtml } from "./quote";
import { calculateRxDeal } from "./receptionist";
import { calculateWebsite } from "./website";

/** null when the deal is sound; otherwise the reason, in plain words. */
export function validateDeal(deal: Deal): string | null {
  try {
    calculateWebsite(deal.website); calculateRxDeal(deal.rx);
    renderQuoteHtml(buildQuote(deal)); renderAgreementHtml(deal);
    return null;
  } catch (e) { return (e as Error).message || "This deal cannot be calculated."; }
}
