// The lead's REAL brand tokens, read from its own live website: colours, fonts and logo. The video
// study of 25 Sep 2026 (VIDEO-STUDY-HOXrLsVqinY.md) used Firecrawl's `formats: ["branding"]` for
// this; that's a paid API with its own key, so this is the dependency-free equivalent over the
// home page (and one first-party stylesheet) that evidence.ts already fetches politely.
//
// Tokens are evidence like any other fact: each carries its source URL, nothing is guessed, and
// direction.ts only lets the brand colour replace a seeded accent when it passes contrast. A draft
// is a redesign concept, so the brand's colour is kept; its logo is recorded for the founder but
// never re-drawn or re-hosted.

export type BrandTokens = {
  sourceUrl: string;
  /** Chromatic colours, most used first (#rrggbb). Near-greys, near-white and near-black are excluded. */
  colours: string[];
  /** The one colour most likely to be the brand's: theme-color if chromatic, else the most used. */
  primary: string | null;
  /** Font families the site declares (first family of each stack), most used first; no generics. */
  fonts: string[];
  /** Absolute URL of the logo image, if one is marked as such. */
  logoUrl: string | null;
  observedAt: string;
};

const GENERIC_FONTS = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica neue|helvetica|arial|georgia|times new roman|times|verdana|tahoma|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji|var\(.*)$/i;

export function hexOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${m[1].split("").map((c) => c + c).join("")}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith("%") ? 60 : 0.6)) return null; // mostly transparent
    return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Saturation-ish: a colour counts as "brand" only if it isn't a grey, near-white or near-black. */
export function isChromatic(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const s = max === min ? 0 : (max - min) / 255 / (1 - Math.abs(2 * l - 1));
  return s > 0.22 && l > 0.08 && l < 0.92;
}

function absolute(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** First-party stylesheet URLs linked from a page (same host), for one extra polite fetch. */
export function stylesheetUrls(html: string, pageUrl: string): string[] {
  const host = (() => { try { return new URL(pageUrl).hostname; } catch { return ""; } })();
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    const abs = href && absolute(href, pageUrl);
    if (abs && new URL(abs).hostname === host) out.push(abs);
  }
  return out;
}

export function extractBrandTokens(html: string, pageUrl: string, css = "", observedAt = new Date().toISOString()): BrandTokens {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const inline = [...html.matchAll(/\bstyle=["']([^"']*)["']/gi)].map((m) => m[1]).join(";");
  const text = `${styles}\n${inline}\n${css}`;

  const counts = new Map<string, number>();
  const bump = (hex: string | null, by = 1) => { if (hex && isChromatic(hex)) counts.set(hex, (counts.get(hex) ?? 0) + by); };
  for (const m of text.matchAll(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g)) bump(hexOf(m[0]));
  // Colours named as brand/primary/accent custom properties count extra.
  for (const m of text.matchAll(/--[\w-]*(?:brand|primary|accent|theme|main)[\w-]*\s*:\s*([^;}]+)/gi)) bump(hexOf(m[1]), 5);
  const themeRaw = /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i.exec(html)?.[1];
  const theme = themeRaw ? hexOf(themeRaw) : null;
  const colours = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 6);
  const primary = theme && isChromatic(theme) ? theme : colours[0] ?? null;

  const fontCounts = new Map<string, number>();
  for (const m of text.matchAll(/font-family\s*:\s*([^;}"]+)/gi)) {
    const first = m[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "").replace(/\s*!important$/i, "").trim();
    if (first && !GENERIC_FONTS.test(first)) fontCounts.set(first, (fontCounts.get(first) ?? 0) + 1);
  }
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi)) {
    for (const fam of m[1].split("&").filter((p) => p.startsWith("family=")))
      { const name = decodeURIComponent(fam.slice(7).split(":")[0]).replace(/\+/g, " "); fontCounts.set(name, (fontCounts.get(name) ?? 0) + 3); }
  }
  const fonts = [...fontCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 4);

  let logoUrl: string | null = null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/logo/i.test(m[0])) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (src && !src.startsWith("data:")) { logoUrl = absolute(src, pageUrl); if (logoUrl) break; }
  }
  if (!logoUrl) {
    const icon = /<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+\.svg)["']/i.exec(html)?.[1];
    if (icon) logoUrl = absolute(icon, pageUrl);
  }
  return { sourceUrl: pageUrl, colours, primary, fonts, logoUrl, observedAt };
}

/** True when there's at least something real to hand the art direction. */
export function hasBrand(b: BrandTokens | null | undefined): b is BrandTokens {
  return !!b && (!!b.primary || b.fonts.length > 0 || !!b.logoUrl);
}
