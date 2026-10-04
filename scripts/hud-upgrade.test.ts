import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainFromModel, holdBrain, noteBrain, publishSignal, readSignal } from "../src/lib/jarvis-signal";
import { orbParticles, renderOrb, ORB_PALETTES } from "../src/lib/model-orb-render";
import { QUICK_ACTIONS, movePin, pinnedActions, togglePin, durationLabel } from "../src/lib/quick-actions";
import { redactText } from "../src/lib/agent-feed";
import { redact, serviceDots, stepsFromMessages, toolOutput } from "./hud-feed";
import { DEFAULT_PINNED, QUICK_ACTION_IDS, normalisePins, quickActionStore, resolveBy } from "./quick-actions";

describe("model orb: which brain is answering", () => {
  test("maps real route/model names to brains", () => {
    expect(brainFromModel("rules")).toBe("jev");
    expect(brainFromModel("jev-router")).toBe("jev");
    expect(brainFromModel("openai/gpt-oss-120b")).toBe("groq"); // gpt-oss runs on Groq
    expect(brainFromModel("qwen/qwen3.8-27b")).toBe("groq");
    expect(brainFromModel("gemini-3.5-flash-lite")).toBe("gemini");
    expect(brainFromModel("gpt-6-sol")).toBe("sol");
    expect(brainFromModel("Hermes · GPT-6 Sol")).toBe("sol");
    expect(brainFromModel("claude-opus-5-5")).toBe("claude");
    expect(brainFromModel("xiaomi/mimo-v2")).toBe("mimo");
    expect(brainFromModel("")).toBe("jarvis");
    expect(brainFromModel(undefined)).toBe("jarvis");
  });
  test("a held brain wins until released, then the previous one returns", () => {
    publishSignal({ brain: "groq", model: "openai/gpt-oss-120b" });
    const release = holdBrain("sol", "Hermes · GPT-6 Sol");
    noteBrain("rules"); // ignored while Hermes works
    expect(readSignal().brain).toBe("sol");
    expect(readSignal().working).toBe(true);
    release();
    expect(readSignal().brain).toBe("groq");
    expect(readSignal().working).toBe(false);
  });
});

