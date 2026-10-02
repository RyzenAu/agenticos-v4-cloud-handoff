#!/usr/bin/env bun
// M&U lead engine + CRM. Jarvis (Hermes skill `mu-leads`) and the founders both use this.
// Nothing here sends an email or places a call.
//
//   bun scripts/leads/cli.ts find --vertical dental|legal|real-estate --area "Parramatta NSW" [--max 20]
//                                [--source osm|google]  osm (OpenStreetMap, free) is the default;
//                                google only works while GOOGLE_PLACES_API_KEY is valid
//                                [--enrich-max 60]  cap on how many of this run's websites get fetched
//   bun scripts/leads/cli.ts calls [--n 8] [--verified] [--all]  today's call list + opener lines;
//                                each reason tagged [verified] (seen on the site) or [score-only];
//                                --verified keeps only leads with at least one verified fact;
//                                --all also surfaces excluded leads (hidden by default)
//   bun scripts/leads/cli.ts card <lead> | cards [--n 10] [--verified]   30-second call-prep
//                                card(s), CRM data only
//   bun scripts/leads/cli.ts list [--status new] [--vertical dental] [--min 40] [--limit 50] [--all]
//                                --all also surfaces excluded leads (hidden by default; see `excluded`)
//   bun scripts/leads/cli.ts show <lead>
//   bun scripts/leads/cli.ts pipeline <lead> | pipeline --summary
//   bun scripts/leads/cli.ts proposal <lead> | deposit-invoice <lead> [--package receptionist-essential|receptionist-professional|receptionist-premium]  (local drafts only; default: the deal's saved package)
//   bun scripts/leads/cli.ts overview                 the morning sentence, tiles, to-do and stuck deals
//   bun scripts/leads/cli.ts stuck                    every lead over its stage's stuck-too-long limit
//   bun scripts/leads/cli.ts deal <lead> [--setup 1650] [--monthly <A$ amount; default from the package catalogue>] [--offer website|redesign|receptionist|both]
//                                [--package receptionist-essential|receptionist-professional|receptionist-premium]
//                                [--probability 40] [--close 2026-10-15] [--contact-pref "…"] [--by usman]
//                                value, weighting, stage history; "default" clears a field back
//   bun scripts/leads/cli.ts move <lead> --to contacted|replied|meeting|proposal|won|lost
//                                [--kind call|email] [--scope "…"] [--note "…"] [--by usman]  logs one activity
//   bun scripts/leads/cli.ts rules [--stuck replied=3,proposal=off] [--probability meeting=40]
//   bun scripts/leads/cli.ts log <lead> --outcome no_answer|voicemail|call_back|interested|not_interested|do_not_contact|meeting|won|lost
//                                [--kind call|email|note|meeting] [--note "…"] [--next 2026-09-30] [--by usman] [--event <id>]
//   bun scripts/leads/cli.ts draft <lead> [--by usman]    email draft (only to an address the business published)
//   bun scripts/leads/cli.ts followups [--by usman]         due/overdue next actions + a draft reply
//                                (never sent), plus any review/referral asks due (14 days after a
//                                won client's "Deployed" milestone, see `care-plan`/review-ask.ts)
//   bun scripts/leads/cli.ts care-plan <lead> [--month 2026-09] [--repo <path to client repo>] [--by usman]
//                                monthly care-plan draft for a won client: re-runs the SEO audit,
//                                an uptime/response check, and lists the month's changes (from
//                                .operator-data/care-plan/<slug>/CHANGES.md, or `--repo`'s git log)
//                                -- writes a client-friendly email + HTML report, draft only, to
//                                .operator-data/drafts/care-plan/<slug>/<month>/
//   bun scripts/leads/cli.ts prep-tomorrow [--top 10] [--by usman]   tomorrow's morning pack: SEO
//                                audit + local (never deployed) preview + opener/call script for
//                                the top of tomorrow's call list (no pack when tomorrow is a
//                                Sunday or public holiday) -- see docs/NIGHTLY-PREP.md
//   bun scripts/leads/cli.ts won <lead> --scope "…" [--by usman]   record the win + create a kickoff checklist
//   bun scripts/leads/cli.ts kickoff <lead>                 the internal kickoff checklist for a won lead,
//                                each milestone's state (pending/partial/done) + the single next action
//   bun scripts/leads/cli.ts milestone <lead> "<name>" --state pending|partial|done
//                                [--note "…"] [--due 2026-09-26] [--date 2026-09-22] [--by usman]
//                                update one delivery milestone (content collected, build started,
//                                review sent, revisions closed, balance invoiced, deployed,
//                                handover sent, review/referral asked); --date sets the completion
//                                date when --state done (defaults to now)
//   bun scripts/leads/cli.ts coach <lead> --data '<json>' [--by usman]   score a debrief (never a recording)
//   bun scripts/leads/cli.ts coaching [--by usman] [--days 7]   trend: average score, top objection, repeats
//   bun scripts/leads/cli.ts optout <email|phone|lead>
//   bun scripts/leads/cli.ts goal --by usman --calls 20     daily call target (0 = none)
//   bun scripts/leads/cli.ts today [--by usman]            today's calls, meetings, follow-ups due, vs target
//   bun scripts/leads/cli.ts stats | export
//   bun scripts/leads/cli.ts purge [--apply]      strict Google Places cleanup (places-cleanup.ts): dry run unless --apply
//   bun scripts/leads/cli.ts rescan                 re-check every open lead: exclusion (gov/legal
//                                aid/non-profit/chain), website discovery for anything with no
//                                website on file, rescore on the real site (see docs/LEAD-ENGINE.md)
//   bun scripts/leads/cli.ts excluded                every lead marked excluded, with why
//   bun scripts/leads/cli.ts dedupe                  find leads that are the same business (same
//                                discovered/tagged domain or phone) and merge them, keeping the
//                                richer record (never deletes; the weaker row stays as `excluded`)
//   bun scripts/leads/cli.ts watch sync       add a changedetection.io watch for every open lead
//                                              with a website (idempotent)
//   bun scripts/leads/cli.ts watch changes    poll changedetection.io for sites that changed,
//                                              note it on the lead
//   bun scripts/leads/cli.ts find-phone <lead>       search for a no-phone lead's number (SearXNG,
//                                Crawl4AI, Jev match check); writes it only on strong agreement,
//                                otherwise a "suggested — verify" number; never overwrites a phone
//   bun scripts/leads/cli.ts phones run [--pilot 30] [--limit N] | phones status | phones coverage
//                                the resumable batch (pauses while meeting mode is on)
//   bun scripts/leads/cli.ts issues <lead> [--dry-run]   evidence-backed issues on their own site
//                                (issues.ts), MiMo hook when MIMO_BULK=1; saves + rescores unless --dry-run
//   bun scripts/leads/cli.ts issues --batch [--top 50] [--dry-run]   the same for today's top callable
//                                leads + a before/after report in .operator-data/reports/
// Add --json for machine output. <lead> is the number, the place ID or a unique part of the name.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildCard, renderCard } from "./card";
import { renderCoachingSummary, renderCoachNote } from "./coach";
import {
  activities, callList, coachingSummary, crmPath, dayReport, eventLogged, excludedLeads, findLead, getKickoff,
  goal, isOptedOut, listLeads, logActivity, nextMilestoneAction, openCrm, pipeline,
  recentSiteChanges, recordCoaching, recordWin, setGoal, setMilestone, STATUSES, sydneyDate, usage,
  type KickoffChecklist, type Lead, type Milestone, type MilestoneState, type Status,
} from "./crm";
import { findLeads, MONTHLY_DETAILS_BUDGET, type Source } from "./engine";
import { applyPlacesCleanup, planPlacesCleanup, renderCleanupPlan } from "./places-cleanup";
import { defaultPlacesLookup, hydrateLead, hydrateLeads, placesAttributionLine, placesSession, type LiveLead } from "./places-live";
import { callOpener, callWindow, DEFAULT_SENDER, emailDraft, emailPitch } from "./outreach";
import { followUpQueue, renderFollowUp } from "./followups";
import { buildCarePlanDraft, renderCarePlanSummary } from "./care-plan";
import { reviewAskQueue, renderReviewAsk } from "./review-ask";
import { buildMorningPack, renderMorningPack, writeMorningPack } from "./prep-tomorrow";
import { defaultDraftsRoot } from "../site-draft/orchestrator";
import { mergeDuplicates, renderMergeResults } from "./dedupe";
import { isVertical, VERTICALS } from "./places";
import { rescanAll, renderRescanSummary } from "./rescan";
import { coverageByPitch, defaultFinderDeps, describeSources, findAndApply, loadProgress, readFinding, runPhoneFinder } from "./phone-finder";
import { isVerifiedFact } from "./score";
import { draftInvoice, draftProposal } from "./sales-backoffice";
import { leadPipeline, pipelineSummary } from "./lead-pipeline";
import { crmOverview, dealRows, draftTarget, leadDeal, moveStage, readDeal, readRules, saveDeal, saveRules, type DealPatch } from "./deals";
import { applyIssueReport, detectIssues, issueHook, outreachBlocked, rankWithMimo } from "./issues";
import { renderTargetingReport, runIssuesBatch, writeTargetingReport } from "./issues-batch";
import { createJarvisEvents } from "../jarvis-events";
import {
  changeDetectionConfigFromEnv, pollChanges, renderPollResult, renderSyncResult, syncWatches,
} from "./watch";
import { dataDirFor } from "../cloud/data-dir";

