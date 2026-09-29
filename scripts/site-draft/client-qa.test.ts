import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditClientClaims,
  auditNoCenterSearchBar,
  auditPalette,
  samplePalette,
  auditRequiredForms,
  auditLinks,
  isSellLikePage,
  runClientQa,
  renderClientQaReport,
  type ClientQaReport,
} from "./client-qa";
import type { ClientFacts } from "./client-evidence";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "client-qa-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function facts(overrides: Partial<ClientFacts> = {}): ClientFacts {
  return {
    clientName: "Bianca Brown Realty",
    allowedNames: ["Brooke Davis", "Zachary Bush"],
    allowedPrices: ["1650", "825", "110", "250"],
    requiredForms: ["appraisal form", "call button", "general enquiry form"],
    hardRules: [],
    palette: { base: ["black"], accents: ["gold"] },
    noCenterSearchBar: true,
    phones: ["0414 574 049"],
    emails: ["bianca@biancabrownrealty.com.au"],
    sources: [{ label: "CLIENT.md", path: "CLIENT.md", extracted: true }],
    ...overrides,
  };
}

describe("auditClientClaims", () => {
  test("passes clean copy that only quotes agreement-sourced prices and names", () => {
    const html = `<html><body><p>Care plan $110/month. Ask Brooke Davis for details.</p></body></html>`;
    expect(auditClientClaims(html, facts())).toEqual([]);
  });

  test("fails a price not in the agreement/CLIENT.md", () => {
    const html = `<html><body><p>1 Erica Road — $1,475,000</p></body></html>`;
    const issues = auditClientClaims(html, facts());
    expect(issues.some((i) => i.severity === "fail" && i.area === "claims" && i.detail.includes("$1,475,000"))).toBe(true);
  });

  test("fails a named person not supplied by the client, found in a team section", () => {
    const html = `<html><body><section id="team"><h2>Meet the team</h2><p>John Smith, lead agent.</p></section></body></html>`;
    const issues = auditClientClaims(html, facts());
    expect(issues.some((i) => i.severity === "fail" && /named person/.test(i.detail) && /John Smith/.test(i.detail))).toBe(true);
  });

  test("does not fail a named person who IS in the allowed list, even in a team section", () => {
    const html = `<html><body><section id="team"><h2>Meet the team</h2><p>Brooke Davis, principal.</p></section></body></html>`;
    expect(auditClientClaims(html, facts())).toEqual([]);
  });

  test("does not flag ordinary capitalised prose outside a team/about/agent section", () => {
    const html = `<html><body><p>Ask Brooke Davis about 1 Erica Road, Wentworth Falls.</p></body></html>`;
    // Brooke Davis is allowed anyway, but the point of this test is that a bare bigram like
    // "Wentworth Falls" or a sentence-initial "Ask Brooke" never even gets scanned outside a
    // person-labelled section, so it can't produce a false-positive "named person" failure.
    expect(auditClientClaims(html, facts()).some((i) => /named person/.test(i.detail))).toBe(false);
  });

  test("fails a star rating, an award claim, a guarantee, before/after and a testimonial", () => {
    const cases = [
      "Rated 5 stars by our clients!",
      "Award-winning local agency.",
      "We guarantee the best price.",
      "See our before and after transformation.",
      `"Best agent ever" - Jane D.`,
    ];
    for (const line of cases) {
      const html = `<html><body><p>${line}</p></body></html>`;
      expect(auditClientClaims(html, facts()).some((i) => i.severity === "fail")).toBe(true);
    }
  });

  test("fails a bare #1 / number one superlative", () => {
    const html = `<html><body><p>The #1 agency in the Blue Mountains.</p></body></html>`;
    expect(auditClientClaims(html, facts()).some((i) => /number one|#1/i.test(i.detail))).toBe(true);
  });
});

describe("auditNoCenterSearchBar", () => {
  test("does nothing when the agreement has no such rule", () => {
    const html = `<header><input type="search"></header>`;
    expect(auditNoCenterSearchBar(html, facts({ noCenterSearchBar: false }))).toEqual([]);
  });

  test("fails a search input inside the header when the rule applies", () => {
    const html = `<header><input type="search" placeholder="Search listings"></header><main></main>`;
    const issues = auditNoCenterSearchBar(html, facts());
    expect(issues.some((i) => i.severity === "fail")).toBe(true);
  });

  test("passes a page with no search input at all", () => {
    const html = `<header><nav><a href="#buy">Buy</a></nav></header><main></main>`;
    expect(auditNoCenterSearchBar(html, facts())).toEqual([]);
  });
});

describe("samplePalette / auditPalette", () => {
  test("classifies black, gold and white correctly", () => {
    const sample = samplePalette("body{background:#090b0d;color:#f5efe6} .accent{color:#c9a227}");
    const families = Object.fromEntries(sample.map((s) => [s.hex, s.family]));
    expect(families["#090b0d"]).toBe("black");
    expect(families["#f5efe6"]).toBe("white");
    expect(families["#c9a227"]).toBe("gold");
  });

  test("passes CSS dominated by black/gold/white", () => {
    const css = "body{background:#090b0d} h1{color:#f5efe6} .btn{background:#c9a227}";
    expect(auditPalette(css, facts())).toEqual([]);
  });

  test("fails CSS dominated by an off-palette colour like bright blue", () => {
    const css = Array(10).fill(".x{color:#1e40ff}").join("\n") + "body{background:#090b0d}";
    const issues = auditPalette(css, facts());
    expect(issues.some((i) => i.severity === "fail")).toBe(true);
  });

  test("does nothing when the agreement specifies no palette", () => {
    expect(auditPalette("body{color:#1e40ff}", facts({ palette: null }))).toEqual([]);
  });
});

describe("auditRequiredForms", () => {
  test("passes when all three Sell-page forms are present", () => {
    const html = `
      <form id="appraisal-form"><input name="name"></form>
      <a class="button" href="tel:0414574049">Call</a>
      <form id="enquiry-form"><textarea name="message"></textarea></form>
    `;
    expect(auditRequiredForms(html, facts())).toEqual([]);
  });

  test("fails when there is no appraisal form", () => {
    const html = `<a class="button" href="tel:0414574049">Call</a><form><textarea name="message"></textarea></form>`;
    const issues = auditRequiredForms(html, facts());
    expect(issues.some((i) => i.severity === "fail" && /appraisal/i.test(i.detail))).toBe(true);
  });

  test("fails when there is no call button", () => {
    const html = `<form id="appraisal-form"></form><form><textarea name="message"></textarea></form>`;
    const issues = auditRequiredForms(html, facts());
    expect(issues.some((i) => i.severity === "fail" && /call button/i.test(i.detail))).toBe(true);
  });

  test("fails when the only form is the appraisal form (this is the real brooke-draft gap)", () => {
    const html = `
      <form id="appraisal-form">
        <input name="name"><input name="phone"><input name="email"><input name="address">
      </form>
      <a class="button button-gold" href="tel:0414574049">Call 0414 574 049</a>
    `;
    const issues = auditRequiredForms(html, facts());
    expect(issues.some((i) => i.severity === "fail" && /general enquiry form/i.test(i.detail))).toBe(true);
  });
});

describe("isSellLikePage", () => {
  test("recognises a dedicated sell.html/sell/index.html page by path", () => {
    expect(isSellLikePage("<body></body>", "sell.html")).toBe(true);
    expect(isSellLikePage("<body></body>", "sell/index.html")).toBe(true);
  });

  test("recognises a single-page site's #selling section by class/id", () => {
    expect(isSellLikePage(`<section id="selling" class="selling">...</section>`, "index.html")).toBe(true);
  });

  test("does NOT treat the Home page as the Sell page just because it embeds a shared appraisal CTA", () => {
    const html = `<body class="page-home"><section id="appraisal" class="appraisal"><form id="appraisal-form"></form></section></body>`;
    expect(isSellLikePage(html, "index.html")).toBe(false);
  });
});

describe("auditLinks", () => {
  test("passes valid tel:/mailto: links and an existing relative asset", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "style.css"), "");
    const html = `<link href="style.css"><a href="tel:0414574049">Call</a><a href="mailto:bianca@biancabrownrealty.com.au">Email</a>`;
    expect(auditLinks(html, dir, facts())).toEqual([]);
  });

  test("fails a relative link that doesn't resolve to a file", () => {
    const dir = tempDir();
    const html = `<a href="missing.html">Missing</a>`;
    const issues = auditLinks(html, dir, facts());
    expect(issues.some((i) => i.severity === "fail" && /Broken link/.test(i.detail))).toBe(true);
  });

  test("fails a malformed tel: link", () => {
    const html = `<a href="tel:call-me-maybe">Call</a>`;
    const issues = auditLinks(html, tempDir(), facts());
    expect(issues.some((i) => i.severity === "fail" && /Malformed tel/.test(i.detail))).toBe(true);
  });

  test("fails a malformed mailto: link", () => {
    const html = `<a href="mailto:not-an-email">Email</a>`;
    const issues = auditLinks(html, tempDir(), facts());
    expect(issues.some((i) => i.severity === "fail" && /Malformed mailto/.test(i.detail))).toBe(true);
  });
});

