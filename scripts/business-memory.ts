import { audienceMeasurementIdentity } from "../src/lib/audience-measurement";
import { sourcedSummaryText, type SourcedFinanceSummary } from "./finance/manual-sourced";
/** Id of the one finance document in memory. Retract it (0 parts) when there is nothing to say. */
export const FINANCE_MEMORY_ID = "finances";

/**
 * The finance document memory may hold: sourced summaries ONLY (owner rule, V4/V6 §8). Period totals
 * from the authoritative NAB CSV import, with the source and as-of date. Observed account balances
 * (Mercury, the retired Basiq path) are acknowledged by source and date only: no account names,
 * balances, account ids, income figures or transactions ever become searchable memory rows.
 */
export function financeMemoryDocument(workspace: any, summaries: SourcedFinanceSummary[] | null): { id: string; title: string; text: string } | null {
  const finances = workspace?.finances;
  const observed = finances?.accounts?.length
    ? `Observed account balances exist in Finance (source: ${String(finances.sourceLabel || "Imported balances").slice(0, 80)}, recorded ${String(finances.recordedAt ?? "unknown").slice(0, 10)}). The figures stay in Finance and are not copied into memory.`
    : "";
  const sourced = summaries?.length ? sourcedSummaryText(summaries) : "";
  if (!sourced && !observed) return null;
  return {
    id: FINANCE_MEMORY_ID,
    title: "Finance summary (sourced)",
    text: [sourced || "# Finance summary (sourced)\nNo NAB CSV imported: bank cash flow is unknown, not zero.", observed].filter(Boolean).join("\n"),
  };
}

/** Dated observations, shared by the dashboard and the searchable local brain. */
export function businessMemoryDocuments(workspace: any, options: { finance?: () => SourcedFinanceSummary[] | null } = {}) {
  const documents: Array<{ id: string; title: string; text: string }> = [];
  let summaries: SourcedFinanceSummary[] | null = null;
  try { summaries = options.finance?.() ?? null; } catch { summaries = null; /* Finance unavailable: say nothing rather than guess. */ }
  const finance = financeMemoryDocument(workspace, summaries);
  if (finance) documents.push(finance);
  const byPlatform = new Map<string, any[]>();
  for (const s of workspace.snapshots || []) {
    if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, []);
    byPlatform.get(s.platform)!.push(s);
  }
  for (const [platform, snapshots] of byPlatform) {
    const ordered = [...snapshots].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const latest = ordered.at(-1);
    const identity = audienceMeasurementIdentity(platform, latest?.measurementScope, latest?.sourceUrl);
    // Keep all original observations in private storage. Shared memory contains
    // only the latest confirmed series, or one current unscoped observation.
    // This prevents a model reconstructing growth from incompatible raw totals.
    const usable = identity ? ordered.filter(row => row.measurementScope === latest.measurementScope && audienceMeasurementIdentity(platform, row.measurementScope, row.sourceUrl) === identity) : latest ? [latest] : [];
    documents.push({
      id: `audience-${platform}`,
      title: `${platform[0].toUpperCase() + platform.slice(1)} audience history`,
      text: [
        `# ${platform} audience observations`,
        "Each line is an observation at its stated date. Missing dates are not zero values. Follower/member counts are not revenue.",
        identity ? `Measurement scope: ${latest.measurementScope}. Source identity: ${identity}. Compare only observations with this exact scope and identity.` : "Measurement scope or source identity is unknown. Only the latest observation is included. Do not infer growth or decline.",
        ordered.length > usable.length ? `${ordered.length - usable.length} observations with different or unknown measurement scope or identity are retained in the dashboard history and omitted here. They are not comparison baselines.` : "",
        ...usable.map(s => `${s.recordedAt} | ${Object.entries(s.metrics).map(([key, value]) => `${key}: ${value}`).join(", ")} | ${s.sourceLabel || "Observation"} (${s.origin || "import"})${s.sourceUrl ? ` | ${s.sourceUrl}` : ""} | scope: ${identity ? s.measurementScope : "unknown"}`),
      ].filter(Boolean).join("\n"),
    });
  }
  return documents;
}

export function businessEvidence(workspace: any) {
  const latest = new Map<string, any>();
  for (const s of workspace.snapshots || [])
    if (!latest.has(s.platform) || s.recordedAt >= latest.get(s.platform).recordedAt)
      latest.set(s.platform, s);
  return {
    interpretation:
      "These are saved observations, not guaranteed live values. Cite each observation date and source. Account balances are not revenue or profit; never aggregate different or unknown currencies. Audience growth requires equal explicit measurement scope and source identity; unknown scopes cannot be compared.",
    finances: workspace.finances
      ? {
          recordedAt: workspace.finances.recordedAt,
          sourceLabel: workspace.finances.sourceLabel,
          sourceUrl: workspace.finances.sourceUrl,
          measurement: "account_balances",
          inMemory: "source and date only; figures stay in Finance",
        }
      : null,
    bankCashFlow: { source: "NAB CSV import (finance-manual.sqlite)", inMemory: "sourced period totals only, as 'Finance summary (sourced)'", live: false },
    audience: [...latest.values()].map((s) => ({
      platform: s.platform,
      recordedAt: s.recordedAt,
      sourceLabel: s.sourceLabel,
      origin: s.origin,
      sourceUrl: s.sourceUrl,
      measurementScope: audienceMeasurementIdentity(s.platform, s.measurementScope, s.sourceUrl) ? s.measurementScope : "unknown",
      sourceIdentity: audienceMeasurementIdentity(s.platform, s.measurementScope, s.sourceUrl),
    })),
    history: {
      observations: (workspace.snapshots || []).length,
      searchableIn: "Memory sources named '[platform] audience history'",
    },
  };
}
