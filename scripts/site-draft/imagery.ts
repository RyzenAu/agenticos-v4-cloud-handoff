// Stage 3: imagery and motion, image-first (owner, 24 Sep 2026: "I want to use Higgsfield for
// crazy-looking websites", after rejecting soft text-to-video clips).
//
//   1. Four sharp STILLS per draft, each used exactly once on the page: hero wide (the film's
//      first frame), hero close (the match-dissolve target), a section image and a detail/texture.
//      Default (owner, 24 Sep 2026: "only use Higgsfield to make videos or motion"): GPT Image 2
//      on the ChatGPT subscription through Hermes' own Codex image plugin, PINNED to one pool
//      entry (openai-2, Usman's Plus; gpt_image_codex.py refuses rather than rotate to another
//      account). The backend returns 1536x1024 / 1024x1536 whatever size is asked, so heroes are
//      lanczos-upscaled (max 2x, mild unsharp) for their 2400 px rendition.
//      Fallback only when GPT Image errors (never when the pinned account is refused): xAI Grok
//      Imagine Image 2.0 at 2K through the Higgsfield route.
//   2. ONE film generated FROM the hero-wide still (image-to-video, so frame one is the crisp,
//      art-directed still): xAI Grok Imagine Video 1.5 at 1080p, 6 s, one slow camera move.
//      It is only ever scroll-scrubbed on wide screens; phones and reduced motion get the still
//      push-in (the Bianca Brown technique), so the film can never be the soft thing people see.
//   3. Zero-cost SVG art when the dev server or budget isn't available.
// Everything goes through the ALREADY-RUNNING Agentic OS dev server's `/__design_generate`
// (its stored credentials; this file never reads a key, never starts or stops the server).
// ffmpeg turns stills into WebP sizes (and a phone crop), and the film into an all-intra H.264
// file so scroll-scrubbing seeks instantly. Cached in assets/imagery.json (version 2): a
// re-draft reuses everything at zero cost.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { runCapture } from "../nonblocking-exec";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Direction, ShotId } from "./direction";
import type { Vertical } from "../leads/places";

export type AssetRole = ShotId | "film" | "fallback";

export type ImageAsset = {
  path: string;
  engine: string;
  description: string;
  costCredits: number;
  costUsd?: number;
  role?: AssetRole;
};

export type ImageSet = {
  /** Asset identity for the reuse audit: every file of one set shares it. */
  key: ShotId;
  /** WebP renditions, smallest first. */
  sizes: { w: number; path: string }[];
  /** Portrait phone crop of hero images. */
  mobile?: string;
  width: number;
  height: number;
};

export type Film = { mp4: string; width: number; height: number; duration: number; approved: boolean; note: string };

export type ImageryMedia = {
  heroWide?: ImageSet;
  heroClose?: ImageSet;
  section?: ImageSet;
  detail?: ImageSet;
  film?: Film;
};

export type ImageryResult = {
  engine: "higgsfield" | "gpt-image" | "css-svg-fallback";
  available: boolean;
  reason: string;
  assets: ImageAsset[];
  totalCredits: number;
  totalUsd?: number;
  generations?: number;
  reused?: boolean;
  media?: ImageryMedia;
};

const DESIGN_SERVER = "http://127.0.0.1:8081";
export const STILL_MODEL = "xai/grok-imagine-image-2.0";
export const GPT_STILL_MODEL = "gpt-image-2";
/** Hermes openai-codex pool entry the stills run on (Usman's ChatGPT Plus). Never rotated. */
export const GPT_POOL_LABEL = "openai-2";
export const FILM_MODEL = "xai/grok-imagine-video/v1.5/reference-to-video";
// Higgsfield's public pricing, 24 Sep 2026: Grok Imagine Image 2.0 from US$0.04 an image; Grok
// Imagine Video 1.5 is US$0.08/s at 480p, US$0.14/s at 720p and US$0.25/s at 1080p. The route's
// catalogue only exposes the "from" price, so the 1080p film rate is fixed here.
const FALLBACK_PRICE = { still: 0.04, filmPerSecond: 0.25 };
const FILM_SECONDS = 6;
const STOP_AND_ASK_USD = 3;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

