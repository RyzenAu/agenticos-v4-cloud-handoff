/**
 * The business OS by voice or typing: search the business records, open the right one from a name, save a note or a task against a named
 * client or deal, draft a quote or an invoice from the agreed price, show the next real action and the existing unsent drafts.
 *
 * Narrow on purpose, like crm.ts: it parses a few explicit forms (each names a business word, so ordinary speech and "open Chrome" are never
 * taken), then runs the CRM's own typed operations (crm.search, crm.task.create, crm.activity.add, crm.proposal.draft, crm.invoice.draft,
 * crm.quote.package, crm.next.list, crm.drafts.list) with the VERIFIED principal. A name is resolved to ONE record or it asks which; it never
 * guesses. Nothing here sends a message, issues an invoice, takes a payment or touches a provider, and there is no second copy of any rule: the
 * arithmetic, the GST and the price checks are the operations' own. The gates are passed in (crm.ts owns them), so a program, routine or gateway
 * principal gains nothing it did not already have.
 */
import { createHash } from "node:crypto";
import type { Principal } from "../identity/principal";
import { crmRefString, type CrmRef } from "../../src/lib/crm-ref";
import { formatAud } from "../../src/lib/receptionist-packages";
import { pickFromHits, type BusinessHit, type BusinessKind } from "../crm/business";
import type { CrmAnswer, CrmOperationsLike } from "./crm";

export type PackageWord = "receptionist-essential" | "receptionist-professional" | "receptionist-premium";
export type BusinessIntent =
  | { kind: "search"; query: string; kinds: BusinessKind[] }
  | { kind: "open"; name: string; kinds: BusinessKind[] }
  | { kind: "named-note"; name: string; kinds: BusinessKind[]; text: string }
  | { kind: "task"; name: string; kinds: BusinessKind[]; title: string; dueAt: string | null; owner: "usman" | "mehroz" | "" }
  | { kind: "quote"; name: string; packageId: PackageWord | null }
  | { kind: "invoice"; name: string; portion: "full" | "deposit" }
  | { kind: "next"; name: string | null }
  | { kind: "drafts"; name: string | null; what: "outreach" | "meeting" | "all" };

