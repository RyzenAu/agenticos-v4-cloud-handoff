/**
 * Readable titles for memory cards and lists (L8, 29 Sep 2026). DISPLAY ONLY: the stored title,
 * file name and id are never changed; callers keep the raw value in a `title` attribute.
 *
 * Notes and imports often carry an id as their title ("f97cf22b-c4e5-45c9-831c-…" or
 * "feedback_autonomous_when_asked"). The owner should read words:
 *   - a UUID (or a long hex id) falls back to the note's own name/title, first heading, or first words;
 *   - snake_case and lower-case kebab-case ids become spaced sentence case;
 *   - anything already written as words is left alone.
 */
import { fmtDay } from "./format";
import { previewSnippet } from "./memory-preview";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4,12}/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const FRONT_MATTER = /^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const EXTENSION = /\.(?:md|markdown|txt|json|jsonl|csv|pdf|docx?|html?|ya?ml)$/i;

export function isOpaqueId(raw: string): boolean {
  const t = raw.trim();
  return UUID.test(t) || LONG_HEX.test(t);
}

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** snake_case (any case) or all-lower kebab-case with no spaces -> "Spaced sentence case". */
function fromSlug(raw: string): string {
  const t = raw.trim().replace(EXTENSION, "");
  if (/\s/.test(t)) return raw.trim();
  const snake = t.includes("_");
  const kebab = t.includes("-") && t === t.toLowerCase();
  if (!snake && !kebab) return raw.trim();
  const words = t.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return sentenceCase(words);
}

function firstWords(s: string, max = 8): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const head = words.slice(0, max).join(" ");
  return words.length > max ? `${head}…` : head;
}

/** A readable title taken from the note body: front-matter name/title, first heading, first words. */
export function titleFromBody(text: string | null | undefined): string {
  const body = String(text ?? "");
  const fm = body.match(FRONT_MATTER);
  let rest = body;
  if (fm) {
    for (const key of ["title", "name", "description"]) {
      const m = fm[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, "im"));
      const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (v && !isOpaqueId(v)) return firstWords(fromSlug(v), 12);
    }
    rest = body.slice(fm[0].length);
  }
  const heading = rest.match(/^\s{0,3}#{1,6}[ \t]+(.+)$/m);
  if (heading?.[1].trim()) return firstWords(heading[1].trim(), 12);
  return firstWords(previewSnippet(rest, 120), 8);
}

/** The title to show on a card. `raw` is the stored title; `body` the note text, when known. */
export function humaniseMemoryTitle(raw: string | null | undefined, body?: string | null): string {
  const t = String(raw ?? "").trim();
  if (!t || isOpaqueId(t)) {
    const fromText = titleFromBody(body);
    return fromText || (t ? "Untitled note" : "Untitled");
  }
  return fromSlug(t);
}

/**
 * A file name, path or event target in a list ("wiki/notes/feedback_autonomous_when_asked.md"):
 * show the last segment as words. URLs and anything containing spaces are returned as they are.
 */
export function humaniseTarget(raw: string | null | undefined): string {
  const t = String(raw ?? "").trim();
  if (!t || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const last = t.split(/[\\/]/).filter(Boolean).pop() ?? t;
  return isOpaqueId(last.replace(EXTENSION, "")) ? t : fromSlug(last);
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|heic|heif|tiff?|bmp|gif)$/i;
const CAMERA_NAME = /^(?:img|dsc|pxl|mvimg|screenshot|image|photo)[_ -]?[\d_ -]+$/i;

/**
 * The caption for a photo tile (L10, 29 Sep 2026). A photo saved under an id or a camera name
 * ("f97cf22b-....png", "IMG_2041.jpg") reads "Photo · 29 Sept"; a name written as words is kept.
 * DISPLAY ONLY: callers keep the raw file name in a `title` attribute.
 */
export function photoCaption(raw: string | null | undefined, createdAt?: string | number | Date | null): string {
  const t = String(raw ?? "").trim();
  const stem = t.replace(IMAGE_EXTENSION, "");
  if (t && !isOpaqueId(stem) && !CAMERA_NAME.test(stem)) return t;
  const day = createdAt ? fmtDay(createdAt, { year: "auto" }) : "—";
  return day === "—" ? "Photo" : `Photo · ${day}`;
}
