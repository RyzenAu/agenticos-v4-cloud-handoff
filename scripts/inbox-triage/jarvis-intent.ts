// Jarvis voice: instant inbox answers from the triage log (no model call, no mailbox request).
//   "what's in my inbox"      → summary
//   "anything important"      → important (urgent + today)
//   "any client emails"       → clients
// Anchored patterns only. "check my email" / "any new emails" stay with get_recent_emails, which
// asks the mailbox live. Answers are built by code from the masked log — never a body, never a code.
import { existsSync } from "node:fs";
import { openTriageStore, triageDbPath, type TriageRow } from "./store";

export type InboxRequest = { skill: "inbox"; action: "summary" | "important" | "clients" };

const clean = (u: string) =>
  u
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/^(?:hey |ok |okay )?jarvis[, ]+/, "")
    .replace(/[?.!,]+/g, " ")
    .replace(/\b(please|mate|sir|right now|at the moment|so far)\b/g, " ")
    .replace(/\be-?mails?\b/g, "email")
    .replace(/\s+/g, " ")
    .trim();

const BOX = "(?:inbox|email|mail)";
const SUMMARY = [
  new RegExp(`^(?:what(?:'s| is| have i got| do i have) in|how(?:'s| is)|what(?:'s| is) happening in|summari[sz]e|triage|brief me on) (?:my |the )?${BOX}(?: today| looking| like)*$`),
  new RegExp(`^(?:give me |read me )?(?:my |an? |the )?${BOX} (?:summary|rundown|brief|round ?up)(?: today)?$`),
];
const IMPORTANT = [
  new RegExp(`^(?:is there |have i got |do i have |did i get |got )?anything (?:important|urgent)(?: (?:in|on) (?:my |the )?${BOX}| come in| today| i need to (?:see|know about))*$`),
  new RegExp(`^(?:any|are there any|have i got any|did i get any|do i have any) (?:important|urgent) (?:new )?${BOX}s?(?: today)?$`),
];
const CLIENTS = [
  new RegExp(`^(?:(?:any|are there any|have i got any|did i get any|do i have any) |anything from (?:my |any |the )?)(?:new )?(?:client|customer)s?(?: ${BOX}s?| messages)?(?: today)?$`),
  /^(?:has|have) (?:a |any |my )?(?:client|customer)s? (?:emailed|written|been in touch|replied)(?: today)?$/,
];

export function inboxIntent(utterance: string): InboxRequest | null {
  const u = clean(utterance);
  if (!u || u.length > 120) return null;
  if (CLIENTS.some((re) => re.test(u))) return { skill: "inbox", action: "clients" };
  if (IMPORTANT.some((re) => re.test(u))) return { skill: "inbox", action: "important" };
  if (SUMMARY.some((re) => re.test(u))) return { skill: "inbox", action: "summary" };
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const who = (row: TriageRow) => row.senderName.replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 40) || row.senderDomain;
const about = (row: TriageRow) => `${who(row)} about "${row.subject.replace(/["]/g, "").slice(0, 70)}"`;
const list = (rows: TriageRow[], max = 3) => {
  const items = rows.slice(0, max).map(about);
  const more = rows.length > max ? `, and ${rows.length - max} more` : "";
  return items.length > 1 ? `${items.slice(0, -1).join("; ")} and ${items.at(-1)}${more}` : `${items[0] ?? ""}${more}`;
};

/** The spoken line. `rows` = the log's last 24 hours, newest first. */
export function answerInbox(req: InboxRequest, rows: TriageRow[], lastLoggedAt: string | null, now = Date.now()) {
  if (!lastLoggedAt) return "Inbox triage hasn't logged anything yet, sir.";
  const staleMinutes = Math.round((now - Date.parse(lastLoggedAt)) / 60_000);
  const stale = staleMinutes > 90 ? ` That's as of ${staleMinutes >= 120 ? plural(Math.round(staleMinutes / 60), "hour") : plural(staleMinutes, "minute")} ago.` : "";
  const urgent = rows.filter((r) => r.importance === "urgent");
  const today = rows.filter((r) => r.importance === "today");
  const clients = rows.filter((r) => r.category === "client");
  if (req.action === "clients") {
    if (!clients.length) return `No client emails in the last day, sir.${stale}`;
    return `${plural(clients.length, "client email")} in the last day: ${list(clients)}.${stale}`;
  }
  if (req.action === "important") {
    const important = [...urgent, ...today];
    if (!important.length) return `Nothing important in the last day, sir. ${plural(rows.length, "email")} logged, all FYI or noise.${stale}`;
    const parts = [];
    if (urgent.length) parts.push(`Urgent: ${list(urgent)}.`);
    if (today.length) parts.push(`For today: ${list(today)}.`);
    return `${parts.join(" ")}${stale}`;
  }
  if (!rows.length) return `Nothing new in the last day, sir.${stale}`;
  const noise = rows.filter((r) => r.importance === "ignore").length;
  const fyi = rows.filter((r) => r.importance === "fyi").length;
  const head = `${plural(rows.length, "email")} in the last day: ${urgent.length} urgent, ${today.length} for today, ${fyi} FYI and ${noise} noise.`;
  const top = urgent[0] ?? clients[0] ?? today[0];
  const client = clients.length ? (clients.length === 1 ? " One is from a client." : ` ${clients.length} are from clients.`) : "";
  return `${head}${client}${top ? ` Top of the pile: ${about(top)}.` : ""}${stale}`;
}

/** Read-only, straight from the log file. Missing log = a clear "nothing yet". */
export function inboxAnswerFromLog(root: string, req: InboxRequest, now = Date.now()) {
  if (!existsSync(triageDbPath(root))) return answerInbox(req, [], null, now);
  const store = openTriageStore(root, { readonly: true });
  try {
    return answerInbox(req, store.since(new Date(now - 24 * 3_600_000).toISOString(), 1000), store.counts().lastLoggedAt, now);
  } finally {
    store.close();
  }
}
