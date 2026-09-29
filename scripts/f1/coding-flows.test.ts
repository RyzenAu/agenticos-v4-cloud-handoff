import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommandIndex, resolveCommand } from "../../src/lib/commands/registry";
import { isCodingRequest } from "../../src/lib/commands/coding";
import { siteRequestFromWords } from "../../src/lib/commands/site-maker";
import { buildSiteRequest, isSiteRequest, PRESET_SKILLS, siteBrief, skillsInRequest } from "../../src/lib/site-maker";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { route } from "../model-router/router";
import { DEFAULT_ACCOUNTS } from "../coding/accounts";
import type { CodingJob, RepoRegistry, RepoRegistryEntry, VerifiedPrincipal } from "../coding/contracts";
import { createOrchestrator } from "../coding/orchestrator";
import { defaultRegistryFile, loadRegistryLayered, validateRegistry } from "../coding/registry";
import { claudeRunner } from "../coding/runners/claude";
import { codexRunner } from "../coding/runners/codex";
import { FakeClaude, FakeCodex, type ClaudeStep } from "../coding/runners/fakes";
import { routerRunner } from "../coding/runners/router";
import { createShaper, draftTitle, spokenSummary, type PlannerDraft } from "../coding/shaper";
import { validateSpec } from "../coding/spec";
import { CodingStore } from "../coding/store";
import { cleanup, fixtureRepo, gitIn, tempRoot, type FixtureRepo } from "../coding/test-fixtures";
import { createCodingVoice } from "../coding/voice";
import { git } from "../coding/worktree";

/**
 * F1 flows 1 and 2, on synthetic repos with fake agent CLIs only: nothing here touches a real checkout, the
 * live .operator-data, a real Claude or Codex, the network, or a real repo of the owner's.
 *   1. Make a site: the default registry (config/coding-repos.defaults.json), the site plan, the skills' brief,
 *      "Draft ready: <title>. Say start when you want it built.", nothing changes until start.
 *   2. Start a coding job by voice or typing: "start a coding job to fix X in <repo>".
 */

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });
const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
const versions = () => ({ claude: "2.1.280", codex: "0.154.0" });

// ─────────────────────────── the default registry ───────────────────────────

