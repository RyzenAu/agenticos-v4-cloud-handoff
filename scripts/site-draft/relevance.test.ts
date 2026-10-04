import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageryMedia } from "./imagery";
import { checkImageRelevance, parseVerdicts } from "./relevance";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function draft(): { dir: string; media: ImageryMedia } {
  const dir = mkdtempSync(join(tmpdir(), "site-draft-relevance-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets", "img"), { recursive: true });
  const set = (key: "hero-wide" | "hero-close" | "section") => {
    const path = `assets/img/${key}-1200.webp`;
    writeFileSync(join(dir, path), key);
    return { key, sizes: [{ w: 1200, path }], width: 1200, height: 800 };
  };
  return { dir, media: { heroWide: set("hero-wide"), heroClose: set("hero-close"), section: set("section") } };
}

describe("image relevance QA", () => {
  test("fails the draft when an image doesn't read as its vertical", async () => {
    const { dir, media } = draft();
    const run = async () =>
      JSON.stringify({
        result: JSON.stringify([
          { file: "assets/img/hero-wide-1200.webp", matches: true, depicts: "dental chair under exam light" },
          { file: "assets/img/hero-close-1200.webp", matches: true, depicts: "instrument tray with mirror" },
          { file: "assets/img/section-1200.webp", matches: false, depicts: "limestone arch, no dental cue" },
        ]),
      });
    const { issues } = await checkImageRelevance(dir, "dental", media, { run });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
    expect(issues[0].detail).toContain("section");
  });

  test("caches verdicts per file set so a re-draft doesn't ask again", async () => {
    const { dir, media } = draft();
    let calls = 0;
    const run = async () => {
      calls++;
      return '[{"file":"assets/img/hero-wide-1200.webp","matches":true,"depicts":"x"},{"file":"assets/img/hero-close-1200.webp","matches":true,"depicts":"x"},{"file":"assets/img/section-1200.webp","matches":true,"depicts":"x"}]';
    };
    expect((await checkImageRelevance(dir, "dental", media, { run })).issues).toHaveLength(0);
    expect((await checkImageRelevance(dir, "dental", media, { run })).issues).toHaveLength(0);
    expect(calls).toBe(1);
  });

  test("a check that can't run warns instead of passing silently", async () => {
    const { dir, media } = draft();
    const { issues } = await checkImageRelevance(dir, "legal", media, { run: async () => { throw new Error("no claude"); } });
    expect(issues[0].severity).toBe("warn");
  });

  test("parses a verdict list wrapped in prose", () => {
    expect(parseVerdicts('Here: [{"file":"a.webp","matches":false,"depicts":"a lake"}]')).toEqual([{ file: "a.webp", matches: false, depicts: "a lake" }]);
  });
});