describe("runClientQa (browser/lighthouse skipped)", () => {
  test("a clean build with full evidence is READY", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body class="page-sell">
        <header><nav><a href="#buy">Buy</a></nav></header>
        <form id="appraisal-form"><input name="name"></form>
        <form id="enquiry-form"><textarea name="message"></textarea></form>
        <a class="button" href="tel:0414574049">Call 0414 574 049</a>
        <p>Care plan $110/month. Ask Brooke Davis.</p>
      </body></html>`,
    );
    writeFileSync(join(dir, "style.css"), "body{background:#090b0d;color:#f5efe6} .btn{background:#c9a227}");

    const report = await runClientQa(dir, {
      skipBrowser: true,
      skipLighthouse: true,
      evidenceOverride: {
        generatedAt: new Date().toISOString(),
        buildDir: dir,
        projectRoot: dir,
        facts: facts(),
        listingText: [],
      },
    });

    expect(report.verdict).toBe("READY");
    expect(report.issues.filter((i) => i.severity === "fail")).toEqual([]);
  });

  test("an unsourced claim and a missing enquiry form make the build NOT READY", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body class="page-sell">
        <form id="appraisal-form"><input name="name"></form>
        <a class="button" href="tel:0414574049">Call</a>
        <p>1 Erica Road — $1,475,000. Rated 5 stars!</p>
      </body></html>`,
    );
    writeFileSync(join(dir, "style.css"), "body{background:#090b0d}");

    const report: ClientQaReport = await runClientQa(dir, {
      skipBrowser: true,
      skipLighthouse: true,
      evidenceOverride: {
        generatedAt: new Date().toISOString(),
        buildDir: dir,
        projectRoot: dir,
        facts: facts(),
        listingText: [],
      },
    });

    expect(report.verdict).toBe("NOT READY");
    expect(report.issues.some((i) => i.area === "claims" && i.severity === "fail")).toBe(true);
    expect(report.issues.some((i) => i.area === "forms" && /general enquiry/i.test(i.detail))).toBe(true);
    const md = renderClientQaReport(report);
    expect(md).toContain("NOT READY");
    expect(md).toContain("claims");
  });

  test("missing CLIENT.md evidence alone is enough to block READY", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<!doctype html><html><body><p>Hello.</p></body></html>`);
    const report = await runClientQa(dir, {
      skipBrowser: true,
      skipLighthouse: true,
      evidenceOverride: {
        generatedAt: new Date().toISOString(),
        buildDir: dir,
        projectRoot: null,
        facts: facts({ sources: [{ label: "CLIENT.md", path: "(not found)", extracted: false, note: "missing" }] }),
        listingText: [],
      },
    });
    expect(report.verdict).toBe("NOT READY");
    expect(report.issues.some((i) => i.area === "evidence" && i.severity === "fail")).toBe(true);
  });
});
