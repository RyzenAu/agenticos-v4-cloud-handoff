import type { Principal } from "../identity/principal";
import type { Principal as JobPrincipal } from "../approvals/principal";
import type { ComputersService } from "./service";

/**
 * Jarvis and Jev to shared cloud computers, through the ONE command path (scripts/jarvis-command/service.ts calls this as its
 * `computers` delegate, before its own routing):
 *
 *   "use the research computer to find the contact page on example.com"      start a computer job
 *   "have the builder bot run ..." / "on the research computer, open ..."   same
 *   "show me the research bot" / "how is the builder computer doing"         status; follows the job on the Computers page
 *   "continue that job on its cloud computer"                                attach to this person's latest computer job
 *
 * Rules, all fail-closed:
 *  - Who is asking is the VERIFIED principal (never the words). The job's agent inherits exactly that person's permitted targets:
 *    both founders may use any shared computer; a personal PC is never reachable this way (and keeps its owner rules elsewhere).
 *  - A computer that doesn't exist is refused by name; nothing is ever sent to a different computer, or to the person's own PC.
 *  - "continue" attaches to a job that is still running or paused. A job that ended (unknown, failed, cancelled) is reported as it
 *    ended; it is never silently re-run, because an interrupted step may already have happened.
 *  - A goal that is one page to open is a typed, rule-planned step (verified by the page's title). Anything open-ended runs the
 *    hub-side goal loop (Jev on the hub, bounded, each move a job step), or is refused when the hub has no Jev key.
 */

export type ComputerCommand =
  | { kind: "use"; name: string; goal: string }
  | { kind: "show"; name: string }
  | { kind: "continue"; name: string | null };

const NAME = "[a-z0-9][a-z0-9-]{0,31}";
const NOUN = "(?:cloud\\s+)?(?:computer|bot|agent|desktop|machine)";
const GENERIC = new Set(["pc", "computer", "my", "his", "her", "its", "this", "that", "the", "main", "home", "work", "usman", "mehroz", "usmans", "mehrozs", "laptop", "phone", "cloud", "a", "an", "new", "other", "windows", "chrome", "second", "spare", "old", "same", "remote", "local", "browser"]);

/** Pure. `names`: the shared computers that exist (lowercase). A phrase naming an unknown computer is still a computer request only when it says "cloud". */
export function parseComputerCommand(utterance: string, names: string[]): ComputerCommand | null {
  const text = utterance.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const known = new Set(names.map((n) => n.toLowerCase()));
  // `explicit`: a command verb or "on the X computer" names the machine, so an unknown name is refused BY NAME (never handed to another lane that
  // would act on a different machine); "show/how is the X computer" questions still need it to exist (or say "cloud").
  const named = (raw: string, cloud: boolean, explicit = false) => {
    const n = raw.toLowerCase();
    if (GENERIC.has(n)) return null;
    return known.has(n) || cloud || explicit ? n : null;
  };
  let m = new RegExp(`^(?:please\\s+)?(?:use|have|ask|tell|get|let)\\s+(?:the\\s+)?(${NAME})\\s+(${NOUN})\\s+(?:to\\s+)?(.{3,})$`, "i").exec(text);
  if (m) {
    const n = named(m[1], /cloud/i.test(m[2]), true);
    if (n) return { kind: "use", name: n, goal: m[3].trim() };
  }
  m = new RegExp(`^(.{3,}?)[,\\s]+(?:on|using|with|in)\\s+the\\s+(${NAME})\\s+(${NOUN})\\s*[.!?]?$`, "i").exec(text);
  if (m) {
    const n = named(m[2], /cloud/i.test(m[3]), true);
    if (n && !/^(?:continue|resume|show)\b/i.test(m[1])) return { kind: "use", name: n, goal: m[1].trim() };
  }
  m = new RegExp(`^(?:please\\s+)?(?:show|open|bring up|pull up|check on|what'?s|how'?s|how is|what is)\\s+(?:me\\s+)?(?:the\\s+)?(${NAME})\\s+(${NOUN})(?:\\s+(?:doing|up to|status))?\\s*[.!?]?$`, "i").exec(text);
  if (m) {
    const n = named(m[1], /cloud/i.test(m[2]));
    if (n) return { kind: "show", name: n };
  }
  m = /^(?:please\s+)?(?:continue|resume|carry on(?: with)?|pick up|attach to)\s+(?:that|the|my|this|our)?\s*(?:job|task|work|run)(?:\s+(?:on|in|at)\s+(?:its|the|that|his|her)\s+(?:(?:cloud\s+)?(?:computer|bot|agent|desktop)|([a-z0-9-]+)\s+(?:cloud\s+)?(?:computer|bot|agent|desktop)))?\s*[.!?]?$/i.exec(text);
  if (m) return { kind: "continue", name: m[1] && !GENERIC.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null };
  m = new RegExp(`^(?:please\\s+)?(?:continue|resume)\\s+(?:the\\s+)?(${NAME})\\s+(?:job|task|work|${NOUN})\\s*[.!?]?$`, "i").exec(text);
  if (m) {
    const n = named(m[1], false);
    if (n) return { kind: "continue", name: n };
  }
  return null;
}

