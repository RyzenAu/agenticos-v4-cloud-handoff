// Pure, file-content-in / result-out checks for the QA gate (scripts/qa/gate.ts). Kept separate
// from gate.ts's disk/network orchestration so every rule here can be unit-tested with plain
// strings and no filesystem or fetch.
//
// Every automatable web-quality rule the brief asked for lives here: WCAG contrast, alt text,
// mobile viewport, robots/noindex correctness, prefers-reduced-motion, and a documented
// Core Web Vitals lab fallback for machines with no Lighthouse installed. Nothing here sends,
// deploys or installs anything — it only reads text already pulled off disk by the caller.

export type Severity = "fail" | "warn" | "pass" | "skip";
export type CheckResult = { id: string; title: string; severity: Severity; detail: string; evidence?: string[] };

export type FileEntry = { path: string; content: string };

// --- WCAG contrast -----------------------------------------------------------------------------
// Same maths as scripts/check-contrast.mjs (relative luminance, WCAG AA 4.5:1 body / 3:1 large),
// generalised from that file's one hard-coded background to any CSS custom-property pair a site
// declares, plus every exact inline `style="color:…;background…"` pair (those are unambiguous —
// no guessing which background a colour sits on).
function lin(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function lum([r, g, b]: number[]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrastRatio(fg: number[], bg: number[]): number {
  const [hi, lo] = lum(fg) > lum(bg) ? [lum(fg), lum(bg)] : [lum(bg), lum(fg)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parses `#rgb`, `#rrggbb` and `rgb(a)(...)` into a 0-255 triple, or null if it isn't a colour
 *  this checker can evaluate (currentColor, a var(), transparent, named colours, etc. — those are
 *  left to manual review rather than guessed at). */
export function parseColor(raw: string): number[] | null {
  const s = raw.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

export type ColorPair = { fg: number[]; bg: number[]; source: string; largeText?: boolean };

/** Extracts every unambiguous inline colour-on-background pair from a page's HTML: a `style=`
 *  attribute naming both `color` and `background`/`background-color` on the one element. */
export function inlineColorPairs(html: string, source: string): ColorPair[] {
  const pairs: ColorPair[] = [];
  const styleRe = /style\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(html))) {
    const style = m[1];
    const color = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1];
    const bg = style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i)?.[1];
    if (!color || !bg) continue;
    const fg = parseColor(color);
    const bgColor = parseColor(bg);
    if (fg && bgColor) pairs.push({ fg, bg: bgColor, source });
  }
  return pairs;
}

/** Extracts every declared CSS custom-property colour pair that looks like a text/background
 *  token pair (`--foreground`/`--background`, `--text`/`--bg`, …) so a design system's own tokens
 *  get checked once, rather than every element that merely references them. */
export function tokenColorPairs(css: string, source: string): ColorPair[] {
  const tokens = new Map<string, string>();
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(css))) {
    const val = parseColor(m[2]);
    if (val) tokens.set(m[1], m[2].trim());
  }
  const fgNames = [...tokens.keys()].filter((k) => /(foreground|text|ink|fg)(?!.*muted)/i.test(k));
  const bgNames = [...tokens.keys()].filter((k) => /(background|^--bg|surface|paper)/i.test(k));
  const pairs: ColorPair[] = [];
  for (const fgName of fgNames) {
    const fg = parseColor(tokens.get(fgName)!);
    if (!fg) continue;
    for (const bgName of bgNames) {
      const bg = parseColor(tokens.get(bgName)!);
      if (bg) pairs.push({ fg, bg, source: `${source}: ${fgName} on ${bgName}` });
    }
  }
  return pairs;
}

export function contrastCheck(htmlFiles: FileEntry[], cssFiles: FileEntry[]): CheckResult {
  const pairs: ColorPair[] = [];
  for (const f of htmlFiles) pairs.push(...inlineColorPairs(f.content, f.path));
  for (const f of cssFiles) pairs.push(...tokenColorPairs(f.content, f.path));
  if (!pairs.length)
    return {
      id: "wcag-contrast", title: "WCAG AA contrast", severity: "skip",
      detail: "No evaluable inline colour-on-background pairs or foreground/background design tokens found — nothing to check automatically. Verify visually.",
    };
  const failing = pairs
    .map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }))
    .filter((p) => p.ratio < (p.largeText ? 3 : 4.5));
  if (!failing.length)
    return { id: "wcag-contrast", title: "WCAG AA contrast", severity: "pass", detail: `${pairs.length} colour pair(s) checked, all pass AA.` };
  return {
    id: "wcag-contrast", title: "WCAG AA contrast", severity: "fail",
    detail: `${failing.length} of ${pairs.length} colour pair(s) fall below WCAG AA (4.5:1 body / 3:1 large text).`,
    evidence: failing.slice(0, 15).map((p) => `${p.source}: ${p.ratio.toFixed(2)}:1`),
  };
}

