// W-C: Hermes load speed (last-known values, spawn-free version), skills sync and owner profile.
// Synthetic fixtures only, in a temp folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLastKnown } from "./last-known";
import { hermesVersionFromInstall, memoryProviderFromConfig, parseHermesVersionFile, parseMemoryStatus, parseProfileList } from "./fast-status";
import {
  MANIFEST_NAME,
  SYNC_CATEGORY,
  claudeOnlyReason,
  collectSkillFiles,
  readLastReport,
  secretReason,
  syncSkillsToHermes,
} from "./skill-sync";
import {
  ENTRY_DELIMITER,
  OWNER_MARK,
  ageFrom,
  buildOwnerProfile,
  hermesMemoryScan,
  ownerProfileState,
  parseEntries,
  screenSensitive,
  suburbFrom,
  userCharLimit,
  writeOwnerProfile,
} from "./owner-profile";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wc-hermes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function w(p: string, text: string) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text, "utf-8");
}

describe("last-known values", () => {
  test("answers at once, refreshes in the background, keeps the old value on failure", async () => {
    let clock = 1_000;
    let calls = 0;
    let fail = false;
    const lk = createLastKnown<number>({
      ttlMs: 100,
      now: () => clock,
      load: async () => {
        calls++;
        if (fail) throw new Error("cli hung");
        return calls * 10;
      },
    });
    const first = lk.read();
    expect(first.value).toBeNull();
    expect(first.checkedAt).toBeNull();
    expect(first.refreshing).toBe(true);
    await lk.refresh();
    expect(lk.read()).toMatchObject({ value: 10, checkedAt: 1_000, refreshing: false });
    expect(calls).toBe(1); // fresh: no new run
    clock += 500;
    fail = true;
    const stale = lk.read(); // stale: serves 10 and starts a refresh
    expect(stale.value).toBe(10);
    await lk.refresh();
    const after = lk.read();
    expect(after.value).toBe(10);
    expect(after.error).toBe("cli hung");
    // Backing off after a failure: no respawn on every poll.
    const callsNow = calls;
    lk.read();
    lk.read();
    expect(calls).toBe(callsNow);
  });

  test("one run at a time, and the value survives a restart on disk", async () => {
    const persistPath = join(dir, "cache", "x.json");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lk = createLastKnown<string>({ ttlMs: 1_000, persistPath, load: async () => (calls++, await gate, "profiles") });
    lk.read();
    lk.read();
    const p = lk.refresh();
    release();
    await p;
    expect(calls).toBe(1);
    const again = createLastKnown<string>({ ttlMs: 60_000, persistPath, load: async () => "new" });
    expect(again.read().value).toBe("profiles");
  });
});

describe("spawn-free Hermes version and CLI parsers", () => {
  test("version comes from the installed hermes_cli/__init__.py", () => {
    const root = join(dir, "hermes");
    w(join(root, "hermes-agent", "hermes_cli", "__init__.py"), '__version__ = "0.21.3"\n__release_date__ = "2026.9.14"\n');
    w(join(root, "bin", "hermes.exe"), "");
    expect(hermesVersionFromInstall(join(root, "bin", "hermes.exe"), join(dir, "nohome"))).toBe("Hermes Agent v0.21.3 (2026.9.14)");
    expect(hermesVersionFromInstall(null, root)).toBe("Hermes Agent v0.21.3 (2026.9.14)");
    expect(hermesVersionFromInstall(null, join(dir, "missing"))).toBeNull();
    expect(parseHermesVersionFile("nothing here")).toBeNull();
  });

  test("profile list and memory status parse the Rich tables", () => {
    const table = [
      "┏━━━━━━━━━━┳━━━━━━━━━━━━━┳━━━━━━━━━┓",
      "┃ Name     ┃ Model       ┃ Gateway ┃",
      "┡━━━━━━━━━━╇━━━━━━━━━━━━━╇━━━━━━━━━┩",
      "│ ◆default │ gpt-6-sol   │ running │",
      "│ mu-sales │ deepseek-v4 │ —       │",
      "└──────────┴─────────────┴─────────┘",
    ].join("\n");
    expect(parseProfileList(table)).toEqual([
      { name: "default", model: "gpt-6-sol", gateway: "running", alias: null, distribution: null, active: true },
      { name: "mu-sales", model: "deepseek-v4", gateway: null, alias: null, distribution: null, active: false },
    ]);
    expect(parseMemoryStatus("Provider: hindsight\n  • mem0  (requires API key)\n  • honcho")).toEqual({
      active: "hindsight",
      available: [
        { name: "mem0", needsKey: true },
        { name: "honcho", needsKey: false },
      ],
    });
    expect(memoryProviderFromConfig("model:\r\n  default: x\r\nmemory:\r\n  provider: hindsight\r\n  memory_enabled: true\r\n")).toBe("hindsight");
    expect(memoryProviderFromConfig("memory:\n  memory_enabled: true\n")).toBeNull();
  });
});

