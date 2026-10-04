// Task 6 of MINISTRY-BACKLOG-2026-09-24.md: evidence gathering for a PAID CLIENT build, as
// distinct from evidence.ts (which gathers evidence for a CRM prospect draft from the lead row
// + a robots-checked scrape of the lead's own site). A client build has no CRM scrape step —
// its evidence is the paperwork the client and founder already exchanged:
//   1. the signed agreement (client-content/agreement/*.pdf) — scope, price, hard design rules;
//   2. the client-supplied listing/copy content (client-content/<listing>/*.docx + photos);
//   3. CLIENT.md at the project root — the founder's own running, human-authored summary of both,
//      per the "three-level memory system" convention already used across every M&U project.
// Nothing here invents a fact: every allowed name/price/rule comes from one of these three
// places, and a fact that can't be traced to one of them is left out of the "allowed" lists so
// client-qa.ts's claims audit fails on it rather than silently accepting it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

export type EvidenceSource = { label: string; path: string; extracted: boolean; note?: string };

export type ClientFacts = {
  clientName: string | null;
  /** People an on-page mention is allowed to name (agreement signatories, named contacts). */
  allowedNames: string[];
  /** Dollar figures sourced from the agreement, normalised (digits only, e.g. "825", "1650"). */
  allowedPrices: string[];
  /** Required enquiry mechanisms named in the agreement/checklist, lower-cased keywords. */
  requiredForms: string[];
  /** Free-text hard rules pulled from the agreement/CLIENT.md that don't fit a structured field. */
  hardRules: string[];
  /** The agreement's palette instruction, if one was found. */
  palette: { base: string[]; accents: string[] } | null;
  /** Whether the agreement/CLIENT.md explicitly rules out a centred search bar. */
  noCenterSearchBar: boolean;
  phones: string[];
  emails: string[];
  sources: EvidenceSource[];
};

export type ClientEvidence = {
  generatedAt: string;
  buildDir: string;
  projectRoot: string | null;
  facts: ClientFacts;
  /** Extracted listing/copy text, kept verbatim for a human to cross-check claims against. */
  listingText: { file: string; text: string }[];
};

function emptyFacts(): ClientFacts {
  return {
    clientName: null,
    allowedNames: [],
    allowedPrices: [],
    requiredForms: [],
    hardRules: [],
    palette: null,
    noCenterSearchBar: false,
    phones: [],
    emails: [],
    sources: [],
  };
}

function uniq(items: string[]): string[] {
  return [...new Set(items)];
}

// --- DOCX extraction -------------------------------------------------------------------------
// A .docx is a plain ZIP; word/document.xml holds the body text. Rather than add a dependency
// for one file type (this repo's own convention — see qa.ts's header comment on agent-browser
// vs Playwright), this reads the ZIP local file headers directly and inflates the one entry we
// need with node:zlib's raw inflate. Handles the common case (a per-entry Deflate or Store
// method, no encryption, no ZIP64) that every Word/Google Docs export produces; anything else
// (encrypted docs, ZIP64 archives) fails soft and is reported as unreadable rather than thrown.
const LOCAL_FILE_HEADER_SIG = 0x04034b50;

export function extractDocxText(buf: Buffer): string {
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIG) {
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.toString("utf8", nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    if (name === "word/document.xml") {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let xml: Buffer;
      try {
        xml = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      } catch {
        return "";
      }
      return xmlToText(xml.toString("utf8"));
    }
    offset = dataStart + compSize;
  }
  return "";
}