// --- Alt text -----------------------------------------------------------------------------------
export function altTextCheck(htmlFiles: FileEntry[]): CheckResult {
  const missing: string[] = [];
  let total = 0;
  for (const f of htmlFiles) {
    const imgRe = /<img\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(f.content))) {
      total++;
      const tag = m[0];
      if (/\brole\s*=\s*"presentation"/i.test(tag) || /\baria-hidden\s*=\s*"true"/i.test(tag)) continue;
      if (!/\balt\s*=/i.test(tag)) missing.push(`${f.path}: ${tag.slice(0, 100)}`);
    }
  }
  if (!total) return { id: "alt-text", title: "Image alt text", severity: "skip", detail: "No <img> tags found." };
  if (!missing.length) return { id: "alt-text", title: "Image alt text", severity: "pass", detail: `${total} image(s) checked, all have an alt attribute.` };
  return {
    id: "alt-text", title: "Image alt text", severity: "fail",
    detail: `${missing.length} of ${total} <img> tag(s) have no alt attribute (decorative images should use alt="" or role="presentation").`,
    evidence: missing.slice(0, 15),
  };
}

// --- Mobile 390px render (heuristic — no headless browser bundled here; see gate.ts's doc note) -
export function mobileRenderCheck(htmlFiles: FileEntry[], cssFiles: FileEntry[]): CheckResult {
  const noViewport = htmlFiles.filter((f) => !/<meta[^>]+name\s*=\s*"viewport"/i.test(f.content));
  const fixedWidthRe = /(?<![-\w])width\s*:\s*(\d{3,5})px/gi;
  const overWide: string[] = [];
  for (const f of cssFiles) {
    let m: RegExpExecArray | null;
    while ((m = fixedWidthRe.exec(f.content))) {
      const px = Number(m[1]);
      if (px > 390 && px < 4000) overWide.push(`${f.path}: width: ${px}px`);
    }
  }
  const issues: string[] = [];
  if (noViewport.length) issues.push(...noViewport.map((f) => `${f.path}: missing <meta name="viewport">`));
  if (overWide.length) issues.push(...overWide.slice(0, 10));
  const detailPrefix = "Static heuristic (no headless browser in this gate) — checks the viewport meta tag and CSS fixed widths over 390px; it does not render the page. ";
  if (!htmlFiles.length) return { id: "mobile-390", title: "Mobile 390px render (heuristic)", severity: "skip", detail: detailPrefix + "No HTML to check." };
  if (!issues.length) return { id: "mobile-390", title: "Mobile 390px render (heuristic)", severity: "pass", detail: detailPrefix + "Viewport meta present, no CSS fixed width over 390px found." };
  return {
    id: "mobile-390", title: "Mobile 390px render (heuristic)", severity: "warn",
    detail: detailPrefix + `${issues.length} potential issue(s) found. Confirm at 390px in a real browser before shipping.`,
    evidence: issues.slice(0, 15),
  };
}

// --- noindex / robots correctness ---------------------------------------------------------------
export type SiteMode = "preview" | "production";

