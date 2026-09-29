import { useEffect, useRef, useState } from "react";
import { catalogue } from "../../../scripts/model-router/catalogue";
import { fmtDateTime } from "@/lib/format";

type ModelReceipt = {
  id: string;
  recordedAt: number;
  model: string;
  outcome: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};
// Cline bridge names ("deepseek-v4.1-flash") for every Cline model in the router catalogue.
// Excluded ones are kept here on purpose: these are past receipts, and a receipt for a model
// that has since been excluded is still a true record.
const models = new Set(
  catalogue()
    .models.filter((m) => m.provider === "cline")
    .map((m) => m.id.slice("cline/".length)),
);
const outcomes = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "termination_unverified",
]);
const usage = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const tokenCount = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
function projectRows(value: unknown): ModelReceipt[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid model receipts");
  return value.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id) ||
      !models.has(row.model) ||
      !outcomes.has(row.outcome) ||
      row.provider !== "cline" ||
      !Number.isFinite(row.recordedAt) ||
      !Number.isFinite(new Date(row.recordedAt).getTime()) ||
      !tokenCount(row.inputTokens) ||
      !tokenCount(row.outputTokens) ||
      !usage(row.costUsd)
    )
      throw new Error("Invalid model receipts");
    return {
      id: row.id,
      recordedAt: row.recordedAt,
      model: row.model,
      outcome: row.outcome,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
    };
  });
}

export function ModelReceipts() {
  const [rows, setRows] = useState<ModelReceipt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function refreshModels() {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setBusy(true);
    setError("");
    try {
      const tokenResponse = await fetch("/__token", { signal, cache: "no-store" });
      if (!tokenResponse.ok) throw new Error("unavailable");
      const auth = await tokenResponse.json();
      if (typeof auth.token !== "string" || !auth.token) throw new Error("unavailable");
      const response = await fetch("/__operator/model-fleet/receipts?limit=50", {
        headers: { "X-Claude-OS-Token": auth.token },
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (!controller.signal.aborted) setRows(projectRows(data.receipts));
    } catch {
      if (!controller.signal.aborted)
        setError(
          "Model receipts unavailable. Open the local AgenticOS app and refresh. Previous rows may be stale; no model call was started.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="biz-card mu-execution-receipts" aria-labelledby="model-receipts-title">
      <h2 id="model-receipts-title">Cline model usage</h2>
      <p>
        Read bounded-call receipts from the local bridge. These show reported token usage and cost,
        including failed or interrupted runs when available. Remaining provider allowance is not
        known.
      </p>
      <button type="button" disabled={busy} onClick={() => void refreshModels()}>
        {busy ? "Checking models…" : "Refresh model receipts"}
      </button>
      {error && <p role="status">{error}</p>}
      {rows === null && !error && (
        <p>
          Receipts start when the new local recorder is active. Earlier reviews are documented
          separately.
        </p>
      )}
      {rows?.length === 0 && <p>No model calls have been recorded by this recorder yet.</p>}
      {!!rows?.length && (
        <div
          style={{ overflowX: "auto" }}
          tabIndex={0}
          role="region"
          aria-label="Model usage table, scroll horizontally"
        >
          <table>
            <caption>Up to 50 latest local Cline receipts</caption>
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Model</th>
                <th scope="col">Outcome</th>
                <th scope="col">Input / output tokens</th>
                <th scope="col">Reported cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{fmtDateTime(new Date(row.recordedAt), { year: true })}</td>
                  <th scope="row">{row.model}</th>
                  <td>{row.outcome}</td>
                  <td>
                    {row.inputTokens ?? "Unknown"} / {row.outputTokens ?? "Unknown"}
                  </td>
                  <td>{row.costUsd === null ? "Unknown" : `US$${row.costUsd.toFixed(6)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        Unknown cost is not zero. These receipts do not reconcile invoices or authorise paid
        fallback.
      </p>
    </section>
  );
}
