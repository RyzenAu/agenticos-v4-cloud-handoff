import { useEffect, useMemo, useState } from "react";
import { BookMarked } from "lucide-react";
import { Badge } from "@/components/ds";
import { cn } from "@/lib/utils";
import { BUCKET_LABEL, DESTINATION_LABEL, createHttpMemoryClient, type FactsUsed, type MemoryClient } from "./client";

/**
 * "Facts used" for one Jarvis answer. Pass the `facts_used` ids the answer came back with
 * (recall_memory / /__memory/recall / voice replies all return them). Ids are re-resolved on the
 * server, so anything forgotten, superseded or removed from the index since the answer shows as
 * unavailable, never as its old text. Each fact names its source: the vault path or the mem- id.
 */
export function useFactsUsed(refs: readonly string[], client?: MemoryClient) {
  const c = useMemo(() => client ?? createHttpMemoryClient(), [client]);
  const key = refs.join("|");
  const [state, setState] = useState<{ loading: boolean; data: FactsUsed | null; error: string | null }>({ loading: refs.length > 0, data: null, error: null });
  useEffect(() => {
    if (!refs.length) return setState({ loading: false, data: { facts: [], missing: [] }, error: null });
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    c.factsUsed([...refs])
      .then((data) => live && setState({ loading: false, data, error: null }))
      .catch((e: Error) => live && setState({ loading: false, data: null, error: e.message }));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, key]);
  return state;
}

export function FactsUsedPanel({
  refs,
  client,
  onOpenFact,
  className,
}: {
  refs: readonly string[];
  client?: MemoryClient;
  /** Open the Memory destination at this item. */
  onOpenFact?: (id: string) => void;
  className?: string;
}) {
  const { loading, data, error } = useFactsUsed(refs, client);
  if (!refs.length) return null;
  return (
    <section aria-label="Facts used" className={cn("rounded-lg border border-border bg-inset p-3", className)}>
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BookMarked className="size-3.5" aria-hidden /> Facts used {data && `(${data.facts.length})`}
      </h3>
      {loading && <p className="mt-2 text-xs text-muted-foreground">Checking memory…</p>}
      {error && <p className="mt-2 text-xs text-danger">Couldn't load the facts behind this answer: {error}</p>}
      {data && (
        <ul className="mt-2 space-y-1.5">
          {data.facts.map((f) => (
            <li key={f.id} className="text-sm">
              <button type="button" onClick={() => onOpenFact?.(f.id)} disabled={!onOpenFact} className="text-left text-foreground hover:underline disabled:no-underline">
                {f.title}
              </button>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Badge tone={f.kind === "memory" ? "accent" : "info"}>{DESTINATION_LABEL[f.kind]}</Badge>
                <span>{BUCKET_LABEL[f.bucket]}</span>
                <span>v{f.version}</span>
                <span className="break-all font-mono">{f.source.kind === "vault" ? f.source.path : f.id}</span>
              </span>
            </li>
          ))}
          {data.missing.length > 0 && (
            <li className="text-xs text-muted-foreground">
              {data.missing.length} {data.missing.length === 1 ? "item is" : "items are"} no longer available (forgotten, corrected or removed from the index).
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
