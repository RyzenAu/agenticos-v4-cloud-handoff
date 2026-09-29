// The owner's own M&U numbers for the Business brief and Goals pages, drawn from the sources the OS
// already has. Each source keeps its own access rules (the NAB ledger is owner-only, websites are
// local-only), fails on its own, and is shown with an honest state; nothing here invents a number.
//
//   M&U wiki          GET /__operator/business/wiki-facts   goals, $/month target, clients' deals
//   NAB CSV ledger    GET /__finance_manual/summary          cash in this month and last month
//   Stripe            GET /__operator/business/finance/stripe/summary (when configured)
//   CRM pipeline      useWorkspacePanel("pipeline")          open leads, proposals, clients by stage
//   CRM overview      GET /__operator/leads/overview         the day's sentence, money due from clients
//   Receptionist      useWorkspacePanel("receptionist")      verdict and this week's calls
//   Websites          GET /__websites/overview               client sites and their build checklist
//   Calendar          operator state events                   today's events
//   Business profile  GET /__operator/business               the saved revenue target and goals
import { useQuery } from "@tanstack/react-query";
import type { WikiFacts } from "../../scripts/business-wiki-facts";
import type { PipelinePanel, ReceptionistPanel, PanelResult } from "@/components/workspace/api";
import type { CalendarEvent } from "@/lib/operator";
import { operatorRequest } from "@/lib/operator";
import { websitesOverview, type OurSite, type WebsitesOverview } from "@/lib/websites";
import { fmtDay, fmtMoney, fmtMoneyCompact } from "./format";

export type { WikiFacts };

/** The honest state of one source, as a word the page shows. */
export type FactState = "live" | "stale" | "failed" | "setup-required" | "loading";
export type FactSource = {
  id: "wiki" | "nab" | "stripe" | "pipeline" | "overview" | "receptionist" | "websites" | "calendar" | "profile";
  label: string;
  state: FactState;
  /** One sentence: what was read, or why not. */
  detail: string;
  /** The one step that fixes a missing source. */
  fix?: { label: string; to: string };
};

/** The subset of the NAB summary this page reads (scripts/finance/manual-summary.ts ManualSummary). */
export type NabSummary = {
  period: { from: string | null; to: string | null; label: string };
  asOf: string | null;
  sourceLabel: string;
  stale: boolean;
  periodCoverage: "full" | "partial" | "none";
  coverageNote: string | null;
  cashInCents: number;
  rowCount: number;
  byScope: Record<"business" | "personal" | "unreviewed", { inCents: number; outCents: number; count: number }>;
};
export type StripeSummary = { configured: boolean; revenueThisMonthAud: number; mrrAud: number | null; lastSyncedAt: string | null };
export type OverviewTiles = {
  sentence: string;
  callsToday: number;
  tiles: {
    invoices: { count: number; cents: number; invoicedCount: number; label: string; source: string } | null;
    builds: { active: number; tasksDue: number };
  };
};

/** One query's outcome: data, an error message, or still loading. */
export type Read<T> = { data?: T | null; error?: string | null; loading?: boolean };

export type BriefInputs = {
  wiki: Read<WikiFacts>;
  nabThisMonth: Read<NabSummary>;
  nabLastMonth: Read<NabSummary>;
  stripe: Read<StripeSummary>;
  pipeline: Read<PanelResult<PipelinePanel>>;
  overview: Read<OverviewTiles>;
  receptionist: Read<PanelResult<ReceptionistPanel>>;
  websites: Read<WebsitesOverview>;
  events: CalendarEvent[] | null;
  profileTarget: number | null;
  now: number;
};

/** Stages at or after a win: a CRM lead here is a client. */
export const CLIENT_STAGES = ["won", "building", "QA", "launched", "care plan"] as const;

export type RevenueFact = {
  /** Business-marked NAB cash in this month (cents), plus Stripe revenue when Stripe is configured. Null = unknown. */
  thisMonthCents: number | null;
  /** NAB cash in this month not yet marked business or personal (cents). */
  unreviewedCents: number | null;
  lastMonthCents: number | null;
  stripeCents: number | null;
  /** Monthly target in dollars, and where it came from. */
  target: number | null;
  targetText: string | null;
  targetSource: "profile" | "wiki" | null;
  /** 0..1 of the target, capped at 1; null when either side is unknown. */
  ratio: number | null;
  /** "NAB CSV imported, as of 26 Sep 2026 · partial month" */
  basis: string | null;
  coverageNote: string | null;
  /** Why there's no number and the one step to get it. */
  empty: { why: string; step: string; to: string } | null;
};

