// L8 (29 Sep 2026): names, URLs and dates the reader needs must wrap, never be cut with an ellipsis.
// Synthetic data only. Class-level guards plus the display-only title humaniser.
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Widget, WidgetList, WidgetRow } from "../src/components/ds";
import { SitesGlance } from "../src/components/websites/sites-glance";
import { humaniseMemoryTitle, humaniseTarget, isOpaqueId, titleFromBody } from "../src/lib/memory-title";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const NO_CUT = /\btruncate\b|whitespace-nowrap|text-ellipsis/;

describe("widget titles and rows wrap", () => {
  test("a long Widget title is not truncated", () => {
    const out = html(<Widget title="Founders' weekly digest and call coaching for Usman" line="x" />);
    expect(out).toContain("Founders&#x27; weekly digest");
    expect(out).not.toMatch(NO_CUT);
    expect(out).toContain("overflow-wrap:anywhere");
  });
  test("WidgetRow title and meta wrap", () => {
    const out = html(<WidgetList title="Skills"><WidgetRow title="/notebooklm-research" meta="Browser-driven research notebook" /></WidgetList>);
    expect(out).toContain("/notebooklm-research");
    expect(out).not.toMatch(NO_CUT);
  });
});

describe("Websites site cards", () => {
  const site = {
    id: "bianca", name: "Bianca Brown Realty", kind: "client", vertical: "real-estate",
    url: "https://bianca.muventures.com.au", alsoAt: ["https://bianca-preview.muventures.com.au"], deployedAt: null,
  } as never;
  test("name, live URL, preview URL and last deploy are all in the markup and none is truncated", () => {
    const out = html(<SitesGlance sites={[site]} templates={[]} vercel={{ error: null, at: null }} />).replace(/<wbr\/?>/g, "");
    expect(out).toContain("Bianca Brown Realty");
    expect(out).toContain("bianca.muventures.com.au");
    expect(out).toContain("bianca-preview.muventures.com.au");
    expect(out).toContain("Last deploy");
    expect(out).toContain("Open live");
    // The Open live button keeps its own no-wrap; the name, URLs and dates must not.
    expect(out.slice(0, out.indexOf("Open live"))).not.toMatch(/truncate|text-ellipsis/);
    expect(out.slice(0, out.indexOf("mt-auto"))).not.toMatch(NO_CUT);
  });
  test("label and value stack, so a long value cannot run off the card edge", () => {
    const out = html(<SitesGlance sites={[site]} templates={[]} vercel={{ error: null, at: null }} />);
    expect(out).not.toContain("justify-between");
    expect(out).toContain("data-glance-row=\"deploy\"");
  });
  test("source files for the site cards, lead lines and the memory cards carry no cut-off classes on name/URL/date fields", () => {
    expect(src("src/components/websites/sites-glance.tsx")).not.toMatch(NO_CUT);
    const ws = src("src/routes/websites.tsx");
    for (const needle of ["{hostOf(url)}", "{p.domain}", "{site.repo.commit", "{title}</span>", "{s.title}</span>"]) {
      const line = ws.split("\n").find((l) => l.includes(needle)) ?? "";
      expect(line).not.toMatch(NO_CUT);
    }
    const crm = src("src/components/operator/crm-overview.tsx");
    expect(crm.split("\n").filter((l) => /item\.name|u\.name|s\.name/.test(l)).join("\n")).not.toMatch(NO_CUT);
    expect(crm).toContain('data-lead-detail=""');
    expect(crm.split("\n").find((l) => l.includes("data-lead-detail")) ?? "").toContain("line-clamp-2");
  });
});

describe("memory titles (display only)", () => {
  test("snake_case and kebab-case ids read as words", () => {
    expect(humaniseMemoryTitle("feedback_autonomous_when_asked")).toBe("Feedback autonomous when asked");
    expect(humaniseMemoryTitle("jarvis-notes.md")).toBe("Jarvis notes");
    expect(humaniseMemoryTitle("Finance summary (sourced)")).toBe("Finance summary (sourced)");
    expect(humaniseMemoryTitle("Marden-Rowe brief")).toBe("Marden-Rowe brief");
  });
  test("a UUID title falls back to the note's own name, heading, or first words", () => {
    const id = "f97cf22b-c4e5-45c9-831c-0a1b2c3d4e5f";
    expect(isOpaqueId(id)).toBe(true);
    expect(humaniseMemoryTitle(id, "---\nname: dental_pricing_notes\n---\nbody")).toBe("Dental pricing notes");
    expect(humaniseMemoryTitle(id, "# Weekly revenue check\n\nNumbers.")).toBe("Weekly revenue check");
    expect(humaniseMemoryTitle(id, "The client asked for a calmer booking page with fewer steps and clearer prices today")).toBe("The client asked for a calmer booking page…");
    expect(humaniseMemoryTitle(id, "")).toBe("Untitled note");
    expect(humaniseMemoryTitle("", "Hello there")).toBe("Hello there");
  });
  test("list targets show the last path segment as words; URLs and sentences are left alone", () => {
    expect(humaniseTarget("wiki/notes/feedback_autonomous_when_asked.md")).toBe("Feedback autonomous when asked");
    expect(humaniseTarget("https://example.com/a_b")).toBe("https://example.com/a_b");
    expect(humaniseTarget("Recall for the dental site")).toBe("Recall for the dental site");
    expect(humaniseTarget("f97cf22b-c4e5-45c9-831c-0a1b2c3d4e5f")).toBe("f97cf22b-c4e5-45c9-831c-0a1b2c3d4e5f");
  });
  test("titleFromBody never throws on empty or odd input", () => {
    expect(titleFromBody(null)).toBe("");
    expect(titleFromBody("---\nname: x\n---\n")).toBe("x");
  });
});
