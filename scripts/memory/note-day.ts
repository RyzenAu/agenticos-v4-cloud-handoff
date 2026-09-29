// How a Jarvis note's day is said ("today", "yesterday", "24 Sept"). Pure, with no Node imports, because the
// voice-intents module is also bundled into the browser (the Memory page's typed box).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
const sydneyDay = (ms: number) => DAY.format(ms); // en-CA: YYYY-MM-DD

/** "today", "yesterday" or "24 Sept" for a note dated `date` (YYYY-MM-DD, Sydney), seen at `now`. */
export function spokenNoteDay(date: string, now: number): string {
  if (date === sydneyDay(now)) return "today";
  if (date === sydneyDay(now - 86_400_000)) return "yesterday";
  const m = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? m[1]}` : date;
}