describe("F1 flow 1: the default site registry", () => {
  const defaults = join(import.meta.dir, "..", "..", "config", "coding-repos.defaults.json");

  test("the repo's defaults file validates with the registry's own rules and holds the five site repos", () => {
    const parsed = JSON.parse(readFileSync(defaults, "utf8"));
    const registry = validateRegistry(parsed);
    expect(registry.repos.map((r) => r.id).sort()).toEqual(["aldergate", "muv-demo-conveyancing", "muv-demo-dental", "muv-flagship-legal", "muv-marketing"]);
    for (const r of registry.repos) {
      expect(r.canonicalPath.startsWith("C:\\Users\\Nebula PC\\source\\repos\\")).toBe(true);
      expect(r.allowedPeople).toEqual(["usman", "mehroz"]);
      expect(r.commands.length).toBeGreaterThan(0);
      // Remote deployment classes are unknown in this source snapshot; a live owner registry can add them.
      expect(r.remotes).toEqual([]);
    }
    expect(registry.repos.find((r) => r.id === "muv-flagship-legal")!.remotes).toEqual([]);
    // Worktrees never live inside a checkout, and the always-protected branches are present.
    for (const r of registry.repos) expect(r.protectedBranches).toEqual(expect.arrayContaining(["main", "master", "production"]));
  });

  test("layered: no live file uses the defaults; a live entry overrides by id; extras are added; the live file is never written", () => {
    const root = tempRoot("f1-registry-");
    roots.push(root);
    const live = join(root, "repos.json");
    expect(existsSync(live)).toBe(false);
    const none = loadRegistryLayered(live, defaults);
    expect(none.registry.repos).toHaveLength(5);
    expect(none.liveError).toBeNull();
    expect(none.fromDefaults).toHaveLength(5);
    expect(existsSync(live)).toBe(false); // reading never creates the live file

    const base = JSON.parse(readFileSync(defaults, "utf8")).repos[1] as RepoRegistryEntry;
    const overridden = { ...base, description: "Dental flagship (owner's own entry)" };
    const extra = { ...base, id: "mu-receptionist", description: "Receptionist app", canonicalPath: "D:\\MU-Receptionist", worktreeParent: "D:\\_coding-worktrees\\mu-receptionist" };
    writeFileSync(live, JSON.stringify({ version: 1, repos: [overridden, extra] }));
    const before = readFileSync(live, "utf8");
    const merged = loadRegistryLayered(live, defaults);
    expect(merged.registry.repos.map((r) => r.id).sort()).toEqual(["aldergate", "mu-receptionist", "muv-demo-conveyancing", "muv-demo-dental", "muv-flagship-legal", "muv-marketing"]);
    expect(merged.registry.repos.find((r) => r.id === "muv-demo-dental")!.description).toBe("Dental flagship (owner's own entry)");
    expect(merged.fromLive.sort()).toEqual(["mu-receptionist", "muv-demo-dental"]);
    expect(readFileSync(live, "utf8")).toBe(before);
  });

  test("a bad live file is named and ignored (the defaults keep working); a bad defaults file leaves the live one; 'off' disables the defaults", () => {
    const root = tempRoot("f1-registry-bad-");
    roots.push(root);
    const live = join(root, "repos.json");
    writeFileSync(live, "{ not json");
    const bad = loadRegistryLayered(live, defaults);
    expect(bad.registry.repos).toHaveLength(5);
    expect(bad.liveError).toContain("not valid JSON");

    // Two entries at one checkout under different ids: invalid together, so the defaults alone are used.
    const first = JSON.parse(readFileSync(defaults, "utf8")).repos[0] as RepoRegistryEntry;
    writeFileSync(live, JSON.stringify({ version: 1, repos: [{ ...first, id: "marketing-copy" }] }));
    const clash = loadRegistryLayered(live, defaults);
    expect(clash.registry.repos.map((r) => r.id)).not.toContain("marketing-copy");
    expect(clash.liveError).toContain("same checkout");

    const badDefaults = join(root, "defaults.json");
    writeFileSync(badDefaults, JSON.stringify({ version: 1, repos: [{ id: "x" }] }));
    writeFileSync(live, JSON.stringify({ version: 1, repos: [first] }));
    const only = loadRegistryLayered(live, badDefaults);
    expect(only.registry.repos.map((r) => r.id)).toEqual([first.id]);
    expect(only.defaultsError).toBeTruthy();

    expect(defaultRegistryFile("C:/x", { CODING_REGISTRY_DEFAULTS: "off" })).toBeNull();
    expect(defaultRegistryFile("C:/x", {})?.replace(/\\/g, "/")).toBe("C:/x/config/coding-repos.defaults.json");
    expect(loadRegistryLayered(join(root, "none.json"), null).registry.repos).toEqual([]);
  });
});

// ─────────────────────────── fixtures ───────────────────────────

const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
/** A synthetic site repo under the given registry id, with the build check a real repo would have. */
function siteFixture(id: string, description: string): FixtureRepo {
  const fx = fixtureRepo();
  roots.push(fx.root);
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const baseSha = gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never;
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  const entry: RepoRegistryEntry = { ...fx.entry, id: id as never, description, commands: [{ id: `${id}.build` as never, kind: "build", argv, cwd: ".", timeoutMs: 60_000, counts: "none" }] };
  return { ...fx, baseSha, entry };
}
const snapshotOf = (fx: FixtureRepo) => JSON.stringify({
  status: gitIn(fx.canonical, "status", "--porcelain=v1", "-z"),
  branches: gitIn(fx.canonical, "branch", "--list", "--format=%(refname) %(objectname)"),
  worktrees: gitIn(fx.canonical, "worktree", "list", "--porcelain"),
  wt: existsSync(fx.entry.worktreeParent) ? readdirSync(fx.entry.worktreeParent) : null,
  dirty: readFileSync(join(fx.canonical, "docs", "readme.md"), "utf8") + readFileSync(join(fx.canonical, "scratch.txt"), "utf8"),
});
const shaperFor = (registry: RepoRegistry, planner: ((input: never) => Promise<PlannerDraft | { question: string }>) | null = null) =>
  createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: versions, jev: null, planner: planner as never });

