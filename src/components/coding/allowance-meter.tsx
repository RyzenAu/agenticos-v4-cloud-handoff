import { fmtDateTime } from "@/lib/format";

export function knownPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function AllowanceMeter({ label, percent, resetsAt }: { label: string; percent: number | null; resetsAt: string | null }) {
  const known = knownPercent(percent);
  const reset = resetsAt && Number.isFinite(Date.parse(resetsAt)) ? fmtDateTime(resetsAt) : null;
  return <div className="mt-3">
    <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground"><span>{label}</span><span>{known ? `${Math.round(percent)}% used` : "Usage unavailable"}</span></div>
    {known && <div role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-inset"><div className={percent >= 90 ? "h-full bg-warn" : "h-full bg-primary"} style={{ width: `${percent}%` }} /></div>}
    <p className="mt-1 text-xs text-muted-foreground">{reset ? `Resets ${reset}` : "Reset time unavailable"}</p>
  </div>;
}
