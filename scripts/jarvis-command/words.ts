/**
 * Which spoken requests go to the ONE command entry (Track 2), so a spoken command takes exactly the
 * path the same words take when typed: POST /screen/command → the command service → Jev → the
 * requester's own device → a Job. Deterministic, no model: the free-voice engine asks this before its
 * older direct rules (pc_act / browser_act / screen_act), so "open Notepad" spoken or typed is ONE
 * job with a device and a check, not two different code paths.
 *
 * Not claimed here (they keep their own rules, which the command entry would only hand back to):
 * lessons, pointing, meeting mode, narration, away mode, memory (handled by the memory rules first),
 * status/protocols, window placement, screen questions and media keys.
 */
import { parseDeckRequest } from "../jev-powerpoint";
import { fileNameIn } from "../jev-files";
import { parseMarginQuery } from "../jev-margin";
import { youtubeSteps } from "../jev-command";
import { referenceIn } from "./context";
import { planContinuation } from "./continuation";
import { planRules, splitSpokenTarget } from "./plan";
import { parsePriceQuery } from "./answers";
import { codingDraftFor } from "./coding";

const YOUTUBE = /\byou\s?tube\b/i;

export type CommandIntent = { utterance: string; spokenTarget?: string; why: string };

/** His words → a jarvis_command call, or null. Pure. */
export function commandIntent(utterance: string, options: { sharing?: boolean } = {}): CommandIntent | null {
  const raw = String(utterance ?? "").trim();
  if (!raw || raw.length > 600) return null;
  const split = splitSpokenTarget(raw);
  const u = split.utterance || raw;
  const out = (why: string): CommandIntent => ({ utterance: raw, ...(split.spokenTarget ? { spokenTarget: split.spokenTarget } : {}), why });
  // A machine named out loud ("on my laptop", "on Mehroz's PC"): device routing is the entry's job.
  if (split.spokenTarget && split.spokenTarget !== "this pc") return out("a device was named");
  // Coding work is Track 3's: when its detector is loaded, the entry opens its draft page (same as typed).
  if (codingDraftFor(u)) return out("coding: Track 3's coding workspace");
  if (planContinuation(u)) return out("verified setup followed by screen work");
  const rule = planRules(u);
  if (rule?.lane === "executor") return out(`executor ${rule.executor}`);
  // "type 'hi' then email it": the entry says which step it won't do (never half-done and called done).
  if (rule?.lane === "unsupported") return out("a step no executor runs in the same command");
  // Memory and "remember to …" reminders keep their own voice rules (the same services the typed path delegates to).
  if (rule?.lane === "delegate" && rule.to !== "memory" && rule.to !== "reminder") return out(`delegate ${rule.to}`);
  // OS pages stay with the Jev router's navigate (the same page either way; typed ones resolve in Track 1's registry).
  if (parseMarginQuery(u)) return out("a margin question (deterministic numbers)");
  if (parsePriceQuery(u)) return out("a price question (the package catalogue)");
  const deck = parseDeckRequest(u);
  if (deck?.ops.length || deck?.ask) return out("a PowerPoint deck by name");
  const file = fileNameIn(u);
  if (file && !/^about\b/i.test(file) && !YOUTUBE.test(u)) return out("a document by name");
  // YouTube work (search, a result, play/pause, "what matters") runs in the app-owned browser. A bare
  // "open YouTube" stays a website open (Track 1's registry resolves it the same way when typed).
  if (YOUTUBE.test(u) && youtubeSteps(u).some((s) => s.do !== "open")) return out("YouTube in the app-owned browser");
  // "Watch this video and tell me what matters": the transcript watcher in the app-owned browser (it says
  // plainly when no video is open there). While he's sharing his screen, "this video" is on his screen: vision.
  if (!options.sharing && /\b(?:watch|summari[sz]e|what matters|key points|main points)\b/i.test(u) && /\b(?:this|the|that) video\b/i.test(u)) return out("a video: the transcript watcher");
  // "Explain this margin", "open that call": the page he's looking at (not while he's sharing his screen,
  // when "this" means the screen and the vision route answers).
  if (!options.sharing && referenceIn(u)) return out("a reference to the page in front of him");
  return null;
}