describe("F1 flow 1: 'make a top-tier dental site for <lead>' drafts against the right repo, from the skills' brief", () => {
  test("the words become the site request; 8 skills are on by default; the brief carries each skill's directive", () => {
    const request = siteRequestFromWords("Jarvis, make a top-tier dental site for Harbour Dental");
    expect(request).toBeTruthy();
    expect(isSiteRequest(request!)).toBe(true);
    expect(request).toContain("in the muv-demo-dental repo");
    expect(skillsInRequest(request!)).toEqual(PRESET_SKILLS);
    expect(PRESET_SKILLS).toHaveLength(8);
    const brief = siteBrief(PRESET_SKILLS);
    for (const id of ["mu-business-evidence", "mu-art-direction", "motion-ui", "accessibility"]) expect(brief).toContain(`- ${id}:`);
    expect(brief).toContain("public evidence");
    expect(brief).toContain("reduced-motion");
    expect(brief).not.toMatch(/\b(?:push|merge|deploy|publish|release|production|vercel)\b/i);
    // The palette and Jarvis land on the same draft: the same registry entry, the same request.
    const typed = resolveCommand("make a top-tier dental site for Harbour Dental", buildCommandIndex({}), { channel: "typed" });
    expect(typed.status === "resolved" && (typed.entry.action as { search: { request: string } }).search.request).toBe(request);
    // Ordinary words are not a site ask.
    expect(siteRequestFromWords("make a site map of the dental repo")).toBeNull();
  });

  test("drafting picks the dental repo, owns only the site's source folders, uses the repo's build as the check, and changes NOTHING", async () => {
    const fx = siteFixture("muv-demo-dental", "Dental demonstration site (Next.js)");
    const other = siteFixture("aldergate", "Aldergate real-estate demonstration site (Next.js)");
    const registry: RepoRegistry = { version: 1, repos: [fx.entry, other.entry] };
    const before = snapshotOf(fx);
    const beforeOther = snapshotOf(other);
    const shaper = shaperFor(registry, async () => { throw new Error("the planner must not run for a site draft"); });
    const request = siteRequestFromWords("Jarvis, make a top-tier dental site for Harbour Dental")!;
    const r = await shaper.shape({ utterance: request, channel: "voice", principal, usePlanner: true });
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    const spec = r.spec;
    expect(spec.repo.repoId).toBe("muv-demo-dental");
    expect(spec.objective).toMatch(/^Make a top-tier dental website for Harbour Dental/);
    expect(spec.confirmation.state).toBe("unconfirmed");
    const builder = spec.roles.find((x) => x.role === "builder")!;
    expect(builder.owns.globs).toEqual(["src/**"]); // src is a site folder; lib, docs and scripts are not
    expect(builder.instructions).toContain("mu-business-evidence");
    expect(builder.instructions).toContain("mu-art-direction");
    expect(builder.instructions).toContain("Nothing goes live");
    expect(spec.roles.some((x) => x.role === "reviewer")).toBe(true);
    expect(spec.checks).toEqual(["muv-demo-dental.build"]);
    expect(spec.doneWhen.filter((d) => d.evidence === "reviewer-confirms").length).toBeGreaterThanOrEqual(3);
    expect(spec.nonGoals).toContain("No paid image or video generation");
    // The deterministic validator accepts it (no consequential words in the role's instructions).
    expect(validateSpec(spec, registry)).toMatchObject({ ok: true, errors: [] });
    expect(r.spokenSummary).toContain(`Source snapshot: ${spec.repo.baseRef} at ${spec.repo.baseSha.slice(0, 12)}; uncommitted checkout changes are excluded.`);
    expect(r.spokenSummary).toContain("Selected routes: builder-1: claude-opus-5-5; reviewer: claude-opus-5-5. Say start");
    // Drafting read the repo and wrote nothing: not a branch, not a worktree, not the dirty work another agent left.
    expect(snapshotOf(fx)).toBe(before);
    expect(snapshotOf(other)).toBe(beforeOther);
  }, 120_000);

  test("the whole voice path: 'make a top-tier dental site for X' → Draft ready → a spoken 'start' → the harness builds, tests, reviews and passes its gate", async () => {
    const fx = siteFixture("muv-demo-dental", "Dental demonstration site (Next.js)");
    const store = CodingStore.open(join(fx.root, "coding-data"));
    const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
    const ledger = new SpokenConfirmationLedger();
    const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
    const prompts: string[] = [];
    const BUILDER: ClaudeStep[] = [
      { tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 'harbour';\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 'harbour';\n" } } },
      { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
      { tool: "Bash", input: { command: 'git commit -m "harbour"' }, effect: { git: ["commit", "-q", "-m", "harbour"] } },
      { text: "Built the site pages and committed." },
    ];
    const claudeSpawn = ((binary: string, args: string[], opts: any) => {
      const plan = args[args.indexOf("--permission-mode") + 1] === "plan";
      const fake = plan
        ? new FakeClaude({ result: { result: JSON.stringify({ verdict: "approve", findings: [], criteria: ["c2", "c3", "c4"].map((id) => ({ criterionId: id, met: true, note: "checked" })) }) } })
        : new FakeClaude({ steps: BUILDER });
      fake.args = args; fake.options = { ...opts, binary };
      return fake;
    }) as any;
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
      runners: {
        claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
        codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
        router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
    });
    const shaper = shaperFor(registry, async () => { throw new Error("no planner for a site"); });
    const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: versions, setFocus: () => {}, repoIds: () => ["muv-demo-dental"] });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
    const say = async (text: string, previousAssistant: string | null = null) => {
      const yes = ledger.record(text);
      prompts.push(text);
      return voice.handle(text, { caller, spokenYes: yes?.id ?? null, previousAssistant });
    };
    const before = snapshotOf(fx);
    const drafted = await say("Jarvis, make a top-tier dental site for Harbour Dental");
    expect(drafted).toMatchObject({ say: expect.stringMatching(/^Draft ready: Make a top-tier dental website for Harbour Dental\. Source snapshot: .* Selected routes: .* Say start when you want it built\.$/), navigate: "/coding" });
    const job = store.listJobs({ limit: 1 })[0];
    expect(job.state).toBe("awaiting_confirmation");
    await Bun.sleep(150);
    expect(store.getJob(job.id)!.state).toBe("awaiting_confirmation"); // nothing runs before start
    expect(snapshotOf(fx)).toBe(before);
    const started = await say("start", drafted!.say);
    expect(started?.say).toContain("Started");
    const done = await (async () => {
      const t0 = Date.now();
      for (;;) {
        const j = store.getJob(job.id)!;
        if (["completed", "needs_owner", "failed"].includes(j.state) && !orch.running(job.id)) return j as CodingJob;
        if (Date.now() - t0 > 400_000) throw new Error(`stuck at ${j.state}`);
        await Bun.sleep(50);
      }
    })();
    expect(done.state).toBe("completed");
    // "start" is not a yes the STT ledger records, so it is recorded as typed words; a spoken "yes" would be "spoken-yes".
    expect(done.spec.confirmation).toMatchObject({ state: "confirmed", via: "typed" });
    // The builder was briefed with the skills; the orchestrator's own build ran; the reviewer approved this commit.
    expect(done.tests.some((t) => t.commandId === "muv-demo-dental.build" && t.exitCode === 0)).toBe(true);
    expect(done.review?.verdict).toBe("approve");
    // Nothing merged, and the canonical checkout is still exactly as it was (the job ran in its own worktree).
    expect(gitIn(fx.canonical, "log", "-1", "--format=%H").trim()).toBe(fx.baseSha);
    expect(gitIn(fx.canonical, "status", "--porcelain=v1", "-z")).toBe(JSON.parse(before).status);
    expect(prompts).toHaveLength(2);
    orch.close(); store.close(); approvals.close();
  }, 600_000);

  test("the Websites page's request (a lead with area and site, all skills) drafts the same way; a repo not in the registry is asked about", async () => {
    const fx = siteFixture("muv-demo-dental", "Dental demonstration site (Next.js)");
    const built = buildSiteRequest({ target: { kind: "lead", leadId: 12, name: "Harbour Dental", area: "Parramatta", website: "https://harbourdental.example" }, vertical: "dental", brief: "Calm and premium. Same-week appointments front and centre.", skills: PRESET_SKILLS });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
    const r = await shaperFor(registry).shape({ utterance: built.request, channel: "ui", principal, usePlanner: true });
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    expect(r.spec.objective).toContain("CRM lead #12");
    const instructions = r.spec.roles.find((x) => x.role === "builder")!.instructions!;
    expect(instructions).toContain("The owner's brief: Calm and premium. Same-week appointments front and centre.");
    expect(instructions.split("\n").filter((l) => l.startsWith("- ")).length).toBe(8);
    // A registry without the flagship repo can't guess: it asks which repo (or says it isn't set up).
    const noDental: RepoRegistry = { version: 1, repos: [siteFixture("aldergate", "Aldergate real-estate demonstration site").entry, siteFixture("muv-marketing", "M&U Ventures marketing site").entry] };
    const asked = await shaperFor(noDental).shape({ utterance: built.request, channel: "ui", principal, usePlanner: true });
    expect(asked.kind).toBe("ask");
  });
});