export function robotsCheck(htmlFiles: FileEntry[], robotsTxt: string | null, mode: SiteMode): CheckResult {
  const withMeta = htmlFiles.map((f) => ({ path: f.path, noindex: /<meta[^>]+name\s*=\s*"robots"[^>]+content\s*=\s*"[^"]*noindex/i.test(f.content) }));
  const noindexPages = withMeta.filter((p) => p.noindex);
  const indexablePages = withMeta.filter((p) => !p.noindex);
  const robotsDisallowsAll = !!robotsTxt && /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*($|\n)/i.test(robotsTxt);

  if (mode === "preview") {
    const bad = indexablePages;
    if (!htmlFiles.length) return { id: "robots-noindex", title: "noindex/robots correctness", severity: "skip", detail: "No HTML to check." };
    if (!bad.length)
      return { id: "robots-noindex", title: "noindex/robots correctness", severity: "pass", detail: `Preview build: all ${htmlFiles.length} page(s) carry a noindex meta tag.` };
    return {
      id: "robots-noindex", title: "noindex/robots correctness", severity: "fail",
      detail: `Preview build: ${bad.length} page(s) have no noindex meta tag — a preview must never be indexable.`,
      evidence: bad.slice(0, 15).map((p) => p.path),
    };
  }
  // production
  const bad = [...noindexPages.map((p) => p.path), ...(robotsDisallowsAll ? ["robots.txt: Disallow: / for User-agent: *"] : [])];
  if (!bad.length)
    return { id: "robots-noindex", title: "noindex/robots correctness", severity: "pass", detail: `Production build: no noindex meta tag and robots.txt doesn't block everything.` };
  return {
    id: "robots-noindex", title: "noindex/robots correctness", severity: "fail",
    detail: `Production build: ${bad.length} page(s)/rule(s) would keep this site out of search — a production site must be indexable.`,
    evidence: bad.slice(0, 15),
  };
}

