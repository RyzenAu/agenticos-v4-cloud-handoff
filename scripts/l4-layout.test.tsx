// L4 (29 Sep 2026): Hermes (see hermes/hermes-tabs.test.tsx), Motion library, Skills, Calendar, Settings,
// Automations and Websites in the widget-grid layout, at a readable size. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const withRouter = (node: ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}>{node}</RouterContextProvider>);
};

/** Every font-size in a stylesheet, in px (rem and em counted at 16 px). */
function fontSizes(css: string): number[] {
  return [...css.matchAll(/font-size\s*:\s*([\d.]+)(px|rem|em)\b/g)].map((m) => Number(m[1]) * (m[2] === "px" ? 1 : 16));
}

describe("no tiny text on the L4 pages", () => {
  test("the Motion library stylesheet has no font-size under 13 px", () => {
    expect(fontSizes(read("src/components/motion/motion-library.css")).filter((n) => n < 13)).toEqual([]);
  });

  test("the generated readable-size stylesheets lift every size to 13 px", () => {
    for (const f of ["src/components/operator/calendar-readable.css", "src/components/operator/settings-readable.css"]) {
      const sizes = fontSizes(read(f));
      expect(sizes.length).toBeGreaterThan(10);
      expect(sizes.filter((n) => n < 13)).toEqual([]);
    }
  });

  test("Skills, Websites, Settings, Calendar and Automations have no tiny Tailwind sizes", () => {
    for (const f of [
      "src/routes/skills.tsx",
      "src/routes/websites.tsx",
      "src/routes/settings.tsx",
      "src/components/websites/make-site.tsx",
      "src/components/websites/sites-glance.tsx",
      "src/components/operator/automations-workspace.tsx",
      "src/components/operator/calendar-workspace.tsx",
    ]) {
      expect(read(f).match(/text-\[(9|10|11|12)(\.5)?px\]|\btext-xs\b|\bds-label\b/g) ?? []).toEqual([]);
    }
  });
});

