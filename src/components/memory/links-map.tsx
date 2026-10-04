/**
 * "How your memory connects": the vault, the OS (the one writer), Hindsight and Hermes, with each
 * one's real state and what Hindsight has indexed. Shown on the Memory map, with a compact Hermes
 * version on the Knowledge graph. Reads /__memory/status, /__memory/links and /__hermes_status only;
 * whatever it can't read says "Not checked" (links-model.ts).
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpen, BrainCircuit, Database } from "lucide-react";
import type { ReactNode } from "react";
import hermesPortrait from "@/assets/hermes-portrait.png";
import { Disclosure, Widget, fmtCount, fmtRelative, type WidgetTone } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { LinksView } from "../../../scripts/memory/links";
import type { SyncStatus } from "../../../scripts/memory/types";
import { describeLinks, type EdgeState, type HermesStatusLike, type LinkNode, type LinkTone, type Loaded, type LinksModel } from "./links-model";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(res.status === 401 ? "sign in to use memory" : res.status === 403 ? "not available from this device" : `status ${res.status}`);
  return res.json();
}
const loaded = <T,>(q: { data?: T; error: unknown; isLoading: boolean }): Loaded<T> => ({
  data: q.data ?? null,
  error: q.error ? (q.error as Error).message : null,
  loading: q.isLoading,
});

/** The three reads behind the map, polled gently (30 s; status is cheap, links is a stat). */
export function useMemoryLinks(): LinksModel & { refreshedAt: number } {
  const opts = { refetchInterval: 30_000, retry: 1, staleTime: 10_000 } as const;
  const status = useQuery<SyncStatus>({ queryKey: ["memory-links", "status"], queryFn: () => getJson("/__memory/status"), ...opts });
  const links = useQuery<LinksView>({ queryKey: ["memory-links", "links"], queryFn: () => getJson("/__memory/links"), ...opts });
  const hermes = useQuery<HermesStatusLike>({ queryKey: ["memory-links", "hermes"], queryFn: () => getJson("/__hermes_status"), ...opts });
  return { ...describeLinks(loaded(status), loaded(links), loaded(hermes)), refreshedAt: Math.max(status.dataUpdatedAt, links.dataUpdatedAt) };
}

const TONE: Record<LinkTone, WidgetTone> = { ok: "success", warn: "warn", bad: "danger", neutral: "muted" };
const EDGE_WORD: Record<EdgeState, string> = { live: "Live", "read-only": "Read only", off: "Off", broken: "Not working", unknown: "Not checked" };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ds-num text-right text-foreground">{children}</dd>
    </div>
  );
}

const OpenLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to as never} className="ds-interactive inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium hover:bg-surface-raised">
    {children} <ArrowUpRight className="size-4" aria-hidden="true" />
  </Link>
);

export function MemoryLinksMap() {
  return <MemoryLinksMapView model={useMemoryLinks()} />;
}

/**
 * L2 (29 Sep, owner: "confusing, circular"): the four places memory lives as four widgets in the
 * page grid (was a bubble diagram with rings). Each says its state in a word; each link's state is
 * its line; the index counts and settings fold under Details. Render inside a WidgetGrid.
 */
