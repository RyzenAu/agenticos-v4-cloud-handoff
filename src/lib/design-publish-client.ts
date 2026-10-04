// The Design studio's side of /__design_publish (scripts/design-publish.ts), as pure helpers so the flow is tested without a browser.
import type { Reply } from "./publish-flow";

export type PostedResult = { platform: string; ok: boolean; detail: string };

/** "Instagram: queued · TikTok: no account connected in Blotato", the way the studio always reported it. */
export function postedLines(json: { results?: PostedResult[] } | null | undefined): string {
  return (json?.results ?? []).map((x) => `${x.platform}: ${x.ok ? "queued" : x.detail}`).join(" · ");
}

/**
 * The hub's answer, made honest for the flow: a 200 where nothing was queued (every platform failed) is a failure, and the old
 * "render it first" and "no Blotato key" answers keep their studio wording. Applied to the direct answer (pc role) and to the run
 * after an approval alike. Pure.
 */
export function designReply(reply: Reply): Reply {
  const j = reply.json;
  if (reply.status === 200 && j && j.ok === false) return { status: 502, json: { ...j, error: postedLines(j) || j.error || "Nothing was posted." } };
  if (reply.status === 409 && j?.stage === "render") return { status: 409, json: { ...j, error: "This deck has no finished renders yet. Render it before publishing." } };
  return reply;
}

/** What the founder is about to post and where, for the card (the hub's own summary says the same in its words). */
export function designCardWords(deckName: string, slideCount: number | null, platforms: readonly string[]): { what: string; where: string } {
  const n = slideCount === null ? "" : ` (${slideCount} slide${slideCount === 1 ? "" : "s"})`;
  return { what: `The carousel "${deckName}"${n}`, where: platforms.length ? `${platforms.join(", ")} through Blotato` : "no platform selected" };
}
