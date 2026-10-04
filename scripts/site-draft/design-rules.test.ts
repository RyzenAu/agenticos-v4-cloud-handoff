// impeccable / mu-art-direction / mu-killer-site as checks, and the brand-token path.
import { describe, expect, test } from "bun:test";
import { applyBrandTokens, buildDirection, renderDirectionMarkdown } from "./direction";
import { contrast, extractBrandTokens, hexOf, isChromatic } from "./brand";
import { auditDesignRules, designRulesPrompt, DESIGN_RULES } from "./design-rules";
import { FRAME_POINTS, frameScrollJs } from "./qa";

const ids = (html: string, extra: { css?: string; vertical?: string } = {}) => auditDesignRules({ html, ...extra }).map((i) => `${i.severity}:${i.detail.slice(1, i.detail.indexOf("]"))}`);

describe("design rules", () => {
  test("every rule reaches the refine prompt", () => {
    const prompt = designRulesPrompt();
    for (const r of DESIGN_RULES) expect(prompt).toContain(r.rule);
  });

  test("eyebrows, gradient text, emoji and missing reduced motion are caught", () => {
    const found = ids('<p class="eyebrow">Services</p><h2>Our work 🚀</h2><style>.x{background-clip:text}@keyframes a{}</style>');
    expect(found).toContain("warn:no-eyebrow");
    expect(found).toContain("fail:no-gradient-text");
    expect(found).toContain("fail:no-emoji-icons");
    expect(found).toContain("fail:reduced-motion");
  });

  test("testimonials fail on dental and warn elsewhere", () => {
    expect(ids("<h2>What our patients say</h2>", { vertical: "dental" })).toContain("fail:no-testimonials-health");
    expect(ids("<h2>Testimonials</h2>", { vertical: "legal" })).toContain("warn:no-testimonials-health");
  });

  test("a clean page with a themed selection passes", () => {
    expect(ids("<style>::selection{background:#123}@media (prefers-reduced-motion:reduce){*{animation:none}}</style><h1>Dental care in Penrith</h1>")).toEqual([]);
  });
});

describe("brand tokens", () => {
  const html = `<html><head><meta name="theme-color" content="#0a6e5c"><link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400&display=swap" rel="stylesheet">
  <style>:root{--brand-primary:#0a6e5c}body{font-family:"Libre Baskerville",Georgia,serif;color:#222}.btn{background:#0a6e5c}.x{color:#fff}</style></head>
  <body><img class="site-logo" src="/img/logo.svg" alt="Smile Co logo"></body></html>`;

  test("reads colour, fonts and logo from the page, ignoring greys", () => {
    const b = extractBrandTokens(html, "https://smile.example/");
    expect(b.primary).toBe("#0a6e5c");
    expect(b.colours).not.toContain("#222222");
    expect(b.fonts[0]).toBe("Libre Baskerville");
    expect(b.logoUrl).toBe("https://smile.example/img/logo.svg");
    expect(hexOf("rgb(10, 110, 92)")).toBe("#0a6e5c");
    expect(isChromatic("#777777")).toBe(false);
  });

  test("a readable brand colour replaces the seeded accent; an unreadable one is recorded, not used", () => {
    const d = buildDirection({ name: "Brand Probe", area: "Penrith NSW", vertical: "dental" });
    const b = extractBrandTokens(html, "https://smile.example/");
    const locked = applyBrandTokens(d, b);
    if (contrast("#0a6e5c", d.palette.paper) >= 3) {
      expect(locked.palette.accent).toBe("#0a6e5c");
      expect(locked.brand?.applied).toBe(true);
    }
    const pale = applyBrandTokens(d, { ...b, primary: "#ffe98a" });
    if (contrast("#ffe98a", d.palette.paper) < 3) {
      expect(pale.palette.accent).toBe(d.palette.accent);
      expect(pale.brand?.applied).toBe(false);
    }
    expect(renderDirectionMarkdown({ name: "Brand Probe", area: "Penrith NSW", vertical: "dental" }, locked)).toContain("Their brand");
    expect(applyBrandTokens(d, null)).toBe(d);
  });
});

describe("RISE examine frames", () => {
  test("frames are taken at 0/25/50/75/100% of the scroll", () => {
    expect([...FRAME_POINTS]).toEqual([0, 25, 50, 75, 100]);
    expect(frameScrollJs(50)).toContain("max*0.5");
  });
});