/** One open-a-page goal is a typed, verified step; anything else is the goal loop. */
const OPEN_PAGE = /^(?:please\s+)?(?:go to|open|navigate to|visit)\s+\S+(?:\s+and\s+(?:check|confirm|verify|make sure)\s+(?:that\s+)?the\s+title\s+(?:is|contains|has|reads)\s+.+)?[.!]?$/i;

/**
 * A goal that asks for information (find, research, summarise, compare, "what are...") and ends in an answer is bounded research: sources, reading,
 * comparison, a cited report returned to the conversation. A goal that DOES something on a page ("find the contact page of X and open it") stays the
 * interactive goal loop.
 */
const INFO_GOAL = /^(?:please\s+)?(?:(?:can|could) you\s+)?(?:research|look up|look into|find out|summari[sz]e|compare|investigate|identify|work out|(?:find|get|give|tell)(?:\s+me)?\s+(?:the|an?|all|some|what|which|how|official|info)|what(?:'s|\s+(?:is|are|does|do))|which|who|how (?:much|many|do|does|to))\b/i;
const ACT_GOAL = /\b(?:and\s+(?:then\s+)?(?:open|click|press|select|fill|sign|log|submit|buy|book|send|download|play|type)|then\s+(?:open|click|press|fill|sign|log|submit)|log ?in|sign ?in|fill (?:in|out)|check ?out|add to cart)\b/i;
export function isResearchGoal(goal: string): boolean {
  return INFO_GOAL.test(goal.trim()) && !ACT_GOAL.test(goal) && !OPEN_PAGE.test(goal);
}

/**
 * The other three workflows, by the words that name them:
 *   "audit https://dental-care-plus.muventures.com.au" / "audit the demo clinic fixture"   website audit (read-only; only authorised sites, checked again by the hub)
 *   "build a pricing card component" / "update the pricing card"                            builder (an isolated worktree, checks, a preview)
 *   "prepare a comparison table of ..." / "draft a proposal for ..."                        business preparation (synthetic information, a saved draft)
 */
const AUDIT_GOAL = /^(?:please\s+)?(?:audit|review|inspect|check|assess)\s+(?:the\s+|our\s+)?(?:(?:web\s?site|site|page)\s+(?:at\s+)?)?(https?:\/\/\S+|(?:the\s+)?(?:local\s+)?(?:demo[- ]clinic|fixture)(?:\s+(?:fixture|site|website))?)\s*(?:for\b.*|on\b.*|at\b.*)?[.!]?$/i;
const BUILD_GOAL = /^(?:please\s+)?(?:build|create|make|add|write|update|change|edit|improve|redo|design)\s+(?:me\s+)?(?:an?\s+|the\s+|our\s+)?(?:\S+\s+){0,5}?(?:component|card|banner|widget|section|block|badge|testimonial|opening[- ]hours)\b/i;
const BIZ_GOAL = /^(?:please\s+)?(?:prepare|draft|put together|make|write|build|create|produce)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:\S+\s+){0,4}?(?:comparison(?:\s+table)?|proposal|options?\s+table)\b/i;
export function planWorkflow(goal: string): { executor: "audit" | "builder" | "bizprep"; args: Record<string, unknown> } | null {
  const a = AUDIT_GOAL.exec(goal.trim());
  if (a) return /^https?:/i.test(a[1]) ? { executor: "audit", args: { url: a[1].replace(/[.,;!?)]+$/, "") } } : { executor: "audit", args: { fixture: "demo-clinic" } };
  if (BIZ_GOAL.test(goal.trim())) return { executor: "bizprep", args: { kind: /proposal/i.test(goal) ? "proposal" : "comparison", brief: goal } };
  if (BUILD_GOAL.test(goal.trim())) return { executor: "builder", args: { brief: goal } };
  return null;
}

