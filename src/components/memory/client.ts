/**
 * What the Memory UI needs from the server. `createHttpMemoryClient` talks to `/__memory`
 * (scripts/memory/plugin.ts); `createSyntheticMemoryClient` (synthetic-client.ts) is an
 * in-browser stand-in with invented data for previews and tests.
 */
import type {
  Bucket,
  CorrectResult,
  DocKind,
  ForgetKind,
  ForgetResult,
  HindsightState,
  IndexState,
  MemoryItemDetail,
  MemoryRow,
  ProcessedBy,
  ProcessingRecord,
  RecallResult,
  Refusal,
  RememberResult,
  SaveToVaultResult,
  SourceRef,
  SyncStatus,
} from "../../../scripts/memory/types";

export type {
  Bucket,
  CorrectResult,
  DocKind,
  ForgetKind,
  ForgetResult,
  HindsightState,
  IndexState,
  MemoryItemDetail,
  MemoryRow,
  ProcessedBy,
  ProcessingRecord,
  RecallResult,
  Refusal,
  RememberResult,
  SaveToVaultResult,
  SourceRef,
  SyncStatus,
};

export type StatusView = SyncStatus & {
  principal: { name: string; via: string };
  pending_approvals?: number;
  /** People whose Telegram approval codes are paused after 3 wrong codes (REVIEW-T6 R2). */
  code_lockouts?: { personId: string; misses: number; until: string }[];
};
export type ReleaseResult = { ok: true; message: string; released: number } | Refusal;
export type FactsUsed = { facts: MemoryRow[]; missing: string[] };
/**
 * The card's button (Track 6): approved by B2's service, and the server then ran exactly the approved
 * forget (or release); `result` is what happened. A refusal names why (`code`).
 */
export type GrantResult =
  | { ok: true; approval: { id: string; summary: string; expires_at: string; granted_via?: string | null }; result?: ForgetResult | ReleaseResult }
  | { ok: false; reason: string; code?: string };
/** A confirm nonce for this browser session's card; a program's request has none (voice or Telegram only). */
export type CardResult = { ok: true; card_nonce: string; expires_at: string } | { ok: false; reason: string; approve_with?: "button" | "voice-or-telegram" | null };
export type ReindexResult = { ok: true; message: string; indexed: IndexState } | Refusal;
/** A forget (or held-removal release) waiting for a person's approval, as GET /__memory/approvals lists it. */
export type PendingApproval = {
  id: string;
  action: "memory.forget" | "memory.bulk-retract";
  /** "<kind>:<id>" (plus "#<heading>" for a section), e.g. "memory:mem-…" or "full:mf-…". */
  target: string;
  summary: string;
  requested_by: string;
  /** A program's request can't be approved by a click, only by the owner's spoken yes. */
  requested_actor?: "human" | "process";
  requested_at: string;
  expires_at: string;
  granted_at: string | null;
};

export interface MemoryClient {
  /** Present on the synthetic client so the UI can label it honestly. */
  readonly synthetic?: boolean;
  status(): Promise<StatusView>;
  items(options?: { kind?: DocKind; bucket?: Bucket; q?: string; includeSuperseded?: boolean }): Promise<MemoryRow[]>;
  item(id: string): Promise<MemoryItemDetail | null>;
  recall(query: string): Promise<RecallResult>;
  remember(input: { text: string; title?: string; bucket?: Bucket; onConflict?: "keep-both"; reaffirm?: boolean }): Promise<RememberResult>;
  saveToVault(input: { text?: string; from_memory?: string; title?: string; bucket?: Bucket; onConflict?: "keep-both"; reaffirm?: boolean }): Promise<SaveToVaultResult>;
  correct(id: string, text: string, expectedVersionHash?: string): Promise<CorrectResult>;
  forget(input: { kind: ForgetKind; target: string; heading?: string; approval_id?: string }): Promise<ForgetResult>;
  /** The card was rendered in this browser session: its single-use confirm nonce (server-held approval). */
  card(approvalId: string): Promise<CardResult>;
  /** The card's button: approve with that nonce; the server runs the approved forget and returns the result. */
  grant(approvalId: string, cardNonce: string): Promise<GrantResult>;
  /** The card's "keep it" button: refuse the request (it can't be approved later). */
  reject(approvalId: string): Promise<{ ok: boolean; reason?: string }>;
  reindex(target: string): Promise<ReindexResult>;
  /** A held mass removal: first call asks (approval-required), the second (after grant) releases. */
  releaseHeld(approvalId?: string, digest?: string): Promise<ReleaseResult>;
  sync(): Promise<{ ok: true; status: SyncStatus }>;
  factsUsed(refs: string[]): Promise<FactsUsed>;
  /** Pending approvals (read only: approving happens on the item, through `grant`). */
  approvals?(): Promise<PendingApproval[]>;
}

