// Takes a READ-ONLY static snapshot of a live flagship page (the Next.js flagships have no static
// export, and their worktrees are dirty and must never be modified). Fetches the rendered HTML,
// drops every script (Next.js hydration would otherwise re-render the flagship's own text over
// ours), and copies the page's stylesheets, fonts and images next to it so the result is a
// self-contained static folder. Nothing here writes to the flagship projects.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

const UA = "Mozilla/5.0 (compatible; MU-Ventures-TemplateBuilder/1.0; +https://muventures.com.au)";
const defaultFetch: Fetcher = (url) => fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });

/** A short, stable, filesystem-safe name for an asset URL. */
export function assetName(url: string): string {
  const u = new URL(url);
  const inner = u.pathname === "/_next/image" ? u.searchParams.get("url") ?? u.pathname : u.pathname;
  const base = basename(decodeURIComponent(inner)).replace(/[^a-zA-Z0-9._-]/g, "_") || "asset";
  return base.length > 80 ? base.slice(-80) : base;
}

/** `/_next/image?url=%2Fimg%2Fx.webp&w=3840` → the original public file `/img/x.webp`. */
export function originalImageUrl(src: string, origin: string): string {
  const u = new URL(src.replace(/&amp;/g, "&"), origin);
  if (u.pathname === "/_next/image") {
    const inner = u.searchParams.get("url");
    if (inner) return new URL(inner, origin).href;
  }
  return u.href;
}

/** Removes every <script> (inline and external) plus script preloads. */
export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*rel=["'](?:preload|modulepreload)["'][^>]*as=["']script["'][^>]*\/?>/gi, "")
    .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*\/?>/gi, "")
    .replace(/<link\b[^>]*as=["']script["'][^>]*\/?>/gi, "");
}

export type SnapshotResult = { html: string; assets: string[] };

/**
 * Snapshot `pageUrl` into `outDir` (index.html is NOT written — the caller transforms the returned
 * HTML first). Assets land in `outDir/assets/`.
 */
export async function snapshotPage(pageUrl: string, outDir: string, fetcher: Fetcher = defaultFetch): Promise<SnapshotResult> {
  const origin = new URL(pageUrl).origin;
  const res = await fetcher(pageUrl);
  if (!res.ok) throw new Error(`Couldn't fetch ${pageUrl} (${res.status}).`);
  let html = stripScripts(await res.text());
  const assetsDir = join(outDir, "assets");
  mkdirSync(join(assetsDir, "media"), { recursive: true });
  const saved = new Map<string, string>(); // absolute url -> relative path from outDir
  const assets: string[] = [];

  async function save(absUrl: string, sub: "" | "media" = ""): Promise<string | null> {
    if (saved.has(absUrl)) return saved.get(absUrl)!;
    if (new URL(absUrl).origin !== origin) return null; // never pull third-party assets
    const r = await fetcher(absUrl);
    if (!r.ok) return null;
    let name = assetName(absUrl);
    if ([...saved.values()].includes(`assets/${sub ? sub + "/" : ""}${name}`)) name = `${saved.size}-${name}`;
    const rel = `assets/${sub ? sub + "/" : ""}${name}`;
    const file = join(outDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    if (/\.css(?:$|\?)/i.test(new URL(absUrl).pathname)) {
      let css = await r.text();
      // Fonts/images referenced from the stylesheet: copy them to assets/media, rewrite relative to the css file.
      const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]).filter((u) => !u.startsWith("data:"));
      for (const u of new Set(urls)) {
        const abs = new URL(u, absUrl).href;
        const local = await save(abs, "media");
        if (local) css = css.split(u).join(local.replace(/^assets\//, ""));
      }
      writeFileSync(file, css, "utf8");
    } else {
      writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
    }
    saved.set(absUrl, rel);
    assets.push(rel);
    return rel;
  }

  // Stylesheets.
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href) continue;
    const local = await save(new URL(href.replace(/&amp;/g, "&"), origin).href);
    html = html.replace(m[0], local ? m[0].replace(href, local) : "");
  }
  // Drop every other preload / prefetch hint (fonts are pulled in by the CSS; images are rewritten below).
  html = html.replace(/<link\b[^>]*rel=["'](?:preload|prefetch|preconnect|dns-prefetch)["'][^>]*\/?>/gi, "");
  // Icons.
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/gi)]) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href) continue;
    const local = await save(new URL(href.replace(/&amp;/g, "&"), origin).href);
    html = html.replace(m[0], local ? m[0].replace(href, local) : "");
  }
  // Images: one original file per <img>, srcset/sizes dropped; <source> elements dropped.
  html = html.replace(/<source\b[^>]*>/gi, "");
  for (const m of [...html.matchAll(/<img\b[^>]*>/gi)]) {
    const src = /\ssrc=["']([^"']+)["']/i.exec(m[0])?.[1];
    let tag = m[0].replace(/\s(?:srcset|srcSet|sizes|imageSrcSet|imagesrcset)=["'][^"']*["']/g, "");
    if (src && !src.startsWith("data:")) {
      const local = await save(originalImageUrl(src, origin));
      tag = local ? tag.replace(src, local) : tag;
    }
    html = html.replace(m[0], tag);
  }
  // Inline background images.
  for (const m of [...html.matchAll(/url\((?:&quot;|['"])?(\/[^)'"&]+)(?:&quot;|['"])?\)/g)]) {
    const local = await save(new URL(m[1], origin).href);
    if (local) html = html.split(m[1]).join(local);
  }
  return { html, assets };
}
