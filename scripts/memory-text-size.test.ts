// L2 follow-up (29 Sep 2026): the Memory pages carried 7-11 px text (graph HUD, explorer, setup).
// Nothing on /memory, /memory-map or /memory/vault may be set below 12 px.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const operator = join(SRC, "components", "operator");
const FILES = [
  ...readdirSync(operator).filter((f) => /^memory-.*\.(css|tsx)$/.test(f)).map((f) => join(operator, f)),
  ...readdirSync(join(SRC, "components", "memory")).filter((f) => /\.(css|tsx)$/.test(f)).map((f) => join(SRC, "components", "memory", f)),
  join(SRC, "routes", "memory-map.tsx"),
  join(SRC, "components", "knowledge-explorer.tsx"),
  join(SRC, "components", "memory-graph-3d.tsx"),
  join(SRC, "components", "memory-graph-mini.tsx"),
  join(SRC, "components", "memory-graph-loader.tsx"),
  join(SRC, "components", "memory-brain.tsx"),
  join(SRC, "components", "brain-graph-3d.tsx"),
  join(SRC, "components", "graphify-graph-3d.tsx"),
  join(SRC, "components", "shell", "shell.css"),
];
const TINY = [/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g, /font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/g];

describe("Memory pages: no text under 12 px", () => {
  test("no tiny Tailwind sizes or px font sizes in the memory sources", () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const re of TINY) for (const m of src.matchAll(re)) hits.push(`${file.slice(SRC.length)}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

// The classes the real data showed on /memory (source cards, filters) live in operator.css, and the
// 3D graphs inject a 10 px nav hint; both are held to 12 px here.
describe("Memory source cards and graph hint", () => {
  const css = readFileSync(join(SRC, "operator.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  const px = (block: string) => {
    const m = block.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    return m ? Number(m[1]) : null;
  };
  test("op-source-top, op-source-bottom, the card snippet and op-select are at least 12 px", () => {
    for (const sel of [".op-source-top", ".op-source-bottom", ".op-source-card p", ".op-source-card h3", ".op-select", ".op-library-tools .op-select"]) {
      const size = px(rule(sel));
      if (size !== null) expect(size).toBeGreaterThanOrEqual(12);
    }
    expect(rule(".op-source-card p")).toContain("var(--text-xs)");
  });
  test("scene-nav-info is set to at least 12 px (now the --text-xs token under the 13 px floor)", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const m = css.match(/\.scene-nav-info\s*\{\s*font-size:\s*([^;!]+?)\s*!important/);
    expect(m).not.toBeNull();
    const value = m![1].trim();
    const token = value.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
    const raw = token ? css.match(new RegExp(`--${token}:\\s*([0-9.]+)(rem|px)`)) : value.match(/^([0-9.]+)(rem|px)$/);
    expect(raw).not.toBeNull();
    const px = Number(raw![1]) * (raw![2] === "rem" ? 16 : 1);
    expect(px).toBeGreaterThanOrEqual(12);
  });
  test("the card preview goes through previewSnippet", () => {
    expect(readFileSync(join(SRC, "components", "operator", "memory-workspace.tsx"), "utf8")).toContain("previewSnippet(s.text, 240, s.title)");
  });
});
