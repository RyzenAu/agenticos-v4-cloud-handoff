// Shared client types and helpers for the Leads CRM (page, drawer, dashboard card). Mirrors
// scripts/leads/crm.ts + api.ts and scripts/lead-sites/registry.ts. Nothing here sends anything:
// phones are tel: links or copied text, and previews deploy only through the drawer's confirm.
import { useCallback, useEffect, useRef, useState } from "react";
import { operatorRequest } from "@/lib/operator";
import type { Tone } from "@/components/ds";
import { fmtDay } from "./format";

export const STATUSES = [
  "new", "to_call", "no_answer", "voicemail", "call_back", "emailed", "interested",
  "meeting", "proposal", "won", "lost", "not_interested", "do_not_contact",
] as const;
export type LeadStatus = (typeof STATUSES)[number];
export const VERTICALS = ["dental", "real-estate", "legal"] as const;
export type Vertical = (typeof VERTICALS)[number];
export const OWNERS = ["usman", "mehroz"] as const;
export type Owner = (typeof OWNERS)[number];

export type Lead = {
  /** Optimistic revision of the stored fields, not hydrated Places content. */
  editVersion?: string;
  id: number;
  vertical: Vertical;
  area: string;
  name: string;
  phone: string;
  address: string;
  website: string;
  mapsUrl: string;
  emails: string[];
  emailOk: boolean;
  score: number;
  pitch: string;
  reasons: string[];
  /** Per reason: directly observed on the business's own site (api.ts withVerified). */
  verified?: boolean[];
  status: LeadStatus;
  owner: string;
  nextAt: string | null;
  lastContactAt: string | null;
  createdAt: string;
  source?: string;
  attribution?: string;
  excluded?: boolean;
  excludedReason?: string;
  websiteSource?: string;
  websiteCheckedAt?: string | null;
  /** What the last website check established (written by the server where the result is known): see scripts/leads/crm.ts. */
  websiteCheck?: "found" | "none-verified" | "check-failed" | "search-unavailable" | "not-checked";
  /** '' (directory/unknown) or 'found_…' when scripts/leads/phone-finder.ts found the phone. */
  phoneSource?: string;
  phoneConfidence?: number | null;
  phoneCheckedAt?: string | null;
  /** A weaker phone-finder result: shown to verify, never dialled from here. */
  suggestedPhone?: string;
  /** Google-sourced lead (scripts/leads/places-live.ts): the CRM stores only its place ID; these
   *  display fields were fetched live for this response and must be shown with `attribution`. */
  placesLive?: { attribution: string; fetchedAt: string | null; fields: string[]; hours: string[]; businessStatus: string; error?: string };
};
export type PhoneFinding = {
  outcome: string;
  display: string;
  kind: string;
  confidence: number | null;
  agreeing: number;
  sources: { url: string; label: string; method: string }[];
  reason: string;
  checkedAt: string;
  websiteFound: string;
  summary: string;
};
export type Activity = { id: number; leadId: number; at: string; kind: string; outcome: string; note: string; by: string };
export type DayReport = { date: string; who: string | null; target: number; calls: number; meetings: number; outcomes: Record<string, number>; followUpsDue: Lead[] };
export type Hunt = {
  status: "ok" | "partial" | "failed" | "never";
  ranAt: string | null;
  area: string | null;
  added: number;
  errors: string[];
  problem?: string;
  ownerAction?: string;
  failingSince?: string | null;
  overdue: boolean;
};
export type Summary = {
  pipeline: Record<string, number>;
  placesUsage: { used: number; budget: number };
  hunt?: Hunt;
  callWindow: { open: boolean; why: string };
  today: { usman: DayReport; mehroz: DayReport };
};
export type CallLead = Lead & { opener: string; scriptReady?: boolean; topIssues?: LeadIssue[] };

