import { unavailableModelWords } from "./model-words";
import type { Principal as ApprovalPrincipal } from "../approvals/principal";
import type { ApprovalService } from "../approvals/service";
import type { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { AgentBinding, CodingJob, JobState, PersonId, RoleChoice, RoleKind, VerifiedPrincipal } from "./contracts";
import type { Orchestrator } from "./orchestrator";
import { redactText } from "./redact";
import { reviseSpec, shortSha, specDigest } from "./spec";
import { labelOf, type AccountsConfig } from "./accounts";
import { modelsUsed } from "./receipts";
import { freeOnlyRefusal, modelLabel } from "./role-choice";
import { spokenSummary, STARTS_WITH_PROMPT, type createShaper } from "./shaper";
import { siteRequestFromWords } from "../../src/lib/commands/site-maker";
import { isCodingRequest } from "../../src/lib/commands/coding";
import type { CodingStore } from "./store";

/**
 * Jarvis's coding phrases (CODING-HARNESS §5.4), answered by rules before any model (free-voice.ts calls
 * this the way it calls memory). Typed works the same. Every line is built from verified state:
 * never "done" before the gate passed, never "merged" before git confirms it.
 *
 *   start          "Jarvis, fix the receptionist dashboard. Opus builds, another Opus reviews. …"
 *   clarify        the answer to the one question the shaper asked
 *   edit-draft     "Use Codex for the review" / "Add a tester" (before "Start it")
 *   confirm-start  "Start it" / "Yes", only right after "Start it?" (a spoken yes is bound to THAT question)
 *   status         "How's the coding job going?" / "What's the builder doing?"
 *   show           "Show me what changed" / "Show me the tests" → the Coding page on that tab
 *   stop / pause   "Stop the coding job" / "Stop the reviewer" / "Pause the coding job"
 *   resume         "Resume the coding job"
 *   apply          "Merge it" / "Deploy it" → the exact action, asked once (B2)
 *   approve-asked  "Yes, approve" right after that question → B2 decide with the STT spoken-yes event
 */

/** `jobId`: the job this reply is about (a drafted, started, stopped, asked-about job), so a caller can attach progress. */
export type CodingVoiceReply = { say: string; navigate?: string; jobId?: string };
export type VoiceCaller = { id: string; name?: string; via?: string; actor?: string };

export type CodingVoiceDeps = {
  store: CodingStore;
  orch: Orchestrator;
  shaper: ReturnType<typeof createShaper>;
  approvals: () => ApprovalService | null;
  spoken: SpokenConfirmationLedger;
  cliVersions: () => { claude: string; codex: string };
  /** Where "show me the tests" sends the Coding page. */
  setFocus: (jobId: string, tab: string) => void;
  hubDeviceId?: string;
  now?: () => number;
  /** Registry repo ids, so "fix X in muv-demo-dental" is recognised. */
  repoIds?: () => string[];
  /** The configured accounts, so a report names the Claude account that ran ("on Claude Max 2"). */
  accounts?: () => AccountsConfig;
};

type VoiceState = {
  draftId?: string;
  jobId?: string;
  /** "Start it?" as asked: its ledger question, and the digest of the plan that was READ OUT (R4-1). */
  startQuestion?: { id: string; at: number; digest: string };
  approval?: { id: string; questionId: string; at: number };
  at: number;
};

/**
 * R4-1: the conversation state key. A person's turns and a program's turns under the same person id
 * never share state, so a program can't edit, answer or clear the question a person was asked.
 */
const PROGRAM_KEY = "~program";
export const voiceStateKey = (caller: VoiceCaller) => (caller.actor === "human" ? caller.id : `${caller.id}${PROGRAM_KEY}`);

const STATE_TTL = 15 * 60_000;
// Kept for reference: the phrases the shared detector covers.
const _ROLE_WORDS = /\b(?:opus|sonnet|codex|claude|hermes|deep ?seek|mimo|cline|another agent|an agent)\b[^.,;]{0,24}\b(?:build|builds|review|reviews|builder|reviewer|implement|implements|fix|fixes)\b|\b(?:build|builds|review|reviews|builder|reviewer)\b[^.,;]{0,24}\b(?:opus|sonnet|codex|claude|hermes|deep ?seek|mimo|cline|another agent)\b|\bcoding job\b|\bhave an? (?:opus|codex|sonnet|claude) builder\b/i;
const _START_VERBS = /^\s*(?:hey\s+)?(?:jarvis[,\s]+)?(?:please\s+)?(?:fix|build|implement|add|change|update|refactor|rename|remove|make|write|improve|create|set|investigate|review)\b/i;

/** The SAME detector the command registry uses (src/lib/commands/coding.ts), so typed and spoken agree. */
export function isCodingStart(text: string, repoIds: readonly string[] = []): boolean {
  return isCodingRequest(text, repoIds);
}
/** A whole-utterance yes (AUDIT-F4 F1): "yes, but change X" is NOT a yes, it's a new request. */
// "Started." and "Yes, yes, yes." are how speech-to-text hears a start answer (30 Sep 2026, live); still the whole utterance only.
const WHOLE_YES = /^(?:(?:yes|yeah|yep)(?:[,.!\s]+(?:yes|yeah|yep)){0,3}|yes please|go ahead|do it|confirm(?:ed)?|start it|start|started|run it|kick it off|yes,? start it)[.!]?$/i;
const WHOLE_APPROVE = /^(?:yes|yeah|yep|yes please|approve|yes,? approve|approved|go ahead|do it|confirm(?:ed)?)[.!]?$/i;
const WHOLE_NO = /^(?:no|nope|reject|don't|do not|cancel(?: it)?|not now)[.!]?$/i;

const human = (s: JobState) => ({
  draft: "a draft with problems", awaiting_confirmation: "waiting for you to start it", preparing: "preparing its worktrees", building: "building",
  integrating: "merging the builders' branches", testing: "running the tests", reviewing: "being reviewed", gating: "at the done gate",
  awaiting_approval: "waiting for your approval", applying: "applying the approved step", completed: "done and verified", needs_owner: "waiting for you",
  blocked_allowance: "paused at an account limit", failed: "failed", cancelled: "stopped", interrupted: "interrupted and not replayed",
}[s]);

export function createCodingVoice(deps: CodingVoiceDeps) {
  const states = new Map<string, VoiceState>();
  const now = () => deps.now?.() ?? Date.now();
  const state = (person: string): VoiceState => {
    const s = states.get(person);
    if (s && now() - s.at < STATE_TTL) return s;
    const fresh: VoiceState = { at: now() };
    states.set(person, fresh);
    return fresh;
  };
  const touch = (person: string, patch: Partial<VoiceState>) => states.set(person, { ...state(person), ...patch, at: now() });

  const verified = (c: VoiceCaller): VerifiedPrincipal => ({
    personId: c.id as PersonId,
    via: c.via === "local" ? "local" : c.via === "telegram" ? "telegram" : c.via === "voice" ? "voice" : "tailnet",
    deviceId: (c.via === "local" ? deps.hubDeviceId ?? "usman-pc" : `${c.id}-remote`) as VerifiedPrincipal["deviceId"],
    sessionId: "voice",
  });
  const approvalPrincipal = (c: VoiceCaller): ApprovalPrincipal => ({
    personId: c.id as ApprovalPrincipal["personId"],
    via: c.via === "local" ? "loopback-owner" : "tailnet-person",
    actor: "human",
    ...(c.via === "local" ? { deviceId: deps.hubDeviceId ?? "usman-pc" } : {}),
  });

  /** The job a follow-up means: the one in this conversation, else the most recently updated. */
  function currentJob(person: string): CodingJob | null {
    const s = state(person);
    if (s.jobId) { const j = deps.store.getJob(s.jobId); if (j) return j; }
    return deps.store.listJobs({ limit: 1 })[0] ?? null;
  }

  function statusLine(j: CodingJob, focus?: RoleKind | null): string {
    const live = deps.orch.liveRoles(j.id);
    const runs = j.runs;
    const lastSpoken = [...deps.store.events(j.id, Math.max(0, j.lastSeq - 60), 60)].reverse().find((e) => e.type === "spoken");
    const lastStep = [...deps.store.events(j.id, Math.max(0, j.lastSeq - 60), 60)].reverse().find((e) => e.type === "step" && (!focus || runs.find((r) => r.roleId === e.roleId)?.role === focus));
    const who = focus ? runs.filter((r) => r.role === focus).at(-1) : null;
    const tests = j.tests.filter((t) => t.sha === j.headSha);
    const parts = [`The ${j.spec.repo.repoId} job is ${human(j.state)}.`];
    if (who) parts.push(`The ${focus} is ${who.state.replace("_", " ")}${lastStep ? `: ${String((lastStep.payload as { label: string }).label).slice(0, 120)}` : ""}.`);
    else if (live.length) parts.push(`${live.join(" and ")} ${live.length === 1 ? "is" : "are"} working.`);
    if (tests.length) {
      const p = tests.reduce((n, t) => n + (t.counts.passed ?? 0), 0), f = tests.reduce((n, t) => n + (t.counts.failed ?? 0), 0);
      parts.push(`Tests at ${shortSha(j.headSha)}: ${p} passed, ${f ? `${f} failed` : "none failed"}.`);
    }
    if (j.review) parts.push(`Review: ${j.review.verdict.replace("-", " ")}.`);
    parts.push(...modelSentences(j, focus));
    if (j.state === "completed") parts.push("Nothing is merged.");
    if (!who && lastSpoken && !/is (?:done|building)/.test(parts[0])) parts.push(String((lastSpoken.payload as { line: string }).line).slice(0, 200));
    return parts.join(" ");
  }

  /**
   * "The builder ran on Codex (selected Opus, fell back because …)." Built from the receipts only: a turn with no
   * receipt is never said to have run, and a role that hasn't started says only what it is set to run on.
   */
  function modelSentences(j: CodingJob, focus?: RoleKind | null): string[] {
    const rows = modelsUsed(j.runs, deps.store.events(j.id, 0, 5000));
    const out: string[] = [];
    for (const role of ["builder", "test-author", "reviewer"] as const) {
      if (focus && focus !== role) continue;
      const mine = rows.filter((r) => r.role === role);
      const last = mine.at(-1);
      if (!last) continue;
      const name = role === "test-author" ? "test author" : role;
      const ran = [...mine].reverse().find((r) => r.hasReceipt);
      if (!ran) { out.push(last.runState === "queued" || last.runState === "starting" || last.runState === "running" ? `The ${name} is set to run on ${modelLabel(last.selected)}.` : `The ${name} has no usage receipt yet, so I can't say what it ran on.`); continue; }
      // A Claude role also says WHICH Claude account ran it (30 Sep 2026: more than one), from the receipt.
      const on = ran.account?.startsWith("claude:") && deps.accounts ? ` on ${labelOf(deps.accounts(), ran.account)}` : ran.account?.startsWith("claude:max-") ? ` on account ${ran.account.split("-").pop()}` : "";
      out.push(ran.fellBack
        ? `The ${name} ran on ${modelLabel(ran.actual!)}${on} (selected ${modelLabel(ran.selected)}, fell back because ${String(ran.reason ?? "it was unavailable").replace(/[.\s]+$/, "").slice(0, 140)}).`
        : `The ${name} ran on ${modelLabel(ran.actual!)}${on}.`);
    }
    return out;
  }

  /** The binding a phrase names, by the shaper's own model words (least-used Codex account, catalogue routes). */
  const modelFrom = (text: string): AgentBinding | null => deps.shaper.bindingFromWords(text);

  async function askToStart(person: string, j: CodingJob, summary: string, validationErrors: string[]): Promise<CodingVoiceReply> {
    if (validationErrors.length) {
      touch(person, { jobId: j.id, startQuestion: undefined });
      return { say: `I drafted it, but it can't start yet: ${validationErrors.slice(0, 2).join("; ")}. It's on screen.`, navigate: "/coding", jobId: j.id };
    }
    const digest = specDigest(j.spec);
    // A program's draft is shown on the Coding page for a person to start; it never opens a spoken
    // question in the shared ledger (that would replace a person's own open question).
    if (person.endsWith(PROGRAM_KEY)) {
      touch(person, { jobId: j.id, draftId: undefined, startQuestion: { id: `program-${j.id}`, at: now(), digest } });
      deps.setFocus(j.id, "plan");
      return { say: summary.replace(/\s*(?:Start it\?|Say start when you want it built\.)$/, " It's on the Coding page; a signed-in person starts it there."), navigate: "/coding", jobId: j.id };
    }
    const q = (deps.spoken.ask as (s: string) => { id: string; at: number }).call(deps.spoken, "coding");
    touch(person, { jobId: j.id, draftId: undefined, startQuestion: { ...q, digest } });
    deps.setFocus(j.id, "plan");
    return { say: summary, navigate: "/coding", jobId: j.id };
  }

  async function handle(utterance: string, turn: { caller: VoiceCaller | null; spokenYes: string | null; previousAssistant: string | null }): Promise<CodingVoiceReply | null> {
    const caller = turn.caller;
    if (!caller?.id) return null;
    const person = voiceStateKey(caller);
    const text = utterance.trim().replace(/^\s*(?:hey\s+)?jarvis[,\s]+/i, "");
    const s = state(person);
    const prev = turn.previousAssistant ?? "";
    const aboutCoding = /\b(?:coding job|builder|reviewer|draft ready|start it\?|merge|the gate|worktree)\b/i.test(prev);
    // R3-1: the voice/typed turn is reachable with the page token alone. Only a person (a signed-in
    // session at the PC, a paired device, or the owner's own Telegram) may start, stop, pause, resume,
    // approve or ask to merge; a program may draft and ask how it's going.
    const person_ = caller.actor === "human";
    const PERSON_ONLY: CodingVoiceReply = { say: "That needs you, signed in: a program can draft coding work and ask how it's going, but only a person can start, stop, pause, resume or merge it. Nothing changed." };

    // ── the approval question just asked: "yes, approve" / "no" ──
    if (s.approval && !person_ && (WHOLE_APPROVE.test(text) || WHOLE_NO.test(text))) return PERSON_ONLY;
    if (s.approval && WHOLE_APPROVE.test(text)) {
      const approvals = deps.approvals();
      if (!approvals) return { say: "The approvals service isn't available, so nothing was merged." };
      if (!turn.spokenYes) return { say: "That needs your spoken yes (a typed yes doesn't count for a merge), or the code from your Telegram. Nothing was merged." };
      const r = approvals.decide(s.approval.id, approvalPrincipal(caller), "approve", { spokenYes: turn.spokenYes, questionId: s.approval.questionId });
      touch(person, { approval: undefined });
      if (!r.ok) return { say: `Not approved: ${r.reason} Nothing was merged.` };
      return { say: "Approved. I'll merge it once and check the result from git; I'll say when it's confirmed." };
    }
    if (s.approval && WHOLE_NO.test(text)) {
      deps.approvals()?.decide(s.approval.id, approvalPrincipal(caller), "reject");
      touch(person, { approval: undefined });
      return { say: "Okay, not merged." };
    }

    // ── "Start it?" just asked ──
    // Anything other than a whole yes/no to a pending question clears it: it's a new request.
    if (s.approval && !WHOLE_APPROVE.test(text) && !WHOLE_NO.test(text)) touch(person, { approval: undefined });
    if (s.startQuestion && s.jobId && WHOLE_NO.test(text)) {
      touch(person, { startQuestion: undefined });
      return { say: "Okay, not started. The draft stays on the Coding page." };
    }
    // A program never answers a start question (R3-1/R4-1): its yes is refused, whatever it follows, and
    // only its OWN state is touched (a person's pending question is kept under a separate key).
    if (!person_ && WHOLE_YES.test(text) && (s.startQuestion || aboutCoding)) {
      touch(person, { startQuestion: undefined });
      return { ...PERSON_ONLY, say: `${PERSON_ONLY.say} The draft is on the Coding page.` };
    }
    // REVIEW-T3 F7c: "start it" is not a shared yes (S2); here it answers ONLY Jarvis's own "Start it?",
    // as the whole utterance, in the very next turn. Anything said in between (a refused money request,
    // another rule's answer) means the question is no longer the one being answered.
    if (s.startQuestion && s.jobId && WHOLE_YES.test(text) && !STARTS_WITH_PROMPT.test(prev.trim())) {
      touch(person, { startQuestion: undefined });
      return { say: "I'm not sure what that yes is for, so nothing started. The draft is still on the Coding page; say start it right after I ask, or press Start there.", navigate: "/coding", jobId: s.jobId };
    }
    if (s.startQuestion && s.jobId && WHOLE_YES.test(text)) {
      const j = deps.store.getJob(s.jobId);
      if (j && j.state !== "awaiting_confirmation" && j.state !== "draft" && j.spec.confirmation.state === "confirmed") { touch(person, { startQuestion: undefined }); return { say: "That one has already started; it isn't started twice. Ask me how it's going.", navigate: "/coding", jobId: j.id }; }
      if (!j || j.state !== "awaiting_confirmation") { touch(person, { startQuestion: undefined }); return { say: "That draft isn't waiting to start any more." }; }
      // R4-1: the yes starts the plan that was read out, or nothing. Changed since (an edit, the page)?
      // Read the new plan out and ask again.
      if (specDigest(j.spec) !== s.startQuestion.digest) {
        touch(person, { startQuestion: undefined });
        return askToStart(person, j, `The plan changed since I asked, so nothing started. ${spokenSummary(j.spec)}`, []);
      }
      // A spoken yes redeems the "Start it?" question (heard in a LATER turn, so the same millisecond counts);
      // a transcribed "start it" is recorded as typed words.
      const yes = turn.spokenYes ? deps.spoken.redeem(turn.spokenYes, { after: s.startQuestion.at - 1, question: s.startQuestion.id }) : null;
      try {
        deps.orch.confirmAndStart(j.id, verified(caller), yes ? "spoken-yes" : "typed", specDigest(j.spec));
      } catch (e) { return { say: `It didn't start: ${redactText((e as Error).message, 200)}` }; }
      touch(person, { startQuestion: undefined });
      deps.setFocus(j.id, "progress");
      return { say: "Started. I'll keep the progress on screen; ask me how it's going any time.", navigate: "/coding", jobId: j.id };
    }

    // ── edit the draft before starting ──
    const EDIT_DRAFT = /\b(?:use|switch to|make it)\b.*\b(?:for|as) (?:the )?(?:review|reviewer|build|builder)\b|\badd a tester\b|\bno review\b/i;
    // R4-1: only a person edits a draft; a program's words never change a plan anyone was read.
    if (!person_ && EDIT_DRAFT.test(text) && (s.startQuestion || aboutCoding)) return PERSON_ONLY;
    if (s.startQuestion && s.jobId && EDIT_DRAFT.test(text)) {
      const j = deps.store.getJob(s.jobId);
      if (!j || j.state === "preparing") return null;
      let roles = [...j.spec.roles];
      let roleChoices = j.spec.roleChoices;
      const model = modelFrom(text);
      const edited = /review/i.test(text) && model ? "reviewer" : /build/i.test(text) && model ? "builder" : null;
      if (!model) {
        // "Use Gemini for the review": a model that can't be run is said, and nothing changes (round 6).
        const missing = unavailableModelWords(text);
        if (missing) return { say: `${missing.reason} Nothing changed.` };
        if (/\b(?:review|build)/i.test(text) && /\b(?:use|switch to)\b/i.test(text)) return { say: "I couldn't tell which model you meant, so nothing changed. Say Opus, Sonnet, Codex, Hermes, DeepSeek, MiMo or Muse." };
      }
      if (model && edited) {
        const refused = freeOnlyRefusal(model, deps.shaper.prefs());
        if (refused) return { say: `${refused} Nothing changed.` };
        // The named role is the owner's word; the other role is picked again if it now clashes (so the check stays independent).
        const kept = (role: "builder" | "reviewer") => (j.spec.roleChoices ?? []).some((c) => c.role === role && c.basis === "named") ? roles.find((r) => r.role === role)?.agent ?? null : null;
        const re = deps.shaper.pickRoles(j.spec.objective, j.spec.roleTemplate, { builder: edited === "builder" ? model : kept("builder"), reviewer: edited === "reviewer" ? model : kept("reviewer") });
        if (!re.ok) return { say: `${re.reason} Nothing changed.` };
        roles = roles.map((r) => (r.role === "builder" ? { ...r, agent: re.builder.binding } : r.role === "reviewer" && re.reviewer ? { ...r, agent: re.reviewer.binding } : r));
        roleChoices = [re.builder.choice, ...(re.reviewer ? [re.reviewer.choice] : [])] as readonly RoleChoice[];
      } else if (/no review/i.test(text)) { roles = roles.filter((r) => r.role !== "reviewer"); roleChoices = roleChoices?.filter((c) => c.role !== "reviewer"); }
      else if (/add a tester/i.test(text)) return { say: "A tester needs its own test files to own. Say which test file it should write, then I'll add it." };
      const next = reviseSpec(j.spec, { roles, ...(roleChoices ? { roleChoices } : {}) });
      const { job, validation } = deps.orch.revise(j.id, next);
      return askToStart(person, job, `Changed. ${spokenSummary(job.spec)}`, validation.ok ? [] : validation.errors.map((e) => e.detail));
    }

    // A pending "Start it?" is answered only by a whole yes/no or a draft edit; anything else clears it.
    if (s.startQuestion) touch(person, { startQuestion: undefined });

    // ── the answer to the shaper's question ──
    if (s.draftId && !isCodingStart(text, deps.repoIds?.() ?? []) && !siteRequestFromWords(text) && !/^(?:how'?s|what'?s|stop|cancel|show)\b/i.test(text)) {
      const r = await deps.shaper.shape({ utterance: text, channel: "voice", principal: verified(caller), draftId: s.draftId, answer: text, usePlanner: person_ });
      return shaped(person, r);
    }

    const siteRequest = siteRequestFromWords(text);
    if (siteRequest) {
      const r = await deps.shaper.shape({ utterance: siteRequest, channel: "voice", principal: verified(caller), usePlanner: person_ });
      return shaped(person, r);
    }

    // ── a new coding request ──
    if (isCodingStart(text, deps.repoIds?.() ?? [])) {
      const r = await deps.shaper.shape({ utterance: text, channel: "voice", principal: verified(caller), usePlanner: person_ });
      return shaped(person, r);
    }

    const j = currentJob(person);
    // ── status ──
    if (/^(?:how'?s|how is)\b.*\b(?:coding|job|build|builder|review|reviewer)\b|\bwhat'?s the (builder|reviewer|tester) doing\b/i.test(text)) {
      if (!j) return { say: "There's no coding job yet." };
      const role = /\bbuilder\b/i.test(text) ? "builder" : /\breviewer\b/i.test(text) ? "reviewer" : /\btester\b/i.test(text) ? "test-author" : null;
      return { say: statusLine(j, role as RoleKind | null), jobId: j.id };
    }
    // ── show ──
    const show = /^(?:show me|open|let me see)\b.*\b(what changed|changes|the diff|tests?|review|usage|plan)\b/i.exec(text);
    if (show && (aboutCoding || /\bcoding\b/i.test(text) || (j && now() - Date.parse(j.updatedAt) < 60 * 60_000))) {
      if (!j) return { say: "There's no coding job yet." };
      const tab = /test/i.test(show[1]) ? "tests" : /review/i.test(show[1]) ? "review" : /usage/i.test(show[1]) ? "usage" : /plan/i.test(show[1]) ? "plan" : "changes";
      deps.setFocus(j.id, tab);
      return { say: `Opening the coding job's ${tab}.`, navigate: "/coding", jobId: j.id };
    }
    if (!j) return null;
    // ── stop / pause / resume ──
    const stop = /^(?:stop|cancel|kill)\b.*\b(?:coding job|coding|the (builder|reviewer|tester))\b/i.exec(text);
    if (stop) {
      if (!person_) return PERSON_ONLY;
      const roleWord = stop[1]?.toLowerCase();
      const role = roleWord ? j.runs.filter((r) => (roleWord === "tester" ? r.role === "test-author" : r.role === roleWord)).at(-1) : null;
      try { deps.orch.cancel(j.id, role?.roleId); } catch (e) { return { say: redactText((e as Error).message, 200) }; }
      return { say: role ? `Stopped the ${roleWord}. The job waits for you.` : "Stopped the coding job. Its worktrees are kept.", jobId: j.id };
    }
    if (/^pause\b.*\bcoding job\b|^pause it\b/i.test(text) && (/\bcoding job\b/i.test(text) || aboutCoding)) {
      if (!person_) return PERSON_ONLY;
      try { deps.orch.interrupt(j.id); } catch (e) { return { say: redactText((e as Error).message, 200) }; }
      return { say: "Paused. Nothing is lost; say 'resume the coding job' to continue.", jobId: j.id };
    }
    if (/^resume\b.*\bcoding job\b|^(?:continue|carry on with) the coding job\b/i.test(text)) {
      if (!person_) return PERSON_ONLY;
      try {
        const resumed = deps.orch.resume(j.id, { by: verified(caller) });
        const review = resumed.review?.sha === resumed.headSha ? resumed.review : null;
        const say = resumed.state === "building" && review?.verdict === "request-changes"
          ? "Resumed to fix the review findings, then run fresh tests and review."
          : resumed.state === "reviewing" && review?.verdict === "cannot-assess"
            ? "Resumed. The reviewer will assess the work again."
            : "Resumed. It continues on the same agent sessions; nothing that already ran is repeated.";
        return { say, jobId: j.id };
      } catch (e) { return { say: redactText((e as Error).message, 200), jobId: j.id }; }
    }
    // ── merge / deploy ──
    const apply = /^(?:merge|push|deploy|ship)\b(?: it| the coding job| that)?(?: (?:into|to) ([\w./-]+))?/i.exec(text);
    if (apply && (aboutCoding || /coding/i.test(text) || (j.state === "completed" && now() - Date.parse(j.updatedAt) < 60 * 60_000))) {
      const verb = apply[0].split(/\s+/)[0].toLowerCase();
      if (!person_) return PERSON_ONLY;
      if (verb === "deploy" || verb === "ship" || verb === "push") return { say: "I don't deploy from the coding harness. I can merge it into a protected branch; the project's own pipeline deploys from there." };
      if (j.state !== "completed") return { say: `It can't be merged: the job is ${human(j.state)}. Only a job whose gate passed can be.`, jobId: j.id };
      const entryBranch = apply[1] ?? "main";
      try {
        const r = await deps.orch.requestApply(j.id, { action: verb === "push" ? "git.push.production" : "git.merge.protected", toRef: entryBranch, by: verified(caller) });
        const approvals = deps.approvals();
        if (!approvals) return { say: "The approvals service isn't available, so nothing can be merged." };
        // Only Usman approves a merge. If Mehroz asked, the question isn't put in HIS voice session (Usman
        // couldn't answer it there, and it would replace any other open question): Usman approves with the
        // Telegram code, or on the Coding page's approval card by his own spoken yes.
        if (person !== "usman") {
          deps.setFocus(j.id, "progress");
          return { say: "Asked. Usman needs to approve the merge, with the code on his Telegram. Nothing is merged until he does.", navigate: "/coding", jobId: j.id };
        }
        const q = approvals.ask(r.approval.id, approvalPrincipal({ ...caller, id: "usman" }));
        touch(person, { approval: { id: r.approval.id, questionId: q.questionId, at: q.askedAt }, jobId: j.id });
        return { say: `${r.approval.summary}. Should I? Say "yes, approve", or send the code from your Telegram.`, jobId: j.id };
      } catch (e) { return { say: `Not merged: ${redactText((e as Error).message, 220)}`, jobId: j.id }; }
    }
    return null;
  }

  async function shaped(person: string, r: Awaited<ReturnType<ReturnType<typeof createShaper>["shape"]>>): Promise<CodingVoiceReply> {
    if (r.kind === "refused") { touch(person, { draftId: undefined }); return { say: r.reason }; }
    if (r.kind === "ask") { touch(person, { draftId: r.draftId }); return { say: r.question }; }
    const { job, validation } = deps.orch.draft(r.spec);
    touch(person, { draftId: undefined });
    return askToStart(person, job, r.spokenSummary, validation.ok ? [] : validation.errors.map((e) => e.detail));
  }

  /** The job and draft this caller's conversation is on (read-only; the command entry returns them so a service can attach progress). */
  const peek = (caller: VoiceCaller): { jobId: string | null; draftId: string | null } => {
    const s = states.get(voiceStateKey(caller));
    return s && now() - s.at < STATE_TTL ? { jobId: s.jobId ?? null, draftId: s.draftId ?? null } : { jobId: null, draftId: null };
  };
  return { handle, statusLine, isCodingStart, peek, reset: (person: string) => states.delete(person) };
}

export type CodingVoice = ReturnType<typeof createCodingVoice>;
