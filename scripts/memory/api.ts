/**
 * The memory API: one shared business-memory pool over Obsidian + Hindsight.
 *
 *   remember      "remember this"            → Hindsight-only memory `mem-…` + local provenance record
 *   saveToVault   "save this to the vault"   → a fact block in the bucket's vault note, then indexed
 *   recall        facts with source (vault path + Obsidian link, or mem- id), version and date
 *   correct       the old version is retracted from Hindsight and kept locally marked superseded
 *   forget        (a) unindex — retract, keep the note   (b) memory — delete a Hindsight-only memory
 *                 (c) full — source + derived copies, vault section edited conflict-safely
 *                 (b) and (c) need a server-held approval (approvals.ts); tombstones stop resurrection
 *
 * One switch, MU_MEMORY_WRITES (settings.ts): "on" for every mutation and Hindsight write, "read"
 * for Hindsight recall only, anything else keeps memory read-only with no Hindsight call at all.
 * The caller is a Principal supplied by the host route (never from the request body), and is
 * recorded as provenance. No bulk delete or bank clear exists anywhere in this API.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SpokenLedger } from "../approvals/service";
import { approvalTarget, headingForKey, headingKey, localApprovals, type Approvals, type CodeNotifier, type GrantChannel, type GrantProof, type MemoryApprovalView } from "./approvals";
import { createConnector, memoryDoc, syncKey, type ConnectorOptions } from "./connector";
import { contentHash, excerpt, likelyConflict, searchDocs, sha256 } from "./derived";
import { screenFact, screenOrigin } from "./guard";
import { resolveMemorySettings } from "./settings";
import { parseFrontmatter } from "./vault";
import {
  VaultConflictError,
  factPagePath,
  headingSectionText,
  listFactPages,
  noteHash,
  readFactPage,
  readNoteRaw,
  removeBlocks,
  removeHeadingSection,
  sanitiseText,
  sanitiseTitle,
  writeFactPage,
  writeNoteIfUnchanged,
} from "./wiki-store";
import {
  isBucket,
  isPrincipal,
  type ActorRecord,
  type Bucket,
  type Channel,
  type CorrectResult,
  type Destination,
  type Fact,
  type ForgetKind,
  type ForgetPlan,
  type ForgetResult,
  type ForgetSection,
  type IndexDoc,
  type IndexState,
  type MemoryRow,
  type MemoryRecord,
  type Principal,
  type RecallResult,
  type RecalledFact,
  type Refusal,
  type RememberResult,
  type SaveToVaultResult,
  type SourceRef,
  type Tombstone,
  type UsageReceipt,
} from "./types";

export * from "./types";

export type MemoryApiOptions = Partial<Omit<ConnectorOptions, "settings">> & {
  settings?: ConnectorOptions["settings"];
  /**
   * The durable approvals (B2's service, Track 6). The main OS passes the process-wide one; by default a
   * copy keeps its own `approvals.sqlite` in its state dir (opened on first use).
   */
  approvals?: Approvals | (() => Approvals);
  /** The spoken-yes ledger a default store's questions use (tests inject their own). */
  spoken?: SpokenLedger;
  /** Sends a program's one-time code to the requester's Telegram DM (default store only). */
  notify?: CodeNotifier;
  /** How long a capture waits for Hindsight before answering "queued". */
  indexWaitMs?: number;
};

const refuse = (code: Refusal["code"], message: string, extra: Partial<Refusal> = {}): Refusal => ({ ok: false, code, message, ...extra });

const BUCKET_WORDS: [Bucket, RegExp][] = [
  ["deen", /\b(quran|qur'an|salah|salat|prayer|masjid|mosque|hifz|hafiz|ramadan|jumu'?ah|dua|deen|islam\w*)\b/i],
  ["finance", /\b(invest\w*|etf|shares?|stocks?|broker|ibkr|portfolio|halal screen\w*|super(annuation)?|budget|savings?|nab|bank)\b/i],
  ["research", /\b(itqan|model|dataset|checkpoint|training|research|paper|eval\w*|benchmark)\b/i],
  ["personal", /\b(birthday|family|marriage|wedding|wife|mum|dad|brother|sister|health|gym|personal)\b/i],
  ["business", /\b(clients?|packages?|pricing|prices?|receptionists?|retell|twilio|leads?|proposals?|invoices?|invoiced|websites?|m&u|mu ventures|sales|decks?|demos?|agency|bookings?|sms|kickoff|clinics?|onboarding|customers?|prospects?|campaigns?|outreach|accounts?|retainers?|billed|billing|quotes?)\b/i],
];
export function inferBucket(text: string): Bucket {
  for (const [bucket, re] of BUCKET_WORDS) if (re.test(text)) return bucket;
  return "general";
}
/** Longest derived title before it is cut (on a word boundary, with "…"); sanitiseTitle caps at 90. */
export const TITLE_MAX = 80;
const capitalise = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Saved fact");
/**
 * A title from the fact's first sentence. Short sentences are kept whole, so the key fact isn't
 * dropped ("…review call is on Thursday at 10am", not "…on Thursday at"); a long one is cut on a
 * word boundary and marked with "…" so it never reads as the whole fact (audit MEM-4).
 */
