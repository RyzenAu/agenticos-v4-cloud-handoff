// R12 Departments: a frontend view over EXISTING data (agents service bots, their tasks and saved results, CRM subjects on jobs) plus
// the planned journey record (GET /__journeys, docs/programme-20261001/R12-DEPARTMENTS-CONTRACT.md). Everything here is pure and
// bun-tested; nothing invents server data. Where the backend has no field yet (an explicit handoff record), the page says what it
// shows is inferred and from what.
import type { StatusState } from "@/components/ds/status-label";

export type DepartmentId = "sales" | "design" | "engineering" | "finance" | "research" | "operations";

export type Department = {
  id: DepartmentId;
  name: string;
  /** One line: what the department is for. */
  purpose: string;
  /** Where its own records already live (a link on the department page), when there is such a page. */
  records?: { label: string; to: string };
};

export const DEPARTMENTS: readonly Department[] = [
  { id: "sales", name: "Sales & CRM", purpose: "Leads, first contact, quotes and proposals.", records: { label: "Open CRM", to: "/crm" } },
  { id: "design", name: "Design & Websites", purpose: "Concepts, previews and site builds.", records: { label: "Open Websites", to: "/websites" } },
  { id: "engineering", name: "Engineering", purpose: "Coding jobs: changes, tests and review.", records: { label: "Open Coding", to: "/coding" } },
  { id: "finance", name: "Finance", purpose: "Invoices, costs and the bank import.", records: { label: "Open Finance", to: "/finance" } },
  { id: "research", name: "Research", purpose: "Sourced reports on businesses, markets and suppliers." },
  { id: "operations", name: "Operations", purpose: "Routines, checks and anything not yet assigned.", records: { label: "Open Automations", to: "/automations" } },
];

export const DEPARTMENT_BY_ID = Object.fromEntries(DEPARTMENTS.map((d) => [d.id, d])) as Record<DepartmentId, Department>;
export const isDepartmentId = (v: unknown): v is DepartmentId => typeof v === "string" && v in DEPARTMENT_BY_ID;

/**
 * Which department each agent bot works in. The agents service has no department field yet (contract item D1), so this small typed
 * table is the one place the mapping lives. A bot that isn't listed is placed by its id and name, then lands in Operations.
 */
export const BOT_DEPARTMENT: Readonly<Record<string, DepartmentId>> = {
  research: "research",
  builder: "engineering",
  outreach: "sales",
  designer: "design",
};

const GUESS: readonly [RegExp, DepartmentId][] = [
  [/\b(sales|lead|leads|outreach|crm|quote|proposal)\b/i, "sales"],
  [/\b(design|designer|website|websites|site|concept)\b/i, "design"],
  [/\b(build|builder|code|coding|engineer|engineering|dev)\b/i, "engineering"],
  [/\b(finance|invoice|invoices|bookkeep|bookkeeper|accounts)\b/i, "finance"],
  [/\b(research|researcher)\b/i, "research"],
];

/** Pure: a bot's department and how it was decided ("table": listed above; "name": guessed from its id or name; "default": Operations). */
export function departmentOfBot(bot: { id: string; name?: string }): { id: DepartmentId; by: "table" | "name" | "default" } {
  const listed = BOT_DEPARTMENT[bot.id];
  if (listed) return { id: listed, by: "table" };
  const words = `${bot.id.replace(/-/g, " ")} ${bot.name ?? ""}`;
  for (const [re, id] of GUESS) if (re.test(words)) return { id, by: "name" };
  return { id: "operations", by: "default" };
}

// ------------------------------------------------------------------ status language

/** The task states the Agents workspace already uses (src/components/agents/tasks/tasks.ts TaskState). */
export type WorkTaskState = "working" | "queued" | "needs-you" | "finished" | "failed" | "stopped" | "interrupted" | "unknown";

/**
 * Pure: the ONE status vocabulary for work anywhere in the OS (R12-UI-SYSTEM "Status language"). Running, waiting/blocked, failed and
 * completed are distinct in word, icon and colour.
 */
export function workStatus(state: WorkTaskState): { state: StatusState; label: string } {
  switch (state) {
    case "working": return { state: "running", label: "Running" };
    case "queued": return { state: "pending", label: "Queued" };
    case "needs-you": return { state: "needs-you", label: "Needs you" };
    case "finished": return { state: "done", label: "Completed" };
    case "failed": return { state: "failed", label: "Failed" };
    case "stopped": return { state: "stopped", label: "Stopped" };
    case "interrupted": return { state: "unknown", label: "Interrupted" };
    default: return { state: "unknown", label: "Outcome unknown" };
  }
}

