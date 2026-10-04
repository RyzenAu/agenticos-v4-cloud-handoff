// Stage 3: the actual build, on Usman's Claude subscription via the official headless CLI
// (`claude -p`) — never the Anthropic API, and never `--bare` (that flag drops CLAUDE.md/plugin
// context in a way this build doesn't want, and the brief explicitly rules it out). This is a
// different invocation from scripts/claude-bridge.ts's `complete()`: the bridge deliberately runs
// text-only ("--tools", "") for Mixture-of-Agents expert calls, but this stage needs Claude Code
// to actually write index.html into the draft folder. So instead of the bridge's empty tool list,
// this scopes file access tightly:
//   - cwd is the draft folder itself, and --add-dir repeats that same path
//   - --allowedTools is just Write/Edit/Read/Glob/Grep — no Bash, no network tools, no MCP
//   - --permission-mode acceptEdits with --permission-prompts none: edits inside that folder are
//     auto-accepted (headless can't answer a prompt), and anything else is auto-DENIED rather than
//     silently escalated — this is the safe alternative to --dangerously-skip-permissions
//   - --strict-mcp-config with no --mcp-config given, so no MCP server can attach at all
// A wall-clock timeout is the turn/time cap: this CLI has no --max-turns flag (checked via
// `claude --help` before writing this), so the timeout is the actual enforcement mechanism, same
// as the bridge's own `timeoutMs`.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClaudeBin } from "../claude-bridge";
import type { Evidence } from "./evidence";
import type { Direction } from "./direction";
import type { ImageryResult } from "./imagery";
import { designRulesPrompt } from "./design-rules";

const BILLING_OVERRIDES = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

export type BuildOptions = {
  bin?: string;
  timeoutMs?: number;
  model?: string;
  run?: (args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) => Promise<string>;
};

export type BuildResult = { ok: true; ms: number; usage: unknown } | { ok: false; error: string; ms: number };

