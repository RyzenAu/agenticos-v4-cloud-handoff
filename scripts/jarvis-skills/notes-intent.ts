// The Jarvis notes phrase grammar, pure and browser-safe (no Node imports): the command entry's receptionist rule uses it
// too, so a note that mentions the receptionist stays a note. The file work is in notes.ts.
import { core } from "./text";

export type NotesRequest = { skill: "notes"; action: "add"; text: string } | { skill: "notes"; action: "read" };
const MAX_NOTE = 500;

export function notesIntent(utterance: string): NotesRequest | null {
  const c = core(utterance).replace(/\s+/g, " ").trim();
  if (c.length > 700) return null;
  const lower = c.toLowerCase().replace(/[.!?]+$/, "");
  if (/^(?:read|tell me|what are|what's in|what is in|show me)(?: me)? (?:my )?(?:(?:last|latest|recent) )?(?:(?:three|3|few) )?(?:jarvis )?notes(?: to me| back)?$|^what did i (?:last )?note(?: down)?$/.test(lower))
    return { skill: "notes", action: "read" };
  const m = c.match(/^(?:note(?:\s*:|,|\s+that\b|\s+to self[:,]?)|take (?:a )?note\b(?:\s+of)?(?:\s+that\b)?[:,]?|make (?:a )?note\b(?:\s+of)?(?:\s+that\b)?[:,]?|add (?:this |that )?to my notes[:,]?|jot (?:this |that |it )?down[:,]?|write (?:this |that |it )?down[:,]?|note (?:this |that |it )?down[:,]?)\s*(.+)$/i)
    ?? c.match(/^add\s+(.+?)\s+to my notes$/i);
  if (!m) return null;
  // "note down that the meeting moved" → the note is "the meeting moved".
  const text = m[1].replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "").replace(/^that\s+(?=\S)/i, "");
  if (!text || text.length < 2) return null;
  return { skill: "notes", action: "add", text: text.slice(0, MAX_NOTE) };
}
