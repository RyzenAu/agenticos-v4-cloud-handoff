// "Jarvis, make a top-tier dental site for Harbour Dental" (W-F, 29 Sep 2026): the words become the same
// site brief the Websites page's "Make a site" builds, and open Track 3's coding DRAFT with it. Nothing
// starts: the draft shows the plan, repo and agents and waits for "Start it". Typed (palette), typed Ask
// Jarvis and spoken all reach this through the coding command entry (./coding.ts), which asks here first.
// Pure.
import { buildSiteRequest, parseSiteAsk, PRESET_SKILLS, type SiteTarget } from "../site-maker";
import type { CommandEntry } from "./types";

/**
 * The site maker's coding request for spoken or typed words ("make a top-tier dental site for Harbour Dental"),
 * or null when the words aren't a site ask. Spoken or typed words carry no brief: the vertical and the name ARE
 * the brief. The same text the Websites page builds, so page, palette and Jarvis land on the same draft. Pure.
 */
export function siteRequestFromWords(text: string): string | null {
  const ask = parseSiteAsk(text);
  if (!ask) return null;
  // A name with no vertical we recognise ("a website for Jo's Cafe"): drafted as "another" business.
  const vertical = ask.vertical ?? "other";
  const target: SiteTarget = ask.name ? { kind: "named", name: ask.name } : { kind: "brief" };
  const built = buildSiteRequest({
    target,
    vertical,
    otherVertical: ask.otherVertical ?? undefined,
    brief: target.kind === "brief" ? "A site that makes local customers book" : "",
    skills: PRESET_SKILLS,
  });
  return built.ok ? built.request : null;
}

/** The registry entry for a "make a site" request, or null when the words aren't one. */
export function siteMakerCommandEntry(text: string): CommandEntry | null {
  const request = siteRequestFromWords(text);
  if (!request) return null;
  const repo = /\bin the ([a-z0-9-]+) repo\b/i.exec(request)?.[1] ?? "the flagship repo";
  return {
    id: "websites:make-site",
    kind: "page",
    title: "Draft a top-tier site",
    detail: "Coding draft in " + repo + " with the top-tier skills; nothing starts until you confirm.",
    phrases: [],
    action: { type: "navigate", to: "/coding", search: { request } },
    destination: "work",
    source: "static",
  };
}