export type ClientFact = {
  name: string;
  summary: string | null;
  deal: WikiFacts["clients"][number]["deal"] | null;
  site: { url: string; status: string | null; launchTarget: string | null; checklist: { done: number; total: number; next: string | null } | null } | null;
  source: string;
};

export type BriefModel = {
  revenue: RevenueFact;
  clients: ClientFact[];
  /** Leads in won-or-later CRM stages. Null = unknown. */
  crmClients: number | null;
  pipeline: {
    open: number | null;
    proposals: number | null;
    proposalsCents: number | null;
    followUpsOverdue: number | null;
    followUpsToday: number | null;
    newLeads7d: number | null;
    newLeads7dNote: string | null;
  } | null;
  /** The CRM's one-line summary of the day, when it answered. */
  sentence: string | null;
  owed: { cents: number; count: number; label: string } | null;
  receptionist: { decision: string; tone: string; callsWeek: number | null; gatesPassed: number; gatesTotal: number } | null;
  calendar: { today: number; next: { title: string; start: string; allDay: boolean } | null } | null;
  position: { text: string; source: string } | null;
  sources: FactSource[];
};

const sydneyDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

function stateOf<T>(r: Read<T>, stale = false): FactState {
  if (r.loading) return "loading";
  if (r.error || r.data === undefined || r.data === null) return "failed";
  return stale ? "stale" : "live";
}

function panelOf<T>(r: Read<PanelResult<T>>): { value: T | null; state: FactState; error: string | null } {
  if (r.loading) return { value: null, state: "loading", error: null };
  if (r.error) return { value: null, state: "failed", error: r.error };
  const d = r.data;
  if (!d) return { value: null, state: "failed", error: "No answer" };
  if (!d.ok) return { value: null, state: "failed", error: d.error };
  return { value: d.data, state: d.stale ? "stale" : "live", error: null };
}

