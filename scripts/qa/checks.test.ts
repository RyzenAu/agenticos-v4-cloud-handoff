import { describe, expect, test } from "bun:test";
import {
  altTextCheck, brokenLinksResult, contrastCheck, contrastRatio, coreWebVitalsFallback,
  coreWebVitalsFromLighthouse, inlineColorPairs, localLinkTargets, mobileRenderCheck, overallPass,
  parseColor, reducedMotionCheck, robotsCheck, tenTellsChecklist, tokenColorPairs,
} from "./checks";

describe("contrastRatio / parseColor", () => {
  test("black on white is 21:1", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  });
  test("parses hex, shorthand hex and rgb()", () => {
    expect(parseColor("#000")).toEqual([0, 0, 0]);
    expect(parseColor("#ffffff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColor("currentColor")).toBeNull();
  });
});

describe("contrastCheck", () => {
  test("flags a low-contrast inline pair", () => {
    const html = [{ path: "index.html", content: '<p style="color:#999999;background:#ffffff">hi</p>' }];
    const r = contrastCheck(html, []);
    expect(r.severity).toBe("fail");
  });
  test("passes a strong inline pair", () => {
    const html = [{ path: "index.html", content: '<p style="color:#000000;background:#ffffff">hi</p>' }];
    const r = contrastCheck(html, []);
    expect(r.severity).toBe("pass");
  });
  test("skips when nothing evaluable is found", () => {
    const r = contrastCheck([{ path: "index.html", content: "<p>hi</p>" }], []);
    expect(r.severity).toBe("skip");
  });
  test("checks design-token pairs from CSS", () => {
    const css = [{ path: "styles.css", content: ":root{--foreground:#111111;--background:#eeeeee;}" }];
    const r = contrastCheck([], css);
    expect(r.severity).toBe("pass");
  });
});

describe("altTextCheck", () => {
  test("fails on a missing alt", () => {
    const r = altTextCheck([{ path: "index.html", content: '<img src="a.png">' }]);
    expect(r.severity).toBe("fail");
  });
  test("passes with alt present", () => {
    const r = altTextCheck([{ path: "index.html", content: '<img src="a.png" alt="A house">' }]);
    expect(r.severity).toBe("pass");
  });
  test("ignores decorative images", () => {
    const r = altTextCheck([{ path: "index.html", content: '<img src="a.png" role="presentation">' }]);
    expect(r.severity).toBe("pass");
  });
});

describe("mobileRenderCheck", () => {
  test("warns when viewport meta is missing", () => {
    const r = mobileRenderCheck([{ path: "index.html", content: "<html><head></head></html>" }], []);
    expect(r.severity).toBe("warn");
  });
  test("passes with viewport and no oversized fixed widths", () => {
    const r = mobileRenderCheck(
      [{ path: "index.html", content: '<meta name="viewport" content="width=device-width,initial-scale=1">' }],
      [{ path: "s.css", content: ".card{width:300px}" }],
    );
    expect(r.severity).toBe("pass");
  });
  test("warns on a CSS fixed width over 390px", () => {
    const r = mobileRenderCheck(
      [{ path: "index.html", content: '<meta name="viewport" content="width=device-width">' }],
      [{ path: "s.css", content: ".hero{width:1200px}" }],
    );
    expect(r.severity).toBe("warn");
  });
});

describe("robotsCheck", () => {
  test("preview mode fails when a page is indexable", () => {
    const r = robotsCheck([{ path: "index.html", content: "<html></html>" }], null, "preview");
    expect(r.severity).toBe("fail");
  });
  test("preview mode passes when every page has noindex", () => {
    const r = robotsCheck([{ path: "index.html", content: '<meta name="robots" content="noindex">' }], null, "preview");
    expect(r.severity).toBe("pass");
  });
  test("production mode fails when noindex is left in", () => {
    const r = robotsCheck([{ path: "index.html", content: '<meta name="robots" content="noindex">' }], null, "production");
    expect(r.severity).toBe("fail");
  });
  test("production mode fails when robots.txt disallows everything", () => {
    const r = robotsCheck([{ path: "index.html", content: "<html></html>" }], "User-agent: *\nDisallow: /\n", "production");
    expect(r.severity).toBe("fail");
  });
  test("production mode passes when open", () => {
    const r = robotsCheck([{ path: "index.html", content: "<html></html>" }], "User-agent: *\nAllow: /\n", "production");
    expect(r.severity).toBe("pass");
  });
});

describe("reducedMotionCheck", () => {
  test("skips a static page", () => {
    const r = reducedMotionCheck([{ path: "index.html", content: "<p>hi</p>" }], []);
    expect(r.severity).toBe("skip");
  });
  test("fails when motion exists with no reduced-motion handling", () => {
    const r = reducedMotionCheck([], [{ path: "s.css", content: ".x{animation:spin 1s linear infinite}" }]);
    expect(r.severity).toBe("fail");
  });
  test("passes when CSS media query handles it", () => {
    const r = reducedMotionCheck(
      [],
      [{ path: "s.css", content: ".x{animation:spin 1s} @media (prefers-reduced-motion: reduce){.x{animation:none}}" }],
    );
    expect(r.severity).toBe("pass");
  });
  test("passes when a matchMedia check handles it", () => {
    const r = reducedMotionCheck(
      [{ path: "index.html", content: "<script>matchMedia('(prefers-reduced-motion: reduce)')</script>" }],
      [{ path: "s.css", content: ".x{transition:opacity 1s}" }],
    );
    expect(r.severity).toBe("pass");
  });
});

describe("coreWebVitals", () => {
  test("fallback warns on render-blocking scripts", () => {
    const r = coreWebVitalsFallback([{ path: "index.html", content: '<head><script src="a.js"></script></head>' }], []);
    expect(r.severity).toBe("warn");
  });
  test("fallback passes a lean page", () => {
    const r = coreWebVitalsFallback([{ path: "index.html", content: '<head><script defer src="a.js"></script></head>' }], [{ path: "a.js", bytes: 1000 }]);
    expect(r.severity).toBe("pass");
  });
  test("lighthouse branch flags metrics outside Good thresholds", () => {
    const r = coreWebVitalsFromLighthouse({ lcp: 4000, inp: 100, cls: 0.05 });
    expect(r.severity).toBe("warn");
    expect(r.evidence?.[0]).toContain("LCP");
  });
  test("lighthouse branch passes within thresholds", () => {
    const r = coreWebVitalsFromLighthouse({ lcp: 1200, inp: 100, cls: 0.02 });
    expect(r.severity).toBe("pass");
  });
});

describe("broken links", () => {
  test("localLinkTargets extracts href/src, skipping anchors/mailto/tel", () => {
    const out = localLinkTargets([{ path: "index.html", content: '<a href="/about">x</a><a href="#top">y</a><a href="mailto:a@b.com">z</a><img src="a.png">' }]);
    expect(out[0].targets.sort()).toEqual(["/about", "a.png"]);
  });
  test("brokenLinksResult fails when something's broken", () => {
    const r = brokenLinksResult([{ fromPage: "index.html", target: "/missing", reason: "file not found" }], 5);
    expect(r.severity).toBe("fail");
  });
  test("brokenLinksResult passes clean", () => {
    const r = brokenLinksResult([], 5);
    expect(r.severity).toBe("pass");
  });
});

describe("tenTellsChecklist", () => {
  test("null (not applicable) for a plain static page", () => {
    expect(tenTellsChecklist([{ path: "index.html", content: "<p>hi</p>" }])).toBeNull();
  });
  test("surfaces the checklist when canvas/motion is present", () => {
    const r = tenTellsChecklist([{ path: "index.html", content: "<canvas></canvas>" }]);
    expect(r).not.toBeNull();
    expect(r!.severity).toBe("warn");
    expect(r!.evidence?.length).toBe(11);
  });
});

describe("overallPass", () => {
  test("false when any check fails", () => {
    expect(overallPass([{ id: "a", title: "a", severity: "pass", detail: "" }, { id: "b", title: "b", severity: "fail", detail: "" }])).toBe(false);
  });
  test("true when nothing fails (warn/skip don't block)", () => {
    expect(overallPass([{ id: "a", title: "a", severity: "warn", detail: "" }, { id: "b", title: "b", severity: "skip", detail: "" }])).toBe(true);
  });
});