export function deriveTitle(text: string) {
  const first = (text.split(/(?<=[.!?])\s|\n/)[0] || text).replace(/[.!?]+$/, "");
  const whole = sanitiseTitle(first);
  if (whole.length <= TITLE_MAX) return capitalise(whole);
  const cut = whole.slice(0, TITLE_MAX);
  const atWord = cut.lastIndexOf(" ") > TITLE_MAX / 2 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return capitalise(`${atWord.replace(/[\s,;:–—-]+$/, "")}…`);
}
/** The title rule before MEM-4 (first nine words): a title made that way still counts as derived. */
const legacyDeriveTitle = (text: string) => {
  const first = text.split(/(?<=[.!?])\s|\n/)[0] || text;
  return capitalise(sanitiseTitle(first.replace(/[.!?]+$/, "").split(/\s+/).slice(0, 9).join(" ")));
};
const isDerivedTitle = (title: string, text: string) => title === deriveTitle(text) || title === legacyDeriveTitle(text);
const newId = (prefix: "mem" | "mf", taken: Set<string>) => {
  for (;;) {
    const id = `${prefix}-${randomBytes(5).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
};
const normalise = (text: string) => text.replace(/\r\n?/g, "\n").trim();

export const FULL_FORGET_LIMITS = [
  "The wiki is a Git repository: earlier commits still contain the removed text until that history is rewritten (for example with git filter-repo) and every clone and remote is updated. This app does not rewrite Git history.",
  "Copies outside this PC's vault folder are not touched: Obsidian Sync, cloud drives, other clones, and backups of the vault.",
  "Hindsight's database backups and Postgres write-ahead log keep deleted bytes until they are rotated or vacuumed; if Hindsight's LLM tracing is on, its request log can hold the text for up to a day.",
];
export const MEMORY_FORGET_LIMITS = [
  "Hindsight's database backups and Postgres write-ahead log keep deleted bytes until they are rotated or vacuumed; if Hindsight's LLM tracing is on, its request log can hold the text for up to a day.",
  "Backups of this PC's app data (.operator-data) taken before now still contain the memory until they expire.",
];

/** A forget Jarvis asked about: the approval and the question put (both server-side only). */
export type VoicePendingForget = { kind: ForgetKind; target: string; approval_id: string; title: string; question_id?: string | null };

export function createMemoryApi(options: MemoryApiOptions = {}) {
  const settings = options.settings ?? resolveMemorySettings();
  const c = createConnector({ ...options, settings });
  let approvalsCache: Approvals | null = null;
  const A = (): Approvals =>
    (approvalsCache ??=
      typeof options.approvals === "function"
        ? options.approvals()
        : (options.approvals ?? localApprovals(settings.stateDir, { spoken: options.spoken, now: () => c.now().getTime(), notify: options.notify })));
  const approvals = { require: (req: Parameters<Approvals["require"]>[0]) => A().require(req) };
  const store = c.store;
  const waitMs = options.indexWaitMs ?? 30_000;
  const voicePending = new Map<string, VoicePendingForget & { at: number }>();

  function checkPrincipal(p: Principal) {
    if (!isPrincipal(p)) throw Object.assign(new Error("Memory needs a signed-in person."), { status: 401 });
  }
  const actorOf = (p: Principal): ActorRecord => ({ id: p.id, name: p.name, via: p.via });
  const writesOff = () =>
    settings.writes
      ? null
      : refuse("writes-disabled", "Memory writing is off (MU_MEMORY_WRITES is not on), so nothing was saved or changed. The lead switches it on after acceptance.");

  // ── lookups ─────────────────────────────────────────────────────────────────────────
  function allVaultFacts(): Fact[] {
    return listFactPages(settings.vaultRoot).flatMap((path) => {
      const bucket = (/^wiki\/topics\/([a-z]+)\//.exec(path)?.[1] ?? "general") as Bucket;
      return readFactPage(settings.vaultRoot, isBucket(bucket) ? bucket : "general", path).facts;
    });
  }
  const lookupPath = (facts: Fact[]) => {
    const m = new Map(facts.map((f) => [f.wiki_ref, f.source.path]));
    return (ref: string) => m.get(ref);
  };
  const noteIdFor = (path: string) => store.readNotes()[path]?.id ?? null;
  const vaultSource = (path: string, noteId: string, link: string, block?: string): SourceRef => ({
    kind: "vault",
    path,
    note_id: noteId,
    link,
    uri: `obsidian://open?vault=${encodeURIComponent(settings.vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/i, ""))}`,
    ...(block ? { block } : {}),
  });

  function destinationFor(kind: "hindsight" | "vault", id: string, extra?: { path: string; link: string; uri: string }): Destination {
    const indexed = c.indexState(id);
    if (kind === "hindsight") return { kind, id, indexed, label: "Hindsight memory (not in the vault)" };
    return { kind, id, path: extra!.path, link: extra!.link, uri: extra!.uri, indexed, label: "Obsidian vault note" };
  }
  /** Why a save is waiting, from what the connector last saw (not always "unreachable"). */
  const queuedWhy = () => {
    const st = c.hindsightState();
    return st === "proxy-writes-off"
      ? "the Hindsight proxy's write switch is off"
      : st === "writer-refused"
        ? "the Hindsight proxy didn't accept this OS as the memory writer"
      : st === "unavailable"
        ? "it isn't reachable right now"
        : st === "auth-failed"
          ? "the Hindsight proxy didn't accept this process"
          : st === "removals-waiting"
            ? "Hindsight's removal limit is reached; it goes through shortly"
            : "it goes through in the background";
  };
  const indexedPhrase = (s: IndexState) =>
    s === "confirmed"
      ? "indexed in Hindsight"
      : s === "sending"
        ? "still being processed by Hindsight (it's saved here; indexing finishes in the background)"
        : s === "queued"
        ? `queued for Hindsight (${queuedWhy()}; nothing is lost)`
        : s === "disabled"
          ? "only in this app's local index (Hindsight is off)"
          : s === "writes-off"
            ? "not sent to Hindsight (writes are off)"
            : "not indexed";
  /** What happened on the Hindsight side of a removal, from the real state (never "retracted" while it is off). */
  const hindsightOff = () => !settings.hindsight.enabled;
  const OFF_NOTHING_SENT = "Hindsight is off, so nothing was sent there";

  type ConflictInfo = NonNullable<Refusal["conflicts"]>[number];
  function conflictsWith(text: string, exceptChain?: string): ConflictInfo[] {
    const out: ConflictInfo[] = [];
    for (const d of c.desired().values()) {
      if (d.kind === "note" || (exceptChain && d.chain === exceptChain)) continue;
      if (likelyConflict(d.content, text)) out.push({ id: d.id, title: d.title, text: d.content, source: d.source, updated: d.updated });
    }
    return out.slice(0, 5);
  }
  const tombstonedHash = (hash: string) => store.readTombstones().some((t) => t.content_hash === hash);
  function liftTombstones(hash: string) {
    store.writeTombstones(store.readTombstones().map((t) => (t.content_hash === hash ? { ...t, content_hash: `lifted:${t.content_hash}` } : t)));
  }

  // ── capture ─────────────────────────────────────────────────────────────────────────
  async function remember(
    p: Principal,
    input: { text: string; title?: string; bucket?: Bucket; channel?: Channel; note?: string; onConflict?: "keep-both"; reaffirm?: boolean },
  ): Promise<RememberResult> {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    const screened = screenFact(input?.text, input?.title);
    if (!screened.ok) return refuse(screened.code, screened.message);
    const note = screenOrigin({ note: input.note });
    if (!note.ok) return refuse(note.code, note.message);
    if (input.bucket !== undefined && !isBucket(input.bucket)) return refuse("invalid", "Unknown bucket.");
    const text = normalise(input.text);
    const hash = contentHash(text);

    const r = await c.serial((): Refusal | { record: MemoryRecord; duplicate: boolean } => {
      if (!input.reaffirm && tombstonedHash(hash))
        return refuse("previously-forgotten", "You asked me to forget this before. Say it again to confirm you want it kept.");
      const memories = store.readMemories();
      const same = memories.find((m) => m.status === "current" && m.content_hash === hash);
      if (same) return { record: same, duplicate: true };
      const inVault = [...c.desired().values()].find((d) => d.kind === "fact" && contentHash(d.content) === hash);
      if (inVault)
        return refuse("conflict", `That's already saved in the vault (${inVault.source.kind === "vault" ? inVault.source.path : inVault.id}).`, {
          conflicts: [{ id: inVault.id, title: inVault.title, text: inVault.content, source: inVault.source, updated: inVault.updated }],
        });
      const conflicts = conflictsWith(text);
      if (conflicts.length && input.onConflict !== "keep-both")
        return refuse("conflict", "This looks like it disagrees with something already saved. Correct the old one, or keep both.", { conflicts });
      const at = c.iso();
      const id = newId("mem", new Set([...memories.map((m) => m.id), ...store.readTombstones().map((t) => t.id)]));
      const record: MemoryRecord = {
        id,
        chain: id,
        version: 1,
        title: sanitiseTitle(input.title ?? "") || deriveTitle(text),
        text,
        bucket: input.bucket ?? inferBucket(`${input.title ?? ""} ${text}`),
        status: "current",
        created: at,
        updated: at,
        actor: actorOf(p),
        origin: input.channel === "ui" ? "ui" : input.channel === "agent" ? "agent" : "jarvis",
        channel: input.channel ?? "voice",
        ...(input.note ? { note: input.note.slice(0, 200) } : {}),
        supersedes: null,
        superseded_by: null,
        content_hash: hash,
      };
      store.writeMemories([...memories, record]);
      if (input.reaffirm) liftTombstones(hash);
      c.reconcile();
      return { record, duplicate: false };
    });
    if ("ok" in r) return r;
    if (!r.duplicate) await c.drainSoon(waitMs);
    const destination = destinationFor("hindsight", r.record.id);
    const message = r.duplicate
      ? `Already remembered as ${r.record.id} ("${r.record.title}").`
      : `Remembered ${hindsightOff() ? "as" : "in Hindsight memory as"} ${r.record.id} ("${r.record.title}"): ${indexedPhrase(destination.indexed)}. Not written to the vault.`;
    return { ok: true, memory: r.record, duplicate: r.duplicate, destination, message };
  }

  async function saveToVault(
    p: Principal,
    input: { text?: string; title?: string; bucket?: Bucket; channel?: Channel; note?: string; from_memory?: string; onConflict?: "keep-both"; expected_hash?: string; reaffirm?: boolean },
  ): Promise<SaveToVaultResult> {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    let text = input?.text ?? "";
    let title = input?.title;
    let bucket = input?.bucket;
    let from: MemoryRecord | undefined;
    if (input?.from_memory) {
      from = store.readMemories().find((m) => m.id === input.from_memory && m.status === "current");
      if (!from) return refuse("not-found", "I can't find that memory to save to the vault.");
      text = from.text;
      title ??= from.title;
      bucket ??= from.bucket;
    }
    const screened = screenFact(text, title);
    if (!screened.ok) return refuse(screened.code, screened.message);
    const origin = screenOrigin({ note: input.note });
    if (!origin.ok) return refuse(origin.code, origin.message);
    if (bucket !== undefined && !isBucket(bucket)) return refuse("invalid", "Unknown bucket.");
    const clean = sanitiseText(normalise(text));
    const hash = contentHash(clean);
    const b: Bucket = bucket ?? inferBucket(`${title ?? ""} ${clean}`);

    const r = await c.serial((): Refusal | { fact: Fact; duplicate: boolean } => {
      if (!input.reaffirm && tombstonedHash(hash)) return refuse("previously-forgotten", "You asked me to forget this before. Say it again to confirm you want it saved.");
      const page = readFactPage(settings.vaultRoot, b);
      if (input.expected_hash && page.hash !== input.expected_hash) return refuse("vault-conflict", new VaultConflictError(page.path).message);
      const same = page.facts.find((f) => f.status === "current" && contentHash(f.text) === hash);
      if (same) return { fact: same, duplicate: true };
      const conflicts = conflictsWith(clean, from?.chain).filter((x) => x.id !== from?.id);
      if (conflicts.length && input.onConflict !== "keep-both")
        return refuse("conflict", "This looks like it disagrees with something already saved. Correct the old one, or keep both.", { conflicts });
      const all = allVaultFacts();
      const at = c.iso();
      const ref = newId("mf", new Set([...all.map((f) => f.wiki_ref), ...store.readTombstones().map((t) => t.id)]));
      const fact: Fact = {
        wiki_ref: ref,
        chain: ref,
        version: 1,
        title: sanitiseTitle(title ?? "") || deriveTitle(clean),
        text: clean,
        bucket: b,
        status: "current",
        created: at,
        updated: at,
        saved_by: p.name,
        origin: {
          kind: input.channel === "ui" ? "ui" : input.channel === "agent" ? "agent" : "voice",
          ...(from ? { ref: from.id } : {}),
          ...(input.note ? { note: input.note.slice(0, 200) } : {}),
        },
        supersedes: null,
        superseded_by: null,
        source: { path: page.path, wiki_ref: ref, link: "" },
      };
      try {
        writeFactPage(settings.vaultRoot, page, [...page.facts, fact], at.slice(0, 10), lookupPath([...all, fact]));
      } catch (e) {
        if (e instanceof VaultConflictError) return refuse("vault-conflict", e.message);
        throw e;
      }
      if (from) {
        // Promoted: the vault note is now the source; the Hindsight-only copy is retracted (no duplicates).
        store.writeMemories(store.readMemories().map((m) => (m.id === from!.id ? { ...m, status: "promoted", superseded_by: ref, updated: at } : m)));
      }
      if (input.reaffirm) liftTombstones(hash);
      c.scan();
      c.reconcile();
      return { fact: readFactPage(settings.vaultRoot, b).facts.find((f) => f.wiki_ref === ref)!, duplicate: false };
    });
    if ("ok" in r) return r;
    if (!r.duplicate) await c.drainSoon(waitMs);
    const path = r.fact.source.path;
    const noteId = noteIdFor(path) ?? "";
    const src = vaultSource(path, noteId, r.fact.source.link, r.fact.wiki_ref) as Extract<SourceRef, { kind: "vault" }>;
    const destination = destinationFor("vault", r.fact.wiki_ref, { path, link: src.link, uri: src.uri });
    const message = r.duplicate
      ? `Already in the vault note ${path} as ${src.link}.`
      : `Saved to the vault note ${path} as ${src.link}${from ? ` (moved from ${from.id})` : ""}. It is ${indexedPhrase(destination.indexed)}.`;
    return { ok: true, fact: r.fact, destination, message };
  }

  // ── correct ─────────────────────────────────────────────────────────────────────────
  async function correct(p: Principal, id: string, input: { text: string; title?: string; expected_version_hash?: string; channel?: Channel }): Promise<CorrectResult> {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    const screened = screenFact(input?.text, input?.title);
    if (!screened.ok) return refuse(screened.code, screened.message);
    const text = normalise(input.text);

    if (typeof id === "string" && id.startsWith("mem-")) {
      const r = await c.serial((): Refusal | { fresh: MemoryRecord; old: MemoryRecord } => {
        const memories = store.readMemories();
        const old = memories.find((m) => m.id === id);
        if (!old) return refuse("not-found", "I can't find that memory.");
        if (old.status !== "current") {
          const cur = memories.find((m) => m.chain === old.chain && m.status === "current");
          return refuse("already-superseded", "That memory was already corrected. Correct the current version instead.", {
            conflicts: cur ? [{ id: cur.id, title: cur.title, text: cur.text, source: { kind: "memory", id: cur.id }, updated: cur.updated }] : [],
          });
        }
        if (input.expected_version_hash && memoryDoc(old).version_hash !== input.expected_version_hash)
          return refuse("conflict", "That memory changed since you opened it. Reload and try again.");
        if (contentHash(text) === old.content_hash) return refuse("invalid", "That's the same as what's saved.");
        const at = c.iso();
        const freshId = newId("mem", new Set([...memories.map((m) => m.id), ...store.readTombstones().map((t) => t.id)]));
        const fresh: MemoryRecord = {
          ...old,
          id: freshId,
          version: old.version + 1,
          title: sanitiseTitle(input.title ?? "") || (isDerivedTitle(old.title, old.text) ? deriveTitle(text) : old.title),
          text,
          status: "current",
          created: at,
          updated: at,
          actor: actorOf(p),
          channel: input.channel ?? old.channel,
          supersedes: old.id,
          superseded_by: null,
          content_hash: contentHash(text),
        };
        store.writeMemories([...memories.map((m) => (m.id === old.id ? { ...m, status: "superseded" as const, superseded_by: freshId, updated: at } : m)), fresh]);
        c.reconcile();
        return { fresh, old };
      });
      if ("ok" in r) return r;
      await c.drainSoon(waitMs);
      const destination = destinationFor("hindsight", r.fresh.id);
      const oldGone = c.indexState(r.old.id) !== "queued";
      return {
        ok: true,
        id: r.fresh.id,
        previous_id: r.old.id,
        destination,
        message: `Corrected: ${r.fresh.id} replaces ${r.old.id}, which is kept here marked superseded${
          hindsightOff() ? ` and dropped from the local index (${OFF_NOTHING_SENT})` : oldGone && settings.writes ? " and retracted from Hindsight" : " and queued for retraction from Hindsight"
        }. The new version is ${indexedPhrase(destination.indexed)}.`,
      };
    }

    if (typeof id === "string" && id.startsWith("mf-")) {
      const clean = sanitiseText(text);
      const r = await c.serial((): Refusal | { fresh: Fact; old: Fact } => {
        const all = allVaultFacts();
        const old = all.find((f) => f.wiki_ref === id);
        if (!old) return refuse("not-found", "I can't find that fact in the vault.");
        if (old.status !== "current") {
          const cur = all.find((f) => f.chain === old.chain && f.status === "current");
          return refuse("already-superseded", "That fact was already corrected. Correct the current version instead.", {
            conflicts: cur ? [{ id: cur.wiki_ref, title: cur.title, text: cur.text, source: vaultSource(cur.source.path, noteIdFor(cur.source.path) ?? "", cur.source.link, cur.wiki_ref), updated: cur.updated }] : [],
          });
        }
        if (input.expected_version_hash && sha256(`${old.title}\n${old.text}`) !== input.expected_version_hash)
          return refuse("vault-conflict", "That fact changed in the vault since you opened it. Nothing was overwritten; reload and try again.");
        if (contentHash(clean) === contentHash(old.text)) return refuse("invalid", "That's the same as what's saved.");
        const page = readFactPage(settings.vaultRoot, old.bucket, old.source.path);
        const at = c.iso();
        const ref = newId("mf", new Set([...all.map((f) => f.wiki_ref), ...store.readTombstones().map((t) => t.id)]));
        const fresh: Fact = {
          ...old,
          wiki_ref: ref,
          version: old.version + 1,
          title: sanitiseTitle(input.title ?? "") || (isDerivedTitle(old.title, old.text) ? deriveTitle(clean) : old.title),
          text: clean,
          status: "current",
          created: at,
          updated: at,
          saved_by: p.name,
          origin: { kind: input.channel === "ui" ? "ui" : "voice", note: "correction" },
          supersedes: old.wiki_ref,
          superseded_by: null,
          source: { path: old.source.path, wiki_ref: ref, link: "" },
        };
        const next: Fact[] = [];
        for (const f of page.facts) {
          next.push(f.wiki_ref === old.wiki_ref ? { ...f, status: "superseded", superseded_by: ref, updated: at } : f);
          if (f.wiki_ref === old.wiki_ref) next.push(fresh);
        }
        try {
          writeFactPage(settings.vaultRoot, page, next, at.slice(0, 10), lookupPath([...all, fresh]));
        } catch (e) {
          if (e instanceof VaultConflictError) return refuse("vault-conflict", e.message);
          throw e;
        }
        c.scan();
        c.reconcile();
        return { fresh, old };
      });
      if ("ok" in r) return r;
      await c.drainSoon(waitMs);
      const path = r.fresh.source.path;
      const src = vaultSource(path, noteIdFor(path) ?? "", `[[${path.split("/").pop()!.replace(/\.md$/, "")}#^${r.fresh.wiki_ref}]]`, r.fresh.wiki_ref) as Extract<SourceRef, { kind: "vault" }>;
      const destination = destinationFor("vault", r.fresh.wiki_ref, { path, link: src.link, uri: src.uri });
      return {
        ok: true,
        id: r.fresh.wiki_ref,
        previous_id: r.old.wiki_ref,
        destination,
        message: `Corrected in the vault note ${path}: ${r.fresh.wiki_ref} replaces ${r.old.wiki_ref}, which stays in the note marked superseded and is no longer indexed. The new version is ${indexedPhrase(destination.indexed)}.`,
      };
    }
    return refuse("not-a-fact", "That's a whole vault note. Edit it in Obsidian; the connector re-indexes the change.");
  }

  // ── recall ──────────────────────────────────────────────────────────────────────────
  function toRecalled(d: IndexDoc, query: string): RecalledFact {
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      text: d.kind === "note" ? excerpt(d.content, query) : d.content,
      source: d.source,
      version: d.version,
      version_hash: d.version_hash,
      date: d.updated,
      origin: d.origin,
      actor: d.actor ?? null,
      indexed: c.indexState(d.id),
      processed_by: c.processedBy(d.id),
      via: [],
      score: 0,
    };
  }
  const sourceLabel = (s: SourceRef) => (s.kind === "vault" ? `vault note ${s.path}` : `Jarvis memory ${s.id}`);

  async function recall(p: Principal, query: string, opts: { limit?: number } = {}): Promise<RecallResult> {
    checkPrincipal(p);
    const q = (typeof query === "string" ? query : "").slice(0, 500).trim();
    // Memory off means off for READS too (round 10): nothing is read from the vault, the local index or Hindsight, and the answer says so.
    if (settings.mode === "off") return { ok: true, query: q, facts: [], facts_used: [], spoken: "Memory is off here, so I didn't look anything up.", hindsight: c.hindsightState(), suppressed: 0, off: "memory is off (MU_MEMORY_WRITES=off): no recall from the vault, the local index or Hindsight" };
    const want = c.desired();
    const facts = new Map<string, RecalledFact>();
    let suppressed = 0;
    const hsr = q ? await c.recallHindsight(q) : { state: c.hindsightState(), hits: [] };
    const index = store.readIndex();
    hsr.hits.forEach((h, rank) => {
      const doc = h.document_id ? want.get(h.document_id) : undefined;
      const entry = doc ? index[doc.id] : undefined;
      // Forgotten, superseded, unindexed, foreign or not-yet-confirmed (stale) documents never reach an answer.
      if (!doc || !entry || entry.inflight || entry.purge || entry.sync_key !== syncKey(doc)) return void suppressed++;
      const f = facts.get(doc.id) ?? toRecalled(doc, q);
      if (!f.via.includes("hindsight")) f.via.push("hindsight");
      (f.hindsight_text ??= []).push(h.text);
      f.score += 5 / (1 + rank);
      facts.set(doc.id, f);
    });
    for (const hit of q ? searchDocs([...want.values()], q, 8) : []) {
      const f = facts.get(hit.doc.id) ?? toRecalled(hit.doc, q);
      f.via.push("local");
      f.score += hit.score;
      facts.set(hit.doc.id, f);
    }
    const ranked = [...facts.values()].map((f) => ({ ...f, score: Math.round(f.score * 1000) / 1000 })).sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 6);
    const unavailable = hsr.state === "unavailable" || hsr.state === "auth-failed";
    // No vault scan has run yet: the vault's notes aren't in the index, so "nothing saved" would be a guess (MEM-6).
    const indexBuilt = store.readStatus().last_scan_at !== null;
    const spoken = ranked.length
      ? `Here's what's saved: ${ranked
          .slice(0, 3)
          .map((f) => `${f.text.replace(/\s+/g, " ")} (from the ${sourceLabel(f.source)})`)
          .join(" Also: ")}`
      : !indexBuilt
        ? `The memory index isn't built yet (the vault hasn't been scanned), so I can't tell whether anything is saved about that${unavailable ? ", and Hindsight isn't reachable right now" : ""}. Run Sync now on the Memory page, then ask again.`
        : unavailable
          ? "I don't have anything saved about that in the local index, and Hindsight isn't reachable right now."
          : "I don't have anything saved about that.";
    return { ok: true, query: q, facts: ranked, facts_used: ranked.map((f) => f.id), spoken, hindsight: hsr.state, suppressed, index_built: indexBuilt };
  }

  // ── browse ──────────────────────────────────────────────────────────────────────────
  function rowOf(d: IndexDoc, status: MemoryRow["status"]): MemoryRow {
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      text: d.kind === "note" ? excerpt(d.content, d.title, 400) : d.content,
      bucket: d.bucket,
      source: d.source,
      version: d.version,
      version_hash: d.version_hash,
      date: d.updated,
      actor: d.actor ?? null,
      status,
      indexed: status === "current" ? c.indexState(d.id) : "not-indexed",
      destination_label: d.kind === "memory" ? "Hindsight memory" : d.kind === "fact" ? "Vault fact" : "Vault note",
      processed_by: status === "current" ? c.processedBy(d.id) : null,
    };
  }
  function memoryRow(m: MemoryRecord): MemoryRow {
    return rowOf(memoryDoc(m), m.status);
  }
  function factRow(f: Fact): MemoryRow {
    const d: IndexDoc = {
      id: f.wiki_ref,
      kind: "fact",
      origin: "obsidian",
      title: f.title,
      content: f.text,
      bucket: f.bucket,
      version: f.version,
      version_hash: sha256(`${f.title}\n${f.text}`),
      updated: f.updated,
      source: vaultSource(f.source.path, noteIdFor(f.source.path) ?? "", f.source.link, f.wiki_ref),
      actor: f.saved_by,
      chain: f.chain,
    };
    return rowOf(d, f.status);
  }

  function list(opts: { kind?: IndexDoc["kind"]; bucket?: Bucket; q?: string; includeSuperseded?: boolean } = {}): MemoryRow[] {
    const want = c.desired();
    const excluded = new Set(store.readExclusions().map((e) => e.id));
    let rows: MemoryRow[];
    if (opts.q?.trim()) rows = searchDocs([...want.values()], opts.q, 30).map((h) => rowOf(h.doc, "current"));
    else {
      rows = [...want.values()].map((d) => rowOf(d, "current"));
      for (const d of store.readVaultDocs())
        if (!want.has(d.id) && (excluded.has(d.id) || (d.source.kind === "vault" && excluded.has(d.source.note_id)))) rows.push(rowOf(d, "excluded"));
      if (opts.includeSuperseded) {
        rows.push(...store.readMemories().filter((m) => m.status !== "current").map(memoryRow));
        rows.push(...allVaultFacts().filter((f) => f.status === "superseded").map(factRow));
      }
      rows.sort((a, b) => b.date.localeCompare(a.date));
    }
    return rows.filter((r) => (!opts.kind || r.kind === opts.kind) && (!opts.bucket || r.bucket === opts.bucket));
  }

  function item(id: string): { row: MemoryRow; history: MemoryRow[]; forget: ForgetKind[] } | null {
    if (typeof id !== "string") return null;
    if (id.startsWith("mem-")) {
      const mems = store.readMemories();
      const m = mems.find((x) => x.id === id);
      if (!m) return null;
      return { row: memoryRow(m), history: mems.filter((x) => x.chain === m.chain).sort((a, b) => a.version - b.version).map(memoryRow), forget: ["memory"] };
    }
    if (id.startsWith("mf-")) {
      const all = allVaultFacts();
      const f = all.find((x) => x.wiki_ref === id);
      if (!f) return null;
      const row = factRow(f);
      const excluded = store.readExclusions().some((e) => e.id === id || e.id === (row.source as { note_id?: string }).note_id);
      if (excluded && f.status === "current") (row.status = "excluded"), (row.indexed = "not-indexed");
      return { row, history: all.filter((x) => x.chain === f.chain).sort((a, b) => a.version - b.version).map(factRow), forget: ["unindex", "full"] };
    }
    const d = store.readVaultDocs().find((x) => x.id === id || (x.kind === "note" && x.source.kind === "vault" && x.source.path === id));
    if (!d) return null;
    const excluded = !c.desired().has(d.id);
    return { row: rowOf(d, excluded ? "excluded" : "current"), history: [], forget: ["unindex", "full"] };
  }

  /**
   * The agents' read-only view (L7): built from ONE connector.desired() pass, so tombstones and path
   * exclusions apply to lists and by-id reads alike (item() reads the store directly and would still
   * show a forgotten fact whose vault write conflicted). No indexed/processed_by lookups, so it is
   * O(N) not O(N^2). Current, wanted documents only; anything that throws reads as "nothing".
   */
  type ReadableDoc = { id: string; kind: IndexDoc["kind"]; title: string; text: string; bucket: Bucket; source: SourceRef; version: number; date: string };
  const readableOf = (d: IndexDoc): ReadableDoc => ({
    id: d.id,
    kind: d.kind,
    title: d.title,
    text: d.kind === "note" ? excerpt(d.content, d.title, 400) : d.content,
    bucket: d.bucket,
    source: d.source,
    version: d.version,
    date: d.updated,
  });
  function readable(opts: { bucket?: Bucket; q?: string; vaultOnly?: boolean } = {}): ReadableDoc[] {
    const want = [...c.desired().values()];
    const docs = opts.q?.trim() ? searchDocs(want, opts.q, 30).map((h) => h.doc) : want.sort((a, b) => b.updated.localeCompare(a.updated));
    return docs.filter((d) => (!opts.bucket || d.bucket === opts.bucket) && (!opts.vaultOnly || d.kind !== "memory")).map(readableOf);
  }
  function readableOne(id: string): ReadableDoc | null {
    if (typeof id !== "string" || !id) return null;
    const want = c.desired();
    const d = want.get(id) ?? [...want.values()].find((x) => x.kind === "note" && x.source.kind === "vault" && x.source.path === id);
    return d ? readableOf(d) : null;
  }

  function factsUsed(refs: string[]) {
    const want = c.desired();
    const out = { facts: [] as MemoryRow[], missing: [] as string[] };
    for (const ref of [...new Set((Array.isArray(refs) ? refs : []).filter((r) => typeof r === "string"))].slice(0, 50)) {
      const d = want.get(ref);
      if (d) out.facts.push(rowOf(d, "current"));
      else out.missing.push(ref);
    }
    return out;
  }

  // ── forget ──────────────────────────────────────────────────────────────────────────
  type Resolved = { path: string; noteId: string; raw: string; docs: IndexDoc[] };
  function resolveNote(target: string): Resolved | null {
    const notes = store.readNotes();
    const path = notes[target] && !notes[target].missing_since ? target : Object.entries(notes).find(([, e]) => e.id === target && !e.missing_since)?.[0];
    if (!path) return null;
    const raw = readNoteRaw(settings.vaultRoot, path);
    if (raw === null) return null;
    return { path, noteId: notes[path].id, raw: raw.replace(/\r\n/g, "\n"), docs: store.readVaultDocs().filter((d) => d.source.kind === "vault" && d.source.path === path) };
  }
  /**
   * What an approval is bound to: the kind, target, source section, the note's hash, the content
   * hashes and the memory ids that will be deleted. Not the sync state (which Hindsight documents
   * happen to be confirmed right now), so a background sync can't invalidate a fresh approval.
   */
  const digestOf = (plan: Omit<ForgetPlan, "digest">, hashes: string[]) =>
    sha256(JSON.stringify({ kind: plan.kind, target: plan.target, source: plan.source ?? null, memories: [...plan.derived.memories].sort(), hashes: [...hashes].sort() }));

  type Built = { plan: ForgetPlan; hashes: string[]; chainFacts?: Fact[]; section?: string; memories?: MemoryRecord[] } | Refusal;

  function buildPlan(kind: ForgetKind, target: string, heading?: string): Built {
    const index = store.readIndex();
    const want = c.desired();
    const inIndex = (id: string) => id in index;
    if (kind === "memory") {
      if (!target.startsWith("mem-")) return refuse("invalid", "Only a Hindsight-only memory (mem-…) can be deleted this way. Use 'full' for vault content.");
      const mems = store.readMemories();
      const m = mems.find((x) => x.id === target);
      if (!m) return refuse("not-found", "I can't find that memory.");
      const chain = mems.filter((x) => x.chain === m.chain);
      const ids = chain.map((x) => x.id);
      const base = {
        kind,
        target,
        title: m.title,
        derived: { hindsight_docs: ids.filter(inIndex), memories: ids, local_index: ids.filter((i) => want.has(i)) },
      };
      const hashes = chain.map((x) => x.content_hash);
      return { plan: { ...base, digest: digestOf(base, hashes) }, hashes, memories: chain };
    }
    if (target.startsWith("mem-")) return refuse("invalid", "A Hindsight-only memory has no vault note. Use kind 'memory' to delete it.");

    if (target.startsWith("mf-")) {
      const all = allVaultFacts();
      const f = all.find((x) => x.wiki_ref === target);
      if (!f) return refuse("not-found", "I can't find that fact in the vault.");
      const raw = readNoteRaw(settings.vaultRoot, f.source.path) ?? "";
      const noteId = noteIdFor(f.source.path) ?? "";
      if (kind === "unindex") {
        const base = {
          kind,
          target,
          title: f.title,
          source: { path: f.source.path, note_id: noteId, section: { kind: "block", ref: f.wiki_ref } as ForgetSection, note_hash: noteHash(raw)! },
          derived: { hindsight_docs: [f.wiki_ref].filter(inIndex), memories: [], local_index: [f.wiki_ref].filter((i) => want.has(i)) },
        };
        return { plan: { ...base, digest: digestOf(base, []) }, hashes: [] };
      }
      const chain = all.filter((x) => x.chain === f.chain);
      const refs = new Set(chain.map((x) => x.wiki_ref));
      const hashes = chain.map((x) => contentHash(x.text));
      const memories = store.readMemories().filter((m) => hashes.includes(m.content_hash) || (m.superseded_by && refs.has(m.superseded_by)));
      const base = {
        kind,
        target,
        title: f.title,
        source: { path: f.source.path, note_id: noteId, section: { kind: "block", ref: f.wiki_ref } as ForgetSection, note_hash: noteHash(raw)! },
        derived: {
          hindsight_docs: [...refs, ...memories.map((m) => m.id)].filter(inIndex),
          memories: memories.map((m) => m.id),
          local_index: [...refs, ...memories.map((m) => m.id)].filter((i) => want.has(i)),
        },
      };
      return { plan: { ...base, digest: digestOf(base, hashes) }, hashes, chainFacts: chain, memories };
    }

    const note = resolveNote(target);
    if (!note) return refuse("not-found", "I can't find that vault note (use its path or note id).");
    const title = note.docs.find((d) => d.kind === "note")?.title ?? note.path;
    const docIds = note.docs.map((d) => d.id);
    if (kind === "unindex") {
      const base = {
        kind,
        target: note.noteId,
        title,
        source: { path: note.path, note_id: note.noteId, section: { kind: "note" } as ForgetSection, note_hash: noteHash(note.raw)! },
        derived: { hindsight_docs: docIds.filter(inIndex), memories: [], local_index: docIds.filter((i) => want.has(i)) },
      };
      return { plan: { ...base, digest: digestOf(base, []) }, hashes: [] };
    }
    if (heading) {
      const { body } = parseFrontmatter(note.raw);
      const section = headingSectionText(body, heading);
      if (section === null) return refuse("not-found", `There's no "${heading}" section in ${note.path}.`);
      const hash = contentHash(section);
      const memories = store.readMemories().filter((m) => m.content_hash === hash);
      const base = {
        kind,
        target: note.noteId,
        title: `${title} › ${heading}`,
        source: { path: note.path, note_id: note.noteId, section: { kind: "heading", heading } as ForgetSection, note_hash: noteHash(note.raw)! },
        derived: {
          hindsight_docs: [note.noteId, ...memories.map((m) => m.id)].filter(inIndex),
          memories: memories.map((m) => m.id),
          local_index: [note.noteId, ...memories.map((m) => m.id)].filter((i) => want.has(i)),
        },
      };
      return { plan: { ...base, digest: digestOf(base, [hash]) }, hashes: [hash], section };
    }
    const blockRefs = new Set(note.docs.filter((d) => d.kind === "fact").map((d) => d.id));
    const hashes = [contentHash(parseFrontmatter(note.raw).body), ...note.docs.map((d) => contentHash(d.content))];
    const memories = store.readMemories().filter((m) => hashes.includes(m.content_hash) || (m.superseded_by && blockRefs.has(m.superseded_by)));
    const base = {
      kind,
      target: note.noteId,
      title,
      source: { path: note.path, note_id: note.noteId, section: { kind: "note" } as ForgetSection, note_hash: noteHash(note.raw)! },
      derived: {
        hindsight_docs: [...docIds, ...memories.map((m) => m.id)].filter(inIndex),
        memories: memories.map((m) => m.id),
        local_index: [...docIds, ...memories.map((m) => m.id)].filter((i) => want.has(i)),
      },
    };
    return { plan: { ...base, digest: digestOf(base, hashes) }, hashes, memories };
  }

  type Pending = Extract<ReturnType<Approvals["require"]>, { status: "pending" }>;
  function approvalRef(d: Pending, digest: string) {
    return {
      id: d.approvalId,
      expires_at: d.expiresAt,
      digest,
      requested_actor: d.requestedActor,
      approve_with: d.requestedActor === "human" ? ("button" as const) : ("voice-or-telegram" as const),
      ...(d.telegram ? { telegram: d.telegram } : {}),
    };
  }
  /** A program's request can't be approved by a click (B2): say how it can be. */
  function howToApprove(d: Pending) {
    if (d.requestedActor === "human") return "";
    return d.telegram === "sending" || d.telegram === "sent"
      ? " A program asked for this, so a click can't approve it: either founder can say yes to Jarvis (\"approve the pending forget\"), or the requester answers the code being sent to their Telegram DM. It runs as soon as it's approved."
      : " A program asked for this, so a click can't approve it: either founder can say yes to Jarvis (\"approve the pending forget\"); the Telegram code couldn't be sent. It runs as soon as it's approved.";
  }

  /**
   * What actually happened in Hindsight after a forget, per store, in words (the Jarvis audit F12: a forget
   * said "deleted from Hindsight" while Hindsight was off). `resent`: a section forget re-sends that note
   * without the section, so its document stays (rewritten), it isn't deleted.
   */
  function hindsightReport(docs: string[], opts: { resent?: string | null } = {}): { state: "confirmed" | "queued" | "disabled"; line: string } {
    if (!settings.hindsight.enabled) return { state: "disabled", line: "Hindsight is off here, so nothing of it was stored there and nothing needed deleting" };
    const index = store.readIndex();
    const gone = docs.filter((d) => d !== opts.resent);
    const pendingDel = gone.filter((d) => d in index);
    const resentPending = opts.resent ? !!index[opts.resent]?.purge || !!store.readOutbox().some((o) => o.doc_id === opts.resent) : false;
    const st = c.hindsightState();
    const why =
      st === "unavailable" ? "Hindsight isn't reachable right now; it retries" : st === "auth-failed" ? "Hindsight refused the credentials; see the Memory page" : st === "proxy-writes-off" ? "Hindsight's write gate is off, so it waits until writes are on again" : st === "writer-refused" ? "the Hindsight proxy didn't accept this OS as the writer; see the Memory page" : !settings.writes ? "memory writes are off here, so it waits" : "finishing in the background";
    const parts: string[] = [];
    if (!docs.length) parts.push("it was never indexed in Hindsight");
    else if (gone.length) parts.push(pendingDel.length ? `${pendingDel.length} Hindsight document(s) queued for deletion (${why})` : `${gone.length} Hindsight document(s) deleted`);
    if (opts.resent) parts.push(resentPending ? `the note's Hindsight copy is queued to be rewritten without it (${why})` : "the note's Hindsight copy was rewritten without it");
    return { state: pendingDel.length || resentPending ? "queued" : "confirmed", line: parts.join(", and ") };
  }

  /** What the approvals store keeps: ids and counts, never a title or text (it outlives the forget). */
  function storedSummaryOf(plan: ForgetPlan) {
    if (plan.kind === "memory") return `Delete Hindsight memory ${plan.target} (${plan.derived.memories.length} version(s)).`;
    const src = plan.source;
    const where = src?.section.kind === "block" ? `vault fact ${plan.target} in note ${src.note_id}` : src?.section.kind === "heading" ? `a section of vault note ${src.note_id}` : `vault note ${plan.target}`;
    return `Forget ${where} everywhere: ${plan.derived.hindsight_docs.length} Hindsight document(s), ${plan.derived.memories.length} derived memory copy(ies).`;
  }
  /** A readable description of a pending approval, from the store as it is now (never from the approvals store). */
  /** The section heading an approval's hashed key stands for, read from the note as it is now. */
  function headingOf(t: { target: string; headingKey?: string }): string | undefined {
    if (!t.headingKey) return undefined;
    const note = resolveNote(t.target);
    return (note && headingForKey(parseFrontmatter(note.raw).body, t.headingKey)) ?? undefined;
  }
  function describeApproval(a: MemoryApprovalView): string {
    const t = approvalTarget(a.target);
    if (a.action === "memory.bulk-retract" || !t) return a.summary;
    const heading = headingOf(t);
    if (t.headingKey && !heading) return a.summary;
    const built = t.kind === "memory" || t.kind === "full" ? buildPlan(t.kind, t.target, heading) : null;
    return built && !("ok" in built) ? summaryOf(built.plan) : a.summary;
  }

  function summaryOf(plan: ForgetPlan) {
    const where = plan.source ? ` in ${plan.source.path}` : "";
    return plan.kind === "memory"
      ? `Delete Hindsight memory "${plan.title}" (${plan.derived.memories.length} version(s)).`
      : `Forget "${plan.title}"${where} everywhere: the vault ${plan.source?.section.kind === "note" ? "note" : "section"}, ${plan.derived.hindsight_docs.length} Hindsight document(s) and ${plan.derived.memories.length} derived memory copy(ies).`;
  }

  async function forget(p: Principal, input: { kind: ForgetKind; target: string; heading?: string; approval_id?: string | null }): Promise<ForgetResult> {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    const kind = input?.kind;
    if (kind !== "unindex" && kind !== "memory" && kind !== "full") return refuse("invalid", "Say which kind of forget: unindex, memory or full.");
    // One target per request: no lists, wildcards or "everything".
    if (typeof input.target !== "string" || !input.target || input.target.length > 300 || /[*?,\s]/.test(input.target.replace(/ /g, "-")))
      return refuse("invalid", "Forget one item at a time (an id or a note path). There is no bulk forget.");
    if (input.heading !== undefined && (typeof input.heading !== "string" || kind !== "full")) return refuse("invalid", "A section heading only applies to a full forget.");

    const outcome = await c.serial(async (): Promise<ForgetResult | { exec: () => ForgetResult }> => {
      const built = buildPlan(kind, input.target, input.heading);
      if ("ok" in built) return built;
      const { plan } = built;

      if (kind === "unindex") {
        const at = c.iso();
        const ex = store.readExclusions();
        const id = plan.target;
        if (!ex.some((e) => e.id === id)) store.writeExclusions([...ex, { id, path: plan.source?.path, excluded_at: at, by: p.name }]);
        c.reconcile();
        return {
          exec: () => ({
            ok: true,
            kind,
            removed: { vault: null, hindsight_docs: plan.derived.hindsight_docs, memories: [], local_index: plan.derived.local_index },
            hindsight: plan.derived.hindsight_docs.some((d) => d in store.readIndex()) ? "queued" : settings.hindsight.enabled && settings.writes ? "confirmed" : c.indexState(id),
            message: `Removed "${plan.title}" from the index. The note stays in the vault at ${plan.source?.path}; it won't be re-indexed until you re-include it (Re-include in index, on its page in Memory).`,
            limits: [],
          }),
        };
      }

      // The stored summary names ids only (the approvals store outlives the forget, so it must never hold the
      // text being forgotten); the readable one goes to the person asked (reply, Telegram), never to disk.
      const decision = approvals.require({
        action: "memory.forget",
        target: `${kind}:${plan.target}${input.heading ? `#${headingKey(input.heading)}` : ""}`,
        digest: plan.digest,
        principal: p,
        approvalId: input.approval_id ?? null,
        summary: storedSummaryOf(plan),
        display: summaryOf(plan),
      });
      if (decision.status === "pending")
        return refuse("approval-required", `${summaryOf(plan)} This needs approval first.${howToApprove(decision)}`, { plan, approval: approvalRef(decision, plan.digest) });
      if (decision.status === "denied")
        return refuse(
          "approval-denied",
          decision.reason === "mismatch"
            ? "The item changed since that approval was given (or the approval was for something else). Nothing was removed; ask again."
            : decision.reason === "expired"
              ? "That approval expired. Nothing was removed; ask again."
              : decision.reason === "consumed"
                ? "That approval was already used. Nothing was removed; ask again."
                : decision.reason === "not-yours"
                  ? "That approval was given by someone else; only they can use it. Nothing was removed."
                  : "That approval isn't known to this server. Nothing was removed.",
          { plan },
        );

      const at = c.iso();
      const stones: Tombstone[] = [];
      const stone = (id: string, hash: string, k: Tombstone["kind"], path?: string) =>
        stones.push({ id, content_hash: hash, kind: k, ...(path ? { source_path: path } : {}), forgotten_at: at, forgotten_by: p.name, approval_id: decision.approvalId });

      if (kind === "memory") {
        for (const m of built.memories ?? []) stone(m.id, m.content_hash, "memory");
        store.writeTombstones([...store.readTombstones(), ...stones]);
        const ids = new Set(stones.map((s) => s.id));
        store.writeMemories(store.readMemories().filter((m) => !ids.has(m.id)));
        c.reconcile();
        return {
          exec: () => ({
            ok: true,
            kind,
            removed: { vault: null, hindsight_docs: plan.derived.hindsight_docs, memories: plan.derived.memories, local_index: plan.derived.local_index },
            ...(() => {
              const hs = hindsightReport(plan.derived.hindsight_docs);
              return {
                hindsight: hs.state,
                message: `Deleted the memory "${plan.title}" (${plan.derived.memories.length} version(s)): removed from this app's store and the local index; ${hs.line}. A tombstone stops it coming back.`,
              };
            })(),
            limits: MEMORY_FORGET_LIMITS,
          }),
        };
      }

      // Full forget: tombstones first (every read path and every future sync refuses it), then the vault edit.
      const src = plan.source!;
      const raw = readNoteRaw(settings.vaultRoot, src.path);
      let next: string | null;
      if (src.section.kind === "block") {
        for (const f of built.chainFacts ?? []) stone(f.wiki_ref, contentHash(f.text), "fact", src.path);
        next = removeBlocks(raw ?? "", new Set((built.chainFacts ?? []).map((f) => f.wiki_ref)));
      } else if (src.section.kind === "heading") {
        stone(`${src.note_id}#${src.section.heading}`, built.hashes[0], "section", src.path);
        const { fields: _f, body } = parseFrontmatter(raw ?? "");
        const head = (raw ?? "").replace(/\r\n/g, "\n").slice(0, (raw ?? "").replace(/\r\n/g, "\n").length - body.length);
        next = head + (removeHeadingSection(body, src.section.heading) ?? body);
      } else {
        stone(src.note_id, built.hashes[0], "note", src.path);
        for (const d of store.readVaultDocs().filter((x) => x.source.kind === "vault" && x.source.path === src.path && x.kind === "fact")) stone(d.id, contentHash(d.content), "fact", src.path);
        next = null;
      }
      for (const m of built.memories ?? []) stone(m.id, m.content_hash, "memory");
      store.writeTombstones([...store.readTombstones(), ...stones]);
      const memIds = new Set((built.memories ?? []).map((m) => m.id));
      store.writeMemories(store.readMemories().filter((m) => !memIds.has(m.id)));
      try {
        writeNoteIfUnchanged(settings.vaultRoot, src.path, src.note_hash, next);
      } catch (e) {
        if (!(e instanceof VaultConflictError)) throw e;
        c.scan();
        c.reconcile();
        return refuse(
          "vault-conflict",
          `${e.message} It is already hidden from recall and queued for removal from Hindsight, but the text is still in the note. Ask to forget it again to finish.`,
        );
      }
      if (src.section.kind === "heading") {
        const index = store.readIndex();
        if (index[src.note_id]) (index[src.note_id].purge = true), store.writeIndex(index);
      }
      if (src.section.kind === "note") {
        const notes = store.readNotes();
        delete notes[src.path];
        store.writeNotes(notes);
      }
      c.scan();
      c.reconcile();
      return {
        exec: () => {
          const hs = hindsightReport(plan.derived.hindsight_docs, { resent: src.section.kind === "heading" ? src.note_id : null });
          return {
            ok: true,
            kind,
            removed: {
              vault: `${src.path}${src.section.kind === "block" ? `#^${src.section.ref}` : src.section.kind === "heading" ? `#${src.section.heading}` : ""}`,
              hindsight_docs: plan.derived.hindsight_docs,
              memories: plan.derived.memories,
              local_index: plan.derived.local_index,
            },
            hindsight: hs.state,
            message: `Forgot "${plan.title}": ${src.section.kind === "note" ? "the note was deleted from" : "the section was removed from"} ${src.path}, ${plan.derived.memories.length} derived memory copy(ies) deleted, the local index updated; ${hs.line}. Tombstones stop a sync or a restored file bringing it back.`,
            limits: FULL_FORGET_LIMITS,
          };
        },
      };
    });
    if ("ok" in outcome) return outcome;
    await c.drainSoon(waitMs);
    return outcome.exec();
  }

  async function reindex(p: Principal, target: string) {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    const note = resolveNote(target);
    const ids = new Set([target, ...(note ? [note.noteId, note.path] : [])]);
    const before = store.readExclusions();
    const after = before.filter((e) => !ids.has(e.id));
    if (after.length === before.length) return refuse("not-found", "That isn't excluded from the index.");
    await c.serial(() => {
      store.writeExclusions(after);
      c.reconcile();
    });
    await c.drainSoon(waitMs);
    return { ok: true as const, message: "Re-included in the index.", indexed: c.indexState(note?.noteId ?? target) };
  }

  function usage() {
    const receipts = store.readReceipts();
    const byOp: Record<string, { calls: number; ok: number; failed: number; tokens_known: number; tokens_unknown_calls: number; avg_latency_ms: number }> = {};
    for (const r of receipts) {
      const o = (byOp[r.op] ??= { calls: 0, ok: 0, failed: 0, tokens_known: 0, tokens_unknown_calls: 0, avg_latency_ms: 0 });
      o.avg_latency_ms = Math.round((o.avg_latency_ms * o.calls + r.latency_ms) / (o.calls + 1));
      o.calls++;
      if (r.outcome === "ok" || r.outcome === "not-found") o.ok++;
      else o.failed++;
      if (r.tokens) o.tokens_known += r.tokens.total;
      else o.tokens_unknown_calls++;
    }
    return {
      cost_basis: "Hindsight's processing model is recorded per save (processing log); the OS sees no bill, so cash stays unknown (not zero).",
      by_op: byOp,
      recent: receipts.slice(-50).reverse() as UsageReceipt[],
      models: c.status().models,
    };
  }

  /**
   * Release removals the connector held because too many documents vanished from the vault at once.
   * Same approval path as a forget: the first call returns approval-required with a server-held id;
   * after the grant (Memory page, page token) the second call releases exactly that set.
   */
  async function releaseHeld(p: Principal, input: { approval_id?: string | null; digest?: string | null } = {}): Promise<{ ok: true; message: string; released: number } | Refusal> {
    checkPrincipal(p);
    const off = writesOff();
    if (off) return off;
    const held = c.heldNow();
    if (!held) return refuse("nothing-held", "Nothing is held: no mass removal is waiting.");
    // Bound to what the page showed: if the held set changed since, nothing is released.
    if (input.digest && input.digest !== held.digest) return refuse("approval-denied", "What is held changed since the page showed it. Nothing was removed; review the list again.");
    const summary = `Remove ${held.ids.length} documents from Hindsight that vanished from the vault at once (for example ${held.ids.slice(0, 3).join(", ")}).`;
    const decision = approvals.require({ action: "memory.bulk-retract", target: `vanished:${held.ids.length}`, digest: held.digest, principal: p, approvalId: input.approval_id ?? null, summary, display: summary });
    if (decision.status === "pending") return refuse("approval-required", `${summary} This needs approval first.${howToApprove(decision)}`, { approval: approvalRef(decision, held.digest) });
    if (decision.status === "denied") return refuse("approval-denied", "That approval doesn't match what is held now (or expired, or was used). Nothing was removed.");
    if (!c.releaseHeld(held.digest, p.name, decision.approvalId)) return refuse("approval-denied", "What is held changed since the approval. Nothing was removed; ask again.");
    await c.drainSoon(waitMs);
    return { ok: true, message: `Released: ${held.ids.length} vanished documents are being removed from Hindsight.`, released: held.ids.length };
  }

  /**
   * A person approves (card, spoken yes or Telegram code): B2 decides whether that evidence may answer this
   * request, and on approval the server runs exactly the approved forget (or release) at once, bound to the
   * approval's target and plan digest. Nobody has to send it again, and a changed item voids the approval.
   */
  async function grantAndRun(id: string, p: Principal, channel: GrantChannel, proof: GrantProof) {
    checkPrincipal(p);
    const g = A().grant(id, p, channel, proof);
    if (!g.ok) return g;
    const result = await runApproved(g.approval, p);
    return { ...g, result };
  }
  async function runApproved(a: MemoryApprovalView, p: Principal): Promise<ForgetResult | Awaited<ReturnType<typeof releaseHeld>>> {
    const t = approvalTarget(a.target);
    let result: ForgetResult | Awaited<ReturnType<typeof releaseHeld>>;
    if (a.action === "memory.bulk-retract") result = await releaseHeld(p, { approval_id: a.id });
    else if (t && (t.kind === "memory" || t.kind === "full")) {
      const heading = headingOf(t);
      result =
        t.headingKey && !heading
          ? refuse("approval-denied", "That section isn't in the note any more. Nothing was removed.")
          : await forget(p, { kind: t.kind, target: t.target, ...(heading ? { heading } : {}), approval_id: a.id });
    }
    else result = refuse("invalid", "That approval isn't for a forget this server can run.");
    // Written once, only when the approval was actually used (a changed item voids it instead).
    if (A().get(a.id)?.state === "consumed") A().recordOutcome(a.id, result.ok ? "succeeded" : "failed");
    return result;
  }
  /**
   * "approve K7PQ-M4XZ" / "deny K7PQ-M4XZ" from the requester's own Telegram DM, for the approval the
   * approval service matched that code to (telegram-codes.ts; misses are counted there). The replies name
   * ids only, never the item's title or text: Telegram and Hermes keep their history (REVIEW-T6 finding 6).
   */
  async function answerTelegram(approvalId: string, p: Principal, yes: boolean, code: string): Promise<string> {
    if (!isPrincipal(p) || p.via !== "telegram") return "Only your own Telegram DM can answer this. Nothing was done.";
    const a = A().get(approvalId);
    if (!a || !A().telegramAnswerable(approvalId)) return "That approval isn't waiting any more. Nothing was done.";
    if (!yes) {
      const r = A().reject(approvalId, p);
      return r.ok ? `OK, refused: ${a.summary} Nothing was removed.` : `${r.reason} Nothing was removed.`;
    }
    // Answer within the relay's window: the forget keeps running if Hindsight is slow.
    const run = grantAndRun(approvalId, p, "telegram", { telegramCode: code });
    const late = new Promise<"late">((r) => setTimeout(() => r("late"), 15_000));
    const g = await Promise.race([run, late]);
    if (g === "late") return `Approved: ${a.summary} It's running now; the Memory page shows when it's done.`;
    if (!g.ok) return `${g.reason}`;
    const r = g.result;
    if (!r.ok) return `Approved, but it didn't run (${r.code}). Nothing was removed; see the Memory page.`;
    const hs = "hindsight" in r ? (r.hindsight === "confirmed" ? "done in Hindsight too" : r.hindsight === "queued" ? "Hindsight's copy is queued for deletion" : "Hindsight is off here") : "";
    return `Approved and done: ${a.summary}${hs ? ` (${hs})` : ""}`;
  }

  return {
    settings,
    connector: c,
    remember,
    saveToVault,
    recall,
    correct,
    forget,
    reindex,
    releaseHeld,
    list,
    item,
    readable,
    readableOne,
    factsUsed,
    usage,
    sync: (opts?: { force?: boolean; waitMs?: number }) => c.sync(opts),
    status: () => c.status(),
    approvals: {
      /** Pending (and approved, unused) forget approvals, each described from the store as it is now. */
      pending: (): (MemoryApprovalView & { display: string })[] => A().pending().map((a) => ({ ...a, display: describeApproval(a) })),
      get: (id: string) => A().get(id),
      /** The Memory page rendered this approval's card in a verified browser session: its confirm nonce. */
      card: (id: string, p: Principal) => {
        checkPrincipal(p);
        return A().card(id, p);
      },
      /** Server-internal (the voice path): Jarvis is asking this person about this approval now. */
      ask: (id: string, p: Principal) => A().ask(id, p),
      grant: grantAndRun,
      reject: (id: string, p: Principal) => {
        checkPrincipal(p);
        return A().reject(id, p);
      },
      answerTelegram,
      /** The approval service (the Telegram relay claims codes against it). */
      service: () => A().service,
      /** People whose Telegram approval codes are paused right now (3 wrong codes): shown on the Memory page. */
      lockouts: () => {
        try {
          return A().service.codeLockouts();
        } catch {
          return [];
        }
      },
    },
    /**
     * The voice turn's pending forget lives HERE, keyed by principal, never in the client's
     * context: a spoken "yes" can only grant the approval this server asked that person about.
     */
    voicePending: {
      set: (p: Principal, pending: VoicePendingForget) => voicePending.set(p.id, { ...pending, at: c.now().getTime() }),
      take: (p: Principal): VoicePendingForget | null => {
        const v = voicePending.get(p.id);
        voicePending.delete(p.id);
        return v && c.now().getTime() - v.at < 10 * 60_000 ? v : null;
      },
      clear: (p: Principal) => void voicePending.delete(p.id),
    },
    paths: { vaultRoot: settings.vaultRoot, stateDir: settings.stateDir, factPage: factPagePath },
  };
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
/** @deprecated name kept so the file layout stays recognisable for the integration merge. */
export type MemoryVaultApi = MemoryApi;
