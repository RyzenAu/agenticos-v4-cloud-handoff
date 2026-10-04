// Track 8 (UI truth), audit F2 STU-1 and STU-2: Studio counts only assets that exist, says when agent
// capture isn't set up, and a failed "Make it" shows the server's reason. Synthetic data, no network.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { AgentTiles, summariseLedger } from "../src/components/shell/pages/studio-page";
import { chatHttpError } from "../src/lib/chat-prompt";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/studio"] }) });
const render = (el: React.ReactElement) => renderToStaticMarkup(<RouterContextProvider router={router}>{el}</RouterContextProvider>);

const item = (agent: string, ts: number, alive: boolean) => ({ agent, ts, alive, path: `D:/synthetic/${agent}-${ts}.png` });

test("STU-1: deleted files (alive:false) are not counted, overall or per agent", () => {
  // The server's raw total (4) counts the deleted file; only 3 exist.
  const s = summariseLedger({ total: 4, armed: true, items: [item("claude", 1, true), item("claude", 2, false), item("hermes", 3, true), item("studio", 4, true)] });
  expect(s.total).toBe(3);
  expect(s.missing).toBe(1);
  expect(s.byAgent).toEqual({ claude: 1, hermes: 1, studio: 1 });
  expect(s.newest).toBe(4);
  // The newest *existing* asset dates the tile, not a deleted one.
  expect(summariseLedger({ items: [item("claude", 9, false), item("claude", 5, true)] }).newest).toBe(5);
});

test("STU-1: capture not armed → a 'Not set up' tile instead of 'Made by …' zeros", () => {
  const html = render(<AgentTiles summary={summariseLedger({ armed: false, items: [] })} />);
  expect(html).toContain("Agent media capture");
  expect(html).toContain("Not set up");
  expect(html).not.toContain("Made by");
  const armed = render(<AgentTiles summary={summariseLedger({ armed: true, items: [item("claude", 1, true), item("hermes", 2, false)] })} />);
  expect(armed).toContain("Made by Claude");
  expect(armed).not.toContain("Made by Hermes"); // its only asset was deleted
  expect(armed).not.toContain("Agent media capture");
});

test("STU-2: a refused 'Make it' carries the server's reason, not 'Claude lane unavailable'", async () => {
  const quiet = Response.json({ error: "This is a quiet read-only copy (AGENTIC_OS_NO_BACKGROUND=1). Use the main app on 127.0.0.1:8081." }, { status: 409 });
  expect((await chatHttpError(quiet)).message).toContain("quiet read-only copy");
  const src = readFileSync(join(import.meta.dir, "../src/routes/design.tsx"), "utf8");
  expect(src).not.toContain('throw new Error("Claude lane unavailable")');
  expect(src).toContain("if (!r.ok || !r.body) throw await chatHttpError(r);");
});
