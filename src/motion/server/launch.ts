/**
 * Run in Claude Code / Codex: make ~/motion-studio-projects/<slug>/ with
 * PROMPT.md (and any dropped assets), then open a new Terminal window running
 * `claude` or `codex` there (Windows: D:\motion-studio-projects and a new
 * Windows Terminal / PowerShell window). The exact command is shown to the person first;
 * this only runs on click. MOTION_STUDIO_DRY_RUN=1 writes the folder but never
 * opens a window.
 */
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  MOTION_MODEL_SETTINGS,
  MOTION_SETTINGS_FILE,
  motionCliCommand,
  motionTargetPrompt,
  type MotionTool,
} from "../engine/launch";
import type { PromptAsset } from "../engine/prompt";
import { safeAssetPath, slugify, studioHome, tildify, uniqueChild } from "./util";

export type Tool = MotionTool;

export interface LaunchPlan {
  folder: string;
  display: string;
  command: string;
  terminal: boolean;
  tool: Tool;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell single-quoted literal: nothing inside is expanded; ' doubles. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function planLaunch(
  name: string,
  tool: Tool = "claude",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LaunchPlan {
  const home = studioHome(env, platform);
  const folder = uniqueChild(home, slugify(name));
  const display = tildify(folder);
  const windows = platform === "win32";
  return {
    folder,
    display,
    command: windows
      ? `Set-Location -LiteralPath ${psQuote(folder)}; ${motionCliCommand(tool, true)}`
      : `cd ${shellQuote(folder)} && ${motionCliCommand(tool, false)}`,
    terminal: platform === "darwin" || windows,
    tool,
  };
}

/** Windows Terminal if it is installed (the Store alias), else a plain PowerShell console. */
export function windowsTerminalLaunch(
  folder: string,
  tool: Tool,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): { file: string; args: string[] } {
  // Fixed text only: the brief stays in PROMPT.md, so nothing here nears the
  // 32,767-character command-line cap and no user text reaches a shell.
  const command = motionCliCommand(tool, true);
  const shell = ["powershell.exe", "-NoLogo", "-NoExit", "-Command", command];
  const wt = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe") : "";
  if (wt && exists(wt)) return { file: wt, args: ["-w", "new", "-d", folder, ...shell] };
  return { file: shell[0], args: shell.slice(1) };
}

/** Assets live in the project folder, so the prompt points at ./assets/<file>. */
function localiseAssets(
  prompt: string,
  folder: string,
  assets: PromptAsset[],
  env?: NodeJS.ProcessEnv,
): string {
  let out = prompt;
  const safe = assets.flatMap((asset) => {
    const source = safeAssetPath(asset.path, env);
    return source ? [{ asset, source }] : [];
  });
  if (!safe.length) return out;
  mkdirSync(join(folder, "assets"), { recursive: true });
  for (const { asset: a, source } of safe) {
    const file = basename(source);
    copyFileSync(source, join(folder, "assets", file));
    out = out
      .split(a.path)
      .join(`./assets/${file}`)
      .split(tildify(a.path))
      .join(`./assets/${file}`);
    for (const f of a.frames ?? []) {
      const frame = safeAssetPath(f, env);
      if (frame) {
        const name = `${file.replace(/\.[a-z0-9]+$/i, "")}-${basename(frame)}`;
        copyFileSync(frame, join(folder, "assets", name));
        out = out.split(f).join(`./assets/${name}`);
      }
    }
  }
  return out;
}

export async function launch(
  name: string,
  prompt: string,
  assets: PromptAsset[],
  options: {
    dryRun: boolean;
    env?: NodeJS.ProcessEnv;
    tool?: Tool;
    platform?: NodeJS.Platform;
    /** Injectable for tests; opens the new window on Windows. */
    open?: (file: string, args: string[], cwd: string) => Promise<void>;
  },
): Promise<LaunchPlan & { launched: boolean; dryRun: boolean }> {
  const tool = options.tool ?? "claude";
  const platform = options.platform ?? process.platform;
  const plan = planLaunch(name, tool, options.env, platform);
  mkdirSync(plan.folder, { recursive: true });
  const body = localiseAssets(prompt.trim(), plan.folder, assets, options.env);
  writeFileSync(join(plan.folder, "GRAPHICS.md"), motionTargetPrompt(body, "claude-code", platform === "win32") + "\n");
  writeFileSync(
    join(plan.folder, "PROMPT.md"),
    motionTargetPrompt(body, tool === "codex" ? "codex" : "claude-code", platform === "win32") + "\n",
  );
  if (platform === "win32")
    writeFileSync(join(plan.folder, MOTION_SETTINGS_FILE), MOTION_MODEL_SETTINGS + "\n");
  if (options.dryRun || !plan.terminal) return { ...plan, launched: false, dryRun: options.dryRun };
  if (platform === "win32") {
    const { file, args } = windowsTerminalLaunch(plan.folder, tool, options.env ?? process.env);
    await (options.open ?? openWindow)(file, args, plan.folder);
    return { ...plan, launched: true, dryRun: false };
  }
  const script = plan.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await new Promise<void>((resolve, reject) =>
    execFile(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${script}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { timeout: 15000 },
      (error) =>
        error
          ? reject(new Error("Couldn't open Terminal. Copy the command and run it yourself."))
          : resolve(),
    ),
  );
  return { ...plan, launched: true, dryRun: false };
}

/** A detached console program gets its own visible window on Windows, which is the point here. */
function openWindow(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: "ignore" });
    child.once("error", () =>
      reject(new Error("Couldn't open a terminal. Copy the command and run it in PowerShell.")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
