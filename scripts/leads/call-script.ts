// A tailored, Hormozi-framework call script for one lead, generated only from the CRM's own
// verified facts (score.ts reasons, buildCard's compliance data) and cached per lead so a founder
// can regenerate on demand without paying for another call every time the drawer opens. The prompt
// hands the model the lead's verified vs score-only reasons separately and tells it never to invent
// a claim — see docs' mu-sales-playbook Australian compliance floor (Spam Act, DNC Register,
// Telemarketing Industry Standard calling hours). Generation runs through the model router
// (routedChat, task "callscript"): Claude on the subscription ("claude -p" under the founder's own
// login), then Cline's free models — never a paid API (the OpenRouter MiMo fallback was removed
// 27 Sep 2026 on the owner's instruction) — with a router receipt per attempt. Nothing here dials,
// sends or emails: it returns text for a founder to read, edit and send himself. A Google-sourced
// lead's live Places details are never put in the prompt (the model sees "[practice name]"), so
// neither the model vendor nor the cached script holds them.
//
// Data class (recorded, not a routing constraint: owner, 28 Sep): the prompt is public business
// facts, plus, when on file, the CRM's own contact history and the founder's contact-preference
// note, which make it business-internal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { claudeBridge } from "../claude-bridge";
import { clineBridge } from "../cline-bridge";
import { clineBridgeName } from "../model-fleet/policy";
import { catalogueModel, catalogueTask } from "../model-router/catalogue";
import { routedChat } from "../model-router/chat";
import type { ChatMessage } from "../model-router/clients";
import { MemoryHealthStore } from "../model-router/health";
import type { ReceiptSink } from "../model-router/receipts";
import { ProviderError, type RouteChoice } from "../model-router/router";
import type { ClaudeComplete } from "../model-router/subscription-clients";
import { buildCard } from "./card";
import { readTrustedIssues } from "./issues";
import { isPlacesLead, type LiveLead } from "./places-live";
import { callWindow, DEFAULT_SENDER, DEMO_CTA } from "./outreach";
import { readSeoAudit, seoVerifiedFacts } from "./seo-audit";
import { dataDirFor } from "../cloud/data-dir";

export type ScriptObjection = "price" | "already_have_website" | "send_email" | "not_now" | "ask_partner";

export type CallScript = {
  leadId: number;
  generatedAt: string;
  model: string;
  pitch: string;
  opener: string;
  discovery: string[];
  valuePitch: string;
  objections: Record<ScriptObjection, string>;
  close: string;
  followupEmail: { subject: string; body: string };
  compliance: {
    callWindow: { open: boolean; why: string };
    dncReminder: string;
    noInventedClaims: string;
  };
};

export const scriptDir = (root: string) => join(dataDirFor(root), "leads", "call-scripts");
export const scriptPath = (root: string, leadId: number) => join(scriptDir(root), `${leadId}.json`);

export function hasScript(root: string, leadId: number): boolean {
  return existsSync(scriptPath(root, leadId));
}

export function readScript(root: string, leadId: number): CallScript | null {
  try {
    return JSON.parse(readFileSync(scriptPath(root, leadId), "utf8")) as CallScript;
  } catch {
    return null;
  }
}

function writeScript(root: string, script: CallScript) {
  mkdirSync(scriptDir(root), { recursive: true });
  writeFileSync(scriptPath(root, script.leadId), JSON.stringify(script, null, 2));
}

/** What the receptionist does, in catalogue-true words (src/lib/receptionist-packages.ts; review T5 R6):
 *  configurable cover, booking only at go-live into a connected calendar, never missed-call cover. */
export const RECEPTIONIST_CAPABILITY = "an AI receptionist that answers calls in the cover they choose (after hours, overflow when the desk is busy, or alongside their team, as their package allows) and, once set up and tested, books into a connected Google Calendar or Cal.com calendar (a booking request otherwise). Never call it missed-call cover, and never say it books today: the demo line takes messages until go-live";

