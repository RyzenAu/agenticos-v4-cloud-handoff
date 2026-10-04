import { crmRefString, type CrmRef } from "./crm-ref";
export type CrmTab = "overview" | "timeline" | "deals" | "delivery";
const TABS: readonly CrmTab[] = ["overview", "timeline", "deals", "delivery"];
export function crmHref(ref: CrmRef, tab: CrmTab = "overview"): string {
  const value = crmRefString(ref);
  if (!TABS.includes(tab)) throw new Error("Invalid CRM tab.");
  // Legacy links retain their exact routing contract until a mapped company is supplied.
  if (ref.kind === "lead") return `/leads?lead=${encodeURIComponent(ref.id)}`;
  return `/crm?ref=${encodeURIComponent(value)}&tab=${tab}`;
}
export type ArtifactRef = { jobId: string; file?: string };
/** Artifact links cannot become external links, encoded traversal or arbitrary filesystem paths. */
export function parseArtifactRef(value: string): ArtifactRef | null {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("artifact:"))
    return null;
  const parts = value.slice(9).split("/");
  const jobId = parts.shift()!;
  if (jobId.trim() !== jobId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(jobId)) return null;
  if (
    parts.some(
      (p) => !p || p === "." || p === ".." || !/^[A-Za-z0-9_. -]+$/.test(p) || p.trim() !== p,
    )
  )
    return null;
  return { jobId, ...(parts.length ? { file: parts.join("/") } : {}) };
}
export function artifactHref(value: string): string | null {
  const ref = parseArtifactRef(value);
  if (!ref) return null;
  const base = `/__computers/artifacts/${encodeURIComponent(ref.jobId)}`;
  return ref.file ? `${base}/f/${ref.file.split("/").map(encodeURIComponent).join("/")}` : base;
}
