// Dot's debugging controls on the System page: restart a hub service and open the redacted logs. ONLY in the gateway's own UI
// bundle (isDotGatewayUi); the founders' app never shows it. The server decides everything (ops.restart / ops.logs, 3 restarts an
// hour); this only asks and reports what the hub said.
import { useState } from "react";
import { Button, Notice, Widget } from "@/components/ds";
import { isDotGatewayUi } from "@/lib/dot-gateway";

type Service = "hub" | "hermes" | "searxng";
const SERVICES: { id: Service; label: string; note: string }[] = [
  { id: "hub", label: "Hub", note: "the OS itself; back in about a minute" },
  { id: "hermes", label: "Hermes", note: "the agent gateway" },
  { id: "searxng", label: "Search", note: "SearXNG web search" },
];
const LOGS = ["hub", "supervisor", "gateway", "release", "health"] as const;

async function token(): Promise<string> {
  const t = await fetch("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return typeof t?.token === "string" ? t.token : "";
}

type Run = { service: Service; phase: "asking" | "restarting" | "done" | "failed"; said: string };

export function DotRestartPanel() {
  const [confirm, setConfirm] = useState<Service | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);
  if (!isDotGatewayUi()) return null;
  // Shown in the page itself: Dot's browser blocks links that open new tabs.
  const openLog = async (name: string, query: string) => {
    setLog({ name, text: "Reading…" });
    try {
      const r = await fetch(`/__gateway/diagnostics/logs?${query}`);
      const j = (await r.json().catch(() => null)) as { files?: { name?: string; lines?: string[] }[]; error?: string; note?: string } | null;
      if (!r.ok) return setLog({ name, text: j?.error ?? `The hub refused (${r.status}).` });
      const text = (j?.files ?? []).map((f) => [`== ${f.name ?? "log"} ==`, ...(f.lines ?? [])].join("\n")).join("\n\n") || j?.note || "Empty.";
      setLog({ name, text });
    } catch {
      setLog({ name, text: "The request didn't reach the hub." });
    }
  };
  const busy = run?.phase === "asking" || run?.phase === "restarting";

  const restart = async (service: Service) => {
    setConfirm(null);
    setRun({ service, phase: "asking", said: "Asking the hub…" });
    try {
      const r = await fetch("/__gateway/ops/restart", { method: "POST", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: JSON.stringify({ service }) });
      const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string; note?: string };
      if (r.status !== 202 || !j.id) return setRun({ service, phase: "failed", said: j.error ?? `The hub refused (${r.status}).` });
      setRun({ service, phase: "restarting", said: j.note ?? "Restarting…" });
      // The hub may be down for a minute: keep asking until it reports done or failed, for up to 3 minutes.
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const s = await fetch(`/__gateway/ops/restart/${encodeURIComponent(j.id)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const state = s?.restart?.state as string | undefined;
        if (state === "done") return setRun({ service, phase: "done", said: `${SERVICES.find((x) => x.id === service)!.label} restarted and answering.` });
        if (state === "failed") return setRun({ service, phase: "failed", said: s?.restart?.detail ?? "The restart failed. Check the logs." });
      }
      setRun({ service, phase: "failed", said: "No answer after 3 minutes. Check the supervisor log." });
    } catch {
      setRun({ service, phase: "failed", said: "The request didn't reach the hub. Try again or check the logs." });
    }
  };

  return (
    <Widget title="Restart and logs" className="mb-6" data-dot-restart>
      <p className="mb-3 text-sm text-muted-foreground">Up to 3 restarts an hour. Logs are the hub's own, with secrets removed.</p>
      <div className="flex flex-wrap gap-2">
        {SERVICES.map((s) =>
          confirm === s.id ? (
            <Button key={s.id} variant="accent" size="sm" onClick={() => void restart(s.id)} disabled={busy}>
              Confirm: restart {s.label}
            </Button>
          ) : (
            <Button key={s.id} variant="outline" size="sm" onClick={() => setConfirm(s.id)} disabled={busy} title={s.note}>
              Restart {s.label}
            </Button>
          ),
        )}
        {confirm ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        ) : null}
      </div>
      {run ? (
        <div className="mt-3" role="status" aria-live="polite">
          <Notice tone={run.phase === "failed" ? "danger" : run.phase === "done" ? "success" : "info"} title={run.phase === "done" ? "Done" : run.phase === "failed" ? "Didn't work" : "Working"}>
            {run.said}
          </Notice>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">Show log:</span>
        {LOGS.map((l) => (
          <button key={l} type="button" className="underline underline-offset-4" onClick={() => void openLog(l, `source=${l}&tail=300`)}>
            {l}
          </button>
        ))}
        <button type="button" className="underline underline-offset-4" onClick={() => void openLog("hub (before last restart)", "source=hub&tail=300&previous=1")}>
          hub (before last restart)
        </button>
      </div>
      {log ? (
        <div className="mt-3" data-dot-log>
          <div className="mb-1 flex items-center justify-between text-sm"><span className="font-medium">{log.name}</span><button type="button" className="underline underline-offset-4" onClick={() => setLog(null)}>Close</button></div>
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-inset p-3 text-xs">{log.text}</pre>
        </div>
      ) : null}
    </Widget>
  );
}
