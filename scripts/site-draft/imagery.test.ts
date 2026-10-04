import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImagery, checkHiggsfieldApiKey, checkGptImage, gptImageSize, PinnedAccountError, checkHiggsfieldDevServer, isRetryableGenerationError, generateWithRetry, findSavedGeneration, generationSlug } from "./imagery";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildDirection } from "./direction";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "site-draft-imagery-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("generation retry policy", () => {
  test("retries only errors where nothing was accepted and billed", () => {
    expect(isRetryableGenerationError("The Higgsfield generation could not be confirmed... this request was not resubmitted")).toBe(true);
    expect(isRetryableGenerationError("HTTP 503: upstream")).toBe(true);
    expect(isRetryableGenerationError("HTTP 403: forbidden")).toBe(true);
    // A dropped connection may still be a running, billed job: recover, never resubmit.
    expect(isRetryableGenerationError("The socket connection was closed unexpectedly")).toBe(false);
    expect(isRetryableGenerationError("Higgsfield is still processing request 1234abcd-1111-2222-3333-444455556666")).toBe(false);
    expect(isRetryableGenerationError("HTTP 502: Higgsfield API request failed (HTTP 400)")).toBe(true);
    expect(isRetryableGenerationError("Higgsfield: choose a supported aspect ratio")).toBe(false);
  });

  test("the attempt budget is a hard ceiling, retries included", async () => {
    let calls = 0;
    const budget = { left: 2 };
    const generate = async () => {
      calls += 1;
      throw new Error("HTTP 503: busy");
    };
    const r = await generateWithRetry(generate, { kind: "image", model: "m", prompt: "p", params: {} }, budget, { backoffMs: [1, 1, 1] });
    expect(r.path).toBeNull();
    expect(calls).toBe(2);
    expect(budget.left).toBe(0);
  });

  test("backs off and succeeds on a retryable failure", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      if (calls === 1) throw new Error("could not be confirmed");
      return "C:/out.png";
    };
    const r = await generateWithRetry(generate, { kind: "image", model: "m", prompt: "p", params: {} }, { left: 3 }, { backoffMs: [1] });
    expect(r).toEqual({ path: "C:/out.png", attempts: 2, error: "" });
  });

  test("finds a dropped job's saved output by prompt slug and time", () => {
    const dir = tempDir();
    const prompt = "Morning sunlight slowly travels across a curved limestone wall";
    const t = Date.now();
    writeFileSync(join(dir, `${t}-${generationSlug(prompt)}-abc123.mp4`), "x");
    writeFileSync(join(dir, `${t - 3_600_000}-${generationSlug(prompt)}-old.mp4`), "x");
    expect(findSavedGeneration(dir, prompt, t - 1000, "video")).toMatch(/abc123\.mp4$/);
    expect(findSavedGeneration(dir, prompt, t - 1000, "image")).toBeNull();
    expect(findSavedGeneration(dir, "a different prompt entirely", t - 1000, "video")).toBeNull();
  });
});

