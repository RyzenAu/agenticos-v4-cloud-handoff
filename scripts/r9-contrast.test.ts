// R9 item 8: text contrast in the OS (WCAG AA: 4.5:1 body, 3:1 large text and non-text). The design tokens in src/styles.css are checked as
// pairs in both themes, and the classes that made text fall below AA (an alpha on muted text or placeholders) stay out of the source.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf("\n}", start));
}
function tokens(b: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of b.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\))/g)) out[m[1]] = m[2];
  return out;
}
function srgb(ok: string): [number, number, number] {
  const [L, C, h] = ok.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/)!.slice(1).map(Number);
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function ratio(a: string, b: string): number {
  const x = lum(srgb(a)), y = lum(srgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const THEMES = { light: tokens(block(":root")), dark: tokens(block(".dark")) };
const TEXT = ["foreground", "muted-foreground", "brand", "brand-strong", "success", "warn", "danger", "info"];
const SURFACES = ["background", "card", "inset", "muted", "accent", "secondary", "surface-raised", "popover", "brand-soft", "success-soft", "warn-soft", "danger-soft", "info-soft", "sidebar"];
const PAIRS: [string, string][] = [
  ["primary-foreground", "primary"], ["brand-foreground", "brand"], ["destructive-foreground", "destructive"], ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"], ["sidebar-primary-foreground", "sidebar-primary"], ["sidebar-accent-foreground", "sidebar-accent"],
];

describe("token pairs meet AA in light and dark", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    test(`${theme}: text tokens on every surface are at least 4.5:1`, () => {
      const low: string[] = [];
      for (const f of TEXT) for (const s of SURFACES) if (t[f] && t[s] && ratio(t[f], t[s]) < 4.5) low.push(`${f} on ${s}: ${ratio(t[f], t[s]).toFixed(2)}`);
      expect(low).toEqual([]);
    });
    test(`${theme}: filled controls keep their label at 4.5:1`, () => {
      const low = PAIRS.filter(([f, b]) => t[f] && t[b] && ratio(t[f], t[b]) < 4.5).map(([f, b]) => `${f} on ${b}`);
      expect(low).toEqual([]);
    });
  }
  test("the light success green was 4.45:1 on the hover surface and 4.34:1 on the soft brand surface; both are now above 4.5", () => {
    const t = THEMES.light;
    expect(ratio(t.success, t.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t.success, t["brand-soft"])).toBeGreaterThanOrEqual(4.5);
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("no class that drops text below AA", () => {
  const files = sources(join(root, "src")).map((p) => [p, readFileSync(p, "utf8")] as const);
  const hits = (re: RegExp, bad: (n: number) => boolean) =>
    files.flatMap(([p, text]) => [...text.matchAll(re)].filter((m) => bad(Number(m[1]))).map((m) => `${p.slice(root.length + 1)}: ${m[0]}`));
  test("muted text keeps at least 70% (below that it is under 3:1 on the light page), and as text it is full strength", () => {
    expect(hits(/(?<![\w:-])text-muted-foreground\/(\d+)/g, (n) => n < 70)).toEqual([]);
  });
  test("placeholders are never faded further: muted-foreground at full strength is 4.5:1 or better", () => {
    expect(hits(/placeholder:text-muted-foreground\/(\d+)/g, () => true)).toEqual([]);
  });
  test("foreground text is not faded below 50%", () => {
    expect(hits(/(?<![\w:-])text-foreground\/(\d+)/g, (n) => n < 50)).toEqual([]);
  });
});

describe("the Agent questions panel follows the theme", () => {
  test("its own text uses the foreground token; the dark cards inside keep their light text", () => {
    const text = readFileSync(join(root, "src/components/operator/agent-jobs.css"), "utf8");
    expect(text).toMatch(/#agent-questions\.jarvis-agent-jobs\s*\{\s*color:\s*var\(--foreground\)/);
    expect(text).toMatch(/#agent-questions\.jarvis-agent-jobs :is\(\.jaj-connection, \.jaj-targets, \.jaj-run\)\s*\{\s*color:\s*#e9f0fb/);
  });
});