describe("skills sync", () => {
  function fixture() {
    const claude = join(dir, "claude");
    const hermes = join(dir, "hermes");
    w(join(claude, "skills", "offer-check", "SKILL.md"), "---\nname: offer-check\ndescription: Score an offer.\n---\n\nScore it.\n");
    w(join(claude, "skills", "offer-check", "references", "rubric.md"), "Rubric.\n");
    w(join(claude, "skills", "offer-check", ".env"), "SYNTHETIC=1\n");
    w(join(claude, "skills", "offer-check", "notes.md"), "key: sk-ant-" + "a".repeat(30) + "\n");
    w(join(claude, "skills", "ask-first", "SKILL.md"), "---\nname: ask-first\ndescription: x\n---\n\nUse AskUserQuestion to ask.\n");
    w(join(claude, "skills", "chain", "SKILL.md"), "---\nname: chain\ndescription: x\ndisable-model-invocation: true\n---\n\nCall the Skill tool.\n");
    w(join(claude, "skills", "pay", "SKILL.md"), "---\nname: pay\ndescription: Helps users send funds to another business.\n---\n\n# `stripe pay`\n");
    w(join(claude, "skills", "leaky", "SKILL.md"), "---\nname: leaky\ndescription: x\n---\n\nghp_" + "b".repeat(36) + "\n");
    w(join(claude, "skills", "my-tone", "SKILL.md"), "---\nname: my-tone\ndescription: tone\n---\n\nTone.\n");
    w(join(claude, "skills", "not-a-skill", "README.md"), "no skill file\n");
    w(join(claude, "skills", "synced", "abc", "docx", "SKILL.md"), "---\nname: docx\n---\n");
    w(join(hermes, "skills", "my-tone", "SKILL.md"), "---\nname: my-tone\ndescription: Hermes' own\n---\n");
    w(join(hermes, "skills", "research", "arxiv", "SKILL.md"), "---\nname: arxiv\ndescription: papers\n---\n");
    return { claude, hermes };
  }

  test("classifies Claude-only, money-moving and secret-looking skills", () => {
    expect(claudeOnlyReason("---\nname: a\n---\nUse the AskUserQuestion tool")).toMatch(/AskUserQuestion/);
    expect(claudeOnlyReason("---\nname: a\n---\nCall the Skill tool with x")).toMatch(/Skill tool/);
    expect(claudeOnlyReason("---\nname: a\n---\nUse Claude in Chrome (`mcp__claude-in-chrome__*`)")).toMatch(/Chrome/);
    expect(claudeOnlyReason("---\nname: a\ndescription: Helps users send funds to a business\n---\n")).toMatch(/money/);
    expect(claudeOnlyReason("---\nname: a\ndescription: Works in Claude Code, Codex and Hermes.\n---\nUse WebFetch or any web tool.")).toBeNull();
    expect(secretReason(".env.local", null)).toMatch(/credential/);
    expect(secretReason("id_ed25519", null)).toMatch(/credential/);
    expect(secretReason("notes.md", Buffer.from("AKIA" + "ABCDEFGHIJKLMNOP"))).toMatch(/key or token/);
    expect(secretReason("notes.md", Buffer.from("api_key = YOUR_API_KEY_HERE"))).toBeNull();
    expect(secretReason("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBeNull();
  });

  test("copies usable skills once, withholds secrets, skips with reasons, backs up first", () => {
    const { claude, hermes } = fixture();
    const clock = () => new Date("2026-09-29T04:00:00Z");
    const dry = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, dryRun: true, now: clock });
    expect(dry.results.map((r) => [r.name, r.outcome])).toEqual([["offer-check", "would-add"]]);
    expect(existsSync(join(hermes, "skills", SYNC_CATEGORY))).toBe(false);

    const run = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, now: clock });
    expect(run.counts).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    const reasons = Object.fromEntries(run.skipped.map((s) => [s.name, s.reason]));
    expect(reasons["ask-first"]).toMatch(/AskUserQuestion/);
    expect(reasons.chain).toMatch(/slash-command/);
    expect(reasons.pay).toMatch(/money/);
    expect(reasons.leaky).toMatch(/SKILL\.md looks like/);
    expect(reasons["my-tone"]).toMatch(/Hermes already has it/);
    expect(reasons["not-a-skill"]).toBe("no SKILL.md");
    expect(reasons["synced/*"]).toMatch(/Anthropic-managed/);
    const dest = join(hermes, "skills", SYNC_CATEGORY, "offer-check");
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain("Score it.");
    expect(existsSync(join(dest, "references", "rubric.md"))).toBe(true);
    expect(existsSync(join(dest, ".env"))).toBe(false);
    expect(existsSync(join(dest, "notes.md"))).toBe(false);
    expect(run.results[0].withheld.map((x) => x.file).sort()).toEqual([".env", "notes.md"]);
    // Backed up before writing: the old skills tree, untouched.
    expect(run.backup).not.toBeNull();
    expect(existsSync(join(run.backup!, "skills", "research", "arxiv", "SKILL.md"))).toBe(true);
    expect(existsSync(join(hermes, "skills", SYNC_CATEGORY, MANIFEST_NAME))).toBe(true);
    expect(readLastReport(hermes)?.counts.added).toBe(1);

    // Idempotent: a second run changes nothing and makes no backup.
    const again = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, now: clock });
    expect(again.results.map((r) => r.outcome)).toEqual(["unchanged"]);
    expect(again.backup).toBeNull();

    // A source edit updates; an edit Hermes made to its copy is kept, not overwritten.
    w(join(claude, "skills", "offer-check", "SKILL.md"), "---\nname: offer-check\ndescription: Score an offer.\n---\n\nScore it twice.\n");
    const updated = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, now: () => new Date("2026-09-29T05:00:00Z") });
    expect(updated.results[0].outcome).toBe("updated");
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain("twice");
    w(join(dest, "SKILL.md"), "---\nname: offer-check\n---\n\nHermes improved this.\n");
    w(join(claude, "skills", "offer-check", "SKILL.md"), "---\nname: offer-check\ndescription: v3\n---\n\nThird.\n");
    const kept = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, now: () => new Date("2026-09-29T06:00:00Z") });
    expect(kept.results[0].outcome).toBe("kept-hermes-edit");
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain("Hermes improved this.");

    // A source that disappears is left in Hermes (nothing deleted).
    rmSync(join(claude, "skills", "offer-check"), { recursive: true, force: true });
    const orphan = syncSkillsToHermes({ claudeHome: claude, hermesHome: hermes, now: () => new Date("2026-09-29T07:00:00Z") });
    expect(orphan.orphaned).toEqual(["offer-check"]);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    // Only a few backups are kept.
    const backups = readdirSync(join(hermes, "backups", "agentic-os-skill-sync"));
    expect(backups.length).toBeLessThanOrEqual(3);
  });

  test("files are collected sorted, without caches or big files", () => {
    const skill = join(dir, "s");
    w(join(skill, "SKILL.md"), "---\nname: s\n---\n");
    w(join(skill, "node_modules", "x.js"), "x");
    w(join(skill, "__pycache__", "a.pyc"), "x");
    w(join(skill, "b.md"), "b");
    writeFileSync(join(skill, "huge.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const { files, withheld } = collectSkillFiles(skill);
    expect(files.map((f) => f.rel)).toEqual(["SKILL.md", "b.md"]);
    expect(withheld).toEqual([{ file: "huge.bin", reason: "larger than 2 MB" }]);
  });
});