describe("buildImagery spend safety", () => {
  test("under bun test with no explicit server or seam, it never calls the live dev server", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Safe Co", area: "Penrith NSW", vertical: "dental" });
    const result = await buildImagery(dir, direction, { env: { NODE_ENV: "test" } });
    expect(result.engine).toBe("css-svg-fallback");
    expect(result.generations).toBe(0);
  });

  test("reuses a draft's cached media at zero cost", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "assets"), { recursive: true });
    for (const f of ["hero-loop.mp4", "hero-poster.webp", "portrait.webp"]) writeFileSync(join(dir, "assets", f), "x");
    writeFileSync(join(dir, "assets", "imagery.json"), JSON.stringify({ version: 2, engine: "higgsfield", assets: [], media: { heroWide: { key: "hero-wide", sizes: [{ w: 960, path: "assets/hero-loop.mp4" }], width: 1, height: 1 }, film: { mp4: "assets/hero-poster.webp", width: 1, height: 1, duration: 6, approved: true, note: "" } } }));
    const direction = buildDirection({ name: "Cache Co", area: "Penrith NSW", vertical: "legal" });
    let called = false;
    const result = await buildImagery(dir, direction, {
      generate: async () => {
        called = true;
        return "";
      },
    });
    expect(called).toBe(false);
    expect(result.reused).toBe(true);
    expect(result.media?.heroWide?.sizes[0].path).toBe("assets/hero-loop.mp4");
  });

  test("with a generation seam, spends at most the cap and records the ledger", async () => {
    const dir = tempDir();
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "film.mp4"), "not really a film");
    writeFileSync(join(src, "still.png"), "not really a png");
    const direction = buildDirection({ name: "Seam Co", area: "Penrith NSW", vertical: "real-estate" });
    const calls: { kind: string; references?: string[] }[] = [];
    const result = await buildImagery(dir, direction, {
      cap: 7,
      ffmpegBin: null,
      generate: async ({ kind, references }) => {
        calls.push({ kind, references });
        return kind === "video" ? join(src, "film.mp4") : join(src, "still.png");
      },
    });
    // Four stills first, then ONE film made from the hero-wide still (its dev-server reference id).
    expect(calls.map((c) => c.kind)).toEqual(["image", "image", "image", "image", "video"]);
    expect(Buffer.from(calls[4].references![0], "base64url").toString("utf8")).toBe(join(src, "still.png"));
    expect(result.engine).toBe("higgsfield");
    expect(result.generations).toBe(5);
    expect(result.media?.heroWide).toBeDefined();
    expect(result.media?.detail).toBeDefined();
    expect(readFileSync(join(dir, "CREDITS.md"), "utf8")).toMatch(/grok-imagine-image-2.0/);
  });

  test("a cap of 2 buys two stills and no film", async () => {
    const dir = tempDir();
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "still.png"), "x");
    const direction = buildDirection({ name: "Cap Two Co", area: "Penrith NSW", vertical: "dental" });
    const kinds: string[] = [];
    const result = await buildImagery(dir, direction, { cap: 2, ffmpegBin: null, generate: async ({ kind }) => { kinds.push(kind); return join(src, "still.png"); } });
    expect(kinds).toEqual(["image", "image"]);
    expect(result.media?.film).toBeUndefined();
  });
});

describe("checkHiggsfieldApiKey", () => {
  test("reports unavailable when no key is in the environment", () => {
    expect(checkHiggsfieldApiKey({}).available).toBe(false);
  });

  test("is a pure function of the env object it's given — never touches a .env file", () => {
    const result = checkHiggsfieldApiKey({ HIGGSFIELD_API_KEY: "abc" });
    expect(result.available).toBe(true);
  });
});

describe("checkHiggsfieldDevServer", () => {
  test("reports unavailable when nothing is listening on the given port", async () => {
    const result = await checkHiggsfieldDevServer("http://127.0.0.1:1"); // nothing listens on port 1
    expect(result.available).toBe(false);
  });
});