// The dev server is one busy Node process; it can stall for tens of seconds under load, so the
// cheap calls are patient and retried rather than failing a draft on one slow response.
async function fetchDesignToken(baseUrl: string, tries = 3): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await withTimeout(fetch(`${baseUrl}/__token`, { signal: AbortSignal.timeout(20_000) }), 21_000);
      if (res.ok) {
        const data = (await res.json()) as { token?: string };
        if (data.token) return data.token;
      }
    } catch {
      /* slow or restarting; try again */
    }
    if (i < tries - 1) await pause(2000);
  }
  return null;
}

export async function checkHiggsfieldDevServer(baseUrl = DESIGN_SERVER): Promise<{ available: boolean; reason: string }> {
  try {
    const res = await withTimeout(fetch(`${baseUrl}/__design_higgsfield_account/status`, { signal: AbortSignal.timeout(20_000) }), 21_000);
    if (!res.ok) return { available: false, reason: `Agentic OS dev server responded ${res.status} to a Higgsfield status check.` };
    const data = (await res.json()) as { ok?: boolean; connected?: boolean };
    if (!data.ok) return { available: false, reason: "Higgsfield status check failed on the Agentic OS dev server." };
    return { available: true, reason: data.connected ? "" : "Higgsfield account (OAuth) not connected; API-key models may still be available." };
  } catch {
    return { available: false, reason: "Agentic OS dev server (localhost:8081) isn't reachable. Higgsfield's credentials live there, not in this process, and this pipeline never starts that server itself." };
  }
}

/** Honest secondary signal only; never reads a .env file (inspects just the object it's given). */
export function checkHiggsfieldApiKey(env: Record<string, string | undefined> = process.env): { available: boolean; reason: string } {
  const present = Boolean(env.HF_CREDENTIALS || env.HF_KEY || env.HIGGSFIELD_API_KEY);
  return present
    ? { available: true, reason: "A raw Higgsfield API key is present in this process's environment." }
    : { available: false, reason: "No raw Higgsfield API key in this process's environment (checked, never read from a .env file)." };
}

export function hermesPython(env: Record<string, string | undefined> = process.env): string | null {
  const root = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "hermes", "hermes-agent") : "";
  const py = root && join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return py && existsSync(py) ? py : null;
}

const GPT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "gpt_image_codex.py");

export function checkGptImage(env: Record<string, string | undefined> = process.env): { available: boolean; reason: string } {
  const py = hermesPython(env);
  if (!py) return { available: false, reason: "Hermes' Python environment isn't installed, so GPT Image (ChatGPT subscription) can't run." };
  if (!existsSync(GPT_SCRIPT)) return { available: false, reason: "gpt_image_codex.py is missing." };
  return { available: true, reason: `GPT Image via Hermes' Codex image plugin, pinned to pool entry ${GPT_POOL_LABEL}.` };
}

/** GPT Image returns one of three shapes whatever is asked; pick the one matching the shot. */
export function gptImageSize(aspect: string): string {
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h || Math.abs(w / h - 1) < 0.15) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

/** Writes one still to `out` and returns its path, or throws. */
export type StillCall = (args: { prompt: string; aspect: string; out: string }) => Promise<string>;

/** The pinned ChatGPT account was refused (missing, wrong plan, limit hit): stop, don't fall back. */
export class PinnedAccountError extends Error {}