export const isOpenWork = (s: WorkTaskState) => s === "working" || s === "queued" || s === "needs-you";
export const isAttention = (s: WorkTaskState) => s === "needs-you" || s === "failed";

// ------------------------------------------------------------------ work items across departments

/** One task with the facts the department views need beyond BotTask: whose it is and which CRM records it is about. */
export type DeptTask = {
  id: string;
  title: string;
  state: WorkTaskState;
  stateWord: string;
  botId: string;
  department: DepartmentId;
  startedAt: number | null;
  endedAt: number | null;
  subjects: string[];
  kind: "computer" | "coding";
  progress: string | null;
  blocker: string | null;
  result: { href: string; external: boolean } | null;
  jobHref: string;
};

export type Party = { department: DepartmentId | "jarvis"; agent: string | null };
export type HandoffView = {
  id: string;
  from: Party;
  to: Party;
  /** What was asked, one line ("concept requested"). */
  label: string;
  state: WorkTaskState;
  /** What the step rests on: an explicit journey record, or an inference from two jobs about the same CRM record. */
  basis: "journey" | "inferred";
  /** The task the receiving side is doing for it, when there is one. */
  taskId: string | null;
  at: number;
};

export const partyName = (p: Party) => (p.department === "jarvis" ? "Jarvis" : DEPARTMENT_BY_ID[p.department].name.split(" & ")[0]);

/**
 * Pure: hand-offs inferred from jobs, until the backend records them (contract D3). A task of department B is a hand-off from A when an
 * earlier task of A is about the same CRM record and ENDED before B's task started. Only finished work counts as handed over; the newest
 * such earlier task is the one named. Never more than one inferred hand-off into a task.
 */
export function inferHandoffs(tasks: readonly DeptTask[]): HandoffView[] {
  const out: HandoffView[] = [];
  for (const t of tasks) {
    if (!t.subjects.length || t.startedAt === null) continue;
    const before = tasks
      .filter((p) => p.department !== t.department && p.state === "finished" && p.endedAt !== null && p.endedAt <= t.startedAt! && p.subjects.some((s) => t.subjects.includes(s)))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    if (!before) continue;
    out.push({ id: `inferred:${before.id}:${t.id}`, from: { department: before.department, agent: before.botId }, to: { department: t.department, agent: t.botId }, label: shortAsk(t.title), state: t.state, basis: "inferred", taskId: t.id, at: t.startedAt });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Pure: a task title as the thing that was asked ("Homepage concept for X" -> "homepage concept for X"), clipped. */
export function shortAsk(title: string, max = 80): string {
  const s = title.replace(/^(Research|Draft|Build):\s*/i, "").trim();
  const t = s.charAt(0).toLowerCase() + s.slice(1);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ------------------------------------------------------------------ journeys (GET /__journeys, planned)

export type JourneyState = "queued" | "running" | "waiting" | "failed" | "completed" | "stopped";
export type JourneyOutput = { label: string; href: string };
export type JourneyStep = {
  id: string;
  index: number;
  title: string;
  owner: Party;
  from: Party | null;
  inputs: { label: string; ref: string | null }[];
  expectedOutput: string;
  dependsOn: string[];
  state: JourneyState;
  acknowledgedAt: number | null;
  startedAt: number | null;
  jobId: string | null;
  completion: { at: number; jobId: string | null; summary: string; outputs: JourneyOutput[] } | null;
  failure: { at: number; jobId: string | null; reason: string; saved: JourneyOutput[] } | null;
  waitingFor: { question: string } | null;
};
export type Journey = {
  id: string;
  kind: string;
  title: string;
  conversationId: string | null;
  requestedBy: string | null;
  subjects: string[];
  state: JourneyState;
  createdAt: number;
  updatedAt: number;
  steps: JourneyStep[];
};

const STATES: readonly JourneyState[] = ["queued", "running", "waiting", "failed", "completed", "stopped"];
const text = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 16) : []);
const outputs = (v: unknown): JourneyOutput[] =>
  Array.isArray(v) ? v.flatMap((o) => (o && typeof o === "object" && typeof (o as JourneyOutput).href === "string" && /^\/(?!\/)/.test((o as JourneyOutput).href) ? [{ label: text((o as JourneyOutput).label, 120) || "Open", href: (o as JourneyOutput).href }] : [])) : [];
function party(v: unknown): Party | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const dept = p.department === "jarvis" || isDepartmentId(p.department) ? (p.department as Party["department"]) : null;
  return dept ? { department: dept, agent: typeof p.agent === "string" && p.agent ? p.agent.slice(0, 40) : null } : null;
}

