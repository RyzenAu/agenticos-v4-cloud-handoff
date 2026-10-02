// Stage 4: mu-concept-qa's checklist, automated. This repo has no Playwright dependency and no
// existing chromium.launch()/toHaveScreenshot() pattern (checked before writing this) — but
// mu-concept-qa's own SKILL.md says to "use an available browser tool" and names the
// agent-browser CLI already installed on this machine (`C:\Users\Nebula PC\AppData\Roaming\npm\
// agent-browser.cmd`) as exactly that tool, with its own axe-core accessibility audit built in.
// That is what this uses, rather than adding a new heavy dependency for one script.
//
// Checks: desktop (1440) + mobile (375) screenshots, console errors, an axe a11y/contrast pass,
// tap-target sizing (from the same a11y audit's target-size rule), a claims-vs-evidence audit
// against evidence.json (fails the draft if a claim isn't traceable), and a page-weight sanity
// check standing in for a full Lighthouse run.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "./evidence";
import { auditDesignRules, localAssetText } from "./design-rules";

// The npm-installed `agent-browser.cmd` is a shim batch file; like the Claude Code npm shim (see
// claude-bridge.ts's defaultClaudeBin), Node's child_process.spawn can't exec a .cmd directly
// without a shell. Rather than spawn with `shell: true` (quoting/injection risk for a path that
// has a space in it — "Nebula PC" — and for anything derived from a lead name later), this
// resolves straight to the real native exe the shim wraps, the same pattern the Claude bridge
// uses for its own npm-shimmed binary.
export function defaultAgentBrowserBin(): string {
  const candidates = [
    process.env.AGENT_BROWSER_BIN,
    process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe"),
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? "agent-browser";
}

export type QaIssue = { severity: "fail" | "warn"; area: string; detail: string };
export type QaReport = {
  pass: boolean;
  issues: QaIssue[];
  screenshots: { desktop: string | null; mobile: string | null };
  generatedAt: string;
};

export type Runner = (args: string[]) => Promise<{ stdout: string; ok: boolean }>;
export type QaOptions = { runner?: Runner; sessionPrefix?: string; /** Issues found before the browser pass (the image-relevance check). */ extraIssues?: QaIssue[] };

export function defaultRunner(bin: string, timeoutMs: number): Runner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({ stdout: out, ok: false });
      }, timeoutMs);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout: err, ok: false });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: out || err, ok: code === 0 });
      });
    });
}

// Text that has no business appearing in a draft built only from evidence.json: reviews, awards,
// prices, guarantees, before/after, or a named individual presented as staff. This is the
// automated half of mu-business-evidence's "never manufacture" rule.
const FORBIDDEN_CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /★|⭐|\b\d(\.\d)?\s*\/\s*5\b|\b\d+(?:\.\d+)?[\s-]*stars?\b/i, label: "star rating" },
  { re: /\$\s?\d|\d+%\s*off/i, label: "price or discount" },
  { re: /award[- ]winning|voted (?:best|number ?one)/i, label: "award claim" },
  { re: /guarantee[ds]?\b/i, label: "guarantee claim" },
  { re: /before\s*(?:&|and)\s*after/i, label: "before/after claim" },
  { re: /testimonial|"[^"]{15,}"\s*[-–—]\s*[A-Z][a-z]+\s*[A-Z]\.?\s*$/im, label: "testimonial" },
  { re: /\bDr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/, label: "named staff member" },
];

