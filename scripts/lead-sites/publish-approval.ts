// Publishing a lead preview to the public web, or taking one down, through the B2 approval service
// (scripts/approvals). Used only under MU_HUB_ROLE=server, where a founder asks from his own browser and nobody sits at
// the hub; in the pc and cloud roles the owner at this PC still deploys directly from his own click.
//
// It follows the pattern B2 already uses for "release a quarantined job" (scripts/jobs/routes.ts):
//
//   1. ASK     POST /deploy {lead, by, confirm}     -> 202 { approval }   (nothing runs; one live record per exact action)
//   2. DECIDE  /__approvals/<id>/card + /decide     per B2's rules (a human requester confirms on the card in a verified
//                                                   session; a program's request needs the spoken yes or the Telegram code)
//   3. RUN     POST /deploy {lead, approvalId}      consume (atomic, once, bound to the LIVE site's digest) -> deploy ->
//                                                   record the outcome. A second call, or a restart, never replays it.
//
// Nothing here decides who may approve: that is B2 (policy.allowedEvidence, ApprovalService.decide). The generic ask / run-once
// steps live in scripts/approvals/gated-action.ts (shared with scripts/design-publish.ts); this file is what a lead preview
// contributes: its digest, its summary and its resource key.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalService } from "../approvals/service";
import type { Principal } from "../approvals/principal";
import { askGated, boundResource, runGated, Unbindable, type GatedNotify } from "../approvals/gated-action";
import type { PreviewRecord } from "./registry";

export type PublishMode = "deploy" | "takedown";
/** The B2 actions (scripts/approvals/policy.ts). takedown is `content.unpublish`, registered next to `content.publish`. */
export const PUBLISH_ACTION: Record<PublishMode, string> = { deploy: "content.publish", takedown: "content.unpublish" };

export type PublishNotify = GatedNotify;
export type PublishReply = { status: number; body: Record<string, unknown> };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * What the approval is bound to, derived from the LIVE preview: its identity and a hash of the page that would go
 * out (deploy) or of what is live (takedown). Regenerating the preview, or a state change, changes this, so a stale
 * approval is voided at the moment it would run (ApprovalService.consume: digest-mismatch).
 */
/** A preview folder bigger than this is not bound (and so not publishable remotely): previews are small static exports. */
export const MAX_BOUND_FILES = 20_000;
export const MAX_BOUND_BYTES = 512 * 1024 * 1024;

/**
 * A digest of the WHOLE preview folder, every file the preview server could serve and the deploy would stage: each
 * file's relative path (sorted, forward slashes), size and sha256, dotfiles included, nothing skipped. A symlink is
 * recorded as a link and its target text, never followed. Any added, removed, renamed or changed file changes it.
 * Throws past the limits, so an oversized folder can't be approved by a digest of part of it.
 */
export function folderDigest(dir: string): string {
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, path);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) lines.push(`${path}	link	${readlinkSync(full)}`);
      else if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        if (++files > MAX_BOUND_FILES || (bytes += st.size) > MAX_BOUND_BYTES) throw new Error("The preview folder is too large to approve as one piece.");
        lines.push(`${path}	${st.size}	${sha(readFileSync(full).toString("latin1"))}`);
      } else lines.push(`${path}	other`);
    }
  };
  walk("");
  return sha(lines.join(String.fromCharCode(10)));
}

export function publishArgs(mode: PublishMode, record: PreviewRecord) {
  let page = "";
  if (mode === "deploy") {
    try {
      page = folderDigest(record.dir);
    } catch (error) {
      // Never approve against a constant: a change after approval would leave the approval valid. Refuse instead.
      throw new Unbindable(`This preview can't be approved for publishing: its folder can't be checked as one piece (${error instanceof Error ? error.message : "unreadable"}).`);
    }
  }
  const siteRef = sha([mode, record.leadId, record.slug, record.domain, record.project, record.generatedAt, mode === "deploy" ? page : record.deployedAt ?? "", record.status].join("|"));
  return { mode, leadId: record.leadId, siteRef };
}

export function publishSummary(mode: PublishMode, record: PreviewRecord, by: string): string {
  return mode === "deploy"
    ? `Publish ${record.business}'s preview to the public web at https://${record.domain} (hidden from search, lasts 30 days). Asked by ${by}.`
    : `Take ${record.business}'s preview down from the public web: https://${record.domain} will stop working. Asked by ${by}.`;
}

export { requesterBinding } from "../approvals/gated-action";
const resourceOf = (mode: PublishMode, leadId: number) => `lead-sites:${mode}:${leadId}`;
/** The scope.resource a lead publish approval is stored under (the key plus who asked). */
export const publishResource = (mode: PublishMode, leadId: number, p: Principal) => boundResource(resourceOf(mode, leadId), p);

/** Step 1: ask. Nothing is published. A repeat of the same exact request returns the same live approval. */
export async function askToPublish(
  approvals: ApprovalService,
  notify: PublishNotify,
  input: { mode: PublishMode; record: PreviewRecord; requester: Principal; confirm: string },
): Promise<PublishReply> {
  const { mode, record, requester } = input;
  // The typed domain is still the founder's "I mean this one" (as in the drawer's confirm dialog).
  if (mode === "deploy" && input.confirm.trim().toLowerCase() !== record.domain)
    return { status: 400, body: { error: `Confirm by passing the exact domain: ${record.domain}` } };
  if (mode === "takedown" && record.status !== "live") return { status: 409, body: { error: "That preview isn't live, so there is nothing to take down." } };
  return askGated(approvals, notify, {
    action: PUBLISH_ACTION[mode],
    args: () => publishArgs(mode, record),
    // Bound to the asking browser session by askGated (requesterBinding).
    resource: resourceOf(mode, record.leadId),
    summary: publishSummary(mode, record, requester.personId),
    requester,
    next: (id) => `Approve it (the approval card in your session, or the owner's spoken yes / Telegram code), then POST { lead, approvalId: "${id}" } to run it once.`,
  });
}

/** Step 3: run an approved request exactly once. `run` is only called after the approval was consumed. */
export async function runApprovedPublish(
  approvals: ApprovalService,
  input: { mode: PublishMode; record: PreviewRecord; approvalId: unknown; caller: Principal },
  run: (by: string) => Promise<PreviewRecord>,
): Promise<PublishReply & { record?: PreviewRecord }> {
  const { mode, record, caller } = input;
  const r = await runGated(
    approvals,
    { action: PUBLISH_ACTION[mode], resource: resourceOf(mode, record.leadId), args: () => publishArgs(mode, record), approvalId: input.approvalId, caller, words: { noun: "preview" } },
    run,
  );
  return r.ok ? { status: 200, body: { preview: r.value, approvalId: r.approvalId, outcome: "succeeded" }, record: r.value } : { status: r.status, body: r.body };
}