export function MemoryLinksMapView({ model: m }: { model: LinksModel }) {
  const { vault, os, hindsight, hermes } = m.nodes;
  const edge = (from: LinkNode["id"]) => m.edges.find((e) => e.from === from)!;
  const h = m.hindsight;
  const toHindsight = edge("os");
  return (
    <>
      <Widget
        icon={BookOpen}
        title="Obsidian vault"
        value={vault.state === "Not checked" ? "Not checked" : h.notes}
        tone={vault.state === "Not checked" ? "muted" : "default"}
        line={vault.state === "Not checked" ? vault.detail : `notes · last scan ${h.lastScan ? fmtRelative(h.lastScan) : "not yet"}`}
        action={<OpenLink to="/memory/vault">Open the vault</OpenLink>}
        data-link-node="vault"
        data-tone={vault.tone}
      />
      <Widget
        icon={BrainCircuit}
        title="AgenticOS"
        value={os.state === "The one memory writer" ? "Writer" : os.state}
        tone={TONE[os.tone] === "success" ? "default" : TONE[os.tone]}
        line={`${toHindsight.label} to Hindsight: ${EDGE_WORD[toHindsight.state].toLowerCase()}`}
        data-link-node="os"
        data-tone={os.tone}
      />
      <Widget
        icon={Database}
        title="Hindsight"
        value={hindsight.state.replace(", read only", "")}
        tone={TONE[hindsight.tone]}
        line={`${hindsight.state.endsWith(", read only") ? "Read only · " : ""}${h.indexed !== null && h.docs !== null ? `${fmtCount(h.indexed)} of ${fmtCount(h.docs)} indexed` : "Index counts not reported"}`}
        data-link-node="hindsight"
        data-tone={hindsight.tone}
        data-testid="memory-links-hindsight"
      >
        <Disclosure summary="Details" className="-mx-3">
          <dl className="divide-y divide-border/60">
            <Fact label="Memories (not in the vault)">{fmtCount(h.memories)}</Fact>
            <Fact label="Waiting to index">{fmtCount(h.pending)}</Fact>
            <Fact label="Last sync">{h.lastSync ? fmtRelative(h.lastSync) : "Not yet"}</Fact>
            <Fact label="Shared bank">{h.bank ?? "—"}</Fact>
            <Fact label="Memory switch">{h.mode ?? "—"}</Fact>
            <Fact label="Failed writes">{fmtCount(h.errors)}</Fact>
          </dl>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{hindsight.detail} The OS is the only writer; agents go through it.</p>
        </Disclosure>
      </Widget>
      <HermesLinkCard model={m} />
    </>
  );
}

/**
 * Hermes as a source (it saves) and a consumer (it recalls), with an honest status, as one widget.
 * Also names Hindsight's state (Connected / Down), since Hermes recalls through it.
 */
export function HermesLinkCard({ model, compact = false }: { model: LinksModel; compact?: boolean }) {
  const hermes = model.nodes.hermes;
  const hindsight = model.nodes.hindsight;
  const calls = model.hermes;
  const edge = model.edges.find((e) => e.from === "hermes");
  return (
    <Widget
      icon={HermesIcon}
      title={compact ? "Hermes and your memory" : "Hermes"}
      value={hermes.state}
      tone={TONE[hermes.tone]}
      line={calls.lastCallAt ? `Last memory call: ${calls.lastTool ?? "call"}, ${fmtRelative(calls.lastCallAt)}` : calls.calls === null ? "Memory calls not checked" : "No memory calls since the OS started"}
      action={<OpenLink to="/agents/hermes">Open Hermes</OpenLink>}
      data-testid="hermes-link-card"
      data-state={hermes.state}
    >
      <dl className="divide-y divide-border/60">
        <Fact label="Hindsight">
          <span className={cn(hindsight.tone === "ok" ? "text-success" : hindsight.tone === "warn" ? "text-warn" : hindsight.tone === "bad" ? "text-danger" : "text-muted-foreground")} data-hindsight-state={hindsight.state}>
            {hindsight.state}
          </span>
        </Fact>
        <Fact label="Reads and saves">{hermes.state.startsWith("Connected") ? "Yes, screened by the OS" : hermes.state === "Not checked" ? "Not checked" : "No"}</Fact>
        {edge && <Fact label="Link to the OS">{EDGE_WORD[edge.state]}</Fact>}
      </dl>
      <Disclosure summary="Details" className="-mx-3 mt-1">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {hermes.detail} Agent calls come from Hermes or Claude Code; the OS doesn't record which, or what was asked.
        </p>
      </Disclosure>
    </Widget>
  );
}

function HermesIcon({ className }: { className?: string }) {
  return <img src={hermesPortrait} alt="" className={cn("rounded-full object-cover", className)} />;
}

/** The Hermes card on its own (Knowledge graph side rail), with its own reads. */
export function HermesMemoryLink() {
  return <HermesLinkCard model={useMemoryLinks()} compact />;
}
