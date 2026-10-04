import type { Tone } from "@/lib/receptionist";
import { fmtDateTime } from "../../lib/format";

export const tone = (value: Tone) => value === "ok" ? "success" : value === "bad" ? "danger" : value;
export const aud = (value: number | null, digits = 2) => value === null ? "—" : `A$${value.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const seconds = (ms: number | null) => ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`;
export const duration = (sec: number | null) => {
  if (sec === null) return "—";
  const rounded = Math.round(sec);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
};
export const callTime = (at: string | null) => at ? fmtDateTime(new Date(at), { weekday: true }) : "Time unavailable";

// Keep caller identifiers masked even if a provider returns an unexpected value.
export const maskedCaller = (from: string | null) => {
  const digits = from?.replace(/\D/g, "") ?? "";
  return digits ? `••• ${digits.slice(-3)}` : "Caller unavailable";
};

/** The resolved line for display: "+614xxxxxxxx" -> "+61 4xx xxx xxx" (as aggregate.ts formatAuNumber); never hard-coded (RX-6). */
export const lineNumber = (n: string) => {
  const m = /^\+61(4\d{2})(\d{3})(\d{3})$/.exec(n);
  return m ? `+61 ${m[1]} ${m[2]} ${m[3]}` : n;
};
