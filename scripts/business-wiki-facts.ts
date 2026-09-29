// M&U facts from the M&U Ventures Obsidian wiki, for the Business brief and Goals pages.
//
// GET /__operator/business/wiki-facts reads a SHORT, allow-listed set of wiki pages (never raw/)
// and pulls out durable facts: the shared long-term goals, the monthly revenue target, the
// business's one-line position and each real client's deal. Read-only, never cached to disk.
//
// Privacy: the owner and partner pages hold phone numbers, emails and a home address. Those pages
// are NOT read here; client pages are read for their deal paragraph only, and any line that looks
// like contact data (phone, email, street address, ABN) is dropped before anything is returned.
//
// Honesty: every fact carries the wiki page it came from and that page's `updated:` date. A value
// the page doesn't state in the expected form is null, never guessed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Pages read, relative to the vault root. Nothing else in the vault is opened. */
export const WIKI_FACT_PAGES = {
  goals: "wiki/topics/personal/shared-goals.md",
  business: "wiki/entities/mu-ventures.md",
  clients: "wiki/topics/business/clients.md",
} as const;
/** Client entity pages live here; only slugs linked from the clients hub are opened. */
const ENTITY_DIR = "wiki/entities";

export type WikiSource = { page: string; updated: string | null };
export type WikiGoal = { title: string; detail: string | null; kind: "business" | "deen" | "personal"; source: WikiSource };
export type WikiClientDeal = {
  totalAud: number | null;
  depositAud: number | null;
  depositPaidOn: string | null;
  balanceAud: number | null;
  carePlanMonthlyAud: number | null;
  targetLaunch: string | null;
  signedOn: string | null;
};
export type WikiClient = { slug: string; name: string; summary: string | null; deal: WikiClientDeal; source: WikiSource };
export type WikiFacts = {
  /** False when the vault (or its wiki/ folder) isn't where the settings point. */
  found: boolean;
  /** The vault folder name only (never the full path). */
  vault: string;
  readAt: string;
  goals: WikiGoal[];
  revenueTarget: { monthly: number; text: string; source: WikiSource } | null;
  business: { name: string; position: string | null; source: WikiSource } | null;
  clients: WikiClient[];
  /** Pages that were expected but missing or unreadable, so the page can say which. */
  missing: string[];
};

