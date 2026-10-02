import { useEffect, useId, useRef, useState } from "react";
import { calculateEconomics, CLIENT_COUNTS, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, DEFAULT_PAYMENT, DEFAULT_TARGET_MARGIN_BPS, defaultEconomicsInput, ECONOMICS_AS_OF, exportEconomicsDraftJson, PRICE_RECOMMENDATION, RATE_SOURCES, scenariosFor, STRIPE_BILLING_BPS, STRIPE_CARD_BPS, STRIPE_FROM_2026_10_01 } from "../../lib/business-economics";
import { useRouter } from "@tanstack/react-router";
import { usePageContext } from "@/components/shell/page-context";
import type { CostRate, EconomicsInput } from "../../lib/business-economics";
import type { UsageScenario } from "../../lib/receptionist-packages";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES, type ReceptionistPackage } from "../../lib/receptionist-packages";
import { priceStatusLines } from "../../lib/price-status";
import { fmtDay, fmtProse } from "@/lib/format";

/**
 * Prices, usage and onboarding come only from the selected catalogue entry (src/lib/receptionist-packages.ts,
 * ex GST), on first load, after a refresh and whenever the package changes. Approval is per field
 * (src/lib/price-status.ts): monthly price, minutes and extra-minute rate vs the setup fee vs pilot terms.
 */
function packageFields(pkg: ReceptionistPackage) {
  const base = scenariosFor(pkg).find((s) => s.id === "base") ?? scenariosFor(pkg)[0];
  return { monthly: String(pkg.pricing.monthly.cents / 100), setup: String(pkg.pricing.setup.cents / 100), overage: String(pkg.pricing.overagePerMinute.cents / 100), included: String(pkg.pricing.includedMinutes), ...scenarioFields(base), notifications: "0", onboarding: String(pkg.model.onboardingMinutes) };
}
/** A scenario's calls as one row: every bucket's calls summed, seconds weighted by count (exact when there is one bucket). */
export function scenarioFields(s: UsageScenario) {
  const count = s.calls.reduce((n, c) => n + c.count, 0);
  const seconds = count ? Math.round(s.calls.reduce((n, c) => n + c.count * c.seconds, 0) / count) : 0;
  return { calls: String(count), seconds: String(seconds), sms: String(s.smsSegments), support: String(s.supportMinutes) };
}
const pct = (bps: number) => String(bps / 100);
/** What each input is called in an error, so a paused estimate says which field to fix (F1-13). */
const FIELD_LABEL: Record<string, string> = {
  monthly: "Monthly price", setup: "Setup fee", included: "Included minutes", overage: "Overage / minute", clients: "Clients",
  hourly: "Labour value / hour", support: "Support minutes", onboarding: "Onboarding minutes", calls: "Connected calls",
  seconds: "Seconds per call", sms: "SMS segments", notifications: "Notifications", target: "Target margin", fx: "USD per A$1",
  card: "FX/card buffer", payment: "Payment fee", paymentFixed: "Payment fixed fee",
};
/** Clients the workbench starts at: the package-margin base case (the Finance page's "5 clients"). */
export const WORKBENCH_BASE_CLIENTS = CLIENT_COUNTS[1];
/** First-load assumption fields, straight from the economics constants (never typed copies). */
export function workbenchDefaults() {
  return {
    clients: String(WORKBENCH_BASE_CLIENTS),
    hourly: String(DEFAULT_LABOUR_HOURLY_CENTS / 100),
    fx: String(DEFAULT_FX.usdPerAudMillionths / 1_000_000),
    card: String(DEFAULT_FX.cardFeeBps / 100),
    target: String(DEFAULT_TARGET_MARGIN_BPS / 100),
    payment: pct(DEFAULT_PAYMENT.percentBps),
    paymentFixed: (DEFAULT_PAYMENT.fixedCents / 100).toFixed(2),
  };
}
/** ISO date → "25 Sept 2026" (locale-independent; src/lib/format.ts). */
export const longDate = (iso: string) => fmtDay(iso, { year: true });
/** The assumption sentences, derived from the constants so the text can't drift from the maths. */
export function assumptionText() {
  const number = DEFAULT_COST_RATES.find((r) => r.id === "number");
  const perNumber = number?.micros == null ? "an unknown monthly rate" : `${number.currency === "USD" ? "US$" : "A$"}${(number.micros / 1_000_000).toFixed(2)}/month`;
  return {
    fx: `US$${(DEFAULT_FX.usdPerAudMillionths / 1_000_000).toFixed(4)} per A$1 (RBA reference rate, ${longDate(DEFAULT_FX.date)}). Conversion divides USD by this rate. Edited FX is a scenario override, not a new RBA observation. Card/FX buffer defaults to an assumed ${DEFAULT_FX.cardFeeBps / 100}%.`,
    stripe: `Stripe AU domestic cards: ${STRIPE_CARD_BPS / 100}% + A$${(STRIPE_FROM_2026_10_01.fixedCents / 100).toFixed(2)}, fees incl. GST (Stripe's own page, re-read ${longDate(STRIPE_FROM_2026_10_01.checkedAt)}; the rate effective from 1 October 2026), plus Stripe Billing ${STRIPE_BILLING_BPS / 100}%, because the receptionist bills through Stripe subscriptions. So the default payment fee is ${pct(DEFAULT_PAYMENT.percentBps)}% + A$${(DEFAULT_PAYMENT.fixedCents / 100).toFixed(2)} on the charge including GST. One monthly payment and one setup payment per client.`,
    telephony: `The telephony estimate uses one ${number?.label ?? "phone number"} per client (${perNumber}) with an inbound SIP leg; actual routing is unverified.`,
  };
}

