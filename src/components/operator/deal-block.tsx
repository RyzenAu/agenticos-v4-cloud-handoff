// The lead drawer's deal economics, stage history and "how they like to be contacted" note.
// Saves to /__operator/leads/deal (scripts/leads/deals.ts) — local CRM fields only.
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge, Button, DetailSection, Notice, fmtDate, fmtRelative } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { aud, leadsApi, OFFER_LABEL, STAGE_LABEL, type LeadDeal, type Offer, type Owner } from "@/lib/leads";

const Block = DetailSection;

const dollars = (cents: number | null) => (cents === null ? "" : String(cents / 100));
/**
 * An A$ amount typed in the deal form, as cents. Blank means "use the offer's price" (null). A
 * negative, malformed ("1.2.3", "abc") or over-limit amount is refused with a message naming the
 * field, never silently flipped positive or cleared (audit F1-14). "1,099" and "$1,099.50" are fine.
 */
export function parseDealAmount(v: string, field: string): number | null {
  const t = v.trim().replace(/^A?\$\s*/i, "").replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (!t) return null;
  if (/^[-−]/.test(t)) throw new Error(`${field} can't be negative.`);
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) throw new Error(`${field} must be an amount in dollars, like 1500 or 1,099.50.`);
  const cents = Math.round(Number(t) * 100);
  if (cents > 100_000_000) throw new Error(`${field} must be A$1,000,000 or less.`);
  return cents;
}

