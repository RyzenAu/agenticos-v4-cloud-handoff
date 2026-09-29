// The go-live checklist as DATA, mirroring D:/MU-Receptionist-wt-prompt/docs/GO-LIVE-CHECKLIST.md
// (checked 27 Sep 2026). This module never fetches or parses that file at runtime — the doc is the
// source of truth for wording and order; this is a structural mirror the dashboard can render and
// (where the agency feed carries real evidence) mark with a derived status.
//
// Hard rule this file encodes: nothing here is "done" by default. The checklist's own opening line
// is "Nothing here has been done. No agent deployed, migrated, changed Retell/Twilio/Vercel/Neon, or
// sent anything." A step's status is "unknown" unless the feed (clients[]/deployment) gives concrete
// evidence; it is never inferred from silence.

import type { FeedClient, FeedDeployment } from "./types";

export type ChecklistStatus = "not-started" | "in-progress" | "verified" | "unknown";

export type ChecklistStep = {
  id: string;
  step: number; // matches the doc's "Step N" numbering; 0 is pre-flight
  title: string;
  ownerYesNeeded: boolean;
  /** Rollback note, one line, for the "what if this fails" column. */
  rollback: string;
};

export const GO_LIVE_STEPS: readonly ChecklistStep[] = [
  { id: "preflight", step: 0, title: "Pre-flight: full local test suite, tsc, evals, booking-demo generator", ownerYesNeeded: false, rollback: "None — nothing changes." },
  { id: "snapshots", step: 1, title: "Take snapshots: Retell agent/LLM export, Twilio messaging screenshot, Neon branch, Vercel deployment id", ownerYesNeeded: false, rollback: "None — these ARE the rollback points for later steps." },
  { id: "vercel-env", step: 2, title: "Vercel Pro plan + production environment variables (CRON_SECRET, TRUST_PROXY_HEADERS, alert email, AGENCY_FEED_TOKEN, …)", ownerYesNeeded: true, rollback: "Disable the alert email channel; revert values and redeploy." },
  { id: "migrations", step: 3, title: "Run pending Prisma migrations (booking, SMS, retention) against production", ownerYesNeeded: true, rollback: "Restore the Neon branch/point-in-time from step 1." },
  { id: "deploy", step: 4, title: "Deploy the merged branch to production", ownerYesNeeded: true, rollback: "Vercel Instant Rollback to the step-1 deployment id." },
  { id: "retention", step: 5, title: "Retention sweep dry run, owner confirms, then apply; Retell provider-side retention", ownerYesNeeded: true, rollback: "Sweep is irreversible by design (dry run first); Retell PATCH back to snapshot." },
  { id: "seed-demo-org", step: 6, title: "Seed the demo organisation (mu-demo-line) — dry run then --apply --confirm-production", ownerYesNeeded: true, rollback: "Point the Retell agent id back at the previous org; unmap it from mu-demo-line." },
  { id: "retell-config", step: 7, title: "Retell configuration: phone number webhook, booking LLM prompt (no texts yet), publish", ownerYesNeeded: true, rollback: "Re-apply the message-taking v3 prompt and null webhook; republish." },
  { id: "five-test-calls", step: 8, title: "Owner's 5 physical test calls (book; change of mind; full day; urgent then booking; ask for a person)", ownerYesNeeded: true, rollback: "Step 7's rollback, then report the call id." },
  { id: "twilio-console", step: 9, title: "Sending number + Twilio console: regulatory bundle, \"A message comes in\" webhook", ownerYesNeeded: true, rollback: "Remove the webhook URL; Twilio still honours STOP at number level." },
  { id: "sms-env", step: 10, title: "SMS environment, live switch (SMS_PROVIDER, SMS_LIVE_SEND, Twilio credentials); redeploy", ownerYesNeeded: true, rollback: "SMS_LIVE_SEND=false and redeploy — every text becomes DRY_RUN." },
  { id: "sms-on-demo", step: 11, title: "Texts on for the demo line; apply the SMS-wording LLM prompt; publish", ownerYesNeeded: true, rollback: "Re-apply step 7's prompt and republish; disable SMS for mu-demo-line." },
  { id: "five-test-texts", step: 12, title: "Owner's 5 test texts (confirmation, reminder, callback, STOP, START/HELP) to the owner's own mobile", ownerYesNeeded: true, rollback: "Step 11's rollback (and step 10's if a text went where it should not)." },
  { id: "say-it-out-loud", step: 13, title: "Update marketing/call pack to say the line books (after step 8) and texts (after step 12)", ownerYesNeeded: false, rollback: "Revert the wording change." },
] as const;

export type ChecklistStepStatus = ChecklistStep & { status: ChecklistStatus; evidence: string[] };

/**
 * Demo tenant client only — the checklist is entirely about mu-demo-line. Every other client's
 * readiness is a separate, per-client concern shown in the clients table, not this checklist.
 */
function findDemoClient(clients: readonly FeedClient[]): FeedClient | null {
  return clients.find((c) => c.isDemoTenant) ?? clients.find((c) => c.slug === "mu-demo-line") ?? null;
}

/**
 * Best-effort status per step from feed evidence alone. Most steps are owner/console actions this
 * dashboard cannot observe and stay "unknown" — never "not-started" dressed up as a false negative,
 * and never "verified" without a concrete signal.
 */
