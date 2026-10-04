// R11: the requests this browser handed to Jarvis from the /jarvis page, kept until the person's conversation shows them, so a sent
// request never vanishes from the page (on reload, or because the companion's own record of typed turns isn't in the thread yet).
export type SentRequest = { requestId: string; text: string; at: number };
export const SENT_KEY = "jarvis-page.sent.v1";
export const SENT_MAX = 20;
export const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const store = (): StorageLike | null => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** Pure: keep the newest, drop the old and malformed. */
export function tidySent(list: unknown, now: number): SentRequest[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is SentRequest => !!x && typeof x.requestId === "string" && typeof x.text === "string" && typeof x.at === "number" && now - x.at < SENT_TTL_MS)
    .slice(-SENT_MAX);
}

export function readSent(now = Date.now(), s: StorageLike | null = store()): SentRequest[] {
  try {
    return tidySent(JSON.parse(s?.getItem(SENT_KEY) ?? "[]"), now);
  } catch {
    return [];
  }
}

export function rememberSent(req: SentRequest, now = Date.now(), s: StorageLike | null = store()): SentRequest[] {
  const next = tidySent([...readSent(now, s).filter((x) => x.requestId !== req.requestId), req], now);
  try {
    s?.setItem(SENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: shown for this visit only */
  }
  return next;
}

/** Pure: the sent requests the conversation doesn't show yet (a user message with the same words, after the request was made, counts). */
export function unshownSent(sent: SentRequest[], messages: { role: string; text: string }[]): SentRequest[] {
  const said = new Set(messages.filter((m) => m.role === "user").map((m) => m.text.trim()));
  return sent.filter((r) => !said.has(r.text.trim()));
}
