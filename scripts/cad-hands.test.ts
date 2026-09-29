import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryHealthStore } from "./model-router/health";
import { MemoryReceiptSink } from "./model-router/receipts";
import {
  CAD_APP_INSTALL,
  buildCreatePrompt,
  buildEditPrompt,
  cadAct,
  extractPythonCode,
  findBlender,
  findFreeCad,
  isScriptSafe,
  openInBlender,
  openInFreeCad,
  parseCadRequest,
  solidWorksAvailable,
  subscriptionCadLlm,
  type CadFiles,
  type CadLlm,
  type RunFn,
} from "./cad-hands";

const SAFE_SCRIPT = `from build123d import *
with BuildPart() as bp:
    Box(40, 20, 5)
    with Locations((-15, 0, 0), (15, 0, 0)):
        Hole(radius=2)
result = bp.part
`;

describe("isScriptSafe", () => {
  test("a plain build123d script that sets result passes", () => {
    expect(isScriptSafe(SAFE_SCRIPT)).toEqual({ safe: true });
  });
  test("rejects an empty script", () => {
    expect(isScriptSafe("   ").safe).toBe(false);
  });
  test("rejects a script with no result assignment", () => {
    expect(isScriptSafe("from build123d import *\nBox(1, 1, 1)\n")).toMatchObject({ safe: false, reason: "does not set a variable named result" });
  });
  test.each([
    ["import os\nresult = 1\n", /network.*file system.*process/],
    ["import subprocess\nresult = 1\n", /network.*file system.*process/],
    ["from socket import socket\nresult = 1\n", /network.*file system.*process/],
    ["import requests\nresult = 1\n", /network.*file system.*process/],
    ["__import__('os')\nresult = 1\n", /__import__/],
    ["eval('1+1')\nresult = 1\n", /eval, exec or compile/],
    ["exec('x=1')\nresult = 1\n", /eval, exec or compile/],
    ["open('x.txt')\nresult = 1\n", /open\(\)/],
    ["result = 1\nprint(open('../../secrets.txt').read())\n", /\.\.\\|open\(\)/],
    ["result = 1  # C:\\Windows\\System32\n", /absolute drive path/],
    ["result = 1  # \\\\fileserver\\share\n", /UNC network path/],
    ["result = 1  # https://example.com\n", /network URL/],
    ["import os\nos.system('echo hi')\nresult = 1\n", /network.*file system.*process/],
    ["result = 1\nx = `whoami`\n", /shell command/],
  ] as const)("rejects: %s", (code, reasonPattern) => {
    const check = isScriptSafe(code);
    expect(check.safe).toBe(false);
    expect(check.reason).toMatch(reasonPattern);
  });
});

describe("extractPythonCode", () => {
  test("pulls code out of a fenced python block", () => {
    const text = "Here you go:\n```python\nfrom build123d import *\nresult = 1\n```\n";
    expect(extractPythonCode(text)).toBe("from build123d import *\nresult = 1");
  });
  test("returns null when there is no result assignment", () => {
    expect(extractPythonCode("```python\nprint('hi')\n```")).toBeNull();
  });
  test("falls back to the raw reply when it has no fence but does set result", () => {
    expect(extractPythonCode("from build123d import *\nresult = 1")).toContain("result = 1");
  });
});

describe("prompts", () => {
  test("create prompt carries the spec and the safety rules", () => {
    const { system, prompt } = buildCreatePrompt("a 40 by 20 by 5 mm bracket with two M4 holes 30 mm apart");
    expect(prompt).toContain("a 40 by 20 by 5 mm bracket");
    expect(system).toContain("result = <the finished Part/Solid/Compound>");
    expect(system).toContain("Never call open()");
  });
  test("edit prompt carries the prior script", () => {
    const { prompt } = buildEditPrompt("make the holes 5 mm", SAFE_SCRIPT);
    expect(prompt).toContain("Hole(radius=2)");
    expect(prompt).toContain("make the holes 5 mm");
  });
});

describe("parseCadRequest", () => {
  test("needs a spec to create or edit", () => {
    expect(() => parseCadRequest({})).toThrow();
    expect(parseCadRequest({ spec: "a bracket" })).toEqual({ spec: "a bracket", job_id: undefined, action: "create" });
  });
  test("open needs no spec", () => {
    expect(parseCadRequest({ action: "open", job_id: "2026-09-25-bracket" })).toEqual({ spec: "", job_id: "2026-09-25-bracket", action: "open" });
  });
  test("rejects a job_id that isn't a plain folder name", () => {
    expect(parseCadRequest({ action: "open", job_id: "../../etc" }).job_id).toBeUndefined();
  });
});

