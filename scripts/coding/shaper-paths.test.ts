// Shaper defects found in live jobs (1 Oct 2026): a path with a space was split into a bogus new file, and two jobs
// were drafted with the same model as builder AND reviewer. Synthetic only: no Jev, no planner, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, RepoRegistryEntry, TaskSpec, VerifiedPrincipal } from "./contracts";
import type { ChoiceEnv, CodingModelPrefs } from "./role-choice";
import { absolutePathsIn, createShaper, heuristicPlan, repoOwns } from "./shaper";
import { cleanup, fixtureRepo } from "./test-fixtures";

const LIVE = "C:/Users/Nebula PC/source/repos/AgenticOS-v4/docs/creative-20261001/BRIEF.md";
const fx = fixtureRepo();
const roots = [fx.root];
afterAll(() => { for (const r of roots) cleanup(r); });
/** The registered AgenticOS repo as it is on this PC (the path only has to exist as a string). */
const AOS = { ...fx.entry, canonicalPath: "C:/Users/Nebula PC/source/repos/AgenticOS-v4" } as RepoRegistryEntry;
const owned = (p: ReturnType<typeof heuristicPlan>) => p!.builders.flatMap((b) => [...b.owns.globs, ...b.owns.newFiles]);

describe("a path with a space parses whole, and an outside absolute path is never owned", () => {
  test("the live defect: 'Nebula PC/source/...' is no longer recorded as a new file", () => {
    const p = heuristicPlan(fx.entry, "Write the brief", `Write the brief to ${LIVE} for the film. Also fix src/a.ts.`);
    expect(owned(p)).toEqual(["src/a.ts"]);
    expect(JSON.stringify(p)).not.toContain("PC/source");
    expect(JSON.stringify(p)).not.toContain("Nebula");
  });
  test("an outside absolute path alone drafts no plan at all (the planner or a question decides)", () => {
    expect(heuristicPlan(fx.entry, "Write the brief", `Write the brief to ${LIVE}.`)).toBeNull();
  });
  test("inside its own repo, the same path is one whole repo-relative new file", () => {
    const p = heuristicPlan(AOS, "Write the brief", `Write the brief to ${LIVE}.`);
    // Owned once, as a repo-relative path (a glob if the file already exists on this PC, else a new file).
    expect(owned(p)).toEqual(["docs/creative-20261001/BRIEF.md"]);
    // Case and slash style of the drive path don't matter on Windows.
    const q = heuristicPlan(AOS, "Write the brief", "write c:\\Users\\Nebula PC\\source\\repos\\agenticos-v4\\docs\\creative-20261001\\BRIEF.md now");
    expect(owned(q)).toEqual(["docs/creative-20261001/BRIEF.md"]);
  });
  test.each([
    ["a drive path with backslashes", "Update D:\\Other Folder\\notes\\plan.md please"],
    ["a POSIX absolute path", "Update /etc/hosts/extra.txt please"],
    ["a home path", "Update ~/notes/plan.md please"],
    ["a parent escape", `Update ${AOS.canonicalPath}/../Other Repo/x.md please`],
    ["a drive path with a space and no extension", "Fix everything under C:/Users/Nebula PC/Documents/stuff/"],
  ])("%s never becomes an owned file or folder", (_n, text) => {
    expect(heuristicPlan(fx.entry, "x", text)).toBeNull();
    expect(heuristicPlan(AOS, "x", text)).toBeNull();
  });
  test("relative paths are read exactly as before", () => {
    const p = heuristicPlan(fx.entry, "x", "Change src/a.ts and add lib/new-file.ts, plus everything in docs/");
    expect(p!.builders[0].owns.globs).toEqual(expect.arrayContaining(["src/a.ts", "docs/**"]));
    expect(p!.builders[0].owns.newFiles).toEqual(["lib/new-file.ts"]);
  });
  test("absolutePathsIn sorts the paths into inside and outside", () => {
    const r = absolutePathsIn(AOS, `Edit ${LIVE} and C:/Elsewhere/My Docs/c.ts and scripts/x.ts.`);
    expect(r.inside).toEqual(["docs/creative-20261001/BRIEF.md"]);
    expect(r.outside).toEqual(["C:/Elsewhere/My Docs/c.ts"]);
    expect(r.rest).toContain("scripts/x.ts");
    expect(r.rest).not.toContain("Nebula");
  });
  test("a plan from the planner is cleaned the same way: outside absolutes dropped, inside ones made relative", () => {
    expect(repoOwns(AOS, { globs: ["src/**", "D:/x/y/**"], newFiles: [LIVE, "C:/Users/Nebula PC/Desktop/out.md", "docs/ok.md"] }))
      .toEqual({ globs: ["src/**"], newFiles: ["docs/creative-20261001/BRIEF.md", "docs/ok.md"] });
  });
  test("end to end: a drafted job never owns the outside path", async () => {
    const s = shaperWith();
    const r = await draftOf(s, `Fix the login bug in src/a.ts so the form submits. Also keep notes in ${LIVE}.`);
    const owns = r.roles.flatMap((x) => (x.owns ? [...x.owns.globs, ...x.owns.newFiles] : []));
    expect(owns).toContain("src/a.ts");
    expect(owns.join(" ")).not.toMatch(/Nebula|PC\/source/);
  });
});