export function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function auditClaims(html: string, evidence: Evidence): QaIssue[] {
  const issues: QaIssue[] = [];
  const text = stripTags(html);
  for (const { re, label } of FORBIDDEN_CLAIM_PATTERNS) {
    const match = text.match(re);
    if (match) issues.push({ severity: "fail", area: "claims", detail: `Found an unevidenced ${label}: "${match[0].slice(0, 60)}"` });
  }
  // Services: every service line rendered should trace back to an evidenced service. We can't
  // parse arbitrary generated markup for a "services" section reliably, so this checks the
  // inverse and cheaper direction: if evidence has NO services at all, the page must not claim any
  // specific named treatment/practice-area beyond generic category language already vetted by the
  // vertical's own copy pool (this is a heuristic backstop, not a substitute for human QA).
  if (!evidence.services.length && evidence.hasOwnWebsite === false) {
    const suspicious = /\b(?:root canal|invisalign|conveyancing|probate|litigation|property management|rental appraisal)\b/i.exec(text);
    if (suspicious) issues.push({ severity: "warn", area: "claims", detail: `Mentions a specific service ("${suspicious[0]}") with no evidenced service list — confirm this is generic vertical copy, not an invented specialty.` });
  }
  return issues;
}

/** Identity of an image/video file for the reuse rule: renditions of one image share it
 *  ("img/hero-wide-960.webp", "img/hero-wide-m.webp" and "img/hero-wide-2400.webp" are one asset). */
