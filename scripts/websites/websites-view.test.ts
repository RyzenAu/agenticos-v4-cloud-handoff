// Audit F3-28: viewing /websites must not queue screenshots (a write on a page view), the page says how
// many are missing or out of date instead, and a failed request reads in plain English.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screenshotErrorText, screenshotsToTake, type ThumbState, type WebsitesOverview } from "../../src/lib/websites";

const thumb = (key: string, patch: Partial<ThumbState> = {}): ThumbState => ({ key, at: "2026-09-27T00:00:00.000Z", stale: false, error: null, busy: false, ...patch });

function overview(): Pick<WebsitesOverview, "sites" | "previews" | "templates" | "drafts"> {
  const site = (id: string, t: ThumbState | null) => ({ id, kind: "flagship", name: id, vertical: "dental", url: `https://${id}.example`, alsoAt: [], project: id, linkedProject: null, deployedAt: null, repo: { path: "", exists: false, commit: null }, brief: null, thumb: t }) as WebsitesOverview["sites"][number];
  return {
    sites: [
      site("fresh", thumb("site-fresh")),
      site("missing", thumb("site-missing", { at: null, stale: true })),
      site("old", thumb("site-old", { stale: true })),
      site("taking", thumb("site-taking", { stale: true, busy: true })),
      site("failed", thumb("site-failed", { at: null, stale: true, error: "Timed out" })),
      site("none", null),
    ],
    previews: [{ leadId: 3, lead: null, previewThumb: thumb("preview-3", { stale: true }), realThumb: thumb("real-3", { at: null, stale: true, error: "Blocked" }), deployedProjectAt: null }],
    templates: [{ vertical: "dental", flagship: null, builtAt: null, kind: null, localUrl: "", thumb: thumb("tpl-dental", { stale: true, error: "Old failure" }) }],
    drafts: [{ folder: "d", name: "d", leadId: null, vertical: null, direction: null, builtAt: null, qaPass: null, localUrl: "", thumb: thumb("draft-d", { at: null, stale: true }) }],
  };
}

describe("F3-28: /websites screenshots", () => {
  test("counts what a plain request would take (thumbs.ts enqueueThumbs without force)", () => {
    // Missing, out of date, a rebuilt preview, a stale one whose last retry failed but has an image, a new draft.
    expect(screenshotsToTake(overview()).map((t) => t.key)).toEqual(["site-missing", "site-old", "preview-3", "tpl-dental", "draft-d"]);
    expect(screenshotsToTake({ sites: [], previews: [], templates: [], drafts: [] })).toEqual([]);
  });

  test("viewing the page never queues screenshots; only the button does", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "routes", "websites.tsx"), "utf8");
    const calls = [...src.matchAll(/queueScreenshots\(/g)];
    expect(calls).toHaveLength(1);
    const capture = src.indexOf("const capture = async");
    expect(capture).toBeGreaterThan(-1);
    expect(src.slice(capture, capture + 200)).toContain("queueScreenshots(");
    expect(src).toMatch(/onClick=\{\(\) => void capture\(/);
    expect(src).not.toContain("Screenshots: {queueError}");
  });

  test("failures read in plain English, never the bare transport error", () => {
    expect(screenshotErrorText(new TypeError("Failed to fetch"))).toBe("Couldn't reach Agentic OS to take screenshots. Check it's running, then try again.");
    expect(screenshotErrorText(new SyntaxError("Unexpected token '<', \"<!doctype\" is not valid JSON"))).toMatch(/^Agentic OS sent back something unexpected/);
    expect(screenshotErrorText(new Error("Request failed (500)"))).toBe("Screenshots couldn't be queued: Agentic OS answered with error 500. Try again in a minute.");
    expect(screenshotErrorText(new Error("Refresh this page and try again."))).toBe("Screenshots couldn't be queued: Refresh this page and try again.");
    expect(screenshotErrorText(undefined)).toBe("Screenshots couldn't be queued. Try again in a minute.");
    for (const e of [new TypeError("Failed to fetch"), new Error("Request failed (502)")]) expect(screenshotErrorText(e)).not.toMatch(/Failed to fetch|^Request failed/);
  });
});
