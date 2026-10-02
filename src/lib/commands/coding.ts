// The coding command (Track 3, 28 Sep 2026; AUDIT-F4 finding F8): "fix / build / change X in <repo>",
// typed or spoken, goes to the coding harness instead of the brain, control_pc or screen_act.
//
// Pure and shared: the command registry (resolveCommand, typed and voice) and Jarvis's rules turn
// (scripts/coding/voice.ts) use the SAME detector, so both channels reach the same place. Detecting is
// not starting: the entry opens the Coding page with the request, where the plan, repo and team are shown
// and a clear confirmation ("Start it") is required before any job runs. Uses the existing contract
// (a navigate action with a search param), so no contract type changes.
import type { CommandEntry } from "./types";
import { siteMakerCommandEntry } from "./site-maker";
import { parseSiteAsk } from "../site-maker";

const LEAD = /^\s*(?:(?:hey|ok|okay)\s+)?(?:jarvis\b[,\s]*)?(?:(?:can|could|would|will) you\s+|please\s+|i want (?:you )?to\s+|let's\s+|go\s+)?/i;
const WORK_VERB = /^(?:fix|build|change|implement|refactor|rename|remove|add|update|write|create|make|improve|clean up|debug|investigate|set)\b/i;
/** The target said first: "In agentic os, add a test …", "On the dental site fix …" (30 Sep 2026, live voice). Only the verb check skips it. */
const LEAD_TARGET = /^(?:in|on|for)\s+(?:the\s+|my\s+|our\s+)?[\w.'\/-]+(?:\s+[\w.'\/-]+){0,3}?\s*,?\s+(?=(?:fix|build|change|implement|refactor|rename|remove|add|update|write|create|make|improve|clean up|debug|investigate)\b)/i;
/** "assign Codex to …", "tell Claude Code to …", or the agent named first: "Codex, fix …". */
const AGENT_FIRST = String.raw`^(?:(?:assign|get|have|ask|use|tell)\s+(?:an?\s+|another\s+)?(?:opus|sonnet|codex|claude(?:\s+code)?|hermes|deep ?seek|mimo|muse|cline|agent|builder|coder|developer|reviewer)|(?:opus|sonnet|codex|claude(?:\s+code)?|mimo|muse|deep ?seek|cline)\s*,)`;
const ASSIGN = new RegExp(AGENT_FIRST + String.raw`[^.]{0,40}?\b(?:to\s+)?(?:fix|build|change|implement|refactor|rename|remove|add|update|write|create|make|improve|debug|investigate|review)\b`, "i");
/** No model named, only roles: "assign a builder to fix X and a reviewer to check it", "have a builder fix X". */
const GENERIC_ROLE = /^(?:assign|get|have|let|ask|use|tell)\s+(?:an?\s+|another\s+|the\s+)?(?:agent|builder|coder|developer|reviewer)\b/i;
/** Softer verbs ("look into", "check", "test") count only with a code target: "ask Claude to look into the flaky test in AgenticOS". */
const ASSIGN_SOFT = new RegExp(AGENT_FIRST + String.raw`[^.]{0,40}?\b(?:to\s+)?(?:look\s+(?:into|at)|check|test|fix\s+up)\b`, "i");
/**
 * An assign verb + a coding task + a named Claude account (1 Oct 2026): "assign this fix to Claude Max 2",
 * "use the second Claude account for a builder to fix X". "max", "account" and "code" alone never start a job:
 * both halves (a coding noun and a Claude account) are needed, and a non-code errand word ("lunch", "invoice")
 * refuses it.
 */
