import { expect, test } from "bun:test";
import { leadSitesPlugin } from "./plugin";
import { previewServerState } from "./preview-server";

// A quiet copy (AGENTIC_OS_NO_BACKGROUND=1) runs beside the live OS on 8081 -- a perf run or the
// desktop supervisor's preview-port test. It must never take 127.0.0.1:8091 (the live copy's
// lead-preview listener), or the live previews break with EADDRINUSE.
test("a quiet copy never starts the 8091 lead-preview listener", () => {
  const G = globalThis as { __muPreviewServer?: unknown };
  const saved = G.__muPreviewServer;
  const before = process.env.AGENTIC_OS_NO_BACKGROUND;
  delete G.__muPreviewServer;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    const plugin = leadSitesPlugin({ root: process.cwd(), token: "t", draftsRoot: process.cwd() });
    const mounted: string[] = [];
    const server = { middlewares: { use: (path: string) => { mounted.push(path); } } };
    (plugin.configureServer as (s: unknown) => void)(server);
    expect(previewServerState()).toBeNull();
    // The read routes still mount, so the quiet copy's Sales pages render.
    expect(mounted).toContain("/__lead-sites");
  } finally {
    if (before === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
    else process.env.AGENTIC_OS_NO_BACKGROUND = before;
    G.__muPreviewServer = saved;
  }
});