export const PITCH_GUIDANCE: Record<string, string> = {
  receptionist: `Pitch the cover they choose: ${RECEPTIONIST_CAPABILITY}.`,
  redesign: "Pitch a redesign of their current site (faster, mobile-first, online booking) grounded only in the verified faults below.",
  both: `Pitch a faster mobile-first site with online booking, plus ${RECEPTIONIST_CAPABILITY}.`,
  website: "No website was found for them — pitch the free preview site M&U can build from public facts about their business.",
  audit_pending: "The audit isn't finished yet — pitch a quick, honest look at their current site rather than any specific fix.",
  none: "There's no clear pitch on file yet — keep this call to discovery and don't promise a specific fix.",
};

export type LlmComplete = (body: unknown) => Promise<{ choices: Array<{ message: { content: string } }> }>;

/** Thrown when the model's reply can't be trusted as the script (no JSON, bad shape) — the caller
 *  never falls back to inventing a script client-side. */
export class CallScriptError extends Error {}

export const CALLSCRIPT_TASK = "callscript";

/** Cline's free models (bridge names, as served at /__cline), tried in order when Claude fails:
 *  the free Cline candidates of the catalogue's "callscript" task. There is no paid fallback. */
export const FREE_SCRIPT_MODELS: readonly string[] = (catalogueTask(CALLSCRIPT_TASK)?.candidates ?? [])
  .filter((id) => catalogueModel(id).provider === "cline" && catalogueModel(id).route === "free")
  .map(clineBridgeName);

/** What the model is told the business is called when the real name is Google Places content. */
export const PLACES_NAME_PLACEHOLDER = "[practice name]";

