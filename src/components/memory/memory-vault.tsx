import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, Copy, ExternalLink, History, RefreshCw, Search, ShieldCheck, Trash2, PencilLine, X, EyeOff, Eye, Archive } from "lucide-react";
import { Badge, Button, Disclosure, EmptyState, Notice, PageHeader, Segmented, Skeleton, Surface, fmtRelative } from "@/components/ds";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { pageName } from "@/components/shell/destinations";
import {
  BASIS_LABEL,
  BUCKET_LABEL,
  DESTINATION_LABEL,
  HINDSIGHT_LABEL,
  INDEX_LABEL,
  approvalTarget,
  createHttpMemoryClient,
  modelLabel,
  type DocKind,
  type ForgetKind,
  type ForgetResult,
  type MemoryClient,
  type MemoryItemDetail,
  type MemoryRow,
  type PendingApproval,
  type ProcessedBy,
  type ProcessingRecord,
  type Refusal,
  type StatusView,
} from "./client";
import { fmtDateTime, fmtDay as formatDay, fmtTime } from "@/lib/format";

const fmtDay = (iso: string) => formatDay(new Date(iso), { year: true });
const fmtClock = (iso: string | null | undefined) => (iso ? fmtTime(new Date(iso), { seconds: true }) : "unknown");
type Tone = "success" | "warn" | "danger" | "info";
type NoticeState = { tone: Tone; text: string; details?: string[]; action?: { label: string; run: () => void } } | null;

const KIND_OPTIONS = [
  { value: "all", label: "All" },
  { value: "note", label: "Vault notes" },
  { value: "fact", label: "Vault facts" },
  { value: "memory", label: "Hindsight memories" },
] as const;

/**
 * The Memory destination: one shared business memory. Obsidian holds curated notes and "save to
 * the vault" facts; Hindsight holds contextual memory and Jarvis captures; AgenticOS syncs the two
 * and records provenance. Every item says where it lives; forgetting says exactly what goes.
 */