describe("model orb: render", () => {
  test("particles are deterministic unit vectors", () => {
    const a = orbParticles(64),
      b = orbParticles(64);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 0; i < 64; i++) expect(Math.hypot(a[i * 5], a[i * 5 + 1], a[i * 5 + 2])).toBeCloseTo(1, 5);
  });
  test("renderOrb draws every particle once per frame in every state, without throwing", () => {
    let images = 0;
    const noop = () => {};
    const ctx = new Proxy(
      { drawImage: () => images++, createRadialGradient: () => ({ addColorStop: noop }) },
      { get: (t: any, k) => (k in t ? t[k] : noop), set: () => true },
    ) as unknown as CanvasRenderingContext2D;
    const particles = orbParticles(100);
    for (const mix of [{ listen: 0, think: 0, speak: 0 }, { listen: 1, think: 0, speak: 0 }, { listen: 0, think: 1, speak: 0 }, { listen: 0, think: 0, speak: 1 }]) {
      images = 0;
      renderOrb(ctx, 3.3, { width: 200, height: 200, ...mix, mic: 0.5, out: 0.7, sprites: [{}, {}, {}] as any, palette: ORB_PALETTES.groq, compact: false }, particles);
      expect(images).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("quick actions", () => {
  test("client and server agree on the action ids", () => {
    expect(QUICK_ACTIONS.map((a) => a.id).sort()).toEqual([...QUICK_ACTION_IDS].sort());
  });
  test("every action that spends has a confirmation, and read-only ones don't", () => {
    for (const a of QUICK_ACTIONS) {
      if (a.gate === "spend") expect(a.confirm?.("Dundas Dental").body).toMatch(/Nothing is (?:dialled or )?(?:sent|deployed)|nothing is deployed or sent/i);
      else expect(a.confirm).toBeUndefined();
    }
  });
  test("pins: toggle, reorder, validate", () => {
    expect(togglePin(["a", "b"], "a")).toEqual(["b"]);
    expect(togglePin(["a"], "b")).toEqual(["a", "b"]);
    expect(movePin(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(movePin(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(pinnedActions(["daily-review", "nope"]).map((a) => a.id)).toEqual(["daily-review"]);
    expect(normalisePins(["plan-today", "daily-review"])).toEqual(["plan-today", "daily-review"]);
    expect(() => normalisePins(["plan-today", "rm-rf"])).toThrow();
    expect(() => normalisePins(["plan-today", "plan-today"])).toThrow();
    expect(() => normalisePins("plan-today")).toThrow();
  });
  test("who ran it: Tailscale identity wins over the picker", () => {
    expect(resolveBy({ name: "Mehroz" }, "usman")).toBe("Mehroz");
    expect(resolveBy(null, "mehroz")).toBe("Mehroz");
    expect(resolveBy(null, "anyone-else")).toBe("Usman");
  });
  test("store keeps pins and a redacted run log in .operator-data", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-"));
    try {
      const store = quickActionStore(root);
      expect(store.read().pinned).toEqual(DEFAULT_PINNED);
      store.setPins(["inbox-important"]);
      const entry = store.log({ action: "inbox-important", ok: true, summary: "token=abc123secret sk-live_abcdefghijkl", ms: 812.4 }, "Usman");
      expect(entry.by).toBe("Usman");
      expect(entry.ms).toBe(812);
      expect(entry.summary).not.toContain("abc123secret");
      expect(entry.summary).not.toContain("sk-live_abcdefghijkl");
      const saved = JSON.parse(readFileSync(join(root, ".operator-data", "quick-actions.json"), "utf8"));
      expect(saved.pinned).toEqual(["inbox-important"]);
      expect(saved.log).toHaveLength(1);
      expect(() => store.log({ action: "nope" }, "Usman")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("durations read like a person wrote them", () => {
    expect(durationLabel(4200)).toBe("4 s");
    expect(durationLabel(72_000)).toBe("1 min 12 s");
  });
});

describe("live agent panel: redaction and steps", () => {
  test("hides keys, tokens and anything in a .env path", () => {
    for (const r of [redact, (s: string) => redactText(s)]) {
      const out = r('cat C:\\Users\\me\\.hermes\\.env && echo OPENAI_API_KEY="sk-proj-abcdefghijklmnop" Bearer abcdefghijklmnop123 ghp_ABCDEFGHIJKLMNOP');
      expect(out).not.toMatch(/\.hermes\\\.env|sk-proj|abcdefghijklmnop|ghp_/);
      expect(out).toContain("[.env hidden]");
    }
  });
  test("tool results show their output text, one line", () => {
    expect(toolOutput('{"output": "A.md\\r\\nB.md\\r\\n", "exit_code": 0}')).toBe("A.md · B.md");
    expect(toolOutput("plain\ntext")).toBe("plain · text");
  });
  test("state.db rows become tool / result / say steps", () => {
    const steps = stepsFromMessages([
      { role: "assistant", content: "", tool_calls: JSON.stringify([{ function: { name: "terminal", arguments: JSON.stringify({ command: "Get-ChildItem docs" }) } }]), timestamp: 1 },
      { role: "tool", tool_name: "terminal", content: '{"output": "README.md", "exit_code": 0, "error": null}', timestamp: 2 },
      { role: "tool", tool_name: "terminal", content: '{"success": false, "error": "denied"}', timestamp: 3 },
      { role: "assistant", content: "Listed the files.", timestamp: 4 },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["tool", "result", "error", "say"]);
    expect(steps[0]).toMatchObject({ name: "terminal", text: "Get-ChildItem docs" });
    expect(steps[1].text).toBe("README.md");
  });
  test("service dots come from the registry and cheap local pings only", async () => {
    const asked: string[] = [];
    const fakeFetch = (async (url: string) => {
      asked.push(String(url));
      return new Response("", { status: String(url).includes("18888") ? 502 : 200 });
    }) as unknown as typeof fetch;
    const dots = await serviceDots(
      [
        { id: "voice.jev-reflex", status: "available", evidence: "TypeSafe key present" },
        { id: "channel.telegram", status: "setup-required", evidence: "no token" },
      ],
      fakeFetch,
    );
    // UI-truth M4: "available" is a key present, not a verified probe, so Jev is unknown, not up.
    expect(Object.fromEntries(dots.map((d) => [d.id, d.state]))).toEqual({ hermes: "up", jev: "unknown", hindsight: "up", searxng: "down", telegram: "warn" });
    expect(asked.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
  });
});
