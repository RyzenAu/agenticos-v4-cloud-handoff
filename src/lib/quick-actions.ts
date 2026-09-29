// Quick actions for the /business rail: what each button is, what it needs and whether it has to
// ask first. The wiring lives in src/components/business/quick-actions.tsx; every action calls an
// endpoint that already exists. Pins and the run log are stored in .operator-data by
// scripts/quick-actions.ts (ids must match QUICK_ACTION_IDS there).

export type QuickActionId =
  | "plan-today"
  | "todays-calls"
  | "morning-brief"
  | "find-phones"
  | "generate-preview"
  | "inbox-important"
  | "seo-audit"
  | "receptionist-report"
  | "daily-review"
  | "end-day";

/** Read: runs straight away. Spend: uses a paid model, search budget or a long build; asks first. */
export type Gate = "read" | "spend";
export type NeedsInput = "lead" | "lead-with-site" | "org";

export type QuickActionDef = {
  id: QuickActionId;
  label: string;
  /** The success toast ("Inbox checked"). */
  done: string;
  /** One line under the label in the manage list. */
  hint: string;
  gate: Gate;
  needs?: NeedsInput;
  /** Works for someone signed in from their phone, or only at this PC. */
  pcOnly: boolean;
  /** What the confirmation says will happen. Required when gate is "spend". */
  confirm?: (subject?: string) => { title: string; body: string; action: string };
};

export const QUICK_ACTIONS: QuickActionDef[] = [
  { id: "plan-today", done: "Day planned", label: "Plan today", hint: "Start-my-day: status, first call, what's next", gate: "read", pcOnly: true },
  { id: "todays-calls", done: "Call list ready", label: "Calls to make", hint: "The call list for now, with openers", gate: "read", pcOnly: false },
  { id: "morning-brief", done: "Brief loaded", label: "Morning brief", hint: "The latest brief's headline and priorities", gate: "read", pcOnly: false },
  {
    id: "find-phones", done: "Phone lookup finished",
    label: "Find phones for new leads",
    hint: "Up to 3 new leads without a number",
    gate: "spend",
    pcOnly: false,
    confirm: () => ({
      title: "Look up phone numbers?",
      body: "Searches for a phone number for up to 3 new leads that don't have one (SearXNG plus a Jev check each, about 15 seconds a lead). A number is saved only when sources agree. Nothing is dialled or sent.",
      action: "Find numbers",
    }),
  },
  {
    id: "generate-preview", done: "Preview built",
    label: "Generate preview for lead…",
    hint: "A local preview site for one lead",
    gate: "spend",
    needs: "lead-with-site",
    pcOnly: true,
    confirm: (lead) => ({
      title: `Build a preview for ${lead ?? "this lead"}?`,
      body: "Gathers evidence, sets an art direction and builds the site with Claude Code, then checks it. It takes several minutes and uses Claude. The preview stays on this PC; nothing is deployed or sent.",
      action: "Build preview",
    }),
  },
  { id: "inbox-important", done: "Inbox checked", label: "Inbox: anything important?", hint: "Last 24 hours from inbox triage", gate: "read", pcOnly: true },
  {
    id: "seo-audit", done: "SEO audit finished",
    label: "SEO audit for lead…",
    hint: "Crawl one lead's site and score it",
    gate: "spend",
    needs: "lead-with-site",
    pcOnly: true,
    confirm: (lead) => ({
      title: `Audit ${lead ?? "this lead"}'s website?`,
      body: "Crawls the lead's own website and scores it, with one Jev call. Results are saved on the lead. Nothing is sent to them.",
      action: "Run audit",
    }),
  },
  { id: "receptionist-report", done: "Report opened", label: "Weekly receptionist report", hint: "Last week's proof report from MU-Receptionist", gate: "read", needs: "org", pcOnly: true },
  { id: "daily-review", done: "Review loaded", label: "Daily review", hint: "Last night's review: what improved, what broke, top actions", gate: "read", pcOnly: false },
  { id: "end-day", done: "Day closed out", label: "End my day", hint: "Scorecard, tomorrow's first event, quiet until 7 am", gate: "read", pcOnly: true },
];

export const actionById = (id: string) => QUICK_ACTIONS.find((a) => a.id === id);

export type ActionResult = {
  ok: boolean;
  summary: string;
  /** Toast headline when the action read nothing ("No brief yet"): never the "done" wording (audit P1-3). */
  headline?: string;
  lines?: string[];
  link?: { label: string; href: string; external?: boolean };
};

/** Said when the inbox read nothing: an empty read is not "nothing important" (audit P1-3). */
export const NO_MAIL_READ = "No mail read in the last 24 hours (inbox not connected or not synced), so I can't say.";

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** "Inbox: anything important?": the honest sentence for a triage digest. Pure. */
export function inboxAnswer(d: { total?: unknown; urgent?: unknown; today?: unknown }): { summary: string; headline?: string } {
  const urgent = count(d.urgent) ?? 0;
  const today = count(d.today) ?? 0;
  if (urgent > 0) return { summary: `${urgent} urgent in the last 24 hours.` };
  if (today > 0) return { summary: `Nothing urgent. ${today} to handle today.` };
  const total = count(d.total);
  if (!total) return { summary: NO_MAIL_READ, headline: "No mail read" };
  return { summary: "Nothing important in the last 24 hours." };
}

/** "Morning brief": no brief written means the toast must not say "Brief loaded". */
export const NO_BRIEF = { summary: "No brief has been written yet. The nightly job writes one before 7 am.", headline: "No brief yet" } as const;

/** "Calls to make": nobody on the call sheet means the toast must not say "Call list ready". */
export function callsHeadline(due: unknown, onSheet: number): string | undefined {
  return onSheet === 0 && !(count(due) && (count(due) as number) > 0) ? "No calls to make" : undefined;
}

/** Pinned ids in their saved order, dropping any the client no longer knows. */
export function pinnedActions(pinned: string[] | undefined) {
  return (pinned ?? []).map(actionById).filter((a): a is QuickActionDef => !!a);
}

export function movePin(pinned: string[], id: string, dir: -1 | 1) {
  const i = pinned.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pinned.length) return pinned;
  const next = [...pinned];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function togglePin(pinned: string[], id: string) {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

/** "4 s", "1 min 12 s". */
export function durationLabel(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}