function defaultRun(bin: string) {
  return (args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude Code build exceeded the ${Math.round(timeoutMs / 1000)}s time cap.`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (out.trim()) resolve(out);
        else reject(new Error(`Claude Code exited ${code}${err ? `: ${err.slice(0, 400)}` : ""}`));
      });
      child.stdin.end(stdin);
    });
}

// v3: the page on disk is already a complete, art-directed, motion-rich scaffold (render.ts). This
// pass is the art director and copy editor, not a from-scratch builder: it makes the scaffold feel
// made for THIS business, and the orchestrator restores the scaffold if the result breaks a guard.
// The prompt is built from what the design-loop critics kept catching (24 Sep 2026): generic
// copy, templated section rhythm, and the generated-site tells frontend-design lists.
export const SYSTEM_PROMPT = `You are the art director and senior front-end craftsperson at M&U Ventures, a two-person
Australian studio that sells websites to local dentists, law firms and real-estate agencies. The
page in the current directory is a draft for ONE prospect, reviewed internally before a cold call.
The owner's bar, verbatim: "premium, no AI slop, reference websites, just interactive, Higgsfield,
just crazy good". Australian English.

The current directory already holds a complete, working page:
- index.html: markup + CSS for the chosen art direction (see direction.md below)
- assets/site.js: a small scroll engine (no libraries): the pinned hero push-in and dissolve,
  the scroll-scrubbed Higgsfield film on wide screens, the statement fill, drifts and reveals
- assets/img/, assets/fonts/, assets/film.mp4: four Higgsfield stills (each used ONCE), the
  self-hosted fonts and the film made from the first still
Your job is to take it from "strong template" to "made for this business". Edit index.html in
place. Do not edit assets/site.js (the orchestrator restores it) and do not create other files
or touch assets/img/, assets/fonts/ or assets/film.mp4.
Leave the hero stage alone: its layout, .stage, .stage-media, .layer rules, clip-paths and the
pinned height were tuned against the reference sites, and QA fails the page if the hero image is
not clearly visible in the first screen at 1440 px and 375 px.

Work in RISE order (References, Idea, Style, Examine), the brief shape every motion build uses:
- References: evidence.json (the facts, plus "brand": their real colours, fonts and logo read from
  their live site), direction.md (including "Their brand" when present) and the reference-site
  mechanisms listed below. A brand-locked accent in direction.md is the business's own colour: keep it.
- Idea: before editing, state the signature moment as beginning / middle / end of the scroll.
- Style: the direction's palette and type; easing cubic-bezier(0.16, 1, 0.3, 1); 500-800 ms for the
  one focal entrance, 150-300 ms for feedback; transform / opacity / clip-path only.
- Examine: QA renders the page at 0%, 25%, 50%, 75% and 100% of its scroll (qa/frames/) and fails any
  blank frame. Walk those five states before you finish: nothing may sit hidden waiting on a
  reveal that can't fire, and no pinned scene may rest on an empty frame. At each state also check
  Jack Roberts' tells that apply to a page: no clipped descenders (line-height 1.1 or more on
  display type), no single word alone on a headline line, no flat single-colour fills on large
  areas (light should fall off), no linear easing, one idea per section on a quiet ground, real
  logo files only (never redrawn), and a little grain or texture so it doesn't look machine-flat.

What to improve (spend your boldness in ONE place, the direction's signature moment):
1. Copy. Rewrite headline, lede, statement and CTAs so they could only belong to this business and
   place, using evidence.json facts (name, street, suburb, phone, listed services). Plain verbs,
   sentence case, specific, no filler, no exclamation marks, no "Learn more", no buzzwords
   ("seamless", "innovative", "state-of-the-art", "tailored", "journey"). Headline max 8 words.
2. Composition. Tune type scale, spacing rhythm and alignment so the page reads as designed, not
   assembled: one oversized display voice, three type sizes per screen, generous but deliberate
   whitespace, the accent colour at most twice per screen. Adjust CSS values freely.
3. The signature moment named in direction.md: make it land (timing, scale, easing), within the
   existing motion runtime. Motion must stay transform / opacity / clip-path only.

What the design-loop critics already rejected (24 Sep 2026 rounds against Tend, Allens and
BresicWhitney); do not reintroduce any of it:
- a headline that is just the street address (the address belongs in the lede and the finale)
- images that float over text or follow the cursor; images sit locked in the grid
- a repeating name/suburb marquee; filler sections; two blocks repeating the same call button
- an empty half of a section; if a column has nothing true to say, give the other column the width
- flooding a section with the accent colour: accent is for actions only; the finale is dark
- a first viewport without imagery on desktop or on the 375px mobile screen
- soft or upscaled imagery as the lead image; keep the sharp still where the scaffold put it

Locked copy: elements carrying data-lock (the h1, the lede, the statement and the finale
title) were written at the art-direction stage. Do not rewrite them; the orchestrator puts the
original text back whatever you do. Spend your effort on everything around them.
Every image appears exactly once on the page; never reuse an image or add a second copy.

Keep, exactly (the orchestrator checks these and discards your edit if any is missing):
- the top banner text "INTERNAL DRAFT — not for distribution" and its Sources button + <dialog id="sources">
- every data-* attribute the runtime uses (data-scene, data-layer, data-film, data-media,
  data-hero, data-fill, data-drift, data-reveal, data-rows, data-finale, data-magnetic,
  data-header, data-callbar, data-lock, data-note-text, data-copy-note, data-topic, data-bring,
  data-month, data-timeline, data-hero-control, data-hero-select, data-footer-mark), the
  #tool-data JSON, the inline motion-on script in <head>, and <script src="assets/site.js" defer>
- the <h1>, the hero <img fetchpriority="high">, the lazy film <video>, every tel: link
- the prefers-reduced-motion CSS block; the "Illustrative ... AI-generated for this concept" caption
- the sections: services (#services), the interactive tool (#prepare), visit (#visit), call (#call)

Hard rules (a QA audit fails the draft on any of these):
- Every fact must come from evidence.json. Never invent a service, staff member, review, rating,
  award, price, guarantee, opening hours, year founded, years of experience, before/after result
  or outcome. Placeholder rows must stay visibly labelled "Placeholder".
- Dental: AHPRA rules, so no testimonials, no outcome or painless claims, no "best". Legal: no
  outcome guarantees, no "leading/best/top". Real estate: no sold prices, no "record" claims.
- This is a REDESIGN concept of the business's current website. Never write copy that says or
  implies the business has no website, no online presence or a first website.
- No images of people. Don't add new <img> tags except for files already in assets/.
- No external hosts: fonts and scripts are self-hosted.
- Refuse the generated-site tells: no eyebrow/kicker labels above headings, no all-caps labels,
  no "01 / 02 / 03" numbering unless it's a real sequence, no gradient text, no identical
  icon+heading+text card grids, no emoji, no "→" appended to links, no middle-dot joined meta.
- QA also checks these mechanically (scripts/site-draft/design-rules.ts, from the installed
  impeccable, mu-art-direction and mu-killer-site skills); a fail sends the page back to you:
${designRulesPrompt()}
- Accessible: WCAG AA contrast, visible focus, tap targets >= 44px, works at 375px wide.
Reply with a one-paragraph summary of what you changed; the file on disk is the deliverable.`;

function buildUserPrompt(evidence: Evidence, directionMd: string, imagery: ImageryResult, fixNotes?: string): string {
  const parts = [
    `## evidence.json\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``,
    `## direction.md\n\n${directionMd}`,
    `## Generated media (relative to cwd)\n\n${imagery.assets.length ? imagery.assets.map((a) => `- ${a.path}: ${a.description} (${a.engine})`).join("\n") : "None: the page uses generated pattern art."}`,
  ];
  if (fixNotes) {
    parts.push(`## QA found problems in the previous pass. Fix ALL of these in index.html, and change nothing else\n\n${fixNotes}`);
  } else {
    parts.push("Read index.html and assets/site.js first, then refine index.html in place.");
  }
  return parts.join("\n\n");
}

export async function buildDraft(
  draftDir: string,
  evidence: Evidence,
  directionMd: string,
  imagery: ImageryResult,
  opts: BuildOptions & { fixNotes?: string } = {},
): Promise<BuildResult> {
  const bin = opts.bin ?? defaultClaudeBin();
  const run = opts.run ?? defaultRun(bin);
  const timeoutMs = opts.timeoutMs ?? 9 * 60_000; // motion + an interactive widget takes longer than a plain static page
  const model = opts.model ?? "sonnet";

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!BILLING_OVERRIDES.test(key)) env[key] = value;
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  });

  const tmpRoot = join(tmpdir(), "agentic-os-site-draft-build");
  mkdirSync(tmpRoot, { recursive: true });
  const systemFile = join(tmpRoot, `system-${randomUUID()}.txt`);
  const args = [
    "-p",
    "--model", model,
    "--allowedTools", "Write Edit Read Glob Grep",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--add-dir", draftDir,
    "--strict-mcp-config",
    "--setting-sources", "project,local",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt-file", systemFile,
  ];
  const prompt = buildUserPrompt(evidence, directionMd, imagery, opts.fixNotes);
  const started = Date.now();
  try {
    writeFileSync(systemFile, SYSTEM_PROMPT, "utf8");
    const raw = await run(args, prompt, env, draftDir, timeoutMs);
    const ms = Date.now() - started;
    let result: any;
    try {
      result = JSON.parse(raw.slice(raw.indexOf("{")));
    } catch {
      return { ok: false, error: "Claude Code returned something that was not JSON.", ms };
    }
    if (result?.is_error) return { ok: false, error: String(result?.result || "Claude Code reported an error.").slice(0, 500), ms };
    return { ok: true, ms, usage: result.usage ?? null };
  } catch (error) {
    return { ok: false, error: (error as Error).message, ms: Date.now() - started };
  } finally {
    rmSync(systemFile, { force: true });
  }
}
