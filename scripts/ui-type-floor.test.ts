// Programme C (1 Oct 2026): the type floor is 13px. No stylesheet or component may set a font size below
// it, and no important label may be tiny capitals. Canvas/3D label drawing is a named exception so a new
// offender fails here instead of shipping.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(SRC);
const rel = (p: string) => p.slice(SRC.length + 1).split(sep).join("/");

/** Canvas/WebGL label drawing, where a px size is a drawing parameter, not page typography. */
const CANVAS_EXCEPTIONS = /graph-3d|brain-graph|agent-core-3d|oracle|stage-cosmos|stage-aurora/;

describe("type floor", () => {
  test("no CSS declares a font-size under 13px", () => {
    const offenders: string[] = [];
    for (const f of files.filter((p) => p.endsWith(".css"))) {
      const css = readFileSync(f, "utf8");
      for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) if (Number(m[1]) < 13) offenders.push(`${rel(f)}: ${m[0]}`);
      for (const m of css.matchAll(/font-size:\s*([\d.]+)rem/g)) if (Number(m[1]) * 16 < 12.99) offenders.push(`${rel(f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no component uses an arbitrary size under 13px", () => {
    const offenders: string[] = [];
    for (const f of files.filter((p) => p.endsWith(".tsx") && !CANVAS_EXCEPTIONS.test(rel(p)))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/text-\[([\d.]+)px\]/g)) if (Number(m[1]) < 13) offenders.push(`${rel(f)}: ${m[0]}`);
      for (const m of src.matchAll(/font-size:\s*([\d.]+)px/g)) if (Number(m[1]) < 13) offenders.push(`${rel(f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test(".ds-label is sentence case at the floor", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const block = /\.ds-label\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toContain("var(--text-2xs)");
    expect(block).toContain("text-transform: none");
  });
});
