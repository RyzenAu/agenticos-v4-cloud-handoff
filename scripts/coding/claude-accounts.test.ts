import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "../approvals/principal";
import { ApprovalService } from "../approvals/service";
import { buildSnapshot, createProviderCache } from "../ai-usage/snapshot";
import type { SubscriptionCard } from "../ai-usage/types";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { allowanceFromSnapshot } from "../model-router/allowance";
import { MemoryReceiptSink } from "../model-router/receipts";
import type { FallbackConfig } from "./fallback";
import { readableJob } from "./job-view";
import { bindingKey, nextFallback, validateFallback } from "./fallback";
import { ALLOWANCE_STALE_MS, AccountsInvalid, DEFAULT_ACCOUNTS, allowanceReading, claudeAllowance, claudeStopReason, pickClaudeSlot, validateAccounts, type AccountsConfig } from "./accounts";
import { claudeSlotEnv, claudeStatusService, parseAuthStatus } from "./claude-status";
import type { AllowanceSnapshot, CodingJob, RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { codingBlocker } from "./pause-reason";
import { codingRoute, type CodingRuntime } from "./routes";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import { claudeSlotFromWords, createShaper } from "./shaper";
import { loadSharedContext, sharedContextBlock } from "./shared-context";
import { boundContextSources, buildReceipt, modelMismatch } from "./receipts";
import { CLAUDE_MODELS, CLAUDE_MODELS_OFFERED, claudeBinding, currentClaudeModel, draftSpec, sameClaudeModel, specDigest } from "./spec";
import type { RunnerOutcome } from "./runners/types";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo, gitIn, tempRoot } from "./test-fixtures";

/**
 * SYNTHETIC checks for several Claude accounts (30 Sep 2026): config, connection evidence, the automatic
 * pick, per-account usage, profile isolation of every Claude child, receipts naming the account that ran,
 * an unavailable account never silently swapped, pre-Start account choice, and the shared context every
 * account receives. No real CLI, account, credential or network.
 */

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });
const root = tempRoot("claude-accounts-");
roots.push(root);
const DIR2 = join(root, "profile-max-2");
mkdirSync(DIR2, { recursive: true });

const TWO: AccountsConfig = validateAccounts({
  version: 1,
  codex: [{ slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false }],
  claude: [{ slot: "claude:max", configDir: null, plan: "claude-max-20x", label: "Claude Max" }, { slot: "claude:max-2", configDir: DIR2, plan: "claude-max-20x", label: "Claude Max 2" }],
});

// Always in the future: a window that has already reset no longer blocks (accounts.claudeStopReason).
const RESETS = new Date(Date.now() + 3_600_000).toISOString();
const card = (id: string, used: number, checkedAt: string | null = new Date().toISOString()): SubscriptionCard => ({
  id, provider: "anthropic", owner: "M&U", plan: "Claude Max 20x", planSlug: null, monthly: null, priceNote: "",
  status: { ok: true, windows: [{ label: "5-hour", usedPercent: used, resetsAt: RESETS }], notes: [], freshness: { checkedAt, source: "test", estimated: false } },
  peakPercent: used,
});

describe("accounts.json: Claude slots", () => {
  test("missing claude list = the one default login (no behaviour change for existing installs)", () => {
    expect(validateAccounts({ version: 1, codex: [] }).claude).toEqual(DEFAULT_ACCOUNTS.claude);
  });
  test("a second account needs its own absolute profile; the default can't be listed twice", () => {
    expect(TWO.claude.map((c) => [c.slot, c.configDir])).toEqual([["claude:max", null], ["claude:max-2", DIR2]]);
    const bad = (claude: unknown) => () => validateAccounts({ version: 1, codex: [], claude });
    expect(bad([{ slot: "claude:max-2", configDir: "relative/dir" }])).toThrow(AccountsInvalid);
    expect(bad([{ slot: "claude:max-2", configDir: "C:/Users/x/.claude" }])).toThrow(/another slot's profile/);
    expect(bad([{ slot: "claude:max", configDir: DIR2 }])).toThrow(/default/);
    expect(bad([{ slot: "claude:max-2", configDir: DIR2 }, { slot: "claude:max-3", configDir: DIR2 }])).toThrow(/another slot's profile/);
    expect(bad([{ slot: "claude:other", configDir: DIR2 }])).toThrow(/claude:max/);
  });
});

describe("connection evidence: claude auth status on the slot's own profile", () => {
  const signedIn = (email: string) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, orgId: `org-${email}`, subscriptionType: "max" });
  test("a subscription login is connected; an API key or no login is not; identity is never kept in clear", () => {
    const ok = parseAuthStatus(signedIn("new@example.com"));
    expect(ok).toMatchObject({ connected: true, subscription: "max" });
    expect(JSON.stringify(ok)).not.toContain("example.com");
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api-key" })).connected).toBe(false);
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false })).connected).toBe(false);
    expect(parseAuthStatus("not json").connected).toBe(false);
  });
  test("each probe runs on its own profile; a missing folder is signed out without probing; the same account twice isn't two accounts", async () => {
    const seen: (string | undefined)[] = [];
    let second = "other@example.com";
    const missing = validateAccounts({ ...TWO, claude: [...TWO.claude, { slot: "claude:max-3", configDir: join(root, "not-created"), label: "Claude Max 3" }] });
    const svc = claudeStatusService({
      accounts: () => missing, binary: () => "C:/fake/claude.exe", env: { PATH: "/bin" },
      probe: async (_b, env) => { seen.push(env.CLAUDE_CONFIG_DIR); return { ok: true, stdout: signedIn(env.CLAUDE_CONFIG_DIR ? second : "orig@example.com") }; },
    });
    expect(svc.current().every((s) => s.connected === null)).toBe(true); // unknown until checked, never "connected"
    await svc.refresh();
    expect(seen.sort()).toEqual([DIR2, undefined].sort() as never);
    const now = svc.current();
    expect(now.find((s) => s.slot === "claude:max")?.connected).toBe(true);
    expect(now.find((s) => s.slot === "claude:max-2")?.connected).toBe(true);
    expect(now.find((s) => s.slot === "claude:max-3")).toMatchObject({ connected: false, reason: expect.stringContaining("doesn't exist") });
    second = "orig@example.com"; // the new profile signed in to the ORIGINAL account by mistake
    await svc.refresh(true);
    expect(svc.current().find((s) => s.slot === "claude:max-2")).toMatchObject({ connected: false, sameAccountAs: "claude:max" });
  });
  test("a preview copy never probes the owner's profiles", async () => {
    let probed = false;
    const svc = claudeStatusService({ accounts: () => TWO, binary: () => "x", env: { PATH: "/bin", ARGENTIC_PREVIEW: "1", USERPROFILE: root }, probe: async () => { probed = true; return { ok: true, stdout: "{}" }; } });
    await svc.refresh();
    expect(probed).toBe(false);
    expect(svc.current().every((s) => s.connected === null)).toBe(true);
  });
  test("slot env: the slot's CLAUDE_CONFIG_DIR replaces any inherited one; the default has none", () => {
    expect(claudeSlotEnv({ configDir: DIR2 }, { claude_config_dir: "C:/elsewhere", PATH: "p" })).toEqual({ PATH: "p", CLAUDE_CONFIG_DIR: DIR2 });
    expect(claudeSlotEnv({ configDir: null }, { CLAUDE_CONFIG_DIR: "C:/elsewhere", PATH: "p" })).toEqual({ PATH: "p" });
  });
});

