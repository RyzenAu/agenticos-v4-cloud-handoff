// Jarvis's CAD hands: turn a spoken or typed spec ("make a 40 by 20 by 5 mm bracket with two
// M4 holes 30 mm apart") into a real 3D model. An LLM, through the model router (task cad.code, in
// its pre-E2 order: Claude Sonnet on the subscription, then Hermes' warm gateway, with free Groq added
// after; a receipt per attempt; same shape as scripts/meeting-mode/llm.ts) writes a build123d
// script; it runs only inside the sandbox venv on
// D: (D:\cad-tools\venv, kept off C: which is low on disk) with a restricted working directory,
// after a static safety filter rejects anything that reaches for the network, the file system
// outside the job folder, or another process. The trusted runner (not LLM-authored) does the
// STEP/STL export and the PNG render, so the generated script never touches a file path itself.
//
// Everything for one request lands in D:\cad-tools\jobs\<timestamp>-<slug>\: model_body.py (the
// generated script, kept so "make the holes 5 mm" can edit it), runner.py, model.step, model.stl,
// model.png and meta.json. Nothing here sends, pays, deletes or installs anything.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RoutedChatDeps } from "./model-router/chat";
import type { HealthStore } from "./model-router/health";
import type { ReceiptSink } from "./model-router/receipts";
import type { ClaudeComplete } from "./model-router/subscription-clients";
import { claudeModelId, routedLlm } from "./meeting-mode/llm";

// --- where things live ---------------------------------------------------------------------------
export const CAD_ROOT = process.env.CAD_TOOLS_ROOT || "D:\\cad-tools";
export const CAD_VENV_PYTHON = join(CAD_ROOT, "venv", "Scripts", "python.exe");
export const CAD_JOBS_ROOT = join(CAD_ROOT, "jobs");

export type CadRequest = { spec: string; job_id?: string; action?: "create" | "edit" | "open" };

export function parseCadRequest(body: unknown): CadRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const spec = typeof b.spec === "string" ? b.spec.slice(0, 600) : "";
  const jobId = typeof b.job_id === "string" && /^[\w.-]{1,120}$/.test(b.job_id) ? b.job_id : undefined;
  const action = b.action === "edit" || b.action === "open" ? b.action : "create";
  if (action !== "open" && !spec.trim()) throw new Error("cad needs a spec: what part to make or change.");
  return { spec, job_id: jobId, action };
}