/** One evidenced issue from scripts/leads/issues.ts: what was found and the page it was seen on. */
export type LeadIssue = { code: string; finding: string; severity: 1 | 2 | 3; offer: "redesign" | "receptionist" | "both"; url: string; seen: string; source: "site" | "directory" };
export type LeadIssues = { checkedAt: string; status: string; statusNote: string; hook: string; top: LeadIssue[] };

export type CallScript = {
  leadId: number;
  generatedAt: string;
  model: string;
  pitch: string;
  opener: string;
  discovery: string[];
  valuePitch: string;
  objections: Record<"price" | "already_have_website" | "send_email" | "not_now" | "ask_partner", string>;
  close: string;
  followupEmail: { subject: string; body: string };
  compliance: {
    callWindow: { open: boolean; why: string };
    dncReminder: string;
    noInventedClaims: string;
  };
};

export type SeoFinding = { id: string; severity: string; priority: string; category: string; title: string; evidence: string };
export type SeoAuditRecord = {
  leadId: number;
  domain: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
  overall: number | null;
  grade: string | null;
  topFindings: SeoFinding[];
  costUsd: number | null;
  files: { pdf: boolean; xlsx: boolean; md: boolean; json: boolean };
};

/** /__seo-audit-files (scripts/leads/seo-audit-files-plugin.ts): opens a finished report in a new tab. */
export function seoAuditFileHref(leadId: number, kind: "pdf" | "xlsx" | "md"): string {
  return `/__seo-audit-files?id=${leadId}&kind=${kind}`;
}

export const OBJECTION_LABEL: Record<keyof CallScript["objections"], string> = {
  price: "“That's too expensive”",
  already_have_website: "“We already have a website”",
  send_email: "“Just send me an email”",
  not_now: "“Not right now”",
  ask_partner: "“I need to ask my partner”",
};

export type PreviewStatus = "generated" | "deploying" | "live" | "taken_down" | "failed";
export type Preview = {
  leadId: number;
  business: string;
  vertical: string;
  slug: string;
  domain: string;
  url: string;
  project: string;
  dir: string;
  status: PreviewStatus;
  generatedAt: string;
  deployedAt: string | null;
  deployedBy: string | null;
  expiresAt: string | null;
  takenDownAt: string | null;
  verified: { at: string; status: number; banner: boolean; noindexHeader: boolean } | null;
  lastError: string | null;
  serviceCount: number;
  missing: string[];
  daysLeft: number | null;
  expired: boolean;
  thumb?: { exists: boolean; at: string | null };
  /** http://<slug>.localhost:8091/ — the local copy at the root of its own origin. */
  localUrl?: string;
};
export type LeadSitesStatus = {
  previews: Preview[];
  templates: Record<string, string | null>;
  thumbs: Record<string, string | null>;
  previewServer?: { port: number; listening: boolean; error: string | null } | null;
  /** The Serve port a remote founder's previews open on (scripts/lead-sites/preview-origin.ts). */
  previewOrigin?: { port: number } | null;
};

/** Where a generated preview opens locally: the root of its own origin (scripts/lead-sites/preview-server.ts). */
export const PREVIEW_PORT = 8091;
/** The hub's second Tailscale Serve port for previews (scripts/lead-sites/preview-origin.ts); /status can override it. */
export const PREVIEW_ORIGIN_PORT = 8445;
let previewOriginPort = PREVIEW_ORIGIN_PORT;

/** How this page was reached: only its host name matters (loopback = the hub's own PC, anything else = Tailscale). */
export type PageReach = { hostname: string };
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|[a-z0-9-]+\.localhost)$/i;
const LOCAL_PREVIEW = /^http:\/\/([a-z0-9-]+)\.localhost(?::\d+)?\/?$/i;

/**
 * The link for a preview, from how the page was reached. On the hub's own loopback it is the local copy
 * (`<name>.localhost:8091`, which only means anything on that PC); from any other origin it is the hub's
 * authenticated preview origin on the same host (a second Serve port), entered through
 * /_mu-preview/open/<name>. A URL that isn't a `*.localhost` preview is returned untouched.
 */
