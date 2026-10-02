/** Missing means no website listed by the source, never confirmed website absence. */
export type WebsitePresence = "all" | "missing";

export function normaliseFindArea(value: unknown): string {
  if (value === undefined || value === null || value === "") throw new Error('Say where, e.g. "Parramatta NSW".');
  if (typeof value !== "string") throw new Error("Area must be a suburb or region name.");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Area must be one line without control characters.");
  const area = value.trim().replace(/\s+/g, " ");
  if (!area) throw new Error('Say where, e.g. "Parramatta NSW".');
  if (area.length > 120) throw new Error("Area must be 120 characters or fewer.");
  return area;
}

export function normaliseWebsitePresence(value: unknown): WebsitePresence {
  if (value === undefined || value === "all") return "all";
  if (value === "missing") return "missing";
  throw new Error('websitePresence must be "all" or "missing".');
}
