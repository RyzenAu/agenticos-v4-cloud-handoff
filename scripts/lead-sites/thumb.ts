// A thumbnail of a lead's REAL website for the Leads drawer: one headless-browser screenshot
// through the agent-browser CLI already used by site-draft QA (no Playwright dependency), cached
// in .operator-data/lead-thumbs/<id>.png. Only ever the business's own public home page.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentBrowserBin, defaultRunner, type Runner } from "../site-draft/qa";

export function thumbPath(root: string, leadId: number) {
  return join(root, ".operator-data", "lead-thumbs", `${leadId}.png`);
}

export function thumbInfo(root: string, leadId: number): { exists: boolean; at: string | null } {
  const file = thumbPath(root, leadId);
  if (!existsSync(file)) return { exists: false, at: null };
  return { exists: true, at: statSync(file).mtime.toISOString() };
}

/** Public http(s) URLs only — never a file:, localhost or private-network address. */
export function publicSiteUrl(website: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(website) && !/^https?:/i.test(website)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function captureThumb(root: string, leadId: number, website: string, runner?: Runner): Promise<string> {
  const url = publicSiteUrl(website);
  if (!url) throw new Error("This lead has no public website to capture.");
  const file = thumbPath(root, leadId);
  mkdirSync(join(root, ".operator-data", "lead-thumbs"), { recursive: true });
  // `open` launches the browser daemon, which keeps the pipes open, so its exit status isn't a
  // reliable signal (site-draft QA ignores it too): judge by whether the screenshot saved.
  const run = runner ?? defaultRunner(defaultAgentBrowserBin(), 30_000);
  const S = ["--session", `lead-thumb-${leadId}`];
  const started = Date.now() - 1000;
  const saved = () => existsSync(file) && statSync(file).mtimeMs >= started && statSync(file).size > 20_000; // a blank frame is ~5 KB
  try {
    for (const waitMs of ["2000", "5000"]) {
      await run([...S, "open", url]);
      await run([...S, "set", "viewport", "1280", "800"]);
      await run([...S, "wait", waitMs]);
      await run([...S, "screenshot", file]);
      if (saved()) return file;
    }
    throw new Error("Couldn't capture their site — it may block headless browsers or load too slowly.");
  } finally {
    await run([...S, "close"]);
  }
}
