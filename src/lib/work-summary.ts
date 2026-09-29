// Work's five-second answer (W-B, 29 Sep 2026): what waits on you, what to do next, what needs
// attention, from the SAME panel reads the cards below use (no extra requests). Pure and honest: a
// panel that wasn't read says so; it is never shown as zero.
import type { PanelResult } from "@/components/workspace/api";
import type { Approval, CallQueuePanel, PipelinePanel, SitesPanel } from "@/components/workspace/api";
import { aud } from "./leads";

type R<T> = PanelResult<T> | undefined;
type TodayData = { approvals: Approval[]; approvalsErrors: string[] };

export type WorkSummary = {
  tone: "ok" | "warn" | "neutral";
  title: string;
  why: string;
  facts: string[];
  /** The one next step: open approvals when any wait, else the call queue when calls are due. */
  next: "approvals" | "calls" | "pipeline" | null;
  approvals: number | null;
};

const ok = <T,>(r: R<T>): T | null => (r && r.ok ? r.data : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function workSummary(input: { today: R<TodayData>; calls: R<CallQueuePanel>; pipeline: R<PipelinePanel>; sites: R<SitesPanel>; loading: boolean }): WorkSummary {
  const today = ok(input.today);
  const calls = ok(input.calls);
  const pipeline = ok(input.pipeline);
  const sites = ok(input.sites);

  const n = today ? today.approvals.length : null;
  const due = calls ? calls.total : null;
  const down = sites ? sites.sites.filter((s) => s.tone === "bad").length : null;

  const facts = [
    due === null ? "Call queue not read" : due === 0 ? "No calls due" : `${plural(due, "call")} due today or overdue`,
    pipeline?.open === null || pipeline?.open === undefined
      ? "Pipeline not read"
      : `${plural(pipeline.open, "open lead")}${pipeline.proposals.count ? ` · ${plural(pipeline.proposals.count, "proposal")} out${pipeline.proposals.valueCents ? ` (${aud(pipeline.proposals.valueCents)})` : ""}` : ""}`,
    sites === null ? "Sites not checked" : sites.sites.length === 0 ? "No public sites listed" : down ? `${down} of ${sites.sites.length} sites down` : `All ${sites.sites.length} sites answering`,
  ];

  if (n === null) {
    const failed = input.today !== undefined && !input.today.ok;
    return { tone: "neutral", title: failed ? "Couldn't read your approvals" : input.loading ? "Reading what waits on you…" : "Approvals not read", why: failed ? "The approvals list didn't load, so what waits on you is unknown. The cards below each say what they could read." : "Reading approvals, calls, pipeline and sites.", facts, next: due ? "calls" : null, approvals: null };
  }
  if (n > 0) {
    const overdue = pipeline?.followUps.overdue ?? 0;
    const why = `${plural(n, "decision")} only you can make${today!.approvalsErrors.length ? `, and ${plural(today!.approvalsErrors.length, "entry", "entries")} in the approvals file need fixing` : ""}. Nothing here sends, merges or deploys on its own.${overdue ? ` ${plural(overdue, "follow-up")} overdue.` : ""}`;
    return { tone: "warn", title: `${plural(n, "decision")} ${n === 1 ? "waits" : "wait"} on you`, why, facts, next: "approvals", approvals: n };
  }
  if (down) return { tone: "warn", title: `${plural(down, "site")} down`, why: "No decisions wait on you, but a public site isn't answering. Open Websites to see which.", facts, next: due ? "calls" : null, approvals: 0 };
  return { tone: "ok", title: "Nothing waits on you", why: due ? "No decisions pending. The call queue is your next step." : "No decisions pending and no calls due. Work the pipeline when you're ready.", facts, next: due ? "calls" : "pipeline", approvals: 0 };
}