describe("owner profile", () => {
  function wiki() {
    const root = join(dir, "vault");
    const wk = join(root, "wiki");
    w(
      join(wk, "topics", "personal", "usman", "usman.md"),
      "---\ntitle: Sam\n---\n\n# Sam\n\n## Identity\n- **Full legal name:** Samuel Example Person\n- **Goes by:** Sam almost always. **Samuel** for important legal matters.\n- **Born:** 1 March 2005 · **age 21**\n\n## Contact\n- **Phone:** 0400 000 000\n- **Email (personal):** sam@example.test\n- **Address:** 1/2 Example Street, Parramatta NSW 2150\n- **Timezone:** Australia/Sydney (AEST/AEDT)\n\n## Education\n**Bachelor of Testing**, Example Uni — completed **June 2026**.\n\n## Faith\nMuslim. **Hafiz** — the Quran is already memorised; the ongoing work is revising it.\n\n## Work\n**Co-founder of [[example-co]], 50/50 with [[alex]].**\n",
    );
    w(join(wk, "topics", "personal", "mehroz", "mehroz.md"), "---\ntitle: Alex\n---\n\n# Alex\n\n## Identity\n- **Born:** 2 February 2004 · **age 22**\n\n## Contact\n- **Phone:** 0400 111 111\n\n## Education\n**Engineering** at **Example Tech** — still studying.\n\n## Faith\nMuslim. **Hafiz**.\n");
    w(join(wk, "topics", "personal", "shared-goals.md"), "---\ntitle: Shared Goals\n---\n\n# Shared Goals\n\n- **Grow [[example-co]] to $10k/month**.\n- **Read more.**\n\n## Related\n- [[sam]] · [[alex]]\n");
    w(join(wk, "entities", "mu-ventures.md"), "---\ntitle: Example Co\n---\n\n# Example Co\n\nThe two-person synthetic business founded by [[sam]] and [[alex]]. More.\n\n## Ownership\n**50/50 between the two co-founders.**\n\n## What it sells\nWebsites for small businesses — demonstrated through demos.\n");
    w(join(wk, "entities", "example-co.md"), "---\ntitle: Example Co\n---\n");
    const claudeMd = join(dir, "CLAUDE.md");
    w(claudeMd, "# Global\n\n## Who I am\n**Samuel Example Person**. 21, born 1 March 2005. Parramatta, NSW. Degree.\nI am not a beginner: skip basics.\n\n## How to work with me\n- **Act, don't survey.** Give me a recommendation.\n- **Australian English.** Organise.\n");
    return { wikiRoot: root, claudeMdPath: claudeMd, now: () => new Date("2026-09-29T00:00:00Z") };
  }

  test("builds three marked entries with no contact details, street or birth date", () => {
    const built = buildOwnerProfile(wiki());
    expect(built.entries).toHaveLength(3);
    for (const e of built.entries) {
      expect(e.startsWith(OWNER_MARK)).toBe(true);
      expect(e).not.toMatch(/0400|@example|Example Street|1 March|2150|born/i);
    }
    expect(built.entries[0]).toContain("Samuel Example Person, called Sam (Samuel for legal matters)");
    expect(built.entries[0]).toContain("21, lives in Parramatta NSW (Australia/Sydney)");
    expect(built.entries[0]).toContain("Muslim and hafiz");
    expect(built.entries[1]).toContain("Co-founder of Example Co with Alex, equal 50/50 partners");
    expect(built.entries[1]).toContain("Alex (22; Engineering at Example Tech, still studying; also hafiz) may message too");
    expect(built.entries[2]).toContain("grow Example Co to $10k/month; read more.");
    expect(built.entries[2]).not.toContain("Sam · Alex");
    expect(built.entries[2]).toContain("act, don't survey");
    expect(built.entries[2]).toContain("Australian English");
  });

  test("helpers: age without the date, suburb only, sensitive screen, char limit", () => {
    expect(ageFrom("24 December 2004 · age 21", new Date("2026-09-29"))).toBe(21);
    expect(ageFrom("24 December 2004", new Date("2026-12-27"))).toBe(22);
    expect(suburbFrom("## Who I am\n21. Mount Druitt, NSW. Degree.", "")).toBe("Mount Druitt NSW");
    expect(suburbFrom("", "7/1 Example Street, Mount Druitt NSW 2770")).toBe("Mount Druitt NSW");
    expect(screenSensitive("Fine. Call 0451 000 000. Mail a@b.co. Lives at 7/1 Example Street. Born 1 March 2004. Ok.").text).toBe("Fine. Ok.");
    expect(userCharLimit("memory:\r\n  user_char_limit: 2000\r\n")).toBe(2000);
    expect(userCharLimit("model:\n  default: x\n")).toBe(1375);
  });

  test("writes USER.md the way Hermes' memory tool reads it, keeps Hermes' own entries, backs up", () => {
    const src = wiki();
    const hermesHome = join(dir, "hermes");
    w(join(hermesHome, "config.yaml"), "memory:\n  user_char_limit: 1375\n");
    w(join(hermesHome, "memories", "USER.md"), "Prefers short replies.\r\n§\r\nUses Windows 11.");
    const res = writeOwnerProfile({ ...src, hermesHome });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.backup && existsSync(res.backup)).toBe(true);
    const raw = readFileSync(join(hermesHome, "memories", "USER.md"), "utf-8");
    expect(raw).not.toContain("\r");
    const entries = parseEntries(raw);
    expect(raw.trim()).toBe(entries.join(ENTRY_DELIMITER)); // round-trips (Hermes' drift guard)
    expect(entries.slice(0, 3).every((e) => e.startsWith(OWNER_MARK))).toBe(true);
    expect(entries.slice(3)).toEqual(["Prefers short replies.", "Uses Windows 11."]);
    expect(raw.length).toBeLessThanOrEqual(1375);
    // Idempotent.
    const again = writeOwnerProfile({ ...src, hermesHome });
    expect(again).toMatchObject({ ok: true, changed: false, backup: null });
    expect(ownerProfileState({ ...src, hermesHome }).inSync).toBe(true);
  });

  test("refuses to overflow the user_char_limit and writes nothing", () => {
    const src = wiki();
    const hermesHome = join(dir, "hermes");
    w(join(hermesHome, "config.yaml"), "memory:\n  user_char_limit: 300\n");
    const res = writeOwnerProfile({ ...src, hermesHome });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/user_char_limit/);
    expect(existsSync(join(hermesHome, "memories", "USER.md"))).toBe(false);
  });

  test("Hermes' own memory scan: findings map per entry; no Python means no verdict", async () => {
    const agent = join(dir, "agent");
    expect(await hermesMemoryScan(["a"], agent, async () => ({ status: 0, stdout: "[null]" }))).toBeNull();
    w(join(agent, "venv", "Scripts", "python.exe"), "");
    w(join(agent, "venv", "bin", "python"), "");
    w(join(agent, "tools", "threat_patterns.py"), "");
    expect(await hermesMemoryScan(["a", "b"], agent, async () => ({ status: 0, stdout: 'noise\n[null, "prompt injection"]\n' }))).toEqual([null, "prompt injection"]);
    expect(await hermesMemoryScan(["a"], agent, async () => ({ status: 1, stdout: "" }))).toBeNull();
  });
});