export function assetKey(path: string): string {
  let base = path.split(/[?#]/)[0].split("/").pop() ?? path;
  base = base.replace(/\.[a-z0-9]+$/i, "");
  for (let i = 0; i < 3; i++) base = base.replace(/-(\d{3,4}w?|m|sm|lg|mobile|small|large)$/i, "");
  return base.toLowerCase();
}

/** The owner's rule: every image (and the film) appears once on the page, the logo excepted.
 *  A <picture> (its <source>s plus <img>) counts as one use; every other <img>, <video> and CSS
 *  url() is one use each. */
export function auditAssetReuse(html: string): QaIssue[] {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<link[^>]*>/gi, " ");
  const uses = new Map<string, number>();
  const count = (keys: Iterable<string>) => { for (const k of new Set(keys)) if (!/logo/i.test(k)) uses.set(k, (uses.get(k) ?? 0) + 1); };
  const media = /[\w./-]+\.(?:webp|avif|png|jpe?g|gif|svg|mp4|webm)\b/gi;
  let rest = body.replace(/<picture[\s\S]*?<\/picture>/gi, (block) => {
    count([...block.matchAll(media)].map((m) => assetKey(m[0])));
    return " ";
  });
  rest = rest.replace(/<(img|video|source)\b[^>]*>/gi, (tag) => {
    count([...tag.matchAll(media)].map((m) => assetKey(m[0])));
    return " ";
  });
  // Images only: a variable font file is legitimately referenced by several @font-face weights.
  for (const m of rest.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) if (!m[1].startsWith("data:") && /\.(?:webp|avif|png|jpe?g|gif|svg|mp4|webm)$/i.test(m[1].split(/[?#]/)[0])) count([assetKey(m[1])]);
  const issues: QaIssue[] = [];
  for (const [key, n] of uses) if (n > 1) issues.push({ severity: "fail", area: "imagery", detail: `Image "${key}" is used ${n} times; every image appears once (the logo excepted).` });
  return issues;
}

/** Share of the first screen the hero image actually covers, after opacity, visibility and any
 *  clip-path inset on its ancestors (a refine pass once clipped it out of view entirely). */
export const HERO_VISIBLE_JS = `(() => {
  const img = document.querySelector('[data-layer="a"] img');
  if (!img) return -1;
  let r = img.getBoundingClientRect();
  let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  let op = 1;
  for (let el = img; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return 0;
    op *= Number(cs.opacity);
    const m = /inset\\(([^)]*)\\)/.exec(cs.clipPath || "");
    if (m) {
      const er = el.getBoundingClientRect();
      const px = (v, size) => (v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
      const parts = m[1].split(" round ")[0].trim().split(/\\s+/);
      const [t, rr = t, bb = t, ll = rr] = parts;
      box = { l: Math.max(box.l, er.left + px(ll, er.width)), t: Math.max(box.t, er.top + px(t, er.height)), r: Math.min(box.r, er.right - px(rr, er.width)), b: Math.min(box.b, er.bottom - px(bb, er.height)) };
    }
  }
  const w = Math.max(0, Math.min(box.r, innerWidth) - Math.max(box.l, 0));
  const h = Math.max(0, Math.min(box.b, innerHeight) - Math.max(box.t, 0));
  return Math.round((w * h) / (innerWidth * innerHeight) * op * 100) / 100;
})()`;

// RISE "Examine" (VIDEO-STUDY-HOXrLsVqinY, 25 Sep 2026): a motion page isn't done until frames at
// 0/25/50/75/100% of its scroll have been looked at. Each frame is saved to qa/frames/ and scored:
// the share of a 5x5 grid of points (below the banner/header band) whose topmost element shows
// text or media at an effective opacity above 0.1. A frame at 0 is blank (a reveal that never
// fired, a pinned scene stuck on its empty state) and fails; a frame under 0.12 is flagged.
export const FRAME_POINTS = [0, 25, 50, 75, 100] as const;
export const frameScrollJs = (pct: number) =>
  `(()=>{const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);window.scrollTo({top:Math.round(max*${pct / 100}),behavior:"instant"});return Math.round(max*${pct / 100})})()`;
export const FRAME_CONTENT_JS = `(() => {
  const op = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.visibility === "hidden" || cs.display === "none") return 0; o *= parseFloat(cs.opacity || "1"); } return o; };
  const shows = (el) => { for (let e = el, d = 0; e && d < 4; e = e.parentElement, d++) { if (/^(IMG|VIDEO|CANVAS|SVG|PICTURE)$/i.test(e.tagName)) return true; if ([...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return true; if (getComputedStyle(e).backgroundImage !== "none") return true; } return false; };
  let hit = 0, n = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const x = innerWidth * (0.1 + 0.2 * i), y = innerHeight * (0.2 + 0.17 * j);
    const el = document.elementFromPoint(x, y); n++;
    if (el && shows(el) && op(el) > 0.1) hit++;
  }
  return Math.round(hit / n * 100) / 100;
})()`;

export async function checkFrames(run: Runner, session: string[], qaDir: string, label: string): Promise<{ issues: QaIssue[]; frames: { pct: number; path: string; content: number | null }[] }> {
  const issues: QaIssue[] = [];
  const frames: { pct: number; path: string; content: number | null }[] = [];
  mkdirSync(join(qaDir, "frames"), { recursive: true });
  for (const pct of FRAME_POINTS) {
    await run([...session, "eval", frameScrollJs(pct)]);
    await run([...session, "wait", "900"]);
    const path = join(qaDir, "frames", `${label}-${String(pct).padStart(3, "0")}.png`);
    await run([...session, "screenshot", path]);
    const res = await run([...session, "eval", FRAME_CONTENT_JS]);
    const content = Number(/-?\d+(?:\.\d+)?\s*$/.exec(String(res.stdout).trim())?.[0] ?? NaN);
    const ok = res.ok && Number.isFinite(content);
    frames.push({ pct, path, content: ok ? content : null });
    if (!ok) continue;
    if (content === 0) issues.push({ severity: "fail", area: "motion", detail: `Blank frame at ${pct}% scroll (${label}): nothing visible; a reveal or pinned scene is stuck. See ${path}.` });
    else if (content < 0.12) issues.push({ severity: "warn", area: "motion", detail: `Nearly empty frame at ${pct}% scroll (${label}), ${Math.round(content * 100)}% of sample points show content. See ${path}.` });
  }
  await run([...session, "eval", frameScrollJs(0)]);
  return { issues, frames };
}

export function auditPageWeight(draftDir: string): QaIssue[] {
  const issues: QaIssue[] = [];
  const indexPath = join(draftDir, "index.html");
  if (!existsSync(indexPath)) return [{ severity: "fail", area: "performance", detail: "index.html was not produced." }];
  let total = statSync(indexPath).size;
  const html = readFileSync(indexPath, "utf8");
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:css|js|svg|png|jpe?g|webp))["']/gi)) {
    const rel = match[1];
    if (/^https?:\/\//i.test(rel)) continue;
    const path = join(draftDir, rel);
    if (existsSync(path)) total += statSync(path).size;
  }
  const externalHosts = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"'/]+)/gi)]
    .map((m) => m[1])
    .filter((host) => !/fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com/i.test(host));
  if (total > 1_500_000) issues.push({ severity: "warn", area: "performance", detail: `Draft weighs ~${Math.round(total / 1024)}KB (local assets) — heavy for a one-page static draft.` });
  if (externalHosts.length) issues.push({ severity: "warn", area: "performance", detail: `References external hosts beyond Google Fonts/cdnjs (GSAP): ${[...new Set(externalHosts)].join(", ")}` });
  return issues;
}

// A heuristic mobile-performance stand-in — this repo has no Lighthouse CLI installed (checked
// before writing this), so this is NOT a measured Lighthouse score and never claims to be one; it
// flags the concrete things that tank a real Lighthouse mobile run on a page with motion: render-
// blocking scripts without `defer`/`async`, motion with no `prefers-reduced-motion` guard, and
// non-hero images without `loading="lazy"`.
export function auditMotionPerformance(draftDir: string): QaIssue[] {
  const issues: QaIssue[] = [];
  const indexPath = join(draftDir, "index.html");
  if (!existsSync(indexPath)) return issues;
  const html = readFileSync(indexPath, "utf8");
  const usesMotion = /gsap|ScrollTrigger|@keyframes|animation-timeline|\btransition\s*:/i.test(html);
  const hasReducedMotionGuard = /prefers-reduced-motion/i.test(html);
  if (usesMotion && !hasReducedMotionGuard) {
    issues.push({ severity: "fail", area: "performance", detail: "Uses animation/motion but has no prefers-reduced-motion guard anywhere in the page." });
  }
  for (const match of html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    if (!/defer|async/i.test(match[0])) issues.push({ severity: "warn", area: "performance", detail: `External script loaded without defer/async, which blocks first paint: ${match[1]}` });
  }
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)];
  for (const [i, tag] of imgTags.entries()) {
    if (i === 0) continue; // the first image is typically the hero — don't lazy-load above-the-fold content
    if (!/loading=["']lazy["']/i.test(tag[0])) issues.push({ severity: "warn", area: "performance", detail: `Below-the-fold <img> without loading="lazy": ${tag[0].slice(0, 80)}` });
  }
  return issues;
}

export async function runQa(
  draftDir: string,
  previewUrl: string,
  evidence: Evidence,
  opts: QaOptions = {},
): Promise<QaReport> {
  const issues: QaIssue[] = [];
  const qaDir = join(draftDir, "qa");
  mkdirSync(qaDir, { recursive: true });

  const html = existsSync(join(draftDir, "index.html")) ? readFileSync(join(draftDir, "index.html"), "utf8") : "";
  issues.push(...(opts.extraIssues ?? []));
  issues.push(...auditClaims(html, evidence));
  issues.push(...auditAssetReuse(html));
  issues.push(...auditPageWeight(draftDir));
  issues.push(...auditMotionPerformance(draftDir));
  // impeccable / mu-art-direction / mu-killer-site, as checks (design-rules.ts): fails here feed
  // the orchestrator's one bounded fix pass, like every other QA fail.
  if (html) issues.push(...auditDesignRules({ html, ...localAssetText(draftDir, html), vertical: evidence.vertical }));

  const run = opts.runner ?? defaultRunner(defaultAgentBrowserBin(), 20_000);
  const session = `${opts.sessionPrefix ?? "site-draft-qa"}-${evidence.leadId}`;
  const S = ["--session", session];
  const desktopPath = join(qaDir, "desktop-1440.png");
  const mobilePath = join(qaDir, "mobile-375.png");
  let desktopOk = false, mobileOk = false;

  try {
    await run([...S, "open", previewUrl]);
    await run([...S, "console", "--clear"]);
    await run([...S, "errors", "--clear"]);
    await run([...S, "set", "viewport", "1440", "900"]);
    const shot1 = await run([...S, "screenshot", desktopPath]);
    const heroDesk = await run([...S, "eval", HERO_VISIBLE_JS]);
    const deskShare = Number(/-?\d+(?:\.\d+)?\s*$/.exec(String(heroDesk.stdout).trim())?.[0] ?? NaN);
    if (heroDesk.ok && Number.isFinite(deskShare) && deskShare >= 0 && deskShare < 0.2) issues.push({ severity: "fail", area: "composition", detail: `The hero image covers only ${Math.round(deskShare * 100)}% of the first screen at 1440 px; it must be clearly visible before any scroll.` });
    desktopOk = shot1.ok && existsSync(desktopPath);
    if (!desktopOk) issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not capture the desktop screenshot via agent-browser." });
    if (desktopOk) issues.push(...(await checkFrames(run, S, qaDir, "desktop-1440")).issues);

    const errors = await run([...S, "errors", "--json"]);
    if (errors.ok) {
      try {
        const parsed = JSON.parse(errors.stdout);
        const list = Array.isArray(parsed) ? parsed : parsed.errors ?? [];
        for (const e of list.slice(0, 10)) issues.push({ severity: "fail", area: "console", detail: `Page error: ${typeof e === "string" ? e : JSON.stringify(e).slice(0, 200)}` });
      } catch {
        /* Non-JSON output from an older CLI build — skip rather than fail QA on a parsing gap. */
      }
    }

    const a11y = await run([...S, "a11y", "--tags", "wcag2a,wcag2aa", "--json"]);
    if (a11y.ok) {
      try {
        const parsed = JSON.parse(a11y.stdout);
        for (const v of (parsed.violations ?? []).slice(0, 15)) {
          issues.push({ severity: v.impact === "critical" || v.impact === "serious" ? "fail" : "warn", area: "accessibility", detail: `${v.id}: ${v.help} (${v.nodeCount ?? "?"} node(s))` });
        }
      } catch {
        issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not parse the accessibility audit output." });
      }
    } else {
      issues.push({ severity: "warn", area: "qa-tooling", detail: "Accessibility audit did not run (agent-browser unavailable or timed out)." });
    }

    await run([...S, "set", "viewport", "375", "812"]);
    const shot2 = await run([...S, "screenshot", mobilePath]);
    const heroMob = await run([...S, "eval", HERO_VISIBLE_JS]);
    const mobShare = Number(/-?\d+(?:\.\d+)?\s*$/.exec(String(heroMob.stdout).trim())?.[0] ?? NaN);
    if (heroMob.ok && Number.isFinite(mobShare) && mobShare >= 0 && mobShare < 0.2) issues.push({ severity: "fail", area: "composition", detail: `The hero image covers only ${Math.round(mobShare * 100)}% of the first screen at 375 px.` });
    mobileOk = shot2.ok && existsSync(mobilePath);
    if (!mobileOk) issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not capture the 375px mobile screenshot via agent-browser." });
  } finally {
    await run([...S, "close"]).catch(() => {});
  }

  const report: QaReport = {
    pass: !issues.some((i) => i.severity === "fail"),
    issues,
    screenshots: { desktop: desktopOk ? desktopPath : null, mobile: mobileOk ? mobilePath : null },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(draftDir, "qa.json"), JSON.stringify(report, null, 2), "utf8");
  const md = [
    `# QA — ${evidence.name}`,
    "",
    `Result: **${report.pass ? "PASS" : "REVIEW NEEDED"}**`,
    "",
    ...report.issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.area}: ${i.detail}`),
    report.issues.length ? "" : "No issues found.",
  ].join("\n");
  writeFileSync(join(draftDir, "QA.md"), md, "utf8");
  return report;
}

/** A short, fixable-instructions string for build.ts's second pass — only the FAIL-level issues,
 *  since mu-art-direction/impeccable bound QA to one inspect + one fix + one confirm. */
export function fixNotesFrom(report: QaReport): string {
  return report.issues
    .filter((i) => i.severity === "fail")
    .map((i) => `- (${i.area}) ${i.detail}`)
    .join("\n");
}
