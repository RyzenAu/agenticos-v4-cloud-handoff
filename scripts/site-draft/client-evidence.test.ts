import { describe, expect, test, afterAll } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDocxText, extractPdfText, parseClientMd, findProjectRoot, gatherClientEvidence } from "./client-evidence";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "client-evidence-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Builds a minimal, valid-enough .docx: a ZIP with one deflated entry, word/document.xml. */
function makeFixtureDocx(bodyText: string): Buffer {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="ns"><w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`;
  const xmlBuf = Buffer.from(xml, "utf8");
  const compressed = deflateRawSync(xmlBuf);
  const name = Buffer.from("word/document.xml", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // method: deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
  localHeader.writeUInt32LE(compressed.length, 18); // compressed size
  localHeader.writeUInt32LE(xmlBuf.length, 22); // uncompressed size
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra length

  return Buffer.concat([localHeader, name, compressed]);
}

/** A minimal, uncompressed single-page PDF with one Tj text-show operator. */
function makeFixturePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];
  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];
  let running = header.length;
  for (const obj of objects) {
    offsets.push(running);
    body += obj + "\n";
    running += obj.length + 1;
  }
  const xrefStart = running;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}

describe("extractDocxText", () => {
  test("reads the body text out of a minimal docx fixture", () => {
    const buf = makeFixtureDocx("Your Own Leura Oasis");
    expect(extractDocxText(buf)).toContain("Your Own Leura Oasis");
  });

  test("returns empty string for a non-docx buffer rather than throwing", () => {
    expect(extractDocxText(Buffer.from("not a zip"))).toBe("");
  });
});

describe("extractPdfText", () => {
  test("reads a Tj-operator text run out of an uncompressed PDF fixture", () => {
    const buf = makeFixturePdf("Hello agreement");
    expect(extractPdfText(buf)).toContain("Hello agreement");
  });

  test("returns empty string for a PDF with no extractable text operators (e.g. a scanned page)", () => {
    const buf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF", "latin1");
    expect(extractPdfText(buf)).toBe("");
  });
});

const CLIENT_MD = `# Bianca Brown Realty — Client Hub
*Last updated: 2026-09-24 · Owner: Usman · Status: ACTIVE BUILD*

## 1 · Who they are

| | |
|---|---|
| Approver / primary contact | **Jordan Avery** — mobile 0491 570 156 |
| Also involved | **Zachary Bush** — Brooke's husband, co-signed the agreement |

## 2 · The deal

- **Total: A$1,650 incl. GST**
  - **A$825 deposit (50%) — paid 22 Sep 2026**
  - **A$825 — due at approved launch**
- **Care plan: $110/month from launch**
- **Export/handover: $250 if requested**

### Scope (from the signed agreement)
- **Sell page**: appraisal form, a call button, a general enquiry form

### Design notes (handwritten on the agreement)
- Black with **dark yellow, gold and white** accents
- **No search bar in the middle**
`;

describe("parseClientMd", () => {
  test("extracts the client name from the H1", () => {
    expect(parseClientMd(CLIENT_MD).clientName).toBe("Bianca Brown Realty");
  });

  test("extracts named people from bolded table entries, not the legal-entity noise", () => {
    const facts = parseClientMd(CLIENT_MD);
    expect(facts.allowedNames).toContain("Jordan Avery");
    expect(facts.allowedNames).toContain("Zachary Bush");
  });

  test("extracts every dollar figure named in the deal section", () => {
    const facts = parseClientMd(CLIENT_MD);
    expect(facts.allowedPrices).toEqual(expect.arrayContaining(["1650", "825", "110", "250"]));
  });

  test("extracts the three required Sell-page forms", () => {
    const facts = parseClientMd(CLIENT_MD);
    expect(facts.requiredForms).toEqual(expect.arrayContaining(["appraisal form", "call button", "general enquiry form"]));
  });

  test("detects the no-centred-search-bar rule", () => {
    expect(parseClientMd(CLIENT_MD).noCenterSearchBar).toBe(true);
  });

  test("extracts the black/dark-yellow/gold/white palette instruction", () => {
    const palette = parseClientMd(CLIENT_MD).palette;
    expect(palette?.base).toContain("black");
    expect(palette?.accents.join(",")).toMatch(/gold|dark yellow|white/);
  });

  test("a CLIENT.md with none of these sections yields empty, not invented, facts", () => {
    const facts = parseClientMd("# Some Other Client\n\nNothing structured here.\n");
    expect(facts.allowedPrices).toEqual([]);
    expect(facts.requiredForms).toEqual([]);
    expect(facts.noCenterSearchBar).toBe(false);
  });
});

describe("findProjectRoot", () => {
  test("walks up from a nested build dir to find CLIENT.md", () => {
    const root = tempDir();
    writeFileSync(join(root, "CLIENT.md"), "# X\n");
    const buildDir = join(root, "brooke-draft", "assets");
    mkdirSync(buildDir, { recursive: true });
    expect(findProjectRoot(buildDir)).toBe(root);
  });

  test("returns null when no CLIENT.md exists within the walk limit", () => {
    const root = tempDir();
    const buildDir = join(root, "nested");
    mkdirSync(buildDir, { recursive: true });
    expect(findProjectRoot(buildDir, 1)).toBe(null);
  });
});

describe("gatherClientEvidence", () => {
  test("auto-discovers CLIENT.md and the agreement/listing content from the build dir", async () => {
    const root = tempDir();
    writeFileSync(join(root, "CLIENT.md"), CLIENT_MD);
    const buildDir = join(root, "brooke-draft");
    mkdirSync(buildDir, { recursive: true });
    const agreementDir = join(root, "client-content", "agreement");
    mkdirSync(agreementDir, { recursive: true });
    writeFileSync(join(agreementDir, "agreement.pdf"), makeFixturePdf("Total including GST $1,650"));
    const listingDir = join(root, "client-content", "74-highland-st-leura");
    mkdirSync(listingDir, { recursive: true });
    writeFileSync(join(listingDir, "copy.docx"), makeFixtureDocx("Your Own Leura Oasis"));

    const evidence = await gatherClientEvidence({ buildDir, evidence: "auto" });
    expect(evidence.projectRoot).toBe(root);
    expect(evidence.facts.allowedNames).toContain("Jordan Avery");
    expect(evidence.facts.sources.some((s) => s.label === "CLIENT.md" && s.extracted)).toBe(true);
    expect(evidence.facts.sources.some((s) => s.label === "signed agreement" && s.extracted)).toBe(true);
    expect(evidence.listingText.some((l) => l.text.includes("Your Own Leura Oasis"))).toBe(true);
  });

  test("a missing CLIENT.md is reported as an unextracted source, not silently ignored", async () => {
    const root = tempDir();
    const buildDir = join(root, "no-client-md");
    mkdirSync(buildDir, { recursive: true });
    const evidence = await gatherClientEvidence({ buildDir, evidence: "auto" });
    expect(evidence.facts.sources.some((s) => s.label === "CLIENT.md" && !s.extracted)).toBe(true);
    expect(evidence.facts.allowedNames).toEqual([]);
  });
});