function xmlToText(xml: string): string {
  // Word represents a paragraph break as a </w:p> element; turn those into newlines before
  // stripping tags so extracted text keeps paragraph structure instead of running together.
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// --- PDF extraction ---------------------------------------------------------------------------
// Best-effort only. Handles the common case of a text-based PDF (FlateDecode content streams,
// literal-string Tj/TJ show-text operators) — the case produced by "export to PDF" from a word
// processor or e-signature tool that keeps text as text. A PDF whose pages are scanned/flattened
// images (this is common for a handwritten, then scanned/photographed, signed form) has no text
// operators to find; this returns an empty string rather than guessing, so callers can tell the
// two cases apart and fall back to CLIENT.md's human transcription instead of failing QA on a
// tool limitation.
export function extractPdfText(buf: Buffer): string {
  const latin1 = buf.toString("latin1");
  const streamRe = /(<<[^>]*?>>)\s*stream\r?\n/g;
  let match: RegExpExecArray | null;
  let out = "";
  let guard = 0;
  while ((match = streamRe.exec(latin1)) && guard++ < 2000) {
    const dict = match[1];
    const start = match.index + match[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end === -1) continue;
    const raw = buf.subarray(start, end);
    let content: string | null = null;
    if (/FlateDecode/.test(dict)) {
      try {
        content = inflateSync(raw).toString("latin1");
      } catch {
        content = null;
      }
    } else if (!/\/Filter/.test(dict)) {
      content = raw.toString("latin1");
    }
    if (!content) continue;
    for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) out += decodePdfString(m[1]) + " ";
    for (const arrMatch of content.matchAll(/\[((?:[^[\]\\]|\\.)*)\]\s*TJ/g)) {
      for (const s of arrMatch[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) out += decodePdfString(s[1]) + " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

const PDF_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

function decodePdfString(s: string): string {
  return s.replace(/\\([()\\nrtbf])/g, (_, c: string) => PDF_ESCAPES[c] ?? c);
}

// --- CLIENT.md parsing --------------------------------------------------------------------------
// CLIENT.md is a human/agent-authored running summary (see the three-level memory convention),
// not a fixed schema — this is deliberately keyword- and pattern-driven rather than tied to exact
// headings, so it degrades gracefully on a client file with a slightly different shape instead of
// silently returning nothing.
const COLOUR_WORDS = ["black", "dark yellow", "yellow", "gold", "white", "cream", "navy", "charcoal"];
const BASE_COLOUR_WORDS = new Set(["black", "charcoal", "navy"]);

export function parseClientMd(md: string): ClientFacts {
  const facts = emptyFacts();

  const titleMatch = md.match(/^#\s+(.+?)\s*(?:—|-|\|)/m) ?? md.match(/^#\s+(.+)$/m);
  facts.clientName = titleMatch ? titleMatch[1].trim() : null;

  // Named people: bold proper names anywhere in the doc ("**Jordan Avery**"), which is how this
  // convention already marks the approver/primary contact and anyone "also involved".
  const boldNameRe = /\*\*([A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+){1,3})\*\*/g;
  for (const m of md.matchAll(boldNameRe)) {
    const candidate = m[1].trim();
    // Exclude obvious non-person bold text (money, all-caps entities, headings-as-labels).
    if (/^[A-Z0-9 &.,]+$/.test(candidate)) continue;
    if (/pty ltd|ventures|realty|davis property/i.test(candidate)) continue;
    facts.allowedNames.push(candidate);
  }
  facts.allowedNames = uniq(facts.allowedNames);

  // Prices: every dollar figure named anywhere in the doc is one the site is allowed to quote
  // (deposit, balance, monthly care fee, one-off add-ons). Normalise to digits only so "$1,650"
  // and "1650" compare equal regardless of formatting on the page.
  for (const m of md.matchAll(/\$\s?([\d][\d,]*(?:\.\d+)?)/g)) facts.allowedPrices.push(m[1].replace(/,/g, ""));
  facts.allowedPrices = uniq(facts.allowedPrices);

  // Required enquiry mechanisms — keyword presence rather than exact bullet parsing, since the
  // agreement checklist and CLIENT.md phrase these slightly differently ("appraisal form" vs
  // "Request an appraisal form").
  const formKeywords: [RegExp, string][] = [
    [/appraisal\s*form|request an appraisal/i, "appraisal form"],
    [/call\s*(?:us\s*)?button|call button/i, "call button"],
    [/general\s*enquiry\s*form|enquiry\s*form/i, "general enquiry form"],
  ];
  for (const [re, label] of formKeywords) if (re.test(md)) facts.requiredForms.push(label);
  facts.requiredForms = uniq(facts.requiredForms);

  // Hard design rules with a dedicated structured field: no centred search bar, and the
  // black/dark-yellow/gold/white palette. Anything else under a "Design notes" heading is kept
  // verbatim in hardRules for the report, since it isn't safe to check automatically.
  facts.noCenterSearchBar = /no\s+search\s*bar[^.\n]*(?:middle|centre|center)/i.test(md) || /search\s*bar[^.\n]*(?:middle|centre|center)/i.test(md);

  const paletteMatch = md.match(/black[^.\n]{0,80}?(dark\s*yellow|gold|white)[^.\n]{0,80}/i);
  if (paletteMatch) {
    const segment = paletteMatch[0].toLowerCase();
    const found = COLOUR_WORDS.filter((c) => segment.includes(c));
    if (found.length) {
      facts.palette = {
        base: found.filter((c) => BASE_COLOUR_WORDS.has(c)),
        accents: found.filter((c) => !BASE_COLOUR_WORDS.has(c)),
      };
    }
  }

  const designSection = md.match(/###?\s*Design notes([\s\S]{0,600}?)(?:\n##|\n###|$)/i);
  if (designSection) {
    for (const line of designSection[1].split("\n")) {
      const bullet = line.replace(/^[\s*-]+/, "").trim();
      if (bullet) facts.hardRules.push(bullet);
    }
  }

  for (const m of md.matchAll(/\b(?:\+?61|0)[\d ]{8,12}\d\b/g)) facts.phones.push(m[0].replace(/\s+/g, " ").trim());
  facts.phones = uniq(facts.phones);
  for (const m of md.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) facts.emails.push(m[0].toLowerCase());
  facts.emails = uniq(facts.emails);

  return facts;
}

// --- Discovery + orchestration ------------------------------------------------------------------

/** Walk up from `startDir` looking for a CLIENT.md (the project-root marker for this convention). */
export function findProjectRoot(startDir: string, maxLevels = 6): string | null {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, "CLIENT.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function listFilesRecursive(dir: string, extensions: string[], depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, extensions, depth - 1));
    else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) out.push(full);
  }
  return out;
}

export type GatherClientEvidenceOptions = {
  buildDir: string;
  /** "auto" walks up from buildDir for CLIENT.md; a path uses that file's directory as the project root. */
  evidence?: string;
  now?: Date;
};

export async function gatherClientEvidence(opts: GatherClientEvidenceOptions): Promise<ClientEvidence> {
  const now = opts.now ?? new Date();
  const explicitClientMd = opts.evidence && opts.evidence !== "auto" ? opts.evidence : null;
  const projectRoot = explicitClientMd ? dirname(explicitClientMd) : findProjectRoot(opts.buildDir);

  const facts = emptyFacts();
  const listingText: { file: string; text: string }[] = [];

  const clientMdPath = explicitClientMd ?? (projectRoot ? join(projectRoot, "CLIENT.md") : null);
  if (clientMdPath && existsSync(clientMdPath)) {
    const md = readFileSync(clientMdPath, "utf8");
    Object.assign(facts, parseClientMd(md));
    facts.sources.push({ label: "CLIENT.md", path: clientMdPath, extracted: true });
  } else {
    facts.sources.push({ label: "CLIENT.md", path: clientMdPath ?? "(not found)", extracted: false, note: "No CLIENT.md found — allowed-names/prices/forms lists will be empty, so any claim on the build will fail the audit until it exists." });
  }

  if (projectRoot) {
    const contentDir = join(projectRoot, "client-content");
    for (const pdfPath of listFilesRecursive(join(contentDir, "agreement"), [".pdf"])) {
      const text = extractPdfText(readFileSync(pdfPath));
      if (text) {
        // Cross-check, don't replace: CLIENT.md is the maintained source of truth, but any extra
        // price/keyword found straight in the agreement is folded in too.
        for (const m of text.matchAll(/\$\s?([\d][\d,]*(?:\.\d+)?)/g)) facts.allowedPrices.push(m[1].replace(/,/g, ""));
        facts.allowedPrices = uniq(facts.allowedPrices);
        facts.sources.push({ label: "signed agreement", path: pdfPath, extracted: true });
      } else {
        facts.sources.push({
          label: "signed agreement",
          path: pdfPath,
          extracted: false,
          note: "No text layer found (likely a scanned/handwritten form) — relying on CLIENT.md's transcription of this agreement for hard rules and pricing.",
        });
      }
    }
    for (const docxPath of listFilesRecursive(contentDir, [".docx"])) {
      const buf = readFileSync(docxPath);
      const text = extractDocxText(buf);
      if (text) {
        listingText.push({ file: docxPath, text });
        facts.sources.push({ label: "client-supplied content", path: docxPath, extracted: true });
      } else {
        facts.sources.push({ label: "client-supplied content", path: docxPath, extracted: false, note: "Could not extract text from this .docx (unexpected internal format)." });
      }
    }
  } else {
    facts.sources.push({ label: "client-content", path: "(project root not found)", extracted: false, note: `No CLIENT.md found by walking up from ${opts.buildDir}; pass --evidence <path-to-CLIENT.md> explicitly.` });
  }

  return { generatedAt: now.toISOString(), buildDir: opts.buildDir, projectRoot, facts, listingText };
}
