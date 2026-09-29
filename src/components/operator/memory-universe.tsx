import { buildMemoryCatalog } from "@/lib/memory-catalog";
import "./memory-universe-v5.css";
import { BRAIN_SOURCES, brainEnabled, sourceOrigin, nodeOrigin } from "@/lib/brain-sources";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  Globe2,
  Network,
  Maximize2,
  Search,
  MessageSquare,
  X,
} from "lucide-react";
import {
  MemoryGraph3D,
  memoryNodeOpacity,
  type MemNode,
  type MemLink,
} from "@/components/memory-graph-3d";
import { useLiveData } from "@/lib/use-live-data";
import { COLLECTIONS, useOperator, askOperator, operatorRequest } from "@/lib/operator";
import type { AudienceSnapshot, BusinessWorkspace } from "@/lib/business-workspace";
import { fmtDateTime } from "@/lib/format";
const COLORS: Record<string, string> = {
  claude: "#f4ad67",
  codex: "#a68cff",
  chatgpt: "#6febc0",
  meetings: "#b89bff",
  email: "#67c8ff",
  skills: "#f77fc8",
  hermes: "#d4e47b",
  openclaw: "#ff8e92",
  grokbot: "#d5e0f5",
  notion: "#d7dceb",
  obsidian: "#b292ff",
  images: "#87d8cd",
  files: "#8dbbff",
  manual: "#70d8ba",
  business: "#edc879",
  personal: "#ef9cb2",
  web: "#7cd3bc",
  agents: "#e2ba77",
  codebases: "#6fcacb",
};
const SOURCE_ORDER = [
  "business",
  "claude",
  "codex",
  "chatgpt",
  "email",
  "meetings",
  "skills",
  "hermes",
  "notion",
  "manual",
  "obsidian",
  "files",
  "images",
  "personal",
  "web",
  "agents",
  "codebases",
  "openclaw",
  "grokbot",
];
const LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  chatgpt: "ChatGPT",
  email: "Email",
  meetings: "Meetings",
  skills: "Skills",
  hermes: "Hermes",
  manual: "Your notes",
  codebases: "Projects",
  web: "Web & video",
  files: "Documents",
  images: "Photos",
  business: "Business notes",
  personal: "Personal",
  obsidian: "Obsidian",
  grokbot: "Grok",
};
type Detail = "macro" | "mid" | "micro" | "full";
const LIMITS: Record<Detail, number> = { macro: 90, mid: 180, micro: 450, full: 1200 };
const endpoint = (value: string | { id: string }): string =>
  typeof value === "object" ? value.id : value;