function isSource(value: unknown): value is Source {
  return value === "osm" || value === "google";
}

const ROOT = resolve(import.meta.dir, "..", "..");
const SENDERS: Record<string, string> = { usman: "Usman", mehroz: "Mehroz" };

function args(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "true";
      else (flags[a.slice(2)] = next), i++;
    } else rest.push(a);
  }
  return { flags, rest };
}

const line = (l: LiveLead) =>
  `#${l.id} ${l.name || (l.source === "google" ? "(Google place: details load live)" : "(name not on file)")} · ${l.vertical} · ${l.area} · score ${l.score} (${l.pitch}) · ${l.status}` +
  `${l.phone ? ` · ${l.phone}` : ""}${l.emailOk ? ` · ${l.emails[0]}` : ""}${l.excluded ? ` · EXCLUDED (${l.excludedReason})` : ""}`;

function sender(by?: string) {
  const name = SENDERS[(by ?? "usman").toLowerCase()] ?? by ?? DEFAULT_SENDER.name;
  return { ...DEFAULT_SENDER, name };
}

function renderMilestone(m: Milestone) {
  const box = m.state === "done" ? "x" : m.state === "partial" ? "~" : " ";
  const bits: string[] = [];
  if (m.state === "done" && m.completedAt) bits.push(`done ${m.completedAt.slice(0, 10)}`);
  if (m.state !== "done" && m.due) bits.push(`due ${m.due}`);
  if (m.note) bits.push(m.note);
  return `  - [${box}] ${m.name}${bits.length ? ` — ${bits.join("; ")}` : ""}`;
}