// ─────────────────────────── an independent reviewer ───────────────────────────

const healthyRoute = ((_t: string, c: { selected?: string }) => ({ model: c.selected, fallbackFrom: null })) as unknown as ChoiceEnv["route"];
const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
function shaperWith(prefs?: CodingModelPrefs, route: ChoiceEnv["route"] = healthyRoute, over: Partial<ChoiceEnv> = {}) {
  const f = fixtureRepo();
  roots.push(f.root);
  const registry: RepoRegistry = { version: 1, repos: [{ ...f.entry, id: "fixture-app" as never, description: "the synthetic fixture app" }] };
  return createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, prefs: prefs ? () => prefs : undefined, choice: () => ({ route, hasKey: () => true, readings: [], ...over }) });
}
async function draftOf(s: ReturnType<typeof shaperWith>, utterance: string): Promise<TaskSpec> {
  const r = await s.shape({ utterance, channel: "typed", principal, usePlanner: false });
  if (r.kind !== "draft") throw new Error(JSON.stringify(r));
  return r.spec;
}
const modelOf = (spec: TaskSpec, role: string) => spec.roles.find((r) => r.role === role)?.agent?.model;
const FREE = ["cline/deepseek-v4.1-flash", "cline/mimo-v2.6-flash", "cline/muse-spark-1.3"];

describe("a draft never pairs the builder and the reviewer on one model", () => {
  test("the live defect: Cline DeepSeek named for both roles gives a different reviewer", async () => {
    const spec = await draftOf(shaperWith(), "Fix the login bug in src/a.ts so the form submits. Cline DeepSeek builds and Cline DeepSeek reviews.");
    expect(modelOf(spec, "builder")).toBe("cline/deepseek-v4.1-flash");
    expect(modelOf(spec, "reviewer")).toBeDefined();
    expect(modelOf(spec, "reviewer")).not.toBe(modelOf(spec, "builder"));
  });
  test("free-only: builder and reviewer are two different free routes, however the words read", async () => {
    const s = shaperWith({ freeOnly: true, allowPaidFallback: true });
    for (const words of [
      "Fix the login bug in src/a.ts so the form submits. DeepSeek builds. DeepSeek reviews.",
      "Fix the login bug in src/a.ts so the form submits. Use Cline for the build and Cline for the review.",
      "Fix the login bug in src/a.ts so the form submits. MiMo builds and reviews it.",
      "Fix the login bug in src/a.ts so the form submits.",
    ]) {
      const spec = await draftOf(s, words);
      expect(FREE).toContain(modelOf(spec, "builder")!);
      expect(FREE).toContain(modelOf(spec, "reviewer")!);
      expect(modelOf(spec, "reviewer")).not.toBe(modelOf(spec, "builder"));
    }
  });
  test("a named builder alone keeps its model and the reviewer is picked as a different one", async () => {
    const spec = await draftOf(shaperWith(), "Fix the login bug in src/a.ts so the form submits. Opus builds.");
    expect(modelOf(spec, "builder")).toBe("claude-opus-5-5");
    expect(modelOf(spec, "reviewer")).not.toBe("claude-opus-5-5");
  });
  test("pickRoles (the voice edit path) holds the same rule when both roles are named alike", () => {
    const s = shaperWith({ freeOnly: true, allowPaidFallback: true });
    const mimo = s.bindingFromWords("MiMo")!;
    const r = s.pickRoles("fix it", "build+review", { builder: mimo, reviewer: mimo });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.binding.model).toBe("cline/mimo-v2.6-flash");
    expect(r.reviewer!.binding.model).not.toBe("cline/mimo-v2.6-flash");
  });
  test("when nothing else can review, the draft is refused with the way out instead of pairing one model", async () => {
    // Only one free route is healthy and free-only is on: there is no second model to review.
    const oneRoute = ((_t: string, c: { selected?: string }) => { if (c.selected !== "cline/mimo-v2.6-flash") throw new Error("down"); return { model: c.selected, fallbackFrom: null }; }) as unknown as ChoiceEnv["route"];
    const s = shaperWith({ freeOnly: true, allowPaidFallback: true }, oneRoute);
    const r = await s.shape({ utterance: "Fix the login bug in src/a.ts so the form submits. MiMo builds.", channel: "typed", principal, usePlanner: false });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toMatch(/both be Cline MiMo.*no other model can review/);
  });
});