// ─────────────────────────── flow 2 ───────────────────────────

describe("F1 flow 2: 'start a coding job to fix X in <repo>' by voice or typing", () => {
  test("the detector and the objective parser know the phrasing", () => {
    for (const text of ["start a coding job to fix the calls table in the receptionist app", "Jarvis, kick off a coding task for the calls table in the receptionist app", "open a new coding job: fix the footer", "have Codex fix the calls table in the receptionist app"])
      expect(isCodingRequest(text)).toBe(true);
    for (const text of ["start a timer for ten minutes", "start the day", "open the coding page"]) expect(isCodingRequest(text)).toBe(false);
    const typed = resolveCommand("start a coding job to fix the calls table in the receptionist app", buildCommandIndex({}), { channel: "typed" });
    expect(typed.status === "resolved" && typed.entry.id).toBe("coding:request");
  });

  function harness(repos: RepoRegistryEntry[], planner: Parameters<typeof shaperFor>[1] = null) {
    const fx = repos[0];
    void fx;
    const root = tempRoot("f1-coding-voice-");
    roots.push(root);
    const store = CodingStore.open(join(root, "coding-data"));
    const registry: RepoRegistry = { version: 1, repos };
    const ledger = new SpokenConfirmationLedger();
    const approvals = new ApprovalService({ path: join(root, "approvals.sqlite"), spoken: ledger });
    let spawns = 0;
    const claudeSpawn = ((binary: string, args: string[], opts: any) => {
      spawns++;
      const fake = new FakeClaude({ stall: true, steps: [{ wait: 60_000 }] });
      fake.args = args; fake.options = { ...opts, binary };
      return fake;
    }) as any;
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
      runners: {
        claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
        codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
        router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
    });
    const shaper = shaperFor(registry, planner);
    const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: versions, setFocus: () => {}, repoIds: () => repos.map((r) => r.id) });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
    const say = (text: string, previousAssistant: string | null = null) => {
      const yes = ledger.record(text);
      return voice.handle(text, { caller, spokenYes: yes?.id ?? null, previousAssistant });
    };
    return { store, orch, say, spawns: () => spawns, close: () => { orch.close(); store.close(); approvals.close(); } };
  }
  const receptionist = () => {
    const fx = siteFixture("mu-receptionist", "The receptionist app: calls, bookings and the client dashboard");
    return fx.entry;
  };
  const fakePlanner = (calls: string[]) => async (input: { objective: string }) => {
    calls.push(input.objective);
    return { objective: input.objective, nonGoals: ["No dependency changes"], doneWhen: [{ id: "c1", text: "the build passes", evidence: "build" as const, ref: "mu-receptionist.build" }, { id: "c2", text: input.objective, evidence: "reviewer-confirms" as const }], builders: [{ owns: { globs: ["src/**"], newFiles: [] } }], checks: ["mu-receptionist.build"] } as unknown as PlannerDraft;
  };

  test("'start a coding job to fix the calls table in the receptionist app' → one draft with the sentence as the objective → 'start' starts it", async () => {
    const entry = receptionist();
    const planned: string[] = [];
    const h = harness([entry], fakePlanner(planned));
    const drafted = await h.say("Jarvis, start a coding job to fix the calls table in the receptionist app");
    expect(drafted).toMatchObject({ say: expect.stringMatching(/^Draft ready: Fix the calls table in the receptionist app\. Source snapshot: .* Say start when you want it built\.$/), navigate: "/coding" });
    expect(planned).toEqual(["fix the calls table in the receptionist app"]); // the sentence, minus the "start a coding job to" lead-in
    const job = h.store.listJobs({ limit: 1 })[0];
    expect(job.spec.objective).toBe("fix the calls table in the receptionist app");
    expect(job.spec.repo.repoId).toBe("mu-receptionist");
    expect(job.state).toBe("awaiting_confirmation");
    await Bun.sleep(100);
    expect(h.spawns()).toBe(0);
    const started = await h.say("start", drafted!.say);
    expect(started?.say).toContain("Started");
    expect(h.store.getJob(job.id)!.spec.confirmation).toMatchObject({ state: "confirmed" });
    h.orch.cancel(job.id);
    h.close();
  }, 120_000);

  test("'have Codex fix X in <repo>' names Codex as the builder and drafts", async () => {
    const h = harness([receptionist()], fakePlanner([]));
    const drafted = await h.say("have Codex fix the calls table in the receptionist app so yesterday's calls stop showing as today");
    expect(drafted?.say).toMatch(/^Draft ready: Fix the calls table in the receptionist app so yesterday's calls stop showing as today\. Source snapshot: .* Selected routes: builder-1: gpt-6-astra; reviewer: claude-opus-5-5\. Say start when you want it built\.$/);
    const job = h.store.listJobs({ limit: 1 })[0];
    expect(job.spec.roles.find((r) => r.role === "builder")!.agent!.model).toBe("gpt-6-astra");
    h.close();
  }, 120_000);

  test("explicit DeepSeek, MiMo and Muse builder choices draft selectable free Cline routes", async () => {
    const h = harness([receptionist()], fakePlanner([]));
    await h.say("have DeepSeek fix the calls table in the receptionist app");
    expect(h.store.listJobs({ limit: 1 })[0].spec.roles.find((r) => r.role === "builder")!.agent!.model).toBe("cline/deepseek-v4.1-flash");
    await h.say("have MiMo fix the calls table in the receptionist app");
    expect(h.store.listJobs({ limit: 1 })[0].spec.roles.find((r) => r.role === "builder")!.agent!.model).toBe("cline/mimo-v2.6-flash");
    await h.say("have Muse fix the calls table in the receptionist app");
    expect(h.store.listJobs({ limit: 1 })[0].spec.roles.find((r) => r.role === "builder")!.agent!.model).toBe("cline/muse-spark-1.3");
    for (const selected of ["cline/deepseek-v4.1-flash", "cline/mimo-v2.6-flash", "cline/muse-spark-1.3"])
      expect(route("coding.router", { selected, hasKey: () => true, allowance: () => null }).model).toBe(selected);
    h.close();
  }, 120_000);

  test("one short question only when the repo is truly ambiguous, and the answer completes the draft", async () => {
    const dental = siteFixture("muv-demo-dental", "Dental demonstration site (Next.js)").entry;
    const legal = siteFixture("muv-demo-conveyancing", "Conveyancing demonstration site (Next.js)").entry;
    const h = harness([dental, legal], async (input: { objective: string; entry: RepoRegistryEntry }) => ({ objective: input.objective, nonGoals: [], doneWhen: [{ id: "c1", text: input.objective, evidence: "reviewer-confirms" as const }], builders: [{ owns: { globs: ["src/**"], newFiles: [] } }], checks: [] }) as never);
    const asked = await h.say("start a coding job to fix the footer links so they open the booking page");
    expect(asked?.say).toMatch(/^Which one: muv-demo-dental \(.*\), or muv-demo-conveyancing \(.*\)\?$/);
    expect(asked?.say.length).toBeLessThan(140);
    const drafted = await h.say("the dental one", asked!.say);
    expect(drafted?.say).toMatch(/^Draft ready: Fix the footer links so they open the booking page\. Source snapshot: .* Say start when you want it built\.$/);
    expect(h.store.listJobs({ limit: 1 })[0].spec.repo.repoId).toBe("muv-demo-dental");
    // Naming the repo in the sentence asks nothing at all.
    const direct = await h.say("start a coding job to fix the footer links so they open the booking page in muv-demo-conveyancing");
    expect(direct?.say).toMatch(/^Draft ready: /);
    expect(h.store.listJobs({ limit: 1 })[0].spec.repo.repoId).toBe("muv-demo-conveyancing");
    h.close();
  }, 120_000);

  test("the receptionist app isn't in the registry: it says so plainly instead of asking about two other repos", async () => {
    const h = harness([siteFixture("muv-demo-dental", "Dental demonstration site (Next.js)").entry, siteFixture("aldergate", "Aldergate real-estate site").entry]);
    const said = await h.say("start a coding job to fix the calls table in the receptionist app");
    expect(said?.say).toMatch(/^The receptionist app isn't in the coding registry yet/);
    expect(said?.say).toContain("mu-receptionist");
    expect(h.store.listJobs({ limit: 1 })).toHaveLength(0);
    h.close();
  }, 120_000);

  test("the title reads well for long and site objectives", () => {
    const spec = (objective: string) => ({ objective, repo: {} as never });
    expect(draftTitle(spec("fix the calls table in the receptionist app"))).toBe("Fix the calls table in the receptionist app");
    expect(draftTitle(spec("Make a top-tier dental website for Harbour Dental (CRM lead #12, Parramatta), in the muv-demo-dental repo, starting from the Lantern Dental flagship on this job's own branch"))).toBe("Make a top-tier dental website for Harbour Dental");
    expect(draftTitle(spec("x ".repeat(80))).length).toBeLessThanOrEqual(92);
    expect(spokenSummary({ objective: "add a booking button", repo: {} } as never)).toBe("Draft ready: Add a booking button. Say start when you want it built.");
    // git() is read-only here: sanity that the helper import used above is the real one.
    expect(typeof git).toBe("function");
  });
});