export function deriveChecklist(
  clients: readonly FeedClient[],
  deployment: FeedDeployment | null,
): ChecklistStepStatus[] {
  const demo = findDemoClient(clients);
  const step = (id: string, status: ChecklistStatus, evidence: string[] = []): ChecklistStepStatus => {
    const base = GO_LIVE_STEPS.find((s) => s.id === id)!;
    return { ...base, status, evidence };
  };
  const rows: ChecklistStepStatus[] = [];
  rows.push(step("preflight", "unknown", ["Runs in D:/MU-Receptionist-wt-prompt; not observable from the agency feed."]));
  rows.push(step("snapshots", "unknown", ["Read-only console/export step; not observable from the agency feed."]));
  rows.push(step("vercel-env", deployment ? (deployment.trustProxyHeaders && deployment.cronSecretValid ? "in-progress" : "not-started") : "unknown", deployment
    ? [
        `TRUST_PROXY_HEADERS: ${deployment.trustProxyHeaders ? "set" : "not set"}`,
        `CRON_SECRET: ${deployment.cronSecretValid ? "valid (32+ chars)" : "missing or too short"}`,
        `Alert email channel live: ${deployment.alertEmailChannelLive ? "yes" : "no"}`,
        "AGENCY_FEED_TOKEN: set (this dashboard read the feed with it)",
      ]
    : ["Feed has no `deployment` block (pre-v1-additions feed, or feed unreadable)."]));
  rows.push(step("migrations", "unknown", ["Not observable from the agency feed; check `prisma migrate status` in the receptionist repo."]));
  rows.push(step("deploy", "unknown", ["Which commit is live is a Vercel console fact, not exposed by the feed."]));
  rows.push(step("retention", "unknown", ["Retention sweep is a one-off script run; not observable from the agency feed."]));
  const seedStatus: ChecklistStatus = !demo ? "not-started"
    : demo.readiness.agentMapped && demo.readiness.inboundNumberSet ? "verified"
    : demo.readiness.agentMapped || demo.readiness.inboundNumberSet ? "in-progress"
    : "not-started";
  rows.push(step("seed-demo-org", seedStatus, demo
    ? [`agentMapped: ${demo.readiness.agentMapped}`, `inboundNumberSet: ${demo.readiness.inboundNumberSet}`]
    : ["No demo-tenant client (isDemoTenant / slug mu-demo-line) in the feed."]));
  rows.push(step("retell-config", demo
    ? demo.readiness.bookingOutcome === "confirmed" ? "verified" : demo.readiness.bookingOutcome === "test_booking_only" ? "in-progress" : "not-started"
    : "not-started", demo ? [`bookingOutcome: ${demo.readiness.bookingOutcome ?? "—"}`] : []));
  rows.push(step("five-test-calls", "unknown", ["Owner's physical phone test; not observable from the agency feed."]));
  rows.push(step("twilio-console", "unknown", ["Twilio console configuration; not observable from the agency feed."]));
  rows.push(step("sms-env", "unknown", ["SMS_LIVE_SEND is not carried by the feed contract; check the Vercel env directly."]));
  rows.push(step("sms-on-demo", demo ? (demo.readiness.smsEnabled ? "verified" : "not-started") : "not-started", demo ? [`smsEnabled: ${demo.readiness.smsEnabled}`] : []));
  rows.push(step("five-test-texts", "unknown", ["Owner's physical phone test; not observable from the agency feed."]));
  const bookingLive = demo?.readiness.bookingOutcome === "confirmed" && demo.readiness.agentMapped && demo.readiness.inboundNumberSet;
  const smsLive = demo?.readiness.smsEnabled === true;
  rows.push(step("say-it-out-loud", bookingLive ? (smsLive ? "verified" : "in-progress") : "not-started", [
    `Booking confirmed on the demo line: ${bookingLive ? "yes" : "no"}`,
    `SMS on for the demo line: ${smsLive ? "yes" : "no"}`,
  ]));
  return rows;
}

/**
 * The one always-visible readiness item the master prompt calls out by name: the live line's
 * capability mismatch stays a visible warning until the demo line is provably taking bookings.
 */
export function liveLineCapabilityMismatch(clients: readonly FeedClient[]): {
  visible: true;
  message: string;
  resolved: boolean;
  reason: string;
} {
  const demo = findDemoClient(clients);
  const resolved = demo?.readiness.bookingOutcome === "confirmed" && demo.readiness.agentMapped && demo.readiness.inboundNumberSet;
  return {
    visible: true,
    message: "The live receptionist line currently takes a message; it does not book appointments.",
    resolved: !!resolved,
    reason: !demo
      ? "No demo-tenant client found in the feed — capability cannot be verified, so the mismatch stays shown."
      : resolved
        ? `Demo line readiness confirms booking (agentMapped, inboundNumberSet, bookingOutcome=confirmed).`
        : `Demo line readiness: bookingOutcome=${demo.readiness.bookingOutcome ?? "—"}, agentMapped=${demo.readiness.agentMapped}, inboundNumberSet=${demo.readiness.inboundNumberSet}.`,
  };
}
