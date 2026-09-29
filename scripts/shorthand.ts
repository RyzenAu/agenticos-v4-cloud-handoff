import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * His shorthand ("yt" = YouTube), shared by every entry point so Jarvis reads him the same
 * way by voice, in chat and on Telegram. Defaults below; his own additions live in
 * `.operator-data/shorthand.json` as { "terms": { "yt": "YouTube", ... } } and win.
 */
export const DEFAULT_SHORTHAND: Record<string, string> = {
  yt: "YouTube",
  ig: "Instagram",
  insta: "Instagram",
  fb: "Facebook",
  li: "LinkedIn",
  gh: "GitHub",
  tw: "X (Twitter)",
  twitter: "X (Twitter)",
  gmail: "Gmail",
  gcal: "Google Calendar",
  gdrive: "Google Drive",
  gdocs: "Google Docs",
  gsheets: "Google Sheets",
  nlm: "NotebookLM",
  gpt: "ChatGPT",
  obs: "Obsidian",
  tg: "Telegram",
  wa: "WhatsApp",
  mu: "M&U Ventures",
  "m&u": "M&U Ventures",
  vsc: "VS Code",
  vscode: "VS Code",
};

export function readShorthand(root: string): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(join(root, ".operator-data", "shorthand.json"), "utf8"));
    const own = data && typeof data.terms === "object" ? data.terms : {};
    const clean: Record<string, string> = {};
    for (const [term, meaning] of Object.entries(own))
      if (typeof meaning === "string" && term.trim() && meaning.trim()) clean[term.trim().toLowerCase()] = meaning.trim();
    return { ...DEFAULT_SHORTHAND, ...clean };
  } catch {
    return { ...DEFAULT_SHORTHAND };
  }
}

/** Terms from the map that appear as whole words in what he said, e.g. ["yt = YouTube"]. */
export function shorthandIn(text: string, map: Record<string, string>) {
  const found: string[] = [];
  for (const [term, meaning] of Object.entries(map)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w&])${escaped}(?=$|[^\\w&])`, "i").test(text)) found.push(`${term} = ${meaning}`);
  }
  return found;
}
