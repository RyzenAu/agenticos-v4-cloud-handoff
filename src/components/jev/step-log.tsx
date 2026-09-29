/**
 * The Jarvis step log (Wave 2): every run through the Jarvis entry with its full detail, for the
 * os-shell's inspector drawer. Speech stays one short line per step; this is where the rest lives.
 *
 * Data: GET /__operator/screen/runs (summaries, newest first) and /__operator/screen/runs?id=<id>
 * (one run: route, target machine, executor, window, and each step's stage, line, Jev decision
 * (op, confidence, policy, latency, tokens) and check). In memory on the server; clears on restart.
 *
 * Props (all optional):
 *   runId      open this run's detail (e.g. the run the voice panel just started)
 *   limit      how many runs to list (default 12)
 *   pollMs     refresh interval while a run is in progress (default 1200; 6000 when idle)
 *   compact    one line per run, no step table until a run is opened
 *   className  outer container classes (the drawer supplies width/height)
 *
 * The component renders only masked text: the server masks typed text (length + hash), e-mails,
 * long numbers and his dictated payloads before anything reaches this list.
 */
import { useEffect, useMemo, useState } from "react";
import { operatorRequest } from "@/lib/operator";
import { fmtTime } from "@/lib/format";

export type JevRunStep = {
  seq: number;
  at: number;
  stage: string;
  text: string;
  spoken?: boolean;
  jev?: { op: string; confidence: number; policy: string; ms: number; inputTokens: number | null; outputTokens: number | null };
  verified?: boolean;
};
export type JevRunOutcome = { ok: boolean; said: string; outcome?: string; ask?: boolean; stopped?: boolean; confirm?: string; ms: number };
export type JevRunSummary = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  request: string;
  source: string;
  executor: string;
  window: string | null;
  route: { kind: string; intent?: string; confidence?: number; handoff?: string } | null;
  steps: number;
  jevCalls: number;
  outcome: JevRunOutcome | null;
};
export type JevRun = Omit<JevRunSummary, "steps" | "jevCalls"> & {
  target: { deviceId: string; owner: string } | null;
  steps: JevRunStep[];
  jev: { calls: number; ms: number[]; inputTokens: number; outputTokens: number };
};
export type JevStepLogProps = { runId?: string; limit?: number; pollMs?: number; compact?: boolean; className?: string };

/** Poll the step log; returns the summaries and the selected run's detail. */
export function useJevRuns(selected: string | null, pollMs = 1200) {
  const [runs, setRuns] = useState<JevRunSummary[]>([]);
  const [detail, setDetail] = useState<JevRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = runs.some((r) => r.endedAt === null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const list = await operatorRequest<{ runs: JevRunSummary[] }>("/screen/runs");
        if (stopped) return;
        setRuns(list.runs ?? []);
        setError(null);
        if (selected) {
          const one = await operatorRequest<{ run: JevRun }>(`/screen/runs?id=${encodeURIComponent(selected)}`).catch(() => null);
          if (!stopped) setDetail(one?.run ?? null);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(tick, live ? pollMs : Math.max(pollMs, 6000));
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected, pollMs, live]);
  return { runs, detail, error };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const time = (ms: number) => fmtTime(new Date(ms), { seconds: true });
function outcomeLabel(o: JevRunOutcome | null) {
  if (!o) return { text: "running", tone: "text-sky-500" };
  if (o.stopped) return { text: "stopped", tone: "text-muted-foreground" };
  if (o.confirm) return { text: "waiting for your yes", tone: "text-amber-500" };
  if (o.ask) return { text: "asked you", tone: "text-amber-500" };
  if (o.ok) return { text: "done", tone: "text-emerald-500" };
  return { text: o.outcome ? o.outcome.replace("_", " ") : "not done", tone: "text-rose-500" };
}

export function JevStepLog({ runId, limit = 12, pollMs = 1200, compact = false, className = "" }: JevStepLogProps) {
  const [selected, setSelected] = useState<string | null>(runId ?? null);
  useEffect(() => {
    if (runId) setSelected(runId);
  }, [runId]);
  const { runs, detail, error } = useJevRuns(selected, pollMs);
  const shown = useMemo(() => runs.slice(0, limit), [runs, limit]);
  return (
    <div className={`flex flex-col gap-2 text-sm ${className}`} data-testid="jev-step-log">
      {error && <p className="text-xs text-rose-500">Step log unavailable: {error}</p>}
      {!error && !shown.length && <p className="text-xs text-muted-foreground">No Jarvis runs yet. They appear here as they happen (kept in memory until the OS restarts).</p>}
      <ul className="flex flex-col gap-1">
        {shown.map((r) => {
          const o = outcomeLabel(r.outcome);
          const open = selected === r.id;
          return (
            <li key={r.id} className="rounded-md border border-border/60">
              <button type="button" onClick={() => setSelected(open ? null : r.id)} className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-muted/40" aria-expanded={open}>
                <span className="w-16 shrink-0 tabular-nums text-xs text-muted-foreground">{time(r.startedAt)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.request || "(no request)"}</span>
                  {!compact && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {r.route ? `${r.route.kind}${r.route.intent ? ` · ${r.route.intent}` : ""}${r.route.confidence ? ` ${pct(r.route.confidence)}` : ""}` : "routing…"} · {r.executor} · {r.steps} steps · Jev ×{r.jevCalls}
                    </span>
                  )}
                </span>
                <span className={`shrink-0 text-xs ${o.tone}`}>{o.text}</span>
              </button>
              {open && detail?.id === r.id && <RunDetail run={detail} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunDetail({ run }: { run: JevRun }) {
  const p50 = run.jev.ms.length ? [...run.jev.ms].sort((a, b) => a - b)[Math.floor((run.jev.ms.length - 1) / 2)] : null;
  return (
    <div className="border-t border-border/60 px-2 py-2">
      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Machine</dt>
        <dd>{run.target ? `${run.target.deviceId} (${run.target.owner})` : "—"}</dd>
        <dt className="text-muted-foreground">Window</dt>
        <dd className="truncate">{run.window ?? "—"}</dd>
        <dt className="text-muted-foreground">Executor</dt>
        <dd>{run.executor}</dd>
        <dt className="text-muted-foreground">Jev</dt>
        <dd>
          {run.jev.calls} call{run.jev.calls === 1 ? "" : "s"}
          {p50 !== null ? ` · p50 ${p50} ms` : ""} · {run.jev.inputTokens}/{run.jev.outputTokens} tokens
        </dd>
        {run.outcome && (
          <>
            <dt className="text-muted-foreground">Result</dt>
            <dd>{run.outcome.said}</dd>
          </>
        )}
      </dl>
      <ol className="flex flex-col gap-0.5 text-xs">
        {run.steps.map((s) => (
          <li key={s.seq} className="grid grid-cols-[4.5rem_1fr_auto] gap-2">
            <span className="text-muted-foreground">{s.stage}</span>
            <span className={s.spoken ? "font-medium" : ""}>
              {s.text}
              {s.jev && (
                <span className="ml-1 text-muted-foreground">
                  [{s.jev.op} {pct(s.jev.confidence)} → {s.jev.policy}, {s.jev.ms} ms]
                </span>
              )}
            </span>
            <span aria-label={s.verified === undefined ? "" : s.verified ? "verified" : "not verified"}>{s.verified === undefined ? "" : s.verified ? "✓" : "✗"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default JevStepLog;
