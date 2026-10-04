/**
 * What the motion kit hands out, from ONE source per piece (html + css + init):
 *   htmlSnippet   paste into any page: <style>, the markup, and a tiny <script> when the piece needs one
 *   reactSnippet  a "use client" component with the same CSS, markup and DOM code
 *   previewDoc    the sandboxed preview the Motion library shows, with the motion forced Full or Reduced
 * Pure string builders: no DOM, no React.
 */
import type { KitPiece } from "./types";

/** The M&U brand tokens every piece's root declares (so a copied piece carries its own palette). */
export const MU_TOKENS = [
  "--mu-bg: #080808",
  "--mu-surface: #131313",
  "--mu-raised: #1b1a18",
  "--mu-ink: #f3efe6",
  "--mu-muted: #a8a294",
  "--mu-gold: #c7a35a",
  "--mu-gold-hi: #e4c887",
  "--mu-line: rgba(243, 239, 230, 0.12)",
  '--mu-display: "Fraunces", Georgia, "Times New Roman", serif',
  '--mu-sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--mu-ease: cubic-bezier(0.22, 1, 0.36, 1)",
  "--mu-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)",
].join(";\n  ");

/** `.mu-x { tokens; …rest }`: a piece's root rule with the brand tokens first. */
export function rootRule(selector: string, rest: string): string {
  return `${selector} {\n  ${MU_TOKENS};\n${rest.replace(/^\n+|\s+$/g, "")}\n}`;
}

const REDUCED_QUERY = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g;

/** Does the CSS carry a reduced-motion block? (Every piece must.) */
export const hasReducedCss = (css: string) => new RegExp(REDUCED_QUERY.source).test(css);

const pascal = (id: string) =>
  id.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
/** JSON for inside a <script>: never closes the tag. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
const indent = (text: string, pad: string) =>
  text
    .replace(/^\n+|\s+$/g, "")
    .split("\n")
    .map((l) => (l.trim() ? pad + l : ""))
    .join("\n");

/** Paste-anywhere HTML: style, markup and (when needed) a script that runs init on every copy of it. */
export function htmlSnippet(p: KitPiece): string {
  const head = `<!-- ${p.name} · M&U motion kit. Reduced motion: ${p.reduced}${p.sampleCopy ? " Sample copy: replace it with sourced copy." : ""} -->`;
  const script = p.init
    ? `\n<script>\n  (() => {\n    function init(root) {\n${indent(p.init, "      ")}\n    }\n    document.querySelectorAll('[data-mu-kit="${p.id}"]').forEach((el) => init(el));\n  })();\n</script>`
    : "";
  return `${head}\n<style>\n${p.css.replace(/^\n+|\s+$/g, "")}\n</style>\n${p.html.replace(/^\n+|\s+$/g, "")}${script}\n`;
}

/** A React (Next.js "use client") component with the same CSS, markup and DOM code. */
export function reactSnippet(p: KitPiece): string {
  const name = pascal(p.id);
  const init = p.init
    ? `\n// DOM code shared with the HTML version.\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nfunction init(root: any): void | (() => void) {\n${indent(p.init, "  ")}\n}\n`
    : "";
  const effect = p.init
    ? `  useEffect(() => {\n    const root = ref.current?.querySelector('[data-mu-kit="${p.id}"]');\n    if (!root) return;\n    const stop = init(root);\n    return () => {\n      if (typeof stop === "function") stop();\n    };\n  }, []);\n`
    : "";
  const imports = p.init
    ? `import { useEffect, useRef } from "react";`
    : `import { useRef } from "react";`;
  return `"use client";
// ${p.name} · M&U motion kit. Reduced motion: ${p.reduced}${p.sampleCopy ? "\n// Sample copy: replace it with sourced copy." : ""}
${imports}

const CSS = ${JSON.stringify(p.css.replace(/^\n+|\s+$/g, ""))};
const HTML = ${JSON.stringify(p.html.replace(/^\n+|\s+$/g, ""))};
${init}
export function ${name}() {
  const ref = useRef<HTMLDivElement>(null);
${effect}  return <div ref={ref} style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: \`<style>\${CSS}</style>\${HTML}\` }} />;
}
`;
}

/** Forces prefers-reduced-motion in the preview: CSS blocks on/off, and matchMedia answers the same. */
function forceMotion(css: string, reduced: boolean): string {
  return css.replace(REDUCED_QUERY, reduced ? "@media all" : "@media not all");
}
const MATCH_MEDIA_SHIM = (reduced: boolean) =>
  `(() => { const real = window.matchMedia.bind(window); window.matchMedia = (q) => /prefers-reduced-motion/.test(q) ? { matches: /reduce/.test(q) ? ${reduced} : ${!reduced}, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } } : real(q); })();`;

const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'unsafe-inline'; img-src data:";
const FONTS =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Inter:wght@400..700&display=swap";

/**
 * The preview page for a sandboxed iframe (sandbox="allow-scripts", no same-origin): the piece's own CSS,
 * markup and init, with the motion forced Full or Reduced. The parent replays it with
 * postMessage("mu-kit:replay"); play-once pieces replay themselves every `loopMs` in Full.
 */
export function previewDoc(p: KitPiece, opts: { reduced: boolean }): string {
  const stage =
    p.stage === "video"
      ? `html,body{margin:0;height:100%;background:#080808}body{display:grid;place-items:center;padding:12px;box-sizing:border-box;overflow:hidden}
#stage{position:relative;width:min(100%,calc((100vh - 24px)*16/9));aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:radial-gradient(120% 90% at 70% 20%,#3a3226 0%,#15130f 55%,#0b0a09 100%)}
#stage::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 45%,rgba(0,0,0,.55));}
#stage>*{position:absolute;left:6%;bottom:9%}`
      : `html,body{margin:0;height:100%;background:#080808}body{display:grid;place-items:center;padding:20px;box-sizing:border-box;overflow:hidden}#stage{display:grid;place-items:center;width:100%}`;
  const run = `
${MATCH_MEDIA_SHIM(opts.reduced)}
const HTML = ${scriptJson(p.html)};
${p.init ? `function init(root) {\n${p.init}\n}` : "function init() {}"}
const stage = document.getElementById("stage");
let stops = [];
function run() {
  for (const stop of stops) if (typeof stop === "function") stop();
  stage.innerHTML = HTML;
  stops = Array.from(stage.querySelectorAll("[data-mu-kit]"), (el) => init(el));
}
run();
window.addEventListener("message", (e) => { if (e.data === "mu-kit:replay") run(); });
${p.loopMs && !opts.reduced ? `setInterval(run, ${Math.max(2000, p.loopMs)});` : ""}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${FONTS}">
<style>${stage}</style>
<style>${forceMotion(p.css, opts.reduced)}</style>
</head><body><div id="stage"></div>
<script>${run}</script>
</body></html>`;
}
