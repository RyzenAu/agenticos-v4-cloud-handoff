// The spoken side of registry-first routing (AUDIT-F4 F2/F3/F9, Track 1): scripts/free-voice.ts asks this
// before its window, screen, PC and Jev lanes, so "open finance" or "show the Professional margin" land
// exactly where the typed box and the Ctrl+K palette send them (src/lib/commands/jarvis-route.ts, the same
// resolver). It never claims an app or folder the PC rules know ("open Notepad", "open settings" = the
// Windows app), never a device action, and never a money or confirmation turn (those lanes run before it).
import { routeHref, routeJarvisText, type JarvisRoute } from "../../src/lib/commands/jarvis-route";
import { DESTINATIONS } from "../../src/components/shell/destinations";
import { pcIntent, type StartApp } from "../pc-hands";
import { hasTrack2RuleAnswers, setRuleAnswerIntent } from "../../src/lib/commands/rule-guard";

export type VoiceRoute =
  | { tool: { name: "navigate"; args: { path: string; focus?: string } }; content: null; route: { intent: string; source: "registry" } }
  | { tool: { name: "open_url"; args: { url: string } }; content: null; route: { intent: string; source: "registry" } }
  | { tool: { name: "page_answer"; args: { query: string } }; content: null; route: { intent: string; source: "registry" } }
  | { tool: { name: "open_lead"; args: { name: string } }; content: null; route: { intent: string; source: "registry" } }
  | { tool: { name: "explain_page"; args: { text: string } }; content: null; route: { intent: string; source: "registry" } }
  | { tool?: undefined; content: string; route: { intent: string; source: "registry" } };

/**
 * Track 2's ruleAnswerIntent (src/lib/jarvis-intents.ts) when it is part of this build, loaded once at
 * runtime (like jev-target.ts loads resolveTarget); otherwise this branch's own matchers stay in place.
 * With it, margins and prices, lead actions and reminders are Track 2's rules on voice, not the registry's.
 */
let t2Loading: Promise<void> | null = null;
export function loadTrack2RuleAnswers(importer: (spec: string) => Promise<unknown> = (spec) => import(spec)): Promise<void> {
  t2Loading ??= importer(new URL("../../src/lib/jarvis-intents.ts", import.meta.url).href)
    .then((mod) => {
      const fn = (mod as { ruleAnswerIntent?: unknown } | null)?.ruleAnswerIntent;
      if (typeof fn === "function") setRuleAnswerIntent(fn as Parameters<typeof setRuleAnswerIntent>[0]);
    })
    .catch(() => undefined);
  return t2Loading;
}

export async function registryVoiceRoute(utterance: string, apps: () => StartApp[] = () => []): Promise<VoiceRoute | null> {
  if (!utterance.trim()) return null;
  await loadTrack2RuleAnswers();
  // The PC's own rules win for things they can open (apps and folders).
  const pc = pcIntent(utterance, apps());
  if (pc && (pc.action === "open_app" || pc.action === "open_folder")) return null;
  const r: JarvisRoute | null = routeJarvisText(utterance, { channel: "voice" });
  if (!r) return null;
  const route = (intent: string) => ({ intent, source: "registry" as const });
  switch (r.kind) {
    case "navigate":
      return { tool: { name: "navigate", args: { path: routeHref(r), ...(r.focus ? { focus: r.focus } : {}) } }, content: null, route: route(`registry.${r.entryId}`) };
    case "open-url":
      return { tool: { name: "open_url", args: { url: r.url } }, content: null, route: route(`registry.${r.entryId}`) };
    case "open-lead":
      return { tool: { name: "open_lead", args: { name: r.name } }, content: null, route: route("registry.open-lead") };
    case "page-answer":
      // The browser reads the page's own data and the result is spoken as-is (protocolFollowUp): no model.
      return { tool: { name: "page_answer", args: { query: r.query } }, content: null, route: route(`registry.${r.query}`) };
    case "answer":
      return { content: r.said, route: route(`registry.${r.entryId}`) };
    case "explain":
      // The page context lives in the browser: it answers from the figures on screen (explain_page), or,
      // with Track 2 in the build, its command entry does (it receives the page context with the request).
      if (hasTrack2RuleAnswers()) return null;
      return { tool: { name: "explain_page", args: { text: utterance.trim().slice(0, 200) } }, content: null, route: route("registry.explain") };
    case "ask":
      return { content: r.said, route: route(`registry.${r.kind}`) };
    default:
      return null;
  }
}

/**
 * The navigate tool's path hint (F3: the eight destinations, built from the shell's list, plus the most
 * asked-for drilldowns). Kept short: the whole brief must fit Groq's free tier (scripts/free-voice.test.ts).
 * Any OS page is accepted by the client (src/lib/voice-actions.ts voiceDestination); the registry route
 * above catches named pages before the brain in any case.
 */
export function navigatePathsHint(): string {
  const extra = ["/operations", "/leads", "/models", "/settings", "/inbox", "/calendar"];
  return [...new Set([...DESTINATIONS.map((d) => d.to), ...extra])].join(" ");
}
