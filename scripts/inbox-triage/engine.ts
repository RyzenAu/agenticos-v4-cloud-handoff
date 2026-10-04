// Inbox triage engine: who counts as a client or lead (from our own records), which archived
// emails are new, the rules → Jev → combine pipeline, and the daily digest.
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askJev, combine, type JevTriage } from "./jev";
import { dispatchAlerts, type Channels, type TriageSettings } from "./alerts";
import { FREE_MAIL, KNOWN_PROVIDERS, POLICY_VERSION, RANK, classifyByRules, domainMatches, emptyContacts, isOtpEmail, oneLineSummary, parseSender, safeSubject, type Contacts, type Importance, type TriageEmail } from "./rules";
import type { TriageRow, TriageStore } from "./store";
import { dataDirFor } from "../cloud/data-dir";

const require = createRequire(import.meta.url);
type Row = Record<string, unknown>;
function openReadonly(path: string): { prepare(sql: string): { all(...a: unknown[]): Row[] }; close(): void } | null {
  if (!existsSync(path)) return null;
  const module = require(process.versions.bun ? "bun:sqlite" : "node:sqlite");
  return process.versions.bun ? new module.Database(path, { readonly: true }) : new module.DatabaseSync(path, { readOnly: true });
}

/** Link-in-bio, directory and platform hosts: a lead's "website" there says nothing about who emailed. */
const PLATFORM_HOSTS = ["facebook.com", "instagram.com", "linktr.ee", "business.site", "wixsite.com", "squarespace.com", "weebly.com", "sites.google.com", "google.com", "yelp.com", "yellowpages.com.au", "truelocal.com.au", "hotfrog.com.au", "healthengine.com.au", "hotdoc.com.au", "realestate.com.au", "domain.com.au", "tiktok.com", "youtube.com", "godaddysites.com", "square.site", "carrd.co", "canva.site", "webflow.io", "vercel.app", "netlify.app", "muventures.com.au"];

const hostOf = (value: string) => {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const usableDomain = (domain: string) => !!domain && domain.includes(".") && !FREE_MAIL.has(domain) && !domainMatches(domain, PLATFORM_HOSTS) && !domainMatches(domain, KNOWN_PROVIDERS);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Client hub files (source/repos/<client>/CLIENT.md): name, contact emails, website, known thread ids. */
export function clientFiles(home = homedir()) {
  const repos = join(home, "source", "repos");
  try {
    return readdirSync(repos, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => join(repos, d.name, "CLIENT.md")).filter((f) => existsSync(f));
  } catch {
    return [];
  }
}

export function parseClientFile(text: string, own = new Set(["muventures.com.au"])) {
  const name = /^#\s+(.+?)(?:\s+[—–-]\s+.*)?$/m.exec(text)?.[1]?.trim() || "a client";
  const addresses = [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()))].filter((e) => !domainMatches(e.split("@")[1], own));
  const domains = new Set<string>();
  for (const address of addresses) if (usableDomain(address.split("@")[1])) domains.add(address.split("@")[1]);
  for (const line of text.split("\n")) if (/website|domain/i.test(line)) for (const m of line.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com\.au|net\.au|org\.au|com|au|net|org|io))\b/gi)) if (usableDomain(m[1].toLowerCase().replace(/^www\./, "")) && !/muventures/i.test(m[1])) domains.add(m[1].toLowerCase().replace(/^www\./, ""));
  const threads = [...text.matchAll(/thread id `([0-9a-f]{12,24})`/gi)].map((m) => m[1]);
  return { name, addresses, domains: [...domains], threads };
}

/** Trusted contacts from the CRM (won = client, the rest = lead) and every CLIENT.md hub. Read-only. */
export function loadContacts(root: string, options: { home?: string; crmPath?: string; files?: string[] } = {}): Contacts {
  const contacts = emptyContacts();
  const addClient = (name: string, addresses: string[], domains: string[], threads: string[] = []) => {
    for (const a of addresses) contacts.clientAddresses.set(a.toLowerCase(), name);
    for (const d of domains) if (usableDomain(d)) contacts.clientDomains.set(d, name);
    for (const t of threads) contacts.clientThreads.set(t, name);
  };
  for (const file of options.files ?? clientFiles(options.home)) {
    try {
      const parsed = parseClientFile(readFileSync(file, "utf8"), contacts.ownDomains);
      addClient(parsed.name, parsed.addresses, parsed.domains, parsed.threads);
    } catch { /* an unreadable hub is skipped, never fatal */ }
  }
  const crm = (() => { try { return openReadonly(options.crmPath ?? join(dataDirFor(root), "crm.sqlite")); } catch { return null; } })();
  if (crm) {
    try {
      for (const lead of crm.prepare("SELECT name,status,emails,website,excluded,merged_into FROM leads").all()) {
        if (lead.merged_into !== null && lead.merged_into !== undefined) continue;
        let emails: string[] = [];
        try { emails = (JSON.parse(String(lead.emails || "[]")) as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase().trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)); } catch { /* skip */ }
        const domains = [hostOf(String(lead.website || "")), ...emails.map((e) => e.split("@")[1])].filter(usableDomain);
        const name = String(lead.name || "a lead").slice(0, 80);
        if (lead.status === "won") addClient(name, emails, domains);
        else if (Number(lead.excluded) !== 1) {
          for (const e of emails) if (!contacts.clientAddresses.has(e)) contacts.leadAddresses.set(e, name);
          for (const d of domains) if (!contacts.clientDomains.has(d)) contacts.leadDomains.set(d, name);
        }
      }
    } catch { /* a CRM mid-migration just means no lead matches this run */ } finally {
      crm.close();
    }
  }
  return contacts;
}