export function MemoryVault({ client: injected, initialRef, className }: { client?: MemoryClient; initialRef?: string; className?: string }) {
  const client = useMemo(() => injected ?? createHttpMemoryClient(), [injected]);
  const id = useId();
  const [status, setStatus] = useState<StatusView | null>(null);
  const [kind, setKind] = useState<"all" | DocKind>("all");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [detail, setDetail] = useState<MemoryItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A failed status or items fetch is shown as failed, never as empty or current (REVIEW-STAGE-D S3). */
  const [statusError, setStatusError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [version, setVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  /** Forgets waiting for approval (MEM-7): a voice "approve it on the Memory page" must land somewhere. */
  const [approvals, setApprovals] = useState<PendingApproval[] | null>(null);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const refresh = () => setVersion((v) => v + 1);

  // A result (e.g. "Removed from the index") can land while the page is scrolled down: bring it into view.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [notice]);

  useEffect(() => {
    if (!client.approvals) return;
    let live = true;
    client
      .approvals()
      .then((a) => live && (setApprovals(a), setApprovalsError(null)))
      .catch((e: Error) => live && setApprovalsError(e.message));
    return () => void (live = false);
  }, [client, version]);

  useEffect(() => {
    let live = true;
    client
      .status()
      .then((s) => live && (setStatus(s), setStatusError(null)))
      .catch((e: Error) => live && setStatusError(e.message));
    return () => void (live = false);
  }, [client, version]);

  useEffect(() => {
    let live = true;
    setRows(null);
    client
      .items({ kind: kind === "all" ? undefined : kind, q: activeQuery || undefined, includeSuperseded: showSuperseded })
      .then((r) => live && (setRows(r), setItemsError(null)))
      .catch((e: Error) => live && (setRows(null), setItemsError(e.message)));
    return () => void (live = false);
  }, [client, kind, activeQuery, showSuperseded, version]);

  const open = useCallback(
    async (itemId: string) => {
      const r = await client.item(itemId).catch(() => null);
      setDetail(r);
      if (!r) setNotice({ tone: "warn", text: "That item is no longer available. It may have been forgotten." });
    },
    [client],
  );
  useEffect(() => {
    if (initialRef) void open(initialRef);
  }, [initialRef, open]);

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await client.sync();
      setStatus((s) => (s ? { ...s, ...r.status } : s));
      refresh();
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  }

  const selected = detail?.row.id ?? null;
  return (
    <div className={cn("mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8", className)}>
      <PageHeader
        title={pageName("/memory/vault")}
        description="One shared business memory. Obsidian holds curated notes; Hindsight holds contextual memory and Jarvis captures; AgenticOS keeps them in sync with sources. Never chats, calls, email bodies, bank records or secrets."
        meta={
          <>
            {status && (
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" aria-hidden />
                Signed in as {status.principal.name} · shared pool
              </span>
            )}
            {client.synthetic && <Badge tone="warn">Synthetic sample data</Badge>}
          </>
        }
      />

      {error && (
        <Notice tone="danger" title="Memory is unavailable" className="mb-4">
          {error}
        </Notice>
      )}
      {notice && (
        <div ref={noticeRef}>
        <Notice
          tone={notice.tone}
          className="mb-4"
          action={
            <span className="flex items-center gap-1">
              {notice.action && (
                <Button variant="outline" size="xs" onClick={notice.action.run}>
                  {notice.action.label}
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setNotice(null)}>
                <X />
              </Button>
            </span>
          }
        >
          {notice.text}
          {notice.details && notice.details.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {notice.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </Notice>
        </div>
      )}

      <PendingApprovals approvals={approvals} error={approvalsError} onReview={(itemId) => void open(itemId)} />

      <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SyncPanel status={status} error={statusError} onRetry={refresh} syncing={syncing} onSync={syncNow} client={client} onNotice={(n) => (setNotice(n), refresh())} />
        <CaptureCard
          client={client}
          writes={status?.settings.writes ?? false}
          onDone={(n, openId) => {
            setNotice(n);
            refresh();
            if (openId) void open(openId);
          }}
        />
      </div>

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setActiveQuery(query.trim());
          setDetail(null);
        }}
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <label htmlFor={`${id}-q`} className="sr-only">
          Search memory
        </label>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id={`${id}-q`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do we know about…"
            className="h-12 w-full rounded-full border border-border bg-card pl-10 pr-10 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {activeQuery && (
            <button type="button" aria-label="Clear search" onClick={() => (setQuery(""), setActiveQuery(""))} className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent">
              <X className="size-4" />
            </button>
          )}
        </div>
        <Button type="submit" variant="outline" className="h-12 rounded-full px-6 text-base">
          Search
        </Button>
      </form>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented ariaLabel="Show" value={kind} options={KIND_OPTIONS} onChange={(v) => (setKind(v), setDetail(null))} />
        <label className="flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
          <input type="checkbox" className="size-4 accent-current" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
          Show superseded
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-label={activeQuery ? `Results for ${activeQuery}` : "Memory items"} className={cn("min-w-0", detail && "hidden lg:block")}>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {activeQuery ? `Results for “${activeQuery}”` : "Latest"}
            {rows && <span className="ml-1.5 normal-case tracking-normal">({rows.length})</span>}
          </h2>
          {itemsError ? (
            <Notice tone="danger" title="Couldn't load memory items">
              {itemsError}{" "}
              <Button variant="outline" size="xs" onClick={refresh}>
                Try again
              </Button>
            </Notice>
          ) : !rows ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[86px] w-full rounded-xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Surface variant="dashed" padding="lg">
              {status && status.last_scan_at === null ? (
                <EmptyState
                  icon={BookOpen}
                  title="The index isn't built yet"
                  body="The vault hasn't been scanned, so this can't say what's saved yet. Sync now builds the index from the vault."
                  action={
                    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
                      <RefreshCw className={cn(syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={BookOpen}
                  title={activeQuery ? "Nothing saved about that" : "Nothing here yet"}
                  body={activeQuery ? "No note, fact or memory matched. Try other words." : "Say “remember that…” to Jarvis for Hindsight memory, or “save this to the vault…” for an Obsidian note."}
                />
              )}
            </Surface>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={`${row.id}:${row.status}`}>
                  <Row row={row} selected={row.id === selected} onOpen={() => open(row.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Item detail" className={cn("min-w-0", !detail && "hidden lg:block")}>
          {detail ? (
            <Detail
              detail={detail}
              client={client}
              writes={status?.settings.writes ?? false}
              hindsightOn={status?.settings.hindsight_enabled ?? true}
              onBack={() => setDetail(null)}
              onOpen={open}
              onChanged={(n, nextId) => {
                setNotice(n);
                refresh();
                if (nextId) void open(nextId);
                else setDetail(null);
              }}
            />
          ) : (
            <Surface variant="dashed" padding="lg" className="rounded-2xl lg:sticky lg:top-6">
              <p className="text-base leading-relaxed text-muted-foreground">Choose an item to see where it lives, who saved it, its version and history, and how to forget it.</p>
            </Surface>
          )}
        </aside>
      </div>
    </div>
  );
}

const MODE_TEXT: Record<StatusView["settings"]["mode"], string> = {
  on: "Memory switch on",
  read: "Memory switch: read only",
  off: "Memory switch off",
};

function SyncPanel({
  status,
  error,
  onRetry,
  syncing,
  onSync,
  client,
  onNotice,
}: {
  status: StatusView | null;
  error: string | null;
  onRetry: () => void;
  syncing: boolean;
  onSync: () => void;
  client: MemoryClient;
  onNotice: (n: NoticeState) => void;
}) {
  if (!status && error)
    return (
      <Notice tone="danger" title="Sync status unavailable">
        {error}{" "}
        <Button variant="outline" size="xs" onClick={onRetry}>
          Try again
        </Button>
      </Notice>
    );
  if (!status) return <Skeleton className="h-[168px] w-full rounded-xl" />;
  const hs = HINDSIGHT_LABEL[status.hindsight];
  const skippedCount = status.skipped.reduce((s, x) => s + x.count, 0);
  const s = status.settings;
  const models = Object.entries(status.models ?? {}).sort((a, b) => b[1] - a[1]);
  const hindsightOn = s.hindsight_enabled;
  const unreachable = status.hindsight === "unavailable" || status.hindsight === "auth-failed";
  return (
    <Surface padding="md" aria-label="Sync status" className="rounded-2xl sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Obsidian ⇄ Hindsight sync</h2>
        <Badge tone={hs.tone}>{hs.label}</Badge>
        <Badge tone={s.mode === "on" ? "success" : "neutral"}>{MODE_TEXT[s.mode]}</Badge>
        <Button variant="outline" size="xs" className="ml-auto" onClick={onSync} disabled={syncing}>
          <RefreshCw className={cn(syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      <p className={cn("mt-1 text-sm", error ? "text-warn" : "text-muted-foreground")}>
        {error ? `Couldn't refresh (${error}); these numbers are from ${fmtClock(status.as_of)}.` : `As of ${fmtClock(status.as_of)}`}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-base sm:grid-cols-4">
        <div>
          <dt className="text-sm text-muted-foreground">Last scan</dt>
          <dd>{status.last_scan_at ? fmtRelative(status.last_scan_at) : "Never: index not built yet"}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Last pushed</dt>
          <dd>{hindsightOn ? fmtRelative(status.last_success_at) : "Hindsight off"}</dd>
        </div>
        {hindsightOn ? (
          <>
            <div>
              <dt className="text-sm text-muted-foreground">Pending</dt>
              <dd className="tabular-nums">{status.pending}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Indexed</dt>
              <dd className="tabular-nums">
                {status.counts.indexed} of {status.counts.docs}
              </dd>
            </div>
          </>
        ) : (
          <>
            {/* With Hindsight off nothing drains, so a "Pending" count would only ever grow (MEM-5). */}
            <div>
              <dt className="text-sm text-muted-foreground">Not sent (Hindsight off)</dt>
              <dd className="tabular-nums">{status.pending}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">In the local index</dt>
              <dd className="tabular-nums">{status.counts.docs}</dd>
            </div>
          </>
        )}
      </dl>
      {s.mode !== "on" && (
        <p className="mt-3 text-sm text-muted-foreground">
          Memory writing is off (MU_MEMORY_WRITES is {s.mode}).{" "}
          {!s.hindsight_enabled
            ? "Recall uses the local index only."
            : unreachable
              ? "Recall uses the local index only: Hindsight is unreachable right now."
              : "Recall uses the local index, and Hindsight when it answers."}
        </p>
      )}
      {s.mode === "on" && unreachable && (
        <p className="mt-2 text-sm text-warn">Hindsight is unreachable right now: recall uses the local index only, and saves wait in the queue (nothing is lost).</p>
      )}
      {s.writer && <p className="mt-2 text-sm text-warn">{s.writer}</p>}
      {(status.code_lockouts ?? []).map((l) => (
        <p key={l.personId} className="mt-2 text-sm text-warn">
          {l.personId.charAt(0).toUpperCase() + l.personId.slice(1)}'s Telegram approval codes are paused until{" "}
          {fmtTime(new Date(l.until))} after {l.misses} wrong codes, and the waiting ones are
          void. If that wasn't them, something on this PC may be guessing. A spoken yes to Jarvis still approves.
        </p>
      ))}
      {status.hindsight === "writer-refused" && (
        <p className="mt-2 text-sm text-danger">
          The Hindsight proxy didn't accept this OS as the memory writer (its writer capability). Saves wait in the queue; nothing is lost. Only the main
          AgenticOS on 8081 can write, and it registers itself when it starts.
        </p>
      )}
      {status.hindsight === "proxy-writes-off" && (
        <p className="mt-2 text-sm text-warn">The Hindsight proxy's own write switch is off, so saves wait in the queue. Nothing is lost; they go through once it is on.</p>
      )}
      {s.reason && s.hindsight_enabled === false && s.mode !== "off" && <p className="mt-2 text-sm text-danger">{s.reason}</p>}
      {s.retired.length > 0 && (
        <p className="mt-2 text-sm text-warn">
          {s.retired.join(" and ")} {s.retired.length === 1 ? "is" : "are"} no longer read. MU_MEMORY_WRITES is the one switch.
        </p>
      )}
      {status.held && <HeldBanner held={status.held} client={client} onNotice={onNotice} />}
      {status.errors.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-warn" aria-label="Sync errors">
          {status.errors.slice(0, 3).map((e) => (
            <li key={e.doc_id}>
              <span className="font-mono">{e.doc_id}</span>: {e.error} (tried {e.attempts}×, kept in the queue)
            </li>
          ))}
        </ul>
      )}
      <Disclosure summary="Processing log" meta="what Hindsight did with recent saves" className="-mx-3 mt-3">
        <ProcessingLog status={status} models={models} />
      </Disclosure>
      {status.skipped.length > 0 && (
        <details className="mt-3 text-sm text-muted-foreground">
          <summary className="cursor-pointer">
            Not indexed: {skippedCount} {skippedCount === 1 ? "note or section" : "notes or sections"} (by rule, not an error)
          </summary>
          <ul className="mt-1 space-y-0.5">
            {status.skipped.map((x) => (
              <li key={x.reason}>
                {x.reason}: {x.count}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Surface>
  );
}

/** Processing: what Hindsight did with each save, which model did it, what failed and what is retrying. */
function ProcessingLog({ status, models }: { status: StatusView; models: [string, number][] }) {
  const retrying = status.pending_ops.filter((o) => o.attempts > 0);
  const recent = (status.recent ?? []).slice(0, 8);
  if (!recent.length && !retrying.length && !models.length) return null;
  return (
    <div className="pt-1">
      <h3 className="sr-only">Processing</h3>
      {models.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Processed by{" "}
          {models.map(([m, n], i) => (
            <span key={m}>
              {i > 0 && ", "}
              {m === "unknown" ? <span className="text-foreground">model unknown</span> : <span className="font-mono text-foreground">{m}</span>} ×{n}
            </span>
          ))}
        </p>
      )}
      {retrying.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm" aria-label="Retrying">
          {retrying.slice(0, 5).map((o) => (
            <li key={`${o.op}:${o.doc_id}`} className="text-warn">
              {o.op === "upsert" ? "Save" : "Removal"} <span className="font-mono">{o.doc_id}</span>: attempt {o.attempts} failed
              {o.hold_until && Date.parse(o.hold_until) > Date.now()
                ? `, waiting until ${fmtClock(o.hold_until)}`
                : o.next_attempt_at
                  ? Date.parse(o.next_attempt_at) > Date.now()
                    ? `, next try at ${fmtClock(o.next_attempt_at)}`
                    : ", retrying now"
                  : ""}
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <ol className="mt-2 space-y-2 text-sm" aria-label="Recent processing">
          {recent.map((r, i) => (
            <ProcessingLine key={`${r.at}-${r.doc_id}-${i}`} r={r} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ProcessingLine({ r }: { r: ProcessingRecord }) {
  const what = r.op === "retain" ? "Saved" : r.authority === "forget" ? "Forgotten" : "Removed";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <Badge tone={r.outcome === "ok" ? "success" : r.outcome === "held" ? "neutral" : "warn"}>{r.outcome === "ok" ? what : r.outcome === "held" ? "Held" : "Failed"}</Badge>
      <span className="font-mono text-foreground">{r.doc_id}</span>
      {r.attempt > 1 && <span className="text-muted-foreground">attempt {r.attempt}</span>}
      {r.op === "retain" && r.outcome === "ok" && <ModelText m={r.processed_by} />}
      {r.error && <span className="text-warn">{r.error}</span>}
      <span className="text-muted-foreground">{fmtRelative(r.at)}</span>
    </li>
  );
}

function ModelText({ m }: { m: ProcessedBy | null | undefined }) {
  if (!m) return <span className="text-muted-foreground">model not recorded yet</span>;
  return (
    <span className="text-muted-foreground">
      by <span className="font-mono text-foreground">{modelLabel(m)}</span> · {BASIS_LABEL[m.basis]}
      {m.fallback_from.length > 0 && <> · fell back from {m.fallback_from.map(modelLabel).join(", ")}</>}
    </span>
  );
}

/** Too many documents vanished from the vault at once: nothing is removed from Hindsight until approved. */
function HeldBanner({ held, client, onNotice }: { held: NonNullable<StatusView["held"]>; client: MemoryClient; onNotice: (n: NoticeState) => void }) {
  const [busy, setBusy] = useState(false);
  async function release() {
    setBusy(true);
    try {
      const ask = await client.releaseHeld(undefined, held.digest);
      if (ask.ok) return onNotice({ tone: "success", text: ask.message });
      if (ask.code !== "approval-required" || !ask.approval) return onNotice({ tone: "warn", text: ask.message });
      // This button is the card: its confirm nonce is bound to this browser session (B2's uiConfirm).
      const card = await client.card(ask.approval.id);
      if (!card.ok) return onNotice({ tone: "warn", text: card.reason });
      const granted = await client.grant(ask.approval.id, card.card_nonce);
      if (!granted.ok) return onNotice({ tone: "warn", text: granted.reason });
      const done = granted.result ?? (await client.releaseHeld(ask.approval.id, held.digest));
      onNotice(done.ok ? { tone: "success", text: done.message } : { tone: "warn", text: done.message });
    } catch (e) {
      onNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Notice tone="warn" title={`${held.count} documents vanished from the vault at once`} className="mt-3">
      <p className="text-sm">
        They are still in Hindsight: a mass removal is held until someone approves it (a moved or deleted folder shouldn't wipe memory). If the notes
        should come back, restore them and sync.
      </p>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer">All {held.count} documents the approval would remove</summary>
        <p className="mt-1 break-all font-mono">{(held.ids ?? held.examples).join(", ")}</p>
      </details>
      <Button variant="outline" size="xs" className="mt-2" onClick={release} disabled={busy}>
        {busy ? "Approving…" : "Approve the removal"}
      </Button>
    </Notice>
  );
}

function CaptureCard({ client, writes, onDone }: { client: MemoryClient; writes: boolean; onDone: (n: NoticeState, openId?: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"memory" | "vault" | null>(null);
  const tid = useId();
  async function run(dest: "memory" | "vault", extra: { onConflict?: "keep-both"; reaffirm?: boolean } = {}) {
    const t = text.trim();
    if (!t) return;
    setBusy(dest);
    try {
      const r = dest === "memory" ? await client.remember({ text: t, ...extra }) : await client.saveToVault({ text: t, ...extra });
      if (r.ok) {
        setText("");
        onDone({ tone: "success", text: r.message }, "memory" in r ? r.memory.id : r.fact.wiki_ref);
      } else onDone(refusalNotice(r, () => run(dest, r.code === "conflict" ? { onConflict: "keep-both" } : { reaffirm: true })));
    } catch (e) {
      onDone({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Surface padding="md" aria-label="Capture" className="rounded-2xl sm:p-6">
      <label htmlFor={tid} className="text-base font-semibold">
        Keep a fact
      </label>
      <Textarea id={tid} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={800} className="mt-3 rounded-xl text-base" placeholder="One short fact worth keeping…" disabled={!writes} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => run("memory")} disabled={!writes || !text.trim() || !!busy}>
          {busy === "memory" ? "Remembering…" : "Remember"}
        </Button>
        <Button variant="accent" size="sm" onClick={() => run("vault")} disabled={!writes || !text.trim() || !!busy}>
          {busy === "vault" ? "Saving…" : "Save to vault"}
        </Button>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        <strong className="font-medium">Remember</strong> keeps it in Hindsight memory only. <strong className="font-medium">Save to vault</strong> writes it into the bucket's Obsidian note and indexes it. Passwords, keys, bank and card details, TFNs and codes are never stored.
        {!writes && " Writing is off until acceptance."}
      </p>
    </Surface>
  );
}

function refusalNotice(r: Refusal, retry?: () => void): NoticeState {
  if (r.code === "conflict" && r.conflicts?.length && retry)
    return { tone: "warn", text: `${r.message} It may disagree with: ${r.conflicts.map((c) => `“${c.title}”`).join(", ")}.`, action: { label: "Keep both", run: retry } };
  if (r.code === "previously-forgotten" && retry) return { tone: "warn", text: r.message, action: { label: "Keep it anyway", run: retry } };
  return { tone: r.code === "vault-conflict" ? "danger" : "warn", text: r.message };
}

function IndexBadge({ row }: { row: MemoryRow }) {
  if (row.status !== "current") return null;
  const i = INDEX_LABEL[row.indexed];
  return <Badge tone={i.tone}>{i.label}</Badge>;
}
function StatusBadge({ row }: { row: MemoryRow }) {
  if (row.status === "superseded") return <Badge tone="warn">Superseded</Badge>;
  if (row.status === "promoted") return <Badge tone="info">Moved to vault</Badge>;
  if (row.status === "excluded") return <Badge tone="neutral">Removed from index</Badge>;
  return null;
}

function Row({ row, selected, onOpen }: { row: MemoryRow; selected: boolean; onOpen: () => void }) {
  const dim = row.status !== "current";
  return (
    <Surface as="button" type="button" variant="interactive" padding="sm" onClick={onOpen} aria-pressed={selected} className={cn("w-full rounded-2xl px-5 py-4 text-left", selected && "border-border-strong bg-surface-raised", dim && "opacity-75")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("text-base font-semibold leading-snug text-foreground", row.status === "superseded" && "line-through decoration-muted-foreground/60")}>{row.title}</span>
        <Badge tone={row.kind === "memory" ? "accent" : "info"}>{DESTINATION_LABEL[row.kind]}</Badge>
        <StatusBadge row={row} />
      </div>
      <p className="mt-1.5 line-clamp-2 text-[15px] leading-relaxed text-foreground/75">{row.text}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <IndexBadge row={row} />
        <span>{BUCKET_LABEL[row.bucket]}</span>
        <span>{fmtDay(row.date)}</span>
        <span className="break-all font-mono">{row.source.kind === "vault" ? row.source.path : row.id}</span>
      </div>
    </Surface>
  );
}

type ForgetStep = { kind: ForgetKind; heading: string; stage: "choose" | "plan"; refusal?: Refusal } | null;

function Detail({
  detail,
  client,
  writes,
  hindsightOn = true,
  onBack,
  onOpen,
  onChanged,
}: {
  detail: MemoryItemDetail;
  client: MemoryClient;
  writes: boolean;
  hindsightOn?: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  onChanged: (n: NoticeState, nextId?: string) => void;
}) {
  const { row: r, history } = detail;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forget, setForget] = useState<ForgetStep>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setEditing(false);
    setForget(null);
    heading.current?.focus();
  }, [r.id]);

  const guard = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      onChanged({ tone: "danger", text: (e as Error).message }, r.id);
      return null;
    } finally {
      setBusy(false);
    }
  };

  async function saveCorrection(e: FormEvent) {
    e.preventDefault();
    const c = await guard(() => client.correct(r.id, draft.trim(), r.version_hash));
    if (!c) return;
    if (c.ok) onChanged({ tone: "success", text: c.message }, c.id);
    else onChanged(refusalNotice(c), r.id);
  }
  async function moveToVault() {
    const v = await guard(() => client.saveToVault({ from_memory: r.id }));
    if (!v) return;
    if (v.ok) onChanged({ tone: "success", text: v.message }, v.fact.wiki_ref);
    else onChanged(refusalNotice(v), r.id);
  }
  async function reinclude() {
    const v = await guard(() => client.reindex(r.source.kind === "vault" && r.kind === "note" ? r.source.note_id : r.id));
    if (!v) return;
    onChanged(v.ok ? { tone: "success", text: v.message } : refusalNotice(v), r.id);
  }
  async function requestPlan(kind: ForgetKind, head: string) {
    const f = await guard(() => client.forget({ kind, target: r.id, heading: head.trim() || undefined }));
    if (!f) return;
    if (f.ok && kind === "unindex") {
      // Stay on the item: its badge now reads "Removed from index", and the notice says how to undo (MEM-11).
      setForget(null);
      onChanged({ tone: "success", text: f.message, action: { label: "Undo", run: () => void reinclude() } }, r.id);
    } else if (f.ok) {
      setForget(null);
      onChanged({ tone: "success", text: f.message, details: f.limits });
    } else if (f.code === "approval-required") setForget({ kind, heading: head, stage: "plan", refusal: f });
    else {
      setForget(null);
      onChanged(refusalNotice(f), r.id);
    }
  }
  async function approveAndForget() {
    const plan = forget?.refusal;
    if (!forget || !plan?.approval) return;
    // The card's button: a confirm nonce for this browser session, then the grant. The server runs the
    // approved forget itself and returns what happened (a program's request can't be approved here).
    const card = await guard(() => client.card(plan.approval!.id));
    if (!card) return;
    if (!card.ok) return onChanged({ tone: "warn", text: card.reason }, r.id);
    const g = await guard(() => client.grant(plan.approval!.id, card.card_nonce));
    if (!g) return;
    if (!g.ok) return onChanged({ tone: "warn", text: g.reason }, r.id);
    const f = (g.result as ForgetResult | undefined) ?? (await guard(() => client.forget({ kind: forget.kind, target: r.id, heading: forget.heading.trim() || undefined, approval_id: plan.approval!.id })));
    setForget(null);
    if (!f) return;
    if (f.ok) onChanged({ tone: "success", text: f.message, details: f.limits });
    else onChanged(refusalNotice(f), r.id);
  }
  function startForget(kind: ForgetKind) {
    if (kind === "full" && r.kind === "note") setForget({ kind, heading: "", stage: "choose" });
    else void requestPlan(kind, "");
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  const current = r.status === "current";
  const plan = forget?.refusal?.plan;

  return (
    <div>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 lg:hidden" onClick={onBack}>
        <ArrowLeft /> Back
      </Button>
      <Surface padding="lg" className="rounded-2xl sm:p-8 lg:sticky lg:top-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={r.kind === "memory" ? "accent" : "info"}>{DESTINATION_LABEL[r.kind]}</Badge>
          <StatusBadge row={r} />
          <IndexBadge row={r} />
          <span className="text-sm text-muted-foreground">{BUCKET_LABEL[r.bucket]}</span>
        </div>
        <h3 ref={heading} tabIndex={-1} className="mt-4 text-balance text-2xl font-semibold leading-tight tracking-[-0.015em] outline-none">
          {r.title}
        </h3>
        {editing ? (
          <form onSubmit={saveCorrection} className="mt-3 space-y-2">
            <label htmlFor={`correct-${r.id}`} className="text-sm font-medium">
              Corrected fact
            </label>
            <Textarea id={`correct-${r.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} maxLength={800} autoFocus />
            <p className="text-sm text-muted-foreground">
              {r.kind === "fact"
                ? "The current version stays in the vault note, marked superseded, and leaves the index."
                : hindsightOn
                  ? "The current version is kept here marked superseded and retracted from Hindsight."
                  : "The current version is kept here marked superseded and leaves the local index (Hindsight is off)."}
            </p>
            <div className="flex gap-2">
              <Button type="submit" variant="accent" size="sm" disabled={busy || !draft.trim() || draft.trim() === r.text}>
                Save correction
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-4 max-w-[68ch] whitespace-pre-line text-[17px] leading-[1.75] text-foreground/95" data-testid="vault-reading-text">{r.text}</p>
        )}

        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-t border-border pt-5 text-[15px]">
          <dt className="text-muted-foreground">Date</dt>
          <dd>{fmtDay(r.date)}</dd>
          {r.actor && (
            <>
              <dt className="text-muted-foreground">Saved by</dt>
              <dd>{r.actor}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Version</dt>
          <dd>
            v{r.version} <span className="font-mono text-xs text-muted-foreground">{r.version_hash.slice(0, 12)}</span>
          </dd>
          <dt className="text-muted-foreground">Id</dt>
          <dd className="font-mono text-xs leading-5">{r.id}</dd>
          {r.status === "current" && (
            <>
              <dt className="text-muted-foreground">Processed</dt>
              <dd className="text-sm leading-5">
                {r.indexed === "confirmed" ? <ModelText m={r.processed_by} /> : <span className="text-muted-foreground">{INDEX_LABEL[r.indexed].label}</span>}
              </dd>
            </>
          )}
        </dl>

        {r.source.kind === "vault" ? (
          <div className="mt-5 rounded-2xl border border-border bg-inset p-4">
            <p className="text-sm font-medium text-muted-foreground">Source: Obsidian vault</p>
            <p className="mt-1 break-all font-mono text-[13px] leading-5 text-foreground">{r.source.path}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{r.source.link}</code>
              <Button variant="ghost" size="xs" onClick={() => copy(r.source.kind === "vault" ? r.source.link : "")} aria-label="Copy Obsidian link">
                <Copy /> {copied ? "Copied" : "Copy link"}
              </Button>
              <Button variant="ghost" size="xs" asChild>
                <a href={r.source.uri}>
                  <ExternalLink /> Open in Obsidian
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-border bg-inset p-4">
            <p className="text-sm font-medium text-muted-foreground">Source: Hindsight memory (app-owned, not in the vault)</p>
            <p className="mt-1 font-mono text-[13px] text-foreground">{r.id}</p>
          </div>
        )}

        {history.length > 1 && (
          <div className="mt-5">
            <h4 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <History className="size-4" aria-hidden /> History
            </h4>
            <ol className="mt-2 space-y-1.5 border-l border-border pl-3">
              {history.map((h) => (
                <li key={h.id} className="text-sm">
                  <button type="button" onClick={() => onOpen(h.id)} disabled={h.id === r.id} className={cn("text-left hover:underline disabled:no-underline", h.id === r.id ? "font-medium text-foreground" : "text-muted-foreground")}>
                    v{h.version} · {fmtDay(h.date)} · {h.status}
                  </button>
                  <span className="block truncate text-sm text-muted-foreground">{h.text}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {!editing && writes && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            {current && r.kind !== "note" && (
              <Button variant="outline" size="sm" onClick={() => (setDraft(r.text), setEditing(true))} disabled={busy}>
                <PencilLine /> Correct
              </Button>
            )}
            {current && r.kind === "memory" && (
              <Button variant="outline" size="sm" onClick={moveToVault} disabled={busy}>
                <Archive /> Save to vault
              </Button>
            )}
            {r.status === "excluded" && (
              <Button variant="outline" size="sm" onClick={reinclude} disabled={busy}>
                <Eye /> Re-include in index
              </Button>
            )}
            {detail.forget.includes("unindex") && current && (
              <Button variant="outline" size="sm" onClick={() => startForget("unindex")} disabled={busy}>
                <EyeOff /> Remove from index
              </Button>
            )}
            {detail.forget.includes("memory") && (
              <Button variant="outline" size="sm" className="text-danger hover:text-danger" onClick={() => startForget("memory")} disabled={busy}>
                <Trash2 /> Delete memory…
              </Button>
            )}
            {detail.forget.includes("full") && (
              <Button variant="outline" size="sm" className="text-danger hover:text-danger" onClick={() => startForget("full")} disabled={busy}>
                <Trash2 /> Forget everywhere…
              </Button>
            )}
          </div>
        )}
        {!writes && <p className="mt-4 text-sm text-muted-foreground">Correcting and forgetting are available once memory writing is switched on.</p>}
      </Surface>

      <AlertDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{forget?.kind === "memory" ? "Delete this Hindsight memory?" : "Forget this everywhere?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {forget?.stage === "choose"
                ? "Forget the whole note, or name one section heading to remove just that section."
                : forget?.refusal?.message ?? ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {forget?.stage === "choose" && (
            <div className="space-y-1.5">
              <label htmlFor={`heading-${r.id}`} className="text-sm font-medium">
                Section heading (optional)
              </label>
              <input
                id={`heading-${r.id}`}
                value={forget.heading}
                onChange={(e) => setForget({ ...forget, heading: e.target.value })}
                placeholder="Leave empty for the whole note"
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}
          {forget?.stage === "plan" && plan && (
            <div className="space-y-2 rounded-lg border border-border bg-inset p-3 text-sm">
              {plan.source && (
                <p>
                  <span className="text-muted-foreground">Vault: </span>
                  <span className="break-all font-mono text-xs">{plan.source.path}</span>
                  {plan.source.section.kind === "heading" ? ` › ${plan.source.section.heading}` : plan.source.section.kind === "note" ? " (whole note)" : " (this fact and its earlier versions)"}
                </p>
              )}
              <p>
                <span className="text-muted-foreground">Hindsight documents: </span>
                {plan.derived.hindsight_docs.length || "none indexed"}
              </p>
              <p>
                <span className="text-muted-foreground">Memory copies: </span>
                {plan.derived.memories.length ? plan.derived.memories.join(", ") : "none"}
              </p>
              <p className="text-sm text-muted-foreground">
                {forget.kind === "full"
                  ? "Git history of the wiki, other clones, sync copies and existing backups keep earlier copies; this app can't remove those."
                  : "Existing backups keep earlier copies until they expire."}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            {forget?.stage === "choose" ? (
              <Button variant="outline" onClick={() => forget && requestPlan("full", forget.heading)} disabled={busy}>
                Review what goes
              </Button>
            ) : (
              <Button className="bg-danger text-white hover:bg-danger/90" onClick={approveAndForget} disabled={busy || !forget?.refusal?.approval}>
                Approve and {forget?.kind === "memory" ? "delete" : "forget"}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const fmtWhen = (iso: string) => fmtDateTime(new Date(iso));

/**
 * Forgets waiting for approval (MEM-7). Read only: approving happens on the item itself (Delete
 * memory… / Forget everywhere… → "Approve and …"), which finds this same server-held request.
 * A program's request can only be approved by the owner's spoken yes, so it gets no Review button.
 */
export function PendingApprovals({ approvals, error, onReview }: { approvals: PendingApproval[] | null; error: string | null; onReview: (itemId: string) => void }) {
  if (error)
    return (
      <Notice tone="warn" className="mb-4" title="Couldn't check for approvals">
        {error}
      </Notice>
    );
  const waiting = (approvals ?? []).filter((a) => !a.granted_at);
  if (!waiting.length) return null;
  return (
    <Surface padding="md" className="mb-4" aria-label="Waiting for approval">
      <h2 className="text-sm font-semibold">
        Waiting for approval <span className="font-normal text-muted-foreground">({waiting.length})</span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Nothing is removed until someone approves. Open the item and choose Approve, or say yes to Jarvis when it asks.</p>
      <ul className="mt-2 space-y-2">
        {waiting.map((a) => {
          const t = approvalTarget(a.target);
          const byProgram = a.requested_actor !== "human";
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="min-w-0 flex-1">{a.summary || (a.action === "memory.bulk-retract" ? "Release a held mass removal" : "Forget an item")}</span>
              <span className="text-sm text-muted-foreground">
                asked by {a.requested_by}
                {byProgram ? " (a program)" : ""} · expires {fmtWhen(a.expires_at)}
              </span>
              {byProgram ? (
                <span className="text-sm text-warn">Needs your spoken yes to Jarvis</span>
              ) : a.action === "memory.bulk-retract" ? (
                <span className="text-sm text-muted-foreground">Approve it in the sync panel above</span>
              ) : t ? (
                <Button variant="outline" size="xs" onClick={() => onReview(t.id)}>
                  Review{t.heading ? ` (section “${t.heading}”)` : ""}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}