export function previewHrefFor(localUrl: string, reach: PageReach | null, remotePort = previewOriginPort): string {
  const m = LOCAL_PREVIEW.exec(localUrl);
  if (!m || !reach?.hostname || LOOPBACK_HOST.test(reach.hostname)) return localUrl;
  return `https://${reach.hostname}:${remotePort}/_mu-preview/open/${m[1].toLowerCase()}`;
}
const currentReach = (): PageReach | null => (typeof location === "undefined" ? null : { hostname: location.hostname });

export function localPreviewHref(preview: Pick<Preview, "slug" | "localUrl">): string {
  return previewHrefFor(preview.localUrl ?? `http://${preview.slug}.localhost:${PREVIEW_PORT}/`, currentReach());
}
/** Any local preview URL (a lead preview, a template, a draft) as the current page can open it. */
export const reachablePreviewUrl = (localUrl: string): string => previewHrefFor(localUrl, currentReach());

export const VERTICAL_LABEL: Record<Vertical, string> = { dental: "Dental", "real-estate": "Real estate", legal: "Legal" };
export const statusLabel = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The pitches a founder actually talks about ("offer"), plus the two honesty states a lead sits in
 *  before it has one ("state": its website isn't verified, or its audit hasn't run). */
export const PITCHES: { key: string; label: string; tone: Tone; kind: "offer" | "state" }[] = [
  { key: "redesign", label: "Redesign", tone: "accent", kind: "offer" },
  { key: "receptionist", label: "Receptionist", tone: "info", kind: "offer" },
  { key: "both", label: "Site + receptionist", tone: "accent", kind: "offer" },
  { key: "website", label: "Website not verified", tone: "warn", kind: "state" },
  { key: "audit_pending", label: "Audit pending", tone: "neutral", kind: "state" },
];
/** Pitch filter options: the offers first, then the honesty states (no pitch yet: the website isn't
 *  verified or the audit hasn't run), labelled so they don't read as offers (audit F1-29). */
export function pitchFilterOptions(): { value: string; label: string }[] {
  return [
    ...PITCHES.filter((p) => p.kind === "offer").map((p) => ({ value: p.key, label: p.label })),
    ...PITCHES.filter((p) => p.kind === "state").map((p) => ({ value: p.key, label: `No pitch yet · ${p.label}` })),
  ];
}

export function pitchInfo(pitch: string) {
  return PITCHES.find((p) => p.key === pitch) ?? { key: pitch, label: pitch ? statusLabel(pitch) : "Not scored", tone: "neutral" as Tone };
}

export function statusTone(s: string): Tone {
  if (s === "won") return "success";
  if (s === "interested" || s === "meeting" || s === "proposal") return "accent";
  if (s === "call_back") return "warn";
  if (s === "lost" || s === "not_interested" || s === "do_not_contact") return "danger";
  return "neutral";
}

const CLOSED = new Set(["won", "lost", "not_interested", "do_not_contact"]);

/** The one next thing to do with this lead, and whether it's overdue. */
export function nextAction(lead: Lead, now = Date.now()): { text: string; overdue: boolean } {
  if (lead.excluded) return { text: "Excluded", overdue: false };
  if (lead.status === "won") return { text: "Kick-off", overdue: false };
  if (CLOSED.has(lead.status)) return { text: "—", overdue: false };
  if (lead.nextAt) {
    const due = Date.parse(lead.nextAt);
    const when = fmtDay(new Date(due), { weekday: true });
    return { text: `${lead.status === "call_back" ? "Call back" : "Follow up"} ${when}`, overdue: due < now };
  }
  if (lead.status === "interested") return { text: "Book a meeting", overdue: false };
  if (lead.status === "meeting") return { text: "Send a proposal", overdue: false };
  if (lead.status === "proposal") return { text: "Chase the proposal", overdue: false };
  if (lead.phone) return { text: lead.lastContactAt ? "Call again" : "First call", overdue: false };
  if (lead.emails.length && lead.emailOk) return { text: "Email draft", overdue: false };
  return { text: "Find a phone number", overdue: false };
}

