// Inbox triage: the typed schema, secret masking and the deterministic rules.
//
// Rules come first and always win over Jev. They are the floor: a known client is at least
// `today`, a payment failure from a real billing sender is `urgent`, a security alert from one
// of his providers is `urgent` and never auto-actioned. Email text is untrusted data — nothing
// the sender writes can lower what these rules decide (the relationship comes from our own
// records, never from the sender's claim).
//
// Nothing here replies, sends, archives, labels or deletes an email. It only labels a copy of
// the metadata for the owner's own log.

export const CATEGORIES = ["client", "lead-reply", "billing", "vendor-ops", "personal", "newsletter", "spam"] as const;
export type Category = (typeof CATEGORIES)[number];
export const IMPORTANCE = ["urgent", "today", "fyi", "ignore"] as const;
export type Importance = (typeof IMPORTANCE)[number];
export const RANK: Record<Importance, number> = { ignore: 0, fyi: 1, today: 2, urgent: 3 };
export const POLICY_VERSION = "inbox-triage/1";

export const atLeast = (a: Importance, floor: Importance): Importance => (RANK[a] >= RANK[floor] ? a : floor);
export const higher = (a: Importance, b: Importance): Importance => (RANK[a] >= RANK[b] ? a : b);

export type Relationship = "client" | "lead" | "vendor" | "own" | "unknown";

/** What the triage sees of one archived email: metadata and the provider's short snippet. */
export type TriageEmail = {
  id: string;
  account: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  labelIds: string[];
  receivedAt: string;
  direction: "inbound" | "outbound";
};

export type Flags = { client?: string; lead?: string; security?: boolean; payment?: boolean; otp?: boolean; noAutoAction?: boolean; phishingRisk?: boolean };

export type RulesDecision = {
  category: Category;
  importance: Importance;
  /** The lowest importance anything else (Jev, a later mode) may ever give this email. */
  floor: Importance;
  /** A specific rule matched (false = the generic fallback, which Jev may refine in advisory mode). */
  confident: boolean;
  reason: string;
  relationship: Relationship;
  flags: Flags;
};

/** Trusted records: our CRM and client files. Never the email itself. */
export type Contacts = {
  clientAddresses: Map<string, string>;
  clientDomains: Map<string, string>;
  clientThreads: Map<string, string>;
  leadAddresses: Map<string, string>;
  leadDomains: Map<string, string>;
  ownDomains: Set<string>;
};

export const emptyContacts = (): Contacts => ({
  clientAddresses: new Map(),
  clientDomains: new Map(),
  clientThreads: new Map(),
  leadAddresses: new Map(),
  leadDomains: new Map(),
  ownDomains: new Set(["muventures.com.au"]),
});

/** Shared mail hosts: a domain match here means nothing, only the exact address counts. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "live.com.au", "msn.com", "yahoo.com", "yahoo.com.au",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "bigpond.com", "bigpond.net.au", "optusnet.com.au",
  "iinet.net.au", "tpg.com.au", "internode.on.net", "gmx.com", "zoho.com", "fastmail.com", "hey.com",
]);

/**
 * Services he has accounts with. Only a sender on one of these (or a subdomain) can raise a
 * trusted security or payment alarm; the same words from anyone else are treated as possible phishing.
 */
export const KNOWN_PROVIDERS = [
  "google.com", "accounts.google.com", "youtube.com", "microsoft.com", "microsoftonline.com", "apple.com", "github.com", "vercel.com",
  "stripe.com", "link.com", "anthropic.com", "claude.com", "openai.com", "chatgpt.com", "twilio.com", "retellai.com", "elevenlabs.io",
  "pinecone.io", "crazydomains.com.au", "tailscale.com", "nab.com.au", "paypal.com", "paypal.com.au", "facebookmail.com", "meta.com",
  "facebook.com", "instagram.com", "linkedin.com", "cloudflare.com", "notion.so", "granola.ai", "groq.com", "openrouter.ai",
  "typesafe.ai", "amazon.com", "amazon.com.au", "aws.amazon.com", "xero.com", "basiq.io", "interactivebrokers.com", "godaddy.com",
  "namecheap.com", "squarespace.com", "wix.com", "hubspot.com", "calendly.com", "zoom.us", "slack.com", "atlassian.com",
  "ato.gov.au", "abr.gov.au", "asic.gov.au", "mygov.au", "servicesaustralia.gov.au",
];

