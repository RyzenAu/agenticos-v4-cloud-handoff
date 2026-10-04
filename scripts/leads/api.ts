// The /__operator/leads/* handlers. Thin wrapper around crm.ts/engine.ts/outreach.ts/places.ts:
// this file only validates input, shapes responses and enforces the local-PC-only rule for
// `find` (it spends paid Google lookups). It never sends an email, dials a number or messages
// anyone — `draft` returns text only.
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";
import type { Database } from "bun:sqlite";
import { buildCard } from "./card";
import { generateCallScript, readScript } from "./call-script";
import {
  activities,
  callList,
  coachingSummary,
  crmPath,
  dayReport,
  eventLogged,
  findLead,
  getKickoff,
  goal,
  listLeads,
  logActivity,
  openCrm,
  pipeline,
  recordCoaching,
  recordWin,
  setGoal,
  STATUSES,
  usage,
  type Lead,
  type Status,
} from "./crm";
import { findLeads, MONTHLY_DETAILS_BUDGET, type Source } from "./engine";
import { normaliseFindArea, normaliseWebsitePresence, type WebsitePresence } from "./find-input";
import { followUpQueue } from "./followups";
import { readHunt, type HuntReport } from "./hunt";
import { callOpener, callWindow, DEFAULT_SENDER, emailDraft, emailPitch } from "./outreach";
import { defaultFinderDeps, describeSources, findAndApply, readFinding, type FinderDeps } from "./phone-finder";
import { issueHook, readTrustedIssues, topIssues } from "./issues";
import { isVertical, VERTICALS } from "./places";
import { defaultPlacesLookup, hydrateLead, hydrateLeads, placesSession, type PlacesLookup, type PlacesSession } from "./places-live";
import { isVerifiedFact } from "./score";
import { readSeoAudit, runSeoAudit, SeoAuditBusyError, SeoAuditConfigError, type SeoAuditRecord } from "./seo-audit";
import { readWatchSummary, type WatchSummary } from "./watch";
import { draftFiles, draftInvoice, draftProposal, readDraft } from "./sales-backoffice";
import { leadPipeline, pipelineSummary } from "./lead-pipeline";
import { crmOverview, dealRows, assertDraftable, draftTarget, isCalendarDate, leadDeal, moveStage, OFFERS, readDeal, readRules, saveDeal, saveRules, type DealPatch } from "./deals";
import { isCallDue } from "../../src/lib/call-queue";
import { searchCrm } from "./crm-search";
import { archiveDeal, attachDeal, DealDeskError, getDeal, linkDeal, listDeals, saveDeal as saveDeskDeal } from "./deal-desk-store";
import { editLead, leadArtifactCurrent, leadEditVersion } from "./edit";

export const OWNERS = ["usman", "mehroz"] as const;
export type Owner = (typeof OWNERS)[number];
export function isOwner(value: unknown): value is Owner {
  return typeof value === "string" && (OWNERS as readonly string[]).includes(value.toLowerCase());
}

/** Thrown for actions that are only allowed at this PC (never over a remote/Tailscale session). */
export class LocalOnly extends Error {}

export type LogBody = {
  lead: string | number;
  outcome: Status | "";
  kind: "call" | "email" | "note" | "meeting";
  note: string;
  next: string | null;
  by: string;
  eventId?: string;
};

/** A value that starts with a calendar date ("2026-02-30…") must name a real day: Date.parse rolls
 *  30 February over to 2 March instead of refusing it (audit F1-15). */
function calendarDateRoundTrips(value: string): boolean {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return !day || isCalendarDate(day[1]);
}

