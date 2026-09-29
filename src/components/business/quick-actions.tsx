// Quick actions: one press runs a real skill or automation that already exists in the OS.
// Read-only actions run straight away; anything that spends (a paid model, search budget, a long
// Claude Code build) asks first with the usual confirmation. Actions that need a lead or a client
// open a small picker. Every run shows who pressed it (Usman or Mehroz), a running state, the
// result inline and a toast, and is written to the quick-actions log in .operator-data.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarCheck2,
  Check,
  ClipboardList,
  FileBarChart2,
  Inbox,
  LayoutTemplate,
  Loader2,
  MoonStar,
  Newspaper,
  PhoneCall,
  PhoneIncoming,
  Pin,
  PinOff,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Sunset,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { operatorRequest } from "@/lib/operator";
import {
  QUICK_ACTIONS,
  actionById,
  durationLabel,
  movePin,
  pinnedActions,
  togglePin,
  callsHeadline,
  inboxAnswer,
  NO_BRIEF,
  type ActionResult,
  type QuickActionDef,
  type QuickActionId,
} from "@/lib/quick-actions";
import "./quick-actions.css";
import { fmtDateTime, fmtDay, fmtTime } from "@/lib/format";

const ICONS: Record<QuickActionId, ReactNode> = {
  "plan-today": <CalendarCheck2 size={16} />,
  "todays-calls": <PhoneCall size={16} />,
  "morning-brief": <Newspaper size={16} />,
  "find-phones": <PhoneIncoming size={16} />,
  "generate-preview": <LayoutTemplate size={16} />,
  "inbox-important": <Inbox size={16} />,
  "seo-audit": <ScanSearch size={16} />,
  "receptionist-report": <FileBarChart2 size={16} />,
  "daily-review": <MoonStar size={16} />,
  "end-day": <Sunset size={16} />,
};