export async function generateCallScript(
  db: Database,
  lead: LiveLead,
  opts: { root: string; now?: Date; complete?: LlmComplete; free?: LlmComplete | null; sink?: ReceiptSink } = { root: "." },
): Promise<CallScript> {
  const now = opts.now ?? new Date();
  const card = buildCard(db, lead, DEFAULT_SENDER, now);
  // Raw transports: the router writes the receipts (the bridges' own `complete` writes none).
  const complete = opts.complete ?? (claudeBridge({ timeoutMs: 4 * 60_000 }).complete as LlmComplete);
  // The free fallback defaults on only with the default Claude generator; a caller that injects its
  // own generator (tests, evals) opts in by passing `free` too.
  const free = opts.free !== undefined ? opts.free : opts.complete ? null : (clineBridge({ timeoutMs: 3 * 60_000 }).complete as LlmComplete);
  // A founder-run SEO audit (scripts/leads/seo-audit.ts, jev-seo) measures the lead's own site
  // directly -- same evidentiary standing as the CRM's other [verified] reasons -- so its top
  // findings are added to the verified list the model is told it may cite in the opener.
  const seoAudit = readSeoAudit(opts.root, lead.id);
  const seoFacts = seoAudit?.ok ? seoVerifiedFacts(seoAudit.topFindings) : [];
  // issues.ts: evidenced issues (finding + the page it was seen on) lead the verified list, and
  // the top one is what the opener must open with.
  const issueReport = readTrustedIssues(db, lead);
  const issueFacts = (issueReport?.issues ?? []).filter((i) => i.evidence.source === "site").map((i) => `${i.finding} (seen on ${i.evidence.url.split(" and ")[0]}: ${i.evidence.seen})`);
  const topIssue = issueReport?.issues[0] ?? null;
  const verified = [...issueFacts, ...card.reasons.filter((r) => r.verified && !issueFacts.some((f) => f.startsWith(r.text.split(" — seen on ")[0]))).map((r) => r.text), ...seoFacts];
  const unverified = card.reasons.filter((r) => !r.verified).map((r) => r.text);
  const guidance = PITCH_GUIDANCE[card.pitch] ?? PITCH_GUIDANCE.audit_pending;
  const businessName = isPlacesLead(lead) ? PLACES_NAME_PLACEHOLDER : card.name;

  const system = [
    "You write short, practical Australian-English cold-call scripts for M&U Ventures founders, following the mu-sales-playbook",
    "(Hormozi value-equation framing: dream outcome, perceived likelihood, time delay, effort/sacrifice) and the Australian outbound",
    "compliance floor (Spam Act 2003, Do Not Call Register, Telemarketing Industry Standard calling hours). You must NEVER invent a",
    "fact about the business. Use only the verified observations you're given; if there are none, say so plainly instead of guessing.",
    "Reply with ONLY a JSON object, no markdown fences and no commentary, matching exactly this shape:",
    '{"opener":"...","discovery":["...","...","..."],"valuePitch":"...",' +
      '"objections":{"price":"...","already_have_website":"...","send_email":"...","not_now":"...","ask_partner":"..."},' +
      '"close":"...","followupEmail":{"subject":"...","body":"..."}}',
  ].join(" ");

  // The CRM's own records (contact history, the founder's note) are business-internal.
  const crmLines = [
    ...(card.lastContact ? [`Last contact: ${card.lastContact.kind} on ${card.lastContact.at.slice(0, 10)}, outcome ${card.lastContact.outcome || "logged"}.`] : []),
    ...(card.contactPref ? [`How they like to be contacted (founder's note — respect it, don't quote it): ${card.contactPref}.`] : []),
  ];
  const prompt = [
    `Caller: ${DEFAULT_SENDER.name} from ${DEFAULT_SENDER.business} — use this name in the opener and email sign-off; never invent another.`,
    `Business: ${businessName} (${card.vertical}, ${card.area}). Pitch type: ${card.pitch}. ${guidance}`,
    ...(businessName === PLACES_NAME_PLACEHOLDER ? [`Refer to the business only as ${PLACES_NAME_PLACEHOLDER}, exactly as written; the founder fills it in.`] : []),
    `Verified facts (directly observed on the business's own site — safe to cite): ${verified.length ? verified.join("; ") : "none on file — say so rather than inventing anything"}.`,
    `Directory/score-only signals (never present these as verified facts): ${unverified.length ? unverified.join("; ") : "none"}.`,
    ...(card.lastContact ? [] : ["Last contact: never contacted."]),
    ...crmLines,
    "",
    "Write:",
    topIssue
      ? `(a) opener — ONE line, in Usman's plain voice: say who you are (${DEFAULT_SENDER.name} from ${DEFAULT_SENDER.business}), then lead with this evidenced issue — "${topIssue.finding}"${issueReport?.hook ? ` (suggested wording: "I noticed ${issueReport.hook}")` : ""} — then ask for 30 seconds. No other claim.`
      : seoFacts.length
      ? "(a) opener — ONE line, permission-based, naming the one or two most concrete SEO-audit findings above (e.g. a load-time or a page Google can't read), in plain English a business owner would understand."
      : "(a) opener — ONE line, permission-based, naming exactly one verified observation (or, if there are none, a generic honest opener with no invented claim).",
    "(b) discovery — 2 to 3 open discovery questions.",
    "(c) valuePitch — a value pitch in Hormozi value-equation terms (dream outcome, likelihood, time, effort), matched to the pitch type above.",
    "(d) objections — one short handler each for: price, already having a website, \"send me an email\", \"not now\", \"need to ask my partner\".",
    `(e) close — ask them to "${DEMO_CTA}", in exactly those words (the one call to action)${card.pitch === "receptionist" ? "" : `: the demo ${card.pitch === "both" ? "also " : ""}shows a preview site built from public facts, and offer to generate it on the spot with the drawer's Generate website button`}.`,
    "(f) followupEmail — a Spam Act-compliant follow-up: identify M&U Ventures as the sender and include a working unsubscribe/opt-out line. Subject and body only.",
  ].join("\n");

  // One route (catalogue task "callscript"): Claude on the subscription first (it won the
  // cold-email/coaching comparisons), then Cline's free models in the task's order ($0), with a
  // receipt per attempt. No paid fallback: if all of them fail, Claude's own error is reported. No
  // path invents a script client-side on failure — a failed generation throws and the drawer shows
  // the error instead of guessing.
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  let claudeError: Error | null = null;
  const noJson = (model: string, remember: boolean) => {
    const error = new CallScriptError(`${model} returned no JSON.`);
    if (remember) claudeError ??= error;
    // A reply that isn't the script is a failed attempt (so the next model runs), not a limit.
    return new ProviderError("unknown", "reply had no JSON", { sent: "unknown" });
  };
  const claude: ClaudeComplete = async (body) => {
    let out: Awaited<ReturnType<LlmComplete>>;
    try {
      out = await complete(body);
    } catch (error) {
      claudeError ??= error as Error;
      throw error;
    }
    if (!(out.choices?.[0]?.message?.content ?? "").includes("{")) throw noJson(body.model, true);
    return out;
  };
  const cline = free
    ? async (choice: RouteChoice, messages: ChatMessage[]) => {
        const model = clineBridgeName(choice.model);
        const out = await free({ model, messages });
        const content = out.choices?.[0]?.message?.content ?? "";
        if (!content.includes("{")) throw noJson(model, false);
        return { value: content, providerModel: choice.providerModel };
      }
    : undefined;
  let text = "";
  let modelUsed = "";
  const label = (choice: RouteChoice) =>
    choice.provider === "cline"
      ? `${clineBridgeName(choice.model)} (Cline free${claudeError ? `, fallback after Claude: ${claudeError.message.slice(0, 100)}` : ""})`
      : `${choice.providerModel} (${choice.route === "subscription" ? "Claude subscription" : choice.route})`;
  try {
    const result = await routedChat({
      task: CALLSCRIPT_TASK,
      caller: "scripts/leads/call-script (call script)",
      root: opts.root,
      messages,
      sink: opts.sink,
      // As before E2, every generation tries Claude first: a window another caller saw used up
      // is not assumed still used up (a fresh, per-call health view).
      health: new MemoryHealthStore(),
      deps: { claude, ...(cline ? { cline } : {}) },
    });
    text = result.value;
    modelUsed = label(result.choice);
  } catch (error) {
    throw claudeError ?? error;
  }
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new CallScriptError("The call-script generator returned no JSON.");
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    throw new CallScriptError("The call-script generator returned something that wasn't valid JSON.");
  }

  const script: CallScript = {
    leadId: lead.id,
    generatedAt: now.toISOString(),
    model: modelUsed,
    pitch: card.pitch,
    opener: String(parsed.opener ?? "").slice(0, 500),
    discovery: Array.isArray(parsed.discovery) ? parsed.discovery.slice(0, 3).map((x: unknown) => String(x).slice(0, 300)) : [],
    valuePitch: String(parsed.valuePitch ?? "").slice(0, 1500),
    objections: {
      price: String(parsed.objections?.price ?? "").slice(0, 500),
      already_have_website: String(parsed.objections?.already_have_website ?? "").slice(0, 500),
      send_email: String(parsed.objections?.send_email ?? "").slice(0, 500),
      not_now: String(parsed.objections?.not_now ?? "").slice(0, 500),
      ask_partner: String(parsed.objections?.ask_partner ?? "").slice(0, 500),
    },
    close: String(parsed.close ?? "").slice(0, 700),
    followupEmail: {
      subject: String(parsed.followupEmail?.subject ?? "").slice(0, 200),
      body: String(parsed.followupEmail?.body ?? "").slice(0, 3000),
    },
    compliance: {
      callWindow: callWindow(now),
      dncReminder: "Check this number against the Do Not Call Register before calling.",
      noInventedClaims: verified.length
        ? "Only the verified facts above are safe to state as fact — everything else in this script is framing, not a claim about this business."
        : "No verified facts on file for this business — don't state anything about it as fact on this call.",
    },
  };
  if (!script.opener) throw new CallScriptError("The call-script generator didn't return an opener.");
  writeScript(opts.root, script);
  return script;
}
