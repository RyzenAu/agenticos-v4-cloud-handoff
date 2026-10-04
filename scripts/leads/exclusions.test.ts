import { describe, expect, test } from "bun:test";
import { checkExclusion } from "./exclusions";

describe("exclusions: denylist + name patterns", () => {
  test("excludes government legal aid and community legal services by name", () => {
    expect(checkExclusion({ name: "Legal Aid NSW" })).toMatchObject({ excluded: true });
    expect(checkExclusion({ name: "Aboriginal Legal Service" })).toMatchObject({ excluded: true });
    expect(checkExclusion({ name: "Community Justice Centres" })).toMatchObject({ excluded: true });
  });

  test("excludes known national chains and franchises", () => {
    expect(checkExclusion({ name: "Pacific Smiles Dental" })).toMatchObject({ excluded: true });
    expect(checkExclusion({ name: "Shine Lawyers Parramatta" })).toMatchObject({ excluded: true });
    expect(checkExclusion({ name: "Starr Partners" })).toMatchObject({ excluded: true });
    expect(checkExclusion({ name: "National Criminal Lawyers®" })).toMatchObject({ excluded: true });
  });

  test("a government-pattern or non-profit name not on the explicit denylist is still caught", () => {
    expect(checkExclusion({ name: "Blacktown City Council Legal Services" }).excluded).toBe(true);
    expect(checkExclusion({ name: "Western Sydney Community Legal Centre Inc" }).excluded).toBe(true);
  });

  test("checks OSM operator/brand tags, not just the display name", () => {
    const result = checkExclusion({ name: "Parramatta Branch", brand: "Starr Partners" });
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("Starr Partners");
  });

  test("a small independent practice is never excluded", () => {
    expect(checkExclusion({ name: "St Clair Dental" })).toEqual({ excluded: false, reason: "" });
    expect(checkExclusion({ name: "Mannah Lawyers" })).toEqual({ excluded: false, reason: "" });
    expect(checkExclusion({ name: "Wish Real Estate" })).toEqual({ excluded: false, reason: "" });
    expect(checkExclusion({ name: "AVA Migration Agency" })).toEqual({ excluded: false, reason: "" });
  });
});
