/**
 * In-browser synthetic MemoryClient for previews, screenshots and component tests.
 * Every item here is invented. Nothing is read from or written to the vault or Hindsight.
 * It mirrors the server's rules closely enough to preview them: destinations, correction,
 * the three forget kinds, and approval before deletion.
 */
import type { Bucket, DocKind, ForgetKind, ForgetResult, MemoryClient, MemoryItemDetail, MemoryRow, ProcessedBy, StatusView } from "./client";

const at = (day: string) => `2026-09-${day}T09:30:00.000Z`;
const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
};
const vault = (path: string, link: string, block?: string) => ({
  kind: "vault" as const,
  path,
  note_id: `n-${hash(path).slice(0, 10)}`,
  link,
  uri: `obsidian://open?vault=mu-ventures-obsidian-wiki&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`,
  ...(block ? { block } : {}),
});
function row(p: Omit<MemoryRow, "version_hash" | "indexed" | "destination_label" | "status" | "version"> & Partial<Pick<MemoryRow, "status" | "version">>): MemoryRow {
  return {
    version: 1,
    status: "current",
    ...p,
    version_hash: hash(p.text),
    indexed: "confirmed",
    destination_label: p.kind === "memory" ? "Hindsight memory" : p.kind === "fact" ? "Vault fact" : "Vault note",
    processed_by: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", fallback_from: [], basis: "metered", calls: 1, tokens: 1840, at: p.date },
  };
}

export function syntheticRows(): MemoryRow[] {
  const page = "wiki/topics/business/memory-business-shared.md";
  return [
    row({ id: "mf-5e1a0c0001", kind: "fact", title: "Premium package is A$1,500 a month", text: "The Premium package is A$1,500 a month.", bucket: "business", source: vault(page, "[[memory-business-shared#^mf-5e1a0c0001]]", "mf-5e1a0c0001"), date: at("20"), actor: "Usman", status: "superseded" }),
    row({ id: "mf-5e1a0c0002", kind: "fact", version: 2, title: "Premium package is A$1,999 a month", text: "The Premium package is A$1,999 a month, 1,800 minutes, extra minutes A$0.70 (approved, ex GST).", bucket: "business", source: vault(page, "[[memory-business-shared#^mf-5e1a0c0002]]", "mf-5e1a0c0002"), date: at("27"), actor: "Usman" }),
    row({ id: "n-5e1a0c0003", kind: "note", title: "Receptionist Playbook", text: "The synthetic demo line answers calls but does not book until go-live is approved. Say so in every demo.", bucket: "business", source: vault("wiki/topics/business/receptionist-playbook.md", "[[receptionist-playbook]]"), date: at("26"), actor: null }),
    row({ id: "mem-5e1a0c0004", kind: "memory", title: "Harbourview prefers morning reminders", text: "Harbourview Dental (synthetic) wants reminder texts sent at 8am the day before.", bucket: "business", source: { kind: "memory", id: "mem-5e1a0c0004" }, date: at("25"), actor: "Mehroz" }),
    row({ id: "mem-5e1a0c0005", kind: "memory", title: "Kickoff calls run 30 minutes", text: "Client kickoff calls run 30 minutes, with the setup checklist sent the day before.", bucket: "business", source: { kind: "memory", id: "mem-5e1a0c0005" }, date: at("24"), actor: "Usman" }),
    row({ id: "n-5e1a0c0006", kind: "note", title: "Canonical Map", text: "Where each business record lives: packages, receptionist config, sales pack, video gallery (synthetic).", bucket: "general", source: vault("wiki/topics/general/canonical-map.md", "[[canonical-map]]"), date: at("22"), actor: null }),
  ];
}

