// Self-hosted web fonts for each draft. Google Fonts' CSS is render-blocking and costs two
// extra origins on a phone; fetching the latin woff2 files once into a local cache and serving
// them from the draft itself gets first paint earlier (mobile Lighthouse) and keeps the draft
// working offline. Falls back to the plain Google Fonts <link> if anything fails.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type FontBundle = {
  /** CSS to inline in <style>: @font-face rules pointing at local files, or "" when using the link. */
  css: string;
  /** Local woff2 files worth preloading (the display face first). */
  preload: string[];
  /** The Google Fonts stylesheet URL to <link> when self-hosting failed; "" when self-hosted. */
  linkHref: string;
};

export function googleFontsHref(families: string[]): string {
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join("&")}&display=swap`;
}

export function defaultFontCache(): string {
  return join(process.env.USERPROFILE || process.env.HOME || ".", ".cache", "mu-site-draft", "fonts");
}

/** Keeps only the `latin` @font-face blocks of a Google Fonts css2 response. */
export function latinFaces(css: string): { block: string; url: string; family: string }[] {
  const out: { block: string; url: string; family: string }[] = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*{[^}]*})/g;
  for (const m of css.matchAll(re)) {
    if (m[1] !== "latin") continue;
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(m[2])?.[1];
    const family = /font-family:\s*'([^']+)'/.exec(m[2])?.[1];
    if (url && family) out.push({ block: m[2], url, family });
  }
  return out;
}

export async function selfHostFonts(
  draftDir: string,
  families: string[],
  opts: { cacheDir?: string; request?: typeof fetch; offline?: boolean } = {},
): Promise<FontBundle> {
  const href = googleFontsHref(families);
  const offline = opts.offline ?? process.env.NODE_ENV === "test";
  const cacheDir = opts.cacheDir ?? defaultFontCache();
  const request = opts.request ?? fetch;
  const key = createHash("sha1").update(href).digest("hex").slice(0, 12);
  const cssCache = join(cacheDir, `${key}.css`);
  try {
    mkdirSync(cacheDir, { recursive: true });
    let css = existsSync(cssCache) ? readFileSync(cssCache, "utf8") : "";
    if (!css) {
      if (offline) return { css: "", preload: [], linkHref: href };
      const res = await request(href, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`fonts css ${res.status}`);
      css = await res.text();
      writeFileSync(cssCache, css, "utf8");
    }
    const faces = latinFaces(css);
    if (!faces.length) return { css: "", preload: [], linkHref: href };
    const outDir = join(draftDir, "assets", "fonts");
    mkdirSync(outDir, { recursive: true });
    const rules: string[] = [];
    const preload: string[] = [];
    const seen = new Set<string>();
    for (const face of faces) {
      const name = `${createHash("sha1").update(face.url).digest("hex").slice(0, 10)}.woff2`;
      const cached = join(cacheDir, name);
      if (!existsSync(cached)) {
        if (offline) return { css: "", preload: [], linkHref: href };
        const res = await request(face.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`font ${res.status}`);
        writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
      }
      copyFileSync(cached, join(outDir, name));
      rules.push(face.block.replace(face.url, `assets/fonts/${name}`));
      if (!seen.has(face.family)) {
        seen.add(face.family);
        preload.push(`assets/fonts/${name}`);
      }
    }
    return { css: rules.join("\n"), preload: preload.slice(0, 2), linkHref: "" };
  } catch {
    return { css: "", preload: [], linkHref: href };
  }
}
