/**
 * Deal desk money helpers (3 Oct 2026). Integer cents everywhere, BigInt for multiplication, half-up rounding:
 * the same conventions as src/lib/business-economics.ts, whose splitGst is reused rather than re-implemented.
 * Framework-free: nothing here imports React, the router, node:fs or a server module.
 */
import { splitGst } from "../business-economics";

export { splitGst };
export { formatAud } from "../receptionist-packages";

export type Fx = { usdPerAudMillionths: number; date: string; cardFeeBps: number };
export type Currency = "AUD" | "USD";

export function int(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be a whole number from 0 to ${max.toLocaleString("en-AU")}`);
  return value;
}

/** round-half-up(a × b ÷ d) for non-negative integers. */
export function mulDiv(a: number, b: number, d: number): number {
  int(a, "value"); int(b, "multiplier"); int(d, "divisor");
  if (d === 0) throw new Error("divisor must be positive");
  const result = Number((BigInt(a) * BigInt(b) + BigInt(d) / 2n) / BigInt(d));
  if (!Number.isSafeInteger(result)) throw new Error("Calculation exceeds safe money range");
  return result;
}

/** Basis points of part over whole, or null when the whole is zero (a margin on zero revenue is undefined, not 0%). */
export function ratioBps(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round(part * 10000 / whole);
}

/**
 * Exact decimal text to a scaled integer: parseDecimal("1,099.50", 2) = 109950. Rejects negatives, exponents,
 * more decimal places than allowed and badly grouped thousands. Throws rather than guessing.
 */
export function parseDecimal(text: string, places: number): number {
  const t = text.trim();
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d*)?$/.test(t)) throw new Error("Enter a plain number, for example 1,099.50");
  const [whole, fraction = ""] = t.replace(/,/g, "").split(".");
  if (fraction.length > places) throw new Error(places === 0 ? "Whole numbers only" : `At most ${places} decimal places`);
  const scaled = Number(BigInt(whole) * 10n ** BigInt(places) + BigInt((fraction + "0".repeat(places)).slice(0, places) || "0"));
  if (!Number.isSafeInteger(scaled)) throw new Error("Number is too large");
  return scaled;
}

/**
 * Split a total by shares (basis points summing to 10,000) so the parts add up to the total exactly.
 * Largest remainder; ties go to the earlier part.
 */
export function allocate(totalCents: number, sharesBps: readonly number[]): number[] {
  int(totalCents, "total");
  if (!sharesBps.length) throw new Error("At least one share is required");
  if (sharesBps.reduce((n, s) => n + int(s, "share", 10000), 0) !== 10000) throw new Error("Shares must add up to 100%");
  const exact = sharesBps.map((s) => BigInt(totalCents) * BigInt(s));
  const parts = exact.map((e) => Number(e / 10000n));
  let left = totalCents - parts.reduce((n, p) => n + p, 0);
  const order = exact.map((e, i) => ({ i, rem: Number(e % 10000n) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) parts[order[k % order.length].i] += 1;
  return parts;
}

/**
 * A supplier amount in AUD cents. USD is divided by the reference rate (US$ per A$1) and lifted by the
 * card/FX buffer, exactly as calculateEconomics converts provider rates.
 */
export function toAudCents(cents: number, currency: Currency, fx: Fx): number {
  int(cents, "amount");
  if (currency === "AUD") return cents;
  const rate = int(fx.usdPerAudMillionths, "USD per AUD", 100_000_000);
  if (!rate) throw new Error("FX rate must be positive");
  const buffer = int(fx.cardFeeBps, "FX buffer", 10000);
  const n = BigInt(cents) * 1_000_000n * BigInt(10000 + buffer);
  const d = BigInt(rate) * 10000n;
  return Number((n + d / 2n) / d);
}

export type PaymentFee = { label: string; percentBps: number; fixedCents: number; /** Fee is GST-inclusive and M&U claims the credit. */ gstCreditable: boolean };

/** Collection fee on one GST-inclusive charge. A zero charge costs nothing (no fixed fee on nothing). */
export function paymentFee(grossCents: number, fee: PaymentFee) {
  int(grossCents, "charge"); int(fee.percentBps, "payment percentage", 10000); int(fee.fixedCents, "payment fixed fee");
  if (grossCents === 0) return { feeCents: 0, creditCents: 0, costCents: 0 };
  const feeCents = mulDiv(grossCents, fee.percentBps, 10000) + (fee.percentBps === 0 && fee.fixedCents === 0 ? 0 : fee.fixedCents);
  const creditCents = fee.gstCreditable ? splitGst(feeCents, "inclusive").gstCents : 0;
  return { feeCents, creditCents, costCents: feeCents - creditCents };
}

export const pctText = (bps: number | null, digits = 1) => bps === null ? "n/a" : `${(bps / 100).toFixed(digits)}%`;
export const hoursText = (minutes: number) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;
