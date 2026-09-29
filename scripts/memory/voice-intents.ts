/**
 * Voice memory intents for Jarvis/Jev. Two ways in, same behaviour:
 *
 *  1. Phrase routing — `handleMemoryUtterance(api, principal, utterance, context)`:
 *       remember   "remember that …", "remember …", "make a note that …", "note that …", "keep in mind …"
 *                  → a Hindsight-only memory (mem-…). Never written to the vault.
 *       vault      "save this to the vault: …", "add to the wiki: …", "put this in the vault: …",
 *                  "save that to the vault" (moves the memory just used into the vault)
 *                  → a fact in the bucket's Obsidian note, then indexed.
 *       recall     "what do we know about …", "what did we decide about …", "recall …", …
 *       correct    "correct that: …", "that's wrong, it's …", "update the <topic> fact to …" — an explicit
 *                  correction intent only ("actually …" in ordinary speech is left for the brain), and it is
 *                  read back first ("Update X to Y? Say yes."); only a yes supersedes the old version.
 *       forget     "forget that" / "forget the <topic> fact" → a memory is deleted; vault content is forgotten
 *                  everywhere. "remove that from the index" → retract only, the note stays.
 *     Deleting or fully forgetting needs a SERVER-HELD approval: the first turn reads the plan back and the
 *     approval id stays on the server, keyed to that person; only their explicit "yes" next turn grants and uses it.
 *
 *  2. Tool calling — `MEMORY_VOICE_TOOLS` + `runMemoryTool`. The model can ASK to forget, but it can
 *     never approve: forget_memory returns `approval-required`; approval comes from the user.
 *
 * Every reply says where the thing went (Hindsight memory or the vault note) and carries `facts_used`.
 */
import type { MemoryApi } from "./api";
import type { NoteHit } from "../jarvis-skills/notes";
import { spokenNoteDay } from "./note-day";
import { approvalTarget } from "./approval-target";
import type { Bucket, ForgetKind, Principal, RecallResult, Refusal } from "./types";
import { isAffirmative } from "../../src/lib/jarvis-control";

export type MemoryIntent =
  | { intent: "remember"; text: string }
  /** "remember that" with nothing after it: ask what, never store the word "That". */
  | { intent: "remember-what" }
  /** "read my notes": the notes file AND the screened memory, each named as its source. */
  | { intent: "notes-read" }
  | { intent: "vault"; text: string | null }
  | { intent: "recall"; query: string }
  | { intent: "correct"; target: string | null; text: string }
  | { intent: "forget"; target: string | null; unindex: boolean }
  | { intent: "review-approvals" };

export type PendingMemoryAction =
  | { action: "forget"; kind: ForgetKind; target: string; title: string }
  | { action: "correct"; id: string; title: string; text: string }
  | { action: "resolve-conflict"; text: string; conflict_id: string; conflict_title: string; destination: "memory" | "vault" }
  | { action: "reaffirm"; text: string; destination: "memory" | "vault" };

export type VoiceContext = {
  /** Ids the previous answer used (so "correct that" / "forget that" has a referent). */
  lastFactsUsed?: string[];
  pending?: PendingMemoryAction | null;
};

/**
 * Server-side options (never from a request body).
 * `channel`: "voice" is Jarvis. When a forget needs approval, the question is put through B2's ONE question
 * registry, and only the voice pipeline's own spoken-yes event approves it: heard while that question was
 * open, and redeemed by the approval service itself. "ui" is the Memory page's typed box, where a typed yes
 * never approves (the card's button does).
 * `spokenYes`: the id of the spoken-yes event the voice pipeline recorded for THIS turn, if any.
 */
export type VoiceOptions = {
  channel?: "voice" | "ui";
  spokenYes?: () => string | null;
  /**
   * The Jarvis notes file (Inbox/Jarvis notes.md), READ-ONLY. When given, "what did I tell you about X" and "read my
   * notes" search it as well as the screened memory and name where each result came from. Never a write path.
   */
  notes?: { search: (query: string, max?: number) => { hits: NoteHit[] }; latest: (count?: number) => { hits: NoteHit[] } };
};

export type VoiceReply = {
  handled: boolean;
  spoken: string;
  facts_used: string[];
  pending: PendingMemoryAction | null;
  outcome?: "remembered" | "saved-to-vault" | "duplicate" | "recalled" | "corrected" | "forgotten" | "unindexed" | "refused" | "needs-confirm" | "cancelled" | "not-found";
  /** Where the result lives, for the UI's destination label. */
  destination?: { kind: "hindsight" | "vault"; id: string; path?: string; link?: string };
};

const clean = (s: string) => s.trim().replace(/^[,:;\-–—\s]+/, "").replace(/[\s.!?]+$/, "");
const sentence = (s: string) => {
  const t = s.trim().replace(/^that\s+/i, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/([^.!?])$/, "$1.") : "";
};