// --- prefers-reduced-motion -----------------------------------------------------------------------
export function reducedMotionCheck(htmlFiles: FileEntry[], cssFiles: FileEntry[]): CheckResult {
  const hasMotionCss = cssFiles.some((f) => /@keyframes|animation\s*:|transition\s*:/i.test(f.content));
  const hasMotionScript = htmlFiles.some((f) => /<script[\s\S]*?(requestAnimationFrame|gsap|ScrollTrigger|canvas)/i.test(f.content));
  if (!hasMotionCss && !hasMotionScript)
    return { id: "reduced-motion", title: "prefers-reduced-motion respected", severity: "skip", detail: "No animation, transition or canvas/GSAP motion found — nothing to gate." };
  const cssHandles = cssFiles.some((f) => /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(f.content));
  const scriptHandles = htmlFiles.some((f) => /matchMedia\(\s*['"]\(prefers-reduced-motion:\s*reduce\)['"]\s*\)/i.test(f.content));
  if (cssHandles || scriptHandles)
    return { id: "reduced-motion", title: "prefers-reduced-motion respected", severity: "pass", detail: "Motion is present and prefers-reduced-motion is handled (CSS media query or matchMedia check)." };
  return {
    id: "reduced-motion", title: "prefers-reduced-motion respected", severity: "fail",
    detail: "Animation/transition/canvas motion found but no @media (prefers-reduced-motion: reduce) rule or matchMedia check found anywhere.",
  };
}

// --- Core Web Vitals lab numbers (documented fallback when Lighthouse isn't installed) -----------
export type PageWeight = { path: string; bytes: number };

export function coreWebVitalsFallback(htmlFiles: FileEntry[], assetWeights: PageWeight[]): CheckResult {
  const totalBytes = assetWeights.reduce((sum, a) => sum + a.bytes, 0);
  const blockingScripts = htmlFiles.reduce((n, f) => {
    const headEnd = f.content.search(/<\/head>/i);
    const head = headEnd === -1 ? f.content : f.content.slice(0, headEnd);
    const scriptRe = /<script\b(?![^>]*\b(?:defer|async|type\s*=\s*"module")\b)[^>]*\bsrc\s*=/gi;
    return n + (head.match(scriptRe)?.length ?? 0);
  }, 0);
  const heavyImages = assetWeights.filter((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.path) && a.bytes > 500_000);
  const detail = "Lighthouse not installed — using a documented static fallback: total local asset weight, render-blocking <script> tags in <head>, and images over 500KB (a common LCP risk). Run Lighthouse locally for real field-accurate LCP/INP/CLS numbers.";
  const issues: string[] = [];
  if (blockingScripts > 0) issues.push(`${blockingScripts} render-blocking <script src> tag(s) in <head> (no defer/async/module) — an LCP/INP risk.`);
  if (heavyImages.length) issues.push(`${heavyImages.length} image(s) over 500KB — an LCP risk. ${heavyImages.slice(0, 5).map((a) => `${a.path} (${(a.bytes / 1024).toFixed(0)}KB)`).join(", ")}`);
  if (totalBytes > 5_000_000) issues.push(`Total local asset weight ${(totalBytes / 1_000_000).toFixed(1)}MB — heavy for mobile.`);
  return {
    id: "core-web-vitals", title: "Core Web Vitals (lab, fallback)", severity: issues.length ? "warn" : "pass",
    detail: `${detail} Total weight: ${(totalBytes / 1_000_000).toFixed(2)}MB across ${assetWeights.length} file(s).${issues.length ? "" : " No obvious LCP/INP risk found by this heuristic."}`,
    evidence: issues,
  };
}

/** True when a `lighthouse` CLI binary is on PATH (checked by gate.ts with `which`/`where` before
 *  calling this) — kept as a pure decision function so the branch is testable without shelling out. */
export function coreWebVitalsFromLighthouse(scores: { lcp: number; inp: number; cls: number }): CheckResult {
  const issues: string[] = [];
  if (scores.lcp > 2500) issues.push(`LCP ${scores.lcp}ms (target < 2500ms)`);
  if (scores.inp > 200) issues.push(`INP ${scores.inp}ms (target < 200ms)`);
  if (scores.cls > 0.1) issues.push(`CLS ${scores.cls.toFixed(3)} (target < 0.1)`);
  return {
    id: "core-web-vitals", title: "Core Web Vitals (Lighthouse lab)", severity: issues.length ? "warn" : "pass",
    detail: issues.length ? `${issues.length} metric(s) outside the "Good" threshold.` : "LCP, INP and CLS all within the Lighthouse \"Good\" threshold.",
    evidence: issues,
  };
}

// --- Broken links/images (file-existence check; network check is done by gate.ts, which knows
// how to fetch) -----------------------------------------------------------------------------------
export function localLinkTargets(htmlFiles: FileEntry[]): { path: string; targets: string[] }[] {
  return htmlFiles.map((f) => {
    const targets = new Set<string>();
    const attrRe = /\b(?:href|src)\s*=\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(f.content))) {
      const url = m[1];
      if (!url || url.startsWith("#") || url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("javascript:") || url.startsWith("data:")) continue;
      targets.add(url);
    }
    return { path: f.path, targets: [...targets] };
  });
}

export function brokenLinksResult(broken: { fromPage: string; target: string; reason: string }[], totalChecked: number): CheckResult {
  if (!totalChecked) return { id: "broken-links", title: "Broken links/images", severity: "skip", detail: "No href/src links found." };
  if (!broken.length) return { id: "broken-links", title: "Broken links/images", severity: "pass", detail: `${totalChecked} link/image target(s) checked, none broken.` };
  return {
    id: "broken-links", title: "Broken links/images", severity: "fail",
    detail: `${broken.length} of ${totalChecked} link/image target(s) are broken.`,
    evidence: broken.slice(0, 20).map((b) => `${b.fromPage} → ${b.target}: ${b.reason}`),
  };
}

/** The RISE "ten tells" (mu-killer-site skill, RISE-GUIDE.md §4) plus M&U's non-negotiables — a
 *  visual/motion checklist that needs a human eye, not an automated score. Only surfaced when the
 *  gate can see generated motion/canvas content; listed as an informational checklist, never PASS/
 *  FAIL, so it never silently gates a static, motion-free site. */
export function tenTellsChecklist(htmlFiles: FileEntry[]): CheckResult | null {
  const hasMotion = htmlFiles.some((f) => /<canvas\b|data-scene=|gsap|ScrollTrigger/i.test(f.content));
  if (!hasMotion) return null;
  return {
    id: "ten-tells", title: "Ten tells (generated motion/canvas — manual review)", severity: "warn",
    detail: "This build has generated motion/canvas content (mu-killer-site RISE-GUIDE.md §4). Automated checks can't judge these — review by eye before shipping:",
    evidence: [
      "1. Clipped letters: line-height >= 1.1; check every g, j, p, q, y.",
      "2. No word alone on a line.",
      "3. Empty stage: the visual fills 80-95% of the stage.",
      "4. Flat colour: light falls off across the frame; no single flat fill.",
      "5. Linear motion: ease in/out; nothing at one constant speed.",
      "6. Loop seams: last frame matches the first, pixel for pixel.",
      "7. Text held >= 1.2s.",
      "8. Fake logos: the real file only, never drawn from memory.",
      "9. Busy backgrounds: one idea on a quiet ground.",
      "10. No texture: real grain/noise so it feels hand-made.",
      "M&U additions: no invented facts/testimonials/awards; no before/after or patient claims (dental, AHPRA); reduced-motion gets the finished still frame; canvas must not block first paint of real HTML text.",
    ],
  };
}

export function overallPass(results: CheckResult[]): boolean {
  return !results.some((r) => r.severity === "fail");
}
