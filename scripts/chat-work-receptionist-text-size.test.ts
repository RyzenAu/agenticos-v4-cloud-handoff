// L5 (29 Sep 2026): /receptionist, /work and /chat still carried 9-11 px text (progress ring unit,
// chat history, composer, code-block label, model badge). Nothing on these three pages may be
// set below 12 px; the token scale already floors at --text-2xs = 12 px.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(css|tsx)$/.test(f) ? [p] : [];
  });
const op = (f: string) => join(SRC, "components", "operator", f);
const FILES = [
  join(SRC, "routes", "receptionist.tsx"),
  join(SRC, "routes", "work.tsx"),
  join(SRC, "routes", "chat.tsx"),
  ...walk(join(SRC, "components", "receptionist")),
  ...walk(join(SRC, "components", "workspace")),
  ...walk(join(SRC, "components", "ds")),
  join(SRC, "components", "shell", "pages", "work-page.tsx"),
  join(SRC, "components", "shell", "pages", "receptionist-destination.tsx"),
  join(SRC, "components", "shell", "page-parts.tsx"),
  op("chat-refinements.css"),
  op("chat-page-composer.css"),
  op("chat-page-composer.tsx"),
  op("chat-history-item.tsx"),
  op("chat-calendar-review.tsx"),
  op("chat-brand.tsx"),
  join(SRC, "components", "chat-md.tsx"),
  join(SRC, "components", "floating-oracle.tsx"),
  join(SRC, "components", "ui", "ai-chat-input.tsx"),
];
const N = String.raw`(?:[0-9]|1[01])(?:\.\d+)?`;
const TINY = [
  new RegExp(String.raw`text-\[${N}px\]`, "g"), // Tailwind arbitrary size
  new RegExp(String.raw`font-size:\s*${N}px`, "g"), // CSS
  new RegExp(String.raw`font:\s*["']?[^;"'}]*?\b${N}px`, "g"), // CSS / inline shorthand
  new RegExp(String.raw`fontSize:\s*["']?${N}(?:px)?["']?\s*[,}]`, "g"), // inline style object
  /font-size:\s*0?\.(?:[0-6]\d*|7[0-4]\d*)r?em/g, // under 0.75rem
  /text-\[0?\.(?:[0-6]\d*|7[0-4]\d*)r?em\]/g,
];

describe("Receptionist, Work and Chat: no text under 12 px", () => {
  test("every guarded file exists", () => {
    for (const f of FILES) expect(statSync(f).isFile()).toBe(true);
  });
  test("no tiny Tailwind sizes, px font sizes or shorthand in the page sources", () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const re of TINY) for (const m of src.matchAll(re)) hits.push(`${file.slice(SRC.length)}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
  test("the guard itself catches a 11 px size", () => {
    expect("text-[11px]".match(TINY[0])).not.toBeNull();
    expect("font-size: 9px".match(TINY[1])).not.toBeNull();
    expect('font: "600 7.5px ui-monospace"'.match(TINY[2])).not.toBeNull();
    expect("fontSize: 11,".match(TINY[3])).not.toBeNull();
    expect("font-size: 12px".match(TINY[1])).toBeNull();
  });
});