const CLAUDE_ACCOUNT = String.raw`(?:claude\s+max(?:\s*(?:number\s*)?(?:[2-9]|one|two|three|four|five|six|seven|eight|nine))?|claude\s+account\s*(?:number\s*)?(?:[1-9]|one|two|three|four|five|six|seven|eight|nine)|(?:the\s+|my\s+)?(?:second|2nd|first|1st|original|other)\s+claude\s+(?:max\s+)?account)`;
const TASK_NOUN = String.raw`(?:fix|bug|change|task|job|issue|feature|refactor|patch|ticket|pull request|build|test|tests)`;
const ACCOUNT_ASSIGN = new RegExp(String.raw`^(?:assign|give|hand|send|route|move|put)\s+(?:this|that|the|it|my)\s+(?:[\w.'/-]+\s+){0,5}?${TASK_NOUN}\b[^;!?]{0,60}?\b(?:to|on|onto|using|with)\s+${CLAUDE_ACCOUNT}\b`, "i");
const ACCOUNT_FOR_ROLE = new RegExp(String.raw`^(?:use|put|run)\s+${CLAUDE_ACCOUNT}\s+(?:for|as)\s+(?:the\s+|a\s+|an\s+)?(?:builder|coder|agent|developer)\b[^;!?]{0,80}?\b(?:fix|build|change|implement|refactor|add|update|write|debug|improve)\b`, "i");
/** Models or roles named: the request is clearly for coding agents. */
const ROLE = /\b(?:opus|sonnet|codex|hermes|deep ?seek|mimo|cline|another agent|an agent)\b[^.,;]{0,24}\b(?:builds?|reviews?|builder|reviewer|implements?|fix(?:es)?)\b|\b(?:builds?|reviews?|builder|reviewer)\b[^.,;]{0,24}\b(?:opus|sonnet|codex|hermes|deep ?seek|mimo|cline|another agent)\b|\bcoding job\b/i;
/** "… in the dental site", "… in AgenticOS", "… on the receptionist dashboard", "… in src/app/page.tsx". */
const TARGET = /\b(?:in|on|for|of)\s+(?:the\s+|our\s+|my\s+)?(?:[\w.'-]+\s+){0,3}?(?:site|website|app|repo|repository|codebase|project|dashboard|os|agenticos|agentic os|page|component|api|server|client|tests?|module|file|branch)\b|\b(?:[\w-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|css|md|json|sql|prisma)\b/i;
/** "start a coding job …", "kick off a coding task …", "open a new coding job: …": a job is asked for by name. */
const JOB_START = /^(?:please\s+)?(?:start|begin|kick off|create|open|set up|run|spin up|queue|make)\s+(?:me\s+)?(?:a|an|the|another)?\s*(?:new\s+)?coding\s+(?:job|task|run)\b/i;
/**
 * The job asked for by name anywhere in a spoken turn (30 Sep 2026, live): "um … i want you to start a coding job in
 * agentic os …", and speech-to-text's "started quitting job" for "start a coding job". Only with a start verb.
 */
const JOB_ANYWHERE = /\b(?:start(?:ed)?|begin|kick off|open|run|do)\s+(?:me\s+)?(?:(?:a|an|the|another)\s+)?(?:new\s+)?(?:coding|quitting|cutting|coating)\s+(?:job|task)\b/i;
const CODE_WORD = /\b(?:bug|test|tests|build|type ?check|lint|code|component|function|endpoint|route|api|css|layout|button|form|page)\b/i;
/** Things that share the verbs but aren't code: never the coding harness. */
const NOT_CODE = /\b(?:volume|brightness|reminder|remind|alarm|timer|appointment|meeting|calendar|event|email|message|text|call|note|playlist|song|video|photo|picture|slide|presentation|powerpoint|excel|spreadsheet|document|lead|invoice|payment|transfer|coffee|dinner|lunch|booking)s?\b/i;

/** Is this a request to START coding work (not to open or ask about the Coding page)? Pure. */
export function isCodingRequest(text: string, repoIds: readonly string[] = []): boolean {
  const t = String(text ?? "").replace(LEAD, "").trim();
  if (!t || t.length > 2000) return false;
  // W-F: "make a top-tier dental site for <lead>" is the site entry's (it drafts with the full site brief),
  // so the spoken coding rules never shape the bare words first.
  if (parseSiteAsk(t)) return false;
  // F1: "start a coding job to fix the calls table in the receptionist app" says a job is wanted outright.
  if (JOB_START.test(t) || JOB_ANYWHERE.test(t)) return true;
  // An account named as the place to run a coding task: "assign this fix to Claude Max 2".
  if ((ACCOUNT_ASSIGN.test(t) || ACCOUNT_FOR_ROLE.test(t)) && !(NOT_CODE.test(t) && !CODE_WORD.test(t) && !TARGET.test(t))) return true;
  // A generic role ("a builder") on a non-code errand ("fix my calendar") is not the coding harness.
  if (ASSIGN.test(t)) return !(GENERIC_ROLE.test(t) && NOT_CODE.test(t) && !CODE_WORD.test(t) && !TARGET.test(t));
  if (ASSIGN_SOFT.test(t) && TARGET.test(t) && !NOT_CODE.test(t)) return true;
  if (!WORK_VERB.test(t.replace(LEAD_TARGET, ""))) return false;
  if (ROLE.test(t)) return true;
  if (NOT_CODE.test(t) && !/\b(?:bug|test|tests|build|type ?check|lint|code|component|function|endpoint|route|api|css|layout|button|form|page)\b/i.test(t)) return false;
  const lower = t.toLowerCase();
  if (repoIds.some((id) => lower.includes(id.toLowerCase()) || id.split("-").filter((w) => w.length > 3).every((w) => lower.includes(w)))) return true;
  return TARGET.test(t);
}

/**
 * The coding draft page for a task (T3 follow-up, 28 Sep; T3c): the brain's delegate_task / run_workflow
 * and the old /__operator/agent-jobs POST never start an agent job. They open Track 3's coding draft (the
 * page this registry entry opens: /coding?request=…), which shows the plan, repo and agents and waits for
 * a signed-in person's "Start it". Pure.
 */
export function codingDraftHref(prompt: unknown, target?: unknown): string | null {
  const text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  // Too short to be a task, or too long for a draft request: never silently cut (R3), the caller says why.
  if (text.length < 3 || text.length > CODING_REQUEST_MAX) return null;
  // The agent is named in its OWN sentence, so the shaper's objective keeps the whole task (R3: a bare
  // " (Codex builds)" made it strip the sentence, and "README.md" lost ".md").
  const who = target === "claude" ? "Claude builds." : target === "both" ? "Codex builds, Claude reviews." : target === "codex" ? "Codex builds." : "";
  const request = who ? `${text}${/[.!?]$/.test(text) ? "" : "."} ${who}` : text;
  if (request.length > CODING_REQUEST_MAX) return null;
  return `/coding?${new URLSearchParams({ request }).toString()}`;
}
/** The longest request a coding draft takes (the /coding page and the shaper use the same cap). */
export const CODING_REQUEST_MAX = 1000;
/** The longest task text from the Tasks form or a voice tool: room is kept for naming the agents. */
export const CODING_TASK_MAX = CODING_REQUEST_MAX - 40;
/** What to say when a task is too long for a draft, naming the limit that actually applied (R4). */
export const codingTooLong = (limit: number = CODING_TASK_MAX) =>
  `That task is over ${limit.toLocaleString("en-AU")} characters, which is more than a coding draft takes. Nothing was cut or drafted: shorten it, or put the detail in a file in the repo and name the file.`;
export const CODING_REQUEST_TOO_LONG = codingTooLong();

/** The registry entry for a coding request: opens Coding with the request to draft (nothing starts). */
export function codingCommandEntry(text: string, repoIds: readonly string[] = []): CommandEntry | null {
  // W-F: "make a top-tier dental site for <lead>" opens the same coding draft with the full site brief.
  const site = siteMakerCommandEntry(text);
  if (site) return site;
  if (!isCodingRequest(text, repoIds)) return null;
  const request = String(text).replace(LEAD, "").trim().slice(0, 1000);
  return {
    id: "coding:request",
    kind: "page",
    title: "Draft a coding job",
    detail: "Shows the plan, repo and agents first; nothing starts until you confirm.",
    phrases: [],
    action: { type: "navigate", to: "/coding", search: { request } },
    destination: "work",
    source: "static",
  };
}
