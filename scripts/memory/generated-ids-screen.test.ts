// Track 8 (28 Sep): a saved fact was sometimes never indexed. The note screen read the fact's random
// block id ("^mf-5f385935bb": 385935) and the footer date ("Saved 2026-09-28") as a BSB and an account
// number whenever the note mentioned an account, and skipped the whole note. Seen as an intermittent
// failure of memory/ui-truth.test.ts (about 1 in 30 saves); this reproduces it deterministically.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenNote } from "./guard";
import { resolveMemorySettings } from "./settings";
import { scanVault, withoutGeneratedIds } from "./vault";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const factNote = (id: string, text: string) => `---
title: Memory Business Shared
type: topic
bucket: business
---

# Memory Business Shared

<!-- memory:begin ${id} -->
## ${text}
<!-- memory:meta {"wiki_ref":"${id}","chain":"${id}","version":1,"bucket":"business","status":"current","created":"2026-09-28T01:01:35.000Z","updated":"2026-09-28T01:01:35.000Z","saved_by":"Usman","origin":{"kind":"voice"},"supersedes":null,"superseded_by":null} -->
${text} ^${id}

*Saved 2026-09-28 by Usman · voice*
<!-- memory:end ${id} -->
`;

function vaultWith(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "t8-generated-ids-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return scanVault(root, resolveMemorySettings({}).sync);
}

describe("the note screen ignores the app's own generated ids", () => {
  const text = "The synthetic Osprey account renews in March.";
  test("the id that tripped it: before the fix the rule matched, now the note is scanned", () => {
    const body = factNote("mf-5f385935bb", text);
    expect(screenNote(body).ok).toBe(false); // the raw note still reads as bank-shaped...
    expect(screenNote(withoutGeneratedIds(body)).ok).toBe(true); // ...the screened text doesn't
    const { notes, skipped } = vaultWith({ "wiki/topics/business/memory-business-shared.md": body });
    expect(skipped).toEqual([]);
    expect(notes.map((n) => n.path)).toEqual(["wiki/topics/business/memory-business-shared.md"]);
  });
  test("real bank details in the same note are still refused", () => {
    const leaked = factNote("mf-5f385935bb", text).replace("*Saved", "BSB 062-000 account 1234 5678\n\n*Saved");
    const { notes, skipped } = vaultWith({ "wiki/topics/business/memory-business-shared.md": leaked });
    expect(notes).toEqual([]);
    expect(skipped).toEqual([{ path: "wiki/topics/business/memory-business-shared.md", reason: "bank-record-shaped content" }]);
  });
  test("only ids in the places the app writes them are replaced (review T8 S-8)", () => {
    const note =
      factNote("mf-5f385935bb", "Kea renews in March.") +
      "Corrects `mf-0123456789`.\nSee [[memory-business-shared#^mf-00000000a1]].\n*Saved 2026-09-28 by Usman · voice · source: mem-0123456789*\n";
    const out = withoutGeneratedIds(note);
    expect(out).not.toMatch(/(?:mf|mem)-[0-9a-f]{10}/);
    expect(out).toContain("<!-- memory:begin id -->");
    expect(out).toContain('"wiki_ref":"id"');
    expect(out).toContain("Kea renews in March. ^id");
    // A hand-written id-shaped token is ordinary text: screened, not blanked.
    const handwritten = "Our account mf-1234567890 renews monthly.";
    expect(withoutGeneratedIds(handwritten)).toBe(handwritten);
    expect(withoutGeneratedIds("mf-062000123456 mf-12345")).toBe("mf-062000123456 mf-12345");
  });
  test("a hand-written note can't slip an account number past the screen inside an id-shaped token", () => {
    const { notes, skipped } = vaultWith({ "wiki/topics/business/handwritten.md": "---\ntitle: Handwritten\n---\n\nBSB mf-0620001234 account mf-1234567890 for the rent.\n" });
    expect(notes).toEqual([]);
    expect(skipped[0]?.reason).toBe("bank-record-shaped content");
  });
});