/** Always "A$…" (en-AU): the browser locale must never turn it into a bare "$". */
export const aud = (cents: number | null) => cents === null ? "Not defined" : `${cents < 0 ? "-" : ""}A$${new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100)}`;
const margin = (bps: number | null) => bps === null ? "No revenue" : `${(bps / 100).toFixed(1)}%`;
/** Strict decimal input, converted to integer units without binary floating-point money maths. */
export function parseEconomicsDecimal(value: string, places: number): number {
  // Thousands separators are fine when they're grouped correctly ("1,099", "12,500.50").
  const raw = value.trim();
  const plain = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(raw) ? raw.replaceAll(",", "") : raw;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(plain);
  if (!match || (match[2]?.length ?? 0) > places) throw new Error(`Use a non-negative number with at most ${places} decimal places.`);
  const n = Number(BigInt(match[1]) * 10n ** BigInt(places) + BigInt((match[2] ?? "").padEnd(places, "0") || "0"));
  if (!Number.isSafeInteger(n)) throw new Error("Number is too large.");
  return n;
}

export function EconomicsComparisonCell({ input }: { input: EconomicsInput }) {
  let value: string;
  try { value = aud(calculateEconomics(input).operatingContributionCents); }
  catch { return <td>Estimate paused<small>Reduce rates, usage or client count.</small></td>; }
  return <td>{value}</td>;
}

export function EconomicsDraftPreview({ input }: { input: EconomicsInput }) {
  return <label className="economics-field"><span>Draft proposal JSON · select and copy</span><textarea readOnly rows={16} value={exportEconomicsDraftJson(input)} aria-label="Draft proposal JSON" /><small>Read-only local preview of the current scenario, ex GST. Catalogue approvals are carried per field; any edited price is marked as a scenario. Draft only, not a quote.</small></label>;
}

/** `?package=` from the router when there is one (tests render the workbench without a router). */
function usePackageParam(): unknown {
  const router = useRouter({ warn: false });
  const read = () => (router?.state.location.search as { package?: unknown } | undefined)?.package;
  const [value, setValue] = useState(read);
  useEffect(() => router?.subscribe("onResolved", () => setValue(read())), [router]);
  return value;
}

