// The conditions "Safe to sell" requires beyond the line answering (UI-truth H5, 28 Sep 2026).
// Pure and unit-tested: every check is ok ONLY on positive evidence. An unread feed, an absent
// field or a sign-off without evidence is never a pass.
import { deriveChecklist, type ChecklistStepStatus } from "./checklist";
import type { EvalFacts } from "./evals";
import { isCriticalBand, isOpenReview } from "./qa-codes";
import type { AgencyFeedState, Blocker, FeedClient, FeedQaFlag, SellCheck, Source } from "./types";

/** The line's own client in the feed: the demo tenant, else the only client. Null when unclear. */
export function lineClient(clients: readonly FeedClient[]): FeedClient | null {
  return clients.find((c) => c.isDemoTenant) ?? clients.find((c) => c.slug === "mu-demo-line") ?? (clients.length === 1 ? clients[0] : null);
}

export type SellGateInput = {
  feed: AgencyFeedState;
  evals: Source<EvalFacts>;
  blockers: readonly Blocker[];
  /** Followed-up flagged calls whose recorded retests haven't passed. */
  awaitingRetest: number;
  /** Checklist statuses; derived from the feed when absent. */
  checklist?: ChecklistStepStatus[];
  /** The Retell calls read: retests can only be counted from calls that were read (audit RX-8). */
  calls?: Source<unknown>;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An open QA flag counts as critical in the top band, or when its severity isn't reported. */
export const isCriticalFlag = (f: Pick<FeedQaFlag, "severity">) => !f.severity || isCriticalBand(f.severity);

function goLiveDetail(feed: AgencyFeedState): string {
  if (!feed.ok) return `Agency feed unavailable (${feed.reason}): verdict unknown`;
  const g = feed.goLive;
  if (!g) return "The feed sent no enforced go-live verdict (goLive): not proven safe";
  const blocked = g.perClient.filter((c) => c.verdict !== "safe");
  const list = blocked
    .slice(0, 3)
    .map((c) => `${c.orgId}: ${c.blockers.length ? c.blockers.join(", ") : c.missing.length ? `missing ${c.missing.join(", ")}` : c.verdict}`)
    .join("; ");
  if (g.verdict === "safe") {
    const newest = g.perClient.map((c) => c.testRecordAt).filter((t): t is string => !!t).sort().at(-1);
    return `Safe: ${g.perClient.length} ${g.perClient.length === 1 ? "client" : "clients"} with current, passing go-live tests${newest ? ` (newest record ${newest.slice(0, 10)})` : ""}`;
  }
  if (g.verdict === "unknown") return `MU-Receptionist couldn't compute every client's verdict${list ? `: ${list}` : ""}`;
  return g.perClient.length ? `Not safe${list ? `: ${list}` : ""}` : "Not safe: no real client has passed its go-live tests";
}

export function sellGateChecks(i: SellGateInput): SellCheck[] {
  const feed = i.feed;
  const checks: SellCheck[] = [];

  // 1. MU-Receptionist's ENFORCED go-live verdict (top-level `goLive`, contract Review R2): the
  //    authoritative record of the per-client go-live tests. Only exactly "safe" passes; absent,
  //    "unknown" or "not-safe" do not. The OS never computes its own.
  checks.push({
    id: "go-live-verdict",
    label: "MU-Receptionist go-live verdict",
    ok: feed.ok && feed.goLive?.verdict === "safe",
    detail: goLiveDetail(feed),
    ...(!feed.ok ? { unknown: true } : {}),
  });

  // 2. No open critical QA flags: the feed's qaFlags list (every organisation) when sent, plus its
  //    counter and call list. With the list present an unreported counter isn't needed.
  const flags = feed.ok ? feed.qaFlags : null;
  const criticalFlags = flags ? flags.filter(isCriticalFlag).length : 0;
  const criticalCalls = feed.ok ? feed.calls.filter((c) => c.qa && isCriticalBand(c.qa.topBand) && isOpenReview(c.qa.reviewStatus)).length : 0;
  const counter = feed.ok ? feed.totals.qaCriticalOpen : null;
  const open = Math.max(counter ?? 0, criticalCalls, criticalFlags);
  const known = feed.ok && (flags !== null || counter !== null);
  checks.push({
    id: "feed-qa",
    label: "No open critical QA flags",
    ok: known && open === 0,
    ...(!known && !open ? { unknown: true } : {}),
    detail: !feed.ok
      ? "Agency feed unavailable: QA flags unknown"
      : !known
        ? "The feed reported neither its QA flags nor the critical counter: unknown"
        : open
          ? `${plural(open, "critical QA flag")} open in production`
          : flags
            ? `None open (${plural(flags.length, "open QA flag")} below critical)`
            : "None open",
  });

  // 3. The owner-console go-live checklist: shown, never blocking. Its per-client steps (test calls,
  //    texts, booking, routing, consent) are what the enforced goLive verdict records; the console
  //    and infrastructure steps (deploy, migrations, snapshots) are informational, and a step the
  //    feed can't see stays "unknown".
  const steps = i.checklist ?? (feed.ok ? deriveChecklist(feed.clients, feed.deployment) : null);
  const verified = steps ? steps.filter((s) => s.status === "verified").length : 0;
  const unknown = steps ? steps.filter((s) => s.status === "unknown").length : 0;
  checks.push({
    id: "checklist",
    label: "Owner console go-live steps (informational)",
    ok: !!steps && steps.length > 0 && verified === steps.length,
    informational: true,
    detail: steps
      ? `${verified} of ${steps.length} verified${unknown ? ` · ${unknown} not visible from the feed (unknown)` : ""} · per-client tests are covered by the go-live verdict`
      : "Agency feed unavailable: checklist unknown",
  });

  // 4. An eval report on file, every scenario check passing.
  const e = i.evals;
  checks.push({
    id: "evals",
    label: "Eval report passing",
    ok: e.ok && e.total > 0 && e.passed === e.total,
    detail: e.ok ? `${e.passed}/${e.total} passed (${e.date})` : e.reason,
  });

  // 5. Every gate passed WITH its evidence present (a sign-off alone is not evidence).
  const passing = i.blockers.filter((b) => b.state === "pass" && b.evidencePresent !== false);
  checks.push({
    id: "gates",
    label: "Go-live gates passed with evidence",
    ok: i.blockers.length === 5 && passing.length === i.blockers.length,
    detail: `${passing.length} of ${i.blockers.length} passed with evidence`,
  });

  // 6. Followed-up calls retested. Retests are counted from the Retell calls: with the calls unread
  //    "none awaiting" can't be known, so it is Unknown, never Met (audit RX-8).
  const callsUnread = i.calls && !i.calls.ok ? i.calls.reason : null;
  checks.push({
    id: "retests",
    label: "Followed-up calls retested",
    ok: i.awaitingRetest === 0 && callsUnread === null,
    detail: i.awaitingRetest
      ? `${plural(i.awaitingRetest, "followed-up call")} awaiting recorded retests${callsUnread !== null ? " · calls couldn't be read, so there may be more" : ""}`
      : callsUnread !== null
        ? `Unknown · couldn't read calls (${callsUnread}), so retests can't be counted`
        : "None awaiting a retest",
    ...(callsUnread !== null && !i.awaitingRetest ? { unknown: true } : {}),
  });
  return checks;
}
