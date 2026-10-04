// Round 6 interface pass (2 Oct 2026): defects found by clicking every control stay fixed.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");




describe("re-check buttons say when they last checked", () => {
  test("Mercury, YouTube key and tool detection show a checked time instead of changing nothing", () => {
    const panel = read("src/components/business/connections-panel.tsx");
    expect(panel).toContain("checked ${fmtTime(native.dataUpdatedAt)}");
    expect(panel).toContain("Still not connected · checked {fmtTime(status.dataUpdatedAt)}");
    expect(read("src/components/operator/workspace-onboarding.tsx")).toContain("checked ${fmtTime(discovery.dataUpdatedAt)}");
  });
});

describe("Home's All decisions lands on the decisions list", () => {
  test("it links to the Work decisions block, not the top of Work", () => {
    expect(read("src/components/shell/pages/today-page.tsx")).toContain('<Link to="/work" hash="ws-today">All decisions</Link>');
  });
});

describe("one main landmark and one page-title style", () => {
  test("Operations and Setup sit inside the shell's main instead of adding a second one", () => {
    expect(read("src/components/business/mu-operations.tsx")).not.toContain("<main");
    expect(read("src/components/operator/workspace-onboarding.tsx")).not.toContain('<main className="ws-calm-shell">');
  });
  test("the Operations title uses the shared display face and size", () => {
    const css = read("src/components/business/mu-operations.css");
    expect(css).toContain("font-family: var(--font-display);");
    expect(css).toContain("font-size: clamp(1.75rem, 1.45rem + 1vw, 2.25rem);");
  });
});

describe("Memory map: the link-strength slider has a name", () => {
  test("a screen reader hears what the slider changes", () => {
    expect(read("src/components/memory-graph-3d.tsx")).toContain('aria-label="Link strength"');
  });
});

describe("a focused tab panel shows where the keyboard is", () => {
  test("the shared TabPanel is a tab stop with a focus-visible ring, not outline-none alone", () => {
    const src = read("src/components/ds/tabs.tsx");
    expect(src).toContain("focus-visible:ring-2 focus-visible:ring-ring");
    expect(src).not.toContain('cn("outline-none", className)');
  });
});


describe("Finance next steps stack on a phone", () => {
  test("the step text has a 16rem basis so its action wraps below instead of squeezing the text", () => {
    expect(read("src/components/shell/pages/finance-page.tsx")).toContain('className="min-w-0 flex-[1_1_16rem]"');
  });
});

describe("Vault: a refused Sync now says so", () => {
  test("a structured { ok: false } answer becomes a visible notice, not silence", () => {
    const src = read("src/components/memory/memory-vault.tsx");
    expect(src).toContain("if (refused.ok === false) {");
    expect(src).toContain("Sync was refused");
  });
});

describe("System: a model check that cannot start says so", () => {
  test("the Check again failure is a visible alert with the reason", () => {
    const src = read("src/components/shell/pages/system-page.tsx");
    expect(src).toContain("setCheckError(e instanceof Error");
    expect(src).toContain("The model check didn't run");
  });
});


describe("Studio links to the finished films", () => {
  test("the Promotional films link opens a page that exists in public/", () => {
    const src = read("src/components/shell/pages/studio-page.tsx");
    const href = src.match(/href="(\/mu-creative-20261001\/[^"]+)"/)?.[1];
    expect(href).toBe("/mu-creative-20261001/index.html");
    expect(existsSync(join(import.meta.dir, "..", "public", href!))).toBe(true);
    expect(src).toContain('target="_blank"');
    expect(src).toContain("Promotional films");
  });
});