/** Pure: one journey from GET /__journeys or /__journeys/<id>. Null when it isn't usable; a malformed step is dropped, never repaired. */
export function parseJourney(raw: unknown): Journey | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id, 80);
  if (!id || !STATES.includes(r.state as JourneyState) || !Array.isArray(r.steps)) return null;
  const steps: JourneyStep[] = [];
  for (const s0 of r.steps) {
    if (!s0 || typeof s0 !== "object") continue;
    const s = s0 as Record<string, unknown>;
    const owner = party(s.owner);
    if (!text(s.id, 60) || !owner || !STATES.includes(s.state as JourneyState)) continue;
    const c = s.completion && typeof s.completion === "object" ? (s.completion as Record<string, unknown>) : null;
    const f = s.failure && typeof s.failure === "object" ? (s.failure as Record<string, unknown>) : null;
    const w = s.waitingFor && typeof s.waitingFor === "object" ? (s.waitingFor as Record<string, unknown>) : null;
    steps.push({
      id: text(s.id, 60),
      index: num(s.index) ?? steps.length,
      title: text(s.title, 120) || "Step",
      owner,
      from: party(s.from),
      inputs: Array.isArray(s.inputs) ? s.inputs.flatMap((i) => (i && typeof i === "object" ? [{ label: text((i as { label?: unknown }).label, 80) || "Input", ref: text((i as { ref?: unknown }).ref, 200) || null }] : [])).slice(0, 8) : [],
      expectedOutput: text(s.expectedOutput, 200),
      dependsOn: strs(s.dependsOn),
      state: s.state as JourneyState,
      acknowledgedAt: num(s.acknowledgedAt),
      startedAt: num(s.startedAt),
      jobId: text(s.jobId, 80) || null,
      completion: c ? { at: num(c.at) ?? 0, jobId: text(c.jobId, 80) || null, summary: text(c.summary, 400), outputs: outputs(c.outputs) } : null,
      failure: f ? { at: num(f.at) ?? 0, jobId: text(f.jobId, 80) || null, reason: text(f.reason, 400) || "It failed.", saved: outputs(f.saved) } : null,
      waitingFor: w && text(w.question, 300) ? { question: text(w.question, 300) } : null,
    });
  }
  steps.sort((a, b) => a.index - b.index);
  return {
    id,
    kind: text(r.kind, 60),
    title: text(r.title, 200) || "Journey",
    conversationId: text(r.conversationId, 120) || null,
    requestedBy: text(r.requestedBy, 40) || null,
    subjects: strs(r.subjects),
    state: r.state as JourneyState,
    createdAt: num(r.createdAt) ?? 0,
    updatedAt: num(r.updatedAt) ?? 0,
    steps,
  };
}

/** Pure: a journey state in the shared work vocabulary. */
export const JOURNEY_TASK_STATE: Record<JourneyState, WorkTaskState> = { queued: "queued", running: "working", waiting: "needs-you", failed: "failed", completed: "finished", stopped: "stopped" };

/** Pure: every step after the first as a hand-off from the step before it (or from `from` when the record names one). */
export function journeyHandoffs(j: Journey): HandoffView[] {
  return j.steps.map((s, i) => {
    const prev = j.steps[i - 1];
    const from: Party = s.from ?? (prev ? prev.owner : { department: "jarvis", agent: null });
    return { id: `journey:${j.id}:${s.id}`, from, to: s.owner, label: s.title.charAt(0).toLowerCase() + s.title.slice(1), state: JOURNEY_TASK_STATE[s.state], basis: "journey" as const, taskId: s.jobId, at: s.acknowledgedAt ?? s.startedAt ?? j.createdAt };
  });
}

/** Pure: "Step 2 of 4: Make a homepage concept", the step that is moving (or waiting, or failed), else the last one. */
export function journeyNow(j: Journey): { step: JourneyStep | null; line: string } {
  const step = j.steps.find((s) => s.state === "waiting" || s.state === "failed" || s.state === "running") ?? j.steps.find((s) => s.state === "queued") ?? j.steps.at(-1) ?? null;
  return { step, line: step ? `Step ${step.index + 1} of ${j.steps.length}: ${step.title}` : "No steps" };
}

/** Pure: does this journey touch the department (any step it owns)? */
export const journeyTouches = (j: Journey, dept: DepartmentId) => j.steps.some((s) => s.owner.department === dept);
