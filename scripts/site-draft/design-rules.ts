// The installed design skills, turned into something the generators actually run. Local skills
// don't influence an API/CLI-driven generator by being installed (mu-art-direction says as much),
// so the rules that can be checked mechanically live here ONCE and are used twice:
//   - designRulesPrompt(): the rule list, pasted into the site-draft refine prompt (build.ts);
//   - auditDesignRules(): the same rules as QA checks, run by site-draft QA (qa.ts runQa, whose
//     fails feed the one bounded fix pass) and by every one-click lead preview (lead-sites
//     generate.ts, which refuses a preview with a fail and records warnings in PREVIEW.md).
// Sources: impeccable 4.3.1 reference/craft-floor.md ("Refuse" list, motion floor) and
// reference/animate.md; mu-art-direction (reduced motion, no fictional people/premises as real);
// mu-killer-site step 1/4/5 (testimonials banned on health sites, captions for generated premises,
// reduced-motion static hero, transform/opacity only, LCP headline visible from first paint).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QaIssue } from "./qa";

export type DesignRuleContext = {
  html: string;
  /** Stylesheets and scripts the page loads (text), so CSS/JS rules see more than the HTML. */
  css?: string;
  js?: string;
  vertical?: string;
};

export type DesignRule = {
  id: string;
  source: "impeccable" | "mu-art-direction" | "mu-killer-site";
  /** One line, imperative, as it appears in prompts. */
  rule: string;
  check: (ctx: DesignRuleContext) => QaIssue | null;
};

