import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHealth } from "./health";
import { hubIsDeviceFor, hubRole, hubRoleGate, needsCompanionBody, pcOnlyCapabilityFor, pcOnlyReport, PC_ONLY_CAPABILITIES } from "./hub-role";

/**
 * The three hub roles. `pc` and `cloud` must behave exactly as they did before `server` existed; the
 * gate decision for every route and caller is proved against the pre-change gate in
 * scripts/identity/server-role.test.ts. Here: the role word, the 501 groups, health and the device flag.
 */

describe("hubRole() returns server only for the word server", () => {
  test("server, with the same trim/case rule cloud has always had", () => {
    expect(hubRole({ MU_HUB_ROLE: "server" })).toBe("server");
    expect(hubRole({ MU_HUB_ROLE: " Server " })).toBe("server");
    expect(hubRole({ MU_HUB_ROLE: "SERVER" })).toBe("server");
  });
  test("everything else is exactly as before", () => {
    expect(hubRole({})).toBe("pc");
    expect(hubRole({ MU_HUB_ROLE: "" })).toBe("pc");
    expect(hubRole({ MU_HUB_ROLE: "pc" })).toBe("pc");
    for (const v of ["servers", "server2", "server-role", "srv", "headless", "serve", "banana", "1", "true", "cloud server", "server cloud"]) expect([v, hubRole({ MU_HUB_ROLE: v })]).toEqual([v, "pc"]);
    expect(hubRole({ MU_HUB_ROLE: "cloud" })).toBe("cloud");
    expect(hubRole({ MU_HUB_ROLE: " Cloud " })).toBe("cloud");
  });
});

/** Every URL the capability regexes can match, plus neighbours that must not, generated from the table. */
function sampleUrls(): string[] {
  const out = new Set<string>(["/__operator/screen/command", "/__operator/leads", "/__jobs", "/__health", "/__claude_chat", "/__devices/me", "/__operator/agent-jobs/status"]);
  const seeds = [
    "/__operator/screen/act", "/__operator/screen/stop", "/__operator/pc/act", "/__operator/cad/act", "/__operator/open-url", "/__operator/vision/describe",
    "/__operator/browser/act", "/__claude", "/__claude/v1/models", "/__claude_chat", "/__claude_chats", "/__hermes", "/__hermes_chat", "/__hermes_status", "/__cline/v1/models",
    "/__ccr_pin_routes", "/__mcp_approvals", "/__permission_decision", "/__question_answer", "/__chat_title", "/__sessions_live", "/__trigger_dream",
    "/__dream_action", "/__dream_engines", "/__set_dream_engine", "/__operator/agent-jobs", "/__operator/agent-jobs/check", "/__operator/hermes/task", "/__start_voice", "/__fish_tts", "/__fish_tts/x",
  ];
  for (const s of seeds) {
    out.add(s);
    out.add(`${s}/`);
    out.add(`${s}?x=1`);
    out.add(`${s}x`);
    out.add(`${s}/sub`);
  }
  return [...out];
}

function run(role: "pc" | "cloud" | "server", url: string) {
  const res = { statusCode: 200, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: string) { this.body = b ?? ""; } };
  let nexted = false;
  hubRoleGate(role)({ url } as never, res as never, () => { nexted = true; });
  return { res, nexted };
}

/** The gate as it was before the server role: cloud refuses every listed capability, pc nothing. Written once, from the old code. */
function legacy(role: "pc" | "cloud", url: string): "next" | { id: string } {
  if (role !== "cloud") return "next";
  const cap = pcOnlyCapabilityFor((url.split("?")[0]).replace(/\/+$/, "") || "/");
  return cap ? { id: cap.id } : "next";
}