export function DealBlock({ leadId, deal, by, onSaved }: { leadId: number; deal: LeadDeal; by: Owner; onSaved: () => void }) {
  const r = deal.record;
  const initial = { offer: r.offer ?? "", setup: dollars(r.setupCents), monthly: dollars(r.monthlyCents), probability: r.probability === null ? "" : String(Math.round(r.probability * 100)), close: r.expectedClose ?? "" };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => { setForm(initial); setError(""); setSavedAt(null); }, [leadId, deal.record.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const e = deal.economics;
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true); setError("");
    try {
      const p = form.probability.trim() === "" ? null : Number(form.probability) / 100;
      if (p !== null && (!Number.isFinite(p) || p < 0 || p > 1)) throw new Error("Probability must be 0–100%.");
      const setupCents = parseDealAmount(form.setup, "Setup");
      const monthlyCents = parseDealAmount(form.monthly, "Monthly");
      await leadsApi.saveDeal(leadId, {
        by, offer: (form.offer || null) as Offer | null, setupCents, monthlyCents,
        probability: p, expectedClose: form.close || null,
      });
      setSavedAt(new Date().toISOString());
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block title="Deal" actions={deal.stuck ? <Badge tone="warn">Stuck {deal.stuck.days} d · limit {deal.stuck.thresholdDays}</Badge> : undefined}>
      <div className="lead-deal-stats grid grid-cols-3 gap-2 rounded-lg bg-inset p-3">
        <div>
          <div className="ds-label text-muted-foreground">First-year value · ex GST</div>
          <div className="ds-num mt-1 text-base font-semibold text-foreground">{aud(e.valueCents)}</div>
          <details className="mt-2"><summary className="cursor-pointer text-sm text-muted-foreground">Price breakdown</summary><p className="mt-2 text-sm text-muted-foreground">{dealBreakdown(e, deal.monthsCounted)}</p></details>
          {e.packageState && e.packageState.state !== "chosen" && <div className={e.packageState.state === "unknown" ? "mt-1 text-xs text-danger" : "mt-1 text-xs text-warn"}>{e.packageState.note}</div>}
        </div>
        <div>
          <div className="ds-label text-muted-foreground">Probability</div>
          <div className="ds-num mt-1 text-base font-semibold text-foreground">{Math.round(e.probability * 100)}%</div>
          <div className="text-xs text-muted-foreground">{e.probabilitySource === "custom" ? `custom · stage says ${Math.round(deal.stageProbability * 100)}%` : e.probabilitySource}</div>
        </div>
        <div>
          <div className="ds-label text-muted-foreground">Weighted</div>
          <div className="ds-num mt-1 text-base font-semibold text-foreground">{aud(e.weightedCents)}</div>
          <div className="text-xs text-muted-foreground">{e.expectedClose ? `close ${fmtDate(e.expectedClose)}` : "no close date"}</div>
        </div>
      </div>
      <p className="mt-2 text-sm text-foreground">
        {STAGE_LABEL[deal.stage]}{deal.daysInStage !== null ? ` for ${deal.daysInStage} day${deal.daysInStage === 1 ? "" : "s"}${deal.daysInferred ? " or more" : ""}` : ""}
        <span className="text-muted-foreground"> · {deal.stuckDays ? `stuck after ${deal.stuckDays} d` : "no stuck limit at this stage"}</span>
      </p>
      {deal.stuck && <Notice tone="warn" className="mt-2" title="Suggested next step">{deal.stuck.action}</Notice>}

      <div className="lead-form mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
          Offer
          <Select value={form.offer || "default"} onValueChange={(v) => set("offer", v === "default" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">From the pitch ({e.offerLabel})</SelectItem>
              {(Object.keys(OFFER_LABEL) as Offer[]).map((o) => <SelectItem key={o} value={o}>{OFFER_LABEL[o]}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Setup / one-off (A$, ex GST)
          <Input inputMode="decimal" className="h-8 text-xs" placeholder={String(e.setupCents / 100)} value={form.setup} onChange={(ev) => set("setup", ev.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Monthly (A$, ex GST)
          <Input inputMode="decimal" className="h-8 text-xs" placeholder={String(e.monthlyCents / 100)} value={form.monthly} onChange={(ev) => set("monthly", ev.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Probability (%)
          <Input inputMode="numeric" className="h-8 text-xs" placeholder={`${Math.round(deal.stageProbability * 100)} (stage)`} value={form.probability} onChange={(ev) => set("probability", ev.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Expected close
          <Input type="date" className="h-8 text-xs" value={form.close} onChange={(ev) => set("close", ev.target.value)} />
        </label>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">Blank fields use the offer's price and the stage's probability.</p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="xs" variant={dirty ? "accent" : "outline"} onClick={save} disabled={busy || !dirty}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Save deal</Button>
        {dirty && <Button size="xs" variant="ghost" onClick={() => setForm(initial)}>Undo</Button>}
        {savedAt && !dirty && <span className="text-xs text-success">Saved {fmtRelative(savedAt)}</span>}
      </div>
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}

      <details className="ds-detail-secondary"><summary>Stage history</summary>
      <p className="mt-0.5 text-xs text-muted-foreground">In date order. Checks and scores show when they last ran.</p>
      <ol className="mt-2 flex flex-col">
        {[...deal.timeline].sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999")).map((s, i, all) => {
          const last = s.stage === deal.stage;
          const end = i === all.length - 1;
          return (
            <li key={s.stage} className="relative flex gap-3 pb-3 last:pb-0">
              {!end && <span className="absolute left-[3px] top-3 h-full w-px bg-border" aria-hidden="true" />}
              <span className={cn("relative mt-1.5 size-[7px] shrink-0 rounded-full", last ? "bg-brand" : "bg-border-strong")} aria-hidden="true" />
              <div className="min-w-0 text-sm">
                <span className={cn("font-medium", last ? "text-foreground" : "text-muted-foreground")}>{STAGE_LABEL[s.stage]}{last ? " (now)" : ""}</span>
                <span className="ds-num text-xs text-muted-foreground"> · {s.at ? fmtDate(s.at) : "date not recorded"}</span>
                <div className="text-xs text-muted-foreground">{s.evidence}</div>
              </div>
            </li>
          );
        })}
      </ol>
      </details>
    </Block>
  );
}

export function ContactPrefBlock({ leadId, value, by, onSaved }: { leadId: number; value: string; by: Owner; onSaved: () => void }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(value); setError(""); setSaved(false); }, [leadId, value]);
  const dirty = text.trim() !== value;
  async function save() {
    setBusy(true); setError("");
    try {
      await leadsApi.saveDeal(leadId, { by, contactPref: text });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Block title="How they like to be contacted">
      <Textarea value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} maxLength={500}
        placeholder="e.g. Practice manager Sue, mornings before 9; text first, no cold emails" className="h-16 text-sm" aria-label="How they like to be contacted" />
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="xs" variant={dirty ? "accent" : "outline"} onClick={save} disabled={busy || !dirty}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Save</Button>
        {saved && !dirty && <span className="text-xs text-success">Saved — shows on the call script</span>}
      </div>
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
    </Block>
  );
}

/**
 * One ex-GST breakdown: "A$1,500 website build + A$699/mo × 12, ex GST · A$X incl. GST". A proposed
 * receptionist setup fee is never shown as a number (and never as "A$0 setup").
 */
export function dealBreakdown(e: LeadDeal["economics"], months: number): string {
  if (e.valueSource === "custom") return `${aud(e.setupCents)} one-off + ${aud(e.monthlyCents)}/mo × ${months} (custom), ex GST · ${aud(e.valueInclGstCents)} incl. GST`;
  const parts: string[] = [];
  if (e.websiteCents) parts.push(`${aud(e.websiteCents)} website build`);
  if (e.receptionistSetup?.status === "approved") parts.push(`${aud(e.receptionistSetup.cents)} receptionist setup`);
  if (e.monthlyCents) parts.push(`${aud(e.monthlyCents)}/mo × ${months}`);
  const setupNote = e.receptionistSetup && e.receptionistSetup.status !== "approved" ? " · Setup: quoted separately once approved" : "";
  if (!parts.length) return `Not priced${setupNote}`;
  return `${parts.join(" + ")}, ex GST · ${aud(e.valueInclGstCents)} incl. GST${setupNote}`;
}
