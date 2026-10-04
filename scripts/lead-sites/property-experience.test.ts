import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPreviewDesign } from "./design";
import { NEXT_TEMPLATE_SPECS, pruneExport, pruneSourcePublic } from "./next-templates";
import { listings } from "./overlays/real-estate/src/data/listings";

describe("complete real-estate previews", () => {
  test("old homepage-only previews cannot be generated or deployed as a complete flagship", () => {
    expect(() => assertPreviewDesign("real-estate", "<html><h1>Agency</h1></html>")).toThrow("older version");
    expect(() => assertPreviewDesign("real-estate", '<main data-mu-property-experience="v1"></main>')).toThrow();
    expect(() => assertPreviewDesign("real-estate", '<main data-mu-property-experience="v2"></main>')).toThrow(); // a cache built with the example stock is refused
    expect(() => assertPreviewDesign("real-estate", '<main data-mu-property-experience="v3"></main>')).not.toThrow();
    expect(NEXT_TEMPLATE_SPECS["real-estate"].sourceRevision).toBe("9f374eb");
    for (const route of ["buy", "rent", "sold", "property", "saved", "sell", "property-management", "agents", "suburbs", "insights", "about", "contact"])
      expect(NEXT_TEMPLATE_SPECS["real-estate"].keepApp).toContain(route);
  });
  test("sample inventory covers all browse channels, without borrowing a prospect's identity", () => {
    expect(listings.filter((l) => l.status === "for-sale").length).toBeGreaterThan(0);
    expect(listings.filter((l) => l.status === "for-rent").length).toBeGreaterThan(0);
    expect(listings.filter((l) => l.status === "sold").length).toBeGreaterThan(0);
    expect(new Set(listings.map((l) => l.slug)).size).toBe(listings.length);
    for (const l of listings) {
      expect(l.priceDisplay).toContain("Example");
      expect(l.priceDisplay).not.toContain("$");
      for (const event of l.events) expect(event.note ?? "").not.toContain("$");
      if (l.status !== "withdrawn") expect(l.photos!.length).toBeGreaterThan(0);
    }
  });
  test("the public reference structure stays complete and preview interactions stay local", () => {
    const overlay = join(import.meta.dir, "overlays", "real-estate");
    const page = readFileSync(join(overlay, "src", "app", "page.tsx"), "utf8");
    for (const section of ["heroMedia", "heroStrip", "grid4", "panelSage", "activity", "assistantChat", "AgentCard", "AreaMap", "ArticleLead", "cred", "finalCta"])
      expect(page).toContain(section);
    expect(page).not.toContain("PropertyScene");
    const form = readFileSync(join(overlay, "src", "components", "forms", "EnquiryForm.tsx"), "utf8");
    expect(form).not.toContain("fetch(");
    expect(form).toContain("nothing sent");
    const engine = readFileSync(join(overlay, "src", "lib", "assistant", "engine.ts"), "utf8");
    expect(engine).toContain('name: "Local example walkthrough"');
  });
  test("dynamic desktop AND phone walkthrough frames survive source and export pruning", () => {
    const work = mkdtempSync(join(tmpdir(), "mu-property-frames-"));
    for (const base of ["public", "out"]) {
      for (const relative of ["motion/approach/d/f120.webp", "motion/approach/m/f120.webp", "photos/unused.webp"]) {
        const file = join(work, base, relative);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, "fixture");
      }
    }
    mkdirSync(join(work, "src"));
    const dynamic = 'const frame = (set, i) => `/motion/approach/${set}/f${i}.webp`;';
    writeFileSync(join(work, "src", "frames.ts"), dynamic);
    writeFileSync(join(work, "out", "frames.js"), dynamic);
    pruneSourcePublic(work);
    pruneExport(join(work, "out"));
    for (const base of ["public", "out"]) {
      expect(existsSync(join(work, base, "motion/approach/d/f120.webp"))).toBe(true);
      expect(existsSync(join(work, base, "motion/approach/m/f120.webp"))).toBe(true);
      expect(existsSync(join(work, base, "photos/unused.webp"))).toBe(false);
    }
  });
});
