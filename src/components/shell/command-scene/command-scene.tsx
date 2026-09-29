// The optional Command scene (NEXUS-ADDENDUM item 3): a black-and-gold spatial overview of Receptionist,
// Leads, Coding, Memory and Finance. Each object shows its real status (value, honest state, source, last
// update) and opens its existing 2D page; tables, proposals and approvals stay 2D. Plain DOM with CSS 3D
// transforms: no WebGL, no camera, no canvas. Lazy-loaded only when opened; the OS never needs it.
// Keyboard: arrows move between objects, Enter opens, Esc closes. Reduced motion or "still" → no drift.
import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, X } from "lucide-react";
import { useWorkspacePanel } from "@/components/workspace/api";
import { readJobs, startJobEventBridge, subscribeJobs } from "@/lib/job-events";
import { HONEST_LABEL, HONEST_MEANING } from "@/lib/honest-state";
import { readMotion, subscribeMotion, type MotionState } from "@/lib/motion";
import { Freshness } from "../page-parts";
import { DESTINATIONS } from "../destinations";
import { HANDOFF_EVENT, HANDOFF_STATE_LABEL, PLACE_LABEL, claimSweep, codingHandoff, handoffMotion, parseHandoff, visibleHandoffs, type Handoff } from "../handoff";
import { LEAD_LINK_GAP, RX_SOURCE_LABEL, receptionistHandoffs, type DashboardHandoffInput } from "../receptionist-handoff";
import { codingObject, codingPage, financeObject, leadsObject, memoryObject, receptionistObject, type FinanceStatusLike, type MemoryStatusLike, type SceneObject } from "./scene-status";
import "./command-scene.css";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// A handoff's sweep plays once per state per browser session, so a refresh, a retry or reopening the scene never replays it.
const SWEEP_KEY = "os:handoff-swept";
const SWEPT = new Set<string>(
  (() => {
    try {
      const v = JSON.parse(window.sessionStorage.getItem(SWEEP_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-200) : [];
    } catch {
      return [];
    }
  })(),
);
const persistSwept = () => {
  try {
    window.sessionStorage.setItem(SWEEP_KEY, JSON.stringify([...SWEPT].slice(-200)));
  } catch {
    /* storage can be blocked; the in-memory set still holds for this page */
  }
};

function useCoding() {
  const [state, setState] = useState<{ read: boolean; job: { title: string; state: string; updatedAt: string } | null; handoff: Handoff | null }>({ read: false, job: null, handoff: null });
  useEffect(() => {
    const stop = startJobEventBridge();
    const pick = (jobs: Parameters<Parameters<typeof subscribeJobs>[0]>[0]) => {
      const j = jobs.find((x) => x.kind === "coding");
      setState({ read: true, job: j ? { title: j.title, state: j.state, updatedAt: j.updatedAt } : null, handoff: codingHandoff(jobs, Date.now()) });
    };
    pick(readJobs());
    const unsub = subscribeJobs(pick);
    // The bridge publishes only when it has something; an empty history is still a read after its first poll.
    const t = window.setTimeout(() => setState((s) => ({ ...s, read: true })), 2500);
    return () => {
      unsub();
      stop();
      window.clearTimeout(t);
    };
  }, []);
  return state;
}

export default function CommandScene({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; returnFocus?: () => HTMLElement | null }) {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const rx = useWorkspacePanel("receptionist");
  const calls = useWorkspacePanel("callQueue");
  const memory = useQuery({ queryKey: ["scene", "memory-status"], queryFn: () => getJson<MemoryStatusLike>("/__memory/status"), staleTime: 30_000, retry: false, enabled: open });
  const finance = useQuery({ queryKey: ["finance-manual-status"], queryFn: () => getJson<FinanceStatusLike>("/__finance_manual/status"), staleTime: 30_000, retry: 1, enabled: open });
  const coding = useCoding();
  // The receptionist's staff handoffs come from the same feed read the Receptionist page uses (counts, with their own read time).
  const rxDash = useQuery({
    queryKey: ["receptionist", "dashboard"],
    queryFn: async () => getJson<DashboardHandoffInput>("/__receptionist/dashboard"),
    staleTime: 60_000,
    retry: false,
    enabled: open,
  });
  // Handoffs: the coding one is derived from the job history above; others arrive as `os:handoff` events
  // from the track that owns them (receptionist calls). Nothing is drawn that no source announced.
  const [announced, setAnnounced] = useState<Handoff[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const h = parseHandoff((e as CustomEvent).detail);
      if (h) setAnnounced((l) => [...l.filter((x) => x.id !== h.id), h]);
    };
    window.addEventListener(HANDOFF_EVENT, on);
    return () => window.removeEventListener(HANDOFF_EVENT, on);
  }, []);
  const [motion, setMotion] = useState<MotionState>(() => readMotion());
  useEffect(() => subscribeMotion(setMotion), []);
  const rxHandoffs = rxDash.data ? receptionistHandoffs(rxDash.data, now) : rxDash.isError ? receptionistHandoffs(null, now) : [];
  const handoffs = visibleHandoffs([...announced, ...rxHandoffs, ...(coding.handoff ? [coding.handoff] : [])], now);
  const sweeps = useRef(new Map<string, "travel" | "still">());
  const [, redraw] = useState(0);
  const travelFor = (h: Handoff): "travel" | "still" => {
    if (handoffMotion(h, motion.holds, motion.reduced) !== "travel") return "still";
    const key = `${h.id}:${h.state}`;
    const known = sweeps.current.get(key);
    if (known) return known;
    const v = claimSweep(key, SWEPT) ? "travel" : "still";
    if (v === "travel") persistSwept();
    sweeps.current.set(key, v);
    return v;
  };
  const objects: SceneObject[] = [
    receptionistObject(rx as never, now),
    leadsObject(calls as never, now),
    codingObject(coding.read, coding.job, now, codingPage(DESTINATIONS.flatMap((d) => [d.to, ...d.drilldowns.map((dd) => dd.to)]))),
    memoryObject(memory, now),
    financeObject(finance),
  ];
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (d: number) => {
    const next = (focus + d + objects.length) % objects.length;
    setFocus(next);
    refs.current[next]?.focus();
  };
  const openObject = (o: SceneObject) => {
    onOpenChange(false);
    void navigate({ to: o.to as never });
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="cs-overlay" />
        <DialogPrimitive.Content
          className="cs-stage"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            refs.current[0]?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // No Radix Trigger here, so without this Escape left focus on <body> (REVIEW-T1 R2).
            const back = returnFocus?.();
            if (back) {
              e.preventDefault();
              back.focus();
            }
          }}
        >
          <div className="cs-head">
            <div>
              <p className="cs-eyebrow">M&amp;U Ventures · Command</p>
              <DialogPrimitive.Title className="cs-title">The business at a glance</DialogPrimitive.Title>
              <DialogPrimitive.Description className="cs-help">
                Each object is a live read with its source. Arrow keys move, Enter opens the page, Esc closes. Work itself stays on the 2D pages.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="cs-close" aria-label="Close the Command scene">
              <X className="h-4 w-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div
            className="cs-world"
            role="group"
            aria-label="Business areas"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              }
            }}
          >
            {objects.map((o, i) => {
              const incoming = handoffs.find((h) => h.to === o.id);
              return (
              <button
                key={o.id}
                ref={(el) => void (refs.current[i] = el)}
                type="button"
                className="cs-object"
                data-slot={i}
                data-state={o.state}
                data-handoff={incoming?.state}
                data-travel={incoming ? travelFor(incoming) : undefined}
                tabIndex={i === focus ? 0 : -1}
                onFocus={() => setFocus(i)}
                onClick={() => openObject(o)}
                aria-label={`${o.label}: ${o.value ?? HONEST_LABEL[o.state]}. ${HONEST_LABEL[o.state]}. Source ${o.source}. Opens the ${o.label} page.`}
              >
                <span className="cs-mark" aria-hidden="true" data-state={o.state} />
                <span className="cs-label">
                  {o.label}
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="cs-value" data-empty={o.value === null || undefined}>
                  {o.value ?? HONEST_LABEL[o.state]}
                </span>
                <span className="cs-detail">{o.detail}</span>
                <span className="cs-foot">
                  <span className="hs-state" data-state={o.state} title={HONEST_MEANING[o.state]}>
                    {HONEST_LABEL[o.state]}
                  </span>
                  <span className="cs-source">{o.source}</span>
                  {o.lastUpdate !== null ? <Freshness at={o.lastUpdate} now={now} staleAfterMs={Infinity} className="cs-when" /> : <span className="cs-when">No successful read yet</span>}
                </span>
                {incoming ? (
                  <span
                    key={`${incoming.id}:${incoming.state}`}
                    className="cs-sweep"
                    aria-hidden="true"
                    onAnimationEnd={() => {
                      // Played once: from here the same state never draws it again, not even when the scene is reopened.
                      sweeps.current.set(`${incoming.id}:${incoming.state}`, "still");
                      redraw((n) => n + 1);
                    }}
                  />
                ) : null}
              </button>
              );
            })}
          </div>
          <section className="cs-handoffs" aria-label="Work in motion" aria-live="polite">
            {handoffs.length === 0 ? (
              <p className="cs-handoff-empty">No handoffs in flight. Coding and call handoffs show here when they are real.</p>
            ) : (
              handoffs.map((h) => (
                <p key={h.id} className="cs-handoff" data-state={h.state}>
                  <span className="cs-handoff-route">
                    {PLACE_LABEL[h.from]} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> {PLACE_LABEL[h.to]}
                  </span>
                  <span className="cs-handoff-what">{h.label}</span>
                  <span className="cs-handoff-state">{HANDOFF_STATE_LABEL[h.state]}</span>
                  <span className="cs-source">{h.source === "job-history" ? "Job history (/__jobs)" : h.source === "receptionist-feed" ? RX_SOURCE_LABEL : "Announced by the owning page"}{h.deviceId ? ` · device ${h.deviceId}` : ""}</span>
                  {h.basis ? <span className="cs-handoff-basis">{h.basis}</span> : null}
                  {h.state === "unknown" ? null : <Freshness at={h.at} now={now} staleAfterMs={Infinity} className="cs-when" />}
                </p>
              ))
            )}
            <p className="cs-handoff-empty" data-gap="lead-link">
              <strong>{LEAD_LINK_GAP.state}.</strong> {LEAD_LINK_GAP.text}
            </p>
          </section>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