export function validateLogBody(body: any, now: Date = new Date()): LogBody {
  const lead = body?.lead;
  if (lead === undefined || lead === null || String(lead).trim() === "") throw new Error("Choose a lead.");
  const outcome = String(body?.outcome ?? "").trim();
  if (outcome && !STATUSES.includes(outcome as Status)) throw new Error(`Unknown outcome "${outcome}".`);
  const kind = String(body?.kind ?? "call").trim();
  if (!["call", "email", "note", "meeting"].includes(kind)) throw new Error("Unknown activity kind.");
  const by = String(body?.by ?? "").trim();
  if (by && !isOwner(by)) throw new Error("by must be usman or mehroz.");
  const note = String(body?.note ?? "").slice(0, 2000);
  let next: string | null = null;
  if (body?.next) {
    const date = new Date(body.next);
    if (Number.isNaN(date.getTime()) || !calendarDateRoundTrips(String(body.next))) throw new Error("That follow-up date isn't valid.");
    next = date.toISOString();
    // Review T5 (F1-15/16): the drawer's min=today is also the server's rule. A follow-up dated
    // before today (Sydney) is refused; earlier today is fine (it's simply due now).
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(d);
    if (day(date) < day(now)) throw new Error("That follow-up date is in the past. Pick today or later.");
  }
  // The drawer won't log a call back without a date; the server holds the same rule (audit F1-16).
  if (outcome === "call_back" && !next) throw new Error("A call back needs a date.");
  const eventId = body?.event !== undefined && body?.event !== null ? String(body.event).trim() || undefined : undefined;
  return { lead, outcome: outcome as Status | "", kind: kind as LogBody["kind"], note, next, by, eventId };
}

export function validateGoalBody(body: any): { by: Owner; calls: number } {
  const by = String(body?.by ?? "").trim().toLowerCase();
  if (!isOwner(by)) throw new Error("by must be usman or mehroz.");
  const calls = Number(body?.calls);
  if (!Number.isFinite(calls) || calls < 0 || calls > 200) throw new Error("calls must be a number between 0 and 200.");
  return { by, calls: Math.round(calls) };
}

export function validateFindBody(body: any): { vertical: keyof typeof VERTICALS; area: string; max: number; source: Source; websitePresence: WebsitePresence } {
  const vertical = body?.vertical;
  if (!isVertical(vertical)) throw new Error(`vertical must be one of ${Object.keys(VERTICALS).join(", ")}.`);
  const area = normaliseFindArea(body?.area);
  const maxRaw = body?.max;
  const max = Math.min(Math.max(Number.isFinite(Number(maxRaw)) ? Math.round(Number(maxRaw)) : 20, 1), 30);
  const sourceRaw = body?.source;
  if (sourceRaw !== undefined && sourceRaw !== "osm" && sourceRaw !== "google") throw new Error('source must be "osm" or "google".');
  const source: Source = sourceRaw === "google" ? "google" : "osm"; // osm (free, no key) is the default
  const websitePresence = normaliseWebsitePresence(body?.websitePresence);
  if (source === "google" && websitePresence === "missing") throw new Error("The no-website-listed filter is available for OpenStreetMap only.");
  return { vertical, area, max, source, websitePresence };
}

export function friendlyFindError(error: unknown, source: Source): Error {
  const message = (error as Error)?.message || "The search failed.";
  if (source === "google" && /403|PERMISSION_DENIED/i.test(message))
    return new Error("Google isn't allowing this yet: enable Places API (New) in Google Cloud Console for this key, then try again.");
  return new Error(message);
}

/** Tags each reason as directly observed on the business's own site ([verified]) or a
 *  directory/score-only signal, so the UI can show the difference without re-deriving it. */
export function withVerified(lead: Lead): Lead & { verified: boolean[] } {
  return { ...lead, verified: lead.reasons.map((r) => isVerifiedFact(r)) };
}

