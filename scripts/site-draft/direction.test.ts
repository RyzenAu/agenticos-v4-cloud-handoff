import { describe, expect, test } from "bun:test";
import { buildDirection, comboKey, directionsFor, renderDirectionMarkdown, HERO_POOLS, type Direction } from "./direction";

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function everyDirection(vertical: "dental" | "legal" | "real-estate"): Direction[] {
  const out: Direction[] = [];
  const used: string[] = [];
  for (let i = 0; i < 4 * HERO_POOLS[vertical].length; i++) {
    const d = buildDirection({ name: "Palette Probe", area: "Penrith NSW", vertical }, { usedCombos: [...used] });
    used.push(comboKey(d));
    out.push(d);
  }
  return out;
}

describe("buildDirection", () => {
  test("is deterministic for the same lead", () => {
    const lead = { name: "St Clair Dental", area: "Mount Druitt NSW", vertical: "dental" as const };
    expect(buildDirection(lead)).toEqual(buildDirection(lead));
  });

  test("each vertical has at least three directions and every hero composition its bar allows", () => {
    for (const v of ["dental", "legal", "real-estate"] as const) {
      expect(directionsFor(v).length).toBeGreaterThanOrEqual(3);
      const all = everyDirection(v);
      expect(new Set(all.map((d) => d.id)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(all.map((d) => d.hero)).size).toBe(HERO_POOLS[v].length);
      expect(new Set(all.map(comboKey)).size).toBe(all.length);
    }
  });

  test("ten dentists drafted in turn get ten different direction/hero combinations", () => {
    const names = ["St Clair Dental", "St Clair Family Dental", "Marayong Dental Clinic", "Westpoint Dental Clinic", "Kingswood Dental Care", "Emu Plains Dentist Care", "No Gaps Dental", "Cranebrook Dental", "Penrith Dental Clinic", "High Street Dental"];
    const usedCombos: string[] = [];
    const usedHeroes: Direction["hero"][] = [];
    for (const name of names) {
      const d = buildDirection({ name, area: "Penrith NSW", vertical: "dental" }, { usedCombos: [...usedCombos], usedHeroes: [...usedHeroes] });
      usedCombos.push(comboKey(d));
      usedHeroes.push(d.hero);
    }
    expect(new Set(usedCombos).size).toBe(10);
    // Hero compositions are spread, not piled onto one.
    for (const h of ["cinema", "window", "frame"] as const) expect(usedHeroes.filter((x) => x === h).length).toBeGreaterThanOrEqual(3);
  });

  test("stays within its vertical's directions", () => {
    const d = buildDirection({ name: "Any Dentist", area: "Penrith NSW", vertical: "dental" });
    expect(directionsFor("dental").map((x) => x.id)).toContain(d.id);
  });

  test("every palette passes WCAG AA for body text, secondary text and text on the accent", () => {
    for (const v of ["dental", "legal", "real-estate"] as const) {
      for (const d of everyDirection(v)) {
        const p = d.palette;
        expect(contrast(p.ink, p.paper)).toBeGreaterThanOrEqual(7);
        expect(contrast(p.muted, p.paper)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.ink, p.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.accentInk, p.accent)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("every draft plans four distinct, people-free, text-free stills and a film from the first", () => {
    for (const v of ["dental", "legal", "real-estate"] as const) {
      for (const d of everyDirection(v)) {
        const shots = [d.imagePlan["hero-wide"], d.imagePlan["hero-close"], d.imagePlan.section, d.imagePlan.detail];
        expect(new Set(shots.map((x) => x.prompt)).size).toBe(4);
        for (const x of shots) {
          expect(x.prompt).toMatch(/empty of people/);
          expect(x.prompt).toMatch(/No text/);
          expect(x.prompt.toLowerCase()).not.toMatch(/\b(patient|dentist|lawyer|woman|man|person|smil)/);
        }
        expect(d.imagePlan["hero-wide"].aspect).toBe(d.hero === "frame" ? "3:4" : "16:9");
        expect(d.imagePlan.film.prompt).toMatch(/empty of people/);
      }
    }
  });

  test("legal and real-estate never get the boxed frame hero their bars rejected", () => {
    for (const v of ["legal", "real-estate"] as const) for (const d of everyDirection(v)) expect(d.hero).not.toBe("frame");
  });

  test("markdown never mentions photography of people", () => {
    const lead = { name: "Test Lawyers", area: "Parramatta NSW", vertical: "legal" as const };
    const md = renderDirectionMarkdown(lead, buildDirection(lead));
    expect(md.toLowerCase()).not.toMatch(/photo of (a |the )?(person|staff|patient)/);
    expect(md).toMatch(/No photography of people/);
  });
});