/** Reasons with their verified flag (falls back to "not verified" for an older API). A reason
 *  rewritten to "Website not verified" is no longer the fact that was verified, so it loses its
 *  [verified] chip rather than contradicting itself (audit F1-26). */
export function taggedReasons(lead: Lead): { text: string; verified: boolean }[] {
  return lead.reasons.map((raw, i) => {
    const text = raw.replace(/no website(?: found)?/gi, "Website not verified");
    return { text, verified: text === raw && !!lead.verified?.[i] };
  });
}

export function suburbOf(area: string) {
  return area.replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s*\d{0,4}$/i, "").trim() || area;
}

export function siteHost(url: string) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function siteHref(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Copy to clipboard with a short-lived "copied" state per key. */
export function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((key: string, text: string) => {
    const done = () => {
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1600);
    };
    try {
      void navigator.clipboard.writeText(text).then(done, done);
    } catch {
      done();
    }
  }, []);
  return [copied, copy];
}

const BY_KEY = "claude-os.leads-by.v1";
export function useOwner(): [Owner, (o: Owner) => void] {
  const [by, setBy] = useState<Owner>("usman");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BY_KEY);
      if (saved === "usman" || saved === "mehroz") setBy(saved);
    } catch { /* default stands */ }
  }, []);
  const update = (o: Owner) => {
    setBy(o);
    try { localStorage.setItem(BY_KEY, o); } catch { /* not persisted this session */ }
  };
  return [by, update];
}

// ── /__lead-sites (scripts/lead-sites/plugin.ts): the owner at the hub, or a founder signed in over Tailscale ──