// --- the safety filter (checked before anything is ever run) -------------------------------------
/**
 * Everything the generated script is forbidden from doing. Defence in depth alongside the job's
 * own restricted cwd and stripped env: the venv process still runs as this Windows user, so the
 * filter — not sandboxing — is what stops network calls, file access outside the job folder, and
 * spawning other processes. Checked as plain text before the script is ever written to disk.
 */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(?:import|from)\s+(?:os|sys|subprocess|socket|shutil|requests|urllib\w*|httpx|aiohttp|http\.\w+|ftplib|smtplib|telnetlib|poplib|imaplib|ctypes|pty|pickle|marshal|multiprocessing|threading|asyncio|importlib|webbrowser|platform|pathlib)\b/,
    reason: "imports a module that can touch the network, the file system, or another process",
  },
  { pattern: /__import__\s*\(/, reason: "calls __import__ directly" },
  { pattern: /\b(?:eval|exec|compile)\s*\(/, reason: "calls eval, exec or compile" },
  { pattern: /\bopen\s*\(/, reason: "calls open() itself; the trusted runner does all file export" },
  { pattern: /\binput\s*\(/, reason: "calls input()" },
  { pattern: /\.\.[\\/]/, reason: "contains a parent-directory path (..\\ or ../)" },
  { pattern: /\b(?:https?|ftp):\/\//i, reason: "contains a network URL" },
  { pattern: /(?<![A-Za-z])[a-zA-Z]:[\\/]/, reason: "contains an absolute drive path" },
  { pattern: /\\\\[\w.$-]+\\/, reason: "contains a UNC network path" },
  { pattern: /`|\$\(/, reason: "looks like a shell command substitution" },
  { pattern: /\bos\.(?:system|popen|remove|unlink|rmdir|rename)\s*\(/, reason: "calls an OS-level file or process function" },
  { pattern: /\brmtree\s*\(/, reason: "calls rmtree" },
  { pattern: /__builtins__|__globals__|__subclasses__|__bases__/, reason: "reaches for Python internals to escape its own namespace" },
];

export function isScriptSafe(code: string): { safe: boolean; reason?: string } {
  const trimmed = code.trim();
  if (!trimmed) return { safe: false, reason: "the model returned an empty script" };
  if (trimmed.length > 20_000) return { safe: false, reason: "the script is too long" };
  for (const { pattern, reason } of FORBIDDEN) if (pattern.test(trimmed)) return { safe: false, reason };
  if (!/\bresult\s*=(?!=)/.test(trimmed)) return { safe: false, reason: "does not set a variable named result" };
  return { safe: true };
}

// --- prompting the model ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You write build123d Python scripts that model one physical part as solid CAD geometry (docs: https://build123d.readthedocs.io).
Rules, no exceptions:
- The only import allowed is "from build123d import *". You may also use the standard "math" module's names (pi, sin, cos, radians, sqrt, ...) if build123d already re-exports them; never write your own "import" or "from" line for anything else.
- Never call open(), eval(), exec(), compile(), __import__() or input(), and never reference a file path, a drive letter, a UNC path, "..", or a URL. Exporting is handled outside your script.
- Finish with exactly one top-level line "result = <the finished Part/Solid/Compound>" and nothing after it. Do not export, print or plot anything yourself.
- Millimetres unless he said otherwise. Reasonable wall thickness and fillets for a 3D-printed or machined part when he didn't specify. Keep it under 150 lines.
- Reply with ONLY a single \`\`\`python fenced code block. No prose before or after it.`;

export function buildCreatePrompt(spec: string) {
  return { system: SYSTEM_PROMPT, prompt: `Model this part: ${spec.trim()}` };
}

export function buildEditPrompt(spec: string, priorScript: string) {
  return {
    system: SYSTEM_PROMPT,
    prompt: `The current model script is:\n\n\`\`\`python\n${priorScript.trim()}\n\`\`\`\n\nChange it so that: ${spec.trim()}\n\nReturn the complete, updated script (not a diff, not an explanation).`,
  };
}

/** Pulls the code out of a \`\`\`python fence; falls back to the raw reply if it looks like Python. */
export function extractPythonCode(text: string): string | null {
  const fenced = text.match(/```(?:python)?\s*\n([\s\S]*?)```/i);
  const code = (fenced ? fenced[1] : text).trim();
  if (!code) return null;
  if (!/\bresult\s*=(?!=)/.test(code)) return null;
  return code;
}

// --- the LLM call: the model router's cad.code task (same shape as meeting-mode/llm.ts) ------------
export type CadLlm = (system: string, prompt: string) => Promise<{ text: string; model: string }>;

/**
 * cad.code through the router, in its pre-E2 order: Claude Sonnet, then Hermes (Codex pool, the old
 * fallback), then free Groq gpt-oss 120b/20b. A reply without a code block moves on to the next model,
 * as before. `model` (catalogue id or Claude's own id) selects a model explicitly; ids come from the
 * catalogue.
 */
export function subscriptionCadLlm(options: { complete?: ClaudeComplete; model?: string; deps?: RoutedChatDeps; sink?: ReceiptSink; health?: HealthStore; root?: string } = {}): CadLlm {
  const selected = options.model ? claudeModelId(options.model, "") || undefined : undefined;
  return routedLlm({
    task: "cad.code",
    caller: "scripts/cad-hands (cad)",
    selected,
    usable: (text) => text.includes("```"),
    suffix: "Do not use any tools.",
    timeoutMs: 4 * 60_000,
    root: options.root,
    sink: options.sink,
    health: options.health,
    deps: { ...(options.deps ?? {}), ...(options.complete ? { claude: options.complete } : {}) },
  });
}

// --- the trusted runner (not LLM-authored): imports model_body.py, exports STEP/STL, renders a PNG --
const TRUSTED_RUNNER = `import sys, os, json, traceback

JOB_DIR = os.path.dirname(os.path.abspath(__file__))
STEP_PATH = os.path.join(JOB_DIR, "model.step")
STL_PATH = os.path.join(JOB_DIR, "model.stl")
PNG_PATH = os.path.join(JOB_DIR, "model.png")

def fail(msg):
    print(json.dumps({"ok": False, "error": msg[-2000:]}))
    sys.exit(1)

try:
    with open(os.path.join(JOB_DIR, "model_body.py"), "r", encoding="utf-8") as f:
        source = f.read()
except Exception as e:
    fail("could not read model_body.py: " + str(e))

ns = {"__name__": "cad_model_body"}
try:
    exec(compile(source, "model_body.py", "exec"), ns)
except Exception:
    fail("model_body.py raised an exception:\\n" + traceback.format_exc())

shape = ns.get("result")
if shape is None:
    fail("model_body.py did not set a variable named result")
if hasattr(shape, "part") and shape.part is not None:
    shape = shape.part
elif hasattr(shape, "sketch") and shape.sketch is not None and not hasattr(shape, "wrapped"):
    shape = shape.sketch
elif hasattr(shape, "line") and shape.line is not None and not hasattr(shape, "wrapped"):
    shape = shape.line

try:
    from build123d import export_step, export_stl
    export_step(shape, STEP_PATH)
    export_stl(shape, STL_PATH)
except Exception:
    fail("exporting STEP/STL failed:\\n" + traceback.format_exc())

try:
    import trimesh, matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    mesh = trimesh.load(STL_PATH)
    fig = plt.figure(figsize=(6, 6))
    ax = fig.add_subplot(111, projection="3d")
    collection = Poly3DCollection(mesh.vertices[mesh.faces], facecolor=(0.75, 0.78, 0.85, 1.0), edgecolor=(0.25, 0.25, 0.3, 0.4), linewidths=0.2)
    ax.add_collection3d(collection)
    bounds = mesh.bounds
    ax.set_xlim(bounds[0][0], bounds[1][0])
    ax.set_ylim(bounds[0][1], bounds[1][1])
    ax.set_zlim(bounds[0][2], bounds[1][2])
    try:
        ax.set_box_aspect(tuple(mesh.extents))
    except Exception:
        pass
    ax.set_axis_off()
    ax.view_init(elev=22, azim=35)
    fig.tight_layout(pad=0)
    fig.savefig(PNG_PATH, dpi=160, facecolor="white")
    plt.close(fig)
except Exception:
    print(json.dumps({"ok": True, "png": False, "warning": traceback.format_exc()[-800:]}))
    sys.exit(0)

print(json.dumps({"ok": True, "png": True}))
`;

// --- running the sandbox --------------------------------------------------------------------------
export type RunFn = (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRun: RunFn = (file, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    // A minimal env: no API keys or secrets, just what Python and the venv need to run.
    const env: NodeJS.ProcessEnv = { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH };
    execFile(file, args, { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: (error as { code?: number })?.code ?? (error ? 1 : 0), stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

function slugify(spec: string) {
  const slug = spec
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slug || "model";
}

function latestJobDir(jobsRoot: string): string | null {
  try {
    const dirs = readdirSync(jobsRoot)
      .map((name) => join(jobsRoot, name))
      .filter((path) => { try { return statSync(path).isDirectory(); } catch { return false; } })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return dirs[0] ?? null;
  } catch {
    return null;
  }
}

export type CadFiles = { dir: string; script: string; step: string; stl: string; png: string; meta: string };
export type CadResult = { ok: boolean; said: string; jobId?: string; files?: CadFiles; model?: string };

export type CadDeps = {
  llm?: CadLlm;
  jobsRoot?: string;
  pythonExe?: string;
  run?: RunFn;
  now?: () => number;
  timeoutMs?: number;
  exists?: (path: string) => boolean;
};

/**
 * The whole "make a bracket" round trip: prompt the model, filter the script it wrote, run it in
 * the venv sandbox with a timeout, and report what landed on disk. "edit" reads the previous job's
 * script and asks for a change instead of starting fresh; "open" just resolves the existing files.
 */
export async function cadAct(request: CadRequest, deps: CadDeps = {}): Promise<CadResult> {
  const jobsRoot = deps.jobsRoot ?? CAD_JOBS_ROOT;
  const exists = deps.exists ?? existsSync;
  mkdirSync(jobsRoot, { recursive: true });

  if (request.action === "open") {
    const dir = request.job_id ? join(jobsRoot, request.job_id) : latestJobDir(jobsRoot);
    if (!dir || !exists(dir)) return { ok: false, said: "I haven't made a model yet, sir." };
    const files: CadFiles = { dir, script: join(dir, "model_body.py"), step: join(dir, "model.step"), stl: join(dir, "model.stl"), png: join(dir, "model.png"), meta: join(dir, "meta.json") };
    if (!exists(files.step)) return { ok: false, said: "That model didn't finish building, sir; there's nothing to open." };
    return { ok: true, said: `Here's the model, sir: ${dir}.`, jobId: dir.split(/[\\/]/).pop(), files };
  }

  const now = deps.now ?? Date.now;
  const llm = deps.llm ?? subscriptionCadLlm();
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const pythonExe = deps.pythonExe ?? CAD_VENV_PYTHON;

  let priorScript = "";
  let priorDir: string | null = null;
  if (request.action === "edit") {
    priorDir = request.job_id ? join(jobsRoot, request.job_id) : latestJobDir(jobsRoot);
    if (priorDir && exists(join(priorDir, "model_body.py"))) priorScript = readFileSync(join(priorDir, "model_body.py"), "utf8");
  }

  const { system, prompt } = priorScript ? buildEditPrompt(request.spec, priorScript) : buildCreatePrompt(request.spec);
  let answer: { text: string; model: string };
  try {
    answer = await llm(system, prompt);
  } catch (error) {
    return { ok: false, said: `I couldn't reach a model to design that, sir: ${(error as Error).message}` };
  }
  const code = extractPythonCode(answer.text);
  if (!code) return { ok: false, said: "The design model didn't return a runnable script, sir.", model: answer.model };

  const safety = isScriptSafe(code);
  const jobId = `${new Date(now()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${slugify(request.spec)}`;
  const dir = join(jobsRoot, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model_body.py"), code);
  const files: CadFiles = { dir, script: join(dir, "model_body.py"), step: join(dir, "model.step"), stl: join(dir, "model.stl"), png: join(dir, "model.png"), meta: join(dir, "meta.json") };

  if (!safety.safe) {
    writeFileSync(files.meta, JSON.stringify({ spec: request.spec, model: answer.model, at: new Date(now()).toISOString(), ok: false, rejected: safety.reason }, null, 2));
    return { ok: false, said: `I won't run that script, sir: it ${safety.reason}.`, jobId, files, model: answer.model };
  }

  writeFileSync(join(dir, "runner.py"), TRUSTED_RUNNER);
  const run = deps.run ?? defaultRun;
  const result = await run(pythonExe, ["runner.py"], dir, timeoutMs);
  let parsed: { ok?: boolean; error?: string; png?: boolean; warning?: string } = {};
  try {
    parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || "{}");
  } catch {
    parsed = {};
  }
  const ok = parsed.ok === true && exists(files.step) && exists(files.stl);
  writeFileSync(
    files.meta,
    JSON.stringify({ spec: request.spec, model: answer.model, at: new Date(now()).toISOString(), ok, png: parsed.png !== false, editOf: priorDir ? priorDir.split(/[\\/]/).pop() : undefined }, null, 2),
  );
  if (!ok) {
    const detail = (parsed.error || result.stderr || result.stdout || "no output").slice(0, 500);
    return { ok: false, said: `The model didn't build, sir: ${detail}`, jobId, files, model: answer.model };
  }
  const described = request.spec.trim().slice(0, 60);
  const said =
    parsed.png === false
      ? `I've modelled that, sir: STEP and STL for "${described}" are in ${dir} (the render failed).`
      : `I've modelled that, sir: STEP, STL and a render for "${described}" are in ${dir}.`;
  return { ok: true, said, jobId, files, model: answer.model };
}

// --- adapters for installed CAD apps ---------------------------------------------------------------
// None of FreeCAD, Blender, Fusion 360 or SolidWorks were found on this PC (checked Program Files,
// %LOCALAPPDATA% and the registry uninstall keys, 25 Sep). These adapters detect an install at call
// time (so they start working the moment one is added) and otherwise say so honestly instead of
// pretending to open anything.
export const CAD_APP_INSTALL: Record<string, string> = {
  freecad: "winget install --id FreeCAD.FreeCAD -e",
  blender: "winget install --id BlenderFoundation.Blender -e",
};

function findUnderProgramFiles(dirPrefix: RegExp, relExe: string, exists = existsSync): string | null {
  const bases = [process.env["ProgramFiles"] || "C:\\Program Files", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "D:\\Program Files"];
  for (const base of bases) {
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (dirPrefix.test(name)) {
        const exe = join(base, name, relExe);
        if (exists(exe)) return exe;
      }
    }
  }
  return null;
}

export function findFreeCad(exists = existsSync): string | null {
  return findUnderProgramFiles(/^freecad/i, join("bin", "FreeCADCmd.exe"), exists);
}
export function findBlender(exists = existsSync): string | null {
  return findUnderProgramFiles(/^blender/i, "blender.exe", exists);
}
export function findFusion360Scripts(env = process.env): string | null {
  const dir = env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Autodesk", "webdeploy");
  // Fusion installs itself under a hashed webdeploy folder; if that folder doesn't exist, Fusion
  // isn't installed. The Scripts folder Jarvis would write into lives under Roaming, unrelated to
  // whether Fusion itself is present, so this only reports Fusion's own presence.
  return dir && existsSync(dir) ? dir : null;
}
export function findSolidWorks(exists = existsSync): boolean {
  return exists("C:\\Program Files\\SOLIDWORKS Corp") || exists("C:\\Program Files (x86)\\SOLIDWORKS Corp");
}

type SpawnFn = (exe: string, args: string[]) => void;
const fireDetached: SpawnFn = (exe, args) => {
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
};

/** Opens a job's STEP file in FreeCAD's GUI via a small trusted macro (not LLM-authored). */
export function openInFreeCad(files: Pick<CadFiles, "dir" | "step">, deps: { find?: typeof findFreeCad; fire?: SpawnFn } = {}): { ok: boolean; said: string } {
  const cmd = (deps.find ?? findFreeCad)();
  if (!cmd) return { ok: false, said: `FreeCAD isn't installed. Install it with: ${CAD_APP_INSTALL.freecad}` };
  const gui = cmd.replace(/FreeCADCmd\.exe$/i, "FreeCAD.exe");
  const macro = `import FreeCAD, Part, FreeCADGui\ndoc = FreeCAD.newDocument()\nPart.insert(r"${files.step}", doc.Name)\nFreeCADGui.SendMsgToActiveView("ViewFit")\n`;
  const macroPath = join(files.dir, "open-in-freecad.FCMacro");
  writeFileSync(macroPath, macro);
  (deps.fire ?? fireDetached)(gui, [macroPath]);
  return { ok: true, said: "Opening the model in FreeCAD." };
}

/** Opens a job's STL file in Blender via --python-expr (not LLM-authored). */
export function openInBlender(files: Pick<CadFiles, "dir" | "stl">, deps: { find?: typeof findBlender; fire?: SpawnFn } = {}): { ok: boolean; said: string } {
  const exe = (deps.find ?? findBlender)();
  if (!exe) return { ok: false, said: `Blender isn't installed. Install it with: ${CAD_APP_INSTALL.blender}` };
  const expr = `import bpy; bpy.ops.wm.stl_import(filepath=r"${files.stl}")`;
  (deps.fire ?? fireDetached)(exe, ["--python-expr", expr]);
  return { ok: true, said: "Opening the model in Blender." };
}

/**
 * Fusion 360 has no headless API: Jarvis can only stage a script for him to press Run on. Honest
 * by design — this never claims to have opened or run anything in Fusion.
 */
export function stageFusion360Script(files: Pick<CadFiles, "dir" | "step">, env = process.env): { ok: boolean; said: string } {
  if (!findFusion360Scripts(env)) return { ok: false, said: "Fusion 360 isn't installed on this PC." };
  const scriptsDir = env.APPDATA && join(env.APPDATA, "Autodesk", "Autodesk Fusion 360", "API", "Scripts", "JarvisImport");
  if (!scriptsDir) return { ok: false, said: "Fusion 360's Scripts folder isn't where I expected." };
  mkdirSync(scriptsDir, { recursive: true });
  const script = `import adsk.core, adsk.fusion, traceback\n\ndef run(context):\n    try:\n        app = adsk.core.Application.get()\n        app.activeDocument.design.importManager.importToTarget2(\n            app.activeDocument.design.importManager.createSTEPImportOptions(r"${files.step}"),\n            app.activeDocument.design.rootComponent)\n    except Exception:\n        adsk.core.Application.get().userInterface.messageBox(traceback.format_exc())\n`;
  writeFileSync(join(scriptsDir, "JarvisImport.py"), script);
  return { ok: true, said: `Fusion has no way to run this on its own, sir: I've put an import script in your Scripts folder under Utilities → Add-Ins → Scripts, called JarvisImport. Press Run there to bring the model in.` };
}

/**
 * SolidWorks automation is COM-only, so it needs a Python process with pywin32 (not the CAD venv,
 * which is deliberately isolated from anything that can drive another application). Detection only
 * for now: SolidWorks isn't installed on this PC.
 */
export function solidWorksAvailable(exists = existsSync): { ok: boolean; said: string } {
  if (!findSolidWorks(exists)) return { ok: false, said: "SolidWorks isn't installed on this PC." };
  return { ok: false, said: "SolidWorks was found, but the COM adapter isn't wired up yet." };
}
