// What a trigger may DO. An action can only record, classify or draft (effect "none" | "draft"). Anything
// that leaves the machine (sending a message, writing to an outside app) is not an action here: it is
// a `followUp`, an approval request through the existing approval service (message.send, ...), executed by
// nothing in this module. In this build there is no sender wired, so an approved follow-up is recorded as
// approved and honestly marked "nothing sent".
import type { SafeFields, TriggerDef } from "./types";

export type FollowUp = { action: string; summary: string; args: unknown };
export type ActionContext = {
  trigger: TriggerDef;
  safe: SafeFields;
  jobId: string;
  /** A masked step on the job (visible on the Work page). */
  step(intent: string, outcome?: "ok" | "failed" | "skipped" | "note", evidence?: string): void;
  /** Declare something this job created (a draft, a task, a record id). An event about it can never re-trigger. */
  output(ref: string, kind: string): void;
  deps: ActionDeps;
};
export type ActionResult = { ok: boolean; note?: string };
export type ActionDef = {
  id: string;
  effect: "none" | "draft";
  label: string;
  run(ctx: ActionContext): Promise<ActionResult>;
  /** Pure: what to ask the owner to approve once the action succeeded. Recomputed from `safe` when consumed. */
  followUp?(safe: SafeFields): FollowUp;
};

export type ActionDeps = {
  /** Agents workspace: start the task a routine names as the bot it is linked to (null when it isn't linked to one). */
  botTask?: (input: { triggerId: string; goal: string }) => Promise<{ ok: boolean; said: string; jobId: string | null; bot: string } | null>;
  /** The business summary for a routine (counts only). Defaults to the local OS brief context. */
  briefSummary?: () => Promise<{ counts: Record<string, number>; note?: string }>;
};

const s = (v: unknown, max = 80) => String(v ?? "").slice(0, max);

/** A new enquiry: classify it, draft a reply (never sent), ask for approval to send. */
const leadProcess: ActionDef = {
  id: "lead.process",
  effect: "draft",
  label: "Process a new enquiry (draft a reply for approval)",
  async run(ctx) {
    const ref = s(ctx.safe.ref, 40);
    const topic = s(ctx.safe.topic, 80);
    if (!ref) {
      ctx.step("The enquiry has no reference", "failed");
      return { ok: false, note: "The enquiry had no reference." };
    }
    ctx.step(`Read enquiry ${ref}${topic ? ` (topic: ${topic})` : ""}`, "ok");
    const urgent = /urgent|emergency|asap|today|pain|swollen|bleeding/i.test(topic);
    ctx.step(`Classified as ${urgent ? "urgent: call back first" : "standard"}`, "ok");
    const draftRef = `draft:${ref}`;
    ctx.output(draftRef, "draft");
    ctx.step(`Drafted a reply, saved as ${draftRef}. Not sent`, "ok");
    return { ok: true, note: `${urgent ? "Urgent e" : "E"}nquiry ${ref} processed. Reply drafted, waiting for approval to send.` };
  },
  followUp: (safe) => ({
    action: "message.send",
    summary: `Send the reply drafted for enquiry ${s(safe.ref, 40)}`,
    args: { draftRef: `draft:${s(safe.ref, 40)}`, enquiryRef: s(safe.ref, 40) },
  }),
};

/** A receptionist QA flag: record a review task. Read-only toward the receptionist; nothing is sent or written outside. */
const flagReview: ActionDef = {
  id: "flag.review",
  effect: "none",
  label: "Record a review task for a receptionist QA flag",
  async run(ctx) {
    const callId = s(ctx.safe.callId, 80);
    if (!callId) return { ok: false, note: "The flag had no call id." };
    ctx.step(`QA flag on call ${callId.slice(0, 12)}: ${s(ctx.safe.codes, 60) || "no codes"}${ctx.safe.severity ? `, severity ${s(ctx.safe.severity, 20)}` : ""}`, "ok");
    ctx.output(`review:${callId}`, "review-task");
    ctx.step("Review task recorded. Nothing was sent or changed outside this PC", "note");
    return { ok: true, note: "Review task recorded for the owner. No message was sent." };
  },
};

/** A scheduled business summary: counts only, from the existing morning-brief context. */
const briefSummary: ActionDef = {
  id: "brief.summary",
  effect: "none",
  label: "Business summary (morning brief context)",
  async run(ctx) {
    if (!ctx.deps.briefSummary) return { ok: false, note: "No brief source is connected." };
    const out = await ctx.deps.briefSummary();
    const line = Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no sections";
    ctx.step(`Read the brief context: ${line}`, "ok");
    if (ctx.safe.late === true || Number(ctx.safe.missed ?? 0) > 0) ctx.step(`Ran late after the host was offline (${s(ctx.safe.missed ?? 0, 6)} earlier window(s) missed)`, "note");
    ctx.output(`summary:${s(ctx.safe.slot, 40)}`, "summary");
    return { ok: true, note: out.note ?? `Business summary ready (${line}).` };
  },
};

/**
 * A routine that hands a task to a bot (Agents workspace): the routine's `goal` runs as a task of the bot it is linked to, on that bot's own computer,
 * as the bot's own job (it carries the bot and lands in the linking founder's bot conversation). A routine linked to no bot runs nothing.
 */
const botTask: ActionDef = {
  id: "bot.task",
  effect: "draft",
  label: "Run a task as the bot this routine is linked to",
  async run(ctx) {
    const goal = s(ctx.trigger.config.goal, 600).trim();
    if (!goal) return { ok: false, note: "This routine has no goal for a bot to carry out." };
    if (!ctx.deps.botTask) return { ok: false, note: "Bots aren't connected here, so nothing ran." };
    const r = await ctx.deps.botTask({ triggerId: ctx.trigger.id, goal });
    if (!r) {
      ctx.step("This routine isn't linked to a bot (Setup > Routines), so nothing ran", "skipped");
      return { ok: false, note: "This routine isn't linked to a bot, so nothing ran." };
    }
    if (!r.ok || !r.jobId) {
      ctx.step(`${r.bot} couldn't start it: ${s(r.said, 160)}`, "failed");
      return { ok: false, note: `${r.bot} couldn't start the task: ${s(r.said, 140)}` };
    }
    ctx.step(`Started ${r.bot}'s task (job ${r.jobId.slice(0, 8)}) on its own computer`, "ok");
    ctx.output(`botjob:${r.jobId}`, "bot-job");
    return { ok: true, note: `Started ${r.bot}'s task; its progress and result are in the ${r.bot} conversation.` };
  },
};

export const BUILT_IN_ACTIONS: ActionDef[] = [leadProcess, flagReview, briefSummary, botTask];
