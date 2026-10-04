// Image-relevance QA (owner, 24 Sep 2026: "the dental doesn't even have ANY dental photos"). A
// vision model looks at the hero and section images and confirms each one visibly belongs to the
// business's vertical within a glance. Runs on the owner's Claude subscription through the
// official `claude -p` CLI (never --bare), read-only: the only tool it may use is Read, inside the
// draft folder. Any image that doesn't read as its vertical fails the draft.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultClaudeBin } from "../claude-bridge";
import type { Lead } from "../leads/crm";
import type { ImageryMedia, ImageSet } from "./imagery";
import type { QaIssue } from "./qa";

export const VERTICAL_SUBJECT: Record<Lead["vertical"], string> = {
  dental: "a dental clinic or dental care (for example a treatment room with a dental chair, dental instruments, a clinic reception, a toothbrush, floss)",
  legal: "a law firm or legal work (for example a lawyer's office, a meeting room, documents or contracts, a pen, keys handed over at a settlement)",
  "real-estate": "real estate (for example houses, a residential street, a home interior, a front door, a garden)",
};

export type RelevanceVerdict = { file: string; matches: boolean; depicts: string };
export type RelevanceRun = (args: string[], stdin: string, cwd: string, timeoutMs: number) => Promise<string>;

const BILLING_OVERRIDES = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

function defaultRun(bin: string): RelevanceRun {
  return (args, stdin, cwd, timeoutMs) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!BILLING_OVERRIDES.test(k)) env[k] = v;
      Object.assign(env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("image relevance check timed out")); }, timeoutMs);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); out.trim() ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)); });
      child.stdin.end(stdin);
    });
}

/** The images a visitor sees first: hero wide, hero close and the section image. */
export function relevanceTargets(media: ImageryMedia | undefined): { role: string; file: string }[] {
  const pick = (set?: ImageSet) => set?.sizes.find((s) => s.w >= 900 && s.w <= 1300)?.path ?? set?.sizes[0]?.path;
  return (
    [
      ["hero wide", pick(media?.heroWide)],
      ["hero close", pick(media?.heroClose)],
      ["section", pick(media?.section)],
    ] as const
  )
    .filter(([, f]) => Boolean(f))
    .map(([role, file]) => ({ role, file: file! }));
}

export function parseVerdicts(raw: string): RelevanceVerdict[] {
  let text = raw;
  try {
    const envelope = JSON.parse(raw.slice(raw.indexOf("{")));
    if (typeof envelope?.result === "string") text = envelope.result;
  } catch {
    /* plain text reply */
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("the relevance check returned no verdict list");
  const list = JSON.parse(text.slice(start, end + 1)) as RelevanceVerdict[];
  return list.filter((v) => v && typeof v.file === "string" && typeof v.matches === "boolean");
}

export async function checkImageRelevance(
  draftDir: string,
  vertical: Lead["vertical"],
  media: ImageryMedia | undefined,
  opts: { run?: RelevanceRun; bin?: string; timeoutMs?: number; model?: string } = {},
): Promise<{ issues: QaIssue[]; verdicts: RelevanceVerdict[] }> {
  const targets = relevanceTargets(media).filter((t) => existsSync(join(draftDir, t.file)));
  if (!targets.length) return { issues: [], verdicts: [] };
  // Cached per exact file set, so a re-draft with the same imagery doesn't ask again.
  const key = targets.map((t) => `${t.file}:${statSync(join(draftDir, t.file)).size}`).join("|");
  const cachePath = join(draftDir, "assets", "relevance.json");
  let verdicts: RelevanceVerdict[] | null = null;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached.key === key && cached.vertical === vertical) verdicts = cached.verdicts;
    } catch {
      /* stale cache */
    }
  }
  if (!verdicts) {
    const run = opts.run ?? defaultRun(opts.bin ?? defaultClaudeBin());
    const args = ["-p", "--model", opts.model ?? "sonnet", "--allowedTools", "Read", "--permission-prompts", "none", "--add-dir", draftDir, "--strict-mcp-config", "--setting-sources", "project,local", "--no-session-persistence", "--output-format", "json"];
    const prompt = `You are checking stock-free website imagery for a local Australian business in this vertical: ${VERTICAL_SUBJECT[vertical]}.
Use the Read tool to look at each of these image files (paths relative to the current directory):
${targets.map((t) => `- ${t.file} (${t.role})`).join("\n")}
For each image, decide one thing: would a stranger glancing at it for one second recognise it as being about ${vertical === "real-estate" ? "real estate" : vertical === "legal" ? "a law firm" : "a dental clinic"}? Abstract architecture, generic interiors or textures with no clear sign of the vertical do NOT match.
Reply with JSON only, no prose: [{"file": "<path>", "matches": true or false, "depicts": "<at most eight words>"}]`;
    try {
      verdicts = parseVerdicts(await run(args, prompt, draftDir, opts.timeoutMs ?? 4 * 60_000));
      writeFileSync(cachePath, JSON.stringify({ key, vertical, verdicts, checkedAt: new Date().toISOString() }, null, 2), "utf8");
    } catch (e) {
      return { issues: [{ severity: "warn", area: "imagery", detail: `Image relevance check could not run: ${(e as Error).message.slice(0, 160)}` }], verdicts: [] };
    }
  }
  const issues: QaIssue[] = [];
  for (const t of targets) {
    const v = verdicts.find((x) => x.file === t.file || x.file.endsWith(t.file) || t.file.endsWith(x.file));
    if (!v) issues.push({ severity: "warn", area: "imagery", detail: `No relevance verdict for ${t.role} (${t.file}).` });
    else if (!v.matches) issues.push({ severity: "fail", area: "imagery", detail: `The ${t.role} image does not read as ${vertical} (it shows: ${v.depicts}). Regenerate it with a clearly ${vertical} subject.` });
  }
  return { issues, verdicts };
}