export function createHttpMemoryClient(base = "/__memory", fetchImpl: typeof fetch = (...a) => fetch(...a)): MemoryClient {
  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(base + path, { headers: { Accept: "application/json" } });
    if (res.status === 401) throw new Error("Sign in to AgenticOS to use memory.");
    if (!res.ok && res.status !== 404) throw new Error((await res.json().catch(() => ({})))?.error || `Memory request failed (${res.status})`);
    return res.json();
  }
  // Every POST carries the caller's own page token (GET /__token), like every other mutating /__*
  // route (Stage B1). A token from a previous server run is stale: a 403 fetches a fresh one next time.
  let token: Promise<string> | null = null;
  const pageToken = () =>
    (token ??= fetchImpl("/__token", { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(async (r) => (r.ok ? String((await r.json())?.token ?? "") : ""))
      .catch(() => ""));
  async function post<T>(path: string, body: unknown): Promise<T> {
    const t = await pageToken();
    const res = await fetchImpl(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(t ? { "X-Claude-OS-Token": t } : {}) },
      body: JSON.stringify(body),
    });
    if (res.status === 403) token = null;
    const data = await res.json().catch(() => ({ error: `Memory request failed (${res.status})` }));
    // 202/403/409/422 carry a structured refusal ({ ok:false, code, message }) the UI shows as-is.
    if (!res.ok && !(data && data.ok === false)) throw new Error(data?.error || `Memory request failed (${res.status})`);
    return data;
  }
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  return {
    status: () => get("/status"),
    items: async (o = {}) => (await get<{ items: MemoryRow[] }>(`/items${qs({ kind: o.kind, bucket: o.bucket, q: o.q, superseded: o.includeSuperseded ? "1" : undefined })}`)).items,
    item: async (id) => {
      const r = await get<MemoryItemDetail & { error?: string }>(`/item/${encodeURIComponent(id)}`);
      return r.row ? r : null;
    },
    recall: (query) => post("/recall", { query }),
    remember: (input) => post("/remember", input),
    saveToVault: (input) => post("/vault/save", input),
    correct: (id, text, expected) => post("/correct", { id, text, expected_version_hash: expected }),
    forget: (input) => post("/forget", input),
    card: (approvalId) => post("/approvals/card", { approval_id: approvalId }),
    grant: (approvalId, cardNonce) => post("/approvals/grant", { approval_id: approvalId, card_nonce: cardNonce }),
    reject: (approvalId) => post("/approvals/reject", { approval_id: approvalId }),
    reindex: (target) => post("/reindex", { target }),
    releaseHeld: (approvalId, digest) => post("/held/release", { ...(approvalId ? { approval_id: approvalId } : {}), ...(digest ? { digest } : {}) }),
    sync: () => post("/sync", {}),
    factsUsed: (refs) => post("/facts-used", { refs }),
    approvals: async () => {
      const r = await get<{ pending?: PendingApproval[] }>("/approvals");
      return Array.isArray(r?.pending) ? r.pending : [];
    },
  };
}

/** "memory:mem-1" → { kind: "memory", id: "mem-1" }; "full:n-1#Pricing" → heading "Pricing". */
export function approvalTarget(target: string): { kind: string; id: string; heading: string | null } | null {
  const m = /^(unindex|memory|full):([^#]+)(?:#(.+))?$/.exec(target);
  return m ? { kind: m[1], id: m[2], heading: m[3] ?? null } : null;
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  business: "Business",
  finance: "Finance",
  deen: "Deen",
  research: "Research",
  personal: "Personal",
  general: "General",
};

/** Where an item lives, in words: the destination label on every row and result. */
export const DESTINATION_LABEL: Record<DocKind, string> = {
  note: "Vault note",
  fact: "Vault fact",
  memory: "Hindsight memory",
};

export const INDEX_LABEL: Record<IndexState, { label: string; tone: "success" | "warn" | "neutral" | "info" }> = {
  confirmed: { label: "Indexed", tone: "success" },
  sending: { label: "Sending to Hindsight", tone: "info" },
  queued: { label: "Queued for Hindsight", tone: "warn" },
  "writes-off": { label: "Not sent (writes off)", tone: "neutral" },
  disabled: { label: "Local index only (Hindsight off)", tone: "neutral" },
  "not-indexed": { label: "Not indexed", tone: "neutral" },
};

export const HINDSIGHT_LABEL: Record<HindsightState, { label: string; tone: "success" | "warn" | "danger" | "neutral" }> = {
  ok: { label: "Hindsight connected", tone: "success" },
  unknown: { label: "Hindsight not checked yet", tone: "neutral" },
  disabled: { label: "Hindsight off", tone: "neutral" },
  "writes-off": { label: "Hindsight read only (writes off)", tone: "neutral" },
  "proxy-writes-off": { label: "Hindsight proxy writes off", tone: "warn" },
  "writer-refused": { label: "Hindsight refused this OS as the writer", tone: "danger" },
  "removals-waiting": { label: "Hindsight: removals waiting (rate limit)", tone: "warn" },
  unavailable: { label: "Hindsight unreachable", tone: "warn" },
  "auth-failed": { label: "Hindsight refused the key", tone: "danger" },
  misconfigured: { label: "Hindsight misconfigured", tone: "danger" },
};

/** "DeepSeek v4.1 flash via OpenRouter" style label for a processing model. */
export function modelLabel(m: Pick<ProcessedBy, "provider" | "model">) {
  return `${m.model} (${m.provider})`;
}
export const BASIS_LABEL: Record<ProcessedBy["basis"], string> = {
  metered: "metered",
  free: "free tier",
  subscription: "subscription",
  unknown: "route unknown",
};

export function sourceText(s: SourceRef) {
  return s.kind === "vault" ? s.path : s.id;
}
