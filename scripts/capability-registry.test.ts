import { describe, expect, test } from "bun:test";
import {
  buildRegistry,
  hermesSkill,
  parseInitServers,
  parseInitTools,
  parseCronList,
  parseOpenclawNodes,
  parseSkillTable,
  parseToolsets,
  splitConnectorTools,
  voiceSummary,
  type Probes,
} from "./capability-registry";

const probes = (patch: Partial<Probes> = {}): Probes => ({
  osServer: true,
  hermesSkills: [{ name: "claude-os", category: "", enabled: true }],
  hermesToolsets: { terminal: true, computer_use: true, vision: true, browser: true },
  gatewayPlatforms: { telegram: "connected" },
  claudeConnectors: [{ name: "claude.ai Gmail", state: "connected" }],
  connectorTools: { claude_ai_Gmail: ["search_threads", "get_thread", "send_message", "trash_thread", "create_draft"] },
  osGoogle: "configured",
  openclaw: "installed-unconfigured",
  obsidianVault: "C:\\vault",
  claudeBridge: true,
  jarvisChrome: true,
  notebooklm: "signed-out",
  pinecone: true,
  ...patch,
});

describe("parsers", () => {
  test("hermes skills table", () => {
    const table = [
      "│ Name                   │ Category             │ Source  │ Trust   │ Status  │",
      "│ claude-os              │                      │ local   │ local   │ enabled │",
      "│ codex                  │ autonomous-ai-agents │ builtin │ builtin │ disabled │",
    ].join("\n");
    expect(parseSkillTable(table)).toEqual([
      { name: "claude-os", category: "", enabled: true, source: "local" },
      { name: "codex", category: "autonomous-ai-agents", enabled: false, source: "builtin" },
    ]);
  });
  test("hermes toolsets", () => {
    expect(parseToolsets("  ✓ enabled  terminal  💻 Terminal\n  ✗ disabled  video  🎬 Video")).toEqual({ terminal: true, video: false });
  });
  test("connector statuses come from the init event; non-claude.ai servers are ignored", () => {
    const stream = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: [],
      mcp_servers: [
        { name: "claude.ai Gmail", status: "connected" },
        { name: "claude.ai Vercel", status: "pending" },
        { name: "claude.ai Neon", status: "needs-auth" },
        { name: "claude.ai Resend", status: "failed" },
        { name: "plugin:stripe:stripe", status: "needs-auth" },
      ],
    });
    expect(parseInitServers(stream)).toEqual([
      { name: "claude.ai Gmail", state: "connected" },
      { name: "claude.ai Vercel", state: "pending" },
      { name: "claude.ai Neon", state: "needs-auth" },
      { name: "claude.ai Resend", state: "failed" },
    ]);
    expect(parseInitServers("not json")).toEqual([]);
  });
  test("tool names come from the stream-json init event only", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "hook_started" }),
      JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__send_message", "mcp__plugin_x__y"] }),
      JSON.stringify({ type: "assistant", message: "mcp__claude_ai_Fake__not_a_tool" }),
    ].join("\n");
    expect(parseInitTools(stream)).toEqual({ claude_ai_Gmail: ["search_threads", "send_message"] });
  });
  test("read verbs are reads; everything else is a write", () => {
    expect(splitConnectorTools(["search_threads", "get_thread", "list-emails", "send_message", "create_draft", "trash_thread", "getaway"])).toEqual({
      readTools: ["search_threads", "get_thread", "list-emails"],
      writeTools: ["send_message", "create_draft", "trash_thread", "getaway"],
    });
  });
});