type GraphContext = {
  business:
    | null
    | (Pick<BusinessWorkspace, "profile" | "finances" | "progress"> & {
        audience: AudienceSnapshot[];
      });
};
const recordedDate = (value?: string) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date not recorded";
  return fmtDateTime(new Date(value), { year: true });
};
type CortexGraph = { nodes: MemNode[]; links: MemLink[] };
const SOURCE_FADE_MS = 450;
/** Outgoing records are visual-only; the searchable graph already excludes them. */
function useSourceFade(desired: CortexGraph, enabled: Record<string, boolean> | undefined) {
  const [visible, setVisible] = useState(desired);
  const previous = useRef(desired);
  const didShowRecords = useRef(false);
  useLayoutEffect(() => {
    const now = performance.now();
    const before = previous.current;
    const old = new Map(before.nodes.map((node) => [node.id, node]));
    const hasRecords = desired.nodes.some((node) => node.kind !== "hub" && !node.categoryHub);
    const wanted = hasRecords ? desired : { nodes: [], links: [] };
    const incoming = new Set(wanted.nodes.map((node) => node.id));
    const nodes: MemNode[] = wanted.nodes.map((node) => {
      const prior = old.get(node.id);
      if (prior?.visualTransition?.to === 0)
        return {
          ...node,
          visualTransition: {
            from: memoryNodeOpacity(prior, now),
            to: 1,
            at: now,
            duration: SOURCE_FADE_MS,
          },
        };
      if (!prior && didShowRecords.current)
        return { ...node, visualTransition: { from: 0, to: 1, at: now, duration: SOURCE_FADE_MS } };
      return prior?.visualTransition?.to === 1
        ? { ...node, visualTransition: prior.visualTransition }
        : node;
    });
    for (const node of before.nodes) {
      if (incoming.has(node.id)) continue;
      if (hasRecords && (!node.origin || enabled?.[node.origin] !== false)) continue;
      const existing = node.visualTransition;
      if (existing?.to === 0 && now >= existing.at + existing.duration) continue;
      nodes.push({
        ...node,
        visualTransition:
          existing?.to === 0
            ? existing
            : {
                from: memoryNodeOpacity(node, now),
                to: 0,
                at: now,
                duration: SOURCE_FADE_MS,
              },
      });
    }
    const kept = new Set(nodes.map((node) => node.id));
    const links = [...wanted.links];
    const keys = new Set(links.map((link) => `${endpoint(link.source)}\0${endpoint(link.target)}`));
    for (const link of before.links) {
      const source = endpoint(link.source),
        target = endpoint(link.target),
        key = `${source}\0${target}`;
      if (kept.has(source) && kept.has(target) && !keys.has(key)) {
        links.push(link);
        keys.add(key);
      }
    }
    const next = { nodes, links };
    if (hasRecords) didShowRecords.current = true;
    previous.current = next;
    setVisible(next);
    const ending = nodes
      .filter((node) => node.visualTransition)
      .map((node) => node.visualTransition!.at + node.visualTransition!.duration);
    if (!ending.length) return;
    const timer = window.setTimeout(
      () => {
        const final = {
          nodes: wanted.nodes.map(({ visualTransition: _fade, ...node }) => node),
          links: wanted.links,
        };
        previous.current = final;
        setVisible(final);
      },
      Math.max(0, Math.max(...ending) - now) + 24,
    );
    return () => window.clearTimeout(timer);
  }, [desired, enabled]);
  return visible;
}
export function MemoryUniverse({ onSource }: { onSource: (id: string) => void }) {
  const live = useLiveData(),
    { state } = useOperator(),
    queryClient = useQueryClient();
  const [previewSources, setPreviewSources] = useState<Record<string, boolean> | null>(null);
  const effectiveState = useMemo(
    () => (previewSources ? { ...state, brainSources: previewSources } : state),
    [state, previewSources],
  );
  useEffect(() => {
    const preview = (event: Event) => {
      const sources = (event as CustomEvent<{ sources: Record<string, boolean> }>).detail?.sources;
      if (sources) setPreviewSources(sources);
    };
    window.addEventListener("memory:source-preview", preview);
    return () => window.removeEventListener("memory:source-preview", preview);
  }, []);
  useEffect(() => {
    if (
      previewSources &&
      Object.entries(previewSources).every(([id, enabled]) => brainEnabled(state, id) === enabled)
    )
      setPreviewSources(null);
  }, [state.brainSources, previewSources]);
  const context = useQuery<GraphContext>({
    queryKey: ["memory-graph-context"],
    queryFn: () => operatorRequest("/brain/context?view=graph"),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const lastBusiness = useRef<GraphContext["business"]>(null);
  if (context.data?.business) lastBusiness.current = context.data.business;
  const [orbitEnabled, setOrbitEnabled] = useState(
    () =>
      typeof window === "undefined" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [layout, setLayout] = useState<"neural" | "sphere" | "network">("neural"),
    [detail, setDetail] = useState<Detail>("mid"),
    [origin, setOrigin] = useState("all");
  const sceneRef = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState(""),
    [focus, setFocus] = useState(""),
    [nonce, setNonce] = useState(0),
    [selected, setSelected] = useState<MemNode | null>(null),
    [expanded, setExpanded] = useState(false),
    [sourceText, setSourceText] = useState(""),
    [error, setError] = useState("");
  const {
    graph: catalog,
    notes,
    counts,
  } = useMemo(() => buildMemoryCatalog(live, state, lastBusiness.current), [live, state.sources, state.inbox, state.events, state.goals, context.data]);
  const graph = useMemo(() => {
    const nodes = catalog.nodes.filter(
      (node) => !node.origin || brainEnabled(effectiveState, node.origin),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      links: catalog.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
    };
  }, [catalog, effectiveState.brainSources]);
  const nodeMap = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of graph.links) {
      if (!map.has(l.source)) map.set(l.source, new Set());
      if (!map.has(l.target)) map.set(l.target, new Set());
      map.get(l.source)!.add(l.target);
      map.get(l.target)!.add(l.source);
    }
    return map;
  }, [graph]);
  const categories = useMemo(
    () =>
      SOURCE_ORDER.concat(
        BRAIN_SOURCES.map((s) => s.id).filter((id) => !SOURCE_ORDER.includes(id)),
      ).map((id) => ({
        id,
        name: LABELS[id] || BRAIN_SOURCES.find((s) => s.id === id)?.name || id,
        color: COLORS[id] || "#a3b4cb",
        count: counts[id] || 0,
        enabled: brainEnabled(effectiveState, id),
      })),
    [counts, effectiveState],
  );
  const searched = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      graph.nodes
        .filter(
          (n) =>
            n.kind !== "hub" &&
            !n.categoryHub &&
            (origin === "all" || n.origin === origin) &&
            `${n.name} ${n.preview || ""}`.toLowerCase().includes(searched),
        )
        .slice(0, 30),
    [graph, searched, origin],
  );
  const { displayedGraph, eligible, linkTotal } = useMemo(() => {
    const scoped = catalog.nodes.filter(
      (n) => n.kind === "hub" || origin === "all" || n.origin === origin,
    );
    const candidates =
      detail === "macro"
        ? scoped.filter((n) => n.kind === "hub" || n.kind === "workspace" || n.kind === "decision")
        : scoped;
    const allowed = new Set(candidates.map((n) => n.id)),
      chosen = new Set<string>(),
      limit = LIMITS[detail];
    const take = (id: string) => {
      if (allowed.has(id) && chosen.size < limit) chosen.add(id);
    };
    if (selected) {
      take(selected.id);
      for (const id of adjacency.get(selected.id) || []) take(id);
    }
    for (const n of candidates) if (n.kind === "hub" || n.categoryHub) take(n.id);
    // Round-robin source buckets keep a large provider from hiding every other source.
    const buckets = new Map<string, string[]>();
    for (const n of candidates) {
      const key = n.origin || "core";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(n.id);
    }
    const lists = [...buckets.values()];
    let index = 0;
    while (chosen.size < Math.min(limit, candidates.length)) {
      let any = false;
      for (const list of lists)
        if (index < list.length) {
          take(list[index]);
          any = true;
        }
      if (!any) break;
      index++;
    }
    const included = new Set(graph.nodes.map((node) => node.id));
    const linked = graph.links.filter((l) => chosen.has(l.source) && chosen.has(l.target));
    const prioritized = selected
      ? [
          ...linked.filter((l) => l.source === selected.id || l.target === selected.id),
          ...linked.filter((l) => l.source !== selected.id && l.target !== selected.id),
        ]
      : linked;
    return {
      displayedGraph: {
        nodes: candidates.filter((n) => chosen.has(n.id) && included.has(n.id)),
        links: prioritized.slice(0, detail === "full" ? 3200 : detail === "micro" ? 1600 : 600),
      },
      eligible: candidates.filter((node) => included.has(node.id)).length,
      linkTotal: linked.length,
    };
  }, [graph, catalog, origin, detail, selected, adjacency]);
  const visualGraph = useSourceFade(displayedGraph, effectiveState.brainSources);
  const hasVisualRecords = visualGraph.nodes.some(
    (node) => node.kind !== "hub" && !node.categoryHub,
  );
  const reset = useCallback(() => {
    setSelected(null);
    setSourceText("");
    setError("");
    setFocus("");
    setNonce((n) => n + 1);
  }, []);
  const chooseOrigin = useCallback(
    (id: string) => {
      setOrigin(id);
      setQuery("");
      reset();
    },
    [reset],
  );
  const fly = useCallback(
    (node: MemNode) => {
      if (node.kind === "hub") {
        chooseOrigin("all");
        setDetail("full");
        return;
      }
      setQuery("");
      setSelected(node);
      setOrigin(node.origin || "all");
      setDetail("micro");
      setFocus(node.name);
      setNonce((n) => n + 1);
      setError("");
      setSourceText("");
    },
    [chooseOrigin],
  );
  const search = useRouterState({
    select: (s) => s.location.search as { source?: string; focus?: string },
  });
  useEffect(() => {
    if (search.source) {
      const n = nodeMap.get(search.source.replace(/^mapped:/, ""));
      if (n) fly(n);
    } else if (search.focus) {
      setQuery(search.focus);
      setFocus(search.focus);
      setNonce((n) => n + 1);
    }
  }, [search.source, search.focus, nodeMap, fly]);
  useEffect(() => {
    if (!selected) return;
    const original = notes.get(selected.id);
    if (!original) return;
    const controller = new AbortController();
    fetch(
      `/__memory_note?vault=${encodeURIComponent(original.vault)}&id=${encodeURIComponent(original.id)}`,
      { signal: controller.signal },
    )
      .then((r) => r.json())
      .then((r) => {
        if (!r.ok) throw new Error(r.error || "Source unavailable");
        setSourceText(r.content);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [selected, notes]);
  useEffect(() => {
    if (!expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => expandButton.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(sceneRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) || []),
      ].filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [expanded]);
  useEffect(() => {
    if (!selected) return;
    const latest = nodeMap.get(selected.id);
    if (!latest) reset();
    else if (
      latest.preview !== selected.preview ||
      latest.meta !== selected.meta ||
      latest.name !== selected.name ||
      latest.updated !== selected.updated
    ) {
      setSelected(latest);
      setSourceText("");
    }
  }, [nodeMap, selected, reset]);
  useEffect(() => {
    const update = (event: Event) => {
      const change = (event as CustomEvent<{ sourcesOnly?: boolean; ids?: string[] }>).detail;
      if (change?.sourcesOnly && !change.ids?.includes("business")) return;
      void queryClient.invalidateQueries({ queryKey: ["memory-graph-context"] });
    };
    window.addEventListener("operator:brain-change", update);
    return () => window.removeEventListener("operator:brain-change", update);
  }, [queryClient]);
  useEffect(() => {
    if (origin !== "all" && (!brainEnabled(effectiveState, origin) || !counts[origin])) {
      chooseOrigin("all");
      setDetail("full");
    }
  }, [origin, effectiveState, counts, chooseOrigin]);
  useEffect(() => {
    const clear = () => {
      chooseOrigin("all");
      setDetail("full");
    };
    window.addEventListener("memory:clear-selection", clear);
    return () => window.removeEventListener("memory:clear-selection", clear);
  }, [chooseOrigin]);
  useEffect(() => {
    const available =
      selected &&
      nodeMap.has(selected.id) &&
      brainEnabled(effectiveState, selected.origin || nodeOrigin(selected));
    window.dispatchEvent(
      new CustomEvent("memory:selection", {
        detail: available
          ? {
              id: selected.id,
              title: selected.name,
              origin: selected.origin || nodeOrigin(selected),
              text: (sourceText || selected.preview || selected.meta || "").slice(0, 4000),
            }
          : null,
      }),
    );
  }, [selected, sourceText, nodeMap, effectiveState]);
  const connections = selected
    ? ([...(adjacency.get(selected.id) || [])]
        .map((id) => nodeMap.get(id))
        .filter(Boolean) as MemNode[])
    : [];
  const activeCategory = categories.find((c) => c.id === origin);
  const includedCount = categories.filter((c) => c.enabled).length;
  const hasRecords = graph.nodes.some(
    (n) => n.kind !== "hub" && !n.categoryHub && (origin === "all" || n.origin === origin),
  );
  function closeInspector() {
    chooseOrigin("all");
    setDetail("full");
  }
  return (
    <section
      ref={sceneRef}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? "Immersive memory network" : "Visual cortex"}
      className={`ar-universe neural-universe neural-wide ${expanded ? "is-expanded" : ""}`}
      data-layout={layout}
      data-scope={origin}
    >
      <div className="ar-universe-top neural-header">
        <div className="cortex-visual-title">
          <span className="cortex-live-dot" />
          <h2>Visual cortex</h2>
        </div>
        <div className="neural-layout-switch" role="group" aria-label="Cortex layout">
          {(
            [
              { id: "neural", name: "Neural", Icon: BrainCircuit },
              { id: "sphere", name: "Sphere", Icon: Globe2 },
              { id: "network", name: "Network", Icon: Network },
            ] as const
          ).map(({ id, name, Icon }) => (
            <button key={id} aria-pressed={layout === id} onClick={() => setLayout(id)}>
              <Icon size={13} />
              {name}
            </button>
          ))}
        </div>
        <label className="op-search neural-header-search">
          <Search size={13} />
          <input
            aria-label="Find a memory node"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) fly(matches[0]);
            }}
            placeholder="Find a memory…"
          />
          {query && (
            <button aria-label="Clear memory search" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </label>
        <span className="ar-graph-count">
          {(hasRecords ? graph.nodes.length : 0).toLocaleString()} nodes <i />
          {(hasRecords ? graph.links.length : 0).toLocaleString()} links
        </span>
        <button
          ref={expandButton}
          className="neural-immersive-button"
          aria-label={expanded ? "Exit immersive memory" : "Explore full-screen memory network"}
          title={
            expanded
              ? "Back to Memory · Escape"
              : "Enter the full network. Drag to explore and scroll to zoom."
          }
          onClick={() => {
            if (expanded) setExpanded(false);
            else {
              setLayout("network");
              setDetail("full");
              chooseOrigin("all");
              setQuery("");
              setExpanded(true);
            }
          }}
        >
          {expanded ? <X size={14} /> : <Maximize2 size={14} />}
          <span>{expanded ? "Back to Memory" : "Explore network"}</span>
        </button>
      </div>
      <div className="ar-universe-body">
        <div className="ar-universe-canvas ds-stage">
          {hasVisualRecords ? (
            <MemoryGraph3D
              graphData={visualGraph}
              layout={layout}
              viewKey={`${origin}:${detail}`}
              orbitEnabled={orbitEnabled}
              onOrbitChange={setOrbitEnabled}
              embedded
              onSelect={fly}
              focusQuery={focus}
              focusNonce={nonce}
            />
          ) : (
            <div className="neural-quiet-empty" role="status">
              <span className="neural-empty-symbol">
                <BrainCircuit size={28} strokeWidth={1} />
              </span>
              <h3>
                {includedCount === 0
                  ? "Switch on a source to explore"
                  : context.isPending
                    ? "Loading your memories"
                    : "Your memory starts here"}
              </h3>
              <p>
                {includedCount === 0
                  ? "Your memories are still saved. Switch on a source to explore them."
                  : "Connect an app or add a memory to start seeing connections."}
              </p>
            </div>
          )}
          <div className="neural-detail-bar">
            <div className="neural-detail-levels" role="group" aria-label="Memory detail level">
              {(["macro", "mid", "micro", "full"] as Detail[]).map((level) => (
                <button
                  key={level}
                  aria-pressed={detail === level}
                  disabled={!hasRecords}
                  title={
                    {
                      macro: "Source hubs and workspaces",
                      mid: "A balanced overview, up to 180 nodes",
                      micro: "Detail inside one source, up to 450 nodes",
                      full: "Full network, up to 1,200 nodes at once",
                    }[level]
                  }
                  onClick={() => {
                    setDetail(level);
                    setSelected(null);
                    setFocus("");
                    setNonce((n) => n + 1);
                    if (level === "full") setOrigin("all");
                    if (level === "micro" && origin === "all")
                      setOrigin([...categories].sort((a, b) => b.count - a.count)[0]?.id || "all");
                  }}
                >
                  <span className={`neural-detail-glyph ${level}`} aria-hidden />
                  <span>{level[0].toUpperCase() + level.slice(1)}</span>
                </button>
              ))}
            </div>
            {hasRecords && (
              <div className="neural-render-count">
                {displayedGraph.nodes.length.toLocaleString()}
                {displayedGraph.nodes.length < eligible
                  ? ` of ${eligible.toLocaleString()}`
                  : ""}{" "}
                shown{linkTotal > displayedGraph.links.length ? " · links limited" : ""}
                <small>
                  {displayedGraph.nodes.length < eligible
                    ? "Search to open any memory"
                    : "Drag to orbit · scroll to zoom"}
                </small>
              </div>
            )}
          </div>
          {origin !== "all" && (
            <button
              className="neural-scope-chip"
              onClick={closeInspector}
              aria-label="Return to all sources"
            >
              <i style={{ background: activeCategory?.color }} />
              {activeCategory?.name || origin}
              <span>All sources</span>
              <X size={11} />
            </button>
          )}
          {selected && (
            <aside className="neural-node-inspector" aria-label="Selected memory">
              <div className="neural-inspector-top">
                <span className="op-eyebrow">
                  {selected.source === "library"
                    ? "SAVED MEMORY"
                    : selected.source === "business-dashboard"
                      ? "BUSINESS DASHBOARD"
                      : selected.categoryHub
                        ? "SOURCE GROUP"
                        : selected.kind}
                </span>
                <button aria-label="Close memory details" onClick={closeInspector}>
                  <X size={15} />
                </button>
              </div>
              <div className="ar-node-detail">
                <h3>{selected.name}</h3>
                {selected.source === "business-dashboard" && selected.meta && (
                  <small className="neural-record-meta">{selected.meta}</small>
                )}
                <p className="neural-inspector-preview">
                  {(
                    sourceText ||
                    selected.preview ||
                    selected.meta ||
                    "Open a connected record to explore its context."
                  ).slice(0, 4000)}
                </p>
                {error && <p role="alert">{error}</p>}
                <div className="ar-node-actions">
                  {selected.source === "business-dashboard" && (
                    <Link className="op-button" to="/business">
                      <ArrowUpRight size={13} />
                      Open dashboard
                    </Link>
                  )}
                  {selected.source === "library" && (
                    <button
                      className="op-button"
                      onClick={() => {
                        setExpanded(false);
                        onSource(selected.id);
                      }}
                    >
                      <BookOpen size={13} />
                      Open source
                    </button>
                  )}
                  <button
                    className="op-button primary"
                    onClick={() => {
                      setExpanded(false);
                      askOperator(
                        `What should I know about ${selected.name}?`,
                        `MEMORY SOURCE: ${selected.name}\n${(sourceText || selected.preview || selected.meta || "No source text available.").slice(0, 4000)}`,
                        true,
                        undefined,
                        selected.origin || nodeOrigin(selected),
                      );
                    }}
                  >
                    <MessageSquare size={13} />
                    Chat about this memory
                  </button>
                </div>
                <div className="op-eyebrow">CONNECTED TO · {connections.length}</div>
                {connections.slice(0, 6).map((n) => (
                  <button className="ar-node-row" key={n.id} onClick={() => fly(n)}>
                    <i style={{ background: n.color }} />
                    <span>{n.name}</span>
                    <ArrowUpRight size={11} />
                  </button>
                ))}
                <button className="neural-back" onClick={closeInspector}>
                  <ArrowLeft size={12} />
                  All sources
                </button>
              </div>
            </aside>
          )}
          {searched && !selected && (
            <div className="neural-search-results" aria-label="Memory search results">
              <div className="neural-search-heading">
                <span>Matching memories</span>
                <small>{matches.length === 30 ? "30+" : matches.length}</small>
                <button aria-label="Close search results" onClick={() => setQuery("")}>
                  <X size={13} />
                </button>
              </div>
              {matches.map((n) => (
                <button className="ar-node-row" key={n.id} onClick={() => fly(n)}>
                  <i style={{ background: n.color }} />
                  <span>{n.name}</span>
                  <ArrowUpRight size={11} />
                </button>
              ))}
              {!matches.length && <p>No matching memories in this source.</p>}
            </div>
          )}
          {context.isError && brainEnabled(state, "business") && (
            <p className="neural-context-error" role="alert">
              Dashboard context unavailable.{" "}
              <button onClick={() => void context.refetch()}>Retry</button>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