const CONTACT_LIKE = /(@|\b0[2-9]\d{2}\s?\d{3}\s?\d{3}\b|\b04\d{2}\s?\d{3}\s?\d{3}\b|\+61|\bABN\b|\bACN\b|\bStreet\b|\bSt\b\s*,|\bRoad\b|\bRd\b\s*,|\bAvenue\b|\bNSW \d{4}\b)/i;

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function body(md: string) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Plain text: wiki links become their label, bold/italics are dropped. */
export function plain(text: string) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, slug: string) => titleFromSlug(slug))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromSlug(slug: string) {
  const special: Record<string, string> = { "mu-ventures": "M&U Ventures", usman: "Usman", mehroz: "Mehroz" };
  return special[slug] ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The paragraph(s) under `## heading`, up to the next heading. */
export function section(md: string, heading: RegExp): string | null {
  const lines = body(md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && heading.test(l.replace(/^##\s+/, "")));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s+/.test(l));
  const text = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return text || null;
}

function money(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /([\d,.]+)\s*(k)?/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] ? n * 1000 : n;
}

function goalKind(text: string): WikiGoal["kind"] {
  if (/quran|allah|deen|prayer|salah|worship|faith|itqan/i.test(text)) return "deen";
  if (/\$|revenue|month|client|business|ventures|sales/i.test(text)) return "business";
  return "personal";
}

/** Bullets like "- **Title.** Detail" from the goals page. */
export function parseGoals(md: string, source: WikiSource): WikiGoal[] {
  const out: WikiGoal[] = [];
  for (const line of body(md).split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (!m) continue;
    const title = plain(m[1]).replace(/[.,;:]\s*$/, "");
    if (!title) continue;
    const detail = plain(m[2]).replace(/^[,.;:]\s*/, "") || null;
    out.push({ title, detail, kind: goalKind(`${title} ${detail ?? ""}`), source });
  }
  return out;
}

/** "$100k/month" anywhere on the page (the goals page first, then the business page). */
export function parseRevenueTarget(md: string, source: WikiSource): WikiFacts["revenueTarget"] {
  const m = /\$\s?([\d,.]+\s*k?)\s*\/\s*month/i.exec(body(md));
  const monthly = money(m?.[1]);
  return m && monthly ? { monthly, text: `A$${m[1].replace(/\s+/g, "")}/month`, source } : null;
}

/** "## Where it stands (…)" on the business page, first paragraph, plain text. */
export function parseBusiness(md: string, source: WikiSource): WikiFacts["business"] {
  const fm = frontmatter(md);
  const stands = section(md, /where it stands|current position/i);
  const first = stands?.split(/\r?\n\s*\r?\n/)[0] ?? null;
  return { name: fm.title || "M&U Ventures", position: first ? plain(first) : null, source };
}

/** Slugs linked under "## The pieces" (or any bullet list of [[links]]) on the clients hub. */
export function parseClientSlugs(md: string): string[] {
  const pieces = section(md, /pieces|clients/i) ?? body(md);
  const slugs: string[] = [];
  for (const line of pieces.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/i.exec(line);
    if (m && !slugs.includes(m[1])) slugs.push(m[1]);
  }
  return slugs;
}

/** A client entity page: its title, the bold first sentence and the deal figures. Contact-like lines are dropped. */
export function parseClient(slug: string, md: string, source: WikiSource): WikiClient {
  const fm = frontmatter(md);
  const safe = (text: string | null) =>
    text
      ? text
          .split(/\r?\n/)
          .filter((l) => !CONTACT_LIKE.test(l))
          .join("\n")
      : null;
  const intro = safe(body(md).split(/\r?\n\s*\r?\n/).find((p) => p.trim() && !/^#/.test(p.trim())) ?? null);
  const summaryMatch = intro ? /\*\*([^*]+)\*\*/.exec(intro) : null;
  const deal = safe(section(md, /deal/i)) ?? "";
  const flat = deal.replace(/\s+/g, " ");
  const num = (re: RegExp) => money(re.exec(flat)?.[1]);
  const text = (re: RegExp) => {
    const m = re.exec(flat);
    return m ? plain(m[1]).replace(/^~/, "").trim() : null;
  };
  return {
    slug,
    name: fm.title || titleFromSlug(slug),
    summary: summaryMatch ? plain(summaryMatch[1]).replace(/[.]\s*$/, "") : null,
    deal: {
      totalAud: num(/A\$\s?([\d,.]+)[^:;()]{0,40}?\btotal\b/i),
      depositAud: num(/deposit\s*\(?\**\s*A\$\s?([\d,.]+)/i),
      depositPaidOn: text(/deposit\s*\(?\**\s*A\$\s?[\d,.]+,?\s*paid\s+([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i),
      balanceAud: num(/A\$\s?([\d,.]+)\s+due\b/i),
      carePlanMonthlyAud: num(/care plan of\s+A?\$\s?([\d,.]+)\s*\/\s*month/i),
      targetLaunch: text(/target launch is\s+\**\s*(~?[0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i),
      signedOn: text(/signed agreement dated\s+\**\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i),
    },
    source,
  };
}

type Reader = (rel: string) => string | null;

/** Pure: facts from a page reader. `read` returns null for a missing page. */
export function wikiFactsFrom(read: Reader, vault: string, found: boolean, now = new Date()): WikiFacts {
  const missing: string[] = [];
  const page = (rel: string) => {
    const md = read(rel);
    if (md === null) missing.push(rel);
    return md;
  };
  const src = (rel: string, md: string): WikiSource => ({ page: rel, updated: frontmatter(md).updated || frontmatter(md).created || null });
  const goalsMd = found ? page(WIKI_FACT_PAGES.goals) : null;
  const businessMd = found ? page(WIKI_FACT_PAGES.business) : null;
  const clientsMd = found ? page(WIKI_FACT_PAGES.clients) : null;
  const goals = goalsMd ? parseGoals(goalsMd, src(WIKI_FACT_PAGES.goals, goalsMd)) : [];
  const revenueTarget =
    (goalsMd && parseRevenueTarget(goalsMd, src(WIKI_FACT_PAGES.goals, goalsMd))) ||
    (businessMd && parseRevenueTarget(businessMd, src(WIKI_FACT_PAGES.business, businessMd))) ||
    null;
  const clients: WikiClient[] = [];
  if (clientsMd) {
    for (const slug of parseClientSlugs(clientsMd).slice(0, 12)) {
      const rel = `${ENTITY_DIR}/${slug}.md`;
      const md = page(rel);
      if (md) clients.push(parseClient(slug, md, src(rel, md)));
    }
  }
  return {
    found,
    vault,
    readAt: now.toISOString(),
    goals,
    revenueTarget,
    business: businessMd ? parseBusiness(businessMd, src(WIKI_FACT_PAGES.business, businessMd)) : null,
    clients,
    missing: found ? missing : [],
  };
}

/** Read the facts from a vault on disk (the folder that holds wiki/). */
export function readWikiFacts(vaultRoot: string, now = new Date()): WikiFacts {
  const vault = vaultRoot.split(/[\\/]/).filter(Boolean).pop() || "vault";
  let found = false;
  try {
    found = existsSync(join(vaultRoot, "wiki")) && statSync(join(vaultRoot, "wiki")).isDirectory();
  } catch {
    found = false;
  }
  const read: Reader = (rel) => {
    // Only the allow-listed pages and linked entity slugs reach here; refuse anything else.
    if (!/^wiki\/(topics|entities)\/[a-z0-9/-]+\.md$/i.test(rel) || rel.includes("..")) return null;
    try {
      return readFileSync(join(vaultRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  return wikiFactsFrom(read, vault, found, now);
}