describe("GPT Image stills (pinned ChatGPT account)", () => {
  test("is unavailable without Hermes' Python environment", () => {
    expect(checkGptImage({}).available).toBe(false);
  });

  test("asks for the backend shape that matches the shot", () => {
    expect(gptImageSize("3:4")).toBe("1024x1536");
    expect(gptImageSize("16:9")).toBe("1536x1024");
    expect(gptImageSize("1:1")).toBe("1024x1024");
  });

  test("is the default stills provider: no Higgsfield spend for stills, film still from Higgsfield", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Gpt Stills Dental", area: "Penrith NSW", vertical: "dental" });
    const stills: string[] = [];
    const kinds: string[] = [];
    const result = await buildImagery(dir, direction, {
      ffmpegBin: null,
      skipFilm: true,
      stills: async ({ out, aspect }) => { stills.push(aspect); writeFileSync(out, "png"); return out; },
      generate: async ({ kind }) => { kinds.push(kind); return join(dir, "never.png"); },
    });
    expect(stills.length).toBe(4);
    expect(kinds).toEqual([]);
    expect(result.engine).toBe("gpt-image");
    expect(result.totalUsd).toBe(0);
    expect(result.assets.every((a) => a.engine === "gpt-image")).toBe(true);
  });

  test("falls back to Higgsfield only when GPT Image errors", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hf.png"), "x");
    const direction = buildDirection({ name: "Gpt Fallback Dental", area: "Penrith NSW", vertical: "dental" });
    const kinds: string[] = [];
    const result = await buildImagery(dir, direction, {
      ffmpegBin: null,
      skipFilm: true,
      backoffMs: [0, 0],
      stills: async () => { throw new Error("HTTP 500: upstream"); },
      generate: async ({ kind }) => { kinds.push(kind); return join(dir, "hf.png"); },
    });
    expect(kinds).toEqual(["image", "image", "image", "image"]);
    expect(result.engine).toBe("higgsfield");
  });

  test("a refused pinned account stops every still: no other account, no Higgsfield fallback", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Gpt Pinned Dental", area: "Penrith NSW", vertical: "dental" });
    let calls = 0;
    const kinds: string[] = [];
    const result = await buildImagery(dir, direction, {
      ffmpegBin: null,
      stills: async () => { calls++; throw new PinnedAccountError("Pool entry 'openai-2' hit its usage limit"); },
      generate: async ({ kind }) => { kinds.push(kind); return join(dir, "never.png"); },
    });
    expect(calls).toBe(1);
    expect(kinds).toEqual([]);
    expect(result.engine).toBe("css-svg-fallback");
    expect(result.reason).toContain("openai-2");
  });
});

describe("buildImagery", () => {
  test("falls back to CSS/SVG art with zero cost when Higgsfield is skipped", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Test Co", area: "Penrith NSW", vertical: "dental" });
    const result = await buildImagery(dir, direction, { skipHiggsfield: true });
    expect(result.engine).toBe("css-svg-fallback");
    expect(result.totalCredits).toBe(0);
    expect(result.assets.length).toBeGreaterThan(0);
    for (const asset of result.assets) expect(existsSync(join(dir, asset.path))).toBe(true);
  });

  test("caps the number of generated fallback assets", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Cap Co", area: "Penrith NSW", vertical: "legal" });
    const result = await buildImagery(dir, direction, { skipHiggsfield: true, cap: 1 });
    expect(result.assets.length).toBe(1);
  });

  test("never asks for more than 3 images even if a higher cap is passed", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Over Co", area: "Penrith NSW", vertical: "legal" });
    const result = await buildImagery(dir, direction, { skipHiggsfield: true, cap: 10 });
    expect(result.assets.length).toBeLessThanOrEqual(3);
  });

  test("writes a credit ledger", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Ledger Co", area: "Penrith NSW", vertical: "real-estate" });
    await buildImagery(dir, direction, { skipHiggsfield: true });
    const ledger = readFileSync(join(dir, "CREDITS.md"), "utf8");
    expect(ledger).toMatch(/Imagery credit ledger/);
    expect(ledger).toMatch(/css-svg-fallback/);
  });

  test("generated SVG fallback never references a photo or a person", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "No Photo Co", area: "Blacktown NSW", vertical: "dental" });
    const result = await buildImagery(dir, direction, { skipHiggsfield: true });
    for (const asset of result.assets) {
      const svg = readFileSync(join(dir, asset.path), "utf8");
      expect(svg).toMatch(/^<svg/);
      expect(svg.toLowerCase()).not.toMatch(/<image|<img/);
    }
  });

  test("an unreachable dev server behaves exactly like skipHiggsfield (graceful fallback)", async () => {
    const dir = tempDir();
    const direction = buildDirection({ name: "Unreachable Co", area: "Penrith NSW", vertical: "dental" });
    const result = await buildImagery(dir, direction, { designServerUrl: "http://127.0.0.1:1" });
    expect(result.engine).toBe("css-svg-fallback");
    expect(result.reason).toMatch(/Higgsfield/);
  });
});
