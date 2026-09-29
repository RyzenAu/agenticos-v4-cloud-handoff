// W-F (29 Sep 2026): the Motion library's M&U kit. At least 8 reusable pieces in black and gold, each with a
// live preview, a reduced-motion fallback (CSS and script alike) and copy-to-use HTML and React snippets.
// Built in code: no network, no paid generation. Synthetic render only.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  hasReducedCss,
  htmlSnippet,
  KIT,
  kitPieceById,
  MU_TOKENS,
  previewDoc,
  reactSnippet,
  searchKit,
} from "../src/motion/kit";
import { KitTab } from "../src/components/motion/kit-tab";
import { Route as MotionRoute } from "../src/routes/motion";

const PIECES_DIR = join(import.meta.dir, "..", "src", "motion", "kit", "pieces");

describe("the M&U motion kit", () => {
  test("at least 8 pieces, unique ids, one file each, registered in order", () => {
    expect(KIT.length).toBeGreaterThanOrEqual(8);
    const ids = KIT.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = readdirSync(PIECES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    expect([...files].sort()).toEqual([...ids].sort());
    for (const id of [
      "kinetic-headline",
      "logo-sting",
      "lower-third",
      "stat-ring",
      "device-pan",
      "testimonial-flip",
      "map-pin-drop",
      "before-after",
      "cta-pulse",
    ])
      expect(kitPieceById(id)).toBeTruthy();
  });

  for (const p of KIT)
    test(`${p.id}: contract, brand, reduced motion, no network, no randomness`, () => {
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.tagline.length).toBeLessThanOrEqual(60);
      for (const field of [p.move, p.reduced, p.useFor]) expect(field.length).toBeGreaterThan(20);
      expect(p.html).toContain(`data-mu-kit="${p.id}"`);
      // Every piece carries the M&U tokens and uses the gold.
      expect(p.css).toContain(MU_TOKENS);
      expect(p.css).toContain("var(--mu-gold");
      // Reduced motion in CSS, and in script where the script animates.
      expect(hasReducedCss(p.css)).toBe(true);
      if (p.init && /requestAnimationFrame|data-nudge/.test(p.init))
        expect(p.init).toContain("prefers-reduced-motion: reduce");
      // Nothing is fetched and nothing is random: a copied piece works offline and the same every time.
      expect(`${p.html}${p.css}${p.init ?? ""}`).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(`${p.html}${p.css}${p.init ?? ""}`).not.toMatch(
        /Math\.random|fetch\(|XMLHttpRequest|localStorage|eval\(/,
      );
      // The script is valid JS, returns a cleanup when it observes or listens, and can't close a <script> tag.
      if (p.init) {
        expect(() => new Function("root", p.init!)).not.toThrow();
        expect(p.init).not.toContain("</script");
        if (/IntersectionObserver|addEventListener|setTimeout|requestAnimationFrame/.test(p.init))
          expect(p.init).toMatch(/return \(\) =>|return \(\) => \{/);
      }
      // A play-once piece has no-script fallback: it's armed only by its script.
      if (/data-armed/.test(p.css))
        expect(p.init ?? "").toContain('setAttribute("data-armed", "")');
    });
});

describe("copy-to-use snippets", () => {
  for (const p of KIT)
    test(`${p.id}: HTML and React come from the same source`, () => {
      const html = htmlSnippet(p);
      expect(html).toStartWith(`<!-- ${p.name} · M&U motion kit. Reduced motion: ${p.reduced}`);
      expect(html).toContain(p.css.trim());
      expect(html).toContain(p.html.trim());
      if (p.init)
        expect(html).toContain(
          `document.querySelectorAll('[data-mu-kit="${p.id}"]').forEach((el) => init(el));`,
        );
      else expect(html).not.toContain("<script>");
      const react = reactSnippet(p);
      expect(react).toStartWith('"use client";');
      const component = p.id.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
      expect(react).toContain(`export function ${component}()`);
      expect(react).toContain(JSON.stringify(p.css.trim()));
      // It parses as TSX.
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(react)).not.toThrow();
    });

  test("the preview forces the motion Full or Reduced, is locked down, and replays on request", () => {
    const p = kitPieceById("stat-ring")!;
    const full = previewDoc(p, { reduced: false });
    const reduced = previewDoc(p, { reduced: true });
    expect(full).toContain("@media not all");
    expect(reduced).toContain("@media all");
    for (const doc of [full, reduced]) {
      expect(doc).not.toMatch(/@media\s*\(\s*prefers-reduced-motion/);
      expect(doc).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none';`);
      expect(doc).toContain('e.data === "mu-kit:replay"');
      // The only </script> is the one that closes the preview's own script.
      expect(doc.split("</script>").length).toBe(2);
    }
    expect(reduced).toContain("matches: /reduce/.test(q) ? true : false");
    expect(full).toContain("matches: /reduce/.test(q) ? false : true");
    expect(full).toContain("setInterval(run, 3800)");
    expect(reduced).not.toContain("setInterval(run");
    // The lower third sits in a 16:9 video frame.
    expect(previewDoc(kitPieceById("lower-third")!, { reduced: false })).toContain(
      "aspect-ratio:16/9",
    );
  });

  test("search finds pieces by what they're for", () => {
    expect(searchKit("map").map((p) => p.id)).toContain("map-pin-drop");
    expect(searchKit("testimonial").map((p) => p.id)).toContain("testimonial-flip");
    expect(searchKit("  ").length).toBe(KIT.length);
    expect(searchKit("zzz-nothing")).toEqual([]);
  });
});

describe("the Motion library tab", () => {
  test("every piece renders as a card with its motion switch and both copy buttons", () => {
    const html = renderToStaticMarkup(<KitTab query="" notify={() => undefined} />);
    for (const p of KIT) {
      expect(html).toContain(`data-kit="${p.id}"`);
      expect(html).toContain(p.name.replace(/&/g, "&amp;"));
    }
    expect(html.match(/Copy HTML/g)?.length).toBe(KIT.length);
    expect(html.match(/Copy React/g)?.length).toBe(KIT.length);
    expect(html.match(/>Full motion</g)?.length).toBe(KIT.length);
    expect(html.match(/>Reduced</g)?.length).toBe(KIT.length);
    // Previews mount only when on screen (none during a server render).
    expect(html).not.toContain("<iframe");
  });

  test("?tab=kit opens the kit; anything else is ignored", () => {
    const validate = (
      MotionRoute.options as { validateSearch: (s: Record<string, unknown>) => { tab?: string } }
    ).validateSearch;
    expect(validate({ tab: "kit" }).tab).toBe("kit");
    expect(validate({ tab: "styles" }).tab).toBeUndefined();
    expect(validate({ tab: "<script>" }).tab).toBeUndefined();
  });
});