const KIND_WORDS: Record<string, BusinessKind> = {
  client: "company", clients: "company", company: "company", companies: "company", customer: "company", customers: "company",
  contact: "contact", contacts: "contact", deal: "deal", deals: "deal", opportunity: "deal", project: "project", projects: "project",
  task: "task", tasks: "task", quote: "quote", quotes: "quote", proposal: "quote", proposals: "quote", invoice: "invoice", invoices: "invoice",
  file: "file", files: "file", document: "document", documents: "document",
};
const kindOf = (word: string | undefined): BusinessKind | null => (word ? (KIND_WORDS[word.toLowerCase()] ?? null) : null);
const PREAMBLE = /^(?:(?:hey\s+|ok\s+|okay\s+)?jarvis[,\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const NAME = "([^:]{2,100}?)";
const SEP = "(?:\\s*:\\s*|,\\s+|\\s+[-–—]\\s+)";
const KINDWORD = "(client|company|customer|deal|project|contact)";
// No "files", "documents" or "tasks" here: "find files called report" is a PC file search and "find tasks about X" belongs to the bots' task list.
// Those are searched with "search the CRM for ..." (every business kind) or through crm.search.
const SEARCH_KINDS = "(clients?|companies|company|customers?|contacts?|deals?|projects?|quotes?|proposals?|invoices?)";

const SEARCH_FIND = new RegExp(`^(?:find|search(?:\\s+for)?|look\\s+up|look\\s+for)\\s+(?:the\\s+|my\\s+|all\\s+|our\\s+)?${SEARCH_KINDS}\\s+(?:called\\s+|named\\s+|for\\s+|about\\s+|matching\\s+|with\\s+|from\\s+)?(.{2,120})$`, "i");
const SEARCH_LIST = new RegExp(`^(?:show(?:\\s+me)?|list)\\s+(?:the\\s+|my\\s+|all\\s+|our\\s+)?${SEARCH_KINDS}\\s+(?:called|named|for|about|matching)\\s+(.{2,120})$`, "i");
const SEARCH_CRM = /^(?:search|look)\s+(?:the\s+)?(?:crm|business(?:\s+records)?|workspace|records)\s+for\s+(.{2,120})$/i;
const SEARCH_IN = /^(?:find|search\s+for|look\s+up)\s+(.{2,120}?)\s+in\s+(?:the\s+)?(?:crm|business\s+records|business\s+os)$/i;

const OPEN_KIND = new RegExp(`^(?:open|show(?:\\s+me)?|pull\\s+up|go\\s+to|take\\s+me\\s+to|bring\\s+up)\\s+(?:the\\s+)?(client|company|contact|deal|project|quote|proposal|invoice)\\s+(?:called\\s+|named\\s+|for\\s+)?(.{2,100})$`, "i");
const OPEN_POST = /^(?:open|show(?:\s+me)?|pull\s+up|go\s+to|take\s+me\s+to|bring\s+up)\s+(?:the\s+)?(.{2,100}?)\s+(deal|project|quote|proposal|invoice)$/i;
const OPEN_IN = /^(?:open|pull\s+up|bring\s+up|show(?:\s+me)?)\s+(.{2,100}?)\s+in\s+(?:the\s+)?crm$/i;
const OPEN_RECORD = /^(?:open|pull\s+up|show(?:\s+me)?)\s+(?:the\s+)?(?:crm\s+)?(?:record|page)\s+(?:for|of)\s+(.{2,100})$/i;

const NOTE_KIND = new RegExp(`^(?:add\\s+(?:a\\s+)?|save\\s+(?:a\\s+)?|make\\s+(?:a\\s+)?)?(?:crm\\s+)?note\\s+(?:to|on|for)\\s+(?:the\\s+)?${NAME}\\s+${KINDWORD}${SEP}(.{2,500})$`, "i");
const NOTE_CRM = new RegExp(`^(?:add\\s+(?:a\\s+)?|save\\s+(?:a\\s+)?|make\\s+(?:a\\s+)?)?crm\\s+note\\s+(?:to|on|for)\\s+(?:the\\s+)?${NAME}${SEP}(.{2,500})$`, "i");
const TASK_KIND = new RegExp(`^(?:create|add|make|new|set\\s+up)\\s+(?:a\\s+|me\\s+a\\s+)?(?:new\\s+)?(?:crm\\s+)?task\\s+(?:for|on|to|against)\\s+(?:the\\s+)?${NAME}\\s+${KINDWORD}${SEP}(.{2,300})$`, "i");
const TASK_CRM = new RegExp(`^(?:create|add|make|new|set\\s+up)\\s+(?:a\\s+|me\\s+a\\s+)?(?:new\\s+)?crm\\s+task\\s+(?:for|on|to|against)\\s+(?:the\\s+)?${NAME}${SEP}(.{2,300})$`, "i");
const TASK_IN_CRM = new RegExp(`^(?:create|add|make|new|set\\s+up)\\s+(?:a\\s+|me\\s+a\\s+)?(?:new\\s+)?task\\s+in\\s+(?:the\\s+)?crm\\s+(?:for|on|to|against)\\s+(?:the\\s+)?${NAME}${SEP}(.{2,300})$`, "i");

const QUOTE = /^(?:draft|prepare|create|make|write|put\s+together)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:new\s+)?(?:quote|proposal)\s+(?:for|on)\s+(?:the\s+)?(.{2,100}?)(?:\s+deal)?(?:\s+(?:with|using|on)\s+(?:the\s+)?(essential|professional|premium)(?:\s+(?:receptionist\s+)?package)?)?$/i;
const INVOICE = /^(?:draft|prepare|create|make|write|put\s+together)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:new\s+)?(deposit\s+)?invoice\s+(?:for|on)\s+(?:the\s+)?(.{2,100}?)(?:\s+deal)?(\s+(?:as\s+a\s+|with\s+a\s+)?deposit)?$/i;
const NEXT = /^(?:what(?:'s|\s+is|\s+are)|show(?:\s+me)?|tell\s+me)\s+(?:the\s+|my\s+|our\s+)?next(?:\s+real)?\s+actions?(?:\s+(?:for|on)\s+(?:the\s+)?(.{2,100}?)(?:\s+(?:deal|client|company|project))?)?$|^next\s+actions?(?:\s+(?:for|on)\s+(?:the\s+)?(.{2,100}?)(?:\s+(?:deal|client|company|project))?)?$/i;
const DRAFTS = /^(?:show(?:\s+me)?|view|open|list|pull\s+up|what\s+are)\s+(?:the\s+|our\s+|any\s+|all\s+)?(?:existing\s+|unsent\s+|draft\s+)*(outreach(?:\s+packs?|\s+drafts?)?|meeting\s+packs?|reply\s+drafts?)(?:\s+(?:for|on|to)\s+(?:the\s+)?(.{2,100}?)(?:\s+(?:deal|client|company|project))?)?$/i;

const SELF = /^(?:this|that|the\s+open|the\s+current|open|current)$/i;
const tidyName = (s: string) => clean(s.replace(/[.!?]+$/, ""));
/** "open the deal", "open it": an article or pronoun is not a name, so nothing is taken. */
const NOT_A_NAME = /^(?:the|a|an|this|that|it|my|our|one|any|some)$/i;
/** "open the file synthetic proposal", "open my Word document quote": a file, app or page the other lanes own, never a CRM name. */
const OTHER_LANE = /^(?:(?:the|my|a|an)\s+)?(?:file|folder|document|doc|pdf|app|application|window|tab|website|site|page|program|spreadsheet|deck|powerpoint|word|excel|notepad|chrome|browser)\b/i;

/** Pure: the business intent in an utterance, or null. Every form names a business word; none can take ordinary speech. */
export function businessIntentIn(utterance: string): BusinessIntent | null {
  const t = clean(utterance.replace(PREAMBLE, "")).replace(/[.!?]+$/, "");
  let m: RegExpExecArray | null;

  if ((m = NOTE_KIND.exec(t)) && !SELF.test(m[1].trim()))
    return { kind: "named-note", name: tidyName(m[1]), kinds: [kindOf(m[2])!], text: clean(m[3]) };
  if ((m = NOTE_CRM.exec(t)) && !SELF.test(m[1].trim()))
    return { kind: "named-note", name: tidyName(m[1]), kinds: ["company", "deal", "project", "contact"], text: clean(m[2]) };

  const task = (name: string, kinds: BusinessKind[], rest: string): BusinessIntent => {
    let title = clean(rest);
    let dueAt: string | null = null;
    let owner: "usman" | "mehroz" | "" = "";
    for (let i = 0; i < 2; i++) {
      const due = /\s+(?:due|by)\s+(\d{4}-\d{2}-\d{2})$/i.exec(title);
      if (due) { dueAt = due[1]; title = title.slice(0, due.index).trim(); }
      const who = /\s+assign(?:ed)?\s+to\s+(usman|mehroz)$/i.exec(title);
      if (who) { owner = who[1].toLowerCase() as "usman" | "mehroz"; title = title.slice(0, who.index).trim(); }
    }
    return { kind: "task", name: tidyName(name), kinds, title, dueAt, owner };
  };
  if ((m = TASK_KIND.exec(t))) return task(m[1], [kindOf(m[2])!], m[3]);
  if ((m = TASK_CRM.exec(t))) return task(m[1], ["company", "deal", "project", "contact"], m[2]);
  if ((m = TASK_IN_CRM.exec(t))) return task(m[1], ["company", "deal", "project", "contact"], m[2]);

  if ((m = INVOICE.exec(t)))
    return { kind: "invoice", name: tidyName(m[2]), portion: m[1] || m[3] ? "deposit" : "full" };
  if ((m = QUOTE.exec(t)))
    return { kind: "quote", name: tidyName(m[1]), packageId: m[2] ? (`receptionist-${m[2].toLowerCase()}` as PackageWord) : null };

  if ((m = NEXT.exec(t))) return { kind: "next", name: m[1] || m[2] ? tidyName((m[1] || m[2])!) : null };
  if ((m = DRAFTS.exec(t))) {
    const word = m[1].toLowerCase();
    return { kind: "drafts", name: m[2] ? tidyName(m[2]) : null, what: word.startsWith("meeting") ? "meeting" : word.startsWith("outreach") ? "outreach" : "all" };
  }

  if ((m = SEARCH_FIND.exec(t)) || (m = SEARCH_LIST.exec(t))) {
    const k = kindOf(m[1]);
    return k ? { kind: "search", query: tidyName(m[2]), kinds: k === "quote" ? ["quote"] : [k] } : null;
  }
  if ((m = SEARCH_CRM.exec(t))) return { kind: "search", query: tidyName(m[1]), kinds: [] };
  if ((m = SEARCH_IN.exec(t))) return { kind: "search", query: tidyName(m[1]), kinds: [] };

  const open = (name: string, kinds: BusinessKind[]): BusinessIntent | null =>
    NOT_A_NAME.test(tidyName(name)) || OTHER_LANE.test(tidyName(name)) ? null : { kind: "open", name: tidyName(name), kinds };
  if ((m = OPEN_KIND.exec(t))) return open(m[2], [kindOf(m[1])!]);
  if ((m = OPEN_POST.exec(t))) return open(m[1], [kindOf(m[2])!]);
  if ((m = OPEN_IN.exec(t))) return open(m[1], []);
  if ((m = OPEN_RECORD.exec(t))) return open(m[1], []);
  return null;
}

type Receipt = { ok?: boolean; text?: string; code?: string; data?: unknown; href?: string };
export type BusinessDeps = {
  operations: () => CrmOperationsLike;
  now?: () => number;
  /** crm.ts's own gates: why this person may not write / read, or null. */
  writeRefusal: (principal: Principal) => string | null;
  readRefusal: (principal: Principal) => string | null;
};

const fail = (said: string, verified: boolean | null = null, extra: Partial<CrmAnswer> = {}): CrmAnswer => ({ ok: false, said, verified, ...extra });
const money = formatAud;
const KIND_LABEL: Record<BusinessKind, string> = {
  company: "client", contact: "contact", deal: "deal", project: "project", task: "task", quote: "quote", invoice: "invoice", document: "document", file: "file", workbook: "quote workbook",
};
const label = (h: BusinessHit) => `${h.title} (${KIND_LABEL[h.kind]}${h.detail ? `, ${h.detail.split(" · ")[0]}` : ""})`;
const askWhich = (name: string, hits: readonly BusinessHit[]): CrmAnswer =>
  fail(`${hits.length} records match "${name}": ${hits.slice(0, 4).map(label).join("; ")}. Which one?`, null, { ask: true });

/** Run one business intent through the CRM's typed operations. Never throws: an unavailable CRM is a plain sentence. */
export async function runBusinessIntent(
  deps: BusinessDeps,
  intent: BusinessIntent,
  principal: Principal,
  options: { eventId?: string } = {},
): Promise<CrmAnswer> {
  const minute = Math.floor((deps.now?.() ?? Date.now()) / 60_000);
  const call = async (name: string, input: unknown): Promise<{ r: Receipt } | { stop: CrmAnswer }> => {
    try {
      const r = (await deps.operations().run(name, input, principal)) as Receipt;
      return { r };
    } catch (error) {
      if ((error as { code?: string })?.code === "needs-upgrade") return { stop: fail(String((error as Error).message)) };
      return { stop: fail("The CRM didn't answer, so nothing changed.") };
    }
  };
  const refused = (r: Receipt): CrmAnswer => fail(`The CRM didn't take it: ${String(r?.text ?? "refused").slice(0, 200)}`, false);

  const writes = intent.kind === "named-note" || intent.kind === "task" || intent.kind === "quote" || intent.kind === "invoice";
  const gate = writes ? deps.writeRefusal(principal) : deps.readRefusal(principal);
  if (gate) return fail(gate);
  // A draft carries the client's price and private text: the CRM page asks for a confirmed browser, and so does this.
  if ((intent.kind === "quote" || intent.kind === "invoice") && principal.actor !== "human")
    return fail("Confirm this browser before I draft a quote or invoice, so nothing was drafted.");

  const find = async (name: string, kinds: readonly BusinessKind[]): Promise<{ hit: BusinessHit } | { stop: CrmAnswer }> => {
    const out = await call("crm.search", { query: name, ...(kinds.length ? { kinds } : {}), limit: 25 });
    if ("stop" in out) return out;
    if (out.r.ok === false) return { stop: refused(out.r) };
    const hits = ((out.r.data as { hits?: BusinessHit[] } | undefined)?.hits ?? []).filter((h) => h.ref);
    const picked = pickFromHits(hits, name);
    if (picked.status === "none") return { stop: fail(`I can't find "${name}" in the business records, so nothing changed.`) };
    if (picked.status === "many") return { stop: askWhich(name, picked.hits) };
    return { hit: picked.hit };
  };
  const dealOf = async (hit: BusinessHit): Promise<{ id: string; version: number; title: string } | { stop: CrmAnswer }> => {
    const out = await call("crm.record.get", { ref: hit.ref });
    if ("stop" in out) return out;
    const deal = out.r.data as { id?: string; version?: number; title?: string } | undefined;
    if (out.r.ok === false || !deal?.id || typeof deal.version !== "number") return { stop: refused(out.r) };
    return { id: deal.id, version: deal.version, title: deal.title ?? hit.title };
  };

  if (intent.kind === "search") {
    const out = await call("crm.search", { query: intent.query, ...(intent.kinds.length ? { kinds: intent.kinds } : {}), limit: 5 });
    if ("stop" in out) return out.stop;
    if (out.r.ok === false) return refused(out.r);
    const data = out.r.data as { total: number; hits: BusinessHit[] };
    if (!data.hits.length) return { ok: true, said: `Nothing in the business records matches "${intent.query}".`, verified: true };
    const shown = data.hits.slice(0, 4).map(label).join("; ");
    return { ok: true, said: `${data.total} match${data.total === 1 ? "" : "es"} for "${intent.query}": ${shown}.${data.hits.length === 1 ? " Say \"open it\" by name to go there." : ""}`, verified: true };
  }
  if (intent.kind === "open") {
    const f = await find(intent.name, intent.kinds);
    if ("stop" in f) return f.stop;
    const path = f.hit.href ?? "/crm";
    return { ok: true, said: `Opened ${label(f.hit)}.`, verified: true, navigate: { path } };
  }
  if (intent.kind === "named-note") {
    const f = await find(intent.name, intent.kinds);
    if ("stop" in f) return f.stop;
    const ref = f.hit.ref as CrmRef;
    const key = options.eventId
      ? `jarvis:${options.eventId}`
      : `jarvis:${createHash("sha256").update(`${principal.personId}|${crmRefString(ref)}|${intent.text}`).digest("hex").slice(0, 24)}:${minute}`;
    const out = await call("crm.activity.add", {
      ref, eventId: key, kind: "note", title: `Note: ${intent.text.slice(0, 80)}`.slice(0, 300), note: intent.text, by: { personId: principal.personId },
    });
    if ("stop" in out) return out.stop;
    if (out.r.ok === false) return refused(out.r);
    return { ok: true, said: `Saved the note on ${label(f.hit)}.`, verified: true, navigate: { path: f.hit.href ?? "/crm" } };
  }
  if (intent.kind === "task") {
    if (!intent.title) return fail("Say what the task is, after the name, and I'll save it.");
    const f = await find(intent.name, intent.kinds);
    if ("stop" in f) return f.stop;
    const hit = f.hit;
    if (!hit.companyId) return fail(`I can't tell which client "${hit.title}" belongs to, so I haven't saved the task.`);
    const owner = intent.owner || principal.personId;
    const key = options.eventId
      ? `jarvis:${options.eventId}:task`
      : `jarvis:task:${createHash("sha256").update(`${principal.personId}|${hit.kind}:${hit.id}|${intent.title}|${intent.dueAt ?? ""}`).digest("hex").slice(0, 24)}:${minute}`;
    const input = {
      externalKey: key,
      companyId: hit.companyId,
      title: intent.title.slice(0, 300),
      dealId: hit.kind === "deal" ? hit.id : null,
      projectId: hit.kind === "project" ? hit.id : null,
      contactId: hit.kind === "contact" ? hit.id : null,
      owner,
      ...(intent.dueAt ? { dueAt: intent.dueAt } : {}),
    };
    const out = await call("crm.task.create", input);
    if ("stop" in out) return out.stop;
    if (out.r.ok === false) return refused(out.r);
    const id = (out.r.data as { id?: string } | undefined)?.id;
    // Independent read-back: the task now lists as open work for that client.
    const back = await call("crm.next.list", { companyId: hit.companyId, limit: 100 });
    const verified = !("stop" in back) && !!(back.r.data as { actions?: { taskId: string }[] } | undefined)?.actions?.some((a) => a.taskId === id);
    const link = hit.kind === "company" ? "" : ` linked to ${hit.title}`;
    return verified
      ? { ok: true, said: `Saved the task "${intent.title}" for ${owner}${link}${intent.dueAt ? `, due ${intent.dueAt}` : ", with no due date"}.`, verified: true, navigate: { path: hit.href ?? "/crm" } }
      : fail("I sent the task to the CRM, but it doesn't read back as open work, so I'm not calling it done.", false);
  }
  if (intent.kind === "quote" || intent.kind === "invoice") {
    const f = await find(intent.name, ["deal"]);
    if ("stop" in f) return f.stop;
    const deal = await dealOf(f.hit);
    if ("stop" in deal) return deal.stop;
    if (intent.kind === "invoice") {
      const out = await call("crm.invoice.draft", { dealId: deal.id, expectedVersion: deal.version, portion: intent.portion });
      if ("stop" in out) return out.stop;
      if (out.r.ok === false) return refused(out.r);
      const d = out.r.data as { document: { id: string }; subtotalCents: number; gstCents: number; totalCents: number };
      const back = await call("crm.record.get", { ref: { kind: "document", id: d.document.id } });
      const verified = !("stop" in back) && back.r.ok !== false;
      return verified
        ? { ok: true, said: `Invoice draft saved on ${deal.title}: ${money(d.subtotalCents)} ex GST + ${money(d.gstCents)} GST = ${money(d.totalCents)}. Not issued or sent; the ABN and payment terms are still to confirm.`, verified: true, navigate: { path: out.r.href ?? f.hit.href ?? "/crm" } }
        : fail("I saved the draft, but it doesn't read back, so I'm not calling it done.", false);
    }
    if (intent.packageId) {
      const out = await call("crm.quote.package", { dealId: deal.id, expectedVersion: deal.version, packageId: intent.packageId });
      if ("stop" in out) return out.stop;
      if (out.r.ok === false) return refused(out.r);
      const d = out.r.data as { created: boolean; packageName: string; monthly: { exGstCents: number; gstCents: number; inclGstCents: number } | null; setupPending: boolean; linked: boolean };
      const monthly = d.monthly ? `${money(d.monthly.exGstCents)} ex GST + ${money(d.monthly.gstCents)} GST = ${money(d.monthly.inclGstCents)} a month` : "no monthly price";
      return {
        ok: true,
        said: `${d.created ? "Quote draft saved" : "That quote draft already exists"} in the deal desk for ${deal.title}: ${d.packageName}, ${monthly}.${d.setupPending ? " The setup fee is pending, so it isn't priced." : ""} It lists what is still unapproved, and nothing was sent.`,
        verified: true,
        navigate: { path: out.r.href ?? "/crm" },
      };
    }
    // The agreed price on the deal (the CRM's own proposal draft): one draft per deal version, never a duplicate.
    const snap = await call("crm.snapshot", {});
    if ("stop" in snap) return snap.stop;
    const documents = ((snap.r.data as { documents?: { id: string; dealId: string | null; kind: string; status: string; currentVersion: number; versions: { number: number; pricing: { dealVersion: number | null } | null }[]; createdAt: string }[] } | undefined)?.documents ?? [])
      .filter((d) => d.dealId === deal.id && d.kind === "proposal")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = documents[0];
    const current = latest?.versions.find((v) => v.number === latest.currentVersion);
    if (latest && current?.pricing?.dealVersion === deal.version)
      return { ok: true, said: `The quote draft for ${deal.title} already matches its current price; nothing new was saved. It was not sent.`, verified: true, navigate: { path: `/crm?ref=${encodeURIComponent(`crm:document:${latest.id}`)}&tab=deals` } };
    const input: Record<string, unknown> = { dealId: deal.id, expectedVersion: deal.version };
    if (latest && latest.status === "draft") { input.documentId = latest.id; input.expectedDocumentVersion = latest.currentVersion; }
    const out = await call("crm.proposal.draft", input);
    if ("stop" in out) return out.stop;
    if (out.r.ok === false) return refused(out.r);
    const doc = out.r.data as { id: string; versions?: { number: number; pricing: { oneOffCents: number; recurringCents: number; gstTreatment: string } | null }[]; currentVersion?: number };
    const p = doc.versions?.find((v) => v.number === doc.currentVersion)?.pricing;
    const total = p ? `One-off ${money(p.oneOffCents)}${p.recurringCents ? `, then ${money(p.recurringCents)} a month` : ""} (${p.gstTreatment === "inclusive" ? "incl. GST" : p.gstTreatment === "exclusive" ? "ex GST" : "no GST"} as agreed).` : "";
    return { ok: true, said: `Quote draft saved on ${deal.title}. ${total} Not sent, and no invoice was created.`.replace(/\s+/g, " "), verified: true, navigate: { path: out.r.href ?? "/crm" } };
  }
  if (intent.kind === "next") {
    let scope: { companyId?: string; dealId?: string } = {};
    let where = "";
    if (intent.name) {
      const f = await find(intent.name, ["company", "deal"]);
      if ("stop" in f) return f.stop;
      scope = f.hit.kind === "deal" ? { dealId: f.hit.id } : { companyId: f.hit.companyId ?? f.hit.id };
      where = ` for ${f.hit.title}`;
    }
    const out = await call("crm.next.list", { ...scope, limit: 20 });
    if ("stop" in out) return out.stop;
    if (out.r.ok === false) return refused(out.r);
    const d = out.r.data as { next: { title: string; owner: string; dueAt: string | null; overdue: boolean; company: string; href: string } | null; waiting: { title: string; dependsOnCount: number }[]; actions: unknown[]; dealLines: { title: string; nextAction: string }[] };
    if (!d.next && !d.waiting.length) return { ok: true, said: `Nothing is open${where}.`, verified: true };
    const parts: string[] = [];
    if (d.next) parts.push(`Next${where}: ${d.next.title}${d.next.company && !where ? ` (${d.next.company})` : ""}, ${d.next.owner ? `owner ${d.next.owner}` : "no owner yet"}${d.next.dueAt ? `, ${d.next.overdue ? "overdue since" : "due"} ${d.next.dueAt.slice(0, 10)}` : ", no due date"}.`);
    else parts.push(`Everything open${where} is waiting on something.`);
    if (d.waiting.length) parts.push(`${d.waiting.length} waiting on other work: ${d.waiting.slice(0, 2).map((w) => `${w.title} (${w.dependsOnCount})`).join("; ")}.`);
    const others = d.actions.length - (d.next ? 1 : 0) - d.waiting.length;
    if (others > 0) parts.push(`${others} more open.`);
    if (d.dealLines[0]) parts.push(`Deal note: ${d.dealLines[0].nextAction.slice(0, 120)}.`);
    return { ok: true, said: parts.join(" "), verified: true, navigate: { path: d.next?.href ?? "/crm?view=today" } };
  }
  // drafts
  let companyId: string | undefined;
  let where = "";
  if (intent.name) {
    const f = await find(intent.name, ["company", "deal"]);
    if ("stop" in f) return f.stop;
    companyId = f.hit.companyId ?? f.hit.id;
    where = ` for ${f.hit.title}`;
  }
  const out = await call("crm.drafts.list", companyId ? { companyId } : {});
  if ("stop" in out) return out.stop;
  if (out.r.ok === false) return refused(out.r);
  const all = (out.r.data as { items: { kind: string; title: string; company: string; gaps: string[]; href: string }[] }).items;
  const items = all.filter((i) => intent.what === "all" || (intent.what === "meeting" ? i.kind === "meeting-pack" : i.kind === "outreach" || i.kind === "reply-draft"));
  if (!items.length) return { ok: true, said: `No ${intent.what === "meeting" ? "meeting packs" : "draft outreach"}${where} on file. Nothing has been sent.`, verified: true };
  const first = items.slice(0, 3).map((i) => `${i.title}${i.company ? ` (${i.company})` : ""}: ${i.gaps[0]}`).join(" | ");
  return { ok: true, said: `${items.length} draft${items.length === 1 ? "" : "s"}${where}, none sent. ${first}`, verified: true, navigate: { path: items[0].href } };
}