describe("the automatic pick and per-account usage", () => {
  const states = (a: boolean | null, b: boolean | null) => [{ slot: "claude:max" as const, connected: a, reason: a === false ? "not signed in" : null }, { slot: "claude:max-2" as const, connected: b, reason: b === false ? "not signed in" : null }];
  test("first connected account below its limit; a full or signed-out account is skipped and said", () => {
    expect(pickClaudeSlot(TWO, states(true, true), [card("claude:max", 20), card("claude:max-2", 5)])).toMatchObject({ ok: true, slot: { slot: "claude:max" } });
    const full = pickClaudeSlot(TWO, states(true, true), [card("claude:max", 97), card("claude:max-2", 5)]);
    expect(full).toMatchObject({ ok: true, slot: { slot: "claude:max-2" } });
    expect(full.ok && full.reason).toBe(`Claude Max 2, because Claude Max: 5-hour window is at 97%, resetting ${RESETS}`);
    expect(pickClaudeSlot(TWO, states(false, true), null)).toMatchObject({ ok: true, slot: { slot: "claude:max-2" } });
    expect(pickClaudeSlot(TWO, states(true, true), null, 95, "claude:max-2")).toMatchObject({ ok: true, slot: { slot: "claude:max-2" } });
    // Unknown connection and unread usage never block.
    expect(pickClaudeSlot(TWO, states(null, null), null)).toMatchObject({ ok: true, slot: { slot: "claude:max" } });
    const none = pickClaudeSlot(TWO, states(false, true), [card("claude:max-2", 99)]);
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("No Claude account can take new work");
  });
  test("usage is read per account: one account's windows are never another's, and unread is null (unknown)", () => {
    const cards = [card("claude:max", 40)];
    expect(claudeAllowance(cards, "claude:max")?.windows[0].usedPercent).toBe(40);
    expect(claudeAllowance(cards, "claude:max")?.accountSlot).toBe("claude:max");
    expect(claudeAllowance(cards, "claude:max-2")).toBeNull();
  });
  test("the usage snapshot reads each profile's own sign-in; the claude-sub bridge is gated by the original only", async () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-ORIGINAL", rateLimitTier: "default_claude_max_20x" } }));
    writeFileSync(join(DIR2, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECOND", rateLimitTier: "default_claude_max_20x" } }));
    const auth: string[] = [];
    const request = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("oauth/usage")) {
        const who = init?.headers?.Authorization ?? "";
        auth.push(who.includes("SECOND") ? "second" : "original");
        const used = who.includes("SECOND") ? 99 : 10;
        return new Response(JSON.stringify({ five_hour: { utilization: used, resets_at: "2026-09-30T12:00:00Z" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const snap = await buildSnapshot({
      settingsFile: join(root, "usage.json"), cache: createProviderCache(), counts: () => null, transcripts: () => null, transcriptsScanning: () => false,
      providerKey: () => "", request, home, hermesHome: join(root, "no-hermes"), env: {}, root,
      claudeProfiles: () => TWO.claude.map((c) => ({ slot: c.slot, label: c.label, configDir: c.configDir })),
    });
    const claude = snap.subscriptions.filter((s) => s.provider === "anthropic");
    expect(claude.map((c) => c.id)).toEqual(["claude:max", "claude:max-2"]);
    expect(auth.sort()).toEqual(["original", "second"]);
    const second = claude.find((c) => c.id === "claude:max-2")!;
    if (second.status.ok) expect(second.status.windows[0].usedPercent).toBe(99);
    // The second account at 99% does not block the Hermes claude-sub bridge (it runs the original login).
    expect(allowanceFromSnapshot(snap, "claude-sub")?.usedPct).toBe(10);
  });
});

describe("spoken/typed account words", () => {
  test("names an account only when it is configured", () => {
    expect(claudeSlotFromWords("have Opus build it on Claude account 2", TWO)).toBe("claude:max-2");
    expect(claudeSlotFromWords("use my second Claude account", TWO)).toBe("claude:max-2");
    expect(claudeSlotFromWords("use the original account", TWO)).toBe("claude:max");
    expect(claudeSlotFromWords("Sonnet builds; allow max 3 retries", TWO)).toBeNull();
    expect(claudeSlotFromWords("use Claude account 2", DEFAULT_ACCOUNTS)).toBeNull();
  });
});

// ─────────────────────────── orchestrator: isolation, receipts, no silent swap, shared context ───────────────────────────

const RESULTS = ["(pass) alpha [1.00ms]", " 1 pass", " 0 fail", ""].join("\n");
function world(opts: { connected?: (slot: string) => boolean | null; accounts?: AccountsConfig; reviewerReports?: string; allowance?: (slot: string) => AllowanceSnapshot | null; fallback?: FallbackConfig | null; location?: "this-pc" | "cloud"; builderFake?: (n: number, args: string[]) => FakeClaude } = {}) {
  const fx = fixtureRepo();
  roots.push(fx.root);
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  const entry = { ...fx.entry, commands: [{ id: "fx.test" as never, kind: "test" as const, argv, cwd: ".", timeoutMs: 60_000, counts: "bun" as const }] };
  const registry: RepoRegistry = { version: 1, repos: [entry] };
  const store = CodingStore.open(join(fx.root, "coding-data"));
  const brief = join(fx.root, "MU-BRIEF.txt");
  writeFileSync(brief, "M&U Ventures sells AI receptionists. Approved Professional plan: A$1,099/month ex-GST.\n");
  const ctxFile = join(fx.root, "shared-context.json");
  writeFileSync(ctxFile, JSON.stringify({ files: [brief] }));
  const launched: { slotDir: string | undefined; readOnly: boolean; system: string; env: Record<string, string>; prompt?: string }[] = [];
  let writers = 0;
  const spawn = ((binary: string, args: string[], o: any) => {
    const readOnly = args[args.indexOf("--permission-mode") + 1] === "plan";
    const system = readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8");
    launched.push({ slotDir: o.env.CLAUDE_CONFIG_DIR, readOnly, system, env: o.env });
    const APPROVE = JSON.stringify({ verdict: "approve", findings: [], criteria: [{ criterionId: "c1", met: true }] });
    const content = "export const a = 42;\n";
    const fake = !readOnly && opts.builderFake ? opts.builderFake(writers++, args) : readOnly ? new FakeClaude({ model: opts.reviewerReports ?? args[args.indexOf("--model") + 1], result: { result: APPROVE } }) : new FakeClaude({ steps: [
      { tool: "Write", input: { file_path: "src/a.ts", content }, effect: { write: { path: "src/a.ts", content } } },
      { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
      { tool: "Bash", input: { command: 'git commit -m "a=42"' }, effect: { git: ["commit", "-q", "-m", "a=42"] } },
      { text: "Set a to 42." },
    ] });
    fake.args = args; fake.options = { ...o, binary };
    return fake;
  }) as any;
  const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
  const orch = createOrchestrator({
    store, registry: () => registry, accounts: () => opts.accounts ?? TWO,
    runners: {
      // A realistic parent env: an inherited CLAUDE_CONFIG_DIR and an API key must never reach a child.
      claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn, platform: "linux", env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "C:/inherited/profile", ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass" }, killGraceMs: 300, softEndMs: 20 }),
      codex: codexRunner({ binary: "C:/fake/codex.exe", platform: "linux", env: { PATH: "/bin" } }),
      router: routerRunner({ chat: async () => { throw new Error("no router here"); } }),
    },
    approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: (slot) => opts.allowance?.(slot) ?? null,
    fallback: () => opts.fallback ?? null,
    executionLocation: () => opts.location ?? "this-pc",
    claudeConnected: (slot) => ({ connected: opts.connected?.(slot) ?? true, reason: opts.connected?.(slot) === false ? "not signed in on this profile" : null }),
    sharedContext: () => loadSharedContext(ctxFile),
    codexIsolation: () => ({ ok: true, message: "" }),
  });
  orch.attachApprovals();
  return { fx, entry, store, orch, launched, approvals, ctxFile };
}
const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };
const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));
async function until(store: CodingStore, id: string, pred: (j: CodingJob) => boolean, ms = 300_000) {
  const t = Date.now();
  for (;;) { const j = store.getJob(id)!; if (pred(j)) return j; if (Date.now() - t > ms) throw new Error(`timed out in ${j.state}`); await Bun.sleep(25); }
}
function specFor(w: ReturnType<typeof world>, builderSlot: "claude:max" | "claude:max-2", reviewerSlot: "claude:max" | "claude:max-2") {
  return draftSpec({
    requestedBy: OWNER, channel: "typed", utterance: "Set a to 42.", entry: w.entry, objective: "Set a to 42 in the fixture",
    doneWhen: [{ id: "c1", text: "a is 42", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
    builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280", builderSlot), owns: { globs: ["src/a.ts"], newFiles: [] } }],
    reviewer: { binding: claudeBinding("claude-sonnet-5-5", "2.1.280", reviewerSlot) }, checks: ["fx.test" as never], dataClass: "synthetic",
  });
}

describe("orchestrator with two Claude accounts (SYNTHETIC)", () => {
  test("each role runs on its own profile; receipts and progress name the account and model that ran; both got the same context", async () => {
    const w = world();
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    expect(done.state).toBe("completed");
    const builder = w.launched.find((l) => !l.readOnly)!;
    const reviewer = w.launched.find((l) => l.readOnly)!;
    expect(builder.slotDir).toBe(DIR2); // the second account's own profile
    expect(reviewer.slotDir).toBeUndefined(); // the original login: default ~/.claude, not the inherited dir
    for (const l of w.launched) expect(l.env.ANTHROPIC_API_KEY).toBeUndefined();
    const events = w.store.events(job.id, 0, 5000);
    const receipts = events.filter((e) => e.type === "usage").map((e) => e.payload as any);
    expect(receipts.map((r) => [r.coding.roleId, r.account, r.model])).toEqual([["builder-1", "claude:max-2", "claude-opus-5-5"], ["reviewer", "claude:max", "claude-sonnet-5-5"]]);
    const steps = events.filter((e) => e.type === "step").map((e) => (e.payload as any).label as string);
    expect(steps).toContain("Account: Claude Max 2 (claude:max-2) · model claude-opus-5-5");
    expect(steps).toContain("Account: Claude Max (claude:max) · model claude-sonnet-5-5");
    expect(steps.some((l) => /^Context: job spec \+ shared business context MU-BRIEF\.txt \(\d+ chars, sha [0-9a-f]{12}\)\. No profile memory is loaded\.$/.test(l))).toBe(true);
    // Identical shared context whichever account ran the role.
    const block = sharedContextBlock(loadSharedContext(w.ctxFile));
    expect(block).toContain("A$1,099/month");
    expect(builder.system).toContain(block);
    expect(reviewer.system).toContain(block);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("a role bound to a signed-out account fails before starting: nothing runs and nothing is moved to another account", async () => {
    const w = world({ connected: (slot) => slot !== "claude:max-2" });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(0);
    const run = done.runs.find((r) => r.roleId === "builder-1")!;
    expect(run.binding.accountSlot).toBe("claude:max-2");
    expect(run.error?.code).toBe("signed_out");
    expect(run.error?.message).toContain("Claude Max 2 (claude:max-2) isn't signed in");
    expect(w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage")).toHaveLength(0);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("an account removed from accounts.json is refused, never replaced by the default login", async () => {
    const w = world({ accounts: DEFAULT_ACCOUNTS });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(0);
    expect(done.runs.find((r) => r.roleId === "builder-1")?.error?.message).toContain("isn't a Claude account configured on this PC");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});

describe("pre-Start account choice (route)", () => {
  test("moves a role to another configured account as a new plan revision; refuses unknown accounts and started jobs", async () => {
    const w = world();
    const shaper = createShaper({ registry: () => ({ version: 1, repos: [w.entry] }), accounts: () => TWO, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
    const rt: CodingRuntime = { store: w.store, orch: w.orch, shaper, registry: () => ({ version: 1, repos: [w.entry] }), accounts: () => TWO, approvals: () => w.approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null };
    const P: Principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.owner-session" };
    const call = (path: string, body: unknown) => codingRoute({ method: "POST", path, url: new URL(`http://x${path}`), body: { requestId: crypto.randomUUID(), ...(body as object) }, principal: P }, rt) as Promise<{ status: number; body: any }>;
    const s = specFor(w, "claude:max", "claude:max");
    const { job } = w.orch.draft(s);
    const moved = await call(`/coding/jobs/${job.id}/account`, { roleId: "builder-1", accountSlot: "claude:max-2" });
    expect(moved.status).toBe(200);
    expect(moved.body.spec.roles.find((r: any) => r.roleId === "builder-1").agent).toMatchObject({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
    expect(moved.body.specDigest).not.toBe(specDigest(s));
    // The digest the owner saw before the change can't start the changed plan.
    expect(() => w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s))).toThrow();
    expect((await call(`/coding/jobs/${job.id}/account`, { roleId: "builder-1", accountSlot: "claude:max-7" })).status).toBe(400);
    w.orch.confirmAndStart(job.id, OWNER, "ui", moved.body.specDigest);
    expect((await call(`/coding/jobs/${job.id}/account`, { roleId: "builder-1", accountSlot: "claude:max" })).status).toBe(409);
    await until(w.store, job.id, settled);
    expect(w.launched.find((l) => !l.readOnly)?.slotDir).toBe(DIR2);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});

describe("which Claude Code runs a role", () => {
  test("an unreadable version never downgrades to the older PATH copy: the pinned bridge copy wins", async () => {
    const { claudeCodingBinary } = await import("./runners/claude");
    const bin = join(root, "path-bin");
    const local = join(root, "localappdata");
    const pinned = join(local, "claude-bridge", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(pinned, ".."), { recursive: true });
    // Neither file can run, so both --version reads fail (as a timed-out read does under load).
    writeFileSync(join(bin, "claude.exe"), "");
    writeFileSync(pinned, "");
    expect(claudeCodingBinary({ platform: "win32", env: { PATH: bin, PATHEXT: ".EXE;.CMD", LOCALAPPDATA: local } })).toBe(pinned);
  });
});

// ─────────────────────────── 1 Oct 2026: model ids, receipt provenance, allowance honesty ───────────────────────────

describe("Claude model ids: the current Sonnet is claude-sonnet-5-5; the old id stays accepted", () => {
  test("new work is bound to 5-5; the legacy id is still valid for stored jobs and maps to the current one", () => {
    expect(CLAUDE_MODELS).toContain("claude-sonnet-5");
    expect(CLAUDE_MODELS).toContain("claude-sonnet-5-5");
    expect(CLAUDE_MODELS_OFFERED).toContain("claude-sonnet-5-5");
    expect(CLAUDE_MODELS_OFFERED).not.toContain("claude-sonnet-5");
    expect(currentClaudeModel("claude-sonnet-5")).toBe("claude-sonnet-5-5");
    expect(currentClaudeModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
  test("a job stored with the legacy Sonnet id still validates and keeps that id (not silently rewritten)", () => {
    const w = world();
    const s = specFor(w, "claude:max-2", "claude:max");
    const legacy = { ...s, roles: s.roles.map((r) => (r.role === "reviewer" && r.agent?.route === "claude-code-cli" ? { ...r, agent: claudeBinding("claude-sonnet-5", "2.1.280", "claude:max") } : r)) };
    const { job, validation } = w.orch.draft(legacy as typeof s);
    expect(validation.errors).toEqual([]);
    expect(job.spec.roles.find((r) => r.role === "reviewer")!.agent!.model).toBe("claude-sonnet-5");
    w.orch.close(); w.store.close(); w.approvals.close();
  });
  test("requested vs reported ignores a dated snapshot suffix but not a different model", () => {
    expect(sameClaudeModel("claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(true);
    expect(sameClaudeModel("claude-sonnet-5-5", "claude-sonnet-5")).toBe(false);
    expect(modelMismatch("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(false);
    expect(modelMismatch("claude-sonnet-5-5", "claude-opus-5-5")).toBe(true);
    expect(modelMismatch("claude-sonnet-5-5", null)).toBeNull(); // never reported: unknown, not "fine"
  });
});

const outcome = (over: Partial<RunnerOutcome> = {}): RunnerOutcome => ({
  status: "succeeded", sessionId: "s", startedAt: Date.parse("2026-10-01T00:00:00Z"), endedAt: Date.parse("2026-10-01T00:00:05Z"),
  providerModel: "claude-sonnet-5-5", cliVersion: "2.1.280", accountPlan: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
  valueUsdEquivalent: 0.01, allowanceEnd: null, error: null, ...over,
} as RunnerOutcome);
const receiptFor = (model: "claude-sonnet-5-5" | "claude-sonnet-5", o: RunnerOutcome, extra: Partial<Parameters<typeof buildReceipt>[0]> = {}) => buildReceipt({
  requestId: "r" as never, parentRequestId: null, jobId: "j" as never, roleId: "builder-1" as never, role: "builder", turn: 1, person: "usman" as never,
  binding: claudeBinding(model, "2.1.280", "claude:max-2"), dataClass: "synthetic", outcome: o, allowanceStart: null, queueMs: 0, ...extra,
});

describe("receipts record what was asked, what ran, where and with which context (SYNTHETIC)", () => {
  test("requested and reported model, slot, CLI version, location; a mismatch is flagged", () => {
    const ok = receiptFor("claude-sonnet-5-5", outcome());
    expect(ok).toMatchObject({ requestedModel: "claude-sonnet-5-5", providerModel: "claude-sonnet-5-5", model: "claude-sonnet-5-5", modelMismatch: false, account: "claude:max-2", executionLocation: "this-pc" });
    expect(ok.coding.cliVersion).toBe("2.1.280");
    const bad = receiptFor("claude-sonnet-5-5", outcome({ providerModel: "claude-sonnet-5" }));
    expect(bad).toMatchObject({ requestedModel: "claude-sonnet-5-5", providerModel: "claude-sonnet-5", modelMismatch: true });
    const silent = receiptFor("claude-sonnet-5", outcome({ providerModel: null }));
    expect(silent).toMatchObject({ requestedModel: "claude-sonnet-5", providerModel: null, modelMismatch: null });
    expect(receiptFor("claude-sonnet-5-5", outcome(), { executionLocation: "cloud" }).executionLocation).toBe("cloud");
  });
  test("context sources are bounded, carry sizes and digests, and never contents", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "task-context" as const, name: "x".repeat(500) + i, chars: i, sha256: "ab12cd34ef56zz99" }));
    const b = boundContextSources(many);
    expect(b).toHaveLength(12);
    expect(b[0].name.length).toBe(200);
    expect(b[0].sha256).toBe("ab12cd34ef56");
    const r = receiptFor("claude-sonnet-5-5", outcome(), { contextSources: [{ kind: "shared-brief", name: "C:/briefs/MU.txt", chars: 1234, sha256: "0123456789ab" }] });
    expect(r.contextSources).toEqual([{ kind: "shared-brief", name: "C:/briefs/MU.txt", chars: 1234, sha256: "0123456789ab" }]);
  });
});

describe("account handling: unknown is not zero, never another account's figure, stale is said", () => {
  const NOW = Date.parse("2026-10-01T10:00:00Z");
  const snap = (over: Partial<AllowanceSnapshot> = {}): AllowanceSnapshot => ({
    accountSlot: "claude:max-2", windows: [{ label: "5-hour", usedPercent: 12, resetsAt: "2026-10-01T12:00:00.000Z" as never }], creditsWouldBeUsed: false, limitReached: false,
    source: "anthropic-oauth-usage-cached", readAt: "2026-10-01T09:55:00.000Z" as never, ...over,
  });
  test("fresh / stale by age / stale by a reset window / unknown when nothing was read", () => {
    expect(allowanceReading(snap(), NOW)).toBe("fresh");
    expect(allowanceReading(snap({ readAt: new Date(NOW - ALLOWANCE_STALE_MS - 1000).toISOString() as never }), NOW)).toBe("stale");
    expect(allowanceReading(snap({ windows: [{ label: "5-hour", usedPercent: 97, resetsAt: "2026-10-01T09:00:00.000Z" as never }] }), NOW)).toBe("stale");
    expect(allowanceReading(null, NOW)).toBe("unknown");
    expect(allowanceReading(snap({ readAt: null }), NOW)).toBe("unknown");
    expect(allowanceReading(snap({ windows: [{ label: "5-hour", usedPercent: null, resetsAt: null }] }), NOW)).toBe("unknown");
  });
  test("one account's reading is never taken for another", () => {
    expect(allowanceReading(snap({ accountSlot: "claude:max" }), NOW, "claude:max-2")).toBe("unknown");
    const cards = [card("claude:max", 100), card("claude:max-2", 4)];
    expect(claudeAllowance(cards, "claude:max-2")?.windows[0].usedPercent).toBe(4);
    expect(claudeAllowance(cards, "claude:max")?.windows[0].usedPercent).toBe(100);
    expect(claudeAllowance([card("claude:max", 100)], "claude:max-2")).toBeNull(); // unread = unknown, not the other account's 100%
  });
  test("the reading time is when the provider was last read, not now; a never-read figure has no time", () => {
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(claudeAllowance([card("claude:max-2", 4, old)], "claude:max-2")?.readAt).toBe(old);
    expect(claudeAllowance([card("claude:max-2", 4, null)], "claude:max-2")?.readAt).toBeNull();
    expect(allowanceReading(claudeAllowance([card("claude:max-2", 4, old)], "claude:max-2"))).toBe("stale");
  });
  test("a window that already reset does not block a new role; a live full one does", () => {
    const full = snap({ windows: [{ label: "5-hour", usedPercent: 99, resetsAt: "2026-10-01T09:00:00.000Z" as never }], limitReached: true });
    expect(claudeStopReason(full, 95, NOW)).toBeNull();
    const live = snap({ windows: [{ label: "5-hour", usedPercent: 99, resetsAt: "2026-10-01T12:00:00.000Z" as never }], limitReached: true });
    expect(claudeStopReason(live, 95, NOW)).toContain("5-hour window is at 99%");
    expect(claudeStopReason(null, 95, NOW)).toBeNull(); // unknown never blocks
  });
  test("the receipt says unknown (null %, reading unknown), never 0%", () => {
    const r = receiptFor("claude-sonnet-5-5", outcome(), { allowanceStart: null });
    expect(r.allowance).toMatchObject({ usedPercentAtLastRead: null, reading: "unknown", readAt: null, accountSlot: "claude:max-2" });
    const stale = receiptFor("claude-sonnet-5-5", outcome(), { allowanceStart: snap({ readAt: "2026-10-01T05:00:00.000Z" as never }), now: () => NOW });
    expect(stale.allowance).toMatchObject({ usedPercentAtLastRead: 12, reading: "stale" });
  });
});

describe("through the orchestrator (SYNTHETIC)", () => {
  test("every receipt carries requested and reported model, location and context sources; a silent model swap is flagged on the job", async () => {
    const w = world({ reviewerReports: "claude-haiku-4-5" });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    const events = w.store.events(job.id, 0, 5000);
    const receipts = events.filter((e) => e.type === "usage").map((e) => e.payload as any);
    const builder = receipts.find((r) => r.coding.roleId === "builder-1");
    const reviewer = receipts.find((r) => r.coding.roleId === "reviewer");
    expect(builder).toMatchObject({ requestedModel: "claude-opus-5-5", providerModel: "claude-opus-5-5", modelMismatch: false, executionLocation: "this-pc", account: "claude:max-2" });
    expect(reviewer).toMatchObject({ requestedModel: "claude-sonnet-5-5", providerModel: "claude-haiku-4-5", modelMismatch: true });
    const kinds = builder.contextSources.map((c: any) => c.kind);
    expect(kinds).toContain("shared-brief");
    expect(kinds).toContain("task-context");
    const brief = builder.contextSources.find((c: any) => c.kind === "shared-brief");
    expect(brief.name.replace(/\\/g, "/")).toBe(w.ctxFile.replace(/\\/g, "/").replace("shared-context.json", "MU-BRIEF.txt"));
    expect(brief.chars).toBeGreaterThan(20);
    expect(JSON.stringify(builder.contextSources)).not.toContain("1,099"); // sizes and digests, never contents
    const steps = events.filter((e) => e.type === "step").map((e) => (e.payload as any).label as string);
    expect(steps.some((l) => /^Model mismatch: asked for claude-sonnet-5-5, the CLI reported claude-haiku-4-5/.test(l))).toBe(true);
    expect(done.state).toBe("completed");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("a blocked role resumes on its ORIGINAL account slot, not the other one", async () => {
    let maxTwoUsed = 97;
    const reading = (slot: string): AllowanceSnapshot | null => slot === "claude:max-2"
      ? { accountSlot: "claude:max-2", windows: [{ label: "5-hour", usedPercent: maxTwoUsed, resetsAt: new Date(Date.now() + 3_600_000).toISOString() as never }], creditsWouldBeUsed: false, limitReached: maxTwoUsed >= 100, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never }
      : { accountSlot: "claude:max", windows: [{ label: "5-hour", usedPercent: 3, resetsAt: null }], creditsWouldBeUsed: false, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never };
    const w = world({ allowance: reading });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const blocked = await until(w.store, job.id, (j) => j.state === "blocked_allowance");
    expect(w.launched).toHaveLength(0); // max is at 3% but nothing moved to it
    expect(blocked.runs.find((r) => r.roleId === "builder-1")!.binding.accountSlot).toBe("claude:max-2");
    maxTwoUsed = 10;
    w.orch.resume(job.id, { by: OWNER });
    const done = await until(w.store, job.id, settled);
    expect(done.state).toBe("completed");
    const builder = w.launched.find((l) => !l.readOnly)!;
    expect(builder.slotDir).toBe(DIR2);
    const receipt = w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any).find((r) => r.coding.roleId === "builder-1");
    expect(receipt.account).toBe("claude:max-2");
    expect(receipt.allowance).toMatchObject({ accountSlot: "claude:max-2", usedPercentAtLastRead: 10, reading: "fresh" });
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});

// ─────────────────────────── 1 Oct 2026: automatic, configured fallback (nothing replayed) ───────────────────────────

describe("fallback.ts: the next account or model from the owner's list", () => {
  const env = (over: Partial<Parameters<typeof nextFallback>[3]> = {}) => ({
    accounts: TWO, claudeConnected: () => true as boolean | null, allowance: () => null, stopAtPercent: 95, cliVersions: { claude: "2.1.280", codex: "0.154.0" }, ...over,
  });
  const cur = claudeBinding("claude-sonnet-5-5", "2.1.280", "claude:max-2");
  test("an account slot keeps the model; a model id keeps the account; slot/model sets both", () => {
    expect(nextFallback(cur, [], ["claude:max"], env()).pick?.binding).toMatchObject({ accountSlot: "claude:max", model: "claude-sonnet-5-5" });
    expect(nextFallback(cur, [], ["claude-opus-5-5"], env()).pick?.binding).toMatchObject({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
    expect(nextFallback(cur, [], ["claude:max/claude-opus-5-5"], env()).pick?.binding).toMatchObject({ accountSlot: "claude:max", model: "claude-opus-5-5" });
  });
  test("an entry that is the current binding or was already tried is skipped, so a chain can never loop", () => {
    const r = nextFallback(cur, [bindingKey(claudeBinding("claude-sonnet-5-5", "x", "claude:max"))], ["claude:max-2", "claude:max"], env());
    expect(r.pick).toBeNull();
    expect(r.skipped.map((s) => s.why)).toEqual(["already tried for this role", "already tried for this role"]);
  });
  test("an unconfigured, signed-out or full account is never picked, and the reason is kept", () => {
    const full = { accountSlot: "claude:max", windows: [{ label: "5-hour", usedPercent: 99, resetsAt: new Date(Date.now() + 3_600_000).toISOString() as never }], creditsWouldBeUsed: false, limitReached: true, source: "anthropic-oauth-usage-cached", readAt: null } as AllowanceSnapshot;
    const r = nextFallback(cur, [], ["claude:max-3", "claude:max", "claude-opus-5-5"], env({ allowance: (s) => (s === "claude:max" ? full : null), claudeConnected: (s) => (s === "claude:max" ? true : true) }));
    expect(r.skipped.map((s) => s.entry)).toEqual(["claude:max-3", "claude:max"]);
    expect(r.skipped[0].why).toContain("isn't a configured");
    expect(r.skipped[1].why).toContain("5-hour window is at 99%");
    expect(r.pick?.binding).toMatchObject({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
    expect(nextFallback(cur, [], ["claude:max"], env({ claudeConnected: () => false })).skipped[0].why).toBe("isn't signed in");
  });
  test("Codex is used only when it may run", () => {
    expect(nextFallback(cur, [], ["gpt-6-astra"], env()).skipped[0].why).toContain("paused");
    expect(nextFallback(cur, [], ["gpt-6-astra"], env({ codexAvailable: true })).pick?.binding).toMatchObject({ route: "codex-app-server", model: "gpt-6-astra" });
  });
  test("the config is validated: auto is opt-in and entries are bounded", () => {
    expect(validateFallback(undefined)).toEqual({ auto: false, chain: [] });
    expect(validateFallback({ auto: true, chain: ["claude:max"] })).toEqual({ auto: true, chain: ["claude:max"] });
    expect(() => validateFallback({ auto: true, chain: "claude:max" })).toThrow();
    expect(validateFallback({ chain: Array.from({ length: 20 }, () => "claude:max") }).chain).toHaveLength(8);
  });
});

describe("orchestrator: a limit moves the role on as configured, and nothing already done is replayed (SYNTHETIC)", () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString() as never;
  const snap = (slot: "claude:max" | "claude:max-2", used: number): AllowanceSnapshot => ({ accountSlot: slot, windows: [{ label: "5-hour", usedPercent: used, resetsAt: future() }], creditsWouldBeUsed: false, limitReached: used >= 100, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never });
  const labels = (w: ReturnType<typeof world>, id: string) => w.store.events(id, 0, 5000).filter((e) => e.type === "step").map((e) => (e.payload as any).label as string);

  test("the reviewer's account is full before it starts: the review runs on the next configured account; the builder and the tests are not re-run", async () => {
    const w = world({ fallback: { auto: true, chain: ["claude:max-2"] }, allowance: (slot) => snap(slot as never, slot === "claude:max" ? 97 : 4) });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    expect(done.state).toBe("completed");
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(1); // the builder ran once
    const reviewer = w.launched.find((l) => l.readOnly)!;
    expect(reviewer.slotDir).toBe(DIR2); // moved onto claude:max-2's own profile
    expect(done.tests.map((t) => t.sha).filter((x, i, a) => a.indexOf(x) === i)).toHaveLength(2); // baseline + head, each run once
    expect(done.tests).toHaveLength(2);
    expect(labels(w, job.id).some((l) => l === "Automatic fallback: reviewer claude:max/claude-sonnet-5-5 → claude:max-2/claude-sonnet-5-5")).toBe(true);
    const receipts = w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
    expect(receipts.map((r) => [r.coding.roleId, r.account])).toEqual([["builder-1", "claude:max-2"], ["reviewer", "claude:max-2"]]);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("the builder hits its limit AFTER committing: it continues on the next account from its own commit; the commit is not redone and both attempts have receipts", async () => {
    const limit = "You've hit your usage limit. It resets soon.";
    const commitThenLimit = () => new FakeClaude({ steps: [
      { tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 42;\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 42;\n" } } },
      { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
      { tool: "Bash", input: { command: 'git commit -m "a=42"' }, effect: { git: ["commit", "-q", "-m", "a=42"] } },
    ], result: { is_error: true, subtype: "error_during_execution", result: limit } });
    const w = world({ fallback: { auto: true, chain: ["claude:max"] }, builderFake: (n) => (n === 0 ? commitThenLimit() : new FakeClaude({ steps: [{ text: "Already committed; nothing left to do." }] })) });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    expect(done.state).toBe("completed");
    const builders = w.launched.filter((l) => !l.readOnly);
    expect(builders.map((b) => b.slotDir)).toEqual([DIR2, undefined]); // max-2 first, then the original login
    const builderRun = done.runs.find((r) => r.roleId === "builder-1")!;
    expect(builderRun.attempt).toBe(2);
    expect(builderRun.binding.accountSlot).toBe("claude:max");
    // One commit on the builder's branch: the fallback agent did not redo it.
    const log = gitIn(w.fx.canonical, "log", "--oneline", `${done.spec.repo.baseSha}..${done.headSha}`).trim().split("\n").filter(Boolean);
    expect(log.filter((l) => /a=42/.test(l))).toHaveLength(1);
    const receipts = w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any).filter((r) => r.coding.roleId === "builder-1");
    expect(receipts.map((r) => [r.coding.turn, r.account, r.outcome])).toEqual([[1, "claude:max-2", "rate_limited"], [2, "claude:max", "succeeded"]]);
    expect(labels(w, job.id).some((l) => l === "Automatic fallback: builder-1 claude:max-2/claude-opus-5-5 → claude:max/claude-opus-5-5")).toBe(true);
    expect(done.tests).toHaveLength(2);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("nothing configured, auto off, or every entry unusable: the job stays paused for the owner and says why", async () => {
    for (const fallback of [null, { auto: false, chain: ["claude:max-2"] }, { auto: true, chain: ["claude:max-2", "claude:max-3"] }] as (FallbackConfig | null)[]) {
      const w = world({ fallback, allowance: (slot) => snap(slot as never, 97) });
      const s = specFor(w, "claude:max-2", "claude:max");
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w.store, job.id, settled);
      expect(done.state).toBe("blocked_allowance");
      expect(w.launched).toHaveLength(0);
      if (fallback?.auto) expect(labels(w, job.id).some((l) => /^Automatic fallback: nothing in the fallback list can take builder-1 now$/.test(l))).toBe(true);
      else expect(labels(w, job.id).some((l) => l.startsWith("Automatic fallback"))).toBe(false);
      w.orch.close(); w.store.close(); w.approvals.close();
    }
  }, 400_000);
});

describe("readableJob: plan, progress, diff, tests, review and result without re-deriving anything (SYNTHETIC)", () => {
  test("a completed job and a job that fell back both read cleanly", async () => {
    const w = world({ fallback: { auto: true, chain: ["claude:max-2"] }, allowance: (slot) => ({ accountSlot: slot as never, windows: [{ label: "5-hour", usedPercent: slot === "claude:max" ? 97 : 4, resetsAt: new Date(Date.now() + 3_600_000).toISOString() as never }], creditsWouldBeUsed: false, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never }) });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    const v = readableJob(done, w.store.events(job.id, 0, 5000) as never);
    expect(v.plan.objective).toBe("Set a to 42 in the fixture");
    expect(v.plan.doneWhen).toEqual([{ id: "c1", text: "a is 42", evidence: "reviewer-confirms", met: true, note: null }]);
    expect(v.plan.roles.map((r) => [r.roleId, r.who?.accountSlot, r.who?.model])).toEqual([["builder-1", "claude:max-2", "claude-opus-5-5"], ["reviewer", "claude:max", "claude-sonnet-5-5"]]);
    expect(v.progress.stateText).toBe("Done and verified");
    expect(v.progress.phases.map((p) => p.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(v.progress.needsYou).toBeNull();
    expect(v.diff?.totals).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(v.diff?.files[0]).toMatchObject({ path: "src/a.ts", ownedBy: "builder-1" });
    expect(v.tests.latest).toMatchObject({ matchesHead: true, failed: 0, exitCode: 0 });
    expect(v.review).toMatchObject({ verdict: "approve", forCurrentHead: true, reviewer: { roleId: "reviewer", account: "claude:max-2", model: "claude-sonnet-5-5" } });
    expect(v.result).toMatchObject({ state: "completed", merged: false, gate: { passed: true } });
    expect(v.result.nextStep).toContain("Nothing is merged");
    // The reviewer fell back from the full original account; the page can say so and show each attempt.
    expect(v.progress.fallbacks.map((f) => [f.roleId, f.from, f.to])).toEqual([["reviewer", "claude:max/claude-sonnet-5-5", "claude:max-2/claude-sonnet-5-5"]]);
    const rev = v.progress.runs.find((r) => r.roleId === "reviewer")!;
    expect(rev.attempts).toEqual([
      { turn: 1, account: "claude:max", requestedModel: "claude-sonnet-5-5", reportedModel: null, modelMismatch: null, outcome: "did_not_run", location: null },
      { turn: 2, account: "claude:max-2", requestedModel: "claude-sonnet-5-5", reportedModel: "claude-sonnet-5-5", modelMismatch: false, outcome: "succeeded", location: "this-pc" },
    ]);
    expect(v.location).toBe("this-pc");
    expect(v.context.sources.some((c) => c.kind === "shared-brief" && c.roleId === "builder-1")).toBe(true);
    // Never contents: the brief's text isn't anywhere in the view.
    expect(JSON.stringify(v)).not.toContain("1,099");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("a paused job says what it needs and which phase is blocked", async () => {
    const w = world({ allowance: (slot) => ({ accountSlot: slot as never, windows: [{ label: "5-hour", usedPercent: 99, resetsAt: new Date(Date.now() + 3_600_000).toISOString() as never }], creditsWouldBeUsed: false, limitReached: true, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never }) });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, settled);
    const v = readableJob(done, w.store.events(job.id, 0, 5000) as never);
    expect(v.progress.state).toBe("blocked_allowance");
    expect(v.progress.phases.map((p) => p.status)).toEqual(["blocked", "pending", "pending", "pending", "pending"]);
    expect(v.progress.needsYou).toContain("5-hour window is at 99%");
    expect(v.result.nextStep).toContain("Paused at an account limit");
    expect(v.diff).toBeNull();
    expect(v.review).toBeNull();
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});

describe("execution location on every receipt (SYNTHETIC)", () => {
  test("this PC by default; a cloud-role hub reports cloud; the device is named, and no login file or env value is ever passed", async () => {
    for (const location of ["this-pc", "cloud"] as const) {
      const w = world({ location });
      const s = specFor(w, "claude:max-2", "claude:max");
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w.store, job.id, settled);
      const receipts = w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
      expect(receipts.map((r) => r.executionLocation)).toEqual([location, location]);
      expect(receipts.every((r) => r.executionDevice === "usman-pc")).toBe(true);
      expect(readableJob(done, w.store.events(job.id, 0, 5000) as never).location).toBe(location);
      // The second account is selected only by its own CLAUDE_CONFIG_DIR path; nothing else about a login is forwarded.
      for (const l of w.launched) expect(Object.keys(l.env).filter((k) => /token|oauth|credential|api_key/i.test(k))).toEqual([]);
      w.orch.close(); w.store.close(); w.approvals.close();
    }
  }, 400_000);
});

// ─────────────────────────── round 6 (2 Oct 2026): a reviewer whose account is signed out ───────────────────────────

describe("item 8: an unavailable reviewer account has a way forward, and nothing already done is repeated (SYNTHETIC)", () => {
  const labels = (w: ReturnType<typeof world>, id: string) => w.store.events(id, 0, 5000).filter((e) => e.type === "step").map((e) => (e.payload as any).label as string);

  test("signed-out reviewer account, no fallback configured: the job waits with one plain blocker; Resume on another connected account reviews the SAME commit and builds nothing again", async () => {
    const w = world({ connected: (slot) => slot !== "claude:max" });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const stopped = await until(w.store, job.id, (j) => j.state === "needs_owner" && !j.runs.some((r) => ["starting", "running"].includes(r.state)));
    await until(w.store, job.id, () => !w.orch.running(job.id));
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(1);
    expect(w.launched.filter((l) => l.readOnly)).toHaveLength(0);
    const blocker = codingBlocker(stopped);
    expect(blocker).toMatchObject({ kind: "reviewer-unavailable", roleId: "reviewer", label: "Retry review" });
    expect(blocker.text).toMatch(/reviewer can't run/i);
    expect(blocker.text).toMatch(/sign|another/i);
    const head = stopped.headSha;
    w.orch.resume(job.id, { by: OWNER, roleId: "reviewer", reassignTo: claudeBinding("claude-sonnet-5-5", "2.1.280", "claude:max-2") });
    const done = await until(w.store, job.id, settled);
    await until(w.store, job.id, () => !w.orch.running(job.id));
    expect(done.state).toBe("completed");
    expect(done.headSha).toBe(head);
    expect(done.review?.sha).toBe(head!);
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(1); // the builder ran once
    expect(done.tests).toHaveLength(2); // baseline and head, once each
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("signed-out reviewer account WITH an authorised fallback: the review moves on by itself, said in the job's record; the build and tests are not repeated", async () => {
    const w = world({ connected: (slot) => slot !== "claude:max", fallback: { auto: true, chain: ["claude:max-2"] } });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w.store, job.id, (j) => j.state === "completed");
    await until(w.store, job.id, () => !w.orch.running(job.id));
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(1);
    expect(w.launched.filter((l) => l.readOnly)).toHaveLength(1);
    expect(done.tests).toHaveLength(2);
    expect(labels(w, job.id).some((l) => l === "Automatic fallback: reviewer claude:max/claude-sonnet-5-5 → claude:max-2/claude-sonnet-5-5")).toBe(true);
    const spoken = w.store.events(job.id, 0, 5000).filter((e) => e.type === "spoken").map((e) => (e.payload as any).line as string);
    expect(spoken.some((l) => /claude:max isn't signed in, so I moved reviewer to claude:max-2/.test(l))).toBe(true);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("a reviewer paused at its account's limit records WHICH account is full and when it resets, so the page never offers another model on it", async () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString() as never;
    const full = (slot: string): AllowanceSnapshot => ({ accountSlot: slot as never, windows: [{ label: "weekly", usedPercent: slot === "claude:max" ? 100 : 3, resetsAt: reset }], creditsWouldBeUsed: false, limitReached: slot === "claude:max", source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never });
    const w = world({ allowance: (slot) => full(slot) });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const stopped = await until(w.store, job.id, (j) => j.state === "blocked_allowance" && !j.runs.some((r) => ["starting", "running"].includes(r.state)));
    await until(w.store, job.id, () => !w.orch.running(job.id));
    const step = w.store.events(job.id, 0, 5000).find((e) => e.type === "step" && (e.payload as any).label === "Account at its limit: claude:max");
    expect(step).toBeTruthy();
    expect((step!.payload as any).detail).toContain(`resetting ${reset}`);
    expect(codingBlocker(stopped)).toMatchObject({ kind: "reviewer-unavailable", roleId: "reviewer" });
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(1);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);

  test("a signed-out account with a fallback list where every entry is unusable stays with the owner, and says so", async () => {
    const w = world({ connected: () => false, fallback: { auto: true, chain: ["claude:max-2"] } });
    const s = specFor(w, "claude:max-2", "claude:max");
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const stopped = await until(w.store, job.id, (j) => j.state === "needs_owner" && !j.runs.some((r) => ["starting", "running"].includes(r.state)));
    await until(w.store, job.id, () => !w.orch.running(job.id));
    expect(w.launched).toHaveLength(0);
    expect(stopped.state).toBe("needs_owner");
    expect(labels(w, job.id).some((l) => /^Automatic fallback: nothing in the fallback list can take builder-1 now$/.test(l))).toBe(true);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});

// ─────────────────────────── review finding 5: a signed-out role is only moved to another ACCOUNT ───────────────────────────

describe("review finding 5: the signed-out fallback never changes the model, discloses credits, and moves only that role", () => {
  const env = (over: Partial<Parameters<typeof nextFallback>[3]> = {}) => ({
    accounts: { ...TWO, codex: [{ slot: "codex:openai-1", codexHome: null, plan: "chatgpt-plus", creditsAllowed: true, order: 0 }, { slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false, order: 1 }] } as AccountsConfig,
    claudeConnected: () => true as boolean | null, allowance: () => null, stopAtPercent: 95, cliVersions: { claude: "2.1.280", codex: "0.154.0" }, codexAvailable: true, ...over,
  });
  const current = claudeBinding("claude-opus-5-5", "2.1.280", "claude:max");
  test("accountsOnly skips model and Codex entries, keeps the model on an account entry", () => {
    const r = nextFallback(current, [], ["claude-sonnet-5-5", "gpt-6-astra", "claude:max-2"], env({ accountsOnly: true }));
    expect(r.pick?.binding).toMatchObject({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
    expect(r.skipped.map((s) => s.entry)).toEqual(["claude-sonnet-5-5", "gpt-6-astra"]);
    expect(r.skipped[0].why).toContain("never to another model");
  });
  test("a Claude account whose next use would draw paid credits is said", () => {
    const credits = (slot: string): AllowanceSnapshot => ({ accountSlot: slot as never, windows: [], creditsWouldBeUsed: true, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as never });
    const r = nextFallback(current, [], ["claude:max-2"], env({ accountsOnly: true, allowance: (s) => credits(s) }));
    expect(r.pick?.credits).toBe(true);
    expect(r.pick?.why).toContain("can draw paid credits");
  });
  test("a Codex entry prefers an account that may not draw credits, and says so when only a credits one exists", () => {
    const r = nextFallback(current, [], ["gpt-6-astra"], env());
    expect(r.pick?.binding.accountSlot).toBe("codex:openai-2");
    expect(r.pick?.credits).toBeUndefined();
    const only = nextFallback(current, [], ["gpt-6-astra"], env({ accounts: { ...TWO, codex: [{ slot: "codex:openai-1", codexHome: null, plan: "chatgpt-plus", creditsAllowed: true, order: 0 }] } as AccountsConfig }));
    expect(only.pick?.binding.accountSlot).toBe("codex:openai-1");
    expect(only.pick?.why).toContain("can draw paid credits");
  });
  test("two builders stopped: moving the signed-out one runs ONLY that one; the other stays stopped and is never re-run behind the owner's back", async () => {
    const w = world({ connected: (slot) => slot !== "claude:max-2", fallback: { auto: true, chain: ["claude-sonnet-5-5", "claude:max"] },
      builderFake: (n) => (n === 0 ? new FakeClaude({ steps: [{ text: "I committed nothing." }] }) : new FakeClaude({ steps: [{ tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 42;\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 42;\n" } } }, { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } }, { tool: "Bash", input: { command: 'git commit -m "a=42"' }, effect: { git: ["commit", "-q", "-m", "a=42"] } }, { text: "done" }] })) });
    const s = draftSpec({
      requestedBy: OWNER, channel: "typed", utterance: "x", entry: w.entry, objective: "Set a and b", doneWhen: [{ id: "c1", text: "a is 42", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
      builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280", "claude:max"), owns: { globs: ["src/b.ts"], newFiles: [] } }, { binding: claudeBinding("claude-opus-5-5", "2.1.280", "claude:max-2"), owns: { globs: ["src/a.ts"], newFiles: [] } }],
      reviewer: { binding: claudeBinding("claude-sonnet-5-5", "2.1.280", "claude:max") }, checks: ["fx.test" as never], dataClass: "synthetic",
    });
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const stopped = await until(w.store, job.id, (j) => j.state === "needs_owner" && !j.runs.some((r) => ["starting", "running"].includes(r.state)) && j.runs.filter((r) => r.roleId === "builder-2").length >= 1 && j.runs.some((r) => r.roleId === "builder-2" && r.binding.accountSlot === "claude:max" && r.state === "succeeded"));
    await until(w.store, job.id, () => !w.orch.running(job.id));
    const b1 = stopped.runs.filter((r) => r.roleId === "builder-1");
    expect(b1).toHaveLength(1); // the other builder ran once and was not run again
    expect(b1[0].state).toBe("failed");
    const b2 = stopped.runs.filter((r) => r.roleId === "builder-2");
    expect(b2.at(-1)!.binding).toMatchObject({ accountSlot: "claude:max", model: "claude-opus-5-5" }); // account moved, model not
    expect(w.launched.filter((l) => !l.readOnly)).toHaveLength(2);
    expect(w.launched.some((l) => l.readOnly)).toBe(false); // nothing was integrated, tested or reviewed with a builder still stopped
    expect(w.store.events(job.id, 0, 5000).some((e) => e.type === "spoken" && /builder-1 is still stopped/.test((e.payload as any).line))).toBe(true);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 400_000);
});