describe("the 501 gate", () => {
  test("pc and cloud answer exactly as before for every sample URL (generated from the capability table)", () => {
    const urls = sampleUrls();
    expect(urls.length).toBeGreaterThan(100);
    for (const role of ["pc", "cloud"] as const)
      for (const url of urls) {
        const want = legacy(role, url);
        const { res, nexted } = run(role, url);
        if (want === "next") expect([role, url, nexted, res.statusCode]).toEqual([role, url, true, 200]);
        else {
          expect([role, url, nexted, res.statusCode]).toEqual([role, url, false, 501]);
          expect(JSON.parse(res.body)).toEqual({ ok: false, status: "needs-companion", capability: want.id, hubRole: "cloud", error: PC_ONLY_CAPABILITIES.find((c) => c.id === want.id)!.say });
        }
      }
  });

  test("server: windows-control, agent-browser and local-voice-stack are 501 (the same capabilities cloud refuses), with a server-honest line", () => {
    const refused: Record<string, string[]> = {
      "windows-control": ["/__operator/screen/act", "/__operator/screen/stop", "/__operator/pc/act", "/__operator/cad/act", "/__operator/open-url", "/__operator/vision/describe"],
      "agent-browser": ["/__operator/browser/act"],
      "local-voice-stack": ["/__start_voice", "/__fish_tts", "/__fish_tts/x"],
    };
    for (const [id, urls] of Object.entries(refused))
      for (const url of urls) {
        const { res, nexted } = run("server", url);
        expect([url, nexted, res.statusCode]).toEqual([url, false, 501]);
        const body = JSON.parse(res.body);
        expect(body).toMatchObject({ ok: false, status: "needs-companion", capability: id, hubRole: "server" });
        expect(body.error).toMatch(/companion/i);
        expect(body.error).not.toMatch(/cloud hub/i);
        expect(run("cloud", url).res.statusCode).toBe(501); // cloud refuses the very same routes
      }
  });

  test("server: local-cli-agents stay available (Claude, Codex, Hermes, Cline bridges and agent jobs)", () => {
    const cap = PC_ONLY_CAPABILITIES.find((c) => c.id === "local-cli-agents")!;
    expect(cap.availableOnServer).toBe(true);
    for (const url of ["/__claude_chat", "/__claude/v1/models", "/__hermes_chat", "/__hermes_status", "/__cline/v1/models", "/__operator/agent-jobs", "/__operator/agent-jobs/status", "/__operator/hermes/task", "/__ccr_pin_routes", "/__trigger_dream", "/__permission_decision"]) {
      expect(pcOnlyCapabilityFor(url)?.id).toBe("local-cli-agents");
      expect([url, run("server", url).nexted, run("server", url).res.statusCode]).toEqual([url, true, 200]);
      expect(run("cloud", url).res.statusCode).toBe(501); // the cloud has no CLIs
    }
  });

  test("server: the Jarvis command path and business routes are not listed, so they keep working", () => {
    for (const url of ["/__operator/screen/command", "/__operator/leads", "/__jobs", "/__approvals/abc", "/__memory/buckets", "/__devices/me", "/__health"]) expect([url, run("server", url).nexted]).toEqual([url, true]);
  });

  test("the refusal is by path only, so it is the same for a loopback caller as for anyone else", () => {
    // hubRoleGate never reads the socket, headers or principal; a request object with only a url is enough.
    expect(hubRoleGate("server").length).toBe(3);
    expect(run("server", "/__operator/browser/act").res.statusCode).toBe(501);
  });
});

describe("hub is a device only in the pc role", () => {
  test("hubIsDeviceFor", () => {
    expect(hubIsDeviceFor("pc")).toBe(true);
    expect(hubIsDeviceFor("cloud")).toBe(false);
    expect(hubIsDeviceFor("server")).toBe(false);
  });
});

describe("health and the pcOnly report", () => {
  test("pcOnlyReport: pc and cloud unchanged; server runs the CLI agents here and sends the desktop groups to the companion", () => {
    expect(pcOnlyReport("pc").every((r) => r.status === "runs-here" && r.detail === "Runs on this PC.")).toBe(true);
    expect(pcOnlyReport("cloud").every((r, i) => r.status === "runs-on-your-pc" && r.detail === PC_ONLY_CAPABILITIES[i].say)).toBe(true);
    const server = Object.fromEntries(pcOnlyReport("server").map((r) => [r.id, r.status]));
    expect(server).toEqual({ "windows-control": "runs-on-your-pc", "agent-browser": "runs-on-your-pc", "local-cli-agents": "runs-here", "local-voice-stack": "runs-on-your-pc" });
  });
  test("needsCompanionBody keeps the cloud wording and adds a server one", () => {
    const cap = PC_ONLY_CAPABILITIES[0];
    expect(needsCompanionBody(cap, "cloud")).toEqual({ ok: false, status: "needs-companion", capability: cap.id, hubRole: "cloud", error: cap.say });
    expect(needsCompanionBody(cap, "server").hubRole).toBe("server");
  });
  test("/__health reports hubRole: server", async () => {
    const base = existsSync("D:/") ? "D:/tmp" : tmpdir();
    mkdirSync(base, { recursive: true });
    const work = mkdtempSync(join(base, "mu-role-health-"));
    try {
      const h = await collectHealth({
        root: work,
        env: { MU_DATA_DIR: work, MU_HUB_ROLE: "server", HINDSIGHT_URL: "off" },
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        version: async () => ({ version: "9.9.9", gitSha: "abc1234", dirty: false, buildTime: "" }),
        jobs: () => ({ owner: true }),
        companions: () => ({ online: 0, total: 0 }),
      });
      expect(h.hubRole).toBe("server");
      expect(h.pcOnly.map((p) => p.status)).toEqual(["runs-on-your-pc", "runs-on-your-pc", "runs-here", "runs-on-your-pc"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
