// The optional Command scene (NEXUS-ADDENDUM item 3): a black-and-gold spatial overview of Receptionist,
// Leads, Coding, Memory and Finance. Each object shows its real status (value, honest state, source, last
// update) and opens its existing 2D page; tables, proposals and approvals stay 2D. Plain DOM with CSS 3D
// transforms: no WebGL, no camera, no canvas. Lazy-loaded only when opened; the OS never needs it.
// Keyboard: arrows move between objects, Enter opens, Esc closes. Reduced motion or "still" → no drift.
import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, X } from "lucide-react";
import { useWorkspacePanel } from "@/components/workspace/api";
import { readJobs, startJobEventBridge, subscribeJobs } from "@/lib/job-events";
import { HONEST_LABEL, HONEST_MEANING } from "@/lib/honest-state";
import { Freshness } from "../page-parts";
import { DESTINATIONS } from "../destinations";
import { codingObject, codingPage, financeObject, leadsObject, memoryObject, receptionistObject, type FinanceStatusLike, type MemoryStatusLike, type SceneObject } from "./scene-status";
import "./command-scene.css";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function useCoding() {
  const [state, setState] = useState<{ read: boolean; job: { title: string; state: string; updatedAt: string } | null }>({ read: false, job: null });
  useEffect(() => {
    const stop = startJobEventBridge();
    const pick = (jobs: Parameters<Parameters<typeof subscribeJobs>[0]>[0]) => {
      const j = jobs.find((x) => x.kind === "coding");
      setState({ read: true, job: j ? { title: j.title, state: j.state, updatedAt: j.updatedAt } : null });
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
            {objects.map((o, i) => (
              <button
                key={o.id}
                ref={(el) => void (refs.current[i] = el)}
                type="button"
                className="cs-object"
                data-slot={i}
                data-state={o.state}
                tabIndex={i === focus ? 0 : -1}
                onFocus={() => setFocus(i)}
                onClick={() => openObject(o)}
                aria-label={`${o.label}: ${o.value ?? HONEST_LABEL[o.state]}. ${HONEST_LABEL[o.state]}. Source ${o.source}. Opens the ${o.label} page.`}
              >
                <span className="cs-mark" aria-hidden="true" data-ambient />
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
              </button>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
