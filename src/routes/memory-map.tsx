import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import {
  memorySignals,
  memorySources,
  memoryEvents,
  memoryStats,
  workspaces,
  type MemorySource,
} from "@/lib/mock-data";
import { useLiveData } from "@/lib/use-live-data";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { FileText, AlertTriangle, RefreshCw, X, Pencil, Cloud, Search, Copy, Check, Maximize2 } from "lucide-react";
import { MemoryBrain } from "@/components/memory-brain";
import type { MemNode } from "@/components/memory-graph-3d";
import { MemoryGraphLoader } from "@/components/memory-graph-loader";
import { KnowledgeExplorer, type KnowledgeGraph } from "@/components/knowledge-explorer";
import { knowledgeDemo } from "@/lib/mock-data";
import claudeLogoPng from "@/assets/claude-logo.png";
import obsidianLogoSvg from "@/assets/logos/obsidian.svg";
import pineconeIconSvg from "@/assets/logos/pinecone-icon.svg";
import { Badge, Button, PageFoot, PageHeader, Widget, WidgetGrid } from "@/components/ds";
import { MemoryLinksMap } from "@/components/memory/links-map";
import { humaniseTarget } from "@/lib/memory-title";

const MemoryGraph3D = lazy(() => import("@/components/memory-graph-3d"));

export const Route = createFileRoute("/memory-map")({
  // ?focus=<query> — voice/text can deep-link the Memory brain to a topic:
  // the graph flies to the matching cluster and the results panel opens.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  head: () => ({
    meta: [
      { title: docTitle("/memory-map") },
      {
        name: "description",
        content: "Interactive 3D map of CLAUDE.md files, decisions, and shared memory.",
      },
    ],
  }),
  component: MemoryPage,
});

const BASE_SOURCES = ["obsidian", "claude"] as const;
const PINECONE_SOURCES = ["obsidian", "claude", "pinecone"] as const;
type SourceId = "obsidian" | "claude" | "pinecone";

