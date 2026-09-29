// The preview motion layer and the design gate that refuses a preview without it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designGate } from "./generate";
import { MOTION_CSS, MOTION_JS, MOTION_MARKER, motionHead, withMotion, writeMotionAssets } from "./motion";

const svc = (name: string) => ({ name, sourceUrl: "https://x.example/" });

describe("motion layer", () => {
  test("the marquee and count line are hidden at fill time without enough verified services", () => {
    expect(motionHead({ services: [svc("A"), svc("B")] })).toContain("[data-mu-marquee]{display:none");
    expect(motionHead({ services: [] })).toContain(".mu-count-line");
    expect(motionHead({ services: [svc("A"), svc("B"), svc("C")] })).not.toContain("data-mu-motion-fill");
  });

  test("the marquee data carries only the verified service names, escaped", () => {
    const head = motionHead({ services: [svc("Crowns"), svc("</script><b>"), svc("Fillings")] });
    expect(head).toContain('"Crowns"');
    expect(head).not.toContain("</script><b>");
  });

  test("withMotion is idempotent and loads the script async (never delays DOMContentLoaded)", () => {
    const once = withMotion("<html><head></head><body></body></html>", { services: [] });
    expect(withMotion(once, { services: [] })).toBe(once);
    expect(once).toContain('src="_mu/motion.js" async');
    expect(once).toContain(MOTION_MARKER);
  });

  test("reduced motion and the final-frame default are built in", () => {
    expect(MOTION_CSS).toContain("prefers-reduced-motion:reduce");
    expect(MOTION_JS).toContain("prefers-reduced-motion: reduce");
    expect(MOTION_JS).toContain("attachShadow"); // marquee kept out of React's hydration
    expect(() => new Function(MOTION_JS)).not.toThrow();
  });
});

describe("design gate", () => {
  const page = (body: string, head = "") => `<!doctype html><html><head><style>::selection{background:#123}</style>${head}</head><body>${body}</body></html>`;

  test("refuses a page without the motion layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-gate-"));
    writeFileSync(join(dir, "index.html"), page("<h1>Hi</h1>"));
    expect(designGate(dir, "legal").fails.join()).toContain("motion layer");
  });

  test("passes with the layer, and refuses testimonials on a dental preview", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-gate-"));
    writeMotionAssets(dir);
    writeFileSync(join(dir, "index.html"), withMotion(page("<h1>Hi</h1>"), { services: [] }));
    expect(designGate(dir, "dental").fails).toEqual([]);
    writeFileSync(join(dir, "index.html"), withMotion(page("<h2>Testimonials</h2>"), { services: [] }));
    expect(designGate(dir, "dental").fails.join()).toContain("no-testimonials-health");
  });
});
