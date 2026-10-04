// The calm "Waiting for approval" card for an outward action the hub put behind a B2 approval (see src/lib/publish-flow.ts).
// It says what will be published and where, in the hub's own words, lets the founder confirm on the card (the hub checks his
// signed-in session), and then shows what actually happened, exactly as the server answered.
import { fmtTime } from "@/lib/format";
import { useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button, Notice } from "@/components/ds";
import { cn } from "@/lib/utils";
import { decideOnCard, type FlowState, type PublishFlow } from "@/lib/publish-flow";


function Btn({ studio, children, onClick, disabled, primary }: { studio: boolean; children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return studio ? (
    <button onClick={onClick} disabled={disabled} className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40", primary ? "bg-white text-black" : "border border-white/20 text-white/80")}>
      {children}
    </button>
  ) : (
    <Button size="sm" variant={primary ? "accent" : "outline"} disabled={disabled} onClick={onClick}>{children}</Button>
  );
}

export function PublishApprovalCard({
  state,
  flow,
  what,
  where,
  doneText,
  askAgain,
  verb = "Will publish",
  approveLabel = "Approve and publish",
  studio = false,
}: {
  state: FlowState;
  flow: PublishFlow;
  /** "Harbour Realty's preview" */
  what: string;
  /** "https://harbour-realty.muventures.com.au" */
  where: string;
  /** The line when it finished (the caller knows what the result means). */
  doneText?: (result: unknown) => string;
  askAgain?: () => void;
  /** "Will publish" / "Will remove" */
  verb?: string;
  approveLabel?: string;
  /** The Design studio's dark panel: same words and behaviour, its own look. */
  studio?: boolean;
}) {
  const [busy, setBusy] = useState<"" | "approve" | "reject">("");
  const [problem, setProblem] = useState("");
  if (state.kind === "idle") return null;
  const box = studio ? "mt-3 rounded-lg border border-sky-300/20 bg-sky-400/[0.06] px-3 py-3 text-xs text-white/85" : "mt-3 rounded-2xl bg-info-soft px-5 py-4 text-sm text-foreground";
  const muted = studio ? "text-white/50" : "text-muted-foreground";
  if (state.kind === "asking")
    return (
      <div className={box} role="status" data-testid="publish-approval-card" data-state="asking">
        <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Asking for approval. Nothing is published yet.</span>
      </div>
    );

  if (state.kind === "waiting" || state.kind === "approved" || state.kind === "running") {
    const a = state.approval;
    const decide = async (decision: "approve" | "reject") => {
      setBusy(decision);
      setProblem("");
      const r = await decideOnCard(a.id, decision).catch((e: Error) => ({ ok: false as const, message: e.message }));
      if (!r.ok) setProblem(r.message);
      setBusy("");
      await flow.refresh();
    };
    const working = state.kind !== "waiting";
    return (
      <section aria-label="Waiting for approval" data-testid="publish-approval-card" data-state={state.kind} className={box}>
        <div className="flex items-center gap-2 font-medium">
          {working ? <Loader2 className="size-4 animate-spin text-info" /> : <ShieldCheck className="size-4 text-info" />}
          {state.kind === "waiting" ? "Waiting for approval" : state.kind === "approved" ? "Approved. Starting now" : "Working on it now"}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className={muted}>{verb}</dt>
          <dd className="min-w-0 break-words">{what}</dd>
          <dt className={muted}>Where</dt>
          <dd className={cn("min-w-0", /^https?:/.test(where) ? "break-all font-mono text-xs leading-5" : "break-words")}>{where}</dd>
        </dl>
        <p className={cn("mt-2", studio ? "text-white/70" : "text-foreground/85")}>{a.summary}</p>
        {state.kind === "waiting" && (
          <>
            <p className={cn("mt-2 text-xs", muted)}>
              Nothing happens until you approve. It runs once, as exactly what you see here
              {a.expiresAt ? `; this approval lapses at ${fmtTime(a.expiresAt)}` : ""}.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn studio={studio} primary disabled={!!busy} onClick={() => void decide("approve")}>
                {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} {approveLabel}
              </Btn>
              <Btn studio={studio} disabled={!!busy} onClick={() => void decide("reject")}>Decline</Btn>
            </div>
            {problem && <p className={cn("mt-2 text-xs", studio ? "text-white/70" : "text-foreground/85")} role="alert">{problem}</p>}
          </>
        )}
      </section>
    );
  }

  if (state.kind === "done") {
    const text = doneText ? doneText(state.result) : "Done.";
    return studio ? (
      <div className={cn(box, "flex items-start justify-between gap-3")} role="status" data-testid="publish-approval-card" data-state="done">
        <span>{text}</span>
        <button onClick={() => flow.dismiss()} className="shrink-0 text-white/50 underline">Close</button>
      </div>
    ) : (
      <Notice tone="success" className="mt-3" action={<Button size="sm" variant="outline" onClick={() => flow.dismiss()}>Close</Button>}>
        <span data-testid="publish-approval-card" data-state="done">{text}</span>
      </Notice>
    );
  }

  if (state.kind !== "ended") return null;
  const title = state.why === "voided" ? "Approval voided" : state.why === "already-used" ? "Already used" : state.why === "expired" ? "Approval expired" : state.why === "rejected" ? "Declined" : state.why === "cancelled" ? "Withdrawn" : "Not published";
  const actions = (
    <div className="flex gap-2">
      {askAgain && state.why !== "already-used" && <Btn studio={studio} onClick={() => { flow.dismiss(); askAgain(); }}>Ask again</Btn>}
      <Btn studio={studio} onClick={() => flow.dismiss()}>Close</Btn>
    </div>
  );
  return studio ? (
    <div className={box} role="alert" data-testid="publish-approval-card" data-state={`ended-${state.why}`}>
      <div className="font-medium">{title}</div>
      <p className="mt-1 text-white/70">{state.message}</p>
      <div className="mt-2">{actions}</div>
    </div>
  ) : (
    <Notice tone={state.why === "error" ? "danger" : "warn"} className="mt-3" title={title} action={actions}>
      <span data-testid="publish-approval-card" data-state={`ended-${state.why}`}>{state.message}</span>
    </Notice>
  );
}