function MemoryPage() {
  const [selected, setSelected] = useState<MemNode | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const [activityQuery, setActivityQuery] = useState("");
  // Voice/text "pull up my X" deep-links here as ?focus=X. We mirror it into
  // state so the graph fly + explorer focus fire on arrival AND whenever the
  // query changes, then strip it from the URL so a manual reload is clean.
  const routeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const [focusQuery, setFocusQuery] = useState<string>("");
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    const f = (routeSearch?.focus ?? "").trim();
    if (!f) return;
    setFocusQuery(f);
    setFocusNonce((n) => n + 1);
    // Voice "pull up my X" → land in the immersive Brain, not just the page.
    setBrainOpen(true);
    // strip ?focus= from the URL (keep the state) so refresh doesn't re-fire.
    void navigate({ search: (prev: any) => ({ ...prev, focus: undefined }), replace: true });
  }, [routeSearch?.focus, navigate]);
  const liveData = useLiveData();
  // Mount-gated: this route is server-rendered (TanStack Start), and
  // `useLiveData()`'s query can resolve at different times on the server
  // (which never gets a second pass) versus the client's own first,
  // pre-mount render — whichever one currently holds real data at that
  // instant "wins" the paint, and the two disagree just often enough to
  // fail hydration here (observed: "Hydration failed because the server
  // rendered text didn't match the client" on /memory-map). `mounted`
  // starts `false` identically in both environments and only flips
  // (client-only) after mount, so the very first paint always agrees on
  // "nothing loaded yet" — the same pattern already used by useOperator()
  // and useWorkspaceProfile() elsewhere in this app — and the real numbers
  // land a tick later, after hydration has already succeeded.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const ld = (mounted ? liveData : {}) as any;
  const hasPinecone = (ld?.memory?.stats?.pineconeIndexes ?? 0) > 0 || ld?.detection?.memoryStores?.pinecone?.hasKey === true;
  const ALL_SOURCES = hasPinecone ? PINECONE_SOURCES : BASE_SOURCES;
  // Multi-select set. Empty set = nothing selected (graph empty).
  // All three present = "All" (everything visible).
  const [activeSet, setActiveSet] = useState<Set<SourceId>>(() => new Set<SourceId>(ALL_SOURCES));
  const isDemo = ld?.isExample === true;
  // Prefer the aggregator's totals; fall back to a sum of mock workspaces so
  // a cold-start clone (live-data.example.json) still renders a meaningful
  // header instead of "0 files indexed".
  const totalFiles =
    Number.isFinite(ld?.memory?.stats?.totalFiles) && ld.memory.stats.totalFiles > 0
      ? ld.memory.stats.totalFiles
      : workspaces.reduce((a, w) => a + w.memoryFiles.length, 0);
  const totalWorkspaces =
    Number.isFinite(ld?.memory?.stats?.totalWorkspaces) && ld.memory.stats.totalWorkspaces > 0
      ? ld.memory.stats.totalWorkspaces
      : workspaces.length;
  // Honest, not just "0": a bare zero here used to read as "we counted and
  // there are none" even when the aggregator never got far enough to know.
  // Only show a number when the aggregator actually reported one (>0);
  // otherwise say plainly whether a key was even detected.
  const pineconeIndexesStat = ld?.memory?.stats?.pineconeIndexes;
  const vectorIndexCount =
    Number.isFinite(pineconeIndexesStat) && pineconeIndexesStat > 0 ? pineconeIndexesStat : null;
  const vectorIndexLabel =
    vectorIndexCount !== null
      ? `${vectorIndexCount} vector index${vectorIndexCount === 1 ? "" : "es"}`
      : hasPinecone
        ? "vector index count unavailable"
        : "no vector index connected";

  const allOn = ALL_SOURCES.every((s) => activeSet.has(s));
  // Pass a single id to the graph: if all three are selected we send "all"
  // (no filter), otherwise we union the matching nodes.
  const matchesActive = (sourceTag: string | undefined, kind?: string) => {
    if (allOn) return true;
    if (activeSet.size === 0) return false;
    if (kind === "vector_store" && activeSet.has("pinecone")) return true;
    if (sourceTag === "pinecone" && activeSet.has("pinecone")) return true;
    if (sourceTag === "obsidian" && activeSet.has("obsidian")) return true;
    if (sourceTag === "claude" && activeSet.has("claude")) return true;
    return false;
  };

  const toggleSource = (id: SourceId | "all") => {
    setActiveSet((prev) => {
      if (id === "all") {
        // Clicking "All" snaps to everything on (or back to everything if it
        // was already all on — same end state, idempotent).
        return new Set(ALL_SOURCES);
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The graph still wants a single string. We compose one based on the set:
  // - all 3 → "all"
  // - 1 → that id
  // - 0 or 2 → use a synthetic id and rely on the graph's union via matchesActive
  const graphFilter = (() => {
    if (allOn) return "all";
    if (activeSet.size === 1) return [...activeSet][0];
    return `multi:${[...activeSet].sort().join(",")}`;
  })();

  // Knowledge graphs — one per Obsidian vault, emitted by the aggregator.
  // A cold-start clone (no live data) gets the bundled demo graph instead.
  const liveGraphs: KnowledgeGraph[] = Array.isArray(ld?.memory?.knowledge?.graphs)
    ? ld.memory.knowledge.graphs.filter((g: KnowledgeGraph) => g?.notes?.length > 0)
    : [];
  const knowledgeIsDemo = liveGraphs.length === 0;
  const knowledgeGraphs = knowledgeIsDemo ? [knowledgeDemo as KnowledgeGraph] : liveGraphs;

  // Use real aggregator events when available, else fall back to the mock
  // event feed shipped with the example file.
  const sourceEvents: typeof memoryEvents =
    Array.isArray(ld?.memory?.events) && ld.memory.events.length > 0
      ? ld.memory.events
      : memoryEvents;

  const visibleEvents = useMemo(() => {
    if (allOn) return sourceEvents;
    const filtered = sourceEvents.filter((e: any) => matchesActive(e.source));
    return filtered.length ? filtered : sourceEvents;
  }, [activeSet, sourceEvents]);

  // Free-text search across the (already source-filtered) activity feed.
  // Matches event type, target, destination and source so the user can find a
  // specific memory event instead of being stuck with the silently-truncated
  // top-8 list. Empty query = no filtering (identity).
  const activityResults = useMemo(() => {
    const q = activityQuery.trim().toLowerCase();
    if (!q) return visibleEvents;
    return visibleEvents.filter((e) =>
      [e.type, e.target, e.destination, e.source]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [activityQuery, visibleEvents]);

  // Stale + missing — prefer aggregator output.
  const staleList: { name: string; updated: string }[] =
    Array.isArray(ld?.memory?.staleFiles) && ld.memory.staleFiles.length > 0
      ? ld.memory.staleFiles.map((f: any) => ({ name: f.name, updated: f.updated ?? "—" }))
      : memorySignals.stale;
  const missingList: string[] =
    Array.isArray(ld?.memory?.missing) && ld.memory.missing.length > 0
      ? ld.memory.missing
      : memorySignals.missing;
  // Conflicts aren't yet emitted by the aggregator — show only mock data
  // when we're running off the example file.
  const conflictsList = isDemo ? memorySignals.conflicts : [];

  // Recompute stat counts based on filter — driven by live data so toggling
  // actually changes what's shown below the graph. Aggregator stats are the
  // source of truth; mock fallbacks are only used in demo mode.
  const tiles = useMemo(() => {
    const memNodes = liveData?.memory?.nodes ?? [];
    const stats = liveData?.memory?.stats ?? {};
    const liveActive = Number.isFinite(stats?.activeLast7d)
      ? stats.activeLast7d
      : isDemo
        ? memoryStats.activeLast7d
        : 0;
    const liveActivated = Number.isFinite(stats?.activatedLast7d)
      ? stats.activatedLast7d
      : isDemo
        ? memoryStats.activatedLast7d
        : 0;
    const liveMissing = Number.isFinite(stats?.missing)
      ? stats.missing
      : isDemo
        ? memoryStats.missing
        : 0;

    if (allOn) {
      return {
        active: liveActive,
        activated: liveActivated,
        // Count the REAL memory sources (obsidian + claude [+ pinecone]) — not a
        // hardcoded 3, which over-reported by 1 (it effectively counted the
        // "All" toggle as a source).
        sources: ALL_SOURCES.length,
        missing: liveMissing,
      };
    }

    const filtered = memNodes.filter((n: any) => matchesActive(n.source, n.kind));
    const fileCount = filtered.filter(
      (n: any) => n.kind === "file" || n.kind === "vector_store",
    ).length;
    const events = sourceEvents.filter((e: any) => matchesActive(e.source));
    const recallHits = events
      .filter((e: any) => e.type === "recall")
      .reduce((a: number, e: any) => a + (e.meta?.hits ?? 1), 0);

    const onlyPinecone = activeSet.size === 1 && activeSet.has("pinecone");
    if (onlyPinecone) {
      return {
        active: stats.pineconeIndexes ?? fileCount,
        activated: recallHits || 0,
        sources: stats.pineconeIndexes ?? 1,
        missing: 0,
      };
    }
    return {
      active: Math.max(0, fileCount),
      activated:
        recallHits || (isDemo ? Math.max(1, Math.round(memoryStats.activatedLast7d / 3)) : 0),
      sources: activeSet.size,
      missing: activeSet.has("claude") ? liveMissing : 0,
    };
  }, [activeSet, sourceEvents, isDemo]);

  // L2 (29 Sep, owner: "fill the screen like the Inbox"; "confusing, circular"): one headline, then a
  // full-width widget grid: where memory lives and whether it's connected (four widgets, no rings),
  // the numbers as widgets, the 3D graph with its source filter, then activity, stale and missing.
  // The explorer, the Brain and the inspector are unchanged. Sources sit in the page foot.
  return (
    <div className="min-w-0">
      <PageHeader
        title="Memory map"
        description="Where each kind of memory lives, and whether it's connected."
        meta={
          isDemo && (
            <Badge
              tone="warn"
              title="Sample data shipped with the app. Run `bun run scripts/aggregate.ts` to populate with your real ~/.claude/ + Obsidian + Pinecone activity."
            >
              Demo data
            </Badge>
          )
        }
      />

      <WidgetGrid aria-label="Memory map">
        {/* Hindsight, the vault, the OS and Hermes: their real status (W-D), as widgets (L2). */}
        <MemoryLinksMap />

        <Widget icon={FileText} title="Files indexed" value={totalFiles.toLocaleString("en-AU")} line={`across ${totalWorkspaces} workspaces`} />
        <Widget icon={RefreshCw} title="Active" value={tiles.active} line="worked on this week" />
        <Widget icon={Search} title="Activated" value={tiles.activated} line="pulled into a session" />
        <Widget icon={AlertTriangle} title="Missing" value={tiles.missing} tone={tiles.missing > 0 ? "danger" : "default"} line="folders without an index" />

        <section className="col-span-full relative overflow-hidden rounded-2xl border border-border bg-card" aria-label="Memory graph">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <h2 className="text-base font-medium text-foreground">Memory graph</h2>
              <p className="text-sm text-muted-foreground">
                {totalWorkspaces} workspaces · {totalFiles} files · {vectorIndexLabel} · {tiles.sources} source{tiles.sources === 1 ? "" : "s"} on
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SourceFilter activeSet={activeSet} allOn={allOn} onToggle={toggleSource} />
              {/* Single entry to full-screen memory. Voice lives INSIDE the Brain. */}
              <Button
                variant="accent"
                size="sm"
                onClick={() => setBrainOpen(true)}
                title="Enter the Brain — full-screen memory, click any cluster to grab it, talk to it hands-free"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Enter the Brain
              </Button>
            </div>
          </div>

          <div className="ds-stage relative overflow-hidden">
            {/* Unmount the page graph while the full-screen Brain is open — two
                live WebGL force-graphs at once tanked the frame rate. */}
            {brainOpen ? (
              <MemoryGraphLoader height={640} />
            ) : (
              <Suspense fallback={<MemoryGraphLoader height={640} />}>
                <MemoryGraph3D onSelect={setSelected} sourceFilter={graphFilter} focusQuery={focusQuery} focusNonce={focusNonce} />
              </Suspense>
            )}
          </div>
        </section>

        <Panel
          title="Recent activity"
          tone="ok"
          wide
          headerRight={
            <ActivitySearch
              value={activityQuery}
              onChange={setActivityQuery}
              shown={Math.min(activityResults.length, 8)}
              total={visibleEvents.length}
            />
          }
        >
          {activityResults.length > 0 ? (
            activityResults
              .slice(0, 8)
              .map((e, i) => <EventRow key={`${e.id}-${i}`} event={e} />)
          ) : (
            <li className="px-5 py-6 text-xs text-muted-foreground text-center">
              No activity matches “{activityQuery.trim()}”.
            </li>
          )}
        </Panel>
        <Panel title="Stale" tone="warn">
          {staleList.length > 0 ? (
            staleList.map((m, i) => <Row key={`${m.name}-${i}`} left={m.name} right={m.updated} tone="amber" />)
          ) : (
            <li className="px-5 py-4 text-sm text-muted-foreground">Nothing stale.</li>
          )}
        </Panel>
        <Panel title="Missing" tone="danger">
          {missingList.length + conflictsList.length > 0 ? (
            <>
              {missingList.map((m, i) => (
                <Row key={`${m}-${i}`} left={m} right="missing" tone="red" />
              ))}
              {conflictsList.map((c) => (
                <Row key={c} left={c} right="conflict" tone="red" />
              ))}
            </>
          ) : (
            <li className="px-5 py-4 text-sm text-muted-foreground">Nothing missing.</li>
          )}
        </Panel>
      </WidgetGrid>

      {/* Knowledge explorer — the relational layer: walk the vault's
          wikilink graph note-by-note like a knowledge base. */}
      <KnowledgeExplorer graphs={knowledgeGraphs} isDemo={knowledgeIsDemo} focusQuery={focusQuery} focusNonce={focusNonce} />

      <PageFoot>
        From this OS's memory status, Hermes' config (read only) and the memory aggregator. Drag the graph to rotate; hover a node to trace its links, click to inspect.
      </PageFoot>

      {selected && <Inspector node={selected} onClose={() => setSelected(null)} />}
      {brainOpen && (
        <MemoryBrain
          graphs={knowledgeGraphs}
          isDemo={knowledgeIsDemo}
          hasPinecone={hasPinecone}
          focusQuery={focusQuery}
          focusNonce={focusNonce}
          onClose={() => setBrainOpen(false)}
        />
      )}
    </div>
  );
}

function SourceFilter({
  activeSet,
  allOn,
  onToggle,
}: {
  activeSet: Set<SourceId>;
  allOn: boolean;
  onToggle: (id: SourceId | "all") => void;
}) {
  // Same mount-gate as MemoryPage above — this component queries live data
  // independently, so it needs the same first-paint determinism.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const liveDataRaw = useLiveData();
  const liveData = mounted ? liveDataRaw : ({} as ReturnType<typeof useLiveData>);
  const pineconeCount = liveData?.memory?.stats?.pineconeIndexes ?? 0;
  type Pill = {
    id: SourceId | "all";
    label: string;
    sub?: string;
    logo?: string;
    /** Render the icon as a white silhouette via mask-image (use for monochrome SVGs) */
    mask?: boolean;
    color: string;
    tooltip: string;
  };
  const pills: Pill[] = [
    { id: "all", label: "All", color: "#9aa3b0", tooltip: "Show every memory layer" },
    {
      id: "obsidian",
      label: "Obsidian",
      logo: obsidianLogoSvg,
      color: "#7c3aed",
      tooltip: "Markdown notes from your Obsidian vault",
    },
    {
      id: "claude",
      label: "Local Claude",
      logo: claudeLogoPng,
      color: "#FF7A3D",
      tooltip: "MEMORY.md, CLAUDE.md and decisions across your workspaces",
    },
    ...(liveData?.memory?.stats?.pineconeIndexes > 0 || liveData?.detection?.memoryStores?.pinecone?.hasKey
      ? [{
          id: "pinecone" as const,
          label: "Pinecone",
          sub: pineconeCount ? `${pineconeCount} indexes` : undefined,
          logo: pineconeIconSvg,
          mask: true,
          color: "#22D3EE",
          tooltip: "Vector indexes — every Pinecone collection feeds this memory source",
        }]
      : []),
  ];

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Memory sources">
      {pills.map((p) => {
        const isActive = p.id === "all" ? allOn : activeSet.has(p.id);
        return (
          <button
            key={p.id}
            onClick={() => onToggle(p.id)}
            title={p.tooltip}
            className={`group inline-flex items-center gap-2 rounded-full border pl-1 pr-3.5 py-1 text-xs transition-all ${
              isActive
                ? "border-foreground/40 bg-foreground/[0.08] text-foreground shadow-sm"
                : "border-border/70 bg-card/40 text-muted-foreground hover:text-foreground hover:border-foreground/20"
            }`}
            style={
              isActive
                ? { boxShadow: `0 0 0 1px ${p.color}66, 0 6px 18px -10px ${p.color}` }
                : undefined
            }
          >
            <span
              className="h-6 w-6 rounded-full grid place-items-center shrink-0"
              style={{
                background: `${p.color}1f`,
                boxShadow: `inset 0 0 0 1px ${p.color}55`,
              }}
            >
              {p.id === "all" ? (
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
              ) : p.mask && p.logo ? (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5"
                  style={{
                    background: p.color,
                    WebkitMaskImage: `url(${p.logo})`,
                    maskImage: `url(${p.logo})`,
                    WebkitMaskSize: "contain",
                    maskSize: "contain",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                    WebkitMaskPosition: "center",
                    maskPosition: "center",
                  }}
                />
              ) : (
                <img src={p.logo} alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
              )}
            </span>
            <span className="font-medium">{p.label}</span>
            {p.sub && (
              <span className="text-xs tabular-nums text-muted-foreground">{p.sub}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function EventRow({ event: e }: { event: (typeof memoryEvents)[number] }) {
  const Icon = e.type === "edit" ? Pencil : e.type === "vectorize" ? Cloud : Search;
  const tone = e.type === "edit" ? "text-success" : e.type === "vectorize" ? "text-info" : "text-warn";
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs hover:bg-foreground/[0.03] transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
        <span className="ds-label text-muted-foreground w-16 shrink-0">{e.type}</span>
        <span className="min-w-0 text-foreground/90 [overflow-wrap:anywhere]" title={e.target}>
          {humaniseTarget(e.target)}
          {e.destination && <span className="text-muted-foreground"> → {e.destination}</span>}
        </span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
        {e.time}
        {e.meta?.hits ? ` · ${e.meta.hits} hits` : ""}
      </span>
    </li>
  );
}

function Inspector({ node, onClose }: { node: MemNode; onClose: () => void }) {
  const ws = node.workspaceId ? workspaces.find((w) => w.id === node.workspaceId) : null;
  // Copy the node's content — the full file body if it resolves in an Obsidian
  // vault (via /__memory_note using the node name as the note id), else the
  // preview. This is the "click a node → grab it" beat from the reference.
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyable = node.kind === "file" || node.kind === "decision" || !!node.preview;
  const copyNode = async () => {
    setCopying(true);
    let content = node.preview ?? node.name ?? "";
    try {
      const r = await fetch(
        `/__memory_note?vault=&id=${encodeURIComponent((node.name ?? "").replace(/\.md$/i, ""))}`,
      ).then((res) => res.json());
      if (r?.ok && typeof r.content === "string" && r.content.length > 0) content = r.content;
    } catch { /* fall back to preview */ }
    let ok = false;
    try { await navigator.clipboard.writeText(content); ok = true; }
    catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = content; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { /* give up */ }
    }
    setCopying(false);
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-background/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl border border-border bg-card shadow-2xl m-0 md:m-6 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              {node.kind === "hub"
                ? "Shared core"
                : node.kind === "workspace"
                  ? "Workspace memory"
                  : node.kind === "vector_store"
                    ? "Pinecone index"
                    : node.kind === "file"
                      ? "Note"
                      : node.kind}
            </div>
            <div className="text-base font-semibold tracking-tight">{node.name}</div>
            {node.kind === "workspace" && ws && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {ws.memoryFiles.length} notes · last edited {node.updated ?? "—"}
              </div>
            )}
            {node.kind === "file" && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {node.size ?? "—"} · last edited {node.updated ?? "—"}
              </div>
            )}
            {node.kind === "vector_store" && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {node.vectorCount?.toLocaleString() ?? "—"} vectors ·{" "}
                {Array.isArray(node.namespaces) ? node.namespaces.length : (node.namespaces ?? "—")}{" "}
                namespaces
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {copyable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyNode()}
                disabled={copying}
                className={copied ? "border-success/50 bg-success-soft text-success" : undefined}
                title="Copy this memory to your clipboard"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : copying ? "Reading…" : "Copy"}
              </Button>
            )}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {node.kind === "file" && node.preview && (
          <div className="px-5 py-4 border-b border-border">
            <div className="text-xs text-muted-foreground mb-1.5">
              Preview
            </div>
            <p className="text-sm italic text-foreground/80 leading-relaxed">"{node.preview}"</p>
          </div>
        )}

        {node.kind === "vector_store" && (
          <div className="p-5 space-y-3">
            <div className="text-xs text-muted-foreground">
              Index details
            </div>
            <ul className="space-y-1.5 text-xs">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Embedding</span>
                <span className="font-mono text-foreground/90">
                  Pinecone · {node.dimension ?? 1024}-dim cosine
                </span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Namespaces</span>
                <span className="tabular-nums">{Array.isArray(node.namespaces) ? node.namespaces.length : (node.namespaces ?? "—")}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Total vectors</span>
                <span className="tabular-nums">{node.vectorCount?.toLocaleString() ?? "—"}</span>
              </li>
            </ul>
            {Array.isArray(node.namespaces) && node.namespaces.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-xs text-muted-foreground mb-2">Namespace breakdown</div>
                <ul className="space-y-1">
                  {node.namespaces.map((ns: any) => (
                    <li key={ns.name} className="flex justify-between text-xs">
                      <span className="font-mono text-foreground/90">{ns.name}</span>
                      <span className="tabular-nums text-muted-foreground">{ns.vectorCount?.toLocaleString?.()} vectors</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {ws && node.kind === "workspace" && (
          <div className="p-5 space-y-3">
            <div className="text-xs text-muted-foreground">
              Notes
            </div>
            <ul className="space-y-1.5">
              {ws.memoryFiles.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-foreground/90">{f.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {f.size} · {f.updated}
                  </span>
                </li>
              ))}
            </ul>
            {node.status === "missing" && (
              <div className="pt-2 border-t border-border text-xs text-warn">
                Suggested: add a MEMORY.md to make this workspace discoverable.
              </div>
            )}
            <div className="pt-2 border-t border-border text-xs text-muted-foreground">
              Path: <span className="font-mono text-foreground/80">{ws.path}</span>
            </div>
          </div>
        )}

        {node.kind === "hub" && (
          <div className="p-5 text-sm text-muted-foreground">
            The shared index aggregates CLAUDE.md, decisions, and session summaries across{" "}
            {workspaces.length} workspaces and{" "}
            {memorySources.filter((s) => s.kind === "vector").length} Pinecone indexes.
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({
  title,
  children,
  tone,
  wide,
  headerRight,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "ok" | "warn" | "danger";
  wide?: boolean;
  headerRight?: React.ReactNode;
}) {
  const Icon = tone === "warn" ? AlertTriangle : tone === "danger" ? FileText : RefreshCw;
  const c = tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-muted-foreground";
  return (
    <div className={`min-w-0 overflow-hidden rounded-2xl border border-border bg-card ${wide ? "col-span-full md:col-span-2" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-4 w-4 shrink-0 ${c}`} />
          <div className="text-sm font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</div>
        </div>
        {headerRight}
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

function ActivitySearch({
  value,
  onChange,
  shown,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  shown: number;
  total: number;
}) {
  const q = value.trim();
  return (
    <div className="flex items-center gap-2 shrink-0">
      {q && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {shown}/{total}
        </span>
      )}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Filter activity"
          aria-label="Filter recent memory activity"
          className="w-32 focus:w-40 transition-[width] rounded-full border border-border/70 bg-card/40 pl-7 pr-6 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/30"
        />
        {q && (
          <button
            onClick={() => onChange("")}
            aria-label="Clear activity filter"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ left, right, tone }: { left: string; right?: string; tone?: "amber" | "red" }) {
  const c = tone === "amber" ? "text-warn" : tone === "red" ? "text-danger" : "text-muted-foreground";
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
      <span className="min-w-0 text-foreground/90 [overflow-wrap:anywhere]" title={left}>{humaniseTarget(left)}</span>
      {right && <span className={`ds-label shrink-0 ${c}`}>{right}</span>}
    </li>
  );
}
