/**
 * Display currency — every cost in the OS is computed in USD (that's what the
 * model providers bill in), so this layer converts at render time only. The
 * underlying data is never rewritten.
 *
 * Rates come from open.er-api.com, which is keyless and CORS-open — consistent
 * with the app's "works with zero setup, no new credentials" rule. They're
 * cached in localStorage so a refresh (or an offline session) still renders,
 * and if we have no usable rate we fall back to showing USD rather than
 * printing a converted-looking number that isn't real.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "./use-hydrated";
import { fmtMoney, fmtMoneyCompact } from "./format";

export interface CurrencyDef {
  code: string;
  name: string;
}

// Kept deliberately short — the currencies this community actually earns and
// spends in. Intl handles the symbol + placement per locale.
export const CURRENCIES: CurrencyDef[] = [
  // Australian dollars first: M&U Ventures is an Australian business (audit P3-9, 29 Sep 2026).
  { code: "AUD", name: "Australian Dollar" },
  { code: "USD", name: "US Dollar" },
  { code: "GBP", name: "British Pound" },
  { code: "EUR", name: "Euro" },
  { code: "AED", name: "UAE Dirham" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "INR", name: "Indian Rupee" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "ZAR", name: "South African Rand" },
];

const STORAGE_KEY = "claude-os.currency";
const RATES_CACHE_KEY = "claude-os.currency.rates";
const RATES_URL = "https://open.er-api.com/v6/latest/USD";

// ── tiny external store so every money figure re-renders the instant the
// user picks a new currency (no context provider to thread through the app)
const listeners = new Set<() => void>();

/**
 * The picker's default when nobody has chosen: M&U Ventures is an Australian business and works in
 * AUD (audit F1-22). A saved choice always wins. Figures still fall back to USD, and say so, until
 * a real AUD rate is available.
 */
export const DEFAULT_CURRENCY = "AUD";

/** The saved display currency, or the default when none (or an unknown code) is saved. */
export function storedCurrency(storage: Pick<Storage, "getItem"> | undefined): string {
  if (!storage) return DEFAULT_CURRENCY;
  try {
    const v = storage.getItem(STORAGE_KEY);
    return v && CURRENCIES.some((c) => c.code === v) ? v : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

function readStoredCode(): string {
  if (typeof window === "undefined") return DEFAULT_CURRENCY;
  try {
    return storedCurrency(window.localStorage);
  } catch {
    return DEFAULT_CURRENCY;
  }
}
let current = readStoredCode();

export function setCurrency(code: string) {
  if (!CURRENCIES.some((c) => c.code === code)) return;
  current = code;
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* localStorage unavailable — session-only preference */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // another tab changing the preference should update this one too
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      current = readStoredCode();
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function readCachedRates(): Record<string, number> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RATES_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && parsed.rates ? parsed.rates : null;
  } catch {
    return null;
  }
}

/**
 * USD→everything rates. Cached for a day; the localStorage copy is the
 * offline/first-paint fallback so figures never flicker back to USD.
 */
export function useRates() {
  return useQuery<Record<string, number>>({
    queryKey: ["currency-rates"],
    queryFn: async () => {
      const res = await fetch(RATES_URL);
      if (!res.ok) throw new Error(`rates ${res.status}`);
      const json = await res.json();
      const rates = json?.rates;
      if (!rates || typeof rates !== "object") throw new Error("no rates");
      try {
        window.localStorage.setItem(
          RATES_CACHE_KEY,
          JSON.stringify({ rates, fetchedAt: Date.now() }),
        );
      } catch {
        /* cache is best-effort */
      }
      return rates as Record<string, number>;
    },
    initialData: () => readCachedRates() ?? undefined,
    staleTime: 12 * 60 * 60 * 1000,
    retry: 1,
  });
}

export interface Currency {
  /** The user's chosen code — or "USD" if we can't honestly convert yet. */
  code: string;
  /** Chosen code even when rates aren't ready (for the picker's own state). */
  selected: string;
  rate: number;
  /** True once a real rate for a non-USD choice is available. */
  converted: boolean;
  setCurrency: (code: string) => void;
  convert: (usd: number) => number;
  /** Format a USD amount in the display currency. */
  format: (usd: number, opts?: { decimals?: number; compact?: boolean }) => string;
}

export function useCurrency(): Currency {
  const selected = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_CURRENCY,
  );
  // F3-12: the rates' initialData is the localStorage copy, which the server never has. Reading it
  // during hydration made the first client render differ from the server's (AUD figures and no
  // "Showing USD while rates load" note vs USD and the note), and React threw the /business tree
  // away. Until hydration both sides see "no rates yet"; the cached rates apply one render later.
  const hydrated = useHydrated();
  const { data: liveRates } = useRates();
  const rates = hydrated ? liveRates : undefined;

  const rawRate = selected === "USD" ? 1 : rates?.[selected];
  // No usable rate → show USD rather than a fake converted figure.
  const usable = typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0;
  const code = usable ? selected : "USD";
  const rate = usable ? (rawRate as number) : 1;

  const convert = useCallback((usd: number) => (Number.isFinite(usd) ? usd * rate : 0), [rate]);

  const format = useCallback(
    (usd: number, opts?: { decimals?: number; compact?: boolean }) => {
      const value = Number.isFinite(usd) ? usd * rate : 0;
      // Sensible default precision: cents for small amounts, whole units for
      // anything you'd read at a glance on a dashboard tile.
      const decimals =
        opts?.decimals ?? (Math.abs(value) > 0 && Math.abs(value) < 10 ? 2 : 0);
      // One formatter (src/lib/format.ts): A$ for AUD, US$ for USD, every other currency labelled.
      return opts?.compact ? fmtMoneyCompact(value, { currency: code }) : fmtMoney(value, { currency: code, whole: decimals === 0 });
    },
    [code, rate],
  );

  return {
    code,
    selected,
    rate,
    converted: usable && selected !== "USD",
    setCurrency,
    convert,
    format,
  };
}
