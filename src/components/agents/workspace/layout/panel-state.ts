// The conversation + computer layout's pure rules: which layout a width gets, how wide the side panel may be, and what is remembered.
// Ideas only from OpenBot's right rail (a persistent computer frame beside the conversation, slimmer on narrow windows); no code copied.

export const WIDE_AT = 1200;
export const TABLET_AT = 768;
export type LayoutMode = "wide" | "tablet" | "phone";

export const PANEL_MIN = 320;
export const PANEL_MAX = 1100;
// R11: 440 left the live desktop a postage stamp beside a 250 px bot list; the list now steps aside while the computer shows, and the panel opens at a comfortable size.
export const PANEL_DEFAULT = 640;
export const PANEL_STEP = 24;
export const PANEL_BIG_STEP = 96;
/** The conversation never gets narrower than this beside the panel: wide enough for the composer's one-line placeholder, the voice button and Send. */
export const CHAT_MIN = 480;
/** The grab handle between the two. */
export const HANDLE = 12;

// v2 (R11): widths saved under v1 were mostly the old 440 default, not a choice; start them fresh.
export const PANEL_STORAGE_KEY = "agents.workspace.computer-panel.v2";
/** Below this row width a side panel would squeeze both panes, so the layout uses the Conversation / Computer switch instead. */
export const SIDE_BY_SIDE_MIN = CHAT_MIN + HANDLE + PANEL_MIN + 48;

export const modeFor = (viewportWidth: number): LayoutMode => (viewportWidth >= WIDE_AT ? "wide" : viewportWidth >= TABLET_AT ? "tablet" : "phone");

/** The widest the panel may be in a row `available` px wide (the viewport when the row isn't measured yet). */
export function panelMax(available: number): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(available) - CHAT_MIN - HANDLE));
}

export function clampWidth(width: number, available: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT;
  return Math.min(panelMax(available), Math.max(PANEL_MIN, w));
}

/** Pure: the width a key press asks for, or null when the key isn't for the separator. The handle sits left of the panel, so Left widens it. */
export function widthForKey(key: string, width: number, available: number, shift = false): number | null {
  const step = shift ? PANEL_BIG_STEP : PANEL_STEP;
  switch (key) {
    case "ArrowLeft": case "ArrowUp": return clampWidth(width + step, available);
    case "ArrowRight": case "ArrowDown": return clampWidth(width - step, available);
    case "Home": return PANEL_MIN;
    case "End": return panelMax(available);
    default: return null;
  }
}

export type PanelPrefs = { open: boolean; width: number };
export const DEFAULT_PREFS: PanelPrefs = { open: false, width: PANEL_DEFAULT };

type StorageLike = Pick<Storage, "getItem" | "setItem">;
function store(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** What this browser remembers: whether the panel is open and how wide. Anything unreadable is the default. */
export function readPrefs(s: StorageLike | null = store()): PanelPrefs {
  try {
    const raw = s?.getItem(PANEL_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Partial<PanelPrefs> | null;
    const width = typeof v?.width === "number" && Number.isFinite(v.width) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(v.width))) : PANEL_DEFAULT;
    return { open: v?.open === true, width };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(p: PanelPrefs, s: StorageLike | null = store()): void {
  try {
    s?.setItem(PANEL_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private mode or full: the layout still works, it just isn't remembered */
  }
}