export function createLeadsApi(
  root: string,
  deps: { db?: Database; hunt?: () => HuntReport; phoneFinder?: FinderDeps; placesLookup?: PlacesLookup | null } = {},
) {
  const db = deps.db ?? openCrm(crmPath(root));
  // Google-sourced leads store only their place ID: their details are fetched live per request
  // (places-live.ts), cached in memory for that request only, and returned with attribution.
  const lookup = (): PlacesLookup | null => (deps.placesLookup !== undefined ? deps.placesLookup : defaultPlacesLookup(db));
  const session = (): PlacesSession => placesSession(lookup());

  function requireLead(ref: string | number): Lead {
    const lead = findLead(db, ref);
    if (!lead) throw new Error("Lead not found.");
    return lead;
  }

  function summary() {
    const window = callWindow();
    const used = usage(db).details_enterprise ?? 0;
    return {
      pipeline: pipeline(db),
      placesUsage: { used, budget: MONTHLY_DETAILS_BUDGET },
      // Last night's Hermes lead hunt: a failed run shows as failed, with the owner's fix.
      hunt: (deps.hunt ?? (() => readHunt()))(),
      callWindow: window,
      today: {
        usman: dayReport(db, "usman"),
        mehroz: dayReport(db, "mehroz"),
      },
    };
  }

  function list(params: URLSearchParams) {
    const status = params.get("status") || undefined;
    const vertical = params.get("vertical") || undefined;
    const minScoreRaw = params.get("minScore");
    if (status && !STATUSES.includes(status as Status)) throw new Error(`Unknown status "${status}".`);
    if (vertical && !isVertical(vertical)) throw new Error(`Unknown vertical "${vertical}".`);
    let minScore: number | undefined;
    if (minScoreRaw) {
      minScore = Number(minScoreRaw);
      if (!Number.isFinite(minScore) || minScore < 0) throw new Error("minScore must be a non-negative number.");
    }
    // Excluded leads (government, chains, merged duplicates) stay hidden unless all=1.
    const includeExcluded = params.get("all") === "1";
    // Limit raised from 500 so the table/board see every lead; deals=1 adds each lead's stage,
    // days in stage, stuck flag, value and top issues (deals.ts) in one pass.
    const leads = listLeads(db, { status, vertical, minScore, limit: 5000, includeExcluded });
    if (params.get("deals") !== "1") return { leads: leads.map(withVerified) };
    const rows = dealRows(root, db, leads);
    return { leads: leads.map((lead) => ({ ...withVerified(lead), deal: rows.get(lead.id) })) };
  }

  async function detail(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = await hydrateLead(requireLead(id), session());
    const report = readTrustedIssues(db, lead);
    return {
      lead: { ...withVerified(lead), editVersion: leadEditVersion(requireLead(id)) }, activities: activities(db, lead.id), phoneFinding: phoneFinding(lead.id),
      pipeline: leadPipeline(root, db, lead), drafts: draftFiles(root, lead.id), deal: leadDeal(root, db, lead),
      // issues.ts: top evidenced issues with the page each was seen on (null until an issues pass ran).
      issues: report ? { checkedAt: report.checkedAt, status: report.status, statusNote: report.statusNote, hook: report.hook, top: topIssues(report, 3) } : null,
    };
  }

  function phoneFinding(leadId: number) {
    const f = readFinding(db, leadId);
    return f ? { ...f, summary: describeSources(f) } : null;
  }

  /** Founder-clicked, one lead: search for its number (SearXNG + Crawl4AI + Jev). Writes `phone`
   *  only on strong agreement and never over an existing one; otherwise leaves a suggestion. */
  async function findPhone(body: any) {
    const lead = requireLead(body?.lead);
    if (lead.excluded) throw new Error("Excluded leads are never called, so there's no phone to find.");
    if (lead.status === "do_not_contact") throw new Error("This lead asked not to be contacted.");
    if (lead.phone) throw new Error("This lead already has a phone — it's never overwritten.");
    const finding = await findAndApply(db, lead, deps.phoneFinder ?? defaultFinderDeps(root));
    return { outcome: finding.outcome, reason: finding.reason, lead: withVerified(requireLead(lead.id)), phoneFinding: phoneFinding(lead.id) };
  }

  function dueCalls(now = new Date()): Lead[] {
    return dayReport(db, null, now).followUpsDue.filter((l) => isCallDue(l, now.getTime()));
  }

  async function calls(params: URLSearchParams) {
    const nRaw = Number(params.get("n"));
    const n = Math.min(Math.max(Number.isFinite(nRaw) && nRaw > 0 ? Math.round(nRaw) : 15, 1), 50);
    const leads = await hydrateLeads(callList(db, n), session());
    return {
      callWindow: callWindow(),
      // Call-backs and follow-ups due today or overdue, by the same rule as the Leads call queue,
      // Today's "Calls to make" and Work's call-queue panel (src/lib/call-queue.ts isCallDue), so
      // every surface gives one number. `leads` is the wider call sheet (first calls included).
      due: dueCalls().length,
      leads: leads.map((lead) => ({
        ...withVerified(lead),
        opener: callOpener({ ...lead, hook: issueHook(db, lead) }, DEFAULT_SENDER),
        scriptReady: !!currentScript(lead.id),
        topIssues: topIssues(readTrustedIssues(db, lead), 3),
      })),
    };
  }

  function log(body: any) {
    const parsed = validateLogBody(body);
    const lead = requireLead(parsed.lead);
    const duplicate = parsed.eventId ? eventLogged(db, parsed.eventId) : false;
    const updated = logActivity(db, lead, {
      kind: parsed.kind,
      outcome: parsed.outcome,
      note: parsed.note,
      by: parsed.by,
      nextAt: parsed.next,
      eventId: parsed.eventId,
    });
    return { lead: updated, duplicate };
  }

  async function card(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = await hydrateLead(requireLead(id), session());
    return buildCard(db, lead, DEFAULT_SENDER);
  }

  async function cards(params: URLSearchParams) {
    const nRaw = Number(params.get("n"));
    const n = Math.min(Math.max(Number.isFinite(nRaw) && nRaw > 0 ? Math.round(nRaw) : 10, 1), 50);
    const leads = await hydrateLeads(callList(db, n), session());
    return { cards: leads.map((lead) => buildCard(db, lead, DEFAULT_SENDER)) };
  }

  function followups(params: URLSearchParams) {
    const who = params.get("by") || null;
    if (who && !isOwner(who)) throw new Error("by must be usman or mehroz.");
    return { followUps: followUpQueue(db, who, DEFAULT_SENDER) };
  }

  function won(body: any) {
    const lead = requireLead(body?.lead);
    const scope = String(body?.scope ?? "").trim();
    const by = String(body?.by ?? "").trim();
    if (by && !isOwner(by)) throw new Error("by must be usman or mehroz.");
    return recordWin(db, lead, { scope, by });
  }

  function kickoff(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = requireLead(id);
    const record = getKickoff(db, lead.id);
    if (!record) throw new Error("No kickoff on file for this lead yet — run leads/won first.");
    return { lead, kickoff: record };
  }

  function coach(body: any) {
    const lead = requireLead(body?.lead);
    const by = String(body?.by ?? "").trim();
    if (by && !isOwner(by)) throw new Error("by must be usman or mehroz.");
    return recordCoaching(db, lead, {
      activityId: body?.activityId ?? null, by, categories: body?.categories ?? {},
      objectionTag: body?.objectionTag ?? null, worked: String(body?.worked ?? ""),
      improve: String(body?.improve ?? ""), nextStep: String(body?.nextStep ?? ""),
    });
  }

  function coaching(params: URLSearchParams) {
    const who = params.get("by") || null;
    if (who && !isOwner(who)) throw new Error("by must be usman or mehroz.");
    const daysRaw = Number(params.get("days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : 7;
    return coachingSummary(db, who, days);
  }

  function setDailyGoal(body: any) {
    const { by, calls: n } = validateGoalBody(body);
    setGoal(db, by, n);
    return { by, calls: goal(db, by) };
  }

  function draft(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = requireLead(id);
    if (!lead.emails.length) throw new Error("No published email address on file for this lead.");
    if (!lead.emailOk) throw new Error("This lead has opted out or its site asks not to be emailed.");
    // F1-33: the founder's contact note travels with the draft (a no-email note refuses it).
    const drafted = emailDraft({ name: lead.name, vertical: lead.vertical, reasons: lead.reasons, pitch: emailPitch(lead.pitch), hook: issueHook(db, lead), contactPref: readDeal(db, lead.id).contactPref }, DEFAULT_SENDER);
    return { to: lead.emails, subject: drafted.subject, body: drafted.body, sent: false, note: "Draft only — this is never sent automatically." };
  }

  function script(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = requireLead(id);
    return { script: currentScript(lead.id) };
  }

  function currentScript(id: number) {
    const script = readScript(root, id);
    return script && leadArtifactCurrent(db, id, script.generatedAt) ? script : null;
  }

  async function generateScript(body: any) {
    const lead = requireLead(body?.lead);
    if (lead.excluded) throw new Error("Excluded leads never get a call script.");
    if (lead.status === "do_not_contact") throw new Error("This lead asked not to be contacted.");
    return { script: await generateCallScript(db, await hydrateLead(lead, session()), { root }) };
  }

  function seoAuditStatus(params: URLSearchParams) {
    const id = params.get("id");
    if (!id) throw new Error("Missing lead id.");
    const lead = requireLead(id);
    const audit = readSeoAudit(root, lead.id) as SeoAuditRecord | null;
    return { audit: audit && leadArtifactCurrent(db, lead.id, audit.startedAt, true) ? audit : null };
  }

  /** Founder-clicked, one lead at a time -- runSeoAudit's own process-wide lock enforces
   *  concurrency 1 regardless of who or what lead this is called for. Local-PC-only: it spends a
   *  small amount of Jev budget and runs a real crawl of the lead's own site. */
  async function seoAudit(body: any, remote: boolean) {
    if (remote) throw new LocalOnly("SEO audits run from this PC only.");
    const lead = requireLead(body?.lead);
    if (lead.excluded) throw new Error("Excluded leads never get an SEO audit.");
    if (lead.status === "do_not_contact") throw new Error("This lead asked not to be contacted.");
    if (!lead.website) throw new Error("This lead has no website on file.");
    try {
      return { audit: await runSeoAudit({ id: lead.id, website: lead.website }, { root }) };
    } catch (error) {
      if (error instanceof SeoAuditBusyError || error instanceof SeoAuditConfigError) throw error;
      throw new Error(error instanceof Error ? error.message : "The SEO audit failed.");
    }
  }

  function watch(): WatchSummary {
    // Local-file summary only (watch-state.json, written by `watch sync`/`watch changes`) --
    // this route never itself calls out to changedetection.io, so it's cheap and works even if
    // that process is stopped.
    return readWatchSummary(root);
  }

  async function find(body: any, remote: boolean) {
    if (remote) throw new LocalOnly("Finding leads spends paid Google lookups (source=google) or shares this PC's slot on OpenStreetMap's free servers (source=osm) — only from this PC.");
    const opts = validateFindBody(body);
    try {
      return await findLeads(db, opts);
    } catch (error) {
      throw friendlyFindError(error, opts.source);
    }
  }

  function saveDealBody(body: any) {
    const lead = requireLead(body?.lead);
    const by = String(body?.by ?? "").trim();
    if (by && !isOwner(by)) throw new Error("by must be usman or mehroz.");
    const patch: DealPatch = {};
    for (const key of ["offer", "packageId", "setupCents", "monthlyCents", "probability", "expectedClose", "contactPref"] as const) {
      if (body && key in body) (patch as any)[key] = body[key] === "" && key !== "contactPref" ? null : body[key];
    }
    if (patch.offer !== undefined && patch.offer !== null && !OFFERS.includes(patch.offer)) throw new Error(`offer must be one of ${OFFERS.join(", ")}.`);
    saveDeal(db, lead.id, patch, by);
    return { deal: leadDeal(root, db, requireLead(lead.id)) };
  }

  function move(body: any) {
    const lead = requireLead(body?.lead);
    const by = String(body?.by ?? "").trim();
    if (by && !isOwner(by)) throw new Error("by must be usman or mehroz.");
    const kind = body?.kind === "email" ? "email" : body?.kind === "call" ? "call" : undefined;
    return moveStage(root, db, lead, { to: String(body?.to ?? ""), by, note: String(body?.note ?? "").slice(0, 1000), kind, scope: String(body?.scope ?? "").slice(0, 300) });
  }

  return {
    close: () => db.close(),
    async handle(path: string, method: string, body: any, params: URLSearchParams, remote: boolean) {
      if (path === "/leads/summary" && method === "GET") return summary();
      if (path === "/leads/list" && method === "GET") return list(params);
      if (path === "/leads/detail" && method === "GET") return detail(params);
      if (path === "/leads/edit" && method === "POST") {
        const lead = editLead(db, requireLead(body?.lead).id, body);
        return { lead: { ...withVerified(lead), editVersion: leadEditVersion(lead) } };
      }
      if (path === "/leads/pipeline" && method === "GET") return params.get("summary") === "1" ? pipelineSummary(root, db) : leadPipeline(root, db, requireLead(params.get("id") ?? ""));
      if (path === "/leads/proposal" && method === "POST") { const t = draftTarget(db, requireLead(body?.lead), body?.packageId); return draftProposal(root, t.lead, t.packageId); }
      if (path === "/leads/deposit-invoice" && method === "POST") { const t = draftTarget(db, requireLead(body?.lead), body?.packageId); return draftInvoice(root, t.lead, new Date(), t.packageId); }
      if (path === "/leads/draft-file" && method === "GET") {
        const lead = requireLead(params.get("id") ?? "");
        const file = params.get("file") ?? "";
        return { file, content: readDraft(root, lead.id, file), mime: file.endsWith(".html") ? "text/html" : file.endsWith(".json") ? "application/json" : "text/markdown" };
      }
      if (path === "/leads/deal-desk/list" && method === "GET") return listDeals(root);
      if (path === "/leads/deal-desk/get" && method === "GET") return getDeal(root, params.get("id"));
      // "Updated by" comes only from the verified principal. For these routes the operator plugin admits a confirmed
      // human session only, sets body.by to that person and passes the signer flag as true. A direct call without that
      // flag (a test, a script) is recorded as "local" whatever it claims: no self-declared author.
      const desk = () => ({ ...(body ?? {}), by: remote ? body?.by : undefined });
      if (path === "/leads/deal-desk/save" && method === "POST") return saveDeskDeal(root, desk());
      if (path === "/leads/deal-desk/archive" && method === "POST") return archiveDeal(root, desk());
      if (path === "/leads/deal-desk/link" && method === "POST") return linkDeal(root, desk());
      if (path === "/leads/deal-desk/attach" && method === "POST") {
        const lead = requireLead(body?.lead); assertDraftable(lead);
        // The lead's saved package is authoritative, as for proposals: the quote must price the same package.
        const saved = readDeal(db, lead.id);
        return attachDeal(root, desk(), lead.id, (deal) => {
          if (!deal.include.receptionist) return;
          if (saved.packageUnknown) throw new DealDeskError(409, `The package saved on this lead's deal ("${saved.packageUnknown}") isn't in the catalogue. Fix the lead's deal first.`);
          if (!saved.packageId) throw new DealDeskError(409, "Choose the receptionist package on the lead's deal first, so the deal and this quote agree.");
          if (saved.packageId !== deal.rx.packageId) throw new DealDeskError(409, `The lead's deal is saved as ${getReceptionistPackage(saved.packageId).shortName} but this workbook prices ${getReceptionistPackage(deal.rx.packageId).shortName}. Change one so they agree.`);
        });
      }
      if (path === "/leads/calls" && method === "GET") return calls(params);
      if (path === "/leads/card" && method === "GET") return card(params);
      if (path === "/leads/cards" && method === "GET") return cards(params);
      if (path === "/leads/draft" && method === "GET") return draft(params);
      if (path === "/leads/script" && method === "GET") return script(params);
      if (path === "/leads/generate-script" && method === "POST") return generateScript(body);
      if (path === "/leads/seo-audit" && method === "GET") return seoAuditStatus(params);
      if (path === "/leads/seo-audit" && method === "POST") return seoAudit(body, remote);
      if (path === "/leads/followups" && method === "GET") return followups(params);
      if (path === "/leads/find-phone" && method === "POST") return findPhone(body);
      if (path === "/leads/log" && method === "POST") return log(body);
      if (path === "/leads/goal" && method === "POST") return setDailyGoal(body);
      if (path === "/leads/find" && method === "POST") return find(body, remote);
      if (path === "/leads/won" && method === "POST") return won(body);
      if (path === "/leads/kickoff" && method === "GET") return kickoff(params);
      if (path === "/leads/coach" && method === "POST") return coach(body);
      if (path === "/leads/coaching" && method === "GET") return coaching(params);
      if (path === "/leads/watch" && method === "GET") return watch();
      if (path === "/leads/overview" && method === "GET") return crmOverview(root, db);
      if (path === "/leads/deal" && method === "POST") return saveDealBody(body);
      if (path === "/leads/move" && method === "POST") return move(body);
      if (path === "/leads/rules" && method === "GET") return readRules(db);
      if (path === "/leads/rules" && method === "POST") return saveRules(db, { probability: body?.probability, stuckDays: body?.stuckDays });
      if (path === "/leads/search" && method === "GET") return searchCrm(root, db, params.get("q") ?? "");
      throw new Error("Choose a supported leads action.");
    },
  };
}