/** The newest archived emails as triage input: inbound only, never drafts or his own sent mail. */
export function archivedEmails(root: string, limit = 200, path = join(dataDirFor(root), "mail-archive.sqlite")): TriageEmail[] {
  const db = openReadonly(path);
  if (!db) return [];
  try {
    return db
      .prepare("SELECT item_json FROM messages ORDER BY received_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 2000)))
      .map((r) => { try { return JSON.parse(String(r.item_json)); } catch { return null; } })
      .filter((item): item is Record<string, any> => !!item && typeof item.id === "string")
      .map(toTriageEmail)
      .filter((e): e is TriageEmail => !!e);
  } finally {
    db.close();
  }
}

export function toTriageEmail(item: Record<string, any>): TriageEmail | null {
  const labels: string[] = Array.isArray(item.labelIds) ? item.labelIds.filter((l: unknown) => typeof l === "string") : [];
  if (item.direction === "outbound" || labels.includes("SENT") || labels.includes("DRAFT")) return null;
  if (!Number.isFinite(Date.parse(item.receivedAt))) return null;
  return {
    id: String(item.id),
    account: String(item.account || ""),
    threadId: String(item.threadId || item.remoteId || item.id),
    from: String(item.from || ""),
    subject: String(item.subject || "(no subject)"),
    snippet: String(item.body || "").slice(0, 1000),
    labelIds: labels,
    receivedAt: new Date(Date.parse(item.receivedAt)).toISOString(),
    direction: "inbound",
  };
}

export const isPersonalMailbox = (account: string, settings: TriageSettings) => settings.personalAccounts.includes(account.toLowerCase()) || FREE_MAIL.has(account.toLowerCase().split("@")[1] ?? "");

/** Rules → Jev → combine → one log row. Jev failing is recorded; the rules' decision stands. */
export async function triageOne(email: TriageEmail, ctx: { contacts: Contacts; settings: TriageSettings; jevKey: string; request?: typeof fetch; now: number; backfill: boolean; shadowCount: number }): Promise<TriageRow> {
  const personal = new Set([email.account.toLowerCase()].filter((a) => isPersonalMailbox(a, ctx.settings)));
  const rules = classifyByRules(email, ctx.contacts, personal);
  const asked = await askJev(email, rules, { key: ctx.jevKey, mailbox: personal.size ? "personal" : "business", request: ctx.request });
  const jev: JevTriage | null = asked.jev;
  const final = combine(rules, jev, ctx.settings.jev.mode);
  const sender = parseSender(email.from);
  const otp = !!rules.flags.otp || isOtpEmail(email.subject, email.snippet);
  const why: string[] = [];
  let basis: TriageRow["alertBasis"] = "";
  const rulesAlert = final.importance === "urgent" || final.category === "client" || (ctx.settings.alerts.leadReplies && final.category === "lead-reply");
  if (rulesAlert) { basis = "rules"; why.push(final.reason); }
  if (final.jevUrgent) {
    basis = basis ? "both" : "jev";
    if (!rulesAlert) why.push(`Jev rated it urgent (${Math.round((jev?.importanceConfidence ?? 0) * 100)}%); the rules had it as ${rules.importance}.`);
  }
  return {
    messageId: email.id,
    account: email.account,
    threadId: email.threadId,
    receivedAt: email.receivedAt,
    loggedAt: new Date(ctx.now).toISOString(),
    senderName: sender.name,
    senderAddress: sender.address,
    senderDomain: sender.domain,
    subject: safeSubject(email.subject, otp),
    summary: oneLineSummary(email, otp),
    category: final.category,
    importance: final.importance,
    reason: final.reason,
    rulesCategory: rules.category,
    rulesImportance: rules.importance,
    jevCategory: jev?.category ?? null,
    jevImportance: jev?.importance ?? null,
    jev: jev ? { categoryConfidence: jev.categoryConfidence, importanceConfidence: jev.importanceConfidence, needsReply: jev.needsReply, manipulation: jev.manipulation, probabilities: jev.probabilities } : null,
    jevMs: asked.ms || null,
    jevError: asked.error ?? null,
    relationship: rules.relationship,
    flags: rules.flags,
    wouldAlert: !!basis,
    alertBasis: basis,
    alertReason: why.join(" ").slice(0, 400),
    alertStatus: ctx.backfill && basis ? "backfill" : "",
    mode: ctx.shadowCount < ctx.settings.jev.shadowTarget ? `shadow ${ctx.shadowCount + 1}/${ctx.settings.jev.shadowTarget}` : ctx.settings.jev.mode,
    policyVersion: POLICY_VERSION,
    backfill: ctx.backfill,
  };
}

export type RunOptions = {
  store: TriageStore;
  settings: TriageSettings;
  contacts: Contacts;
  emails: TriageEmail[];
  jevKey: string;
  request?: typeof fetch;
  now?: number;
  /** Log only: nothing alerts (the first run over an existing mailbox, or a shadow replay). */
  backfill?: boolean;
  channels?: Channels;
  concurrency?: number;
};

/** Triage every email not yet in the log, then (unless backfill) hand the alert-worthy ones to dispatch. */
export async function runTriage(options: RunOptions) {
  const now = options.now ?? Date.now();
  const fresh = options.emails.filter((e) => !options.store.has(e.id));
  const rows: TriageRow[] = [];
  let shadowCount = options.store.counts().withJev;
  const queue = [...fresh];
  const worker = async () => {
    for (let email = queue.shift(); email; email = queue.shift()) {
      const row = await triageOne(email, { contacts: options.contacts, settings: options.settings, jevKey: options.jevKey, request: options.request, now, backfill: !!options.backfill, shadowCount });
      if (row.jevCategory) shadowCount++;
      options.store.insert(row);
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 8)) }, worker));
  rows.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  const alerts = options.backfill || !options.channels ? [] : await dispatchAlerts(rows, { store: options.store, settings: options.settings, channels: options.channels, now });
  return { scanned: options.emails.length, logged: rows, alerts };
}