describe("the owner can ask for a fresh session of the same model, in so many words", () => {
  test("'Opus builds, another Opus reviews' is kept as named (voice-f4's draft), and says so", async () => {
    const r = await shaperWith().shape({ utterance: "Fix the login bug in src/a.ts so the form submits. Opus builds, another Opus reviews.", channel: "voice", principal, usePlanner: false });
    if (r.kind !== "draft") throw new Error(JSON.stringify(r));
    expect(modelOf(r.spec, "builder")).toBe("claude-opus-5-5");
    expect(modelOf(r.spec, "reviewer")).toBe("claude-opus-5-5");
    expect(r.spokenSummary).toContain("Opus builds");
    expect(r.spokenSummary).toContain("Opus reviews");
  });
  test("without 'another', two plain mentions of one model are still split", async () => {
    const spec = await draftOf(shaperWith(), "Fix the login bug in src/a.ts so the form submits. Opus builds. Opus reviews.");
    expect(modelOf(spec, "reviewer")).not.toBe(modelOf(spec, "builder"));
  });
});

describe("absolute planner globs and path edges (review defects 5 and 6)", () => {
  const APP = { canonicalPath: "C:/Users/Nebula PC/source/repos/app" };
  test("absolute globs under the repo stay whole; empty results are dropped", () => {
    expect(repoOwns(APP, { globs: ["C:/Users/Nebula PC/source/repos/app/src/**", "C:/Users/Nebula PC/source/repos/app/**", "C:/Users/Nebula PC/source/repos/app/lib/*"], newFiles: [] }))
      .toEqual({ globs: ["src/**", "**", "lib/*"], newFiles: [] });
    expect(repoOwns(APP, { globs: ["C:/Users/Nebula PC/source/repos/app/"], newFiles: ["C:/Users/Nebula PC/source/repos/app"] })).toEqual({ globs: [], newFiles: [] });
  });
  test("a file name with a space parses whole, and nothing is left to be read as a root file", () => {
    const r = absolutePathsIn(APP, "Update C:/Users/Nebula PC/source/repos/app/Docs/Read Me.md please");
    expect(r.inside).toEqual(["Docs/Read Me.md"]);
    expect(r.rest).not.toMatch(/Me\.md|Read/);
    const p = heuristicPlan({ ...fx.entry, canonicalPath: APP.canonicalPath } as RepoRegistryEntry, "x", "Update C:/Users/Nebula PC/source/repos/app/Docs/Read Me.md please");
    expect(owned(p)).toEqual(["Docs/Read Me.md"]);
  });
  test("two drive paths in one sentence are two paths, not one", () => {
    const r = absolutePathsIn(APP, "Edit C:/Users/Nebula PC/source/repos/app/src/a.ts And C:/Elsewhere/x.ts today");
    expect(r.inside).toEqual(["src/a.ts"]);
    expect(r.outside).toEqual(["C:/Elsewhere/x.ts"]);
    expect(r.rest).not.toMatch(/\bAnd\b|x\.ts/);
    const p = heuristicPlan({ ...fx.entry, canonicalPath: APP.canonicalPath } as RepoRegistryEntry, "x", "Edit C:/Users/Nebula PC/source/repos/app/src/a.ts And C:/Elsewhere/x.ts today");
    expect(owned(p).join(" ")).not.toMatch(/And|Elsewhere|x\.ts/);
  });
  test("a relative file named after an absolute path is still read", () => {
    const p = heuristicPlan(fx.entry, "x", "Edit C:/Elsewhere/My Docs/c.ts and src/a.ts");
    expect(owned(p)).toEqual(["src/a.ts"]);
  });
});