export function planSteps(goal: string, canPlanGoals: boolean, canResearch = false, canWorkflows = false) {
  if (OPEN_PAGE.test(goal)) return [{ executor: "screen.goal", args: { goal } }];
  const wf = canWorkflows ? planWorkflow(goal) : null;
  if (wf) return [wf];
  if (canResearch && isResearchGoal(goal)) return [{ executor: "research", args: { goal } }];
  if (!canPlanGoals) return [{ executor: "screen.goal", args: { goal } }];
  return [{ executor: "goal", args: { goal } }];
}

const STATE_WORDS: Record<string, string> = { online: "idle and ready", busy: "in use", asleep: "asleep", offline: "offline", starting: "starting up", failed: "failed" };

export async function computerCommand(computers: ComputersService, utterance: string, principal: Principal) {
  const names = computers.list().map((c) => c.name);
  const cmd = parseComputerCommand(utterance, names);
  if (!cmd) return null;
  const listing = names.length ? `The shared ones are ${names.join(", ")}.` : "There are none yet.";
  const refuseUnknown = (n: string) => ({ ok: false, said: `There's no shared computer called "${n}". ${listing} Nothing ran anywhere else.` });

  if (cmd.kind === "use") {
    if (!names.includes(cmd.name)) return refuseUnknown(cmd.name);
    const r = await computers.startJob({
      computer: cmd.name, by: principal.personId, principal: principal as unknown as JobPrincipal, agent: "jarvis", title: cmd.goal.slice(0, 80),
      steps: planSteps(cmd.goal, computers.canPlanGoals, computers.canResearch, computers.canWorkflows), wake: true,
    });
    if (!r.ok) return { ok: false, said: r.reason, deviceId: computers.deviceFor(computers.store.get(cmd.name)!)?.id };
    const view = computers.view(cmd.name);
    return { ok: true, started: true, said: `Started on ${cmd.name}: ${cmd.goal.slice(0, 120)}. It runs there whether or not your PC is on; say "show me the ${cmd.name} computer" to follow it, or stop to cancel.`, jobId: r.jobId, deviceId: view.id ?? undefined };
  }

  if (cmd.kind === "show") {
    if (!names.includes(cmd.name)) return refuseUnknown(cmd.name);
    const v = computers.view(cmd.name);
    const job = v.assigned?.jobId ?? v.paused?.jobId;
    const jv = job ? computers.jobView(job) : null;
    const who = v.controller.kind === "person" ? `${v.controller.who} is controlling it` : v.controller.kind === "agent" ? `agent ${v.controller.who} is using it` : "nobody is using it";
    const said = `${v.label} is ${STATE_WORDS[v.state] ?? v.state}; ${who}${jv ? `; its job "${jv.title}" is ${jv.paused ? "paused for a person" : jv.state} after ${jv.steps.length} step${jv.steps.length === 1 ? "" : "s"}` : ""}${v.takeoverPending ? `; ${v.takeoverPending.by} is waiting to take control` : ""}. Opening it on the Computers page.`;
    return { ok: true, said, navigate: "/computers", ...(v.id ? { deviceId: v.id } : {}), ...(job ? { jobId: job } : {}) };
  }

  // continue: this person's latest computer job (on the named computer, if they named one)
  const jobId = computers.lastJob(principal.personId, cmd.name ?? undefined);
  if (!jobId) return { ok: false, said: cmd.name ? `You haven't started a job on ${cmd.name}, so there's nothing to continue.` : "You haven't started a computer job, so there's nothing to continue." };
  const jv = computers.jobView(jobId);
  if (!jv) return { ok: false, said: "I can't find that job any more, so nothing was continued." };
  const dev = jv.computer ? computers.view(jv.computer).id ?? undefined : undefined;
  if (["running", "queued", "awaiting-approval"].includes(jv.state))
    return { ok: true, said: `${jv.title} is still ${jv.paused ? "paused while a person has the computer" : "running"} on ${jv.computer}, ${jv.steps.length} step${jv.steps.length === 1 ? "" : "s"} in. I've attached to it.`, jobId, deviceId: dev, navigate: "/computers" };
  const how = jv.state === "succeeded" ? "finished" : jv.state === "unknown" ? "ended with an unknown outcome: one step may or may not have happened" : jv.state === "cancelled" ? "was stopped" : "stopped early";
  return { ok: false, said: `That job on ${jv.computer} ${how}${jv.note ? `: ${jv.note.slice(0, 140)}` : ""}. I won't run it again blindly; tell me the next goal and I'll start a new job.`, jobId, deviceId: dev };
}
