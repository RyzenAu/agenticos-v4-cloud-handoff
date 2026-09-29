import { describe, expect, test } from "bun:test";
import { renderSite, displayPhone, addressParts, relockCopy, RUNTIME_JS } from "./render";
import { buildDirection, comboKey, HERO_POOLS, type Direction } from "./direction";
import { auditClaims, auditAssetReuse, assetKey } from "./qa";
import { scaffoldGuards } from "./orchestrator";
import type { Evidence } from "./evidence";
import type { ImageryMedia, ImageSet } from "./imagery";

const at = "2026-09-24T00:00:00.000Z";
function evidence(vertical: Evidence["vertical"], opts: { phone?: string; services?: string[] } = {}): Evidence {
  const src = "https://www.openstreetmap.org/node/1";
  const f = (field: string, value: string, category: "business" | "contact" | "location" = "business") => ({ category, field, value, sourceUrl: src, sourceLabel: "OpenStreetMap", observedAt: at, status: value ? ("verified" as const) : ("missing" as const) });
  return {
    leadId: 1,
    name: "Test Business",
    vertical,
    area: "Mount Druitt NSW",
    generatedAt: at,
    facts: [f("name", "Test Business"), f("suburb", "Mount Druitt", "location"), f("address", "162 Bennett Road, St Clair NSW 2759", "location"), f("phone", opts.phone ?? "", "contact")],
    services: (opts.services ?? []).map((value) => ({ category: "service" as const, field: "service", value, sourceUrl: "https://example.com.au/services", sourceLabel: "Business's own website", observedAt: at, status: "verified" as const })),
    hasOwnWebsite: Boolean(opts.services?.length),
    ownSiteReachable: Boolean(opts.services?.length),
    robotsBlocked: false,
    complianceNotes: ["AHPRA advertising rules apply: no patient testimonials, no before/after photos, no claims implying a guaranteed clinical outcome.", "No outcome guarantees or 'best/leading' superlatives that aren't independently verifiable."],
  };
}
function directionsFor(vertical: Evidence["vertical"]): Direction[] {
  const used: string[] = [];
  const out: Direction[] = [];
  for (let i = 0; i < 4 * HERO_POOLS[vertical].length; i++) {
    const d = buildDirection({ name: "Render Probe", area: "Penrith NSW", vertical }, { usedCombos: [...used] });
    used.push(comboKey(d));
    out.push(d);
  }
  return out;
}
const set = (key: ImageSet["key"], mobile = false): ImageSet => ({
  key,
  sizes: [960, 1600, 2400].map((w) => ({ w, path: `assets/img/${key}-${w}.webp` })),
  mobile: mobile ? `assets/img/${key}-m.webp` : undefined,
  width: 2816,
  height: 1584,
});
const media: ImageryMedia = {
  heroWide: set("hero-wide", true),
  heroClose: set("hero-close", true),
  section: set("section"),
  detail: set("detail"),
  film: { mp4: "assets/film.mp4", width: 1600, height: 900, duration: 6, approved: true, note: "" },
};

describe("helpers", () => {
  test("formats Australian numbers the local way", () => {
    expect(displayPhone("+61 2 9670 3195")).toBe("02 9670 3195");
    expect(displayPhone("+61412345678")).toBe("0412 345 678");
  });
  test("splits street and locality from an address", () => {
    expect(addressParts("162 Bennett Road, St Clair NSW 2759", "Mount Druitt")).toEqual({ street: "162 Bennett Road", streetName: "Bennett Road", locality: "St Clair" });
    expect(addressParts("", "Parramatta").locality).toBe("Parramatta");
  });
  test("renditions of one image share an asset key", () => {
    expect(assetKey("assets/img/hero-wide-960.webp")).toBe("hero-wide");
    expect(assetKey("assets/img/hero-wide-m.webp")).toBe("hero-wide");
    expect(assetKey("assets/img/hero-close-2400.webp")).toBe("hero-close");
  });
});