/** Pure: everything the Business brief and Goals pages show from the owner's own data. */
export function deriveBrief(i: BriefInputs): BriefModel {
  const sources: FactSource[] = [];
  const wiki = i.wiki.data ?? null;

  // ── The M&U wiki ──
  if (i.wiki.loading) sources.push({ id: "wiki", label: "M&U wiki", state: "loading", detail: "Reading the M&U Ventures wiki…" });
  else if (!wiki) sources.push({ id: "wiki", label: "M&U wiki", state: "failed", detail: `The wiki facts couldn't be read${i.wiki.error ? ` (${i.wiki.error})` : ""}.` });
  else if (!wiki.found)
    sources.push({ id: "wiki", label: "M&U wiki", state: "setup-required", detail: `No wiki/ folder in the vault "${wiki.vault}". Goals, target and clients come from it.`, fix: { label: "Check the vault on Memory → Memory map", to: "/memory-map" } });
  else
    sources.push({
      id: "wiki",
      label: "M&U wiki",
      state: "live",
      detail: `${wiki.goals.length} shared goals, ${wiki.clients.length} ${wiki.clients.length === 1 ? "client" : "clients"}${wiki.revenueTarget ? `, target ${wiki.revenueTarget.text}` : ""} from "${wiki.vault}"${wiki.missing.length ? `. Missing: ${wiki.missing.join(", ")}` : ""}.`,
    });

  // ── Revenue towards the monthly target ──
  const nab = i.nabThisMonth.data ?? null;
  const nabLast = i.nabLastMonth.data ?? null;
  const stripe = i.stripe.data?.configured ? i.stripe.data : null;
  const target = i.profileTarget && i.profileTarget > 0 ? i.profileTarget : (wiki?.revenueTarget?.monthly ?? null);
  const targetSource = i.profileTarget && i.profileTarget > 0 ? "profile" : wiki?.revenueTarget ? "wiki" : null;
  const nabKnown = !!nab && nab.periodCoverage !== "none" && nab.rowCount > 0;
  const stripeCents = stripe ? Math.round(stripe.revenueThisMonthAud * 100) : null;
  const businessIn = nabKnown ? nab!.byScope.business.inCents : null;
  const thisMonthCents = businessIn === null && stripeCents === null ? null : (businessIn ?? 0) + (stripeCents ?? 0);
  let empty: RevenueFact["empty"] = null;
  if (thisMonthCents === null) {
    if (i.nabThisMonth.loading) empty = null;
    else if (i.nabThisMonth.error && /403|forbidden|not allowed/i.test(i.nabThisMonth.error))
      empty = { why: "The NAB ledger only opens for the owner on this PC.", step: "Open this page as the owner on the PC to see revenue.", to: "/finance" };
    else if (nab && nab.rowCount > 0 && nab.periodCoverage === "none")
      empty = { why: `The imported NAB CSV doesn't cover this month yet (${nab.sourceLabel}).`, step: "Import this month's NAB CSV on Finance → Import", to: "/finance" };
    else empty = { why: "No NAB CSV has been imported, so this month's revenue is unknown.", step: "Import a NAB CSV on Finance → Import", to: "/finance" };
  }
  const lastKnown = !!nabLast && nabLast.periodCoverage !== "none" && nabLast.rowCount > 0;
  const revenue: RevenueFact = {
    thisMonthCents,
    unreviewedCents: nabKnown ? nab!.byScope.unreviewed.inCents : null,
    lastMonthCents: lastKnown ? nabLast!.byScope.business.inCents : null,
    stripeCents,
    target,
    targetText: targetSource === "wiki" ? (wiki?.revenueTarget?.text ?? null) : target ? `$${target.toLocaleString("en-AU")}/month` : null,
    targetSource,
    ratio: thisMonthCents !== null && target ? Math.min(1, thisMonthCents / 100 / target) : null,
    basis: nabKnown ? `${nab!.sourceLabel}${nab!.periodCoverage === "partial" ? " · part of the month" : ""}${stripe ? " + Stripe" : ""}` : stripe ? "Stripe only (no NAB CSV for this month)" : null,
    coverageNote: nabKnown ? nab!.coverageNote : null,
    empty,
  };
  if (i.nabThisMonth.loading) sources.push({ id: "nab", label: "NAB CSV (Finance)", state: "loading", detail: "Reading the imported NAB ledger…" });
  else if (!nab)
    sources.push({ id: "nab", label: "NAB CSV (Finance)", state: "failed", detail: `The NAB ledger couldn't be read${i.nabThisMonth.error ? ` (${i.nabThisMonth.error})` : ""}.`, fix: { label: "Open Finance", to: "/finance" } });
  else if (nab.rowCount === 0) sources.push({ id: "nab", label: "NAB CSV (Finance)", state: "setup-required", detail: "No NAB CSV imported yet.", fix: { label: "Import a NAB CSV on Finance → Import", to: "/finance" } });
  else sources.push({ id: "nab", label: "NAB CSV (Finance)", state: nab.stale ? "stale" : "live", detail: `${nab.sourceLabel}. ${nab.periodCoverage === "none" ? "Doesn't cover this month." : nab.coverageNote ?? "Covers this month."}`, fix: nab.stale || nab.periodCoverage !== "full" ? { label: "Import a newer NAB CSV", to: "/finance" } : undefined });
  if (i.stripe.loading) sources.push({ id: "stripe", label: "Stripe", state: "loading", detail: "Checking Stripe…" });
  else if (!i.stripe.data) sources.push({ id: "stripe", label: "Stripe", state: "failed", detail: `Stripe couldn't be read${i.stripe.error ? ` (${i.stripe.error})` : ""}.` });
  else if (!i.stripe.data.configured) sources.push({ id: "stripe", label: "Stripe", state: "setup-required", detail: "Not connected, so card payments aren't counted.", fix: { label: "Connect Stripe on Finance → Finances", to: "/business?view=finance" } });
  else sources.push({ id: "stripe", label: "Stripe", state: "live", detail: `Revenue this month counted${i.stripe.data.lastSyncedAt ? `, synced ${fmtDay(new Date(i.stripe.data.lastSyncedAt), { year: true })}` : ""}.` });

  // ── CRM ──
  const pipe = panelOf(i.pipeline);
  const p = pipe.value;
  const crmClients = p ? p.stages.filter((s) => (CLIENT_STAGES as readonly string[]).includes(s.stage)).reduce((n, s) => n + s.count, 0) : null;
  sources.push({
    id: "pipeline",
    label: "Leads CRM",
    state: pipe.state,
    detail: p ? `${p.open ?? "?"} open of ${p.total ?? "?"} records · ${crmClients} in won-or-later stages.` : pipe.state === "loading" ? "Reading the CRM…" : `The CRM pipeline couldn't be read${pipe.error ? ` (${pipe.error})` : ""}.`,
    fix: pipe.state === "failed" ? { label: "Open Leads", to: "/leads" } : undefined,
  });
  const ov = i.overview.data ?? null;
  const owed = ov?.tiles.invoices && ov.tiles.invoices.count > 0 ? { cents: ov.tiles.invoices.cents, count: ov.tiles.invoices.count, label: ov.tiles.invoices.label } : null;

  // ── Receptionist ──
  const rxp = panelOf(i.receptionist);
  const rx = rxp.value;
  sources.push({ id: "receptionist", label: "Receptionist", state: rxp.state, detail: rx ? `${rx.verdict.decision} · ${rx.gatesPassed} of ${rx.gates.length} go-live gates.` : rxp.state === "loading" ? "Reading the receptionist…" : `The receptionist status couldn't be read${rxp.error ? ` (${rxp.error})` : ""}.` });

  // ── Websites ──
  const sites = i.websites.data?.sites ?? null;
  sources.push({
    id: "websites",
    label: "Websites",
    state: stateOf(i.websites),
    detail: sites ? `${sites.filter((s) => s.kind === "client").length} client ${sites.filter((s) => s.kind === "client").length === 1 ? "site" : "sites"}, ${sites.filter((s) => s.kind === "flagship").length} flagships in the catalogue.` : i.websites.loading ? "Reading the websites catalogue…" : `The websites catalogue couldn't be read${i.websites.error ? ` (${i.websites.error})` : ""}.`,
  });

  // ── Clients: the wiki's real clients, matched to their site in the catalogue ──
  const clientSites = (sites ?? []).filter((s) => s.kind === "client");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const siteFor = (name: string, slug: string): OurSite | undefined =>
    clientSites.find((s) => norm(s.name).includes(norm(name).slice(0, 8)) || norm(slug).includes(norm(s.id)) || norm(s.id).includes(norm(slug).slice(0, 6)));
  const siteView = (s: OurSite | undefined): ClientFact["site"] =>
    s ? { url: s.url, status: s.brief?.status ?? null, launchTarget: s.brief?.launchTarget ?? null, checklist: s.brief?.checklist && s.brief.checklist.total > 0 ? s.brief.checklist : null } : null;
  const clients: ClientFact[] = (wiki?.clients ?? []).map((c) => ({ name: c.name, summary: c.summary, deal: c.deal, site: siteView(siteFor(c.name, c.slug)), source: c.source.page }));
  // A client site in the catalogue that the wiki doesn't list is still a client.
  for (const s of clientSites) if (!clients.some((c) => c.site?.url === s.url)) clients.push({ name: s.name, summary: null, deal: null, site: siteView(s), source: "Websites catalogue" });

  // ── Calendar ──
  let calendar: BriefModel["calendar"] = null;
  if (i.events) {
    const day = sydneyDay(i.now);
    const todays = i.events.filter((e) => sydneyDay(Date.parse(e.start)) === day || (e.allDay && e.start.slice(0, 10) === day));
    const upcoming = todays.filter((e) => e.allDay || Date.parse(e.end || e.start) >= i.now).sort((a, b) => a.start.localeCompare(b.start));
    calendar = { today: todays.length, next: upcoming[0] ? { title: upcoming[0].title, start: upcoming[0].start, allDay: upcoming[0].allDay } : null };
    sources.push({ id: "calendar", label: "Calendar", state: "live", detail: i.events.length ? `${todays.length} ${todays.length === 1 ? "event" : "events"} today from ${i.events.length} saved.` : "No events saved yet.", fix: i.events.length ? undefined : { label: "Connect a calendar on Today → Calendar", to: "/calendar" } });
  } else sources.push({ id: "calendar", label: "Calendar", state: "loading", detail: "Reading the calendar…" });

  sources.push({
    id: "profile",
    label: "Revenue target",
    state: target ? "live" : "setup-required",
    detail: targetSource === "profile" ? `$${target!.toLocaleString("en-AU")}/month, saved in your business profile.` : targetSource === "wiki" ? `${wiki!.revenueTarget!.text} from ${wiki!.revenueTarget!.source.page} (not saved in your profile).` : "No monthly target saved or found in the wiki.",
  });

  return {
    revenue,
    clients,
    crmClients,
    pipeline: p ? { open: p.open, proposals: p.proposals.count, proposalsCents: p.proposals.valueCents, followUpsOverdue: p.followUps.overdue, followUpsToday: p.followUps.dueToday, newLeads7d: p.newLeads7d, newLeads7dNote: p.newLeads7dNote ?? null } : null,
    sentence: ov?.sentence ?? null,
    owed,
    receptionist: rx ? { decision: rx.verdict.decision, tone: rx.verdict.tone, callsWeek: rx.calls.ok ? rx.calls.week.count : null, gatesPassed: rx.gatesPassed, gatesTotal: rx.gates.length } : null,
    calendar,
    position: wiki?.business?.position ? { text: wiki.business.position, source: wiki.business.source.page } : null,
    sources,
  };
}