const SYNTHETIC_MODEL: ProcessedBy = { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", fallback_from: [], basis: "metered", calls: 1, tokens: 1840, at: new Date().toISOString() };
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const delay = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export function createSyntheticMemoryClient(options: { rows?: MemoryRow[]; latencyMs?: number; writes?: boolean } = {}): MemoryClient {
  let rows = options.rows ?? syntheticRows();
  const ms = options.latencyMs ?? 60;
  const writes = options.writes ?? true;
  const approvals = new Map<string, { target: string; kind: ForgetKind; granted: boolean }>();
  let n = 0;
  const nextId = (p: "mem" | "mf") => `${p}-${(0x5e1a0c1000 + ++n).toString(16)}`;
  const current = () => rows.filter((r) => r.status === "current");
  const status = (): StatusView => ({
    principal: { name: "Usman", via: "local" },
    settings: { mode: writes ? "on" : "read", retired: [], writes, hindsight_enabled: true, hindsight_url: "http://127.0.0.1:8878", bank: "mu-shared", api_key: "missing", reason: null },
    hindsight: writes ? "ok" : "writes-off",
    last_scan_at: new Date(Date.now() - 40_000).toISOString(),
    last_drain_at: new Date(Date.now() - 40_000).toISOString(),
    last_success_at: new Date(Date.now() - 40_000).toISOString(),
    pending: 0,
    pending_ops: [],
    errors: [],
    counts: { notes: 2, docs: current().length, memories: current().filter((r) => r.kind === "memory").length, indexed: current().length, excluded: 0, tombstones: 0 },
    skipped: [{ reason: "secret-shaped content", count: 1, examples: ["wiki/topics/general/staging-setup.md"] }],
    recent: [
      { at: new Date(Date.now() - 40_000).toISOString(), doc_id: "mem-5e1a0c0005", op: "retain", outcome: "ok", attempt: 1, error: null, processed_by: SYNTHETIC_MODEL, latency_ms: 4300 },
      { at: new Date(Date.now() - 90_000).toISOString(), doc_id: "mem-5e1a0c0004", op: "retain", outcome: "ok", attempt: 2, error: null, processed_by: { ...SYNTHETIC_MODEL, provider: "groq", model: "openai/gpt-oss-120b", basis: "free", fallback_from: [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" }], calls: 2 }, latency_ms: 2900 },
      { at: new Date(Date.now() - 120_000).toISOString(), doc_id: "mem-5e1a0c0004", op: "retain", outcome: "failed", attempt: 1, error: "Hindsight is unreachable (connection failed).", processed_by: null, latency_ms: 12 },
    ],
    models: { "openrouter/deepseek/deepseek-v4.1-flash": 5, "groq/openai/gpt-oss-120b": 1 },
    held: null,
    as_of: new Date().toISOString(),
  });
  const detail = (id: string): MemoryItemDetail | null => {
    const r = rows.find((x) => x.id === id);
    if (!r) return null;
    const chain = r.kind === "note" ? [r] : rows.filter((x) => x.kind === r.kind && x.title.split(" ")[0] === r.title.split(" ")[0]);
    return { row: r, history: chain.length > 1 ? chain : [], forget: r.kind === "memory" ? ["memory"] : ["unindex", "full"] };
  };

  const client: MemoryClient = {
    synthetic: true,
    status: () => delay(status(), ms),
    items: (o = {}) => {
      const q = new Set(words(o.q ?? ""));
      const list = rows.filter((r) => (o.includeSuperseded || r.status === "current" || r.status === "excluded") && (!o.kind || r.kind === o.kind) && (!o.bucket || r.bucket === o.bucket));
      return delay(q.size ? list.filter((r) => words(`${r.title} ${r.text}`).some((w) => q.has(w))) : list, ms);
    },
    item: (id) => delay(detail(id), ms),
    recall: (query) => {
      const q = new Set(words(query));
      const hits = current().filter((r) => words(`${r.title} ${r.text}`).some((w) => q.has(w)));
      return delay(
        {
          ok: true as const,
          query,
          facts: hits.map((r) => ({ id: r.id, kind: r.kind, title: r.title, text: r.text, source: r.source, version: r.version, version_hash: r.version_hash, date: r.date, origin: (r.kind === "memory" ? "jarvis" : "obsidian") as "jarvis" | "obsidian", actor: r.actor, indexed: "confirmed" as const, processed_by: r.processed_by ?? null, via: ["local" as const], score: 1 })),
          facts_used: hits.map((r) => r.id),
          spoken: hits.length ? `Here's what's saved: ${hits[0].text}` : "I don't have anything saved about that.",
          hindsight: "ok" as const,
          suppressed: 0,
        },
        ms,
      );
    },
    remember: (input) => {
      const id = nextId("mem");
      const r = row({ id, kind: "memory", title: input.text.slice(0, 60), text: input.text, bucket: (input.bucket ?? "general") as Bucket, source: { kind: "memory", id }, date: new Date().toISOString(), actor: "Usman" });
      rows = [r, ...rows];
      return delay({ ok: true as const, memory: { id, chain: id, version: 1, title: r.title, text: r.text, bucket: r.bucket, status: "current" as const, created: r.date, updated: r.date, actor: { id: "local-owner", name: "Usman", via: "local" as const }, origin: "ui" as const, channel: "ui" as const, supersedes: null, superseded_by: null, content_hash: r.version_hash }, duplicate: false, destination: { kind: "hindsight" as const, id, indexed: "confirmed" as const, label: "Hindsight memory (not in the vault)" }, message: `Remembered in Hindsight memory as ${id} (synthetic): indexed in Hindsight. Not written to the vault.` }, ms);
    },
    saveToVault: (input) => {
      const from = input.from_memory ? rows.find((r) => r.id === input.from_memory) : undefined;
      const text = from?.text ?? input.text ?? "";
      const id = nextId("mf");
      const bucket = (input.bucket ?? from?.bucket ?? "business") as Bucket;
      const path = `wiki/topics/${bucket}/memory-${bucket}-shared.md`;
      const src = vault(path, `[[memory-${bucket}-shared#^${id}]]`, id);
      if (from) from.status = "promoted";
      rows = [row({ id, kind: "fact", title: text.slice(0, 60), text, bucket, source: src, date: new Date().toISOString(), actor: "Usman" }), ...rows];
      return delay({ ok: true as const, fact: { wiki_ref: id, chain: id, version: 1, title: text.slice(0, 60), text, bucket, status: "current" as const, created: "", updated: "", saved_by: "Usman", origin: { kind: "ui" as const }, supersedes: null, superseded_by: null, source: { path, wiki_ref: id, link: src.link } }, destination: { kind: "vault" as const, id, path, link: src.link, uri: src.uri, indexed: "confirmed" as const, label: "Obsidian vault note" }, message: `Saved to the vault note ${path} as ${src.link} (synthetic). It is indexed in Hindsight.` }, ms);
    },
    correct: (id, text) => {
      const old = rows.find((r) => r.id === id);
      if (!old || old.kind === "note") return delay({ ok: false as const, code: "not-found" as const, message: "I can't find that fact." }, ms);
      const fresh = row({ ...old, id: nextId(old.kind === "memory" ? "mem" : "mf"), text, version: old.version + 1, date: new Date().toISOString(), status: "current" });
      old.status = "superseded";
      rows = [fresh, ...rows];
      return delay({ ok: true as const, id: fresh.id, previous_id: old.id, destination: fresh.kind === "memory" ? { kind: "hindsight" as const, id: fresh.id, indexed: "confirmed" as const, label: "Hindsight memory (not in the vault)" } : { kind: "vault" as const, id: fresh.id, path: (fresh.source as { path: string }).path, link: "", uri: "", indexed: "confirmed" as const, label: "Obsidian vault note" }, message: `Corrected: ${fresh.id} replaces ${old.id}, which is kept marked superseded and retracted from Hindsight (synthetic).` }, ms);
    },
    forget: (input): Promise<ForgetResult> => {
      const r = rows.find((x) => x.id === input.target);
      if (!r) return delay({ ok: false as const, code: "not-found" as const, message: "Not found." }, ms);
      if (input.kind === "unindex") {
        r.status = "excluded";
        r.indexed = "not-indexed";
        return delay({ ok: true as const, kind: "unindex" as const, removed: { vault: null, hindsight_docs: [r.id], memories: [], local_index: [r.id] }, hindsight: "confirmed" as const, message: `Removed "${r.title}" from the index. The note stays in the vault (synthetic).`, limits: [] }, ms);
      }
      const approval = input.approval_id ? approvals.get(input.approval_id) : undefined;
      if (!approval || !approval.granted || approval.target !== r.id) {
        const id = input.approval_id && approvals.has(input.approval_id) ? input.approval_id : `apr-synthetic-${++n}`;
        approvals.set(id, { target: r.id, kind: input.kind, granted: approvals.get(id)?.granted ?? false });
        return delay({ ok: false as const, code: "approval-required" as const, message: `Forget "${r.title}"${r.source.kind === "vault" ? ` in ${r.source.path}` : ""}. This needs approval first.`, approval: { id, expires_at: new Date(Date.now() + 600_000).toISOString(), digest: r.version_hash }, plan: { kind: input.kind, target: r.id, title: r.title, ...(r.source.kind === "vault" ? { source: { path: r.source.path, note_id: r.source.note_id, section: r.kind === "fact" ? { kind: "block" as const, ref: r.id } : { kind: "note" as const }, note_hash: r.version_hash } } : {}), derived: { hindsight_docs: [r.id], memories: r.kind === "memory" ? [r.id] : [], local_index: [r.id] }, digest: r.version_hash } }, ms);
      }
      approvals.delete(input.approval_id!);
      rows = rows.filter((x) => x.id !== r.id);
      return delay({ ok: true as const, kind: input.kind, removed: { vault: r.source.kind === "vault" ? r.source.path : null, hindsight_docs: [r.id], memories: r.kind === "memory" ? [r.id] : [], local_index: [r.id] }, hindsight: "confirmed" as const, message: `Forgot "${r.title}" (synthetic).`, limits: input.kind === "full" ? ["Git history and existing backups keep earlier copies; this app can't remove those."] : ["Existing backups keep earlier copies until they expire."] }, ms);
    },
    card: (approvalId) =>
      delay(approvals.has(approvalId) ? { ok: true as const, card_nonce: `synthetic-${approvalId}`, expires_at: new Date(Date.now() + 600_000).toISOString() } : { ok: false as const, reason: "No such approval." }, ms),
    grant: async (approvalId, cardNonce) => {
      const a = approvals.get(approvalId);
      if (!a || cardNonce !== `synthetic-${approvalId}`) return delay({ ok: false as const, reason: "No such approval." }, ms);
      a.granted = true;
      // As the real server does: the approved forget runs at once.
      const result = await client.forget({ kind: a.kind, target: a.target, approval_id: approvalId });
      return { ok: true as const, approval: { id: approvalId, summary: "synthetic", expires_at: new Date(Date.now() + 600_000).toISOString(), granted_via: "ui" }, result };
    },
    reject: (approvalId) => delay(approvals.delete(approvalId) ? { ok: true } : { ok: false, reason: "No such approval." }, ms),
    reindex: (target) => {
      const r = rows.find((x) => x.id === target || (x.source.kind === "vault" && x.source.note_id === target));
      if (r) (r.status = "current"), (r.indexed = "confirmed");
      return delay(r ? { ok: true as const, message: "Re-included in the index.", indexed: "confirmed" as const } : { ok: false as const, code: "not-found" as const, message: "That isn't excluded." }, ms);
    },
    sync: () => delay({ ok: true as const, status: status() }, ms),
    releaseHeld: () => delay({ ok: false as const, code: "nothing-held" as const, message: "Nothing is held (synthetic)." }, ms),
    factsUsed: (refs) => {
      const cur = new Map(current().map((r) => [r.id, r]));
      return delay({ facts: refs.flatMap((id) => (cur.has(id) ? [cur.get(id)!] : [])), missing: refs.filter((id) => !cur.has(id)) }, ms);
    },
  };
  return client;
}

export type { DocKind };
