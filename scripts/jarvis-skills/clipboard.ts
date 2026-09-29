// Clipboard: "read my clipboard" speaks up to 300 characters, but never anything that looks like a
// password, key, token or card number; "copy that" puts Jarvis's last spoken answer on it.
import { looksSecret, norm, sir } from "./text";
import { psText, unb64, type PsHost } from "./ps-host";

export type ClipboardRequest = { skill: "clipboard"; action: "read" } | { skill: "clipboard"; action: "copy"; text: string };
export const CLIPBOARD_SPOKEN_MAX = 300;

/** `lastAnswer` is Jarvis's previous spoken line (from the conversation), for "copy that". */
export function clipboardIntent(utterance: string, lastAnswer = ""): ClipboardRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is");
  if (u.length > 60) return null;
  if (/^(?:read|tell me|what is (?:on|in)|what's (?:on|in)|say|check)(?: me| out)? (?:my|the) clipboard(?: to me| out| out loud| aloud)?$|^what have i (?:got )?copied$|^what did i (?:just )?copy$|^read (?:me )?what i (?:just )?copied$/.test(u))
    return { skill: "clipboard", action: "read" };
  if (/^(?:copy (?:that|this|it|what you (?:just )?said|your (?:last )?(?:answer|reply|response))(?: (?:to|onto) (?:my|the) clipboard)?|put (?:that|it) (?:on|in) (?:my|the) clipboard)$/.test(u))
    return { skill: "clipboard", action: "copy", text: lastAnswer.trim().slice(0, 4000) };
  // "copy M&U Ventures to my clipboard", "put 'see you at 3' on the clipboard": his words, as said.
  const m = utterance.trim().replace(/[.!?]+$/, "").match(/^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:copy|put) ["“']?(.+?)["”']? (?:to|on|onto|in|into) (?:my|the) clipboard$/i);
  if (m && !/^(?:that|this|it|what you (?:just )?said)$/i.test(m[1].trim())) return { skill: "clipboard", action: "copy", text: m[1].trim().slice(0, 4000) };
  return null;
}

/** What Jarvis may say about clipboard text: the text (trimmed), or a refusal. Pure. */
export function spokenClipboard(text: string | null) {
  if (text === null) return "There's no text on your clipboard, sir. It may be an image or a file.";
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Your clipboard is empty, sir.";
  if (looksSecret(text)) return "Your clipboard holds something that looks like a password or key, sir, so I won't read it aloud.";
  if (t.length <= CLIPBOARD_SPOKEN_MAX) return `Your clipboard says: ${t}`;
  const cut = t.slice(0, CLIPBOARD_SPOKEN_MAX).replace(/\s+\S*$/, "");
  return `Your clipboard has ${t.length.toLocaleString("en-AU")} characters. It starts: ${cut}…`;
}

export async function readClipboard(ps: PsHost): Promise<string | null> {
  const out = (
    await ps.run(
      "if ([Windows.Forms.Clipboard]::ContainsText()) { $t = [Windows.Forms.Clipboard]::GetText(); if ($t.Length -gt 8000) { $t = $t.Substring(0, 8000) }; 'T' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) } else { 'NOTEXT' }",
    )
  ).trim();
  if (out.startsWith("ERROR")) throw new Error("I couldn't open the clipboard just now.");
  return out === "NOTEXT" ? null : unb64(out.slice(1));
}

export async function writeClipboard(ps: PsHost, text: string) {
  const out = (await ps.run(`[Windows.Forms.Clipboard]::SetText(${psText(text)}); 'OK'`)).trim();
  if (out !== "OK") throw new Error("I couldn't reach the clipboard just now.");
}

export async function answerClipboard(req: ClipboardRequest, ps: PsHost) {
  if (req.action === "read") {
    try {
      return spokenClipboard(await readClipboard(ps));
    } catch (error) {
      return sir((error as Error).message);
    }
  }
  const text = req.text.trim();
  if (!text) return "I haven't said anything worth copying yet, sir.";
  if (looksSecret(text)) return "That looks like a password or key, sir, so I'd rather not put it on the clipboard.";
  try {
    await writeClipboard(ps, text);
    return "Copied to your clipboard, sir.";
  } catch (error) {
    return sir((error as Error).message);
  }
}