describe("renderSite", () => {
  for (const vertical of ["dental", "legal", "real-estate"] as const) {
    test(`${vertical}: every direction and hero renders a guarded, claim-free page that uses each image once`, () => {
      for (const d of directionsFor(vertical)) {
        for (const m of [media, undefined]) {
          const ev = evidence(vertical, { phone: vertical === "legal" ? "" : "+61 2 9670 3195" });
          const html = renderSite({ evidence: ev, direction: d, media: m, fallbackArt: "assets/hero.svg" });
          expect(scaffoldGuards(html, ev, html)).toEqual([]);
          expect(auditClaims(html, ev).filter((i) => i.severity === "fail")).toEqual([]);
          expect(auditAssetReuse(html)).toEqual([]);
          expect(html).toContain("INTERNAL DRAFT — not for distribution");
          expect(html).toContain(`data-hero="${d.hero}"`);
          expect(html).toMatch(/prefers-reduced-motion: reduce/);
          expect(html).toMatch(/<h1 class="display" data-lock="h1">[^<]+<\/h1>/);
          // No third-party scripts; fonts fall back to Google only when self-hosting failed.
          const hosts = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"'/]+)/gi)].map((x) => x[1]);
          for (const h of hosts) expect(h).toMatch(/fonts\.(googleapis|gstatic)\.com|openstreetmap\.org|example\.com\.au/);
          expect(html).not.toMatch(/gsap|lenis/i);
        }
      }
    });
  }

  test("with media, all four stills and the film appear, each exactly once", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const html = renderSite({ evidence: evidence("dental", { phone: "+61 2 9670 3195" }), direction: d, media });
    for (const key of ["hero-wide", "hero-close", "section", "detail"]) expect(html).toContain(`assets/img/${key}-1600.webp`);
    expect(html.match(/data-src="assets\/film.mp4"/g)?.length).toBe(1);
  });

  test("the reuse audit fails a page that shows the same image twice", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const html = renderSite({ evidence: evidence("dental", { phone: "+61 2 9670 3195" }), direction: d, media });
    const doubled = html.replace("</main>", '<img src="assets/img/section-720.webp" alt=""></main>');
    const issues = auditAssetReuse(doubled);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toMatch(/"section" is used 2 times/);
    // The logo is exempt.
    expect(auditAssetReuse(html.replace("</main>", '<img src="assets/img/logo.svg" alt=""><img src="assets/img/logo.svg" alt=""></main>'))).toEqual([]);
  });

  test("a variable font shared by several @font-face weights is not an image reuse", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const html = renderSite({ evidence: evidence("dental", { phone: "+61 2 9670 3195" }), direction: d, media });
    const font = "@font-face { src: url(assets/fonts/c45101e86e.woff2) format('woff2'); }";
    const withFonts = html.replace("</head>", `<style>${font}${font}${font}</style></head>`);
    expect(auditAssetReuse(withFonts)).toEqual([]);
  });

  test("unevidenced services are visibly labelled placeholders; evidenced ones link their source", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const none = renderSite({ evidence: evidence("dental", { phone: "+61 2 9670 3195" }), direction: d, media });
    expect(none).toContain('<p class="svc-label">Placeholder list</p>');
    expect((none.match(/svc--placeholder/g) ?? []).length).toBe(4);
    const some = renderSite({ evidence: evidence("dental", { phone: "+61 2 9670 3195", services: ["General dentistry"] }), direction: d, media });
    expect(some).toContain("General dentistry");
    expect(some).toContain('href="https://example.com.au/services"');
    expect(some).not.toContain("Placeholder list");
  });

  test("no phone: no tel: link, no invented number", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "legal" });
    const html = renderSite({ evidence: evidence("legal"), direction: d, media });
    expect(html).not.toContain("tel:");
    expect(html).toContain("Phone number to confirm with the firm.");
  });

  test("the film is lazy, poster-first, and only rendered when approved", () => {
    const d = buildDirection({ name: "X", area: "Y", vertical: "real-estate" });
    const html = renderSite({ evidence: evidence("real-estate", { phone: "+61 2 8664 3200" }), direction: d, media });
    expect(html).toMatch(/<video class="layer layer-film" data-film data-src="assets\/film.mp4" muted playsinline preload="none"/);
    expect(html).not.toMatch(/<source[^>]+\.mp4/);
    expect(html).toMatch(/fetchpriority="high"/);
    const rejected = renderSite({ evidence: evidence("real-estate", { phone: "+61 2 8664 3200" }), direction: d, media: { ...media, film: { ...media.film!, approved: false } } });
    expect(rejected).not.toContain("data-film");
  });

  test("the runtime is library-free, gated on motion, and never shows the film on phones or Save-Data", () => {
    expect(RUNTIME_JS).toContain("if (!motion) return;");
    expect(RUNTIME_JS).toContain("conn.saveData");
    expect(RUNTIME_JS).toContain('matchMedia("(min-width: 900px)")');
    expect(RUNTIME_JS).not.toContain("`");
    expect(RUNTIME_JS).not.toMatch(/gsap|Lenis/);
  });
});

