// Every form a visitor can open on a generated preview must be completable: a required select with no enabled option can never be submitted,
// and the form then ends in "Please enter ..." on every try (the /contact form shipped like that until round 8's follow-up).
import { describe, expect, test } from "bun:test";
import { preparedRealEstateSource } from "./prepared-source-helper";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXT_TEMPLATE_SPECS, prepareSource } from "./next-templates";
import { site } from "./overlays/real-estate/src/data/site";

describe("the contact form's department choice", () => {
  test("the site data offers at least one real, generic department, and none is a person", () => {
    expect(site.departments.length).toBeGreaterThanOrEqual(2);
    for (const d of site.departments) {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.label).not.toMatch(/imogen|theo|priya|callum|hana|sallis|marchetti|raman|reid|okafor/i);
      expect(d.label).not.toMatch(/\{\{/);
    }
    expect(new Set(site.departments.map((d) => d.label)).size).toBe(site.departments.length);
  });
});

describe("every required select in the prepared source offers an enabled, non-empty option", () => {
  const repo = join("C:", "Users", "Nebula PC", "source", "repos", "aldergate");
  test.skipIf(!existsSync(repo))("real estate: literal option lists are non-empty, and a list taken from site data is non-empty in that data", () => {
    const work = preparedRealEstateSource();
    const files = (readdirSync(join(work, "src"), { recursive: true }) as string[]).filter((p) => /\.tsx$/.test(p));
    let required = 0;
    const problems: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(work, "src", f), "utf8");
      for (const m of src.matchAll(/\{[^{}]*?type:\s*"select"[^{}]*?required:\s*true[^{}]*?options:\s*([^}\n]*?)\s*(?:,\s*\w+:|\})/g)) {
        required++;
        const expr = m[1];
        const literal = /^\[([^\]]*)\]/.exec(expr);
        if (literal) {
          const items = literal[1].split(",").map((s) => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean);
          if (!items.length) problems.push(`${f}: empty literal options`);
        } else if (/site\.departments/.test(expr)) {
          if (!site.departments.length) problems.push(`${f}: options come from site.departments, which is empty`);
        } else problems.push(`${f}: options expression not understood: ${expr.slice(0, 60)}`);
      }
    }
    expect(required).toBeGreaterThanOrEqual(5); // contact, sell (2), management (2), maintenance
    expect(problems).toEqual([]);
  });
});
