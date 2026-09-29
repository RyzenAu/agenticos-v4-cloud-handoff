import { useEffect, useId, useState } from "react";
import { operatorRequest } from "@/lib/operator";
import { Button, Notice } from "@/components/ds";
import { leadsApi, type Offer, type Owner } from "@/lib/leads";
import { formatAud, RECEPTIONIST_PACKAGES } from "@/lib/receptionist-packages";

type Pipeline = { stage: string; evidence: string; nextAction: string; owner: string; closed: boolean };
const TIERS = [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier);
const hasReceptionist = (offer?: Offer) => offer === "receptionist" || offer === "both";

/**
 * Sales pipeline + local drafts. For a receptionist offer the lead's catalogue package is chosen
 * here, saved on the deal (so the deal value follows it) and sent with every draft request; the
 * server validates it against the catalogue.
 */
export function SalesBackofficePanel({ id, pipeline, initialFiles, refresh, by, offer, packageId }: {
  id: number; pipeline?: Pipeline; initialFiles?: string[]; refresh: () => void;
  by?: Owner; offer?: Offer; packageId?: string | null;
}) {
  const uid = useId();
  const [files, setFiles] = useState(initialFiles ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // No silent default: `packageId` is only a package the founder CHOSE (never the estimate's
  // assumed Essential, audit F1-02). Until one is chosen the selector shows "Choose a package…",
  // the drafts are disabled, and the server refuses them too.
  const [pkg, setPkg] = useState<string>(packageId ?? "");
  // The deal detail can arrive after the panel mounts: follow the saved package when it does.
  useEffect(() => { setPkg(packageId ?? ""); }, [packageId]);
  const showPackage = hasReceptionist(offer);
  async function choosePackage(next: string) {
    setError(""); setBusy(true);
    const previous = pkg;
    setPkg(next);
    try { await leadsApi.saveDeal(id, { by: by ?? "usman", packageId: next }); refresh(); }
    catch (e) { setPkg(previous); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function draft(kind: "proposal" | "deposit-invoice") {
    setBusy(true); setError("");
    try {
      const result = await operatorRequest<{ files: string[] }>(`/leads/${kind}`, { lead: id, ...(showPackage && pkg ? { packageId: pkg } : {}) }, "POST");
      setFiles(existing => [...new Set([...existing, ...result.files])]);
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function open(file: string) {
    setError("");
    try {
      const result = await operatorRequest<{ content: string; mime: string }>(`/leads/draft-file?id=${id}&file=${encodeURIComponent(file)}`, undefined, "GET");
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
      const a = document.createElement("a"); a.href = url; a.download = file; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setError((e as Error).message); }
  }
  return <section className="border-t border-border pt-4" aria-label="Sales pipeline and drafts">
    <h3 className="ds-label text-muted-foreground">Sales pipeline</h3>
    {pipeline && <p className="mt-1 text-sm">{pipeline.stage} · {pipeline.evidence}<br />Next: {pipeline.nextAction} ({pipeline.owner})</p>}
    {showPackage && <label htmlFor={`${uid}-pkg`} className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
      Receptionist package (prices the deal and the drafts)
      <select id={`${uid}-pkg`} value={pkg} disabled={busy} onChange={(e) => void choosePackage(e.target.value)}
        className="h-9 rounded-md border border-border bg-transparent px-2 text-sm text-foreground">
        {!pkg && <option value="" disabled>Choose a package…</option>}
        {TIERS.map((p) => <option key={p.id} value={p.id}>{p.shortName} · {formatAud(p.pricing.monthly.cents)}/month ex GST ({p.pricing.status})</option>)}
      </select>
    </label>}
    {showPackage && !pkg && <p className="mt-1 text-xs text-warn">Package not chosen: the deal value assumes Essential for the estimate. Choose one to draft.</p>}
    <p className="mt-2 text-xs text-muted-foreground">Local drafts only. Nothing is sent or charged. Founder review required before use.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="xs" variant="outline" disabled={busy || pipeline?.closed || (showPackage && !pkg)} onClick={() => draft("proposal")}>Draft proposal</Button>
      <Button size="xs" variant="outline" disabled={busy || pipeline?.closed || (showPackage && !pkg)} onClick={() => draft("deposit-invoice")}>Draft deposit invoice</Button>
    </div>
    {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
    {files.length > 0 && <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{files.map(file => <li key={file}><button className="underline underline-offset-2" onClick={() => open(file)}>Download DRAFT {file}</button></li>)}</ul>}
  </section>;
}