describe("locked copy", () => {
  const ev = evidence("dental", { phone: "+61 2 9670 3195" });
  const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
  const scaffold = renderSite({ evidence: ev, direction: d, media });

  test("the dental headline speaks to the visitor, not the address", () => {
    expect(scaffold).toContain(">Book the check‑up you&#39;ve been putting off.</h1>");
  });

  test("a refine pass that swaps the headline for an address gets the art-directed headline back", () => {
    const refined = scaffold
      .replace(/(<h1 class="display" data-lock="h1">)[^<]+(<\/h1>)/, "$1Dental care on Bennett Road, St Clair.$2")
      .replace("font-size: clamp(2.9rem", "font-size: clamp(3.1rem");
    const { html, changed, missing } = relockCopy(refined, scaffold);
    expect(changed).toEqual(["h1"]);
    expect(missing).toEqual([]);
    expect(html).toContain(">Book the check‑up you&#39;ve been putting off.</h1>");
    expect(html).not.toContain("Dental care on Bennett Road, St Clair.");
    // The refine's other polish survives.
    expect(html).toContain("font-size: clamp(3.1rem");
  });

  test("a refine pass that deletes a locked element fails the guards", () => {
    const refined = scaffold.replace(/<p class="lede" data-lock="lede">[^<]+<\/p>/, "");
    expect(relockCopy(refined, scaffold).missing).toEqual(["lede"]);
    expect(scaffoldGuards(refined, ev, scaffold)).toContain("locked copy (lede)");
  });
});

describe("scaffoldGuards", () => {
  test("flags a refine pass that drops the banner, the tool or a tel link, or adds a claim", () => {
    const ev = evidence("dental", { phone: "+61 2 9670 3195" });
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const scaffold = renderSite({ evidence: ev, direction: d, media });
    const broken = scaffold.replace("INTERNAL DRAFT", "DRAFT").replace('id="tool-data"', 'id="x"').replaceAll("tel:+61296703195", "tel:000").replace("</main>", "<p>Award-winning care, 4.9/5 from our patients.</p></main>");
    const missing = scaffoldGuards(broken, ev, scaffold);
    expect(missing).toContain("internal draft banner");
    expect(missing).toContain("interactive tool data");
    expect(missing).toContain("tel: link");
    expect(missing.some((m) => /award|star rating/i.test(m))).toBe(true);
  });

  test("flags a new external host and a reused image", () => {
    const ev = evidence("dental", { phone: "+61 2 9670 3195" });
    const d = buildDirection({ name: "X", area: "Y", vertical: "dental" });
    const scaffold = renderSite({ evidence: ev, direction: d, media });
    const extra = scaffold.replace("</body>", '<script src="https://cdn.example.net/x.js"></script></body>');
    expect(scaffoldGuards(extra, ev, scaffold)).toContain("new external host https://cdn.example.net");
    const reused = scaffold.replace("</main>", '<img src="assets/img/detail-720.webp" alt=""></main>');
    expect(scaffoldGuards(reused, ev, scaffold).some((m) => /"detail" is used 2 times/.test(m))).toBe(true);
  });
});
