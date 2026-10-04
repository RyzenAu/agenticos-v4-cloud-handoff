export const REPLY_STYLES = [
  { value: "current", label: "Current Jarvis style" },
  { value: "direct", label: "Direct · minimal banter" },
  { value: "warm", label: "Warm · conversational" },
] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number]["value"];
const KEY = "mu.jarvis.reply-style.v1";
export function replyStyle(value: unknown): ReplyStyle {
  return REPLY_STYLES.some((s) => s.value === value) ? value as ReplyStyle : "current";
}
export function loadReplyStyle(): ReplyStyle {
  try { return replyStyle(localStorage.getItem(KEY)); } catch { return "current"; }
}
export function saveReplyStyle(value: ReplyStyle): boolean {
  try { localStorage.setItem(KEY, replyStyle(value)); return true; } catch { return false; }
}
export function replyStyleInstructions(value: unknown): string {
  switch (replyStyle(value)) {
    case "direct": return "\nDelivery preference: speak plainly and briefly, with minimal banter. This changes tone only; preserve all factual qualifications, confirmations and tool rules above.";
    case "warm": return "\nDelivery preference: speak warmly and conversationally, with a little understated wit when appropriate. Keep replies brief. This changes tone only; preserve all factual qualifications, confirmations and tool rules above.";
    default: return "";
  }
}
