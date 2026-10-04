// Pending OWNER approvals for the Workspace "Today" panel.
//
// Two sources, merged:
//   1. scripts/workspace/approvals.json — a small hand-kept list of decisions only the owner can
//      make (seeded 27 Sep 2026 from the Operations delivery checks and the day's handoffs).
//      Edit the file to add or close one; nothing here writes it. Close an item with
//      `"status": "done"`, or record the owner's answer with `"status": "decided"` plus
//      `decision` and `decidedOn`. A pending item never lives forever (UI-truth M6): it expires on
//      its `expires` date, or MAX_PENDING_DAYS after `since`, and then leaves the waiting count and
//      is named as expired so it gets closed or renewed.
//   2. Live receptionist readiness — each gate that is waiting for the owner's sign-off.
//
// Metadata only: titles, one-line details and internal links. The validator refuses anything that
// looks like an email address or a phone number, so a caller's or client's contact details can
// never ride along in this file.

export const APPROVAL_AREAS = ["receptionist", "websites", "sales", "email", "offers", "finance", "operations"] as const;
export type ApprovalArea = (typeof APPROVAL_AREAS)[number];

export type Approval = {
  id: string;
  title: string;
  area: ApprovalArea;
  /** One plain line: what the decision is and what it unblocks. */
  detail: string;
  /** Internal route ("/receptionist") or an https link the owner opens himself. */
  href: string;
  /** YYYY-MM-DD the item was raised; null for live-derived items. */
  since: string | null;
  /** Where the item comes from, e.g. "Operations delivery checks", "receptionist readiness (live)". */
  source: string;
  /** Live progress where one exists, e.g. "0 of 5 owner retest calls". */
  progress?: string;
  /** File-backed business decision; live readiness gates use their own evidence controls. */
  recordable?: boolean;
  revision?: string;
};

export type ApprovalsFile = {
  version: 1;
  items: (Approval & { status: "pending" | "done" | "decided"; decision?: string; decidedOn?: string; expires?: string })[];
};

/** A pending item with no `expires` date stops counting as waiting this many days after `since`. */
export const MAX_PENDING_DAYS = 14;
export type ExpiredApproval = { id: string; title: string; expiredOn: string };

/** YYYY-MM-DD in Sydney, the owner's calendar day. */
export function sydneyDay(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]*){8,}/;

function text(value: unknown, field: string, max: number, errors: string[], at: string): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${at}: ${field} is required`);
    return null;
  }
  const v = value.trim();
  if (v.length > max) {
    errors.push(`${at}: ${field} is longer than ${max} characters`);
    return null;
  }
  if (EMAIL.test(v) || PHONE.test(v)) {
    errors.push(`${at}: ${field} looks like it holds contact details (email or phone) — keep those out`);
    return null;
  }
  return v;
}

/** Validates the approvals file. Bad items are skipped and named in `errors`; good ones survive. */
export function validateApprovals(
  raw: unknown,
  now: number = Date.now(),
): { items: Approval[]; done: number; decided: number; expired: ExpiredApproval[]; errors: string[] } {
  const errors: string[] = [];
  const empty = { items: [], done: 0, decided: 0, expired: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...empty, errors: ["approvals file must be an object { version: 1, items: [...] }"] };
  const file = raw as Record<string, unknown>;
  if (file.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(file.items)) return { ...empty, errors: [...errors, "items must be an array"] };
  const seen = new Set<string>();
  const items: Approval[] = [];
  const expired: ExpiredApproval[] = [];
  const today = sydneyDay(now);
  let done = 0;
  let decided = 0;
  file.items.forEach((entry, index) => {
    const at = `items[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const before = errors.length;
    const id = typeof e.id === "string" && ID.test(e.id) ? e.id : (errors.push(`${at}: id must be lower-case kebab-case`), null);
    if (id && seen.has(id)) errors.push(`${at}: duplicate id "${id}"`);
    const title = text(e.title, "title", 120, errors, at);
    const detail = text(e.detail, "detail", 400, errors, at);
    const source = text(e.source, "source", 80, errors, at);
    const area = APPROVAL_AREAS.includes(e.area as ApprovalArea) ? (e.area as ApprovalArea) : (errors.push(`${at}: area must be one of ${APPROVAL_AREAS.join(", ")}`), null);
    const href = typeof e.href === "string" && (/^\/[a-z0-9/_-]*$/i.test(e.href) || /^https:\/\/[^\s]+$/.test(e.href)) ? e.href : (errors.push(`${at}: href must be an internal path or an https link`), null);
    const since = typeof e.since === "string" && DAY.test(e.since) && Number.isFinite(Date.parse(`${e.since}T00:00:00Z`)) ? e.since : (errors.push(`${at}: since must be YYYY-MM-DD`), null);
    const status =
      e.status === undefined ? "pending" : e.status === "pending" || e.status === "done" || e.status === "decided" ? e.status : (errors.push(`${at}: status must be "pending", "done" or "decided"`), null);
    const day = (v: unknown, field: string) =>
      v === undefined ? undefined : typeof v === "string" && DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : (errors.push(`${at}: ${field} must be YYYY-MM-DD`), null);
    const expires = day(e.expires, "expires");
    if (status === "decided") {
      // A decision is recorded with what was decided and when, never just flipped off.
      text(e.decision, "decision", 200, errors, at);
      if (e.decidedOn === undefined) errors.push(`${at}: decidedOn is required for a decided item`);
      else day(e.decidedOn, "decidedOn");
    }
    if (errors.length > before || !id || !title || !detail || !source || !area || !href || !since || !status || expires === null) return;
    seen.add(id);
    if (status === "done") {
      done++;
      return;
    }
    if (status === "decided") {
      decided++;
      return;
    }
    const lastDay = expires ?? addDays(since, MAX_PENDING_DAYS);
    if (today > lastDay) {
      expired.push({ id, title, expiredOn: lastDay });
      return;
    }
    items.push({ id, title, area, detail, href, since, source });
  });
  return { items, done, decided, expired, errors };
}

/** The part of the receptionist snapshot approvals read (readiness only — never calls or transcripts). */
export type ReadinessLike = {
  blockers?: { id: string; title: string; state: string; next?: string; stateNote?: string }[];
  ownerRetestCalls?: { count: number; target: number } | null;
} | null;

/** Receptionist gates waiting on the owner, plus live retest progress on the matching file item. */
export function mergeApprovals(fileItems: Approval[], readiness: ReadinessLike): Approval[] {
  const out = fileItems.map((a) => ({ ...a }));
  if (readiness) {
    const retest = out.find((a) => a.id === "receptionist-retest-calls");
    if (retest)
      retest.progress = readiness.ownerRetestCalls
        ? `${readiness.ownerRetestCalls.count} of ${readiness.ownerRetestCalls.target} owner retest calls`
        : "Retest attribution unavailable — count them on /receptionist";
    for (const b of readiness.blockers ?? []) {
      if (b.state !== "open") continue; // pass = nothing to do; fail/not-tested = evidence first, not a sign-off
      out.push({
        id: `receptionist-gate-${b.id}`,
        title: `Sign off receptionist gate: ${b.title}`.slice(0, 120),
        area: "receptionist",
        detail: (b.stateNote || b.next || "Evidence is in; waiting for the owner's sign-off.").slice(0, 400),
        href: "/receptionist",
        since: null,
        source: "receptionist readiness (live)",
      });
    }
  }
  return out;
}