describe("cadAct", () => {
  function fakeLlm(text: string, model = "test-model"): CadLlm {
    return async () => ({ text, model });
  }
  /** Stands in for the venv: "runs" the script by writing the files a real build123d job would. */
  function fakeRun(files: { step?: boolean; stl?: boolean; png?: boolean } = { step: true, stl: true, png: true }): RunFn {
    return async (_file, _args, cwd) => {
      if (files.step) writeFileSync(join(cwd, "model.step"), "ISO-10303-21;");
      if (files.stl) writeFileSync(join(cwd, "model.stl"), "solid model");
      if (files.png) writeFileSync(join(cwd, "model.png"), "png");
      return { code: 0, stdout: JSON.stringify({ ok: true, png: !!files.png }), stderr: "" };
    };
  }

  test("a safe script is written, run, and reported with its files", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    try {
      const result = await cadAct(
        { spec: "a 40 by 20 by 5 mm bracket with two M4 holes 30 mm apart", action: "create" },
        { jobsRoot, llm: fakeLlm(`\`\`\`python\n${SAFE_SCRIPT}\`\`\``), run: fakeRun(), now: () => Date.UTC(2026, 8, 25, 6, 0, 0) },
      );
      expect(result.ok).toBe(true);
      expect(result.said).toContain("bracket with two M4 holes");
      expect(result.files && existsSync(result.files.step)).toBe(true);
      expect(result.files && existsSync(result.files.stl)).toBe(true);
      expect(result.files && existsSync(result.files.script)).toBe(true);
      expect(result.jobId).toMatch(/^2026-09-25/);
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });

  test("an unsafe script is rejected and never handed to the sandbox", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    let ran = false;
    try {
      const unsafe = "import subprocess\nresult = 1\n";
      const result = await cadAct(
        { spec: "delete everything", action: "create" },
        {
          jobsRoot,
          llm: fakeLlm(`\`\`\`python\n${unsafe}\`\`\``),
          run: async (...args) => {
            ran = true;
            return fakeRun()(...args);
          },
          now: () => Date.UTC(2026, 8, 25, 6, 0, 0),
        },
      );
      expect(result.ok).toBe(false);
      expect(result.said).toContain("won't run that script");
      expect(ran).toBe(false);
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });

  test("a build that doesn't produce STEP/STL is reported as failed", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    try {
      const result = await cadAct(
        { spec: "an impossible shape", action: "create" },
        { jobsRoot, llm: fakeLlm(`\`\`\`python\n${SAFE_SCRIPT}\`\`\``), run: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "boom" }), stderr: "" }) },
      );
      expect(result.ok).toBe(false);
      expect(result.said).toContain("boom");
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });

  test("edit reads the previous job's script and asks the model for a change", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    try {
      const priorDir = join(jobsRoot, "2026-09-25-bracket");
      mkdirSync(priorDir, { recursive: true });
      writeFileSync(join(priorDir, "model_body.py"), SAFE_SCRIPT);
      let sentPrompt = "";
      const result = await cadAct(
        { spec: "make the holes 5 mm", job_id: "2026-09-25-bracket", action: "edit" },
        {
          jobsRoot,
          llm: async (_system, prompt) => {
            sentPrompt = prompt;
            return { text: `\`\`\`python\n${SAFE_SCRIPT.replace("radius=2", "radius=2.5")}\`\`\``, model: "test-model" };
          },
          run: fakeRun(),
        },
      );
      expect(sentPrompt).toContain("Hole(radius=2)");
      expect(sentPrompt).toContain("make the holes 5 mm");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });

  test("open resolves the newest job when no job_id is given", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    try {
      const dir = join(jobsRoot, "2026-09-25-plate");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "model.step"), "ISO-10303-21;");
      const result = await cadAct({ spec: "", action: "open" }, { jobsRoot });
      expect(result.ok).toBe(true);
      expect(result.files?.dir).toBe(dir);
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });

  test("open with nothing built yet says so plainly", async () => {
    const jobsRoot = mkdtempSync(join(tmpdir(), "cad-jobs-"));
    try {
      const result = await cadAct({ spec: "", action: "open" }, { jobsRoot });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(jobsRoot, { recursive: true, force: true });
    }
  });
});

