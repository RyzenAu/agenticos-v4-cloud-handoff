/**
 * The one-to-two-line preview on a memory card (display only: the stored text is never changed).
 * Saved notes and imports often begin with YAML front-matter ("---\nname: …\n---") or markdown
 * markers, and probes leave "User: …" transcript lines; a card should show the words, not the markup.
 */
const FRONT_MATTER = /^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function fromFrontMatter(block: string): string {
  // With no body, the note's own description (or name) is the best short preview.
  for (const key of ["description", "summary", "title", "name"]) {
    const m = block.match(new RegExp(`^${key}:[ \t]*(.+)$`, "im"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/** Title and heading compared by their words only: case, emphasis marks, spacing and end punctuation are ignored. */
function sameWords(a: string, b: string): boolean {
  const words = (v: string) =>
    v
      .replace(/(\*\*|__|[*_`])/g, "")
      .replace(/\s+/g, " ")
      .replace(/[\s.:;,!?\-–—]+$/, "")
      .trim()
      .toLowerCase();
  const x = words(a);
  return x !== "" && x === words(b);
}

/**
 * When the note's body opens with a markdown heading that repeats its title, the card (which already
 * shows the title above the preview) would say it twice ("Finance summary" then "Finance summary
 * Revenue is up…"). The duplicate heading is dropped from the preview only, and only when more text
 * follows it; the stored note is never touched.
 */
function withoutTitleHeading(body: string, title: string | null | undefined): string {
  if (!title || !title.trim()) return body;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return body;
  const heading = lines[first].match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
  if (!heading || !sameWords(heading[1], title)) return body;
  const rest = lines.slice(first + 1).join("\n");
  return rest.trim() ? rest : body;
}

export function previewSnippet(text: string | null | undefined, max = 240, title?: string | null): string {
  let body = String(text ?? "");
  const fm = body.match(FRONT_MATTER);
  if (fm) {
    const rest = body.slice(fm[0].length);
    body = rest.trim() ? withoutTitleHeading(rest, title) : fromFrontMatter(fm[1]);
  } else body = withoutTitleHeading(body, title);
  body = body
    .replace(/\r\n?/g, "\n")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^\s{0,3}>[ \t]?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:user|assistant|human)[ \t]*:[ \t]*/i, "");
  return body.length > max ? `${body.slice(0, max).trimEnd()}…` : body;
}