/** Visible text only (no style/script/svg/tags), entities decoded enough to match copy. */
export function visibleCopy(html: string): string {
  return html
    .replace(/<(style|script|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Elements whose class list contains `word` and that carry visible text. */
function labelledElements(html: string, word: RegExp): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(p|span|div|small|h6)\b[^>]*\bclass="([^"]*)"[^>]*>([\s\S]{0,200}?)<\/\1>/gi)) {
    if (!word.test(m[2])) continue;
    const text = visibleCopy(m[3]);
    if (text && !/\{\{/.test(text)) out.push(text.slice(0, 40));
  }
  return out;
}

const issue = (severity: QaIssue["severity"], detail: string): QaIssue => ({ severity, area: "design", detail });

export const DESIGN_RULES: DesignRule[] = [
  {
    id: "no-eyebrow",
    source: "impeccable",
    rule: "No eyebrow, kicker or overline labels above headings; the heading carries its own weight.",
    check: ({ html }) => {
      const hits = labelledElements(html, /\b(eyebrow|kicker|overline)\b/i);
      return hits.length ? issue("warn", `Eyebrow/kicker labels above headings (${hits.length}): "${hits.slice(0, 3).join('", "')}". impeccable bans them.`) : null;
    },
  },
  {
    id: "no-gradient-text",
    source: "impeccable",
    rule: "No gradient text; emphasis comes from weight or size.",
    check: ({ html, css = "" }) => (/background-clip\s*:\s*text/i.test(html + css) ? issue("fail", "Gradient text (background-clip: text).") : null),
  },
  {
    id: "no-emoji-icons",
    source: "impeccable",
    rule: "No emoji or unicode glyphs standing in for icons.",
    check: ({ html }) => {
      const m = /\p{Extended_Pictographic}/u.exec(visibleCopy(html).replace(/[©®™]/g, ""));
      return m ? issue("fail", `Emoji in visible copy ("${m[0]}"); use drawn icons.`) : null;
    },
  },
  {
    id: "no-section-numbers",
    source: "impeccable",
    rule: "No 01 / 02 / 03 section numbering unless the sequence itself carries information.",
    check: ({ html }) => {
      const n = [...html.matchAll(/>\s*0[1-9]\s*(?:\/|<)/g)].length;
      return n >= 3 ? issue("warn", `${n} "01/02/03"-style numerals; keep them only where the order means something.`) : null;
    },
  },
  {
    id: "no-testimonials-health",
    source: "mu-killer-site",
    rule: "No testimonials, reviews or star ratings (never verified in a preview; banned outright on dental sites by AHPRA).",
    check: ({ html, vertical }) => {
      const copy = visibleCopy(html);
      const m = /\b(testimonials?|what our (?:patients|clients) say|\d(?:\.\d)?\s*(?:stars?|★)|5-star)\b/i.exec(copy);
      if (!m) return null;
      return issue(vertical === "dental" ? "fail" : "warn", `Review/testimonial language ("${m[0]}"); nothing like it is verified.`);
    },
  },
  {
    id: "reduced-motion",
    source: "mu-art-direction",
    rule: "Every animation has a prefers-reduced-motion path that leaves a complete, still page.",
    check: ({ html, css = "", js = "" }) => {
      const all = html + css + js;
      const moves = /@keyframes|\btransition\s*:|requestAnimationFrame|data-mu-(?:reveal|stagger|hero|marquee)|data-reveal|data-m=/i.test(all);
      return moves && !/prefers-reduced-motion/i.test(all) ? issue("fail", "Motion with no prefers-reduced-motion path.") : null;
    },
  },
  {
    id: "compositor-only",
    source: "mu-killer-site",
    rule: "Animate transform, opacity and clip-path only; never width, height, top, left or margins.",
    check: ({ html, css = "" }) => {
      const m = /transition(?:-property)?\s*:[^;}"]*\b(width|height|top|left|right|bottom|margin[\w-]*)\b\s+[\d.]+m?s/i.exec(html + css);
      return m ? issue("warn", `Animates a layout property (${m[1]}); use transform instead.`) : null;
    },
  },
  {
    id: "no-bounce",
    source: "impeccable",
    rule: "Exponential ease-out (cubic-bezier(0.16, 1, 0.3, 1)); no bounce or elastic curves.",
    check: ({ html, css = "", js = "" }) => {
      const all = html + css + js;
      const overshoot = [...all.matchAll(/cubic-bezier\(\s*[\d.]+\s*,\s*(-?[\d.]+)\s*,\s*[\d.]+\s*,\s*(-?[\d.]+)\s*\)/g)].some((m) => Number(m[1]) > 1.3 || Number(m[2]) > 1.3 || Number(m[1]) < -0.3);
      return overshoot || /\b(easeOutBounce|easeInOutElastic|elastic\.out|bounce\.out)\b/.test(all) ? issue("warn", "Bounce/elastic easing.") : null;
    },
  },
  {
    id: "no-thick-side-border",
    source: "impeccable",
    rule: "No coloured border-left/right thicker than 1px on cards, list items or callouts.",
    check: ({ html, css = "" }) => {
      const m = /border-(?:left|right)\s*:\s*([2-9]|\d{2,})px\s+solid\s+(?!currentColor|transparent)/i.exec(html + css);
      return m ? issue("warn", `A ${m[1]}px coloured side border.`) : null;
    },
  },
  {
    id: "no-hard-offset-shadow",
    source: "impeccable",
    rule: "No zero-blur offset block shadows outside a neobrutalist world.",
    check: ({ html, css = "" }) => (/box-shadow\s*:\s*-?[1-9]\d*px\s+-?[1-9]\d*px\s+0(?:px)?\s+(?!0)/i.test(html + css) ? issue("warn", "Hard offset (zero-blur) box shadow.") : null),
  },
  {
    id: "specific-copy",
    source: "impeccable",
    rule: 'Specific copy in the business\'s own language: no "Learn more", no "seamless / innovative / state-of-the-art / tailored / journey", no exclamation marks.',
    check: ({ html }) => {
      const m = /\b(learn more|seamless|innovative|state-of-the-art|cutting-edge|tailored solutions?|your journey)\b|[a-z]!(?:\s|$)/i.exec(visibleCopy(html));
      return m ? issue("warn", `Generic copy ("${m[0].trim()}").`) : null;
    },
  },
  {
    id: "generated-imagery-captioned",
    source: "mu-killer-site",
    rule: "Generated premises or objects are captioned as illustrative and AI-generated; never presented as the business's own.",
    check: ({ html }) => {
      const hasImages = /<img\b[^>]*\bsrc="[^"]*(?:generated|stock|assets\/img|_img)\//i.test(html);
      return hasImages && !/illustrative|AI-generated/i.test(visibleCopy(html)) ? issue("warn", "Photography with no illustrative / AI-generated caption or disclaimer.") : null;
    },
  },
  {
    id: "themed-selection",
    source: "impeccable",
    rule: "Theme the browser surfaces from the palette: text selection and focus rings are designed, not defaults.",
    check: ({ html, css = "" }) => (/::selection/.test(html + css) ? null : issue("warn", "Text selection uses the browser default; theme ::selection from the palette.")),
  },
];

/** The rules as prompt lines, grouped by source skill. */
export function designRulesPrompt(): string {
  return DESIGN_RULES.map((r) => `- ${r.rule} (${r.source})`).join("\n");
}

/** The text of the page's own (relative) stylesheets and scripts, for the CSS/JS rules. */
export function localAssetText(dir: string, html: string): { css: string; js: string } {
  let css = "", js = "";
  for (const m of html.matchAll(/(?:href|src)="(?!https?:|\/\/|data:)\/?([^"?#]+\.(css|js))"/gi)) {
    const path = join(dir, m[1]);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (m[2].toLowerCase() === "css") css += `\n${text}`;
    else if (!/^_next\//.test(m[1])) js += `\n${text}`; // framework chunks aren't the page's design
  }
  return { css, js };
}

/** Runs every rule; one issue per broken rule. */
export function auditDesignRules(ctx: DesignRuleContext): QaIssue[] {
  const out: QaIssue[] = [];
  for (const rule of DESIGN_RULES) {
    const found = rule.check(ctx);
    if (found) out.push({ ...found, detail: `[${rule.id}] ${found.detail}` });
  }
  return out;
}
