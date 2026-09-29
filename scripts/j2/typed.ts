// J6: the typed command entry's browser commands are the SAME hands as spoken ones (AUDIT-JARVIS: typed "youtube lo-fi beats" went to
// the old app-owned Playwright executor, spoken went to Jarvis Chrome). One request, the same skill, the same line that says where it
// ended up. A step on the page in front (back, scroll, click, "open the first result"…) uses Jarvis Chrome only while it is
// frontmost; otherwise it goes to the real screen hands, as the spoken route does.
import { browserSkillIntent, PAGE_ACTIONS, type BrowserSkillRequest } from "./intents";

/** The same browser-versus-real-screen choice voice makes for a current-page command. */
export async function typedBrowserTarget(utterance: string, jarvisChromeInFront?: () => Promise<boolean>): Promise<{ kind: "browser"; request: BrowserSkillRequest } | { kind: "screen"; goal: string } | null> {
  const req = browserSkillIntent(utterance);
  if (!req) return null;
  if (PAGE_ACTIONS.has(req.action) && !(await jarvisChromeInFront?.().catch(() => false))) return { kind: "screen", goal: utterance.trim() };
  return { kind: "browser", request: req };
}

export async function typedBrowserRequest(utterance: string, jarvisChromeInFront?: () => Promise<boolean>): Promise<BrowserSkillRequest | null> {
  const target = await typedBrowserTarget(utterance, jarvisChromeInFront);
  return target?.kind === "browser" ? target.request : null;
}