const BY_KEY = "claude-os.leads-by.v1"; // shared with the Leads page's "logging as" picker
type Owner = "usman" | "mehroz";
type State = { pinned: string[]; log: LogEntry[]; viewer: { name: string | null; remote: boolean } };
type LogEntry = { id: string; at: string; action: string; by: string; ok: boolean; summary: string; ms: number };
type Lead = { id: number; name: string; website?: string; phone?: string; status: string; vertical?: string; area?: string; excluded?: boolean };
type Picked = { lead?: Lead; org?: string; fast?: boolean };
type Run = { id: QuickActionId; by: string; startedAt: number; subject?: string };
type Shown = { id: QuickActionId; by: string; at: number; ms: number; subject?: string; result: ActionResult };
type Toast = { id: number; ok: boolean; text: string };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}
async function postSiteDraft(body: unknown) {
  const token = (await (await fetch("/__token")).json()).token;
  const response = await fetch("/__site-draft/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Preview failed (${response.status})`);
  return data as { name: string; previewUrl?: string; ms?: number; qaPass?: boolean };
}
const clip = (s: unknown, n = 140) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** The wiring: each action calls endpoints that already exist. */
async function execute(id: QuickActionId, picked: Picked, owner: Owner): Promise<ActionResult> {
  switch (id) {
    case "plan-today":
    case "end-day": {
      const run = await operatorRequest<{ ok: boolean; said: string; navigate: string | null; steps: { label: string; state: string; detail?: string }[] }>(
        "/jarvis/protocol",
        { name: id === "plan-today" ? "start-day" : "shutdown" },
      );
      window.dispatchEvent(new CustomEvent("jarvis:protocol", { detail: run }));
      return {
        ok: run.ok,
        summary: clip(run.said, 400) || (run.ok ? "Done." : "It stopped part-way."),
        lines: run.steps.map((s) => `${s.state === "done" ? "Done" : s.state === "failed" ? "Failed" : s.state === "skipped" ? "Skipped" : "To do"} · ${s.label}${s.detail ? ` (${clip(s.detail, 80)})` : ""}`),
        link: run.navigate ? { label: run.navigate === "/dashboard" ? "Open Mission Control" : "Open", href: run.navigate } : undefined,
      };
    }
    case "todays-calls": {
      const data = await getJson<{ callWindow: { open: boolean; why: string }; due?: number; leads: Lead[] }>("/__operator/leads/calls?n=8");
      // The headline is the due count: the same number as the Leads call queue, Today's "Calls to
      // make" and Work's call queue (audit F1-01). The list below it is the wider call sheet.
      const due = typeof data.due === "number" ? `${data.due} call${data.due === 1 ? "" : "s"} due (call-backs and follow-ups)` : null;
      const sheet = data.leads.length ? `${data.leads.length} on today's call sheet` : "Nobody on the call sheet";
      return {
        ok: true,
        headline: callsHeadline(data.due, data.leads.length),
        summary: `${due ? `${due} · ${sheet}` : sheet} · calling window ${data.callWindow.open ? "open" : "closed"}, ${data.callWindow.why}.`,
        lines: data.leads.map((l) => [l.name, l.vertical, l.area, l.phone].filter(Boolean).join(" · ")),
        link: { label: "Open Leads", href: "/leads" },
      };
    }
    case "morning-brief": {
      const data = await getJson<{ latest: { date: string; headline: string; summary: string; priorities?: string[] } | null }>("/__operator/business/brief");
      if (!data.latest) return { ok: true, ...NO_BRIEF };
      return {
        ok: true,
        summary: `${data.latest.headline} (${fmtDay(new Date(data.latest.date), { weekday: true })})`,
        lines: data.latest.priorities?.length ? data.latest.priorities : [clip(data.latest.summary, 300)],
      };
    }
    case "find-phones": {
      const list = await getJson<{ leads: Lead[] }>("/__operator/leads/list?status=new");
      const targets = list.leads.filter((l) => !l.phone && !l.excluded).slice(0, 3);
      if (!targets.length) return { ok: true, summary: "Every new lead already has a number. Nothing to look up." };
      const lines: string[] = [];
      let found = 0;
      for (const lead of targets) {
        try {
          const r = await operatorRequest<{ outcome: string; reason: string; lead: Lead }>("/leads/find-phone", { lead: lead.id, by: owner });
          if (r.lead?.phone) found++;
          lines.push(`${lead.name}: ${r.lead?.phone ? `saved ${r.lead.phone}` : r.outcome.replace(/_/g, " ")}${r.reason ? ` · ${clip(r.reason, 90)}` : ""}`);
        } catch (error) {
          lines.push(`${lead.name}: ${clip((error as Error).message, 110)}`);
        }
      }
      return { ok: true, summary: `Looked up ${targets.length} lead${targets.length === 1 ? "" : "s"}; ${found} number${found === 1 ? "" : "s"} saved.`, lines, link: { label: "Open Leads", href: "/leads" } };
    }
    case "generate-preview": {
      const lead = picked.lead!;
      const r = await postSiteDraft({ lead: lead.id, ...(picked.fast ? { fast: true } : {}) });
      return {
        ok: true,
        summary: `Preview ready for ${r.name}${r.qaPass === false ? "; QA flagged issues to fix before showing anyone" : ""}.`,
        link: r.previewUrl ? { label: "Open preview", href: r.previewUrl, external: true } : undefined,
      };
    }
    case "inbox-important": {
      const d = await getJson<{ total: number; urgent: number; today: number; lines: string[] }>("/__operator/inbox/triage/digest");
      return {
        ok: true,
        ...inboxAnswer(d),
        lines: (d.lines ?? []).slice(0, 8).map((l) => clip(l, 220)),
        link: { label: "Open Inbox", href: "/inbox" },
      };
    }
    case "seo-audit": {
      const lead = picked.lead!;
      const r = await operatorRequest<{ audit: { ok: boolean; error: string | null; overall: number | null; grade: string | null; topFindings: unknown[]; domain: string } }>(
        "/leads/seo-audit",
        { lead: lead.id },
      );
      const a = r.audit;
      if (!a.ok) return { ok: false, summary: `The audit of ${a.domain} didn't finish: ${clip(a.error, 160)}` };
      return {
        ok: true,
        summary: `${a.domain} scored ${a.overall ?? "—"}${a.grade ? ` (${a.grade})` : ""}.`,
        lines: (a.topFindings ?? []).slice(0, 5).map((f) => {
          const x = f as Record<string, unknown>;
          return clip(x.title ?? x.message ?? x.finding ?? JSON.stringify(f), 160);
        }),
        link: { label: "Open the lead", href: "/leads" },
      };
    }
    case "receptionist-report": {
      const info = await getJson<{ running: boolean; base: string | null; note?: string }>("/__operator/quick-actions/receptionist");
      if (info.note) return { ok: false, summary: info.note };
      if (!info.running)
        return { ok: false, summary: "The receptionist app isn't running on this PC. Start it in D:\\MU-Receptionist (npm run dev, port 3000), then press again." };
      const week = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const href = `${info.base}/api/qa/${encodeURIComponent(picked.org!)}/weekly-report?week=${week}`;
      window.open(href, "_blank", "noopener,noreferrer");
      return { ok: true, summary: `Opened last week's proof report for ${picked.org}. It's generated on request and never emailed; you send it.`, link: { label: "Open again", href, external: true } };
    }
    case "daily-review": {
      const live = await getJson<{ dream?: { date?: string; healthStatus?: string; report?: { summaryLine?: string; improved?: string[]; broke?: string[]; topActions?: { title: string }[] } } }>("/__live-data");
      const r = live.dream?.report;
      if (!r) return { ok: true, summary: "No review yet. The nightly review writes one around 3 am.", link: { label: "Open Mission Control", href: "/dashboard" } };
      return {
        ok: live.dream?.healthStatus !== "failed",
        summary: `${r.summaryLine ?? "Last night's review"}${live.dream?.date ? ` (${live.dream.date})` : ""}`,
        lines: [
          ...(r.topActions ?? []).slice(0, 3).map((a) => `Do next · ${clip(a.title, 120)}`),
          ...(r.broke ?? []).slice(0, 2).map((b) => `Broke · ${clip(b, 120)}`),
          ...(r.improved ?? []).slice(0, 2).map((b) => `Improved · ${clip(b, 120)}`),
        ],
        link: { label: "Open Mission Control", href: "/dashboard" },
      };
    }
  }
}

function useOwner(): [Owner, (o: Owner) => void] {
  const [owner, setOwner] = useState<Owner>("usman");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BY_KEY);
      if (saved === "usman" || saved === "mehroz") setOwner(saved);
    } catch {
      /* default stands */
    }
  }, []);
  return [
    owner,
    (o) => {
      setOwner(o);
      try {
        localStorage.setItem(BY_KEY, o);
      } catch {
        /* not persisted */
      }
    },
  ];
}

