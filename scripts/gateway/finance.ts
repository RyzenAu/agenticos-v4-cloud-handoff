/**
 * BUSINESS finance for the Dot gateway: the manual ledger's business rows, receivables, open-invoice match SUGGESTIONS and
 * the Stripe snapshot the hub already keeps. Read with `finance.read`; categorise a business row with `finance.write`.
 *
 * What "business" means here: a ledger row whose scope is "business" (scripts/finance/manual-store.ts `Scope`). The one
 * ledger also holds the founders' "personal" rows and "unreviewed" ones; neither is ever returned, counted or changed
 * through the gateway, and nothing here can move a row between scopes (that is the founders' call).
 *
 * Never here: moving money, refunds, charges, issuing an invoice, Stripe writes (the hub has none), bank or account
 * connections, CSV statement imports (a bank statement holds personal rows), vendor rules (they apply to personal rows of
 * the same vendor too), clearing or migrating the ledger. No account number, alias, key or token is returned.
 */
import { SHARED_LEDGER, type EffectiveRow, type ManualFinanceStore } from "../finance/manual-store";
import { resolvePeriod, type Period } from "../finance/manual-summary";
import { matchInvoices, type OpenInvoice } from "../finance/invoice-matching";
import { receivablesSummary, LOCAL_RECEIVABLES } from "../finance/receivables";

export type FinanceDeps = {
  store: () => ManualFinanceStore;
  invoices: () => OpenInvoice[];
  stripe: () => { summary(): unknown } | null;
  today: () => string;
};

export class FinanceRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** A business row as Dot sees it: no account alias, no salted keys, no raw NAB text. */
export const rowView = (r: EffectiveRow) => ({
  id: r.id,
  date: r.date,
  processedOn: r.processedOn,
  status: r.status,
  amountCents: r.amountCents,
  kind: r.kind,
  category: r.category,
  vendor: r.vendorLabel,
  knownVendor: r.known,
  foreign: r.foreign,
  refundOf: r.refundOf,
  edited: Object.fromEntries(Object.entries(r.edited).map(([field, p]) => [field, { by: p?.by, at: p?.at }])),
});

const inRange = (date: string, range: { from: string | null; to: string | null }) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

export function createGatewayFinance(deps: FinanceDeps) {
  const business = () => deps.store().rows(SHARED_LEDGER).filter((r) => r.scope === "business");
  const businessRow = (id: unknown) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9:_-]{1,120}$/.test(id)) throw new FinanceRefusal(400, "txId must be a ledger row id.");
    const row = deps.store().row(SHARED_LEDGER, id);
    // A personal or unreviewed row does not exist for the gateway.
    if (!row || row.scope !== "business") throw new FinanceRefusal(404, "No business ledger row with that id.");
    return row;
  };

  return {
    summary(period: Period) {
      const range = resolvePeriod(period, deps.today());
      const rows = business().filter((r) => r.status === "posted" && inRange(r.date, range));
      const byCategory: Record<string, { inCents: number; outCents: number; count: number }> = {};
      let inCents = 0;
      let outCents = 0;
      for (const r of rows) {
        if (r.kind === "transfer") continue; // money between the business's own accounts is not income or spend
        const c = (byCategory[r.category || "uncategorised"] ??= { inCents: 0, outCents: 0, count: 0 });
        c.count++;
        if (r.amountCents >= 0) (c.inCents += r.amountCents), (inCents += r.amountCents);
        else (c.outCents -= r.amountCents), (outCents -= r.amountCents);
      }
      return { scope: "business", period: range, inCents, outCents, netCents: inCents - outCents, rows: rows.length, byCategory, note: "Business rows only; personal and unreviewed rows are not included." };
    },
    transactions(period: Period, limit: number) {
      const range = resolvePeriod(period, deps.today());
      const rows = business().filter((r) => inRange(r.date, range)).sort((a, b) => b.date.localeCompare(a.date));
      return { scope: "business", period: range, total: rows.length, rows: rows.slice(0, limit).map(rowView) };
    },
    receivables() {
      const credits = business()
        .filter((r) => r.amountCents > 0 && r.status === "posted")
        .map((r) => ({ id: r.id, amount: r.amountCents / 100, description: r.vendorLabel, postDate: r.processedOn ?? r.date }));
      const invoices = deps.invoices();
      return {
        receivables: receivablesSummary(LOCAL_RECEIVABLES),
        openInvoices: invoices.map((i) => ({ id: i.id, reference: i.reference, amount: i.amount, currency: i.currency ?? "AUD", issuedAt: i.issuedAt ?? null, dueAt: i.dueAt ?? null })),
        // Suggestions only: recording a match has no store in the hub today (DOT-ACCESS.md, the capability matrix).
        suggestedMatches: matchInvoices(invoices, credits),
      };
    },
    stripe() {
      const s = deps.stripe();
      return s ? { snapshot: s.summary(), note: "The hub's last synced Stripe snapshot (read-only). The gateway never calls Stripe and cannot refund, charge or issue." } : { snapshot: null, note: "Stripe is not set up on this hub." };
    },
    /** Categorise ONE business row (category and kind), or link a refund to the business charge it refunds. Never its scope. */
    categorise(input: { txId: unknown; category?: unknown; kind?: unknown; refundOf?: unknown }) {
      const row = businessRow(input.txId);
      const patch: Partial<Record<"category" | "kind" | "refundOf", string | null>> = {};
      if (input.category !== undefined) {
        if (input.category !== null && (typeof input.category !== "string" || !/^[A-Za-z0-9 &/,()'.-]{1,60}$/.test(input.category))) throw new FinanceRefusal(400, "category must be a short plain label (or null to undo).");
        patch.category = input.category as string | null;
      }
      if (input.kind !== undefined) {
        if (input.kind !== null && typeof input.kind !== "string") throw new FinanceRefusal(400, "kind must be one of the ledger's kinds (or null to undo).");
        patch.kind = input.kind as string | null;
      }
      if (input.refundOf !== undefined) {
        if (input.refundOf !== null) businessRow(input.refundOf); // a refund links to a BUSINESS charge only
        patch.refundOf = input.refundOf as string | null;
      }
      if (!Object.keys(patch).length) throw new FinanceRefusal(400, "Send category, kind or refundOf.");
      try {
        return rowView(deps.store().setTxOverride(SHARED_LEDGER, row.id, patch, "dot"));
      } catch (error) {
        const code = (error as { code?: string })?.code ?? (error as Error).message;
        throw new FinanceRefusal(400, `The ledger refused that change (${String(code).slice(0, 60)}).`);
      }
    },
  };
}

export type GatewayFinance = ReturnType<typeof createGatewayFinance>;