// "remember to …" is a reminder, not a fact — left for the normal brain.
const REMEMBER = /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:remember(?!\s+to\b)(?: that)?|make a note(?: that)?|note that|keep in mind(?: that)?)\b[:,]?\s+(.+)$/is;
const VAULT_WITH_TEXT = /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:save (?:this|it) (?:to|in) (?:the )?(?:vault|wiki|obsidian)|add (?:this )?to (?:the )?(?:vault|wiki)|put (?:this|it) in (?:the )?(?:vault|wiki))\b[:,]?\s+(.+)$/is;
const VAULT_THAT = /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:save|move|put) (?:that|it) (?:to|in|into) (?:the )?(?:vault|wiki|obsidian)[.!]?$/i;
const RECALL = /^(?:hey jarvis,?\s*)?(?:what do (?:we|you|i) know about|what did we (?:decide|say|agree|discuss) (?:about|on)|what did i (?:tell|say to|mention to) you (?:about|on)|what did i (?:say|mention|note|write down) (?:about|on)|what do you remember (?:about|of|on)|do you remember (?:anything |something |much |what (?:i|we) (?:said|told you|decided) )?(?:about|on|of)|remind me what (?:we|i) (?:said|told you|decided|agreed)(?: (?:about|on))?|what(?:'s| is) saved (?:about|on)|do we have anything (?:on|about)|recall|look up in memory)\s+(.+)$/is;
/** "read my notes", "what are my notes": the notes file and the memory together (only when the notes file is wired in). */
const NOTES_READ = /^(?:hey jarvis,?\s*)?(?:read|tell me|what are|what's in|what is in|show me)(?: me)? (?:my )?(?:(?:last|latest|recent) )?(?:(?:three|3|few) )?(?:jarvis )?notes(?: to me| back)?[.!?]*$/i;
const CORRECT_THAT = /^(?:hey jarvis,?\s*)?(?:correct that|correction|that's wrong|that is wrong|update that)\b[:,]?\s*(?:to\s+|it's\s+|it is\s+)?(.+)$/is;
const CORRECT_TOPIC = /^(?:hey jarvis,?\s*)?(?:correct|update|change) the (.+?) (?:fact|memory|note) to\s+(.+)$/is;
const UNINDEX_THAT = /^(?:hey jarvis,?\s*)?(?:remove (?:that|it) from (?:the )?index|stop indexing (?:that|it)|unindex (?:that|it))[.!]?$/i;
const FORGET_THAT = /^(?:hey jarvis,?\s*)?(?:forget (?:that|it|this)|delete that memory)[.!]?$/i;
const FORGET_TOPIC = /^(?:hey jarvis,?\s*)?(?:forget (?:about |what (?:i|we) said about |the )?|delete the memory (?:about|of) )(.+?)(?: (?:fact|memory|note))?[.!]?$/is;
const REVIEW_APPROVALS =
  /^(?:hey jarvis,?\s*)?(?:(?:approve|review|read(?: me)?|check) (?:the |any )?(?:pending|waiting) (?:forgets?|memory (?:deletions?|approvals?|forgets?))|what(?:'s| is| are) (?:waiting|pending) (?:for (?:my )?approval|to be approved)|(?:are there )?any (?:pending|waiting) (?:forgets?|memory approvals?))[?.!]?$/i;
const REMOVE_FROM_MEMORY = /^(?:hey jarvis,?\s*)?remove (?:the )?(.+?) from memory[.!]?$/is;
// A yes is the whole reply (AUDIT F4 F1): the shared whole-utterance yes. "Yeah, but not that one" or "yes
// forget the other one" is not a yes. Memory's own answers count only for their own read-back (REVIEW-S2 fix 1):
// "forget it" approves "Forget X? Say yes…", "save it" approves a save; anywhere else "forget it" is a no.
const FORGET_YES = /^(?:yes,?\s+)?forget it(?:,?\s+please)?[.!]?$/i;
const SAVE_YES = /^(?:yes,?\s+)?save it(?:,?\s+please)?[.!]?$/i;
const YES = { test: (u: string) => isAffirmative(u) };
const NO = /^(?:no|nope|cancel|stop|never ?mind|leave it|don't|forget it|forget about it|scrap that)\b/i;
const KEEP_BOTH = /\bkeep both\b/i;
// Whole reply too: "don't update that" or "update it later" is not a yes to the change.
const REPLACE = /^(?:yes,?\s+)?(?:replace|correct|update) (?:it|the old one|that)(?:,?\s+please)?[.!]?$/i;

/** Pure phrase parser. Returns null when the utterance isn't a memory intent. */
export function parseMemoryIntent(utterance: string): MemoryIntent | null {
  const u = (utterance || "").trim();
  if (!u || u.length > 1200) return null;
  let m: RegExpExecArray | null;
  if (REVIEW_APPROVALS.test(u)) return { intent: "review-approvals" };
  if (NOTES_READ.test(u)) return { intent: "notes-read" };
  if ((m = RECALL.exec(u))) return { intent: "recall", query: clean(m[1]) };
  if (VAULT_THAT.test(u)) return { intent: "vault", text: null };
  if ((m = VAULT_WITH_TEXT.exec(u))) return { intent: "vault", text: sentence(m[1]) || null };
  if ((m = CORRECT_TOPIC.exec(u))) return { intent: "correct", target: clean(m[1]), text: clean(m[2]) };
  if ((m = CORRECT_THAT.exec(u))) return { intent: "correct", target: null, text: clean(m[1]) };
  if (UNINDEX_THAT.test(u)) return { intent: "forget", target: null, unindex: true };
  if (FORGET_THAT.test(u)) return { intent: "forget", target: null, unindex: false };
  if ((m = REMOVE_FROM_MEMORY.exec(u))) return { intent: "forget", target: clean(m[1]), unindex: false };
  if ((m = FORGET_TOPIC.exec(u)) && !/^(it|that|this)$/i.test(clean(m[1]))) return { intent: "forget", target: clean(m[1]), unindex: false };
  if ((m = REMEMBER.exec(u))) {
    // "remember that" on its own: the optional "that" is the whole capture. Ask what, don't store "That.".
    if (/^(?:that|this|it|something|one thing|a thing)$/i.test(clean(m[1]))) return { intent: "remember-what" };
    const text = sentence(m[1]);
    return text ? { intent: "remember", text } : null;
  }
  return null;
}


const VALUE = /(?:A?\$\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:minutes?|mins?|hours?|days?|weeks?|months?|am|pm|%|per cent))?/gi;

/**
 * "correct that: it's A$1,999" — a bare value replaces the one value in the old fact, so the
 * corrected fact is still a whole sentence. Returns null when a fragment can't be applied safely.
 */
export function applySpokenCorrection(oldText: string, spoken: string): string | null {
  const fragment = spoken.trim().replace(/[.!]+$/, "");
  const bare = fragment.match(VALUE);
  if (bare && bare.length === 1 && bare[0].trim() === fragment) {
    const olds = oldText.match(VALUE) ?? [];
    if (olds.length !== 1) return null;
    return oldText.replace(olds[0], fragment);
  }
  if (fragment.split(/\s+/).length < 4) return null;
  return keepEntities(oldText, fragment);
}

/** Words that start a sentence without naming anyone (never an entity on their own). */
const NOT_ENTITY = new Set(["the", "they", "it", "he", "she", "we", "i", "this", "that", "these", "those", "a", "an", "our", "their", "its", "his", "her", "my", "your", "synthetic"]);
/** Capitalised names in a fact ("Synthetic Dental Co", "Harbourview Dental", "Usman"). */
export function entitiesOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[A-Z][\w&'.-]*(?:\s+(?:&\s+)?[A-Z0-9][\w&'.-]*)*/g)) {
    const words = m[0].split(/\s+/);
    while (words.length && NOT_ENTITY.has(words[0].toLowerCase()) && words.length > 1) words.shift();
    const name = words.join(" ");
    if (name && !(words.length === 1 && NOT_ENTITY.has(name.toLowerCase()))) out.push(name);
  }
  return out;
}

const PRONOUN_START = /^(?:they(?:'re| are)?|it(?:'s| is)?|he(?:'s| is)?|she(?:'s| is)?|we(?:'re| are)?|this(?: one)?(?:'s| is)?|that(?:'s| is)?|these|those|their|its|his|her)\b\s*/i;
/**
 * A spoken correction keeps who (or what) the fact is about (the Jarvis audit F12: "correct that: they
 * prefer calls after 2 pm" had replaced "Synthetic Dental Co prefers calls before 10 am" with the pronoun
 * fragment, losing the business). A fragment that names its own entity is taken as said; one that starts
 * with a pronoun gets the old fact's subject back, lined up on the shared verb ("prefer" ~ "prefers"); a
 * fragment that drops every entity and can't be lined up returns null, so Jarvis asks for the whole fact.
 */
export function keepEntities(oldText: string, fragment: string): string | null {
  const said = fragment.charAt(0).toUpperCase() + fragment.slice(1) + ".";
  const olds = entitiesOf(oldText);
  if (!olds.length) return said;
  const lower = fragment.toLowerCase();
  if (olds.some((e) => lower.includes(e.toLowerCase()))) return said;
  const pm = PRONOUN_START.exec(fragment);
  if (!pm) {
    // Its own subject: the fragment STARTS with a name ("Harbourview Dental prefers …"); a capitalised
    // day or place later in the sentence isn't a subject.
    // One capitalised word is a name only if it isn't an ordinary word of the old fact ("Calls after 2 pm
    // …" is STT's capital, not a new subject; "Mehroz prefers …" names someone).
    const lead = entitiesOf(said)[0];
    if (!lead || !said.startsWith(lead.split(" ")[0])) return null;
    const single = !lead.includes(" ");
    const oldWordSet = new Set(oldText.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
    return !single || !oldWordSet.has(lead.toLowerCase().replace(/[^a-z0-9']/g, "")) ? said : null;
  }
  const copula = /('s| is)$/i.test(pm[0].trim()) ? "is" : /('re| are)$/i.test(pm[0].trim()) ? "are" : null;
  const rest = fragment.slice(pm[0].length).trim();
  const restWords = rest.split(/\s+/).filter(Boolean);
  const verb = (copula ?? restWords[0] ?? "").toLowerCase();
  const tail = copula ? restWords : restWords.slice(1);
  if (!verb || !tail.length) return null;
  const stem = verb.replace(/(?:es|s)$/, "");
  const oldWords = oldText.replace(/[.!?]+$/, "").split(/\s+/);
  const at = oldWords.findIndex((w, i) => {
    if (i === 0) return false;
    const x = w.toLowerCase().replace(/[^a-z']/g, "");
    return x === verb || (stem.length >= 3 && x.replace(/(?:es|s)$/, "") === stem) || ((verb === "is" || verb === "are") && (x === "is" || x === "are"));
  });
  if (at < 1) return null;
  const subject = oldWords.slice(0, at).join(" ");
  if (!olds.some((e) => subject.toLowerCase().includes(e.toLowerCase()))) return null;
  return `${subject} ${oldWords[at]} ${tail.join(" ")}.`.replace(/\s+/g, " ");
}

const reply = (r: Omit<VoiceReply, "handled">): VoiceReply => ({ handled: true, ...r });
const q = (t: string) => `"${t}"`;
const refused = (r: Refusal): VoiceReply => reply({ spoken: r.message, facts_used: [], pending: null, outcome: "refused" });

type Target = { id: string; title: string; text: string; kind: "memory" | "fact" | "note" };

async function resolveTarget(api: MemoryApi, p: Principal, target: string | null, ctx: VoiceContext): Promise<{ hit: Target | null; ambiguous: Target[] }> {
  if (!target) {
    const id = ctx.lastFactsUsed?.[0];
    const it = id ? api.item(id) : null;
    return { hit: it && it.row.status === "current" ? { id: it.row.id, title: it.row.title, text: it.row.text, kind: it.row.kind } : null, ambiguous: [] };
  }
  const rec = await api.recall(p, target, { limit: 3 });
  const top = rec.facts[0];
  if (!top) return { hit: null, ambiguous: [] };
  if (rec.facts.length > 1 && rec.facts[1].score >= top.score * 0.9) return { hit: null, ambiguous: rec.facts.map((f) => ({ id: f.id, title: f.title, text: f.text, kind: f.kind })) };
  // A note hit's text is an excerpt; corrections need the full stored text, which item() has.
  const full = api.item(top.id);
  return { hit: { id: top.id, title: top.title, text: full?.row.kind === "note" ? top.text : (full?.row.text ?? top.text), kind: top.kind }, ambiguous: [] };
}

async function doRemember(api: MemoryApi, p: Principal, text: string, extra: { onConflict?: "keep-both"; reaffirm?: boolean } = {}): Promise<VoiceReply> {
  const r = await api.remember(p, { text, channel: "voice", note: "remember this", ...extra });
  if (r.ok)
    return reply({
      spoken: r.message,
      facts_used: [r.memory.id],
      pending: null,
      outcome: r.duplicate ? "duplicate" : "remembered",
      destination: { kind: "hindsight", id: r.memory.id },
    });
  if (r.code === "conflict" && r.conflicts?.[0])
    return reply({
      spoken: `That disagrees with ${q(r.conflicts[0].title)}, saved ${r.conflicts[0].updated.slice(0, 10)}. Should I replace it, or keep both?`,
      facts_used: r.conflicts.map((c) => c.id),
      pending: { action: "resolve-conflict", text, conflict_id: r.conflicts[0].id, conflict_title: r.conflicts[0].title, destination: "memory" },
      outcome: "needs-confirm",
    });
  if (r.code === "previously-forgotten") return reply({ spoken: `${r.message} Say yes to keep it.`, facts_used: [], pending: { action: "reaffirm", text, destination: "memory" }, outcome: "needs-confirm" });
  return refused(r);
}

async function doVault(api: MemoryApi, p: Principal, input: { text?: string; from_memory?: string }, extra: { onConflict?: "keep-both"; reaffirm?: boolean } = {}): Promise<VoiceReply> {
  const r = await api.saveToVault(p, { ...input, channel: "voice", ...extra });
  if (r.ok)
    return reply({
      spoken: r.message,
      facts_used: [r.fact.wiki_ref],
      pending: null,
      outcome: "saved-to-vault",
      destination: r.destination.kind === "vault" ? { kind: "vault", id: r.fact.wiki_ref, path: r.destination.path, link: r.destination.link } : undefined,
    });
  if (r.code === "conflict" && r.conflicts?.[0] && input.text)
    return reply({
      spoken: `That disagrees with ${q(r.conflicts[0].title)}. Should I replace it, or keep both?`,
      facts_used: r.conflicts.map((c) => c.id),
      pending: { action: "resolve-conflict", text: input.text, conflict_id: r.conflicts[0].id, conflict_title: r.conflicts[0].title, destination: "vault" },
      outcome: "needs-confirm",
    });
  if (r.code === "previously-forgotten" && input.text)
    return reply({ spoken: `${r.message} Say yes to save it.`, facts_used: [], pending: { action: "reaffirm", text: input.text, destination: "vault" }, outcome: "needs-confirm" });
  return refused(r);
}

async function askForget(api: MemoryApi, p: Principal, t: Target, unindex: boolean, opts: VoiceOptions = {}): Promise<VoiceReply> {
  if (unindex) {
    if (t.kind === "memory") return reply({ spoken: `${q(t.title)} is a Jarvis memory, not a vault note. Say "forget that" to delete it.`, facts_used: [t.id], pending: null, outcome: "refused" });
    const r = await api.forget(p, { kind: "unindex", target: t.id });
    return r.ok ? reply({ spoken: r.message, facts_used: [], pending: null, outcome: "unindexed" }) : refused(r);
  }
  const kind: ForgetKind = t.kind === "memory" ? "memory" : "full";
  const r = await api.forget(p, { kind, target: t.id });
  if (!r.ok && r.code === "approval-required" && r.approval) {
    // The approval id and the question stay on the server, keyed to this person; the client only learns a
    // question is pending. Jarvis asks through B2's ONE question registry, so only a yes heard after THIS
    // question can approve it (a typed yes has no spoken-yes event).
    const voice = opts.channel === "voice";
    const question = voice ? api.approvals.ask(r.approval.id, p) : null;
    api.voicePending.set(p, { kind, target: t.id, approval_id: r.approval.id, title: t.title, question_id: question?.questionId ?? null });
    const extra = kind === "full" ? ` That removes it from the vault note, Hindsight and every derived copy (Git history keeps old versions). To only stop indexing it, say "remove that from the index".` : "";
    return reply({
      spoken: `${r.message.replace(/ A program asked for this.*$/, "")}${extra} ${voice ? "Say yes to approve." : "Confirm it with the button on its card on the Memory page."}`,
      facts_used: [t.id],
      pending: { action: "forget", kind, target: t.id, title: t.title },
      outcome: "needs-confirm",
    });
  }
  return r.ok ? reply({ spoken: r.message, facts_used: [], pending: null, outcome: "forgotten" }) : refused(r);
}

async function resolvePending(api: MemoryApi, p: Principal, utterance: string, pending: PendingMemoryAction, opts: VoiceOptions = {}): Promise<VoiceReply | null> {
  const u = utterance.trim();
  if (pending.action === "resolve-conflict") {
    if (KEEP_BOTH.test(u))
      return pending.destination === "vault" ? doVault(api, p, { text: pending.text }, { onConflict: "keep-both" }) : doRemember(api, p, pending.text, { onConflict: "keep-both" });
    if (REPLACE.test(u) || YES.test(u)) {
      const c = await api.correct(p, pending.conflict_id, { text: pending.text, channel: "voice" });
      return c.ok ? reply({ spoken: c.message, facts_used: [c.id], pending: null, outcome: "corrected" }) : refused(c);
    }
    if (NO.test(u)) return reply({ spoken: "Okay, nothing saved.", facts_used: [], pending: null, outcome: "cancelled" });
    return null;
  }
  if (pending.action === "correct") {
    if (YES.test(u) || REPLACE.test(u)) {
      const c = await api.correct(p, pending.id, { text: pending.text, channel: "voice" });
      if (!c.ok && c.code === "already-superseded" && c.conflicts?.[0]) {
        const again = await api.correct(p, c.conflicts[0].id, { text: pending.text, channel: "voice" });
        if (again.ok) return reply({ spoken: again.message, facts_used: [again.id], pending: null, outcome: "corrected" });
      }
      return c.ok ? reply({ spoken: c.message, facts_used: [c.id], pending: null, outcome: "corrected" }) : refused(c);
    }
    if (NO.test(u)) return reply({ spoken: `Okay, "${pending.title}" stays as it is.`, facts_used: [pending.id], pending: null, outcome: "cancelled" });
    return null;
  }
  if (YES.test(u) || (pending.action === "forget" ? FORGET_YES : SAVE_YES).test(u)) {
    if (pending.action === "reaffirm")
      return pending.destination === "vault" ? doVault(api, p, { text: pending.text }, { reaffirm: true }) : doRemember(api, p, pending.text, { reaffirm: true });
    // The spoken yes answers the approval THIS SERVER asked this person about (never an id from the
    // client). B2's service redeems the voice pipeline's own spoken-yes event, bound to the question put,
    // and the server then runs exactly the approved forget. A typed yes, or a yes to another question,
    // approves nothing: the approval stays pending (the Memory page's card, or the Telegram code).
    const asked = api.voicePending.take(p);
    if (!asked || asked.target !== pending.target || asked.kind !== pending.kind)
      return reply({ spoken: "There's nothing waiting for your yes. Ask me to forget it again.", facts_used: [], pending: null, outcome: "refused" });
    if (opts.channel !== "voice")
      return reply({ spoken: "A typed yes can't approve a forget. Use the button on its card, or say yes to Jarvis out loud. Nothing was removed.", facts_used: [pending.target], pending: null, outcome: "needs-confirm" });
    const yes = opts.spokenYes?.() ?? null;
    // No usable spoken yes: put the question again (B2's ONE registry opens a fresh one). The voice ledger
    // closes a question on anything that isn't a whole-utterance yes ("yes, forget it" counts as a no there,
    // S2), so without a fresh question every later yes would fail (REVIEW-T6 finding 4).
    const reask = (why: string) => {
      const q = api.approvals.ask(asked.approval_id, p);
      api.voicePending.set(p, { ...asked, question_id: q?.questionId ?? null });
      return reply({ spoken: `${why} Nothing was removed yet.`, facts_used: [pending.target], pending, outcome: "needs-confirm" });
    };
    if (!yes || !asked.question_id)
      return reask(
        FORGET_YES.test(u) && !YES.test(u)
          ? 'To forget it, just say "yes". Or say "no" to keep it.'
          : "Forgetting needs your spoken yes, said out loud after my question (a typed yes can't approve it). Say yes now, or approve it on the Memory page.",
      );
    const g = await api.approvals.grant(asked.approval_id, p, "voice", { spokenYes: yes, questionId: asked.question_id });
    if (!g.ok && (g.code === "no-spoken-yes" || g.code === "no-question" || g.code === "not-asked"))
      return reask(`${g.reason} Say yes again now, or approve it on the Memory page.`);
    if (!g.ok) return reply({ spoken: `${g.reason} Nothing was removed.`, facts_used: [], pending: null, outcome: "refused" });
    const f = g.result;
    return f.ok
      ? reply({ spoken: `${f.message}${"limits" in f && f.limits.length ? " " + f.limits[0] : ""}`, facts_used: [], pending: null, outcome: "forgotten" })
      : refused(f);
  }
  if (NO.test(u)) {
    if (pending.action === "forget") {
      // An explicit no refuses it (a program's request can't then be approved some other way later).
      const asked = api.voicePending.take(p);
      if (asked && asked.target === pending.target) api.approvals.reject(asked.approval_id, p);
    }
    return reply({ spoken: pending.action === "forget" ? "Okay, I'll keep it." : "Okay, nothing saved.", facts_used: [], pending: null, outcome: "cancelled" });
  }
  return null;
}

const NAMES: Record<string, string> = { usman: "Usman", mehroz: "Mehroz" };
/**
 * "Approve the pending forget": a forget someone asked for (typically a program, Claude Code or Hermes
 * through /__memory/mcp) is read back and put to this person as a question. Their spoken yes approves it,
 * and the server runs it. One at a time, oldest first.
 */
async function reviewApprovals(api: MemoryApi, p: Principal, opts: VoiceOptions): Promise<VoiceReply> {
  const waiting = api.approvals
    .pending()
    .filter((a) => a.state === "pending" && a.action === "memory.forget")
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  if (!waiting.length) return reply({ spoken: "Nothing is waiting for approval.", facts_used: [], pending: null, outcome: "not-found" });
  const a = waiting[0];
  const t = approvalTarget(a.target);
  if (!t || (t.kind !== "memory" && t.kind !== "full"))
    return reply({ spoken: "Something is waiting, but I can't read it out. Check the Memory page.", facts_used: [], pending: null, outcome: "refused" });
  const who = a.requested_actor === "process" ? `A program acting for ${NAMES[a.requested_by] ?? a.requested_by}` : (NAMES[a.requested_by] ?? a.requested_by);
  const more = waiting.length > 1 ? ` (${waiting.length - 1} more after this.)` : "";
  if (opts.channel !== "voice")
    return reply({ spoken: `${who} asked: ${a.display}${more} Approve it by saying yes to Jarvis, or with the code in the requester's Telegram DM.`, facts_used: [], pending: null, outcome: "needs-confirm" });
  const question = api.approvals.ask(a.id, p);
  if (!question) return reply({ spoken: "I couldn't put that question to you. Check the Memory page.", facts_used: [], pending: null, outcome: "refused" });
  const kind = t.kind as ForgetKind;
  api.voicePending.set(p, { kind, target: t.target, approval_id: a.id, title: a.display, question_id: question.questionId });
  return reply({
    spoken: `${who} asked: ${a.display}${more} Say yes to approve it, or no to refuse.`,
    facts_used: [],
    pending: { action: "forget", kind, target: t.target, title: a.display },
    outcome: "needs-confirm",
  });
}

const SOURCE_NOTES = "your Jarvis notes in the vault";
const spokenNote = (h: NoteHit, now: number) => `${spokenNoteDay(h.date, now)}, ${h.text.replace(/\s+/g, " ").slice(0, 150)}`;

/** "read my notes": the notes file first, then the screened memory, each named as its source. Read-only. */
function readNotesAndMemory(api: MemoryApi, notes: NonNullable<VoiceOptions["notes"]>, now: number): VoiceReply {
  const words = ["Latest", "Before that", "And before that"];
  const fromNotes = notes.latest(3).hits.map((h, i) => `${words[i] ?? "Then"}, ${spokenNote(h, now)}`);
  const mems = api.list({ kind: "memory" }).slice(0, 2);
  const parts = [
    fromNotes.length ? `From ${SOURCE_NOTES}: ${fromNotes.join(". ")}.` : "You haven't any Jarvis notes yet.",
    mems.length ? `From Hindsight memory: ${mems.map((m) => m.text.replace(/\s+/g, " ").slice(0, 150)).join(" Also: ")}` : "Nothing is saved in Hindsight memory yet.",
  ];
  return reply({ spoken: parts.join(" "), facts_used: mems.map((m) => m.id), pending: null, outcome: fromNotes.length || mems.length ? "recalled" : "not-found" });
}

/** A recall answer that also searched the notes file: the memory's line (it names its source), then the notes' own. */
function recallWithNotes(r: RecallResult, hits: NoteHit[], searched: boolean, now: number): VoiceReply {
  const found = r.facts_used.length > 0;
  const noted = hits.length ? `From ${SOURCE_NOTES}: ${hits.map((h) => spokenNote(h, now)).join(" Also: ")}` : "";
  const spoken = found ? (noted ? `${r.spoken} ${noted}` : r.spoken) : noted ? `Nothing about that in memory. ${noted}` : searched ? `${r.spoken} Nothing in ${SOURCE_NOTES} either.` : r.spoken;
  return reply({ spoken, facts_used: r.facts_used, pending: null, outcome: found || hits.length ? "recalled" : "not-found" });
}

/** Route one utterance. `handled: false` means "not a memory intent" — pass it to the normal brain. */
export async function handleMemoryUtterance(api: MemoryApi, p: Principal, utterance: string, ctx: VoiceContext = {}, opts: VoiceOptions = {}): Promise<VoiceReply> {
  if (ctx.pending) {
    const r = await resolvePending(api, p, utterance, ctx.pending, opts);
    if (r) return r;
    // Anything else drops the pending question: nothing is removed without an explicit yes.
  }
  const intent = parseMemoryIntent(utterance);
  if (!intent) return { handled: false, spoken: "", facts_used: [], pending: null };

  if (intent.intent === "review-approvals") return reviewApprovals(api, p, opts);
  if (intent.intent === "remember-what") return reply({ spoken: "Remember what?", facts_used: [], pending: null, outcome: "not-found" });
  if (intent.intent === "notes-read") return opts.notes ? readNotesAndMemory(api, opts.notes, Date.now()) : { handled: false, spoken: "", facts_used: [], pending: null };
  if (intent.intent === "remember") return doRemember(api, p, intent.text);
  if (intent.intent === "vault") {
    if (intent.text) return doVault(api, p, { text: intent.text });
    const mem = ctx.lastFactsUsed?.find((r) => r.startsWith("mem-"));
    if (!mem) return reply({ spoken: 'Which one? Say "save this to the vault:" and the fact.', facts_used: [], pending: null, outcome: "not-found" });
    return doVault(api, p, { from_memory: mem });
  }
  if (intent.intent === "recall") {
    const r: RecallResult = await api.recall(p, intent.query);
    if (opts.notes) return recallWithNotes(r, opts.notes.search(intent.query).hits, true, Date.now());
    return reply({ spoken: r.spoken, facts_used: r.facts_used, pending: null, outcome: r.facts_used.length ? "recalled" : "not-found" });
  }

  const { hit, ambiguous } = await resolveTarget(api, p, intent.target, ctx);
  if (ambiguous.length)
    return reply({ spoken: `I found a few: ${ambiguous.map((a) => q(a.title)).join(", ")}. Which one?`, facts_used: ambiguous.map((a) => a.id), pending: null, outcome: "not-found" });
  if (!hit)
    return reply({
      spoken: intent.target ? `I can't find anything saved about ${intent.target}.` : "Which one? Ask me about it first, then say correct that or forget that.",
      facts_used: [],
      pending: null,
      outcome: "not-found",
    });

  if (intent.intent === "forget") return askForget(api, p, hit, intent.unindex, opts);

  if (hit.kind === "note")
    return reply({ spoken: `${q(hit.title)} is a whole vault note. Edit it in Obsidian and I'll pick up the change.`, facts_used: [hit.id], pending: null, outcome: "refused" });
  const text = applySpokenCorrection(hit.text, intent.text);
  if (!text)
    return reply({ spoken: `Say the full corrected fact for ${q(hit.title)}, including who or what it's about, so it still makes sense on its own.`, facts_used: [hit.id], pending: null, outcome: "refused" });
  // Read it back first: nothing is superseded until the person says yes to exactly this change.
  return reply({
    spoken: `Update ${q(hit.title)} from ${q(hit.text.replace(/\s+/g, " "))} to ${q(text)}? Say yes to update it, or no to leave it.`,
    facts_used: [hit.id],
    pending: { action: "correct", id: hit.id, title: hit.title, text },
    outcome: "needs-confirm",
  });
}

// ── Tool-calling surface ───────────────────────────────────────────────────────────────

export const MEMORY_VOICE_TOOLS = [
  {
    name: "remember_fact",
    description:
      "Keep ONE short fact the user explicitly asked you to remember (\"remember that…\"). Goes to Hindsight memory only (not the vault). Never pass chat logs, call transcripts, email bodies, bank details or secrets — they are refused.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, one or two sentences." },
        bucket: { type: "string", enum: ["business", "finance", "deen", "research", "personal", "general"] },
      },
      required: ["text"],
    },
  },
  {
    name: "save_to_vault",
    description:
      "Save ONE curated fact into the Obsidian vault (\"save this to the vault\"), or move a mem-… memory there with from_memory. Sensitive personal details are refused (they stay in memory).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        from_memory: { type: "string", description: "A mem-… id to move into the vault instead of text." },
        bucket: { type: "string", enum: ["business", "finance", "deen", "research", "personal", "general"] },
      },
    },
  },
  {
    name: "recall_memory",
    description: "Look up saved knowledge (\"what do we know about…\"). Answer only from what comes back and name each source (vault note path or memory id).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "correct_fact",
    description: "Replace a saved fact (mf-… vault fact or mem-… memory) with a corrected version. The old version is retracted from Hindsight and kept marked superseded.",
    parameters: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
  },
  {
    name: "forget_memory",
    description:
      "Ask to forget something. kind 'unindex' = stop indexing a vault note/fact (keeps the note); 'memory' = delete a mem-… memory; 'full' = remove vault content and every derived copy. 'memory' and 'full' return approval-required: read the plan to the user. You cannot approve it yourself; the user approves by saying yes or on the Memory page.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, kind: { type: "string", enum: ["unindex", "memory", "full"] } },
      required: ["id", "kind"],
    },
  },
] as const;

export type MemoryToolName = (typeof MEMORY_VOICE_TOOLS)[number]["name"];

/** Execute one tool call. Returns a JSON-safe result the model can read, always with facts_used. */
export async function runMemoryTool(api: MemoryApi, p: Principal, name: string, args: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const bucket = (v: unknown) => (["business", "finance", "deen", "research", "personal", "general"].includes(s(v)) ? (s(v) as Bucket) : undefined);
  switch (name) {
    case "remember_fact": {
      const r = await api.remember(p, { text: s(args.text), bucket: bucket(args.bucket), channel: "tool" });
      return r.ok ? { ok: true, id: r.memory.id, destination: r.destination, message: r.message, facts_used: [r.memory.id] } : { ...r, facts_used: r.conflicts?.map((c) => c.id) ?? [] };
    }
    case "save_to_vault": {
      const r = await api.saveToVault(p, { text: s(args.text) || undefined, from_memory: s(args.from_memory) || undefined, bucket: bucket(args.bucket), channel: "tool" });
      return r.ok ? { ok: true, id: r.fact.wiki_ref, destination: r.destination, message: r.message, facts_used: [r.fact.wiki_ref] } : { ...r, facts_used: [] };
    }
    case "recall_memory": {
      const r = await api.recall(p, s(args.query));
      return {
        ok: true,
        facts: r.facts.map((f) => ({ id: f.id, text: f.text, source: f.source, version: f.version, date: f.date })),
        hindsight: r.hindsight,
        facts_used: r.facts_used,
        instruction: r.facts_used.length ? "Answer only from these and name the source of each." : "Nothing saved. Say so; do not guess.",
      };
    }
    case "correct_fact": {
      const r = await api.correct(p, s(args.id), { text: s(args.text), channel: "tool" });
      return r.ok ? { ok: true, id: r.id, superseded: r.previous_id, message: r.message, facts_used: [r.id] } : { ...r, facts_used: [] };
    }
    case "forget_memory": {
      const kind = args.kind === "unindex" || args.kind === "memory" || args.kind === "full" ? args.kind : ("" as never);
      // No approval id is accepted from the model.
      const r = await api.forget(p, { kind, target: s(args.id) });
      return r.ok ? { ok: true, message: r.message, limits: r.limits, facts_used: [] } : { ...r, facts_used: [] };
    }
    default:
      return { ok: false, code: "invalid", message: `Unknown memory tool: ${name}`, facts_used: [] };
  }
}
