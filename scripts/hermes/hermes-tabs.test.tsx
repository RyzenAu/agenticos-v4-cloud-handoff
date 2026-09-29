// L4 (29 Sep 2026): the Hermes page loads only its Overview. Chat, skills, memory, personas, mission and
// files each mount the first time their tab is opened. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { HERMES_TABS, HermesPage } from "../../src/routes/-pages/hermes";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", "..", p), "utf8");
const render = (client: QueryClient, node: ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </RouterContextProvider>,
  );
};

const status = {
  installed: true,
  binPath: "C:/synthetic/hermes.exe",
  version: "Hermes Agent v0.21.3 (2026.9.14)",
  configured: true,
  defaultModel: "synthetic-model",
  provider: "openai-codex",
  providerKeyName: null,
  hasProviderKey: true,
  needsSetup: false,
  envPath: "C:/synthetic/.env",
};

function seeded() {
  const client = new QueryClient();
  // Demo mode is off on the server (no window), so every query key ends in `false`.
  client.setQueryData(["hermes-status", false], status);
  client.setQueryData(["hermes-memory", false], {
    hermesHome: "C:/synthetic/.hermes",
    user: { content: "", charCount: 300, charLimit: 1375, path: "" },
    memory: { content: "", charCount: 200, charLimit: 2200, path: "" },
    soul: { content: "", charCount: 0, isTemplate: true, path: "" },
    provider: { active: null, available: [] },
    profiles: [],
    sessionCount: 2,
    skillCount: 3,
  });
  client.setQueryData(["hermes-skills", false], {
    skills: [
      { id: "research", description: "", subskills: ["arxiv", "web"] },
      { id: "creative", description: "", subskills: ["video"] },
    ],
  });
  client.setQueryData(["hermes-sessions", false], {
    sessions: [{ id: "s1", model: "synthetic-model", platform: "cli", messageCount: 4, startedAt: "2026-09-29T01:00:00.000Z", lastUpdated: "2026-09-29T01:05:00.000Z", firstUserMessage: "hi" }],
  });
  client.setQueryData(["hermes-connections", false], { connections: [{ kind: "provider", name: "openai-codex", slug: "openai-codex", status: "connected" }] });
  client.setQueryData(["hermes-owner-profile"], { state: { path: "x", exists: false, limit: 1375, current: [], others: [], proposed: [], inSync: false, usageAfter: 0, fits: true, sources: [], warnings: [] } });
  client.setQueryData(["hermes-skill-sync"], { report: null, running: false });
  return client;
}

describe("Hermes tabs (L4)", () => {
  test("seven tabs, Overview first", () => {
    expect(HERMES_TABS.map((t) => t.id)).toEqual(["overview", "chat", "skills", "memory", "personas", "mission", "files"]);
  });

  test("the first render is the Overview: status widgets, live stats, profile and skills", () => {
    const html = render(seeded(), <HermesPage />);
    for (const s of ["Overview", "Chat", "Skills", "Memory", "Personas", "Mission", "Files and commands"]) expect(html).toContain(s);
    // The four status widgets, with real values.
    expect(html).toContain("v0.21.3");
    expect(html).toContain("synthetic-model");
    expect(html).toContain("via openai-codex");
    expect(html).toContain("14%"); // (300 + 200) of (1375 + 2200) characters
    expect(html).toContain("in 2 categories");
    expect(html).toContain(">3<"); // three skills across two categories
    // The identity and skills cards are still on the first screen.
    expect(html).toContain("Who Hermes thinks you are");
    expect(html).toContain("Your skills in Hermes");
    // Everything heavy stays unmounted until its tab is opened.
    expect(html).not.toContain("Ask Hermes anything");
    expect(html).not.toContain("Pantheon");
    expect(html).not.toContain("Mission Control");
    expect(html).not.toContain("Documents");
    expect(html).not.toContain("hermes profile");
  });

  test("one headline sentence, and no sentence-long badge", () => {
    const html = render(seeded(), <HermesPage />);
    expect(html).toContain("Running synthetic-model. Ask it anything, or see what it knows about you.");
  });

  test("the other tabs mount lazily: each panel is only rendered once visited, and hidden when not active", () => {
    const src = read("src/routes/-pages/hermes.tsx");
    const tabs = src.slice(src.indexOf("function HermesTabs"), src.indexOf("const fmtChars"));
    expect(tabs).toContain("visited.has(id)");
    expect(tabs).toContain("active={tab === id}");
    for (const [id, body] of [
      ["chat", "<HermesChat status={status} yolo />"],
      ["skills", "<HermesLiveSkills />"],
      ["memory", "<HermesMemorySection />"],
      ["personas", "<HermesProfileTemplates />"],
      ["mission", '<HermesMissionControl agent="hermes" />'],
      ["files", "<HermesDocumentsGallery />"],
    ] as const) {
      expect(tabs).toMatch(new RegExp(`panel\\(\\s*"${id}"`));
      expect(tabs).toContain(body);
    }
    // The old page mounted all of them in one scroll.
    expect(src).not.toContain("function HermesStatsSection");
    expect(src.split("<HermesChat status={status} yolo />").length - 1).toBe(1);
  });

  test("no text under 13 px is left in the Hermes page sources", () => {
    for (const f of ["src/routes/-pages/hermes.tsx", "src/components/hermes-mission-control.tsx", "src/components/hermes-documents-gallery.tsx"]) {
      const src = read(f);
      expect(src.match(/text-\[(9|10|11|12)(\.5)?px\]/g) ?? []).toEqual([]);
      expect(src.match(/fontSize:\s*(9|10|11|12)(\.5)?\b(?!\d)/g) ?? []).toEqual([]);
    }
  });
});