const ownerName = (o: Owner) => (o === "mehroz" ? "Mehroz" : "Usman");
const ago = (at: number, now: number) => {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return fmtTime(new Date(at));
};

export function QuickActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [owner, setOwner] = useOwner();
  const state = useQuery<State>({ queryKey: ["quick-actions"], queryFn: () => getJson("/__operator/quick-actions"), staleTime: 10_000, retry: 1 });
  const viewer = state.data?.viewer;
  const by = viewer?.remote && viewer.name ? viewer.name : ownerName(owner);
  const pinned = useMemo(() => pinnedActions(state.data?.pinned), [state.data?.pinned]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirming, setConfirming] = useState<{ def: QuickActionDef; picked: Picked } | null>(null);
  const [picking, setPicking] = useState<QuickActionDef | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The toast portal needs document.body, which the server render doesn't have. Mount it after
  // hydration so server and client markup match (this was a hydration error on /business).
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    if (!runs.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [runs.length]);

  const toast = (ok: boolean, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, ok, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ok ? 4200 : 7000);
  };

  async function run(def: QuickActionDef, picked: Picked) {
    if (runs.some((r) => r.id === def.id)) return;
    if (viewer?.remote && def.pcOnly) {
      toast(false, `${def.label} runs from the PC only.`);
      return;
    }
    const subject = picked.lead?.name ?? picked.org;
    const started = Date.now();
    setRuns((list) => [...list, { id: def.id, by, startedAt: started, subject }]);
    let result: ActionResult;
    try {
      result = await execute(def.id, picked, owner);
    } catch (error) {
      result = { ok: false, summary: (error as Error).message || "It didn't work." };
    }
    const ms = Date.now() - started;
    setRuns((list) => list.filter((r) => r.id !== def.id));
    setShown({ id: def.id, by, at: Date.now(), ms, subject, result });
    toast(result.ok, result.ok ? `${result.headline ?? def.done}${subject ? ` for ${subject}` : ""}, run by ${by}` : `${def.label.replace("…", "")} didn't finish: ${clip(result.summary, 90)}`);
    // Logged like the rest of the OS: who, what, how it went (no lead data beyond the name).
    void operatorRequest("/quick-actions/log", { action: def.id, ok: result.ok, summary: `${subject ? `${subject}: ` : ""}${result.summary}`, ms, by: owner })
      .then(() => qc.invalidateQueries({ queryKey: ["quick-actions"] }))
      .catch(() => undefined);
  }

  function press(def: QuickActionDef) {
    if (def.needs) return setPicking(def);
    if (def.gate === "spend") return setConfirming({ def, picked: {} });
    void run(def, {});
  }
  function picked(def: QuickActionDef, choice: Picked) {
    setPicking(null);
    if (def.gate === "spend") setConfirming({ def, picked: choice });
    else void run(def, choice);
  }

  async function savePins(next: string[]) {
    qc.setQueryData<State>(["quick-actions"], (old) => (old ? { ...old, pinned: next } : old));
    try {
      await operatorRequest("/quick-actions/pins", { pinned: next });
    } catch (error) {
      toast(false, `Couldn't save the pinned actions: ${(error as Error).message}`);
      void qc.invalidateQueries({ queryKey: ["quick-actions"] });
    }
  }

  const shownDef = shown ? actionById(shown.id) : null;
  const confirmText = confirming?.def.confirm?.(confirming.picked.lead?.name);
  return (
    <section className="qa-rail" aria-labelledby="qa-heading">
      <header className="qa-head">
        <h2 id="qa-heading">Quick actions</h2>
        <div className="qa-head-tools">
          {viewer?.remote ? (
            <span className="qa-who" title="Signed in over Tailscale (people.json)">
              Running as {by}
            </span>
          ) : (
            <label className="qa-who">
              Running as
              <select aria-label="Who is running these actions" value={owner} onChange={(e) => setOwner(e.target.value as Owner)}>
                <option value="usman">Usman</option>
                <option value="mehroz">Mehroz</option>
              </select>
            </label>
          )}
          <ManagePins pinned={state.data?.pinned ?? []} onChange={(next) => void savePins(next)} />
        </div>
      </header>

      {state.isError ? (
        <p className="qa-empty">Quick actions aren't available: {(state.error as Error).message}</p>
      ) : !state.data ? (
        <div className="qa-grid" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="qa-skeleton" />
          ))}
        </div>
      ) : pinned.length === 0 ? (
        <p className="qa-empty">No actions pinned. Use Edit to pin the ones you press every day.</p>
      ) : (
        <div className="qa-grid">
          {pinned.map((def) => {
            const running = runs.find((r) => r.id === def.id);
            const blocked = !!viewer?.remote && def.pcOnly;
            return (
              <button
                key={def.id}
                type="button"
                className="qa-btn"
                data-running={!!running}
                data-gate={def.gate}
                disabled={!!running || blocked}
                aria-busy={!!running}
                title={blocked ? `${def.hint}. Runs from the PC only.` : def.gate === "spend" ? `${def.hint}. Asks before it runs.` : def.hint}
                onClick={() => press(def)}
              >
                <span className="qa-btn-icon">{running ? <Loader2 size={16} className="animate-spin" /> : ICONS[def.id]}</span>
                <span className="qa-btn-label">{def.label}</span>
                {running ? (
                  <span className="qa-btn-meta">
                    {running.by} · {durationLabel(now - running.startedAt)}
                  </span>
                ) : def.gate === "spend" ? (
                  <span className="qa-btn-meta">Asks first</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {shown && shownDef && (
        <article className="qa-result" data-ok={shown.result.ok} aria-live="polite">
          <header>
            <span className="qa-result-icon">{shown.result.ok ? <Check size={14} /> : <TriangleAlert size={14} />}</span>
            <h3>
              {shownDef.label}
              {shown.subject ? ` · ${shown.subject}` : ""}
            </h3>
            <span className="qa-result-meta">
              {shown.by} · {ago(shown.at, now)} · {durationLabel(shown.ms)}
            </span>
            <button type="button" className="qa-icon-btn" aria-label="Dismiss result" onClick={() => setShown(null)}>
              <X size={14} />
            </button>
          </header>
          <p>{shown.result.summary}</p>
          {!!shown.result.lines?.length && (
            <ul>
              {shown.result.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {shown.result.link &&
            (shown.result.link.external ? (
              <a className="qa-result-link" href={shown.result.link.href} target="_blank" rel="noopener noreferrer">
                {shown.result.link.label} <ArrowUpRight size={13} />
              </a>
            ) : (
              <button type="button" className="qa-result-link" onClick={() => void navigate({ to: shown.result.link!.href })}>
                {shown.result.link.label} <ArrowUpRight size={13} />
              </button>
            ))}
        </article>
      )}

      {!!state.data?.log.length && (
        <details className="qa-log">
          <summary>
            <ClipboardList size={13} /> Recent runs
          </summary>
          <ol>
            {state.data.log.slice(0, 8).map((entry) => (
              <li key={entry.id} data-ok={entry.ok}>
                <span>{actionById(entry.action)?.label ?? entry.action}</span>
                <span className="qa-log-summary">{entry.summary}</span>
                <span className="qa-log-meta">
                  {entry.by} · {fmtDateTime(new Date(entry.at), { weekday: true })}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {picking && <Picker def={picking} onCancel={() => setPicking(null)} onPick={(choice) => picked(picking, choice)} />}

      <AlertDialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmText?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="qa-confirm-who">Logged as run by {by}.</p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const c = confirming;
                setConfirming(null);
                if (c) void run(c.def, c.picked);
              }}
            >
              {confirmText?.action ?? "Run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {portalReady &&
        createPortal(
          <div className="qa-toasts" role="status" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className="qa-toast" data-ok={t.ok}>
                {t.ok ? <Check size={14} /> : <TriangleAlert size={14} />}
                <span>{t.text}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
}

function ManagePins({ pinned, onChange }: { pinned: string[]; onChange: (next: string[]) => void }) {
  const ordered = [...pinnedActions(pinned), ...QUICK_ACTIONS.filter((a) => !pinned.includes(a.id))];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="qa-edit">
          <SlidersHorizontal size={14} /> Edit
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="qa-pins">
        <p className="qa-pins-title">Pinned actions</p>
        <p className="qa-pins-note">Pinned actions show on the rail in this order, for everyone.</p>
        <ul>
          {ordered.map((def) => {
            const on = pinned.includes(def.id);
            const i = pinned.indexOf(def.id);
            return (
              <li key={def.id} data-on={on}>
                <button type="button" className="qa-pin-toggle" aria-pressed={on} onClick={() => onChange(togglePin(pinned, def.id))}>
                  {on ? <Pin size={13} /> : <PinOff size={13} />}
                  <span>
                    <strong>{def.label}</strong>
                    <small>
                      {def.hint}
                      {def.gate === "spend" ? " · asks first" : ""}
                    </small>
                  </span>
                </button>
                {on && (
                  <span className="qa-pin-order">
                    <button type="button" className="qa-icon-btn" aria-label={`Move ${def.label} up`} disabled={i === 0} onClick={() => onChange(movePin(pinned, def.id, -1))}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="qa-icon-btn" aria-label={`Move ${def.label} down`} disabled={i === pinned.length - 1} onClick={() => onChange(movePin(pinned, def.id, 1))}>
                      <ArrowDown size={13} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Picker({ def, onPick, onCancel }: { def: QuickActionDef; onPick: (choice: Picked) => void; onCancel: () => void }) {
  const [query, setQuery] = useState("");
  const [fast, setFast] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isOrg = def.needs === "org";
  const leads = useQuery<{ leads: Lead[] }>({
    queryKey: ["qa-leads"],
    queryFn: () => getJson("/__operator/leads/list"),
    enabled: !isOrg,
    staleTime: 30_000,
  });
  const orgs = useQuery<{ running: boolean; orgs: string[]; note?: string }>({
    queryKey: ["qa-receptionist"],
    queryFn: () => getJson("/__operator/quick-actions/receptionist"),
    enabled: isOrg,
    staleTime: 10_000,
  });
  const q = query.trim().toLowerCase();
  const leadRows = (leads.data?.leads ?? [])
    .filter((l) => !l.excluded && l.status !== "do_not_contact" && (def.needs !== "lead-with-site" || !!l.website))
    .filter((l) => !q || `${l.name} ${l.area ?? ""} ${l.vertical ?? ""}`.toLowerCase().includes(q))
    .slice(0, 40);
  const orgRows = (orgs.data?.orgs ?? []).filter((o) => !q || o.includes(q));
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="qa-picker" onOpenAutoFocus={(e) => (e.preventDefault(), input.current?.focus())}>
        <DialogHeader>
          <DialogTitle>{def.label.replace("…", "")}</DialogTitle>
          <DialogDescription>{isOrg ? "Choose the receptionist client." : def.needs === "lead-with-site" ? "Choose a lead. Only leads with a website are listed." : "Choose a lead."}</DialogDescription>
        </DialogHeader>
        <label className="qa-picker-search">
          <Search size={14} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={isOrg ? "Find a client" : "Find a lead by name, area or type"} aria-label="Filter" />
        </label>
        {def.id === "generate-preview" && (
          <label className="qa-picker-fast">
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} />
            Quick template draft instead (instant, no Claude build)
          </label>
        )}
        <div className="qa-picker-list" role="listbox" aria-label={isOrg ? "Clients" : "Leads"}>
          {isOrg ? (
            orgs.isLoading ? (
              <p className="qa-picker-empty">Checking the receptionist app…</p>
            ) : orgs.data?.note ? (
              <p className="qa-picker-empty">{orgs.data.note}</p>
            ) : orgRows.length ? (
              orgRows.map((org) => (
                <button key={org} type="button" role="option" aria-selected={false} onClick={() => onPick({ org })}>
                  <strong>{org}</strong>
                  <small>{orgs.data?.running ? "App running on :3000" : "App not running: start it first"}</small>
                </button>
              ))
            ) : (
              <p className="qa-picker-empty">No receptionist clients found in D:\MU-Receptionist\clients.</p>
            )
          ) : leads.isLoading ? (
            <p className="qa-picker-empty">Loading leads…</p>
          ) : leads.isError ? (
            <p className="qa-picker-empty">Couldn't load leads: {(leads.error as Error).message}</p>
          ) : leadRows.length ? (
            leadRows.map((lead) => (
              <button key={lead.id} type="button" role="option" aria-selected={false} onClick={() => onPick({ lead, fast })}>
                <strong>{lead.name}</strong>
                <small>{[lead.vertical, lead.area, lead.status.replace(/_/g, " "), lead.website?.replace(/^https?:\/\/(www\.)?/, "")].filter(Boolean).join(" · ")}</small>
              </button>
            ))
          ) : (
            <p className="qa-picker-empty">{q ? `No lead matches “${query}”.` : "No leads yet."}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
