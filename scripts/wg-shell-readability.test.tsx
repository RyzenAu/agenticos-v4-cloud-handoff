// W-G (29 Sep 2026): global readability tokens, the calmer shell and the three-workspace switcher.
// Owner: "overall it's small and not good on the eyes"; "too many workspaces". Source and SSR checks
// only; synthetic data.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { HeaderMore } from "../src/components/shell/header-more";
import { WorkspaceSwitcher } from "../src/components/workspace/three-workspaces";
import { Badge, StatTile, Surface } from "../src/components/ds";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const styles = read("src/styles.css");
const doc = read("docs/DESIGN-SYSTEM.md");

/** --name: <n>rem → px, from the scale block. */
const remPx = (name: string) => {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(styles);
  if (!m) throw new Error(`no --${name}`);
  return Math.round(Number(m[1]) * 16);
};
const lineHeight = (name: string) => Number(new RegExp(`--${name}--line-height:\\s*([\\d.]+)`).exec(styles)?.[1]);

describe("type scale", () => {
  test("body is 15px with a comfortable line height; section titles and page titles are larger", () => {
    expect(remPx("text-sm")).toBe(15);
    expect(lineHeight("text-sm")).toBeGreaterThanOrEqual(1.55);
    expect(remPx("text-xs")).toBe(13);
    expect(remPx("text-2xs")).toBe(13); // the floor: nothing in the OS reads below 13px (1 Oct 2026)
    expect(remPx("text-lg")).toBe(20);
    expect(remPx("text-xl")).toBe(24);
    expect(read("src/components/shell/shell.css")).toContain("font-size: clamp(1.75rem, 1.45rem + 1vw, 2.25rem);");
  });

  test("the shell's base follows the token, not a hard-coded 13px", () => {
    const css = read("src/operator.css");
    expect(css).toMatch(/\.operator-shell \{\s*font-size: var\(--text-sm\);\s*line-height: var\(--text-sm--line-height\);/);
    expect(css).not.toMatch(/\.operator-shell \{\s*font-size: 13px/);
  });

  test("docs/DESIGN-SYSTEM.md states every step exactly as the tokens set it", () => {
    for (const step of ["text-3xl", "text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-xs"]) {
      expect(doc).toContain(`| \`${step}\` | ${remPx(step)} / ${lineHeight(step)} |`);
    }
    expect(doc).toContain(`| \`.ds-label\` / \`text-2xs\` | ${remPx("text-2xs")}, sentence case`);
    expect(doc).toContain("body 15px with a 1.6 line height");
    expect(doc).not.toContain("body 13px");
  });
});

describe("shape and colour", () => {
  test("cards are rounded-2xl (18px) through the tokens and the primitives", () => {
    expect(styles).toContain("--radius: 0.625rem;");
    expect(styles).toContain("--card-radius: var(--radius-2xl);");
    expect(doc).toContain("| `rounded-2xl` | 18px | **Cards**");
    expect(renderToStaticMarkup(createElement(Surface, null, "x"))).toContain("rounded-2xl");
    expect(renderToStaticMarkup(createElement(StatTile, { label: "Calls", value: "3" }))).toContain("rounded-2xl");
    const badge = renderToStaticMarkup(createElement(Badge, { tone: "warn" }, "Stale"));
    expect(badge).toContain("text-2xs");
    expect(badge).not.toContain("text-[11px]");
  });

  test("danger and warn are softer (lower chroma) in both themes, and the audit checks them", () => {
    const chroma = (block: string, name: string) => Number(new RegExp(`--${name}: oklch\\([\\d.]+ ([\\d.]+) `).exec(block)?.[1]);
    const light = styles.slice(styles.indexOf(":root {"), styles.indexOf(".dark {"));
    const dark = styles.slice(styles.indexOf(".dark {"));
    for (const block of [light, dark]) {
      expect(chroma(block, "danger")).toBeLessThanOrEqual(0.15);
      expect(chroma(block, "warn")).toBeLessThanOrEqual(0.1);
    }
    const audit = read("scripts/contrast-audit.py");
    for (const pair of ['("danger", "danger-soft"', '("warn", "warn-soft"', '("muted-foreground", "popover"']) expect(audit).toContain(pair);
  });
});

describe("top bar", () => {
  const root = read("src/routes/__root.tsx");
  const header = root.slice(root.indexOf("<header"), root.indexOf("</header>"));

  test("live state stays in the bar; the view toggles move into one labelled More menu", () => {
    for (const live of ["<CommandPaletteButton />", "<JarvisChipSlot />", "<ScreenShareControl />", "<MeetingModeControl />", "<OperatorJobs />", "<HeaderMore />"]) expect(header).toContain(live);
    for (const moved of ["<MotionControl", "<InspectorToggle", "<ThemeToggle", "<JarvisHudToggle"]) expect(header).not.toContain(moved);
  });

  test("the motion controller still mounts exactly once (MotionControl starts it)", () => {
    const more = read("src/components/shell/header-more.tsx");
    const count = (s: string) => (s.match(/<MotionControl \/>/g) ?? []).length;
    expect(count(root) + count(more) + count(read("src/components/app-sidebar.tsx"))).toBe(1);
    // hidden, never unmounted
    expect(more).toContain("hidden={!open}");
  });

  test("More renders every control with its label and keeps the ids other code relies on", () => {
    const html = renderToStaticMarkup(createElement(HeaderMore));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/aria-label="More"/);
    expect(html).toContain('id="jarvis-hud-toggle"');
    expect(html).toContain('id="inspector-toggle"');
    expect(html).toContain("Dark mode");
    expect(html).toMatch(/role="group" aria-label="More controls" hidden=""/);
    expect(read("src/components/shell/shell.css")).toContain(".sh-more-panel .op-header-ask > span {\n  display: inline !important;");
  });
});

describe("sidebar", () => {
  test("calmer and a step larger: 256px, 44px rows, 20px icons, a clear active state", () => {
    const css = read("src/components/shell/shell.css");
    expect(css).toMatch(/\.sh-sidebar\.op-sidebar \{\s*background: var\(--sidebar\);\s*width: 256px;/);
    expect(css).toMatch(/\.sh-dest-link \{[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.sh-dest-link\.active \{[^}]*font-weight: 600;/);
    expect(css).toMatch(/\.sh-drill-link \{[^}]*min-height: 38px;/);
    expect(read("src/components/app-sidebar.tsx")).toContain("<d.icon size={20}");
  });
});

describe("workspace switcher", () => {
  const render = (node: React.ReactNode) => {
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/workspaces/receptionist"] }) });
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RouterContextProvider router={router}>{node}</RouterContextProvider>
      </QueryClientProvider>,
    );
  };
  test("shows exactly the three, and marks where you are", () => {
    const html = render(<WorkspaceSwitcher current="receptionist" />);
    expect((html.match(/class="ws3-pill[ "]/g) ?? []).length).toBe(3);
    for (const name of ["M&amp;U Ventures", "Receptionist", "Websites"]) expect(html).toContain(name);
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/href="\/workspaces\/receptionist"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/workspaces\/receptionist"/);
  });

  test("/workspaces/<id> is one of the three, or (older links) a project folder", () => {
    const src = read("src/routes/workspaces.$id.tsx");
    expect(src).toContain("return isWorkspaceId(id) ? <ThreeWorkspacePage id={id} /> : <ProjectFolderDetail id={id} />;");
    // the project page says which workspace it's part of
    expect(src).toContain("Part of {home.project.name} · {home.group.name}");
    // the list is three cards now, with the rules behind a disclosure
    const index = read("src/routes/workspaces.index.tsx");
    expect(index).toContain("ws.groups.map((g)");
    expect(index).toContain("<summary>How folders are placed</summary>");
  });
});
