/**
 * Coding work belongs to Track 3 (REVIEW-T2 #3, lead decision 28 Sep): "fix X in the dental site",
 * "assign Codex to …" go to T3's coding workspace (draft → plan → confirm), never to an agent job
 * started from here. The command entry only recognises the words with T3's OWN detector
 * (src/lib/commands/coding.ts `codingCommandEntry`) and opens the same draft page its registry entry
 * opens, so a typed command and the palette land in the same place.
 *
 * T3's module is loaded at runtime (it arrives with T3's merge); until then nothing here claims coding
 * words, and they fall through to Jev like any other request.
 */
type Entry = { action: { type: string; to?: string; search?: Record<string, string> } } | null;
type Detector = (text: string) => { path: string } | null;

let detector: Detector | null = null;
/** T3's `codeChangeNotPayment` (scripts/jarvis-execution/spoken-money.ts on T3's branch), when present. */
let codeChange: ((text: string) => boolean) | null = null;

/**
 * REVIEW-T3 F7b: a code change that only NAMES a money feature ("fix the checkout bug in the dental site")
 * is coding work, not a payment. T3's own rule decides; false until T3 is in this tree.
 */
export function codeChangeNotPayment(text: string): boolean {
  try {
    return !!codeChange?.(text);
  } catch {
    return false;
  }
}
let loading: Promise<boolean> | null = null;

/** The Coding draft page for these words (T3's detector), or null. Sync once loaded. */
export function codingDraftFor(text: string): { path: string } | null {
  try {
    return detector?.(text) ?? null;
  } catch {
    return null;
  }
}

/** Load T3's detector if it's in this tree. Resolves true when coding words are recognised. Cached. */
export function loadCodingDetector(importer: (spec: string) => Promise<unknown> = (spec) => import(spec)): Promise<boolean> {
  loading ??= (async () => {
    try {
      const mod = (await importer(new URL("../../src/lib/commands/coding.ts", import.meta.url).href)) as { codingCommandEntry?: (text: string) => Entry };
      const entry = mod?.codingCommandEntry;
      if (typeof entry !== "function") return false;
      try {
        const money = (await importer(new URL("../jarvis-execution/spoken-money.ts", import.meta.url).href)) as { codeChangeNotPayment?: (text: string) => boolean };
        if (typeof money?.codeChangeNotPayment === "function") codeChange = money.codeChangeNotPayment;
      } catch {
        /* the money rule without T3's carve-out: coding words that name money stay refused */
      }
      detector = (text) => {
        const e = entry(text);
        if (!e || e.action.type !== "navigate" || typeof e.action.to !== "string" || !e.action.to.startsWith("/")) return null;
        const q = new URLSearchParams(e.action.search ?? {}).toString();
        return { path: `${e.action.to}${q ? `?${q}` : ""}` };
      };
      return true;
    } catch {
      return false; // T3 not merged yet
    }
  })();
  return loading;
}
