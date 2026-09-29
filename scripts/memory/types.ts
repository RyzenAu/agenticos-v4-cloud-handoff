/**
 * Memory connector contract (28 Sep 2026, V5 §2). Types only — no Node imports — so the React
 * Memory component and the Jev/Jarvis track can import them without pulling in `node:fs`.
 *
 * Roles:
 *  - Obsidian (the M&U wiki vault) is authoritative for curated notes and "save to the vault" facts.
 *  - Hindsight does contextual memory and retrieval: an index of permitted vault notes plus
 *    Hindsight-only memories captured through Jarvis ("remember this", ids `mem-…`).
 *  - AgenticOS (this module) is the interface, permission, sync and provenance layer.
 *
 * ONE shared business-memory pool: there are no per-person scopes. Who saved or changed
 * something is recorded as provenance (`actor`), never used to hide it.
 */

export const BUCKETS = ["business", "finance", "deen", "research", "personal", "general"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Who is calling. Supplied by the host route from the verified OS request context
 * (loopback owner or a Tailscale-vouched person). Never read from a request body or Host header.
 */
/** `actor` (Stage B1): "process" for Hermes, Claude Code, scripts; "human" for a browser session or spoken turn. */
export type Principal = {
  id: string;
  name: string;
  via: "local" | "tailnet" | "telegram" | "voice" | "system";
  actor?: "human" | "process";
  /**
   * B1's own resolved principal (Track 6), kept only on the server: the approval service needs its via,
   * actor, session key and device to decide who may approve. Never written to a store or a response.
   */
  os?: { personId: string; via: string; actor?: "human" | "process"; sessionId?: string; deviceId?: string };
};

/** Where a document originally came from. */
export type Origin = "obsidian" | "jarvis" | "ui" | "agent";
/** How a capture arrived (a channel label, never a transcript). */
export type Channel = "voice" | "ui" | "tool" | "agent";

export type VaultSource = {
  kind: "vault";
  /** Path relative to the vault root, forward slashes. */
  path: string;
  /** Stable note id (frontmatter `id`, or the connector's persisted path→id map). */
  note_id: string;
  /** Wiki link: `[[slug]]`, or `[[slug#^mf-…]]` for one fact block. */
  link: string;
  /** `obsidian://open?vault=…&file=…` */
  uri: string;
  /** For a fact block: its `mf-…` ref. */
  block?: string;
};
export type MemorySource = { kind: "memory"; id: string };
export type SourceRef = VaultSource | MemorySource;

export type DocKind = "note" | "fact" | "memory";

/** One document the connector wants Hindsight to hold (document_id = id). */
export type IndexDoc = {
  id: string;
  kind: DocKind;
  origin: Origin;
  title: string;
  content: string;
  bucket: Bucket;
  version: number;
  /** sha256 of the indexed content: the version Hindsight should hold. */
  version_hash: string;
  /** ISO date of this version (note mtime, fact update, memory capture). */
  updated: string;
  source: SourceRef;
  actor?: string;
  chain?: string;
};

export type ActorRecord = { id: string; name: string; via: Principal["via"] };

/** A Hindsight-only memory ("remember this"). Its local record is the provenance store. */
export type MemoryRecord = {
  id: string;
  chain: string;
  version: number;
  title: string;
  text: string;
  bucket: Bucket;
  status: "current" | "superseded" | "promoted";
  created: string;
  updated: string;
  actor: ActorRecord;
  origin: Exclude<Origin, "obsidian">;
  channel: Channel;
  /** A short label for where it came from (max 200 chars), e.g. "said on the Tuesday call". */
  note?: string;
  supersedes: string | null;
  /** The mem- that corrected it, or the mf- vault fact it was promoted to. */
  superseded_by: string | null;
  content_hash: string;
};

export type FactStatus = "current" | "superseded";

/** Where a vault fact came from — the capture channel, never a raw transcript. */
export type FactOrigin = {
  kind: "voice" | "ui" | "agent" | "document" | "jarvis";
  /** A path, URL or record id (e.g. the mem- it was promoted from). */
  ref?: string;
  note?: string;
};

/** A curated fact block inside a vault note (`wiki/topics/<bucket>/memory-<bucket>-shared.md`). */
export type Fact = {
  wiki_ref: string;
  chain: string;
  version: number;
  title: string;
  text: string;
  bucket: Bucket;
  status: FactStatus;
  created: string;
  updated: string;
  /** Display name of whoever saved this version (provenance). */
  saved_by: string;
  origin: FactOrigin;
  supersedes: string | null;
  superseded_by: string | null;
  source: { path: string; wiki_ref: string; link: string };
};

/**
 * "proxy-writes-off": the OS switch is on but the Hindsight proxy's own gate is off
 * (`hindsightctl writes -State on`), so saves stay queued. "auth-failed": the proxy did not accept
 * this process (Windows account check) or a direct instance refused the key.
 */
/** "writer-refused": the proxy's writer capability didn't accept this OS as the memory writer (Track 6). */
export type HindsightState = "ok" | "unknown" | "disabled" | "writes-off" | "proxy-writes-off" | "writer-refused" | "removals-waiting" | "unavailable" | "auth-failed" | "misconfigured";

/** Whether a destination is in Hindsight yet. */
export type IndexState = "confirmed" | "sending" | "queued" | "writes-off" | "disabled" | "not-indexed";

export type Destination =
  | { kind: "hindsight"; id: string; indexed: IndexState; label: string }
  | { kind: "vault"; id: string; path: string; link: string; uri: string; indexed: IndexState; label: string };

export type RefusalCode =
  | "prohibited-content"
  | "sensitive-for-vault"
  | "too-large"
  | "empty"
  | "not-found"
  | "not-a-fact"
  | "conflict"
  | "vault-conflict"
  | "already-superseded"
  | "previously-forgotten"
  | "approval-required"
  | "approval-denied"
  | "writes-disabled"
  | "nothing-held"
  | "invalid";

export type Refusal = {
  ok: false;
  code: RefusalCode;
  message: string;
  conflicts?: { id: string; title: string; text: string; source: SourceRef; updated: string }[];
  plan?: ForgetPlan;
  approval?: {
    id: string;
    expires_at: string;
    digest: string;
    /** Who asked (B1's actor): a person in the UI, or a program acting for them. */
    requested_actor?: "human" | "process";
    /** How it can be approved: the card's button (a person's own request), or only a spoken yes / the Telegram code. */
    approve_with?: "button" | "voice-or-telegram";
    /** A program's request: whether the one-time code went to the requester's Telegram DM. */
    telegram?: "sending" | "sent" | "not-sent";
  };
};

export type RememberResult = { ok: true; memory: MemoryRecord; duplicate: boolean; destination: Destination; message: string } | Refusal;
export type SaveToVaultResult = { ok: true; fact: Fact; destination: Destination; message: string } | Refusal;
export type CorrectResult = { ok: true; id: string; previous_id: string; destination: Destination; message: string } | Refusal;

export type RecalledFact = {
  id: string;
  kind: DocKind;
  title: string;
  /** The indexed text (vault fact/memory text, or a note excerpt). */
  text: string;
  /** What Hindsight extracted from it for this query, when it answered. */
  hindsight_text?: string[];
  source: SourceRef;
  version: number;
  version_hash: string;
  date: string;
  /** Provenance: where the text first came from, and who saved or last changed it (null: unknown, e.g. a hand edit in Obsidian). */
  origin: Origin;
  actor: string | null;
  /** Whether this exact version is confirmed in Hindsight. Recall only returns confirmed or locally indexed versions. */
  indexed: IndexState;
  /** The model route Hindsight's receipt says processed this version; null when no receipt was found (unknown, not a guess). */
  processed_by: ProcessedBy | null;
  via: ("hindsight" | "local")[];
  score: number;
};

export type RecallResult = {
  ok: true;
  query: string;
  facts: RecalledFact[];
  facts_used: string[];
  spoken: string;
  /** Hindsight's part in this answer. "unavailable" is not "no results". */
  hindsight: HindsightState;
  /** Hindsight hits dropped because they were forgotten, superseded, unindexed or not ours. */
  suppressed: number;
  /** False until the first vault scan: an empty answer then means "not built yet", not "nothing saved". */
  index_built?: boolean;
};

export type ForgetKind = "unindex" | "memory" | "full";

export type ForgetSection = { kind: "block"; ref: string } | { kind: "heading"; heading: string } | { kind: "note" };

export type ForgetPlan = {
  kind: ForgetKind;
  target: string;
  title: string;
  /** The Obsidian source (unindex / full). */
  source?: { path: string; note_id: string; section: ForgetSection; note_hash: string };
  /** Every derived copy this connector knows about. */
  derived: { hindsight_docs: string[]; memories: string[]; local_index: string[] };
  digest: string;
};

export type ForgetResult =
  | {
      ok: true;
      kind: ForgetKind;
      removed: { vault: string | null; hindsight_docs: string[]; memories: string[]; local_index: string[] };
      hindsight: IndexState;
      message: string;
      /** What this app cannot remove (Git history, backups). Always present for full forget. */
      limits: string[];
    }
  | Refusal;

export type Tombstone = {
  id: string;
  content_hash: string;
  kind: DocKind | "section";
  source_path?: string;
  forgotten_at: string;
  forgotten_by: string;
  approval_id?: string;
};

export type Exclusion = { id: string; path?: string; excluded_at: string; by: string };

export type OutboxOp = {
  doc_id: string;
  op: "upsert" | "retract";
  version_hash: string | null;
  enqueued_at: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  /**
   * A refusal that no forced sync may retry before this time (the proxy's delete rate limit, a
   * refused approval): "Sync now" and every save used to force it again (REVIEW-STAGE-D S1).
   */
  hold_until?: string | null;
};

/** One model call Hindsight made while processing a document (its llm_requests receipt, no text). */
export type ModelRef = { provider: string; model: string };
export type ProcessedBy = ModelRef & {
  /** Earlier failover members that failed on this save before `model` succeeded. */
  fallback_from: ModelRef[];
  /** Cost basis of the route that did the work; the cash amount itself is unknown here. */
  basis: "metered" | "free" | "subscription" | "unknown";
  calls: number;
  tokens: number | null;
  at: string;
};

/**
 * The processing log (processing.jsonl): one line per Hindsight write attempt, so the Memory page
 * can show what was processed, by which model, what failed and what is being retried.
 */
export type ProcessingRecord = {
  at: string;
  /** Ids only, never titles or text: a forgotten item must leave nothing readable behind. */
  doc_id: string;
  op: "retain" | "retract";
  outcome: "ok" | "failed" | "held";
  attempt: number;
  error: string | null;
  /** retain: which model processed it (null = not recorded yet or unknown). */
  processed_by: ProcessedBy | null;
  /** retract: why it was removed (routine: correction, note removed, unindex; forget: an approved forget). */
  authority?: "routine" | "forget";
  latency_ms: number;
};

export type SyncStatus = {
  settings: {
    /** The one switch, MU_MEMORY_WRITES: off | read | on. */
    mode: "off" | "read" | "on";
    writes: boolean;
    hindsight_enabled: boolean;
    hindsight_url: string | null;
    bank: string;
    /** "not-needed" through the proxy; a key set anyway is reported so it can be removed. */
    api_key: "set" | "missing";
    reason: string | null;
    /** Retired switch names still set somewhere (MEMORY_WRITES, HINDSIGHT_ENABLED): they do nothing now. */
    retired: string[];
    /** Why this copy is read-only although the switch is on (it isn't the one memory writer). */
    writer?: string | null;
  };
  /**
   * Whether Hindsight answers its health check (L2): "not-checked" only until the first background
   * probe completes; "disabled" when Hindsight isn't configured. Probed at most every ~60 s.
   */
  hindsight_health?: "connected" | "down" | "not-checked" | "disabled";
  hindsight_checked_at?: string | null;
  hindsight: HindsightState;
  last_scan_at: string | null;
  last_drain_at: string | null;
  last_success_at: string | null;
  pending: number;
  pending_ops: OutboxOp[];
  errors: { doc_id: string; error: string; attempts: number }[];
  counts: { notes: number; docs: number; memories: number; indexed: number; excluded: number; tombstones: number };
  skipped: { reason: string; count: number; examples: string[] }[];
  /** Most recent Hindsight write attempts, newest first (processing, model, failures, retries). */
  recent: ProcessingRecord[];
  /** Saves per processing model since the store began, e.g. "openrouter/deepseek/deepseek-v4.1-flash": 12; "unknown" when no receipt was found. */
  models: Record<string, number>;
  /** When this status was computed (the UI shows it, and marks it stale if a refresh fails). */
  as_of: string;
  /** Removals held back because too many documents vanished from the vault at once. */
  held: { count: number; digest: string; examples: string[]; ids: string[]; since: string } | null;
};

/** One browseable item on the Memory page (a vault note, a vault fact or a Hindsight memory). */
export type MemoryRow = {
  id: string;
  kind: DocKind;
  title: string;
  text: string;
  bucket: Bucket;
  source: SourceRef;
  version: number;
  version_hash: string;
  date: string;
  actor: string | null;
  status: "current" | "superseded" | "promoted" | "excluded";
  indexed: IndexState;
  destination_label: string;
  /** Which model processed the current indexed version (null = not indexed yet or not recorded). */
  processed_by?: ProcessedBy | null;
};

export type MemoryItemDetail = { row: MemoryRow; history: MemoryRow[]; forget: ForgetKind[] };

export type UsageReceipt = {
  at: string;
  op: "retain" | "recall" | "delete" | "get" | "health" | "receipts" | "register";
  bank: string;
  doc_id: string | null;
  latency_ms: number;
  outcome: "ok" | "not-found" | "error" | "unavailable" | "auth-failed";
  http_status: number | null;
  /** Token counts when Hindsight reports them (sync retain does); otherwise null. Unknown is not zero. */
  tokens: { input: number; output: number; total: number } | null;
  /** The OS does not see Hindsight's LLM bill; the per-save route is in the processing log. */
  cost: { basis: "see-processing"; cash_usd: null };
};

export function isBucket(value: unknown): value is Bucket {
  return typeof value === "string" && (BUCKETS as readonly string[]).includes(value);
}

export function isPrincipal(value: unknown): value is Principal {
  const p = value as Principal;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    ["local", "tailnet", "telegram", "voice", "system"].includes(p.via)
  );
}