export function domainMatches(domain: string, list: Iterable<string>) {
  for (const known of list) if (domain === known || domain.endsWith(`.${known}`)) return known;
  return "";
}

/** "Brooke Davis <bianca@x.com.au>" → name + lower-case address + domain. Tolerates odd quoting. */
export function parseSender(from: string) {
  const raw = String(from || "");
  const angled = [...raw.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].pop()?.[1];
  const bare = raw.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  const address = (angled || bare || "").replace(/["']/g, "").toLowerCase();
  const domain = address.split("@")[1]?.replace(/[^a-z0-9.-]/g, "") ?? "";
  // Archived senders come as "Name <addr>" or "Name addr" (the Gmail connector's form): drop the address.
  let name = raw.replace(/<[^>]*>/g, " ").replace(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ").replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!name || name.includes("@")) name = address.split("@")[0] || "unknown sender";
  return { name: name.replace(/\s+/g, " ").slice(0, 60), address, domain };
}

// --- masking --------------------------------------------------------------------------------------
const CODE_PHRASE = /\b(verification code|verify(?:ing)? (?:code|your email with)|one[- ]time (?:pass)?(?:code|password|pin)|\botp\b|passcode|security code|login code|log[- ]in code|sign[- ]?in code|confirmation code|auth(?:entication)? code|2fa|two[- ]factor code|magic link|access code|your code|code is|code:)/i;
const CODE_TOKEN = /\b(?=[A-Z0-9-]*\d)[A-Z0-9]{3,4}-?[A-Z0-9]{3,4}\b|\b\d{4,8}\b/;

/** A one-time code / magic-link email. Its content is never logged or spoken. */
export function isOtpEmail(subject: string, snippet: string) {
  const text = `${subject}\n${snippet}`;
  if (/\b(verification code|one[- ]time (?:pass)?code|\botp\b|passcode|login code|sign[- ]?in code|magic link|security code)\b/i.test(text)) return true;
  if (/\b(promo|discount|coupon|voucher|referral|gift)\b|% off/i.test(text)) return false;
  return (CODE_PHRASE.test(text) || /\bcode\b/i.test(subject)) && CODE_TOKEN.test(text);
}

/** Strip anything credential-shaped from text that will be stored, spoken or sent. */
export function maskSecrets(text: string) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]+/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/\b(password|passcode|pass|pin|pwd|api[ _-]?key|token|secret|otp|code)(\s*(?:is|:|=)\s*)\S+/gi, "$1$2[hidden]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
    .replace(/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{24,}\b/g, "[redacted]")
    .replace(/\b\d{4,8}\b(?=[^.]{0,40}\b(?:code|otp|pin|passcode)\b)/gi, "[hidden]")
    .replace(/\b(?:code|otp|pin|passcode)\b([^.]{0,20}?)\b\d{4,8}\b/gi, (_m, gap) => `code${gap}[hidden]`)
    .replace(/\s+/g, " ")
    .trim();
}

/** Subject as it may be logged: an OTP email's digits and code-like tokens are masked too. */
export function safeSubject(subject: string, otp: boolean) {
  const masked = maskSecrets(subject || "(no subject)");
  const out = otp ? masked.replace(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{3,4}-?[A-Z0-9]{3,4}\b|\b\d{3,}\b/g, "[hidden]") : masked;
  return out.slice(0, 160);
}

/** One line for the log, a DM or speech. Never the body; an OTP email is just its kind. */
export function oneLineSummary(email: Pick<TriageEmail, "subject" | "snippet">, otp: boolean) {
  if (otp) return "verification code email";
  const text = maskSecrets(email.snippet || "");
  if (!text) return "";
  const first = text.split(/(?<=[.!?])\s+/)[0] || text;
  return (first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first).slice(0, 140);
}

// --- rules ----------------------------------------------------------------------------------------
const SECURITY = /\b(new (?:log ?in|sign[- ]?in|device)|did you just (?:log|sign|add)|(?:didn'?t|did not|don'?t) recogni[sz]e|device (?:has been |was )?registered|third[- ]party (?:oauth )?app(?:lication)? (?:has been |was )?(?:added|authori[sz]ed|connected)|trusted device|accounts? cent(?:re|er)|security alert|critical security|new sign[- ]?in|signed in (?:on|from)|sign[- ]?in attempt|login attempt|suspicious|unusual (?:sign|activity|login|log[- ]in)|password (?:was |has been )?(?:changed|reset)|reset your password|2-step|two[- ]factor|2fa (?:was |has been )?(?:disabled|turned off|changed)|new device|account (?:locked|suspended|compromised|disabled)|recovery (?:email|phone) (?:was )?changed|app password|someone (?:has )?(?:tried|signed in)|access (?:was )?(?:granted|revoked|removed)|new (?:api key|access token|ssh key|deploy key) (?:was )?(?:added|created))\b/i;
const PAYMENT_FAIL = /\b(payment (?:has )?(?:failed|declined|unsuccessful|was unsuccessful|could not be processed|was not (?:successful|processed))|card (?:was |has been )?declined|failed payment|(?:could ?n[o']t|unable to|we couldn'?t) (?:process|charge|collect)|charge failed|past due|insufficient funds|dispute(?:d)?|chargeback|payout (?:failed|was returned)|invoice (?:is )?(?:overdue|past due)|subscription (?:will be |has been |was )?(?:suspended|cancel+ed) (?:due to|because)|update (?:your )?(?:payment method|billing details|card))\b/i;
const CLIENT_URGENT = /\b(urgent|asap|emergency|immediately|site (?:is )?down|not working|broken|can'?t (?:access|log ?in|see)|error|complain\w*|refund|cancel\w*|unhappy|disappointed|deadline|today)\b/i;
const ACTION = /\b(action required|action needed|expir(?:es|ing|ed|y)|will be (?:suspended|deleted|disabled|cancel+ed|removed)|final (?:reminder|notice)|verify (?:it'?s you|your (?:account|identity|email|domain))|delivery status notification \(failure\)|undeliverable|could not be delivered|mail delivery failed|address not found|renew(?:al)? (?:now|required|due)|domain .{0,30}expir|quota (?:exceeded|reached)|limit (?:reached|exceeded)|service (?:interruption|suspended))(?![a-z])/i;
const CI_FAIL = /\b((?:run|build|deploy(?:ment)?|workflow|job|check|pipeline) (?:has )?failed|failed (?:run|build|deploy(?:ment)?)|incident|outage|degraded)\b/i;
const BILLING = /\b(invoice|receipt|tax invoice|payment (?:received|confirmation|successful|confirmed)|your (?:bill|statement)|order (?:confirmation|confirmed)|subscription (?:renewed|renewal|confirmed)|payout|refund(?:ed)?|remittance|billing)\b/i;
const PROMO = /(\d+% off|\bdiscount|\bsale\b|\boffer\b|\bdeals?\b|\bwebinar|\bnewsletter|\bunsubscribe|\bis here\b|\bnow (?:generally )?available|\bgenerally available|\bjust landed|\bnew features?|\bintroducing\b|\bwhat'?s new|\btips?\b|\bguide\b|\bfeedback\b|\bsurvey\b|\bevents? happening|\bnew notifications?|\breacted to|\bposted\b|\btop jobs|\bin stock)/i;
const AUTOMATED_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|updates?|news|newsletters?|info|hello|hi|team|support|help|mail|mailer|marketing|community|billing|receipts?|accounts?|security|postmaster|mailer-daemon|welcome|email|comms|service|feedback|invoice|payments?)(?:[-+._].*)?$/i;
const AUTOMATED_SUBDOMAIN = /^(?:e|em|email|emails|mail|mailer|mg|news|newsletter|comms|info|reply|notice|notices|notifications?|marketing|updates|go|link|t|txn|send|bounce)\./i;

export function relationshipOf(email: TriageEmail, contacts: Contacts, sender = parseSender(email.from)) {
  const { address, domain } = sender;
  const freeMail = FREE_MAIL.has(domain);
  const client =
    contacts.clientAddresses.get(address) ||
    (!freeMail && domain ? contacts.clientDomains.get(domain) || [...contacts.clientDomains].find(([d]) => domain.endsWith(`.${d}`))?.[1] : undefined) ||
    contacts.clientThreads.get(email.threadId);
  if (client) return { relationship: "client" as const, name: client };
  if (domain && domainMatches(domain, contacts.ownDomains)) return { relationship: "own" as const, name: "" };
  const lead = contacts.leadAddresses.get(address) || (!freeMail && domain ? contacts.leadDomains.get(domain) : undefined);
  if (lead) return { relationship: "lead" as const, name: lead };
  if (domain && domainMatches(domain, KNOWN_PROVIDERS)) return { relationship: "vendor" as const, name: domainMatches(domain, KNOWN_PROVIDERS) };
  return { relationship: "unknown" as const, name: "" };
}

export function isAutomated(email: TriageEmail, sender = parseSender(email.from)) {
  const local = sender.address.split("@")[0] ?? "";
  return (
    AUTOMATED_LOCAL.test(local) ||
    AUTOMATED_SUBDOMAIN.test(sender.domain) ||
    /\bteam\b|\bnotifications?\b/i.test(sender.name) ||
    email.labelIds.some((l) => ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].includes(l))
  );
}

const decision = (d: Omit<RulesDecision, "floor"> & { floor?: Importance }): RulesDecision => ({ floor: "ignore", ...d, importance: atLeast(d.importance, d.floor ?? "ignore") });

/**
 * The deterministic decision. Order matters: known clients first (nothing can hide them, not even
 * Gmail's spam folder), then his accounts' security and payment alarms, then everything else.
 */
export function classifyByRules(email: TriageEmail, contacts: Contacts, personalAccounts: Set<string> = new Set()): RulesDecision {
  const sender = parseSender(email.from);
  const who = relationshipOf(email, contacts, sender);
  const subject = email.subject || "";
  const text = `${subject}\n${email.snippet || ""}`;
  const otp = isOtpEmail(subject, email.snippet || "");
  const labels = new Set(email.labelIds);
  const spamFolder = labels.has("SPAM");
  const base = { relationship: who.relationship, flags: { ...(otp ? { otp: true } : {}) } as Flags };

  if (who.relationship === "client") {
    const flags: Flags = { ...base.flags, client: who.name };
    if (PAYMENT_FAIL.test(text)) return decision({ ...base, flags: { ...flags, payment: true }, category: "client", importance: "urgent", floor: "today", confident: true, reason: `Known client (${who.name}) and it mentions a payment problem.` });
    const urgent = CLIENT_URGENT.test(subject);
    return decision({
      ...base, flags, category: "client", importance: urgent ? "urgent" : "today", floor: "today", confident: true,
      reason: `Known client (${who.name})${urgent ? "; the subject sounds urgent" : ""}${spamFolder ? "; Gmail put it in spam, but the client record wins" : ""}.`,
    });
  }

  const provider = domainMatches(sender.domain, KNOWN_PROVIDERS);
  const securityish = SECURITY.test(subject) || (!!provider && /\b(security|sign[- ]?in|password|account|log[- ]?in|alert)\b/i.test(subject) && SECURITY.test(text) && !PROMO.test(subject));
  if (securityish) {
    if (provider && !spamFolder)
      return decision({ ...base, flags: { ...base.flags, security: true, noAutoAction: true }, category: "vendor-ops", importance: "urgent", floor: "urgent", confident: true, reason: `Security alert from ${provider} about one of your accounts. Check it in ${provider}'s own app or site, not through a link.` });
    if (!spamFolder && !labels.has("CATEGORY_PROMOTIONS") && !PROMO.test(subject))
      return decision({ ...base, flags: { ...base.flags, security: true, noAutoAction: true, phishingRisk: true }, category: "vendor-ops", importance: "today", floor: "today", confident: true, reason: `Security notice from ${sender.domain || "an unknown sender"}, which isn't on the known-provider list: check that account directly, and don't click its links in case it's phishing.` });
  }

  if (PAYMENT_FAIL.test(text) && !PROMO.test(subject)) {
    if (provider && !spamFolder)
      return decision({ ...base, flags: { ...base.flags, payment: true, noAutoAction: true }, category: "billing", importance: "urgent", floor: "urgent", confident: true, reason: `Payment failure notice from ${provider}.` });
    if (!spamFolder)
      return decision({ ...base, flags: { ...base.flags, payment: true, phishingRisk: true }, category: "billing", importance: "today", floor: "today", confident: true, reason: "Payment-failure wording from an unrecognised sender: check your billing directly, possibly phishing." });
  }

  if (who.relationship === "lead")
    return decision({ ...base, flags: { ...base.flags, lead: who.name }, category: "lead-reply", importance: "today", floor: "today", confident: true, reason: `From a lead in the CRM (${who.name}).` });

  if (spamFolder) return decision({ ...base, category: "spam", importance: "ignore", confident: true, reason: "Gmail filed it as spam and it isn't from a known client." });
  if (labels.has("TRASH")) return decision({ ...base, category: "newsletter", importance: "ignore", confident: true, reason: "Already in the bin." });
  if (otp) return decision({ ...base, category: "vendor-ops", importance: "fyi", confident: true, reason: "One-time code email (content hidden)." });
  if (who.relationship === "own") return decision({ ...base, category: "personal", importance: "fyi", confident: false, reason: "From your own M&U domain." });

  const automated = isAutomated(email, sender);
  if (ACTION.test(subject) && !/\bno action (?:is )?(?:required|needed)\b/i.test(subject) && (automated || provider))
    return decision({ ...base, category: "vendor-ops", importance: "today", confident: true, reason: `A service${provider ? ` (${provider})` : ""} needs an action from you or reports a bounce/expiry.` });
  if (CI_FAIL.test(subject) && automated) return decision({ ...base, category: "vendor-ops", importance: "fyi", confident: true, reason: "Automated build or service failure notice." });
  if (BILLING.test(subject) && !PROMO.test(subject)) return decision({ ...base, category: "billing", importance: "fyi", confident: true, reason: "Invoice, receipt or payment notice." });
  if (labels.has("CATEGORY_PROMOTIONS") || labels.has("CATEGORY_SOCIAL") || (automated && PROMO.test(text)))
    return decision({ ...base, category: "newsletter", importance: "ignore", confident: true, reason: "Marketing, announcement or social notification." });
  if (automated || provider) return decision({ ...base, category: "vendor-ops", importance: "fyi", confident: !!provider, reason: `Automated notice${provider ? ` from ${provider}` : ""}.` });

  const personalMailbox = personalAccounts.has(email.account.toLowerCase());
  return decision({
    ...base, category: "personal", importance: personalMailbox ? "fyi" : "today", confident: false,
    reason: personalMailbox ? "A person writing to your personal mailbox." : "A person you don't have on record writing to the business mailbox.",
  });
}