/** "A$12,400" for cents; whole dollars. */
export function audWhole(cents: number) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${fmtMoney(Math.abs(cents) / 100, { whole: true })}`;
}
/** "A$100k" for 100000 dollars. */
export function dollarsShort(n: number) {
  return fmtMoneyCompact(n, { compactFrom: 1000 });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : e ? String(e) : null);
function asRead<T>(q: { data?: T; error: unknown; isLoading: boolean }): Read<T> {
  return { data: q.data, error: errMsg(q.error), loading: q.isLoading };
}

export async function nabSummary(period: string): Promise<NabSummary> {
  const res = await fetch(`/__finance_manual/summary?period=${encodeURIComponent(period)}`, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${typeof body?.error === "string" ? body.error : "Request failed"}`);
  return body as NabSummary;
}

/** The NAB ledger summary for a period (owner-only on the server; a 403 is an error, never zero). */
export function useNabSummary(period: "this-month" | "last-month") {
  return useQuery<NabSummary>({ queryKey: ["business-facts", "nab", period], queryFn: () => nabSummary(period), staleTime: 60_000, retry: false, refetchOnWindowFocus: false });
}

/** Client hook: the queries this page adds (the CRM and receptionist panels come from useWorkspacePanel). */
export function useBusinessFactQueries() {
  const opts = { staleTime: 60_000, retry: false as const, refetchOnWindowFocus: false };
  const wiki = useQuery<WikiFacts>({ queryKey: ["business-facts", "wiki"], queryFn: () => operatorRequest("/business/wiki-facts"), ...opts });
  const nabThisMonth = useNabSummary("this-month");
  const nabLastMonth = useQuery<NabSummary>({ queryKey: ["business-facts", "nab", "last-month"], queryFn: () => nabSummary("last-month"), ...opts });
  // Same keys as the Finances tab, so both share one read.
  const stripe = useQuery<StripeSummary>({ queryKey: ["business-finance-stripe-summary"], queryFn: () => operatorRequest("/business/finance/stripe/summary"), ...opts });
  const overview = useQuery<OverviewTiles>({ queryKey: ["business-facts", "leads-overview"], queryFn: () => operatorRequest("/leads/overview", undefined, "GET"), ...opts });
  const websites = useQuery<WebsitesOverview>({ queryKey: ["websites-overview"], queryFn: websitesOverview, ...opts });
  return {
    wiki: asRead(wiki),
    nabThisMonth: asRead(nabThisMonth),
    nabLastMonth: asRead(nabLastMonth),
    stripe: asRead(stripe),
    overview: asRead(overview),
    websites: asRead(websites),
  };
}
