// Away mode card for Mission Control: on/off, the kill switch, the queue and what's waiting for his
// code. Approvals themselves happen only on Telegram ("yes CODE" from his own chat), never here.
// Reads GET /__operator/away; changes go through POST /__operator/away (this PC, or Usman over Tailscale).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, Octagon, Plane, Plus } from "lucide-react";
import { Badge, Button, EmptyState, StatusDot, Surface, type Tone } from "@/components/ds";
import { operatorRequest } from "@/lib/operator";
import { fmtTime } from "@/lib/format";

type AwayTask = { id: number; text: string; route: string; from: string; status: string; result?: string; createdAt: string };
type AwayStatus = {
  on: boolean;
  armed: boolean;
  paused: boolean;
  locked: boolean | null;
  watching: boolean;
  running: number | null;
  pending: { taskId: number; action: string; expiresAt: string } | null;
  tasks: AwayTask[];
  config: { approvalTtlMs: number; armIdleMs: number };
};

const STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  running: "accent",
  awaiting_approval: "warn",
  done: "success",
  failed: "danger",
  refused: "danger",
  stopped: "warn",
  not_approved: "neutral",
  interrupted: "warn",
  cancelled: "neutral",
};
const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function AwayModeCard() {
  const qc = useQueryClient();
  const away = useQuery({ queryKey: ["away-mode"], queryFn: () => operatorRequest<AwayStatus>("/away"), refetchInterval: 3000 });
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await operatorRequest<{ said: string; status: AwayStatus }>("/away", body);
      setSaid(r.said);
      qc.setQueryData(["away-mode"], r.status);
      return r;
    } catch (error) {
      setSaid((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = away.data;
  const tasks = (s?.tasks ?? []).slice().reverse().slice(0, 8);
  const tone: Tone = !s?.on ? "neutral" : s.paused ? "warn" : s.armed ? "success" : "info";
  const state = !s ? "…" : !s.on ? "Off" : s.paused ? "On · paused" : s.armed ? "On · working" : `On · waiting for ${Math.round(s.config.armIdleMs / 1000)} s idle`;

  return (
    <section className="mb-12" aria-labelledby="away-card-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="away-card-title" className="text-lg font-semibold leading-snug tracking-[-0.01em]">Away mode</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <StatusDot tone={tone} label={state} />
            {s?.on && s.locked !== null && <StatusDot tone={s.locked ? "warn" : "neutral"} label={s.locked ? "PC locked: screen tasks wait" : "PC unlocked"} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s?.on ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ action: "off" })}>
              <Hand className="size-3.5" /> I'm back
            </Button>
          ) : (
            <Button variant="accent" size="sm" disabled={busy || !s} onClick={() => act({ action: "on" })}>
              <Plane className="size-3.5" /> Away mode on
            </Button>
          )}
          {s?.paused ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ action: "resume" })}>Resume</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy || !s?.on} onClick={() => act({ action: "stop" })} aria-label="Stop now">
              <Octagon className="size-3.5" /> Stop
            </Button>
          )}
        </div>
      </div>
      <Surface padding="none">
        <form
          className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const r = await act({ action: "task", text });
            if (r) setText("");
          }}
        >
          <label htmlFor="away-task" className="sr-only">Queue a task for while you're away</label>
          <input
            id="away-task"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Queue a task, e.g. "tidy Downloads" or "run the lead phone-finder"'
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            maxLength={600}
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy || !text.trim()}>
            <Plus className="size-3.5" /> Queue
          </Button>
        </form>
        {said && <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">{said}</p>}
        {s?.pending && (
          <div className="border-b border-border bg-surface-raised px-4 py-3 text-sm">
            <span className="font-medium">Waiting for your Telegram code: </span>
            {s.pending.action}
            <span className="text-muted-foreground"> · reply "yes CODE" on Telegram before {fmtTime(new Date(s.pending.expiresAt))}</span>
          </div>
        )}
        {away.error ? (
          <p className="p-4 text-sm text-muted-foreground">Couldn't read away mode: {(away.error as Error).message}</p>
        ) : !tasks.length ? (
          <div className="p-4"><EmptyState variant="row" title="Nothing queued. Tasks from Telegram (/task …), voice or here show up in this list." /></div>
        ) : (
          <ol className="divide-y divide-border">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <span className="ds-num w-8 shrink-0 text-xs text-muted-foreground">#{t.id}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{t.text}</span>
                    <Badge tone={STATUS_TONE[t.status] ?? "neutral"}>{label(t.status)}</Badge>
                    <span className="text-xs text-muted-foreground">{t.route === "cli" ? "CLI" : t.route} · from {t.from}</span>
                  </div>
                  {t.result && <p className="mt-0.5 break-words text-xs text-muted-foreground">{t.result}</p>}
                </div>
                {t.status === "queued" && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => act({ action: "cancel", id: t.id })}>Cancel</Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </Surface>
    </section>
  );
}