describe("registry", () => {
  test("probes give 'available', never 'working'; acceptance PASS promotes, FAIL demotes", () => {
    const base = buildRegistry(probes());
    expect(base.find((c) => c.id === "notes.obsidian")!.status).toBe("available");
    expect(base.some((c) => c.status === "working")).toBe(false);
    const tested = buildRegistry(probes(), {
      "notes.obsidian": { result: "PASS", evidence: "clip file created", at: "2026-09-23T06:00:00Z" },
      "pc.launch": { result: "FAIL", evidence: "timed out", at: "2026-09-23T06:00:00Z" },
    });
    expect(tested.find((c) => c.id === "notes.obsidian")!.status).toBe("working");
    expect(tested.find((c) => c.id === "pc.launch")!.status).toBe("broken");
  });
  test("a PASS can't hide a probe that is down now", () => {
    const registry = buildRegistry(probes({ claudeBridge: false }), { "agent.claude-bridge": { result: "PASS", evidence: "ok", at: "2026-09-23T06:00:00Z" } });
    expect(registry.find((c) => c.id === "agent.claude-bridge")!.status).toBe("broken");
  });
  test("connectors carry exact read and write tool names; owner actions appear when setup is needed", () => {
    const registry = buildRegistry(probes());
    const gmail = registry.find((c) => c.id === "connector.gmail")!;
    expect(gmail.readTools).toEqual(["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"]);
    expect(gmail.writeTools).toContain("mcp__claude_ai_Gmail__send_message");
    expect(gmail.permission).toBe("consequential");
    expect(registry.find((c) => c.id === "connector.os-google")!.ownerAction).toContain("Connect Google");
  });
  test("the Hermes skill teaches denial checks and approval rules; voice gets one short line", () => {
    const registry = buildRegistry(probes());
    const skill = hermesSkill(registry, "2026-09-23T06:00:00Z");
    expect(skill).toContain("name: jarvis-capabilities");
    expect(skill).toContain("permission_denials");
    expect(skill).toContain("mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread");
    expect(skill).toContain("explicit yes");
    expect(skill).not.toContain("His own skills");
    const withCustom = hermesSkill(registry, "2026-09-23T06:00:00Z", [
      { name: "notebooklm", category: "research", enabled: true, source: "local" },
      { name: "codex", category: "autonomous-ai-agents", enabled: true, source: "builtin" },
      { name: "jarvis-capabilities", category: "", enabled: true, source: "local" },
    ]);
    expect(withCustom).toContain("- `notebooklm` (research)");
    expect(withCustom).not.toContain("- `codex`");
    expect(withCustom).not.toContain("- `jarvis-capabilities`");
    expect(registry.find((c) => c.id === "notes.notebooklm")!.ownerAction).toContain("notebooklm login");
    const line = voiceSummary(registry);
    expect(line).toContain("Gmail");
    expect(line).toContain("Not available right now");
    expect(line.length).toBeLessThan(600);
  });
  test("OpenClaw nodes: setup until a device is connected, then available", () => {
    const find = (p: Partial<Probes>) => buildRegistry(probes(p)).find((c) => c.id === "devices.openclaw-nodes")!;
    expect(find({}).status).toBe("setup-required");
    expect(find({ openclaw: "running", openclawNodes: [] }).ownerAction).toContain("approve the pairing");
    expect(find({ openclaw: "running", openclawNodes: [{ name: "Phone", connected: false, commands: [] }] }).evidence).toContain("none connected");
    const live = find({ openclaw: "running", openclawNodes: [{ name: "Phone", connected: true, commands: ["device.status"] }] });
    expect(live.status).toBe("available");
    expect(live.permission).toBe("consequential");
    const status = 'noise\n{"nodes":[{"displayName":"Phone","connected":true,"commands":["device.status"]},{"nodeId":"abc","connected":false}]}';
    expect(parseOpenclawNodes(status)).toEqual([
      { name: "Phone", connected: true, commands: ["device.status"] },
      { name: "abc", connected: false, commands: [] },
    ]);
    expect(parseOpenclawNodes("gateway closed")).toEqual([]);
  });
  test("cron jobs and voice notes come from live probes", () => {
    const list = [
      "  c60f5ba54ac3 [active]",
      "    Name:      morning-brief",
      "    Deliver:   telegram:123",
      "    Last run:  2026-09-23T20:38:57.744706+10:00  ok",
      "",
      "  d9dc2f6b49fb [paused]",
      "    Name:      jarvis-watchdog",
      "    Deliver:   telegram:123",
    ].join("\n");
    const jobs = parseCronList(list);
    expect(jobs).toEqual([
      { name: "morning-brief", active: true, lastStatus: "ok", deliver: "telegram:123" },
      { name: "jarvis-watchdog", active: false, lastStatus: "", deliver: "telegram:123" },
    ]);
    const registry = buildRegistry(probes({ cronJobs: jobs, hermesGroqKey: true, hermesToolsets: { stt: true } }));
    expect(registry.find((c) => c.id === "proactive.morning-brief")!.status).toBe("available");
    expect(registry.find((c) => c.id === "proactive.watchdog")!.ownerAction).toContain("resume");
    expect(registry.find((c) => c.id === "voice.telegram-notes")!.status).toBe("available");
    expect(buildRegistry(probes()).find((c) => c.id === "voice.telegram-notes")!.status).toBe("setup-required");
    const failing = buildRegistry(probes({ cronJobs: [{ ...jobs[0], lastStatus: "delivery_failed: 403" }] }));
    expect(failing.find((c) => c.id === "proactive.morning-brief")!.status).toBe("broken");
  });
});

describe("the Jev reflex probe on a server-role hub (round 10)", () => {
  test("asks /voice/free/status with the local owner's proof, so a configured Jev is not reported as 'no TypeSafe key'", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { probe } = await import("./capability-registry");
    const dir = mkdtempSync(join(tmpdir(), "cap-jev-"));
    const tokenFile = join(dir, "local-owner.token");
    const synthetic = "S".repeat(48); // a synthetic token: the probe must send the proof, never print it
    writeFileSync(tokenFile, synthetic);
    const before = process.env.MU_LOCAL_OWNER_TOKEN_FILE;
    process.env.MU_LOCAL_OWNER_TOKEN_FILE = tokenFile;
    const seen: Array<{ url: string; owner: string | null }> = [];
    try {
      // The hub refuses an anonymous request on the server role; with the proof it answers jev:true.
      const fetcher = (async (url: string, init?: { headers?: Record<string, string> }) => {
        const owner = init?.headers?.["X-MU-Local-Owner"] ?? null;
        seen.push({ url: String(url), owner });
        if (String(url).endsWith("/__operator/voice/free/status")) return owner === synthetic ? Response.json({ configured: true, jev: true }) : new Response("{}", { status: 403 });
        return Response.json({});
      }) as unknown as typeof fetch;
      const p = await probe({ root: dir, exec: async () => "", fetch: fetcher, hermesHome: dir, self: true });
      expect(p.jev).toBe(true);
      expect(seen.find((s) => s.url.endsWith("/__operator/voice/free/status"))?.owner).toBe(synthetic);
    } finally {
      if (before === undefined) delete process.env.MU_LOCAL_OWNER_TOKEN_FILE;
      else process.env.MU_LOCAL_OWNER_TOKEN_FILE = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
