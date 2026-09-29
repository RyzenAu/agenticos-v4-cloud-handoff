import { useEffect, useRef, useState } from "react";
import { fmtTime } from "@/lib/format";

type Receipt = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unverified" | "blocked";
  evidence: string | null;
  usageMicrousd: number | null;
};
const statuses = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unverified",
  "blocked",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validReceipts(value: unknown): Receipt[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid receipt response.");
  return value.map((row) => {
    if (
      !row ||
      !uuid.test(row.id) ||
      !statuses.has(row.status) ||
      !(row.evidence === null || /^[a-f0-9]{64}$/.test(row.evidence)) ||
      !(
        row.usageMicrousd === null ||
        (Number.isSafeInteger(row.usageMicrousd) && row.usageMicrousd >= 0)
      )
    )
      throw new Error("Invalid receipt response.");
    return {
      id: row.id,
      status: row.status,
      evidence: row.evidence,
      usageMicrousd: row.usageMicrousd,
    };
  });
}

/** Explicit metadata-only reads. Refresh never repeats an execution request. */
export function ExecutionReceipts() {
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function refresh(cancelId?: string) {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setBusy(true);
    setMessage("");
    let cancellation = "";
    let cancellationAttempted = false;
    try {
      const tokenResponse = await fetch("/__token", { signal, cache: "no-store" });
      if (!tokenResponse.ok) throw new Error("unavailable");
      const auth = await tokenResponse.json();
      if (typeof auth.token !== "string" || !auth.token) throw new Error("unavailable");
      const headers = { "X-Claude-OS-Token": auth.token, "Content-Type": "application/json" };
      if (cancelId) {
        cancellationAttempted = true;
        const stopped = await fetch(`/__operator/control/jobs/${cancelId}/cancel`, {
          method: "POST",
          headers,
          body: "{}",
          signal,
        });
        if (stopped.status === 202)
          cancellation =
            "Cancellation requested. Refresh to check the settled outcome; partial effects may remain.";
        else if (stopped.status === 409)
          cancellation =
            "This job is no longer cancellable here. No new cancellation was accepted.";
        else throw new Error("unavailable");
        setMessage(cancellation);
      }
      const response = await fetch("/__operator/control/jobs?limit=50", {
        headers,
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (controller.signal.aborted) return;
      setRows(validReceipts(data.receipts));
      setChecked(fmtTime(new Date()));
      setMessage(cancellation);
    } catch {
      if (!controller.signal.aborted)
        setMessage(
          cancellation
            ? `${cancellation} The status refresh failed; previous rows may be stale.`
            : cancellationAttempted
              ? "Cancellation outcome unknown. Refresh status before trying Stop again; previous rows may be stale. No task has been resubmitted."
              : "Receipt service unavailable. Open this view in the local AgenticOS app and retry. Any previous rows below may be stale; no task has been resubmitted.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="biz-card mu-execution-receipts" aria-labelledby="execution-receipts-title">
      <h2 id="execution-receipts-title">Jarvis execution receipts</h2>
      <p>
        Check an existing control job after interruption or reconnect. This view reads job IDs,
        outcomes, evidence fingerprints and recorded usage. It contains no conversation text.
      </p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "Checking…" : "Refresh job receipts"}
      </button>
      {checked && <p>Last checked at {checked}. Refresh reads status only.</p>}
      {message && <p role="status">{message}</p>}
      {rows === null && !message && <p>Load receipts to see locally recorded control jobs.</p>}
      {rows?.length === 0 && <p>No control jobs are recorded in this local journal yet.</p>}
      {!!rows?.length && (
        <div
          style={{ overflowX: "auto" }}
          tabIndex={0}
          role="region"
          aria-label="Execution receipt table, scroll horizontally"
        >
          <table>
            <caption>Up to 50 locally recorded control jobs</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Outcome</th>
                <th scope="col">Evidence</th>
                <th scope="col">Recorded usage</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <code title={row.id}>{row.id.slice(0, 8)}</code>
                  </th>
                  <td>{row.status}</td>
                  <td>
                    {row.evidence ? (
                      <code title={row.evidence}>{row.evidence.slice(0, 12)}</code>
                    ) : (
                      "Not verified"
                    )}
                  </td>
                  <td>
                    {row.usageMicrousd === null
                      ? "Unknown"
                      : `US$${(row.usageMicrousd / 1_000_000).toFixed(6)}`}
                  </td>
                  <td>
                    {row.status === "running" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void refresh(row.id)}
                        aria-label={`Stop job ${row.id.slice(0, 8)}`}
                      >
                        Stop
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        Unverified means the job ended without sufficient evidence. Cancellation can leave partial
        effects. Usage is metadata, not an invoice reconciliation. No job is automatically retried.
      </p>
    </section>
  );
}
