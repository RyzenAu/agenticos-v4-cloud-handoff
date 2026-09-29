// Track 8: capability checks that time out are "unchecked", never "Broken — Start Agentic OS"
// (audit F3-06); the probes use the server's real origin and skip the self-probe when they run
// inside it (F5 P2-6); refreshes are one at a time and debounced (P2-6).
import { describe, expect, test } from "bun:test";
import { buildRegistry, probe, type Probes } from "./capability-registry";
import { serialRefresher } from "./serial-refresh";
import { toolCounts, toolStatusView } from "../src/components/shell/system-facts";

const base = (patch: Partial<Probes> = {}): Probes => ({
  osServer: true,
  hermesSkills: [{ name: "claude-os", category: "", enabled: true }],
  hermesToolsets: { terminal: true, computer_use: true, vision: true, browser: true },
  gatewayPlatforms: { telegram: "connected" },
  claudeConnectors: [],
  connectorTools: {},
  osGoogle: "configured",
  openclaw: "installed-unconfigured",
  obsidianVault: null,
  claudeBridge: true,
  jarvisChrome: true,
  notebooklm: "signed-out",
  pinecone: true,
  ...patch,
});
const byId = (reg: ReturnType<typeof buildRegistry>, id: string) => reg.find((c) => c.id === id)!;

describe("timed-out self-checks", () => {
  test("a timed-out OS or Claude-bridge check is 'unchecked' with a reason and no 'Start Agentic OS'", () => {
    const reg = buildRegistry(base({ osServer: false, claudeBridge: false, timedOut: ["osServer", "claudeBridge"] }));
    for (const id of ["voice.free", "agent.dashboard", "agent.claude-bridge", "agent.ministry"]) {
      const c = byId(reg, id);
      expect(c.status).toBe("unchecked");
      expect(c.evidence).toMatch(/didn't answer|within 8 s/);
      expect(c.ownerAction ?? "").not.toMatch(/Start Agentic OS/);
    }
  });
  test("a real failure (no timeout) is still broken and still says what to do", () => {
    const reg = buildRegistry(base({ osServer: false, claudeBridge: false }));
    expect(byId(reg, "voice.free").status).toBe("broken");
    expect(byId(reg, "voice.free").ownerAction).toMatch(/Start Agentic OS/);
    expect(byId(reg, "agent.claude-bridge").status).toBe("broken");
  });
  test("the evidence names the port that was probed", () => {
    expect(byId(buildRegistry(base({ origin: "http://127.0.0.1:4391" })), "voice.free").evidence).toContain("127.0.0.1:4391");
  });
  test("System shows 'unchecked' as 'Not checked · timed out', counted as unknown, listed with its reason", () => {
    expect(toolStatusView("unchecked")).toEqual({ label: "Not checked · timed out", tone: "neutral" });
    const reg = buildRegistry(base({ osServer: false, timedOut: ["osServer"] }));
    const counts = toolCounts({ generatedAt: "2026-09-28T03:00:00Z", capabilities: reg });
    expect(counts.broken).toBe(0);
    expect(counts.unknown).toBeGreaterThan(0);
    expect(counts.unknownItems.map((c) => c.id)).toContain("voice.free");
  });
});

describe("probe()", () => {
  const exec = async () => "";
  test("inside the server it doesn't fetch its own /__token, and it uses the real origin", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const p = await probe({ root: "C:/nowhere", exec, fetch: fetcher, hermesHome: "C:/nowhere/hermes", origin: "http://127.0.0.1:4391", self: true });
    expect(p.osServer).toBe(true);
    expect(urls.some((u) => u.endsWith("/__token"))).toBe(false);
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:4391/"))).toBe(true);
    expect(urls.some((u) => u.includes(":8081"))).toBe(false);
  });
  test("a probe that times out is recorded as timed out, not just false", async () => {
    const fetcher = (async (url: string) => {
      if (String(url).includes("/__claude/")) throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      if (String(url).endsWith("/__token")) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const p = await probe({ root: "C:/nowhere", exec, fetch: fetcher, hermesHome: "C:/nowhere/hermes", origin: "http://127.0.0.1:4391" });
    expect(p.claudeBridge).toBe(false);
    expect(p.timedOut).toEqual(["claudeBridge"]); // refused is a real failure, not a timeout
    expect(p.osServer).toBe(false);
  });
});

describe("serialRefresher", () => {
  test("a burst of scheduled refreshes makes one run after the last; a request mid-run queues exactly one more", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const r = serialRefresher(
      () =>
        new Promise<void>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          release = () => {
            active--;
            resolve();
          };
        }),
      { delayMs: 30 },
    );
    for (let i = 0; i < 5; i++) r.schedule(); // five saves in a row
    await Bun.sleep(80);
    expect(r.runs).toBe(1);
    void r.now();
    void r.now(); // both arrive while the first run is still going
    expect(r.runs).toBe(1);
    release();
    await Bun.sleep(80); // the queued follow-up runs once, after the debounce
    expect(r.runs).toBe(2);
    release();
    await Bun.sleep(10);
    expect(maxActive).toBe(1);
    r.stop();
  });
});

test("serialRefresher: a run that throws synchronously is contained, and the next run still happens", async () => {
  let calls = 0;
  const r = serialRefresher(() => {
    calls++;
    if (calls === 1) throw new TypeError("undefined is not an object");
    return Promise.resolve();
  }, { delayMs: 5 });
  await expect(r.now()).resolves.toBeUndefined();
  await r.now();
  expect(calls).toBe(2);
  r.stop();
});