function renderKickoff(lead: Lead, k: KickoffChecklist) {
  const section = (title: string, items: string[]) => [`${title}:`, ...items.map((i) => `  - [ ] ${i}`)].join("\n");
  const next = nextMilestoneAction(k);
  return [
    `Kickoff · #${lead.id} ${lead.name} · scope: ${k.scope}${k.by ? ` · won by ${k.by}` : ""} · ${k.createdAt.slice(0, 10)}`,
    section("Intake questions", k.intake),
    section("Asset requests", k.assets),
    section("Accounts access", k.access),
    [`Milestones:`, ...k.milestones.map(renderMilestone)].join("\n"),
    next ? `Next action: ${next.name}${next.detail ? ` — ${next.detail}` : ""}` : "All milestones done — nothing left to track here.",
    "Internal checklist only — nothing here has been sent to the client.",
  ].join("\n\n");
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const { flags, rest } = args(argv);
  const json = flags.json === "true";
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);
  const db = openCrm(crmPath(ROOT));
  // One in-memory Places cache for this command: Google leads' details are fetched live, never stored.
  const places = placesSession(defaultPlacesLookup(db));
  const need = (ref?: string) => {
    if (!ref) throw new Error("Which lead? Give its number or part of its name.");
    const lead = findLead(db, ref);
    if (!lead) throw new Error(`No lead matches "${ref}".`);
    return lead;
  };

  switch (command) {
    case "pipeline": {
      if (flags.summary === "true") {
        const result = pipelineSummary(ROOT, db);
        out(result, [`${result.total} leads (${result.closed} closed/excluded)`, ...Object.entries(result.counts).map(([stage, count]) => `${stage}: ${count}`)].join("\n"));
      } else {
        const view = leadPipeline(ROOT, db, need(rest[0]));
        out(view, `#${view.leadId}: ${view.stage} — ${view.evidence}\nNext: ${view.nextAction} (${view.owner})`);
      }
      break;
    }
    case "overview": {
      const o = crmOverview(ROOT, db);
      const t = o.tiles;
      const aud = (c: number) => `A$${(c / 100).toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;
      out(o, [
        o.sentence,
        `New (7 d): ${t.newLeads.count ?? "unknown"} · Open pipeline: ${aud(t.pipeline.weightedCents)} weighted (${t.pipeline.count} deals, ${aud(t.pipeline.valueCents)}) · Stuck: ${t.stuck.count}`,
        `Overdue follow-ups: ${t.followUps.overdue} (+${t.followUps.dueToday} today) · Proposals: ${t.proposals.count} (${aud(t.proposals.valueCents)}) · Builds: ${t.builds.active} (${t.builds.tasksDue} tasks due)`,
        `Owed to us: ${aud(t.invoices.cents)} · ${t.invoices.label} (${t.invoices.source})${t.netCash ? ` · Net cash ${t.netCash.month} (NAB CSV, not margin): ${t.netCash.netCents === null ? "unknown" : `${aud(t.netCash.netCents)}${t.netCash.coverage === "partial" ? " (partial month)" : ""}`}` : ""}`,
        "To do today:",
        ...o.todo.slice(0, 15).map((i) => `  ${i.overdue ? "OVERDUE " : ""}[${i.kind}] #${i.leadId} ${i.name} — ${i.detail}${i.contactPref ? ` (prefers: ${i.contactPref})` : ""}`),
        ...(o.upcoming.length ? ["Upcoming:", ...o.upcoming.slice(0, 10).map((u) => `  ${u.at.slice(0, 10)} ${u.kind} · #${u.leadId} ${u.name} — ${u.detail}`)] : []),
      ].join("\n"));
      break;
    }
    case "stuck": {
      const leads = listLeads(db, { limit: 10_000 });
      const rows = dealRows(ROOT, db, leads);
      const stuck = leads.filter((l) => rows.get(l.id)!.stuck).map((l) => ({ lead: l, row: rows.get(l.id)! }));
      out(stuck.map(({ lead, row }) => ({ id: lead.id, name: lead.name, stage: row.stage, ...row.stuck })),
        stuck.length ? stuck.map(({ lead, row }) => `#${lead.id} ${lead.name} · ${row.stage} ${row.stuck!.days} d (limit ${row.stuck!.thresholdDays}) — ${row.stuck!.action}`).join("\n") : "Nothing stuck.");
      break;
    }
    case "deal": {
      const lead = need(rest[0]);
      const patch: DealPatch = {};
      const clear = (v: string) => v === "default" || v === "none";
      const money = (v: string) => (clear(v) ? null : Math.round(Number(v) * 100));
      if (flags.package) patch.packageId = clear(flags.package) ? null : flags.package; // validated by saveDeal against the catalogue
      if (flags.setup) patch.setupCents = money(flags.setup);
      if (flags.monthly) patch.monthlyCents = money(flags.monthly);
      if (flags.offer) patch.offer = clear(flags.offer) ? null : flags.offer as DealPatch["offer"];
      if (flags.probability) patch.probability = clear(flags.probability) ? null : Number(flags.probability) / 100;
      if (flags.close) patch.expectedClose = clear(flags.close) ? null : flags.close;
      if (flags["contact-pref"]) patch.contactPref = clear(flags["contact-pref"]) ? "" : flags["contact-pref"];
      if (Object.keys(patch).length) saveDeal(db, lead.id, patch, flags.by ?? "");
      const d = leadDeal(ROOT, db, findLead(db, lead.id)!);
      const e = d.economics;
      out(d, [
        `#${lead.id} ${lead.name} · ${d.stage}${d.daysInStage !== null ? ` for ${d.daysInStage} d` : ""}${d.stuck ? ` · STUCK (limit ${d.stuck.thresholdDays} d): ${d.stuck.action}` : ""}`,
        `${e.offerLabel}: A$${e.setupCents / 100}${e.monthlyCents ? ` + A$${e.monthlyCents / 100}/mo × ${d.monthsCounted}` : ""} = A$${e.valueCents / 100} · ${Math.round(e.probability * 100)}% (${e.probabilitySource}) · weighted A$${Math.round(e.weightedCents) / 100}${e.expectedClose ? ` · close ${e.expectedClose}` : ""}`,
        d.contactPref ? `How they like to be contacted: ${d.contactPref}` : "",
        "Stage history:",
        ...d.timeline.map((s) => `  ${s.stage}: ${s.at ? s.at.slice(0, 10) : "date not recorded"} — ${s.evidence}`),
      ].filter(Boolean).join("\n"));
      break;
    }
    case "move": {
      const lead = need(rest[0]);
      const result = moveStage(ROOT, db, lead, { to: flags.to ?? "", by: flags.by, note: flags.note, kind: flags.kind === "email" ? "email" : "call", scope: flags.scope });
      out(result, `#${lead.id} ${lead.name} is now at ${result.pipeline.stage}. One activity logged; nothing was sent.`);
      break;
    }
    case "rules": {
      const pairs = (v?: string) => Object.fromEntries((v ?? "").split(",").filter(Boolean).map((kv) => kv.split("=").map((x) => x.trim())));
      if (flags.stuck || flags.probability) {
        saveRules(db, {
          stuckDays: Object.fromEntries(Object.entries(pairs(flags.stuck)).map(([k, v]) => [k, v === "off" ? null : Number(v)])),
          probability: Object.fromEntries(Object.entries(pairs(flags.probability)).map(([k, v]) => [k, Number(v) / 100])),
        });
      }
      const r = readRules(db);
      out(r, Object.entries(r.probability).map(([s, p]) => `${s}: ${Math.round(p * 100)}%${r.stuckDays[s as keyof typeof r.stuckDays] ? ` · stuck after ${r.stuckDays[s as keyof typeof r.stuckDays]} d` : ""}`).join("\n"));
      break;
    }
    case "proposal":
    case "deposit-invoice": {
      const lead = need(rest[0]);
      // Same rule as the API: the deal's offer, an explicit or saved catalogue package, never an assumed one.
      const t = draftTarget(db, lead, flags.package);
      const result = command === "proposal" ? draftProposal(ROOT, t.lead, t.packageId) : draftInvoice(ROOT, t.lead, new Date(), t.packageId);
      out(result, `DRAFT only — ${result.files.map(f => join(dataDirFor(ROOT), "drafts", String(lead.id), f)).join("\n")}`);
      break;
    }
    case "find": {
      if (!isVertical(flags.vertical)) throw new Error(`--vertical must be one of ${Object.keys(VERTICALS).join(", ")}.`);
      if (flags.source !== undefined && !isSource(flags.source)) throw new Error('--source must be "osm" or "google".');
      const source: Source = isSource(flags.source) ? flags.source : "osm";
      const result = await findLeads(db, {
        vertical: flags.vertical, area: flags.area ?? rest.join(" "), source,
        max: Number(flags.max ?? 20), enrichMax: flags["enrich-max"] !== undefined ? Number(flags["enrich-max"]) : undefined,
      });
      out(
        result,
        [
          `${result.added.length} new ${result.vertical} leads in ${result.area} via ${source === "osm" ? "OpenStreetMap" : "Google Places"}` +
            ` (${result.searched} found, ${result.alreadyKnown} already in the CRM` +
            `${result.skippedClosed ? `, ${result.skippedClosed} closed` : ""})` +
            ` — ${result.noWebsite} with no website found, ${result.withPhone} with a phone, ${result.withEmail} with an email` +
            `${result.discovered ? `, ${result.discovered} website(s) found by discovery (no directory tag)` : ""}` +
            `${result.excluded ? `, ${result.excluded} excluded (gov/legal aid/non-profit/chain)` : ""}.`,
          ...result.added.slice(0, 15).map((l) => `  ${line(l)}\n     ${l.reasons.slice(0, 3).join("; ")}`),
          source === "osm"
            ? `Source: ${result.attribution}.${result.flaggedPersonalEmails ? ` ${result.flaggedPersonalEmails} personal-looking email(s) found and skipped, not stored.` : ""}`
            : `Place details: ${placesAttributionLine(result.added[0]?.placesLive) || "Google Maps"} — only the place IDs were saved. ` +
              `Places budget left this month: ${result.budgetLeft}/${MONTHLY_DETAILS_BUDGET}${result.stoppedForBudget ? " (stopped early: budget reached)" : ""}.`,
        ].join("\n"),
      );
      break;
    }
    case "calls": {
      const window = callWindow();
      const verifiedOnly = flags.verified === "true";
      const showAll = flags.all === "true";
      const changes = new Map(recentSiteChanges(db, 7).map((c) => [c.leadId, c]));
      // Tightened default cohort (backlog #5): a small, manually-verifiable list beats a long one.
      // Excluded leads (gov/legal aid/non-profit/chain, or a merged-away duplicate) are hidden
      // unless --all is given — they're never meant to be called.
      let listed = callList(db, Number(flags.n ?? 8), new Date(), showAll);
      if (verifiedOnly) listed = listed.filter((l) => l.reasons.some(isVerifiedFact) || changes.has(l.id));
      const leads = await hydrateLeads(listed, places);
      const items = leads.map((l) => ({ ...l, opener: callOpener({ ...l, hook: issueHook(db, l) }, sender(flags.by)) }));
      out(
        { window, leads: items, verifiedOnly },
        [
          `Calling hours: ${window.why}.${verifiedOnly ? " (verified-only)" : ""}`,
          ...items.map((l, i) => {
            const change = changes.get(l.id);
            const reasons = l.reasons.slice(0, 2).map((r) => `${r}${isVerifiedFact(r) ? " [verified]" : " [score-only]"}`);
            if (change) reasons.unshift(`site changed ${change.at.slice(0, 10)} [verified]`);
            const live = l.placesLive ? `\n   ${placesAttributionLine(l.placesLive)}` : "";
            return `${i + 1}. ${line(l)}\n   Why: ${reasons.join("; ") || "—"}\n   Say: ${l.opener}${live}`;
          }),
          items.length ? "" : "Nobody due. Run `find` to add leads.",
        ].join("\n"),
      );
      break;
    }
    case "card": {
      const lead = await hydrateLead(need(rest[0]), places);
      const card = buildCard(db, lead, sender(flags.by));
      out(card, renderCard(card));
      break;
    }
    case "cards": {
      const verifiedOnly = flags.verified === "true";
      const leads = await hydrateLeads(callList(db, Number(flags.n ?? 10)), places);
      let cards = leads.map((l) => buildCard(db, l, sender(flags.by)));
      if (verifiedOnly) cards = cards.filter((c) => c.hasVerifiedFact);
      out({ cards, verifiedOnly }, cards.length ? cards.map(renderCard).join("\n\n") : "Nobody due (with a verified fact).");
      break;
    }
    case "list": {
      // Excluded leads (gov/legal aid/non-profit/chain, or a merged-away duplicate) are hidden
      // unless --all is given — see `excluded` for just that set.
      const leads = listLeads(db, { status: flags.status, vertical: flags.vertical, minScore: Number(flags.min ?? 0), limit: Number(flags.limit ?? 50), includeExcluded: flags.all === "true" });
      const changes = new Map(recentSiteChanges(db, 7).map((c) => [c.leadId, c]));
      out(
        leads,
        leads.map((l) => {
          const change = changes.get(l.id);
          return `${line(l)}${change ? ` · site changed ${change.at.slice(0, 10)} [verified — reason to reach out]` : ""}`;
        }).join("\n") || "No leads match.",
      );
      break;
    }
    case "show": {
      const lead = need(rest[0]);
      const history = activities(db, lead.id);
      out(
        { lead, activities: history },
        [
          line(lead),
          lead.address, lead.website, lead.mapsUrl,
          `Why: ${lead.reasons.join("; ")}`,
          ...history.map((a) => `  ${a.at.slice(0, 16)} ${a.kind} ${a.outcome} ${a.by ? `(${a.by})` : ""} ${a.note}`),
        ].filter(Boolean).join("\n"),
      );
      break;
    }
    case "log": {
      const lead = need(rest[0]);
      const outcome = (flags.outcome ?? "") as Status | "";
      if (outcome && !STATUSES.includes(outcome)) throw new Error(`--outcome must be one of ${STATUSES.join(", ")}.`);
      const kind = (flags.kind ?? (outcome ? "call" : "note")) as "call" | "email" | "note" | "meeting";
      if (!["call", "email", "note", "meeting"].includes(kind)) throw new Error("--kind must be call, email, note or meeting.");
      let nextAt: string | null = null;
      if (flags.next) {
        const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(flags.next) ? `${flags.next}T09:00:00+10:00` : flags.next);
        if (Number.isNaN(d.getTime())) throw new Error("--next must be a date like 2026-09-30.");
        nextAt = d.toISOString();
      }
      const duplicate = flags.event ? eventLogged(db, flags.event) : false;
      const updated = logActivity(db, lead, { kind, outcome, note: flags.note, by: flags.by, nextAt, eventId: flags.event });
      out(updated, duplicate ? `Already logged (event ${flags.event}); no duplicate created. ${line(updated)}` : `Logged. ${line(updated)}`);
      break;
    }
    case "draft": {
      const lead = need(rest[0]);
      if (lead.status === "do_not_contact") throw new Error(`${lead.name} asked not to be contacted.`);
      if (!lead.emailOk || !lead.emails.length || isOptedOut(db, lead.emails[0]))
        throw new Error(`No email to use for ${lead.name}: none published on their site, or they opted out. Call instead.`);
      const draft = { to: lead.emails[0], ...emailDraft({ name: lead.name, vertical: lead.vertical, reasons: lead.reasons, pitch: emailPitch(lead.pitch), hook: issueHook(db, lead), contactPref: readDeal(db, lead.id).contactPref }, sender(flags.by)) };
      out(draft, `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n\n(Draft only. Send it yourself, then: log ${lead.id} --kind email --outcome emailed)`);
      break;
    }
    case "followups": {
      const who = flags.by ? flags.by.toLowerCase() : null;
      const items = followUpQueue(db, who, sender(flags.by));
      // Review/referral asks (due 14 days after a won client's Deployed milestone) share this
      // desk -- same "due next action" idea, just for delivered clients rather than open leads.
      const reviewAsks = reviewAskQueue(db, sender(flags.by));
      const sections = [
        items.length ? items.map(renderFollowUp).join("\n\n") : "No follow-ups due.",
        reviewAsks.length ? reviewAsks.map(renderReviewAsk).join("\n\n") : "No review/referral asks due.",
      ];
      out({ followUps: items, reviewAsks }, sections.join("\n\n---\n\n"));
      break;
    }
    case "care-plan": {
      const lead = need(rest[0]);
      const draft = await buildCarePlanDraft(db, lead, { root: ROOT, month: flags.month, repoPath: flags.repo });
      out(draft, renderCarePlanSummary(draft));
      break;
    }
    case "prep-tomorrow": {
      const pack = await buildMorningPack(db, { root: ROOT, draftsRoot: defaultDraftsRoot(), top: Number(flags.top ?? 10), by: flags.by });
      const file = writeMorningPack(ROOT, pack);
      out({ pack, file }, `${renderMorningPack(pack)}\n\nWritten to ${file}`);
      break;
    }
    case "won": {
      const lead = need(rest[0]);
      if (!flags.scope) throw new Error('Say the scope: --scope "website rebuild + AI receptionist".');
      const { lead: updated, kickoff } = recordWin(db, lead, { scope: flags.scope, by: flags.by });
      out(
        { lead: updated, kickoff },
        `Won #${updated.id} ${updated.name}: ${flags.scope}\nKickoff checklist created — see \`kickoff ${updated.id}\`.\nNothing client-facing was sent.`,
      );
      break;
    }
    case "kickoff": {
      const lead = need(rest[0]);
      const kickoff = getKickoff(db, lead.id);
      if (!kickoff) throw new Error(`No kickoff on file for ${lead.name}. Run \`won ${lead.id} --scope "…"\` first.`);
      out(kickoff, renderKickoff(lead, kickoff));
      break;
    }
    case "milestone": {
      const lead = need(rest[0]);
      const name = rest[1];
      if (!name) throw new Error('Say the milestone name, e.g. milestone 32 "Content collected" --state partial --note "…".');
      const state = flags.state as MilestoneState;
      if (!["pending", "partial", "done"].includes(state)) throw new Error("--state must be pending, partial or done.");
      let completedAt: string | undefined;
      if (flags.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) throw new Error("--date must be a plain date like 2026-09-22 (used as the completion date when --state done).");
        completedAt = flags.date;
      }
      const kickoff = setMilestone(db, lead.id, name, { state, note: flags.note, due: flags.due, completedAt, by: flags.by });
      out(kickoff, renderKickoff(lead, kickoff));
      break;
    }
    case "coach": {
      const lead = need(rest[0]);
      if (!flags.data) throw new Error(`Give --data '{"categories":{"opener":12,...},"objectionTag":"price","worked":"…","improve":"…","nextStep":"…"}'.`);
      let parsed: any;
      try {
        parsed = JSON.parse(flags.data);
      } catch {
        throw new Error("--data must be valid JSON.");
      }
      const note = recordCoaching(db, lead, {
        activityId: parsed.activityId ?? null, by: flags.by, categories: parsed.categories ?? {},
        objectionTag: parsed.objectionTag ?? null, worked: parsed.worked ?? "", improve: parsed.improve ?? "",
        nextStep: parsed.nextStep ?? "",
      });
      out(note, renderCoachNote(note));
      break;
    }
    case "coaching": {
      const who = flags.by ? flags.by.toLowerCase() : null;
      const summary = coachingSummary(db, who, Number(flags.days ?? 7));
      out(summary, renderCoachingSummary(summary));
      break;
    }
    case "optout": {
      const value = rest[0] ?? "";
      const lead = value.includes("@") ? listLeads(db, { limit: 500 }).find((l) => l.emails.includes(value.toLowerCase())) : findLead(db, value);
      if (lead) logActivity(db, lead, { kind: "note", outcome: "do_not_contact", note: `opt-out: ${value}` });
      else db.query("INSERT OR IGNORE INTO optouts (value) VALUES (?)").run(value.includes("@") ? value.toLowerCase() : value.replace(/\D/g, ""));
      out({ optedOut: value, lead: lead?.id ?? null }, `Opted out: ${value}${lead ? ` (lead #${lead.id} marked do_not_contact)` : ""}.`);
      break;
    }
    case "goal": {
      const who = (flags.by ?? "").toLowerCase();
      if (!SENDERS[who]) throw new Error(`--by must be one of ${Object.keys(SENDERS).join(", ")}.`);
      if (flags.calls !== undefined) setGoal(db, who, Number(flags.calls));
      const target = goal(db, who);
      out({ who, dailyCalls: target }, `${SENDERS[who]}: ${target ? `${target} calls a day` : "no daily call target"}.`);
      break;
    }
    case "today": {
      const who = flags.by ? flags.by.toLowerCase() : null;
      const r = dayReport(db, who);
      const time = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit" });
      out(r, [
        `${r.date}${who ? ` · ${SENDERS[who] ?? who}` : ""}: ${r.calls} call${r.calls === 1 ? "" : "s"}${r.target ? ` of ${r.target}` : ""}, ${r.meetings} meeting${r.meetings === 1 ? "" : "s"}.`,
        ...r.activities.map((a) => `  ${time(a.at)} ${a.kind} #${a.leadId} ${a.leadName || "?"}: ${a.outcome || "—"}${a.note ? ` (${a.note.slice(0, 80)})` : ""}${!who && a.by ? ` [${a.by}]` : ""}`),
        r.followUpsDue.length ? `Follow-ups due (${r.followUpsDue.length}):` : "No follow-ups due.",
        ...r.followUpsDue.slice(0, 10).map((l) => `  ${line(l)} · due ${sydneyDate(l.nextAt!)}`),
      ].join("\n"));
      break;
    }
    case "stats": {
      const p = pipeline(db);
      const u = usage(db);
      const changes = recentSiteChanges(db, 7);
      out({ pipeline: p, placesUsage: u, budget: MONTHLY_DETAILS_BUDGET, recentSiteChanges: changes }, [
        `Pipeline: ${Object.entries(p).map(([k, v]) => `${k} ${v}`).join(", ") || "empty"}`,
        `Places this month: ${u.details_enterprise ?? 0}/${MONTHLY_DETAILS_BUDGET} detail lookups, ${u.text_search_ids ?? 0} free searches.`,
        changes.length
          ? `Recent site changes (7d, verified — reason to reach out): ${changes.map((c) => `#${c.leadId} ${c.leadName} (${c.at.slice(0, 10)})`).join(", ")}.`
          : "Recent site changes (7d): none.",
      ].join("\n"));
      break;
    }
    case "export": {
      // The csv-memory surface: exact counts and lists for "how many dentists did we call?".
      const dir = join(homedir(), "Desktop", "Business - M&U Ventures", "data");
      mkdirSync(dir, { recursive: true });
      const rows = listLeads(db, { limit: 500 });
      const cols = ["id", "name", "vertical", "area", "status", "score", "pitch", "owner", "lastContactAt", "nextAt", "emailOk", "website"] as const;
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      // Names only for leads a founder has contacted (then they're our record, not Google's copy).
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(c === "name" && r.googleAt ? "" : r[c])).join(","))].join("\n");
      writeFileSync(join(dir, "leads.csv"), csv + "\n");
      out({ file: join(dir, "leads.csv"), rows: rows.length }, `Wrote ${rows.length} leads to ${join(dir, "leads.csv")}.`);
      break;
    }
    case "purge": {
      // Strict Places cleanup (places-cleanup.ts): dry run unless --apply.
      const plan = flags.apply === "true" ? applyPlacesCleanup(db, { root: ROOT }) : planPlacesCleanup(db, { root: ROOT });
      out(plan, renderCleanupPlan(plan, crmPath(ROOT)));
      break;
    }
    case "rescan": {
      // Re-checks every open lead: exclusion (gov/legal aid/non-profit/chain), website discovery
      // for anything with no website on file, and rescoring on the real site. Fixes leads added
      // before discovery.ts/exclusions.ts existed. Never touches a won/lost/closed lead.
      const summary = await rescanAll(db);
      out(summary, renderRescanSummary(summary));
      break;
    }
    case "excluded": {
      const leads = excludedLeads(db);
      out(leads, leads.length ? leads.map((l) => `${line(l)}`).join("\n") : "No excluded leads on file.");
      break;
    }
    case "dedupe": {
      // Finds leads that are the same business — same discovered/tagged website domain, or same
      // phone — and folds the weaker record into the richer one (kept on file, never deleted;
      // see dedupe.ts / mergeLead in crm.ts).
      const results = mergeDuplicates(db, { by: flags.by });
      out(results, renderMergeResults(results));
      break;
    }
    case "watch": {
      const cfg = changeDetectionConfigFromEnv();
      if (!cfg) throw new Error("CHANGEDETECTION_API_KEY isn't set in ~/.config/agentic-os.env -- run scripts/windows/changedetection.ps1 and add the key first.");
      const sub = rest[0];
      if (sub === "sync") {
        const result = await syncWatches(db, cfg, ROOT);
        out(result, renderSyncResult(result));
      } else if (sub === "changes") {
        const result = await pollChanges(db, cfg, ROOT);
        if (result.changed.length) {
          // Quiet HUD-only nudge -- never spoken over budget, never a message to anyone.
          createJarvisEvents(ROOT).submit({
            source: "watch",
            text: `${result.changed.length} prospect site${result.changed.length === 1 ? "" : "s"} changed`,
            priority: "low",
          });
        }
        out(result, renderPollResult(result, (id) => findLead(db, id)));
      } else {
        throw new Error("Say `watch sync` or `watch changes`.");
      }
      break;
    }
    case "find-phone": {
      const lead = need(rest[0]);
      const finding = await findAndApply(db, lead, defaultFinderDeps(ROOT));
      const stored = readFinding(db, lead.id);
      const p = finding.phone;
      out(finding, [
        `#${lead.id} ${lead.name}: ${finding.outcome}${p ? ` — ${p.local}${p.kind === "mobile" ? " (mobile: may be a sole trader's personal number)" : ""}` : ""}` +
          `${finding.confidence != null ? ` (confidence ${finding.confidence.toFixed(2)})` : ""}`,
        `  ${finding.reason}`,
        stored && finding.phone ? `  ${describeSources(stored)}` : "",
        ...finding.sources.map((s) => `  - ${s.label}: ${s.url} (${s.method})`),
        finding.outcome === "suggested" ? "  Not written to the lead's phone — shown as a suggested number to verify." : "",
        finding.websiteFound ? `  Also found what looks like their website: ${finding.websiteFound} — queued for \`bun scripts/leads/reaudit.ts run\`.` : "",
      ].filter(Boolean).join("\n"));
      break;
    }
    case "phones": {
      const sub = rest[0] ?? "status";
      if (sub === "status") {
        const progress = loadProgress(ROOT);
        out(progress, `Phone finder: ${progress.processedIds.length}/${progress.total} processed — ${Object.entries(progress.counts).map(([k, v]) => `${k} ${v}`).join(", ")} (updated ${progress.updatedAt}).`);
      } else if (sub === "coverage") {
        const cov = coverageByPitch(db);
        out(cov, Object.entries(cov).map(([pitch, c]) => `  ${pitch.padEnd(14)} ${c.withPhone}/${c.total} with a phone · ${c.total - c.withPhone} without${c.suggested ? ` (${c.suggested} with a suggested number)` : ""}`).join("\n"));
      } else if (sub === "run") {
        db.close();
        const result = await runPhoneFinder({
          root: ROOT, pilot: flags.pilot ? Number(flags.pilot) : undefined, limit: flags.limit ? Number(flags.limit) : undefined,
        });
        console.log(`Done: ${result.processedIds.length}/${result.total} processed — ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
        return;
      } else throw new Error("Say `phones run`, `phones status` or `phones coverage`.");
      break;
    }
    case "issues": {
      const dryRun = flags["dry-run"] === "true";
      if (flags.batch === "true") {
        const result = await runIssuesBatch(db, { top: Number(flags.top ?? 50), dryRun, rank: { root: ROOT }, log: json ? undefined : (l) => console.log(l) });
        const md = renderTargetingReport(result, { crmPath: crmPath(ROOT) });
        const files = writeTargetingReport(ROOT, result, md);
        out({ ...files, leads: result.rows.length, applied: result.applied, costUsd: result.costUsd, dryRun },
          `${result.rows.length} lead(s) checked${dryRun ? " (dry run: CRM unchanged)" : `, ${result.applied} rescored`}; MiMo US$${result.costUsd.toFixed(4)}.\nReport: ${files.md}`);
        break;
      }
      const lead = need(rest[0]);
      const blocked = outreachBlocked(lead);
      const ranked = await rankWithMimo(await detectIssues(lead), lead, { root: ROOT });
      const report = ranked.report;
      const saved = !dryRun && !blocked && applyIssueReport(db, lead, report);
      out({ report, saved, blocked, mimo: ranked.skipped ?? "used" }, [
        `#${lead.id} ${lead.name} · ${report.status}${report.statusNote ? ` (${report.statusNote})` : ""}`,
        `Verdict: ${report.verdict} · score ${lead.score} -> ${report.score} · pitch ${lead.pitch} -> ${report.pitch}`,
        ...report.issues.map((i, n) => `  ${n + 1}. [sev ${i.severity}, ${i.offer}] ${i.finding}\n     evidence: ${i.evidence.url || "(listing)"} — ${i.evidence.seen}`),
        report.strengths.length ? `Already good: ${report.strengths.join(", ")}` : "",
        blocked ? `Not for outreach (${blocked}) — no opener.` : report.hook ? `Say: ${callOpener({ ...lead, hook: report.hook }, sender(flags.by))}  [hook: ${report.hookSource}]` : "",
        blocked ? "" : dryRun ? "(dry run — nothing saved)" : saved ? "Saved and rescored." : "",
      ].filter(Boolean).join("\n"));
      break;
    }
    default:
      console.log((await Bun.file(import.meta.path).text()).split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
  db.close();
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