describe("app adapters (none of these are installed on this PC, 25 Sep)", () => {
  test("FreeCAD: reports the winget command when it isn't installed", () => {
    const files: Pick<CadFiles, "dir" | "step"> = { dir: "D:\\cad-tools\\jobs\\x", step: "D:\\cad-tools\\jobs\\x\\model.step" };
    const result = openInFreeCad(files, { find: () => null });
    expect(result).toEqual({ ok: false, said: `FreeCAD isn't installed. Install it with: ${CAD_APP_INSTALL.freecad}` });
  });
  test("Blender: reports the winget command when it isn't installed", () => {
    const files: Pick<CadFiles, "dir" | "stl"> = { dir: "D:\\cad-tools\\jobs\\x", stl: "D:\\cad-tools\\jobs\\x\\model.stl" };
    const result = openInBlender(files, { find: () => null });
    expect(result).toEqual({ ok: false, said: `Blender isn't installed. Install it with: ${CAD_APP_INSTALL.blender}` });
  });
  test("findFreeCad/findBlender return null when nothing on disk matches", () => {
    expect(findFreeCad(() => false)).toBeNull();
    expect(findBlender(() => false)).toBeNull();
  });
  test("SolidWorks: honestly reports it isn't installed", () => {
    expect(solidWorksAvailable(() => false)).toEqual({ ok: false, said: "SolidWorks isn't installed on this PC." });
  });
});

describe("the CAD model call goes through the router (cad.code)", () => {
  const block = "```python\nresult = 1\n```";
  const setup = (claude: () => Promise<any>, groq: (model: string) => Response) => {
    const dir = mkdtempSync(join(tmpdir(), "cad-llm-"));
    const sink = new MemoryReceiptSink();
    const seen: string[] = [];
    const request = (async (url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      seen.push(`${url.includes("groq") ? "groq" : "other"}:${model}`);
      return groq(model);
    }) as unknown as typeof fetch;
    const llm = subscriptionCadLlm({
      root: dir,
      sink,
      health: new MemoryHealthStore(),
      deps: { env: { GROQ_API_KEY: "gsk_test" }, home: dir, request, hermesKey: () => "", claude: async (body: any) => (seen.push(`claude:${body.model}`), claude()) },
    });
    return { dir, sink, seen, llm };
  };

  test("Claude Sonnet first (rule), receipt names the model that ran", async () => {
    const h = setup(async () => ({ choices: [{ message: { content: block } }] }), () => new Response("{}", { status: 500 }));
    try {
      const out = await h.llm("system", "make a bracket");
      expect(out).toEqual({ text: block, model: "claude-sonnet-5 (Claude subscription)" });
      expect(h.sink.receipts).toHaveLength(1);
      expect(h.sink.receipts[0]).toMatchObject({ task: "cad.code", caller: "scripts/cad-hands (cad)", model: "claude/sonnet-5", providerModel: "claude-sonnet-5", route: "subscription", selectedBy: "rule", outcome: "succeeded" });
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("no code block from Claude -> Hermes next (the old fallback), then free Groq; a new linked request", async () => {
    const h = setup(
      async () => ({ choices: [{ message: { content: "I'd rather not." } }] }),
      (model) => new Response(JSON.stringify({ model, choices: [{ message: { content: block } }] }), { status: 200 }),
    );
    try {
      const out = await h.llm("system", "make a bracket");
      // Hermes isn't configured in the fixture (no API server key), so free Groq answers after it.
      expect(h.seen).toEqual(["claude:claude-sonnet-5", "groq:openai/gpt-oss-120b"]);
      expect(out).toEqual({ text: block, model: "openai/gpt-oss-120b (groq free)" });
      expect(h.sink.receipts.map((r) => [r.model, r.route, r.outcome])).toEqual([
        ["claude/sonnet-5", "subscription", "succeeded"],
        ["codex/gpt-6-sol", "subscription", "failed"],
        ["groq/gpt-oss-120b", "free", "succeeded"],
      ]);
      expect(h.sink.receipts[1].parentRequestId).toBe(h.sink.receipts[0].requestId);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