export function EconomicsWorkbench() {
  const uid = useId();
  // ?package=<catalogue id> preselects a package (the command palette's "show the Professional margin").
  const wanted = usePackageParam();
  const initial = RECEPTIONIST_PACKAGES.find((p) => p.id === wanted) ?? RECEPTIONIST_PACKAGES[0];
  const [packageId, setPackageId] = useState<string>(initial.id);
  const [fields, setFields] = useState(() => ({ ...packageFields(initial), ...workbenchDefaults() }));
  const [gst, setGst] = useState(true);
  const [showDraft, setShowDraft] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState("");
  const [rates, setRates] = useState<readonly CostRate[]>(() => defaultEconomicsInput(getReceptionistPackage(packageId)).rates);
  const [rateText, setRateText] = useState<Record<string, string>>({});
  const pkg = getReceptionistPackage(packageId);
  const status = priceStatusLines(pkg);
  // F1-09: a package picked before hydration leaves the <select> showing it while state still holds
  // the default. On mount, adopt whatever the select really shows, so the fields and numbers match it.
  const packageSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const shown = packageSelect.current?.value;
    if (shown && shown !== packageId) selectPackage(shown);
    // Mount only: later changes go through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (key: keyof typeof fields, value: string) => setFields((old) => ({ ...old, [key]: value }));
  function selectPackage(id: string) {
    const next = getReceptionistPackage(id);
    setPackageId(id);
    setFields((old) => ({ ...old, ...packageFields(next) }));
  }
  useEffect(() => {
    if (typeof wanted === "string" && wanted !== packageId && RECEPTIONIST_PACKAGES.some((p) => p.id === wanted)) selectPackage(wanted);
    // only when the link asks for a different package
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  let input: EconomicsInput | null = null;
  let result: ReturnType<typeof calculateEconomics> | null = null;
  let error = "";
  try {
    const numeric = (key: keyof typeof fields, places = 0) => {
      try { return parseEconomicsDecimal(fields[key], places); }
      catch (cause) { throw new Error(`${FIELD_LABEL[key] ?? key}: ${cause instanceof Error ? cause.message : "check the value"}`); }
    };
    if (numeric("target", 2) >= 10_000) throw new Error("Target margin must be below 100%.");
    input = { ...defaultEconomicsInput(pkg),
      package: { ...pkg, pricing: { ...pkg.pricing, monthly: { ...pkg.pricing.monthly, cents: numeric("monthly", 2) }, setup: { ...pkg.pricing.setup, cents: numeric("setup", 2) }, overagePerMinute: { ...pkg.pricing.overagePerMinute, cents: numeric("overage", 2) }, includedMinutes: numeric("included") } },
      clients: numeric("clients"), calls: pkg.kind === "receptionist" ? [{ count: numeric("calls"), seconds: numeric("seconds") }] : [],
      notificationsPerClient: pkg.kind === "receptionist" ? numeric("notifications") : 0,
      smsSegmentsPerClient: pkg.kind === "receptionist" ? numeric("sms") : 0,
      supportMinutesPerClient: numeric("support"), supportHourlyCents: numeric("hourly", 2), onboardingMinutes: numeric("onboarding"), onboardingHourlyCents: numeric("hourly", 2),
      fx: { usdPerAudMillionths: numeric("fx", 6), date: DEFAULT_FX.date, cardFeeBps: numeric("card", 2) },
      gstRegistered: gst, targetMarginBps: numeric("target", 2),
      payment: { percentBps: numeric("payment", 2), fixedCents: numeric("paymentFixed", 2), gst: "inclusive", creditEligible: true },
      rates: rates.map((r) => ({ ...r, micros: rateText[r.id] === undefined ? r.micros : rateText[r.id].trim() === "" ? null : parseEconomicsDecimal(rateText[r.id], 6) })),
    };
    result = calculateEconomics(input);
  } catch (cause) { error = cause instanceof Error ? cause.message : "Check the assumptions."; }
  // Page context for Jarvis: "explain this margin" cites these figures and their source, never a model's numbers.
  const fmtPct = (bps: number | null) => (bps === null ? "not computable" : `${(bps / 100).toFixed(1)}%`);
  usePageContext("operations:economics", {
    selection: {
      kind: "package",
      id: pkg.id,
      label: `${pkg.shortName} package`,
      to: "/operations",
      search: { package: pkg.id },
      focus: "economics-workbench",
      source: "src/lib/receptionist-packages.ts + src/lib/business-economics.ts",
      facts: result
        ? {
            "Monthly price (ex GST, as entered)": aud(input?.package.pricing.monthly.cents ?? null),
            Clients: String(input?.clients ?? ""),
            "Revenue / month (ex GST)": aud(result.revenueExGstCents),
            Contribution: aud(result.contributionCents),
            "Contribution margin": fmtPct(result.contributionMarginBps),
            "Operating margin": fmtPct(result.operatingMarginBps),
            "Cost rates complete": result.incomplete ? "no, some are unknown" : "yes",
          }
        : { Error: error || "No result" },
    },
    sources: [{ id: "economics-model", label: "Package economics (estimate)", state: "simulated", source: "Package catalogue + economics model (planning assumptions)", lastSuccess: ECONOMICS_AS_OF }],
  });
  function downloadDraft() {
    if (!input || !result) return;
    const url = URL.createObjectURL(new Blob([exportEconomicsDraftJson(input)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${input.package.id}-draft-proposal.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setDownloadNotice("Download requested; completion is not verified. If your browser does not save a file, use View draft details to inspect and copy the JSON.");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const field = (key: keyof typeof fields, label: string, disabled = false) => <label className="economics-field" key={key} htmlFor={`${uid}-${key}`}><span>{label}</span><input id={`${uid}-${key}`} inputMode="decimal" value={fields[key]} disabled={disabled} onChange={(e) => update(key, e.target.value)} /></label>;
  return <section id="economics-workbench" className="biz-card economics-workbench" aria-labelledby={`${uid}-title`}>
    <style>{`
      .economics-workbench{padding:clamp(16px,3vw,28px);min-width:0;color:var(--op-text,inherit)}
      .economics-workbench h2{font-size:24px;font-weight:500;letter-spacing:-.025em;margin:0}
      .economics-workbench h3{font-size:17px;font-weight:600;margin:28px 0 12px}
      .economics-workbench p{line-height:1.6;max-width:75ch;margin:12px 0}
      .economics-workbench small{font-size:var(--text-xs);line-height:1.5;display:block}
      .economics-workbench input,.economics-workbench select{font:inherit;color:inherit;background:var(--op-panel,transparent);border:1px solid var(--op-border,#aaa);border-radius:8px;padding:10px;min-height:44px;min-width:0;width:100%;box-sizing:border-box}
      .economics-workbench textarea{font:inherit;font-size:14px;line-height:1.5;color:inherit;background:var(--op-panel,transparent);border:1px solid var(--op-border,#aaa);border-radius:8px;padding:12px;width:100%;box-sizing:border-box;resize:vertical}
      .economics-workbench select option{color:#171717;background:#fff}
      .economics-workbench input:disabled{opacity:.55;cursor:not-allowed}
      .economics-workbench :is(input,textarea,select,button,summary,a):focus-visible{outline:2px solid currentColor;outline-offset:3px}
      .economics-workbench input[type=checkbox]{width:18px;min-height:18px;accent-color:var(--op-accent,#455844)}
      .economics-workbench a{text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
      .economics-workbench button{font:inherit;padding:9px 14px;min-height:44px;border:1px solid var(--op-border,#aaa);border-radius:8px;color:inherit;background:transparent;cursor:pointer}
      .economics-workbench button:hover{background:var(--op-hover,rgba(127,127,127,.12))}
      .economics-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}
      .economics-field{display:flex;flex-direction:column;gap:7px;font-size:13px}
      .economics-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;align-items:center}
      .economics-table-wrap{overflow-x:auto;max-width:100%;margin:12px 0}
      .economics-workbench table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
      .economics-workbench th,.economics-workbench td{text-align:right;padding:12px 10px;border-bottom:1px solid var(--op-border,#bbb);white-space:nowrap}
      .economics-workbench th:first-child,.economics-workbench td:first-child{text-align:left;white-space:normal;min-width:100px}
      .economics-workbench caption{text-align:left;padding:8px 0;font-weight:600}
      .economics-workbench details{border-top:1px solid var(--op-border,#aaa);padding-top:16px;margin-top:24px}
      .economics-workbench summary{cursor:pointer;font-weight:600;min-height:32px}
      .economics-workbench ul{padding-left:22px;line-height:1.6}
      .economics-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:0 32px;font-variant-numeric:tabular-nums}
      .economics-results>div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--op-border,#bbb)}
      .economics-results dd{margin:0;text-align:right;font-weight:600}
      .economics-notice{padding:12px 0;border-block:1px solid var(--op-border,#aaa)}
      .economics-status{list-style:none;padding:0;margin:0;display:grid;gap:4px;font-size:14px;line-height:1.5}
      .economics-status li[data-approved="true"]{font-weight:600}
      .economics-rate{display:grid;grid-template-columns:minmax(0,2fr) minmax(130px,1fr) minmax(130px,1fr);gap:12px;padding:16px 0;border-bottom:1px solid var(--op-border,#bbb)}
      @media(max-width:600px){.economics-rate{grid-template-columns:1fr}.economics-workbench th,.economics-workbench td{padding:10px 8px}}
    `}</style>
    <h2 id={`${uid}-title`}>Package economics</h2>
    <p>Test a price against call usage and the time it takes to deliver. These are local estimates in Australian dollars, with public rates checked {fmtProse(ECONOMICS_AS_OF)}. Edits stay in this view.</p>
    <label className="economics-field" htmlFor={`${uid}-package`}><span>Package catalogue</span><select ref={packageSelect} id={`${uid}-package`} value={packageId} onChange={(e) => selectPackage(e.target.value)}>{RECEPTIONIST_PACKAGES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="economics-notice" aria-label="Approval status">
      <ul className="economics-status">
        <li data-approved={status.monthly.approved}>{status.monthly.text}</li>
        <li data-approved={status.setup.approved}>{status.setup.text}</li>
        <li data-approved={false}>{status.pilot.text}</li>
        <li>Service readiness: {pkg.readiness.state.replaceAll("-", " ")}. {pkg.limitations[0]}</li>
      </ul>
    </div>
    <small>Changing package resets its prices and usage defaults. Your provider rates, FX, client count and labour value stay in place for comparison.</small>
    {pkg.kind === "receptionist" && pkg.readiness.state !== "unsupported" && <details><summary>Pricing recommendation for review</summary><p>{PRICE_RECOMMENDATION.rationale}</p><small>{status.monthly.text}. {status.setup.text}. {status.pilot.text}.</small></details>}
    <h3>Price and delivery assumptions</h3>
    <div className="economics-fields">
      {field("monthly", `Monthly price (A$, ex GST)${status.monthly.approved ? " · approved" : " · proposed"}`)}{field("setup", `Setup fee (A$, ex GST)${status.setup.approved ? " · approved" : " · proposed, not approved"}`)}
      {field("included", "Included minutes", pkg.kind !== "receptionist")}{field("overage", "Overage / minute (A$, ex GST)", pkg.kind !== "receptionist")}
      {field("clients", "Clients sharing platform costs")}{field("hourly", "Labour value / hour (A$, no GST)")}
      {field("support", "Monthly support minutes / client")}{field("onboarding", "Onboarding minutes / client")}
    </div>
    <label className="economics-actions"><input type="checkbox" checked={gst} onChange={(e) => setGst(e.target.checked)} /> M&amp;U is GST registered: 10% GST is added to invoices and eligible input GST is claimed</label>
    <small>Prices are ex GST. Untick only to model an unregistered what-if; it keeps the quoted prices and removes output GST and credits.</small>
    <h3>Usage per client, per month</h3>
    <div className="economics-actions">{scenariosFor(pkg).map((s) => <button type="button" key={s.id} disabled={pkg.kind !== "receptionist"} onClick={() => setFields((old) => ({ ...old, ...scenarioFields(s) }))}>{s.label} usage</button>)}</div>
    <div className="economics-fields">{field("calls", "Connected calls", pkg.kind !== "receptionist")}{field("seconds", "Seconds per call (average)", pkg.kind !== "receptionist")}{field("sms", "SMS segments sent", pkg.kind !== "receptionist")}{field("notifications", "Notifications", pkg.kind !== "receptionist")}{field("target", "Target marginal overage margin (%)")}</div>
    {error && <p role="alert">Estimate paused: {error}</p>}
    <div className="economics-actions"><button type="button" disabled={!result} onClick={downloadDraft}>Download draft proposal</button><button type="button" disabled={!result} aria-expanded={showDraft} onClick={() => setShowDraft((shown) => !shown)}>{showDraft ? "Hide draft details" : "View draft details"}</button><small>Local JSON of the selected package and scenario, ex GST, with per-field approval status. Draft only, not a quote.</small></div>
    {downloadNotice && <p role="status">{downloadNotice}</p>}
    {showDraft && result && input && <EconomicsDraftPreview input={input} />}
    {result && input && <>
      <h3>Monthly estimate · {input.clients} clients</h3>
      <p>{result.incomplete ? "Known-cost subtotal only. Unknown costs and supplier GST remain unresolved; contribution may be overstated." : "All cost lines have values; still an estimate, not measured or reconciled."}</p>
      <dl className="economics-results" aria-live="polite">
        <div><dt>Revenue excluding GST</dt><dd>{aud(result.revenueExGstCents)}</dd></div>
        <div><dt>Variable service + payment costs</dt><dd>{aud(result.variableCostCents)}</dd></div>
        <div><dt>Contribution</dt><dd>{aud(result.contributionCents)}<small>{margin(result.contributionMarginBps)}</small></dd></div>
        <div><dt>Support allocation</dt><dd>{aud(result.supportCents)}</dd></div>
        <div><dt>Shared platform allocation</dt><dd>{aud(result.sharedPlatformCents)}</dd></div>
        <div><dt>Operating contribution</dt><dd>{aud(result.operatingContributionCents)}<small>{margin(result.operatingMarginBps)}</small></dd></div>
        <div><dt>Output / eligible input GST</dt><dd>{aud(result.outputGstCents)} / {aud(result.monthlyInputGstCents)}</dd></div>
        <div><dt>Estimated GST balance</dt><dd>{aud(result.estimatedNetGstCents)}</dd></div>
        <div><dt>Usage cost / minute</dt><dd>{aud(result.perMinuteCents)}</dd></div>
        <div><dt>Usage cost / call</dt><dd>{aud(result.perCallCents)}</dd></div>
        <div><dt>Included-minute utilisation</dt><dd>{result.includedUtilisationBps === null ? "Not applicable" : `${(result.includedUtilisationBps / 100).toFixed(1)}%`}<small>{result.overageMinutes} overage minutes / client</small></dd></div>
        <div><dt>Overage price floor at {fields.target}%</dt><dd>{aud(result.overageFloorQuotedCents)}<small>Ex GST, like the price</small></dd></div>
        <div><dt>Usage break-even, no overage charged</dt><dd>{result.breakEvenIncludedMinutes ?? "Not defined"}<small>minutes / client (approx.)</small></dd></div>
        <div><dt>Clients to cover shared platform</dt><dd>{result.breakEvenClients ?? "No positive contribution"}</dd></div>
      </dl>
      {result.overageBelowFloor && <p role="status">The proposed overage is below the calculated floor. Raise the price or reduce scoped costs before approval.</p>}
      <p>Break-even holds this call mix, support and rates constant. The overage floor includes percentage payment fees on the same invoice; it excludes unknown costs and additional support growth. A zero-usage scenario has no marginal-cost estimate.</p>
      <h3>Setup scenario · one client{status.setup.approved ? "" : " · uses a PROPOSED setup fee, not approved revenue"}</h3>
      {!status.setup.approved && <p>Scenario only. The setup fee is proposed and not approved, so nothing here is revenue and no draft invoices it.</p>}
      <dl className="economics-results"><div><dt>{status.setup.approved ? "Setup revenue excluding GST" : "Proposed setup fee, ex GST (scenario)"}</dt><dd>{aud(result.setup.revenueExGstCents)}</dd></div><div><dt>Labour + setup costs + payment fee</dt><dd>{aud(result.setup.costCents)}</dd></div><div><dt>Setup contribution</dt><dd>{aud(result.setup.contributionCents)}</dd></div></dl>
      <h3>Usage and scale comparison</h3>
      <div className="economics-table-wrap" role="region" aria-label="Scenario comparison, scroll horizontally" tabIndex={0}><table><caption>Monthly operating contribution after support and one shared platform allocation</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Minutes / client</th>{CLIENT_COUNTS.map((n) => <th scope="col" key={n}>{n} {n === 1 ? "client" : "clients"}</th>)}</tr></thead><tbody>{scenariosFor(pkg).map((s) => <tr key={s.id}><th scope="row">{s.label}<small>{pkg.kind === "receptionist" ? s.supportMinutes : input.supportMinutesPerClient} support min</small></th><td>{pkg.kind === "receptionist" ? s.calls.reduce((n, c) => n + c.count * c.seconds, 0) / 60 : 0}</td>{CLIENT_COUNTS.map((clients) => <EconomicsComparisonCell key={clients} input={{ ...input!, clients, calls: pkg.kind === "receptionist" ? s.calls.map((c) => ({ ...c })) : [], smsSegmentsPerClient: pkg.kind === "receptionist" ? s.smsSegments : input!.smsSegmentsPerClient, supportMinutesPerClient: pkg.kind === "receptionist" ? s.supportMinutes : input!.supportMinutesPerClient }} />)}</tr>)}</tbody></table></div>
      <details><summary>Cost calculation breakdown</summary><div className="economics-table-wrap" role="region" aria-label="Cost breakdown, scroll horizontally" tabIndex={0}><table><thead><tr><th scope="col">Cost line</th><th scope="col">Basis</th><th scope="col">Billed seconds / client</th><th scope="col">Operating cost</th></tr></thead><tbody>{result.lines.map((l) => <tr key={l.id}><th scope="row">{l.label}</th><td>{l.basis}</td><td>{l.billedSeconds ?? "—"}</td><td>{aud(l.operatingCents)}</td></tr>)}<tr><th scope="row">Monthly payment fees</th><td>Per client invoice</td><td>—</td><td>{aud(result.paymentCostCents)}</td></tr></tbody></table></div><ul>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
    </>}
    <details><summary>Rates, FX and tax assumptions</summary>
      <p><a href={RATE_SOURCES.rba} target="_blank" rel="noreferrer">RBA</a>: {assumptionText().fx}</p>
      <div className="economics-fields">{field("fx", "USD per A$1 (up to 6 decimals)")}{field("card", "FX/card buffer (%)")}{field("payment", "Payment fee (%)")}{field("paymentFixed", "Payment fixed fee (A$)")}</div>
      <p><a href={RATE_SOURCES.stripe} target="_blank" rel="noreferrer">Stripe</a>: {assumptionText().stripe} <a href={RATE_SOURCES.gst} target="_blank" rel="noreferrer">GST credits require eligibility.</a></p>
      <p>Blank rates mean unknown, not zero. Edits are assumptions. Foreign supplier GST is unverified by default; select a treatment only with evidence. The bundled Retell line already includes STT, TTS and LLM. {assumptionText().telephony}</p>
      {rates.map((r) => <div className="economics-rate" key={r.id}><div><strong>{fmtProse(r.label)}</strong><small>{fmtProse(r.note)}</small><small>{r.source ? <a href={r.source} target="_blank" rel="noreferrer">Official source</a> : "No scoped provider rate"} · checked {fmtProse(r.checkedAt)} · effective date {r.effectiveFrom ? fmtProse(r.effectiveFrom) : "not published / unknown"}</small></div><label className="economics-field"><span>{r.currency} / {r.basis}</span><input aria-label={`${r.label} rate`} inputMode="decimal" placeholder="Unknown" value={rateText[r.id] ?? (r.micros === null ? "" : String(r.micros / 1000000))} onChange={(e) => setRateText((old) => ({ ...old, [r.id]: e.target.value }))} /></label><div><label className="economics-field"><span>Supplier GST</span><select aria-label={`${r.label} GST`} value={r.gst} onChange={(e) => setRates((old) => old.map((x) => x.id === r.id ? { ...x, gst: e.target.value as CostRate["gst"] } : x))}>{["unknown", "none", "inclusive", "exclusive"].map((v) => <option key={v} value={v}>{v}</option>)}</select></label><label className="economics-actions"><input type="checkbox" checked={r.creditEligible} onChange={(e) => setRates((old) => old.map((x) => x.id === r.id ? { ...x, creditEligible: e.target.checked } : x))} /> Credit eligible</label></div></div>)}
    </details>
    <details><summary>Package scope and approval requirements</summary><p>{fmtProse(pkg.pricing.rationale)}</p><h3>Functions evidenced</h3>{pkg.functions.length ? <ul>{pkg.functions.map((f) => <li key={f.id}><strong>{f.label}: {f.state.replaceAll("-", " ")}</strong><small>{fmtProse(f.evidence)}</small></li>)}</ul> : <p>No supported trades playbook was found in the inspected niche list.</p>}<h3>Integrations</h3><ul>{pkg.integrations.map((i) => <li key={i.name}>{i.name}: {i.state}. {i.limitation}</li>)}</ul><h3>Limitations</h3><ul>{pkg.limitations.map((s) => <li key={s}>{fmtProse(s)}</li>)}</ul><h3>Onboarding</h3><ul>{pkg.onboarding.map((s) => <li key={s}>{s}</li>)}</ul><h3>Release gates</h3><ul>{pkg.readiness.releaseGates.map((s) => <li key={s}>{s}</li>)}</ul><small>Evidence checked {fmtProse(pkg.readiness.checkedAt)}; local source and dated handoff only. There is no price approval or live-readiness authority in this component.</small></details>
  </section>;
}

export default EconomicsWorkbench;