describe("Motion library", () => {
  test("one h1 and one headline sentence, then the box and the wall", () => {
    const src = read("src/components/motion/motion-library.tsx");
    expect(src).toContain('title="Motion Library"');
    expect(src).toContain("Make a motion piece: pick a style, describe the idea, and get a prompt for Claude Code.");
    // The huge centred hero heading is retired, but every collection is still a tab.
    expect(read("src/components/motion/motion-library.css")).not.toMatch(/\.ml-hero h1\s*\{/);
    for (const t of ['"styles", "Styles"', '"kit", "M&U kit"', '"made", "Made in this video"', '"inspiration", "Inspiration"']) expect(src).toContain(t);
  });
});

describe("Skills page", () => {
  const src = read("src/routes/skills.tsx");
  test("time saved, totals, the chart and the top savers are widgets in one grid", () => {
    expect(src).toContain("<WidgetGrid");
    for (const t of ['title="Time saved"', 'title="Skills"', 'title="Uses"', 'title="Where the work happens"', 'title="Top time savers"']) expect(src).toContain(t);
    expect(src).toContain("const CATEGORY_PREVIEW_COUNT = 4;"); // one row of four per category
  });
  test("each skill is a widget: name, uses as the one big value, last used, and the minutes it saves", () => {
    expect(src).toContain("value={s.uses}");
    expect(src).toContain("line={lastUsedText(s.lastUsed)}");
    expect(src).toContain("minutes saved per run");
  });
  test("the honest states stay: demo data, no dollar figure without a rate", () => {
    expect(src).toContain("Demo data");
    expect(src).toContain("const showMoney = !rate.assumed;");
  });
});

describe("Calendar page", () => {
  const src = read("src/components/operator/calendar-workspace.tsx");
  test("four widgets lead the page: today, next up, the week, the calendars", () => {
    for (const t of ['title="Today"', 'title="Next up"', 'title="Next 7 days"', 'title="Calendars"']) expect(src).toContain(t);
    expect(src.indexOf('title="Today"')).toBeLessThan(src.indexOf('ariaLabel="Calendar view"'));
  });
  test("the headline comes from the saved events, and the timezone note is one foot line", () => {
    expect(src).toContain("Nothing on today.");
    expect(src).toContain("<PageFoot>");
    expect(src).not.toContain('className="op-form-help" style');
  });
  test("every feature is still there: month and agenda, booking links, availability, import, sync, coverage", () => {
    for (const t of ["Booking links", "Availability", "Import .ics", "Sync now", "Calendar coverage", "Agenda", "Ask about your calendar"]) expect(src).toContain(t);
  });
});

describe("Settings page", () => {
  const src = read("src/routes/settings.tsx");
  test("settings leads with its sections, with setup reachable and unsaved changes visible", () => {
    expect(src).toContain('to="/setup"');
    expect(src).toContain('Review setup');
    expect(src).toContain('Unsaved changes');
    expect(src.indexOf('title="Settings"')).toBeLessThan(src.indexOf('aria-label="Settings sections"'));
    const css = read("src/components/operator/workspace-settings.css");
    expect(css).toContain("max-width: 1680px");
    expect(css).not.toContain("max-width: 950px");
  });
  test("all five sections are still tabs", () => {
    for (const t of ["Personal profile", "Connections", "AI tools", "Workspace", "Jarvis"]) expect(src).toContain(`label: "${t}"`);
  });
});

describe("Automations page", () => {
  const job = (name: string, over: Record<string, unknown> = {}) => ({
    id: name,
    name,
    schedule: "0 8 * * *",
    scheduleText: "Daily 08:00",
    active: true,
    lastRunAt: "2026-09-28T22:00:00.000Z",
    lastStatus: "ok",
    nextRunAt: "2026-09-29T22:00:00.000Z",
    deliver: "telegram:1",
    mode: "agent",
    dot: "green" as const,
    ...over,
  });
  const render = (automations: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(["automations"], { automations });
    client.setQueryData(["leads-summary"], {});
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AutomationsWorkspace } = require("../src/components/operator/automations-workspace");
    return withRouter(<QueryClientProvider client={client}>{<AutomationsWorkspace />}</QueryClientProvider>);
  };

  test("four summary widgets, then one widget per job, then one foot line", () => {
    const html = render([job("morning-brief"), job("site-monitor"), job("lead-calls", { dot: "red", lastStatus: "failed" }), job("meeting-sync", { active: false, dot: "amber" })]);
    expect(html.match(/data-widget-grid/g)?.length).toBe(2 + 1); // summary, jobs, and the folded paused group
    for (const t of ["Healthy", "Failing", "Paused", "Next run"]) expect(html).toContain(`>${t}<`);
    expect(html).toContain('data-job="morning-brief"');
    expect(html).toContain('data-job="lead-calls"');
    expect(html).toContain("Run now");
    expect(html).toContain("data-page-foot");
    expect(html).not.toContain("ds-ring");
  });

  test("a healthy job carries no badge; a failing one says so in one word, in the danger tone", () => {
    const html = render([job("morning-brief"), job("lead-calls", { dot: "red", lastStatus: "failed" })]);
    const morning = html.slice(html.indexOf('data-job="morning-brief"'), html.indexOf('data-job="lead-calls"'));
    expect(morning).not.toContain(">Healthy<");
    const failing = html.slice(html.indexOf('data-job="lead-calls"'));
    expect(failing).toContain(">Failing<");
    expect(failing).toContain("text-danger");
  });

  test("a paused job shows 'Paused' as its value and offers Resume, never Pause", () => {
    const html = render([job("morning-brief"), job("meeting-sync", { active: false, dot: "amber" })]);
    const paused = html.slice(html.indexOf('data-job="meeting-sync"'));
    expect(paused).toContain(">Paused<");
    expect(paused).toContain("Resume");
    expect(paused).not.toContain(">Pause<");
  });
});

describe("Websites page", () => {
  const src = read("src/routes/websites.tsx");
  test("the create and ask paths come first: make, ask Jarvis, motion graphics, skills", () => {
    for (const t of ['title="Make a site"', 'title="Ask Jarvis"', 'title="Motion graphics"', 'title="Top-tier skills"']) expect(src).toContain(t);
    const at = (s: string) => src.indexOf(s);
    expect(at('title="Make a site"')).toBeLessThan(at("<SitesGlance"));
    expect(at("<SitesGlance")).toBeLessThan(at("<MakeSite"));
    expect(at("<MakeSite")).toBeLessThan(at('id="clients"'));
    // Ask Jarvis opens the text panel; it invents no backend.
    expect(src).toContain("onClick={openJarvisText}");
    expect(src).toContain('search={{ tab: "kit" } as never}');
  });
  test("every existing section is still there; freshness and sources are one foot line", () => {
    for (const id of ['id="clients"', 'id="flagships"', 'id="previews"', 'id="local"', "<Inspiration />", "<LeadDrawer"]) expect(src).toContain(id);
    expect(src).toContain("<PageFoot>");
    expect(src).toContain("Deploys and take-downs happen only from a lead");
  });
});