describe("request paths run no Hermes CLI (the page no longer waits on Python start-up)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "vite.config.ts"), "utf-8");
  const handler = (route: string) => {
    const start = src.indexOf(`server.middlewares.use("${route}"`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("server.middlewares.use(", start + 10);
    // Code only: comments may name the old commands.
    return src.slice(start, next === -1 ? undefined : next).replace(/\/\/[^\n]*/g, "");
  };
  for (const route of ["/__hermes_status", "/__hermes_profiles", "/__hermes_memory", "/__hermes_connections", "/__hermes_sessions"]) {
    test(route, () => {
      const body = handler(route);
      expect(body).not.toMatch(/\b(?:runText|runCapture|runFileText|execSync|spawnSync|execFileSync)\(/);
      expect(body).not.toMatch(/hermes (?:profile list|memory status|--version)/);
    });
  }
  test("the slow readouts are last-known values refreshed in the background", () => {
    expect(src).toContain("hermesProfilesKnown.read()");
    expect(src).toContain("hermesMemoryStatusKnown.read()");
    expect(src).toContain("hermesCliServicesKnown.read()");
    expect(src).toContain("hermesSessionsKnown.read()");
    expect(src).toContain("hermesVersionFromInstall(binPath, hermesDir)");
  });
});

describe("the customise plugin", () => {
  type Handler = (req: any, res: any, next: () => void) => void;
  function mount(opts: { atHub?: boolean; tokenOk?: boolean; report?: any }) {
    const routes = new Map<string, Handler>();
    const calls: boolean[] = [];
    const { hermesCustomisePlugin } = require("./plugin") as typeof import("./plugin");
    const plugin = hermesCustomisePlugin({
      root: dir,
      atHub: () => opts.atHub ?? true,
      tokenOk: () => opts.tokenOk ?? true,
      hermesBin: () => undefined,
      runSkillSync: async (dryRun) => (calls.push(dryRun), opts.report ?? { dryRun, counts: { added: 0 } }),
    });
    (plugin.configureServer as any)({ middlewares: { use: (path: string, fn: Handler) => routes.set(path, fn) } });
    return { routes, calls };
  }
  function call(fn: Handler, method: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
      const { Readable } = require("node:stream");
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.headers = { "content-type": "application/json" };
      const res: any = { statusCode: 200, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, end(text: string) { resolve({ status: this.statusCode, json: JSON.parse(text) }); } };
      fn(req, res, () => resolve({ status: 404, json: null }));
    });
  }

  test("hub-only, and a POST needs the page token", async () => {
    const remote = mount({ atHub: false });
    expect((await call(remote.routes.get("/__hermes_skill_sync")!, "GET")).status).toBe(403);
    expect((await call(remote.routes.get("/__hermes_owner_profile")!, "GET")).status).toBe(403);
    const noToken = mount({ tokenOk: false });
    expect((await call(noToken.routes.get("/__hermes_skill_sync")!, "POST", {})).status).toBe(403);
    expect(noToken.calls).toEqual([]);
  });

  test("POST runs the sync (dry run passed through) and GET reads the last report", async () => {
    const m = mount({});
    const dry = await call(m.routes.get("/__hermes_skill_sync")!, "POST", { dryRun: true });
    expect(dry.status).toBe(200);
    expect(m.calls).toEqual([true]);
    const real = await call(m.routes.get("/__hermes_skill_sync")!, "POST", {});
    expect(real.status).toBe(200);
    expect(m.calls).toEqual([true, false]);
    const got = await call(m.routes.get("/__hermes_skill_sync")!, "GET");
    expect(got.status).toBe(200);
    expect(got.json).toHaveProperty("report");
    expect(got.json.running).toBe(false);
  });
});