export function gptImageStill(opts: { python?: string | null; poolLabel?: string; timeoutMs?: number } = {}): StillCall | null {
  const py = opts.python === undefined ? hermesPython() : opts.python;
  if (!py || !existsSync(GPT_SCRIPT)) return null;
  return async ({ prompt, aspect, out }) => {
    const promptFile = `${out}.prompt.txt`;
    writeFileSync(promptFile, prompt, "utf8");
    const args = [GPT_SCRIPT, "--prompt-file", promptFile, "--size", gptImageSize(aspect), "--quality", "high", "--out", out, "--pool-label", opts.poolLabel ?? GPT_POOL_LABEL];
    // Async (T8b, review T8 S-6): a spawnSync here held the whole server for up to 5 minutes per still.
    const run = await runCapture(py, args, { timeout: opts.timeoutMs ?? 5 * 60_000 });
    const line = (run.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
    let res: { ok?: boolean; error?: string } = {};
    try {
      res = JSON.parse(line);
    } catch {
      /* no JSON: a crash or timeout */
    }
    if (res.ok && existsSync(out)) return out;
    const why = res.error ?? `gpt_image_codex exited ${run.status ?? "on timeout"}`;
    if (run.status === 4) throw new PinnedAccountError(why);
    throw new Error(why);
  };
}

type ModelPrice = { unit: string; costUsd: number };

async function livePrices(baseUrl: string, token: string): Promise<Record<string, ModelPrice>> {
  try {
    const res = await fetch(`${baseUrl}/__design_models?engine=higgsfield`, { headers: { "X-Claude-OS-Token": token }, signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as { models?: { id: string; pricing?: { unit: string; costUsd: number }[] }[] };
    const out: Record<string, ModelPrice> = {};
    for (const m of data.models ?? []) if (m.pricing?.[0]) out[m.id] = { unit: m.pricing[0].unit, costUsd: m.pricing[0].costUsd };
    return out;
  } catch {
    return {};
  }
}

/** Errors worth one more attempt: nothing was (knowingly) accepted and billed. A request the
 *  provider accepted but hasn't finished ("still processing request …") is never retried, since a
 *  resubmission would pay twice. */
export function isRetryableGenerationError(message: string): boolean {
  // A dropped connection is NOT retryable: the dev server's Node HTTP server closes any request
  // after 300 s, while a video job keeps running (and billing) on the provider. The generator
  // below recovers that job's output instead of paying for a second one.
  if (/still processing|Request [0-9a-f]{8}-|accepted the request|socket|closed unexpectedly|ECONNRESET|fetch failed/i.test(message)) return false;
  return /could not be confirmed|HTTP 5\d\d|\b50[234]\b|HTTP 403|rate limit|temporar|try again/i.test(message);
}

export type GenerateCall = (args: { kind: "image" | "video"; model: string; prompt: string; params: Record<string, unknown>; references?: string[] }) => Promise<string>;

/** The dev server names saved generations `<epoch ms>-<first 40 chars of the prompt, slugged>-<hash>.<ext>`. */
export function generationSlug(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}

export function defaultGenerationsDir(): string {
  return join(process.env.USERPROFILE || process.env.HOME || ".", ".claude-os", "design", "generations");
}

/** A generation the dev server saved after `since` for this prompt, if any. */
export function findSavedGeneration(dir: string, prompt: string, since: number, kind: "image" | "video"): string | null {
  if (!existsSync(dir)) return null;
  const slug = generationSlug(prompt).slice(0, 30);
  const exts = kind === "video" ? /\.(mp4|webm)$/i : /\.(png|jpe?g|webp)$/i;
  const hits = readdirSync(dir)
    .filter((f) => exts.test(f) && f.includes(slug))
    .map((f) => ({ f, t: Number(f.split("-")[0]) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= since - 5_000)
    .sort((a, b) => b.t - a.t);
  return hits.length ? join(dir, hits[0].f) : null;
}

function devServerGenerator(baseUrl: string, opts: { generationsDir?: string; pollMs?: number } = {}): GenerateCall {
  const generationsDir = opts.generationsDir ?? defaultGenerationsDir();
  const pollMs = opts.pollMs ?? 10_000;
  return async ({ kind, model, prompt, params, references }) => {
    // The dev server's session token rotates, so fetch it fresh for every paid call.
    const token = await fetchDesignToken(baseUrl);
    if (!token) throw new Error("HTTP 403: could not fetch the dev-server session token");
    const since = Date.now();
    const jobId = `site-draft-${since}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const res = await fetch(`${baseUrl}/__design_generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
        body: JSON.stringify({ engine: "higgsfield", model, kind, count: 1, params, prompt, jobId, engineLabel: "Higgsfield", modelLabel: model, ...(references?.length ? { references } : {}) }),
        signal: AbortSignal.timeout(kind === "video" ? 17 * 60_000 : 6 * 60_000),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; items?: { path: string }[]; error?: string; failures?: string[] };
      if (!res.ok || !data.ok || !data.items?.length) throw new Error(`HTTP ${res.status}: ${data.error ?? data.failures?.[0] ?? "generation failed"}`);
      return data.items[0].path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^HTTP \d/.test(message)) throw error;
      // Connection dropped mid-job: wait for the server-side job to finish and pick up its file.
      const deadline = since + (kind === "video" ? 16 : 6) * 60_000;
      while (Date.now() < deadline) {
        const saved = findSavedGeneration(generationsDir, prompt, since, kind);
        if (saved) return saved;
        let active = true;
        try {
          const jobs = (await (await fetch(`${baseUrl}/__design_jobs`, { signal: AbortSignal.timeout(5000) })).json()) as { jobs?: { id: string }[] };
          active = Boolean(jobs.jobs?.some((j) => j.id === jobId));
        } catch {
          /* server busy; keep waiting until the deadline */
        }
        if (!active) {
          const late = findSavedGeneration(generationsDir, prompt, since, kind);
          if (late) return late;
          // The dev server restarted (Vite restarts when a file its config imports changes) and
          // dropped the job. If the provider had already accepted it, it is probably billed:
          // name the request so the owner can fetch the output from the Higgsfield console.
          let orphan = "";
          try {
            const ledger = (await (await fetch(`${baseUrl}/__design_higgsfield_requests`, { signal: AbortSignal.timeout(8000) })).json()) as { requests?: { requestId: string; model: string; status: string; updatedAt: number }[] };
            const hit = ledger.requests?.find((r) => r.model === model && r.updatedAt >= since && r.status === "accepted");
            if (hit) orphan = ` Higgsfield accepted request ${hit.requestId} (likely billed); its output can be downloaded from the Higgsfield console.`;
          } catch {
            /* ledger unavailable */
          }
          throw new Error(`Connection dropped and the job ended without a saved file (${message}).${orphan}`);
        }
        await pause(pollMs);
      }
      throw new Error(`Connection dropped and the job did not finish in time (${message})`);
    }
  };
}


/** One generation with bounded retry + backoff. `budget.left` is decremented per ATTEMPT. */
export async function generateWithRetry(
  generate: GenerateCall,
  args: Parameters<GenerateCall>[0],
  budget: { left: number },
  opts: { backoffMs?: number[]; log?: (line: string) => void } = {},
): Promise<{ path: string | null; attempts: number; error: string }> {
  const backoff = opts.backoffMs ?? [5_000, 15_000];
  let attempts = 0;
  let error = "";
  while (budget.left > 0) {
    budget.left -= 1;
    attempts += 1;
    try {
      return { path: await generate(args), attempts, error: "" };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      opts.log?.(`${args.kind} attempt ${attempts} failed: ${error.slice(0, 200)}`);
      if (!isRetryableGenerationError(error) || attempts > backoff.length || budget.left <= 0) break;
      await pause(backoff[attempts - 1]);
    }
  }
  return { path: null, attempts, error };
}

// ---------------------------------------------------------------------------------------------
// ffmpeg post-processing

export async function findFfmpeg(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const candidates: string[] = [];
  if (env.FFMPEG_BIN) candidates.push(env.FFMPEG_BIN);
  const home = env.USERPROFILE || env.HOME || "";
  const muTools = join(home, ".local", "share", "mu-tools", "ffmpeg");
  if (existsSync(muTools)) {
    for (const entry of readdirSync(muTools)) candidates.push(join(muTools, entry, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = await runCapture(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { timeout: 5000 });
  const first = probe.status === 0 ? probe.stdout.split(/\r?\n/)[0]?.trim() : "";
  return first || null;
}

// ffmpeg runs as async children (T8b, review T8 S-6): these ran synchronously inside a site-draft request,
// holding every other request for each encode (up to 5 minutes apiece).
async function ff(bin: string, args: string[]): Promise<boolean> {
  const r = await runCapture(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 5 * 60_000 });
  return r.status === 0;
}

async function probeDuration(bin: string, input: string): Promise<number> {
  const r = await runCapture(bin, ["-hide_banner", "-i", input], { timeout: 60_000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 5;
}

// ---------------------------------------------------------------------------------------------
// Post-processing

const SHOT_SIZES: Record<ShotId, number[]> = { "hero-wide": [960, 1600, 2400], "hero-close": [960, 1600, 2400], section: [720, 1200], detail: [720, 1200] };
const MEDIA_KEY: Record<ShotId, keyof Omit<ImageryMedia, "film">> = { "hero-wide": "heroWide", "hero-close": "heroClose", section: "section", detail: "detail" };

async function dims(bin: string, input: string): Promise<{ width: number; height: number }> {
  const m = (await runCapture(bin, ["-hide_banner", "-i", input], { timeout: 60_000 })).stderr?.match(/, (\d{3,5})x(\d{3,5})/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
}

const SHARPEN = "unsharp=5:5:0.45:5:5:0";

/** WebP renditions plus, for hero shots, a 9:16 phone crop around `focalX`. Sources are never
 *  upscaled unless `maxUpscale` > 1 (GPT Image's 1536 px stills), then lanczos + mild unsharp. */
export async function processStillSet(bin: string, input: string, assetsDir: string, shot: ShotId, focalX = 50, maxUpscale = 1): Promise<ImageSet | null> {
  const outDir = join(assetsDir, "img");
  mkdirSync(outDir, { recursive: true });
  const { width, height } = await dims(bin, input);
  if (!width) return null;
  const sizes: ImageSet["sizes"] = [];
  for (const w of SHOT_SIZES[shot]) {
    const target = Math.min(w, Math.floor(width * maxUpscale));
    if (sizes.some((s) => s.w === target)) continue;
    const name = `${shot}-${target}.webp`;
    if (await ff(bin, ["-i", input, "-vf", `scale=${target}:-2:flags=lanczos${target > width ? `,${SHARPEN}` : ""}`, "-c:v", "libwebp", "-quality", target >= 2000 ? "74" : "76", join(outDir, name)])) sizes.push({ w: target, path: `assets/img/${name}` });
  }
  if (!sizes.length) return null;
  let mobile: string | undefined;
  if (shot === "hero-wide" || shot === "hero-close") {
    const cropW = Math.min(width, Math.round((height * 9) / 16));
    const x = Math.max(0, Math.min(width - cropW, Math.round((width * focalX) / 100 - cropW / 2)));
    const name = `${shot}-m.webp`;
    // Phone LCP budget (~90 KB): busy textures (foliage, blossom) get a lower quality, then a
    // narrower crop, instead of a 200 KB hero on a throttled phone.
    for (const [w, q] of [[720, 58], [720, 46], [600, 42], [540, 36]] as const) {
      if (!(await ff(bin, ["-i", input, "-vf", `crop=${cropW}:${height}:${x}:0,scale=${w}:-2:flags=lanczos${cropW < w ? `,${SHARPEN}` : ""}`, "-c:v", "libwebp", "-quality", String(q), join(outDir, name)]))) break;
      mobile = `assets/img/${name}`;
      if (statSync(join(outDir, name)).size <= 90 * 1024) break;
    }
  }
  return { key: shot, sizes, mobile, width, height };
}

/** All-intra H.264 (every frame a keyframe) so `currentTime` seeks are instant when scrubbed. */
export async function processFilm(bin: string, input: string, assetsDir: string): Promise<Film | null> {
  const { width, height } = await dims(bin, input);
  const duration = await probeDuration(bin, input);
  if (!width) return null;
  const out = join(assetsDir, "film.mp4");
  const scale = width > height ? "scale='min(1600,iw)':-2:flags=lanczos" : "scale=-2:'min(1600,ih)':flags=lanczos";
  const ok = await ff(bin, ["-i", input, "-an", "-vf", `${scale},fps=24,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-g", "1", "-keyint_min", "1", "-sc_threshold", "0", "-movflags", "+faststart", out]);
  if (!ok) return null;
  const d = await dims(bin, out);
  // Automatic gate: a film below 1080 on its short side, or under 4 s, is not premium enough.
  const shortSide = Math.min(width, height);
  const approved = shortSide >= 1080 && duration >= 4;
  const note = approved ? "" : `rejected: ${width}x${height}, ${duration.toFixed(1)} s (needs >= 1080 short side and >= 4 s)`;
  const sheet = join(assetsDir, "..", "qa");
  mkdirSync(sheet, { recursive: true });
  await ff(bin, ["-i", input, "-vf", "fps=1,scale=480:-2,tile=6x1", "-frames:v", "1", join(sheet, "film-sheet.png")]);
  return { mp4: "assets/film.mp4", width: d.width, height: d.height, duration, approved, note };
}

// ---------------------------------------------------------------------------------------------
// Zero-cost fallback art

function jitter(seed: number, i: number): number {
  const x = Math.sin(seed + i * 999) * 10000;
  return x - Math.floor(x);
}

/** A quiet tonal field with fine contour lines: no text, no logos, no people. */
function heroSvg(direction: Direction): string {
  const { accent, accentSoft, paper } = direction.palette;
  const lines = Array.from({ length: 18 }, (_, i) => {
    const y = 40 + i * 26;
    const a = 18 + jitter(direction.seed, i) * 30;
    return `<path d="M-20 ${y} C 200 ${y - a}, 420 ${y + a}, 820 ${y - a / 2}" fill="none" stroke="${accent}" stroke-opacity="${(0.08 + (i % 4) * 0.03).toFixed(2)}" stroke-width="1.2" />`;
  }).join("\n    ");
  return `<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustrative contour pattern, generated for this concept">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${paper}" /><stop offset="1" stop-color="${accentSoft}" /></linearGradient></defs>
  <rect width="800" height="500" fill="url(#g)" />
    ${lines}
</svg>`;
}

// ---------------------------------------------------------------------------------------------

type Manifest = { version: 2; media: ImageryMedia; assets: ImageAsset[]; engine: ImageryResult["engine"] };

function readManifest(draftDir: string): Manifest | null {
  const path = join(draftDir, "assets", "imagery.json");
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (m.version !== 2 || !m.media?.heroWide) return null;
    const files = [m.media.heroWide, m.media.heroClose, m.media.section, m.media.detail].flatMap((s) => (s ? s.sizes.map((x) => x.path) : []));
    if (m.media.film) files.push(m.media.film.mp4);
    return files.every((f) => existsSync(join(draftDir, f))) ? m : null;
  } catch {
    return null;
  }
}

export function writeManifest(draftDir: string, media: ImageryMedia, assets: ImageAsset[]) {
  writeFileSync(join(draftDir, "assets", "imagery.json"), JSON.stringify({ version: 2, media, assets, engine: assets.find((a) => a.role === "hero-wide")?.engine === "gpt-image" ? "gpt-image" : "higgsfield" } satisfies Manifest, null, 2), "utf8");
}

function ledger(draftDir: string, rows: string[]) {
  const ledgerPath = join(draftDir, "CREDITS.md");
  const header = "# Imagery credit ledger\n\n| Date | Engine | Asset | Cost |\n|---|---|---|---|\n";
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, header, "utf8");
  if (rows.length) appendFileSync(ledgerPath, rows.join("\n") + "\n", "utf8");
}

export type ImageryOptions = {
  /** Max PAID generation attempts for this draft (4 stills + 1 film + 2 retries by default). */
  cap?: number;
  env?: Record<string, string | undefined>;
  vertical?: Vertical;
  designServerUrl?: string;
  skipHiggsfield?: boolean;
  /** Skip the film even when the budget allows it (stills only). */
  skipFilm?: boolean;
  regenerate?: boolean;
  generate?: GenerateCall;
  /** Stills provider. Default: GPT Image pinned to openai-2 (not under bun test, and not when a
   *  `generate` seam is given). `null` = Higgsfield stills only. */
  stills?: StillCall | null;
  ffmpegBin?: string | null;
  generationsDir?: string;
  /** Already-generated source files by shot (and "film"), reused instead of paying again. */
  existing?: Partial<Record<ShotId | "film", string>>;
  backoffMs?: number[];
  log?: (line: string) => void;
};

/** The dev server only reads references inside its roots, its ledger or its references folder, so
 *  a still it didn't make (GPT Image) is copied into ~/.claude-os/design/references first. */
export function referenceable(path: string, home = homedir()): string {
  if (path.startsWith(defaultGenerationsDir())) return path;
  const dir = join(home, ".claude-os", "design", "references");
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `site-draft-${Date.now()}-${path.split(/[\\/]/).pop()}`);
  copyFileSync(path, copy);
  return copy;
}

/** The dev server's reference id for a file it saved: base64url of the absolute path. */
export function designReferenceId(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

export async function buildImagery(draftDir: string, direction: Direction, opts: ImageryOptions = {}): Promise<ImageryResult> {
  const cap = Math.max(0, Math.min(opts.cap ?? 7, 8));
  const baseUrl = opts.designServerUrl ?? DESIGN_SERVER;
  const assetsDir = join(draftDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const log = opts.log ?? (() => {});
  const today = new Date().toISOString().slice(0, 10);

  // `bun test` must never spend money: live generation needs an explicit server URL or seam there.
  const underTest = (opts.env ?? process.env).NODE_ENV === "test" && !opts.designServerUrl && !opts.generate;
  const skip = opts.skipHiggsfield || underTest;

  if (!skip && !opts.regenerate) {
    const cached = readManifest(draftDir);
    if (cached) return { engine: cached.engine, available: true, reason: "Reused this draft's generated media (no new spend).", assets: cached.assets, totalCredits: 0, totalUsd: 0, generations: 0, reused: true, media: cached.media };
  }

  const media: ImageryMedia = {};
  const assets: ImageAsset[] = [];
  const rows: string[] = [];
  let reason = "";
  let generations = 0;
  let totalUsd = 0;
  const sources: Partial<Record<ShotId, string>> = {};
  const stillEngine: Partial<Record<ShotId, string>> = {};

  if (!skip) {
    let generate = opts.generate ?? null;
    // Never a live GPT call under bun test or when a test seam is injected.
    const still: StillCall | null = opts.stills !== undefined ? opts.stills : opts.generate || (opts.env ?? process.env).NODE_ENV === "test" ? null : gptImageStill();
    let pinnedRefusal = "";
    let prices: Record<string, ModelPrice> = {};
    if (!generate && cap > 0) {
      const status = await checkHiggsfieldDevServer(baseUrl);
      const token = status.available ? await fetchDesignToken(baseUrl) : null;
      if (!status.available) reason = status.reason;
      else if (!token) reason = "Could not fetch the local dev-server session token.";
      else {
        generate = devServerGenerator(baseUrl, { generationsDir: opts.generationsDir });
        prices = await livePrices(baseUrl, token);
      }
    }
    if (generate || still) {
      const ffmpeg = opts.ffmpegBin === undefined ? await findFfmpeg(opts.env) : opts.ffmpegBin;
      const budget = { left: cap };
      const stillPrice = prices[STILL_MODEL]?.costUsd ?? FALLBACK_PRICE.still;
      const shots: ShotId[] = ["hero-wide", "hero-close", "section", "detail"];
      for (const shot of shots) {
        const plan = direction.imagePlan[shot];
        const reuse = opts.existing?.[shot] && existsSync(opts.existing[shot]!) ? opts.existing[shot]! : null;
        let res: { path: string | null; attempts: number; error: string } = { path: reuse, attempts: 0, error: "" };
        let via: "reuse" | "gpt" | "higgsfield" = "reuse";
        if (!reuse && still) {
          via = "gpt";
          for (let attempt = 1; attempt <= 2 && !res.path; attempt++) {
            res.attempts = attempt;
            try {
              res.path = await still({ prompt: plan.prompt, aspect: plan.aspect, out: join(assetsDir, `gpt-${shot}.png`) });
            } catch (e) {
              res.error = (e as Error).message;
              log(`GPT Image ${shot} attempt ${attempt}: ${res.error.slice(0, 160)}`);
              // The pinned account was refused: stop ALL stills (no silent move to another account or engine).
              if (e instanceof PinnedAccountError) {
                pinnedRefusal = res.error;
                break;
              }
            }
          }
          generations += res.attempts;
        }
        if (pinnedRefusal) {
          reason ||= `GPT Image stopped (pinned account ${GPT_POOL_LABEL}): ${pinnedRefusal.slice(0, 200)}`;
          break;
        }
        if (!res.path && generate) {
          if (totalUsd + stillPrice > STOP_AND_ASK_USD) break;
          via = "higgsfield";
          res = await generateWithRetry(generate, { kind: "image", model: STILL_MODEL, prompt: plan.prompt, params: { resolution: "2k", aspect_ratio: plan.aspect, quality: "medium" } }, budget, { backoffMs: opts.backoffMs, log });
          generations += res.attempts;
        }
        if (!res.path) {
          reason ||= `${shot} failed after ${res.attempts} attempt(s): ${res.error.slice(0, 160)}`;
          continue;
        }
        if (via === "higgsfield") totalUsd += stillPrice;
        const gptSource = via === "gpt" || (via === "reuse" && /(^|[\\/])gpt-[^\\/]*$/.test(res.path));
        sources[shot] = res.path;
        const raw = join(assetsDir, `source-${shot}${res.path.slice(res.path.lastIndexOf("."))}`);
        if (raw !== res.path) copyFileSync(res.path, raw);
        const set = ffmpeg ? await processStillSet(ffmpeg, raw, assetsDir, shot, plan.focalX, gptSource ? 2 : 1) : null;
        const fallbackSet: ImageSet = { key: shot, sizes: [{ w: 1600, path: `assets/${raw.slice(assetsDir.length + 1)}` }], width: 1600, height: 900 };
        media[MEDIA_KEY[shot]] = set ?? fallbackSet;
        stillEngine[shot] = gptSource ? "gpt-image" : "higgsfield";
        rows.push(
          via === "higgsfield"
            ? `| ${today} | higgsfield/${STILL_MODEL} (2K, ${plan.aspect}; GPT Image fallback) | ${shot}: ${plan.prompt.slice(0, 120)}... | US$${stillPrice.toFixed(3)} |`
            : via === "gpt"
              ? `| ${today} | ${GPT_STILL_MODEL} via Hermes Codex (ChatGPT ${GPT_POOL_LABEL}, ${gptImageSize(plan.aspect)}) | ${shot}: ${plan.prompt.slice(0, 120)}... | subscription (US$0) |`
              : `| ${today} | reused (${gptSource ? "gpt-image" : "higgsfield"}) | ${shot}: ${res.path.slice(-60)} | reused an earlier generation |`,
        );
      }

      // The film, FROM the hero-wide still (its first frame), wide screens only.
      const filmReuse = opts.existing?.film && existsSync(opts.existing.film) ? opts.existing.film : null;
      const filmPrice = Math.max(prices[FILM_MODEL]?.costUsd ?? 0, FALLBACK_PRICE.filmPerSecond) * FILM_SECONDS;
      if (generate && !opts.skipFilm && sources["hero-wide"] && (filmReuse || (budget.left > 0 && totalUsd + filmPrice <= STOP_AND_ASK_USD))) {
        const res = filmReuse
          ? { path: filmReuse, attempts: 0, error: "" }
          : await generateWithRetry(
              generate,
              { kind: "video", model: FILM_MODEL, prompt: direction.imagePlan.film.prompt, params: { resolution: "1080p", duration: FILM_SECONDS, aspect_ratio: direction.imagePlan["hero-wide"].aspect }, references: [designReferenceId(stillEngine["hero-wide"] === "gpt-image" ? referenceable(sources["hero-wide"]!) : sources["hero-wide"]!)] },
              budget,
              { backoffMs: opts.backoffMs, log },
            );
        generations += res.attempts;
        if (res.path) {
          if (!filmReuse) totalUsd += filmPrice;
          const raw = join(assetsDir, `source-film${res.path.slice(res.path.lastIndexOf("."))}`);
          if (raw !== res.path) copyFileSync(res.path, raw);
          const film = ffmpeg ? await processFilm(ffmpeg, raw, assetsDir) : null;
          if (film) media.film = film;
          rows.push(`| ${today} | higgsfield/${FILM_MODEL} (1080p, ${FILM_SECONDS} s, image-to-video from hero-wide) | film: ${direction.imagePlan.film.prompt.slice(0, 120)}... | ${filmReuse ? "reused an earlier generation" : `~US$${filmPrice.toFixed(2)} (US$0.25/s at 1080p)`}${film && !film.approved ? `; ${film.note}` : ""} |`);
        } else reason ||= `film failed: ${res.error.slice(0, 160)}`;
      }
    }
  }

  const generated = Boolean(media.heroWide);
  if (generated) {
    for (const [role, set] of Object.entries({ "hero-wide": media.heroWide, "hero-close": media.heroClose, section: media.section, detail: media.detail }) as [ShotId, ImageSet | undefined][]) {
      if (!set) continue;
      const top = set.sizes[set.sizes.length - 1];
      const size = existsSync(join(draftDir, top.path)) ? statSync(join(draftDir, top.path)).size : 0;
      assets.push({ path: top.path, role, engine: stillEngine[role] ?? "higgsfield", description: `${role}, ${set.width}x${set.height} source, ${Math.round(size / 1024)} KB at ${top.w} px`, costCredits: 0 });
    }
    if (media.film) assets.push({ path: media.film.mp4, role: "film", engine: "higgsfield", description: `film ${media.film.width}x${media.film.height}, ${media.film.duration.toFixed(1)} s, all-intra${media.film.approved ? "" : ` (${media.film.note})`}`, costCredits: 0 });
    writeManifest(draftDir, media, assets);
  } else {
    writeFileSync(join(assetsDir, "hero.svg"), heroSvg(direction), "utf8");
    assets.push({ path: "assets/hero.svg", engine: "css-svg-fallback", description: "Tonal contour field", costCredits: 0, role: "fallback" });
    rows.push(`| ${today} | css-svg-fallback | assets/hero.svg | 0 |`);
  }
  ledger(draftDir, rows);

  const gptImage = checkGptImage();
  return {
    engine: generated ? (stillEngine["hero-wide"] === "gpt-image" ? "gpt-image" : "higgsfield") : "css-svg-fallback",
    available: generated,
    reason: generated ? reason : `${reason || (skip ? "Generation skipped" : "No generation budget")} | GPT Image: ${gptImage.reason}`,
    assets,
    totalCredits: 0,
    totalUsd,
    generations,
    reused: false,
    media: generated ? media : undefined,
  };
}
