// The desk payment confirm card (P1, 29 Sep 2026). At his desk, when Jarvis has read a payment page and set up ONE exact
// payment, this shows it: who is paid, how much, on which site, what for, and which button will be pressed. Confirm presses
// it once, through Jarvis Chrome, while he watches; Cancel drops it; saying yes does the same as Confirm. It times out in
// two minutes. The card never shows anything unless this is the owner at his desk (the server sends an empty feed
// otherwise), and Confirm is not focused for him: Enter never pays by accident.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ds";
import { operatorRequest } from "@/lib/operator";
import { formatMoney } from "@/lib/desk-money";

type Waiting = { id: string; named: string | null; recurring: string | null; what: string; payee: string; amount: string; currency: string; host: string; button: string; last4: string | null; source: string; expiresAt: number; state: string };
type Finished = { id: string; state: string; said: string; payee: string; amount: string; currency: string; settledAt: number };
type Feed = { desk: boolean; now: number; ttlMs?: number; pending: Waiting[]; recent: Finished[] };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function DeskPaymentCard() {
  const qc = useQueryClient();
  const feed = useQuery({
    queryKey: ["desk-pay"],
    queryFn: () => operatorRequest<Feed>("/desk-pay"),
    // Quiet when nothing waits; quicker while a payment is on the card (and at once after a payment skill call, below).
    refetchInterval: (query) => (query.state.data?.pending?.length ? 1500 : 3000),
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    const now = () => void qc.invalidateQueries({ queryKey: ["desk-pay"] });
    window.addEventListener("jarvis:desk-pay", now);
    return () => window.removeEventListener("jarvis:desk-pay", now);
  }, [qc]);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const data = feed.data;
  const waiting = data?.desk ? data.pending : [];
  useEffect(() => {
    if (!waiting.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting.length]);
  void tick;
  // What his own click just answered ("Paid…", "Stopped: the amount changed…") stays for a few seconds, then goes.
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 9000);
    return () => clearTimeout(t);
  }, [said]);

  const act = async (path: "/desk-pay/confirm" | "/desk-pay/cancel", id: string) => {
    setBusy(id);
    try {
      const r = await operatorRequest<{ ok: boolean; said: string }>(path, { id });
      setSaid({ id, text: r.said, ok: r.ok });
    } catch (error) {
      setSaid({ id, text: (error as Error).message, ok: false });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["desk-pay"] });
    }
  };

  const first = waiting[0];
  const skew = data ? data.now - Date.now() : 0;
  const secondsLeft = first ? Math.max(0, Math.ceil((first.expiresAt - (Date.now() + skew)) / 1000)) : 0;
  const finished = data?.desk && !waiting.length ? data.recent.filter((r) => r.settledAt && data.now - r.settledAt < 45_000).slice(-1)[0] : undefined;
  const result = finished ?? (said && !waiting.length ? { id: said.id, state: said.ok ? "done" : "stopped", said: said.text, payee: "", amount: "", currency: "", settledAt: 0 } : undefined);
  if (!first && !result) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[2147482000] flex justify-center sm:inset-x-auto sm:bottom-6 sm:right-6 sm:justify-end" data-testid="desk-payment-card">
      {first ? (
        <section
          role="alertdialog"
          aria-labelledby="desk-pay-title"
          aria-describedby="desk-pay-detail"
          className="pointer-events-auto w-full max-w-[420px] rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-2xl"
        >
          <p id="desk-pay-title" className="text-sm text-muted-foreground">
            {waiting.length > 1 ? `${waiting.length} payments waiting for your OK` : "Payment waiting for your OK"}
          </p>
          <p className="ds-num mt-1 text-4xl font-semibold leading-tight tracking-[-0.02em]" aria-label={`Amount ${formatMoney(first.amount, first.currency)}`}>
            {formatMoney(first.amount, first.currency)}
          </p>
          <p className="mt-1 text-lg font-medium leading-snug">{first.payee}</p>
          {first.recurring && (
            <p className="mt-1 text-sm font-medium text-warn" data-testid="desk-pay-recurring">
              Then: {first.recurring}
            </p>
          )}
          {first.named && (
            <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" role="note" data-testid="desk-pay-named">
              You named {first.named}; this page is {first.host}.
            </p>
          )}
          <dl id="desk-pay-detail" className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Site</dt>
            <dd className="break-all font-mono text-[13px]">{first.host}</dd>
            <dt className="text-muted-foreground">For</dt>
            <dd>{first.what}</dd>
            <dt className="text-muted-foreground">Button</dt>
            <dd>{first.button}</dd>
            {first.last4 && (
              <>
                <dt className="text-muted-foreground">Card</dt>
                <dd className="ds-num">ending {first.last4}</dd>
              </>
            )}
          </dl>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="accent" size="lg" disabled={busy !== null} onClick={() => void act("/desk-pay/confirm", first.id)}>
              <Check className="size-4" /> {busy === first.id ? "Paying…" : "Confirm"}
            </Button>
            <Button variant="outline" size="lg" disabled={busy !== null} onClick={() => void act("/desk-pay/cancel", first.id)}>
              <X className="size-4" /> Cancel
            </Button>
            <p className="ds-num ml-auto text-sm text-muted-foreground" role="timer" aria-live="off">
              or say yes · {clock(secondsLeft)}
            </p>
          </div>
          {waiting.length > 1 && <p className="mt-3 text-sm text-muted-foreground">Yes only works with one payment waiting: use the buttons.</p>}
          {said && said.id === first.id && !said.ok && (
            <p className="mt-3 text-sm text-warn" role="status">
              {said.text}
            </p>
          )}
        </section>
      ) : result ? (
        <section
          role="status"
          className={`pointer-events-auto w-full max-w-[420px] rounded-2xl border bg-card p-4 text-sm shadow-xl ${result.state === "done" ? "border-success/50" : result.state === "unknown" || result.state === "stopped" || result.state === "failed" ? "border-warn/50" : "border-border"}`}
        >
          {result.said}
        </section>
      ) : null}
    </div>
  );
}
