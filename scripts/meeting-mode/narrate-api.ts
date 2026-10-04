// /skill-drafts — the review list for narrated-workflow drafts (scripts/meeting-mode/narrate.ts,
// narrate-store.ts). Thin glue only: every write goes through narrate-store.ts's own validation;
// this file just turns HTTP into those calls. Nothing here starts a narration or writes a skill on
// its own — approve is the one explicit action that does, and only for the draft named.
//
//   GET    /skill-drafts                → { drafts: SkillDraft[] }
//   POST   /skill-drafts/:id/approve    → installs the SKILL.md, marks the draft approved
//   POST   /skill-drafts/:id/edit       { title?, summary?, steps?, tools? } → the edited draft
//   POST   /skill-drafts/:id/discard    → marks the draft discarded (kept, not built)
//   DELETE /skill-drafts/:id            → removes the draft file and its transcript entirely
import { homedir } from "node:os";
import { join } from "node:path";
import { approveDraft, discardDraft, editDraft, deleteDraft, listDrafts, type ApproveTargets } from "./narrate-store";
import { dataDirFor } from "../cloud/data-dir";

type RouteInput = {
  root: string;
  path: string;
  method: string;
  body: any;
  remote: { name: string; role?: string } | null;
  send: (value: unknown, status?: number) => void;
};

/** Where an approved draft is installed. Overridable for tests; on a real machine this matches
 *  where the jev-audit skill and every other hand-installed skill already live. */
export function defaultApproveTargets(): ApproveTargets {
  return { claudeSkillsDir: join(homedir(), ".claude", "skills"), hermesSkillsDir: join(homedir(), "AppData", "Local", "hermes", "skills") };
}

export async function skillDraftsRoute(
  { root, path, method, body, remote, send }: RouteInput,
  targets: ApproveTargets = defaultApproveTargets(),
): Promise<boolean> {
  if (path !== "/skill-drafts" && !path.startsWith("/skill-drafts/")) return false;
  // Drafts can hold a real transcript of what he or Mehroz said; a remote (Tailscale) viewer
  // doesn't get to read, edit, approve or delete them — same posture as finance/ai_usage skills.
  if (remote) return send({ error: "Skill drafts are only available at the PC itself." }, 403), true;
  const operatorData = join(dataDirFor(root));
  const parts = path.split("/").filter(Boolean); // ["skill-drafts"] or ["skill-drafts", id, action]
  try {
    if (method === "GET" && parts.length === 1) return send({ drafts: listDrafts(operatorData) }), true;
    const id = parts[1];
    if (!id) return send({ error: "Missing draft id." }, 400), true;
    if (method === "DELETE" && parts.length === 2) return deleteDraft(operatorData, id), send({ ok: true }), true;
    if (method !== "POST" || parts.length !== 3) return send({ error: "Unknown skill-drafts route." }, 404), true;
    const action = parts[2];
    if (action === "approve") return send({ draft: approveDraft(operatorData, id, targets) }), true;
    if (action === "discard") return send({ draft: discardDraft(operatorData, id) }), true;
    if (action === "edit") return send({ draft: editDraft(operatorData, id, body ?? {}) }), true;
    return send({ error: "Unknown skill-drafts route." }, 404), true;
  } catch (error) {
    send({ error: (error as Error).message }, 400);
    return true;
  }
}