// --- digest --------------------------------------------------------------------------------------
const label = (row: TriageRow) => `${row.senderName} — ${row.subject}`.slice(0, 110);

export function digest(store: TriageStore, now = Date.now(), hours = 24) {
  const rows = store.since(new Date(now - hours * 3_600_000).toISOString(), 1000);
  const count = (importance: Importance) => rows.filter((r) => r.importance === importance).length;
  const by = (importance: Importance) => rows.filter((r) => r.importance === importance);
  const clients = rows.filter((r) => r.category === "client");
  const leads = rows.filter((r) => r.category === "lead-reply");
  const fyi = by("fyi");
  const lines = [
    `Inbox, last ${hours} h: ${rows.length} logged. ${count("urgent")} urgent, ${count("today")} for today, ${fyi.length} FYI, ${count("ignore")} noise.`,
    ...(by("urgent").length ? [`Urgent: ${by("urgent").slice(0, 4).map(label).join("; ")}`] : []),
    ...(clients.length ? [`Clients: ${clients.slice(0, 4).map(label).join("; ")}`] : []),
    ...(leads.length ? [`Lead replies: ${leads.slice(0, 4).map(label).join("; ")}`] : []),
    ...(by("today").filter((r) => r.category !== "client" && r.category !== "lead-reply").length
      ? [`Today: ${by("today").filter((r) => r.category !== "client" && r.category !== "lead-reply").slice(0, 5).map(label).join("; ")}`]
      : []),
    ...(fyi.length ? [`FYI: ${[...new Set(fyi.map((r) => r.senderName))].slice(0, 6).join(", ")}${fyi.length > 6 ? " and more" : ""}`] : []),
  ];
  return { hours, total: rows.length, urgent: count("urgent"), today: count("today"), fyi: fyi.length, ignore: count("ignore"), clients: clients.length, lines };
}

/** Shadow review numbers: how often Jev and the rules agree, and where they don't. */
export function shadowReport(rows: TriageRow[]) {
  const withJev = rows.filter((r) => r.jevCategory && r.jevImportance);
  const agreeCategory = withJev.filter((r) => r.jevCategory === r.rulesCategory).length;
  const agreeImportance = withJev.filter((r) => r.jevImportance === r.rulesImportance).length;
  const disagreements = withJev.filter((r) => r.jevCategory !== r.rulesCategory || r.jevImportance !== r.rulesImportance);
  const jevHigher = withJev.filter((r) => RANK[r.jevImportance!] > RANK[r.rulesImportance]).length;
  const jevLower = withJev.filter((r) => RANK[r.jevImportance!] < RANK[r.rulesImportance]).length;
  return { total: rows.length, withJev: withJev.length, jevErrors: rows.filter((r) => r.jevError).length, agreeCategory, agreeImportance, jevHigher, jevLower, disagreements };
}
