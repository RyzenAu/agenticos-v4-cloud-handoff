// Sales -> Website data: client-hub parsing, the Vercel listing parser, the screenshot queue and the
// overview — against temp folders and a fake browser runner (never Vercel, never a real site).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftInfo, parseClientBrief, parseDay, parseVercelProjects, type OurSite } from "./catalogue";
import { websitesOverview, thumbTargets } from "./plugin";
import { captureShot, enqueueThumbs, isThumbKey, thumbFile, thumbsIdle, thumbState } from "./thumbs";

const base = mkdtempSync(join(tmpdir(), "mu-websites-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const put = (file: string, body = "x") => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
};

const HUB = `# Harbour Realty — Client Hub
*Last updated: 2026-09-24 · Owner: Usman · Status: ACTIVE BUILD (first paying client)*

| Trading name | Harbour Realty |
| Approver | Jo Citizen — mobile 0400 000 000 |

## 3 · Status timeline

| Date | Event |
|---|---|
| 17 Sep 2026 | Agreement signed |
| **~26 Sep 2026** | **Preview due** |
| **~13 Oct 2026** | **Target launch** (3 weeks from start) |

## 5 · Delivery checklist

- [x] Kick-off call
- [ ] **Preview to Jo by Fri 26 Sep 2026** (promised by email)
- [ ] Build the listing page
      from the supplied photos
- [ ] Final invoice

## 6 · Next actions

- [ ] not part of the checklist
`;

describe("client hub", () => {
  test("status, dates and checklist progress come out; contact details don't", () => {
    const brief = parseClientBrief(HUB);
    expect(brief).toEqual({
      status: "Active build",
      updated: "2026-09-24",
      previewDue: "2026-09-26",
      launchTarget: "2026-10-13",
      checklist: { done: 1, total: 4, next: "Preview to Jo by Fri 26 Sep 2026 (promised by email)" },
    });
    expect(JSON.stringify(brief)).not.toContain("0400");
  });
  test("parseDay", () => {
    expect(parseDay("~13 Oct 2026")).toBe("2026-10-13");
    expect(parseDay("1 September 2026")).toBe("2026-09-01");
    expect(parseDay("soon")).toBeNull();
  });
  test("a hub without the sections gives nulls, not a crash", () => {
    expect(parseClientBrief("# nothing here")).toEqual({ status: null, updated: null, previewDue: null, launchTarget: null, checklist: { done: 0, total: 0, next: null } });
  });
});

describe("vercel listing", () => {
  test("keeps name, production URL and update time only", () => {
    const out = `Vercel CLI 59\n{"projects":[{"name":"muv-demo-dental","id":"prj_x","latestProductionUrl":"https://muv-demo-dental.vercel.app","updatedAt":1790256968225}]}\n`;
    expect(parseVercelProjects(out)).toEqual([{ name: "muv-demo-dental", url: "https://muv-demo-dental.vercel.app", updatedAt: new Date(1790256968225).toISOString() }]);
    expect(() => parseVercelProjects("Error: not logged in")).toThrow();
  });
});

describe("screenshots", () => {
  test("keys are a closed vocabulary, never a URL", () => {
    expect(isThumbKey("site-bianca")).toBe(true);
    expect(isThumbKey("preview-194")).toBe(true);
    expect(isThumbKey("https://evil.example")).toBe(false);
    expect(isThumbKey("site-../../x")).toBe(false);
    expect(isThumbKey("other-1")).toBe(false);
  });

  test("the queue captures missing shots once, as JPEG, then reports them fresh", async () => {
    const root = join(base, "q-os");
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("screenshot")) put(args[args.length - 1], "j".repeat(10_000));
      return { stdout: "", ok: true };
    };
    const target = { key: "site-test", kind: "live" as const, url: "https://example.muventures.com.au" };
    expect(thumbState(root, target).stale).toBe(true);
    expect(enqueueThumbs(root, [target], { runner })).toEqual(["site-test"]);
    await thumbsIdle();
    const state = thumbState(root, target);
    expect(state.at).not.toBeNull();
    expect(state.stale).toBe(false);
    expect(thumbFile(root, target).endsWith("site-test.jpg")).toBe(true);
    expect(calls.some((c) => c.includes("--screenshot-format") && c.includes("jpeg"))).toBe(true);
    expect(calls.at(-1)).toContain("close");
    expect(enqueueThumbs(root, [target], { runner })).toEqual([]); // fresh: nothing to do
    expect(enqueueThumbs(root, [target], { runner, force: true })).toEqual(["site-test"]);
    await thumbsIdle();
  });

  test("a local preview's shot goes stale when its index.html changes", async () => {
    const root = join(base, "stale-os");
    const source = join(base, "stale-site", "index.html");
    put(source, "<h1>v1</h1>");
    const target = { key: "tpl-dental", kind: "local" as const, url: "http://tpl--dental.localhost:8091/", source };
    put(thumbFile(root, target), "j".repeat(10_000));
    const shotAt = statSync(thumbFile(root, target)).mtimeMs;
    expect(thumbState(root, target).stale).toBe(false);
    const { utimesSync } = await import("node:fs");
    utimesSync(source, new Date(shotAt + 5000), new Date(shotAt + 5000));
    expect(thumbState(root, target).stale).toBe(true);
  });

  test("a page that never renders fails with a clear message", async () => {
    const runner = async () => ({ stdout: "", ok: false });
    await expect(captureShot(runner, [], "https://x.example", join(base, "never", "a.jpg"))).rejects.toThrow(/Couldn't capture/);
  });
});

