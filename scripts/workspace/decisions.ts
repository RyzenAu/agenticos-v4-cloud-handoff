// Business decisions are saved locally. Recording one never executes or grants an action.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sydneyDay, validateApprovals, type Approval } from "./approvals";
import { dataDirFor } from "../cloud/data-dir";

export type DecisionAnswer = "approved" | "declined" | "completed";
export type DecisionRecord = { item: Approval; revision: string; answer: DecisionAnswer; note: string; at: string; by: string };
export const decisionPath = (root: string) => join(dataDirFor(root), "workspace-decisions.json");
export function decisionRevision(item: Approval): string {
  return createHash("sha256").update(JSON.stringify([item.id, item.title, item.detail, item.href, item.since, item.source])).digest("hex");
}
export function readDecisions(file: string): DecisionRecord[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.some((r: DecisionRecord) => !r?.item?.id || r.revision !== decisionRevision(r.item) || !["approved", "declined", "completed"].includes(r.answer) || typeof r.note !== "string" || !Number.isFinite(Date.parse(r.at)))) throw new Error("Saved decisions couldn't be read. Restore the local decisions file, then retry.");
  return raw.items;
}
export function applyDecisions(items: Approval[], records: DecisionRecord[]) {
  return items.filter(item => !records.some(r => r.item.id === item.id && r.revision === decisionRevision(item)));
}
export function saveDecision(root: string, body: unknown, by: string, now = Date.now()): { records: DecisionRecord[] } {
  const input = body as { id?: unknown; revision?: unknown; answer?: unknown; note?: unknown } | null;
  if (!input || typeof input.id !== "string" || typeof input.revision !== "string") throw new Error("Choose a decision and refresh its details first.");
  const file = join(root, "scripts", "workspace", "approvals.json");
  const parsed = validateApprovals(JSON.parse(readFileSync(file, "utf8")), now);
  const path = decisionPath(root);
  const records = readDecisions(path);
  if (input.answer === "reopen") {
    const record = records.find(r => r.item.id === input.id && r.revision === input.revision);
    if (!record) throw new Error("That decision changed. Refresh before reopening it.");
    records.splice(records.indexOf(record), 1);
  } else {
    if (!["approved", "declined", "completed"].includes(String(input.answer))) throw new Error("Choose approve, decline or complete.");
    const item = parsed.items.find(r => r.id === input.id);
    if (!item || decisionRevision(item) !== input.revision) throw new Error("That item changed or is no longer pending. Refresh before saving.");
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (note.length > 200) throw new Error("Keep the decision note to 200 characters.");
    // Keep contact details out of the metadata stream, matching approvals.json's contract.
    if (note && validateApprovals({ version: 1, items: [{ ...item, since: item.since ?? sydneyDay(now), status: "decided", decision: note, decidedOn: sydneyDay(now) }] }, now).errors.length) throw new Error("Keep contact details out of this note; use the lead or inbox instead.");
    const record: DecisionRecord = { item, revision: input.revision, answer: input.answer as DecisionAnswer, note, at: new Date(now).toISOString(), by };
    const existing = records.findIndex(r => r.item.id === item.id);
    if (existing >= 0) records[existing] = record; else records.push(record);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, items: records }, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  return { records };
}
