/** Private text is for a confirmed person. A pending browser, a bare tailnet login, a script or a companion can still see that records exist
 * (names, stages, dates), but not document bodies, drafted-reply text, attachment names or contact preference notes. This only ever removes text. */
export const CONFIRM_NOTE = "Confirm this browser to read private text.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Free-text fields that are private for an unconfirmed caller, by name. Search must not match them either. */
export const PRIVATE_TEXT_FIELDS = [
  "notes",
  "preferences",
  "scope",
  "nextAction",
  "description",
  "closeReason",
  "excludedReason",
  "restrictions",
] as const;

/** Replaces each entry of a private list with a placeholder so the count (waiting or not) stays visible but the text does not. */
const maskList = (list: Json[]): Json[] => list.map(() => "Private");

/** A copy of `value` with private text blanked, plus a `privateTextWithheld` note on the top-level object. */
export function withholdPrivate<T>(value: T): T {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(node)) out[key] = walk(child);
    // A document: version bodies are private.
    if (Array.isArray(out.versions) && typeof out.title === "string" && "currentVersion" in out) {
      out.versions = (out.versions as Json[]).map((v) => {
        if (!isObject(v)) return v;
        return { ...v, content: "", contentDeferred: true };
      });
    }
    // Every activity and correspondence note (drafted replies included) is private.
    if ("eventId" in out && typeof out.note === "string") out.note = "";
    // Company notes.
    if ("mergedInto" in out && typeof out.notes === "string") out.notes = "";
    // A company's exclusion reason.
    if ("mergedInto" in out && typeof out.excludedReason === "string") out.excludedReason = "";
    // A deal's scope and next action.
    if ("stageHistory" in out) {
      if (typeof out.scope === "string") out.scope = "";
      if (typeof out.nextAction === "string") out.nextAction = "";
      // The won/lost reason, and the reason given at every stage change.
      if (typeof out.closeReason === "string") out.closeReason = "";
      if (Array.isArray(out.stageHistory))
        out.stageHistory = (out.stageHistory as Json[]).map((h) =>
          isObject(h) && typeof h.reason === "string" ? { ...h, reason: "" } : h,
        );
    }
    // A project's scope and milestone notes.
    if (Array.isArray(out.milestones) && "contentRequests" in out) {
      if (typeof out.scope === "string") out.scope = "";
      out.milestones = (out.milestones as Json[]).map((m) =>
        isObject(m) && typeof m.note === "string" ? { ...m, note: "" } : m,
      );
    }
    // A task's description.
    if ("completedAt" in out && "dueAt" in out && typeof out.description === "string")
      out.description = "";
    // A task's dependencies and evidence: what it waits on and where the proof lives.
    if ("completedAt" in out && "dueAt" in out) {
      if (Array.isArray(out.dependsOn)) out.dependsOn = maskList(out.dependsOn);
      if (Array.isArray(out.evidence)) out.evidence = maskList(out.evidence);
    }
    // A contact's restrictions.
    if (Array.isArray(out.restrictions) && "companyId" in out && "email" in out)
      out.restrictions = maskList(out.restrictions);
    // An attachment: even its name says who the client is.
    if (typeof out.sha256 === "string" && typeof out.documentId === "string") {
      out.name = "Private file";
    }
    // A contact's preference notes.
    if (
      typeof out.preferences === "string" &&
      out.preferences &&
      "companyId" in out &&
      "email" in out
    ) {
      out.preferences = "";
    }
    return out;
  };
  const copy = walk(value as unknown as Json);
  if (isObject(copy)) copy.privateTextWithheld = CONFIRM_NOTE;
  return copy as unknown as T;
}
