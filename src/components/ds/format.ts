/**
 * Number and date formatting for the design system (docs/DESIGN-SYSTEM.md §
 * Data and numbers). Money goes through useCurrency() — these are for
 * everything else. en-AU throughout: "24 Sept", "1,234", "12.5%".
 */
import { fmtDay } from "../../lib/format";

const LOCALE = "en-AU";

/** 1234 → "1,234". Null/undefined/NaN → "—" (never "0" for missing data). */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(n);
}

/** 241817 → "242K"; below 10,000 stays exact. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 10_000) return fmtCount(n);
  return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** 0.125 → "12.5%" (pass a ratio). Whole numbers drop the decimal. */
export function fmtPercent(ratio: number | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    maximumFractionDigits: decimals,
  }).format(ratio);
}

/** ISO/Date → "24 Sept" (adds the year when it isn't this year). One formatter: src/lib/format.ts. */
export function fmtDate(value: string | number | Date | null | undefined): string {
  return fmtDay(value, { year: "auto" });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function fmtRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return "—";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) {
    const d = Math.floor(s / 86_400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return fmtDate(t);
}