describe("overview", () => {
  test("our sites, previews, templates and drafts from the folders on disk", async () => {
    const root = join(base, "repos", "os");
    const drafts = join(base, "drafts");
    const repos = join(base, "repos");
    put(join(repos, "harbour", "CLIENT.md"), HUB);
    put(join(repos, "harbour", ".vercel", "project.json"), JSON.stringify({ projectId: "prj_secretish", orgId: "team_x", projectName: "harbour-realty" }));
    put(join(drafts, "_templates", "dental", "index.html"), "<h1>t</h1>");
    put(join(drafts, "_templates", "dental", "template.json"), JSON.stringify({ vertical: "dental", flagship: "Lantern Dental", builtAt: "2026-09-24T15:35:37.487Z", kind: "next-export" }));
    put(join(drafts, "wish-real-estate", "index.html"), "<h1>d</h1>");
    put(join(drafts, "wish-real-estate", "evidence.json"), JSON.stringify({ leadId: 31, name: "Wish Real Estate", vertical: "real-estate" }));
    put(join(drafts, "wish-real-estate", "direction.json"), JSON.stringify({ name: "Brick and Jacaranda" }));
    put(join(drafts, "wish-real-estate", "qa.json"), JSON.stringify({ pass: true }));
    put(join(drafts, "harbour-dental", "flagship-preview", "index.html"), "<h1>p</h1>");
    put(join(root, ".operator-data", "lead-sites.json"), JSON.stringify({ version: 1, previews: [{ leadId: 7, slug: "harbour-dental", dir: join(drafts, "harbour-dental", "flagship-preview"), project: "mu-preview-harbour-dental", status: "generated" }] }));
    put(join(root, ".operator-data", "websites-vercel.json"), JSON.stringify({ at: new Date().toISOString(), projects: [{ name: "harbour-realty", url: "https://harbour.muventures.com.au", updatedAt: "2026-09-24T16:51:19.135Z" }] }));
    const sites: OurSite[] = [{ id: "harbour", kind: "client", name: "Harbour Realty", vertical: "real-estate", url: "https://harbour.muventures.com.au", alsoAt: [], project: "harbour-realty", repo: "harbour", brief: "CLIENT.md" }];

    const o = await websitesOverview({ root, draftsRoot: drafts, reposRoot: repos, sites, vercel: false });
    expect(o.sites[0]).toMatchObject({ id: "harbour", linkedProject: "harbour-realty", deployedAt: "2026-09-24T16:51:19.135Z", brief: { previewDue: "2026-09-26" } });
    expect(JSON.stringify(o)).not.toContain("prj_secretish");
    expect(o.previews.map((p) => p.leadId)).toEqual([7]);
    expect(o.templates).toEqual([expect.objectContaining({ vertical: "dental", flagship: "Lantern Dental", localUrl: "http://tpl--dental.localhost:8091/" })]);
    expect(o.drafts).toEqual([expect.objectContaining({ folder: "wish-real-estate", leadId: 31, direction: "Brick and Jacaranda", qaPass: true, localUrl: "http://draft--wish-real-estate.localhost:8091/" })]);
    const keys = thumbTargets({ root, draftsRoot: drafts, sites }).map((t) => t.key);
    expect(keys).toEqual(["site-harbour", "preview-7", "tpl-dental", "draft-wish-real-estate"]);
  });

  test("draftInfo falls back to the folder name", () => {
    put(join(base, "bare", "plain-draft", "index.html"), "<h1>x</h1>");
    expect(draftInfo(join(base, "bare"), "plain-draft")).toMatchObject({ name: "plain draft", leadId: null, vertical: null, qaPass: null });
  });
});