export async function leadSitesStatus(ids: number[] = []): Promise<LeadSitesStatus> {
  const res = await fetch(`/__lead-sites/status${ids.length ? `?ids=${ids.join(",")}` : ""}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (Number.isInteger(data?.previewOrigin?.port)) previewOriginPort = data.previewOrigin.port;
  return data;
}

/** The same POST, but an HTTP status is an answer, not an exception: the approval flow needs the 202 and the 409s as they are. */
export async function leadSitesPostRaw(path: "/generate" | "/deploy" | "/takedown" | "/thumb", body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const token = (await (await fetch("/__token")).json()).token;
  const res = await fetch(`/__lead-sites${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export async function leadSitesPost<T = any>(path: "/generate" | "/deploy" | "/takedown" | "/thumb", body: Record<string, unknown>): Promise<T> {
  const { status, json } = await leadSitesPostRaw(path, body);
  if (status < 200 || status >= 300) throw new Error(json?.error || `Request failed (${status})`);
  return json as T;
}

/**
 * A deploy that answered 200 but whose preview isn't live and checked is a failure, not a success (the pc-role drawer always
 * said so). Applied to the direct answer and to the run after an approval alike. Pure.
 */
export function deployReply(reply: { status: number; json: any }): { status: number; json: any } {
  const p = reply.json?.preview;
  if (reply.status === 200 && p && (p.status !== "live" || p.lastError)) return { status: 400, json: { error: p.lastError || "The public preview hasn't passed its live check yet.", outcome: reply.json?.outcome } };
  return reply;
}

export const leadsApi = {
  summary: () => operatorRequest<Summary>("/leads/summary", undefined, "GET"),
  /** `due` = call-backs and follow-ups due today or overdue (src/lib/call-queue.ts isCallDue); `leads` = the call sheet. */
  calls: (n: number) => operatorRequest<{ callWindow: Summary["callWindow"]; due?: number; leads: CallLead[] }>(`/leads/calls?n=${n}`, undefined, "GET"),
  list: (all: boolean) => operatorRequest<{ leads: Lead[] }>(`/leads/list${all ? "?all=1" : ""}`, undefined, "GET"),
  detail: (id: number) => operatorRequest<{ lead: Lead; activities: Activity[]; phoneFinding?: PhoneFinding | null; pipeline: { stage: string; evidence: string; nextAction: string; owner: string; closed: boolean }; drafts: string[]; issues?: LeadIssues | null; deal?: LeadDeal }>(`/leads/detail?id=${id}`, undefined, "GET"),
  edit: (id: number, patch: Partial<Pick<Lead, "name" | "phone" | "emails" | "address" | "website" | "area" | "vertical" | "owner" | "status" | "nextAt">> & { version: string; by: Owner }) => operatorRequest<{ lead: Lead }>("/leads/edit", { lead: id, ...patch }, "POST"),
  /** Every lead with its deal row (stage, days in stage, stuck flag, value, issues). */
  board: (all: boolean) => operatorRequest<{ leads: BoardLead[] }>(`/leads/list?deals=1${all ? "&all=1" : ""}`, undefined, "GET"),
  overview: () => operatorRequest<CrmOverview>("/leads/overview", undefined, "GET"),
  saveDeal: (id: number, patch: DealPatch & { by: Owner }) => operatorRequest<{ deal: LeadDeal }>("/leads/deal", { lead: id, ...patch }, "POST"),
  move: (id: number, body: { to: MoveTarget; by: Owner; note?: string; kind?: "call" | "email"; scope?: string }) =>
    operatorRequest<{ lead: Lead; pipeline: { stage: Stage } }>("/leads/move", { lead: id, ...body }, "POST"),
  rules: () => operatorRequest<DealRules>("/leads/rules", undefined, "GET"),
  saveRules: (patch: { probability?: Partial<Record<Stage, number>>; stuckDays?: Partial<Record<Stage, number | null>> }) => operatorRequest<DealRules>("/leads/rules", patch, "POST"),
  search: (q: string) => operatorRequest<{ query: string; hits: SearchHit[] }>(`/leads/search?q=${encodeURIComponent(q)}`, undefined, "GET"),
  findPhone: (id: number) => operatorRequest<{ outcome: string; reason: string; lead: Lead; phoneFinding: PhoneFinding | null }>("/leads/find-phone", { lead: id }, "POST"),
  script: (id: number) => operatorRequest<{ script: CallScript | null }>(`/leads/script?id=${id}`, undefined, "GET"),
  generateScript: (id: number) => operatorRequest<{ script: CallScript }>("/leads/generate-script", { lead: id }, "POST"),
  seoAuditStatus: (id: number) => operatorRequest<{ audit: SeoAuditRecord | null }>(`/leads/seo-audit?id=${id}`, undefined, "GET"),
  runSeoAudit: (id: number) => operatorRequest<{ audit: SeoAuditRecord }>("/leads/seo-audit", { lead: id }, "POST"),
};

// ── deals, stages and the morning overview (scripts/leads/deals.ts) ──

export const STAGES = ["found", "verified", "scored", "audited", "preview", "contacted", "replied", "meeting", "proposal", "won", "building", "QA", "launched", "care plan"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  found: "Found", verified: "Verified", scored: "Scored", audited: "Audited", preview: "Preview", contacted: "Contacted",
  replied: "Replied", meeting: "Meeting", proposal: "Proposal", won: "Won", building: "Building", QA: "QA", launched: "Launched", "care plan": "Care plan",
};
export const MOVE_TARGETS = ["contacted", "replied", "meeting", "proposal", "won", "lost"] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];
export type Offer = "website" | "redesign" | "receptionist" | "both";
export const OFFER_LABEL: Record<Offer, string> = { website: "Website", redesign: "Website redesign", receptionist: "AI receptionist", both: "Website + AI receptionist" };

export type Stuck = { thresholdDays: number; days: number; action: string };
export type DealEconomics = {
  offer: Offer; offerLabel: string;
  /** Catalogue receptionist package priced (null for website-only offers) and its price status. */
  packageId: string | null; priceStatus: "proposed" | "approved" | null;
  /** All ex GST; valueInclGstCents adds 10% GST. */
  setupCents: number; monthlyCents: number; valueCents: number; valueInclGstCents: number; gstBasis: "ex GST"; valueSource: string;
  /** Website build ex GST; the receptionist setup fee with its own approval (counted only when approved). */
  websiteCents: number; receptionistSetup: { cents: number; status: "proposed" | "approved" } | null;
  /** "assumed" = no package chosen (entry tier used for the estimate); "unknown" = a stored id not in the catalogue. */
  packageState: { state: "chosen" | "assumed" | "unknown"; note: string } | null;
  probability: number; probabilitySource: "stage default" | "custom" | "closed"; weightedCents: number; expectedClose: string | null;
};
export type DealRow = {
  stage: Stage; closed: boolean; evidence: string; nextAction: string; owner: string;
  stageSince: string | null; daysInStage: number | null; daysInferred: boolean; stuck: Stuck | null;
  economics: DealEconomics; contactPref: string; websiteStatus?: string;
  issues: { code: string; finding: string; severity: number; url?: string }[];
};
export type BoardLead = Lead & { deal: DealRow };
export type StageEntry = { stage: Stage; at: string | null; evidence: string; inferred: boolean };
export type DealRecord = { offer: Offer | null; packageId: string | null; packageUnknown?: string | null; setupCents: number | null; monthlyCents: number | null; probability: number | null; expectedClose: string | null; contactPref: string; updatedBy: string; updatedAt: string | null };
export type LeadDeal = DealRow & { timeline: StageEntry[]; record: DealRecord; stageProbability: number; stuckDays: number | null; monthsCounted: number };
export type DealPatch = { offer?: Offer | null; packageId?: string | null; setupCents?: number | null; monthlyCents?: number | null; probability?: number | null; expectedClose?: string | null; contactPref?: string };
export type DealRules = { probability: Record<Stage, number>; stuckDays: Partial<Record<Stage, number>>; monthsCounted: number };
export type TodoItem = { kind: "call" | "follow-up" | "build task"; leadId: number; name: string; detail: string; dueAt: string | null; overdue: boolean; phone: string; contactPref: string };
export type UpcomingItem = { kind: "meeting" | "call back" | "follow-up" | "milestone"; leadId: number; name: string; at: string; detail: string };
export type CrmOverview = {
  generatedAt: string;
  date: string;
  sentence: string;
  tiles: {
    /** count is null (with a note) while the CRM is too new to tell new leads from its first load. */
    newLeads: { count: number | null; days: number; note?: string | null };
    pipeline: { count: number; valueCents: number; weightedCents: number; stages: Stage[] };
    stuck: { count: number };
    followUps: { overdue: number; dueToday: number };
    proposals: { count: number; valueCents: number };
    builds: { active: number; tasksDue: number };
    /** Money owed from the hand-kept client record; `label` says what it is (e.g. due at launch, not invoiced). */
    invoices: { count: number; cents: number; source: string; invoicedCount?: number; label?: string };
    /** Net operating cash this month from the NAB CSV ledger: cash flow, not margin (null: nothing imported). */
    netCash: { month: string; inCents: number | null; outCents: number | null; netCents: number | null; coverage: "full" | "partial" | "none"; coverageNote: string | null; statement: string; asOf: string | null } | null;
  };
  callsToday: number;
  callWindow?: { open: boolean; why: string };
  todo: TodoItem[];
  upcoming: UpcomingItem[];
  stuck: ({ leadId: number; name: string; stage: Stage } & Stuck)[];
};
export type SearchHit = { group: "leads" | "contacts" | "proposals" | "clients"; leadId: number; title: string; detail: string };

/** 165000 → "A$1,650"; cents kept only when there are any. */
export function aud(cents: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 10_000) return `A$${new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 }).format(dollars)}`;
  const whole = Number.isInteger(dollars);
  return `${dollars < 0 ? "−" : ""}A$${new Intl.NumberFormat("en-AU", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(Math.abs(dollars))}`;
}
