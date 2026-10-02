import type { BusinessWorkspace } from "@/lib/business-workspace";
import { useState } from "react";
import { fmtDay, fmtMoney } from "@/lib/format";

/** The business keeps Sydney time: a UTC instant late on 30 Sep is 1 Oct here, on every machine. */
export const FINANCE_TIME_ZONE = "Australia/Sydney";

/**
 * "Recorded 1 Oct 2026", or "Recorded: not recorded" when the stored value is missing or not a date. Stored
 * timestamps are ISO strings; they are never shown raw, and an unreadable one never prints "Invalid Date".
 */
export function recordedLine(label: string, iso: string | null | undefined): string {
  // JavaScript reads some junk ("0000-00-00") as a day in 1899; no finance record is that old, so it counts as unreadable.
  const readable = !!iso && Date.parse(iso) >= Date.UTC(2000, 0, 1);
  const day = readable ? fmtDay(iso, { timeZone: FINANCE_TIME_ZONE, year: true }) : "—";
  return day === "—" ? `${label}: not recorded` : `${label} ${day}`;
}

const amount = (value: number, currency: string | null) =>
  currency
    ? fmtMoney(value, { currency })
    : value.toLocaleString("en-AU", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/**
 * A fresh workspace never substitutes example balances for missing records.
 * Once live balances exist the fictional walkthrough is not offered here.
 */
export function FinanceSnapshotState({ finances, onExamples }: {
  finances?: BusinessWorkspace["finances"];
  onExamples?: () => Promise<void>;
}) {
  const accounts = finances?.accounts ?? [];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const groups = [...accounts.reduce((map, account) => {
    const key = account.currency || "";
    map.set(key, (map.get(key) || 0) + account.balance);
    return map;
  }, new Map<string, number>())].map(([currency, total]) => ({ currency: currency || null, total }));
  const income = finances?.monthlyIncome;
  async function showExamples() {
    if (!onExamples) return;
    setPending(true);
    setError("");
    try { await onExamples(); }
    catch { setError("The example view could not be opened. Please try again."); }
    finally { setPending(false); }
  }
  return (
    <section className="biz-card" style={{ padding: "28px", marginBottom: "24px" }}>
      <div className="biz-card-heading">
        <h2>{accounts.length ? "Your connected balances" : "Your finances start empty."}</h2>
        <span className="biz-small-tag">{accounts.length ? "Live snapshot" : "Not connected"}</span>
      </div>
      {accounts.length ? (
        <>
          <p>{finances?.sourceLabel} · {recordedLine("Recorded", finances?.recordedAt)}</p>
          <dl className="biz-finance-live-totals">
            {groups.map((group) => (
              <div key={group.currency || "unspecified"}>
                <dt>Cash on hand{groups.length > 1 ? ` · ${group.currency || "no currency"}` : ""}</dt>
                <dd>{amount(group.total, group.currency)}</dd>
              </div>
            ))}
            <div>
              <dt>Income, last 30 days</dt>
              <dd>
                {income ? amount(income.amount, income.currency) : "Not read yet"}
                {income ? <small> · {income.transactions} settled payments · {recordedLine("read", income.recordedAt)}</small> : <small> · refresh from the overview</small>}
              </dd>
            </div>
          </dl>
          <dl style={{ display: "grid", gap: "12px", marginTop: "20px" }}>
            {accounts.map((account, index) => (
              <div key={`${account.sourceId || account.name}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: "24px" }}>
                <dt>{account.name}</dt>
                <dd>{amount(account.balance, account.currency)}{account.currency ? "" : " (currency not supplied)"}</dd>
              </div>
            ))}
          </dl>
          <p style={{ marginTop: "20px" }}>Income is the sum of settled incoming payments, with transfers between your own accounts left out. Expenses and profit need their own records.</p>
        </>
      ) : (
        <p style={{ margin: "16px 0" }}>Connect an account to see your balances, cash flow and runway here.</p>
      )}
      {onExamples && !accounts.length && (
        <button type="button" className="biz-demo-toggle" disabled={pending} onClick={showExamples} style={{ marginTop: "12px" }}>{pending ? "Opening sample data…" : "Explore sample numbers"}</button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
