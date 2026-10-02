// Founder edits only: no calls, messages, model requests or contact-permission grants.
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { findLead, isOptedOut, STATUSES, type Lead } from "./crm";
import { isVertical } from "./places";

const fields = ["name", "phone", "address", "website", "area", "emails", "vertical", "owner", "status", "nextAt"] as const;
export function leadEditVersion(lead: Lead): string {
  return createHash("sha256").update(JSON.stringify(fields.map(key => lead[key]))).digest("hex");
}
export function leadArtifactCurrent(db: Database, leadId: number, at: string, websiteOnly = false): boolean {
  const row = db.query(`SELECT MAX(at) AS at FROM activities WHERE lead_id = ? AND kind IN (${websiteOnly ? "'website_edit'" : "'website_edit','lead_edit'"})`).get(leadId) as { at: string | null };
  return !row.at || Date.parse(at) > Date.parse(row.at);
}
export function editLead(db: Database, id: number, body: unknown): Lead {
  const input = body as Record<string, unknown>;
  const current = findLead(db, id);
  if (!current) throw new Error("This lead no longer exists.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose the fields to change.");
  if (input.by !== "usman" && input.by !== "mehroz") throw new Error("by must be usman or mehroz.");
  if (input.version !== leadEditVersion(current)) throw new Error("This lead changed while you were editing. Reload it before saving.");
  if (Object.keys(input).some(k => !["lead", "version", "by", ...fields].includes(k as any))) throw new Error("That field can't be edited here.");
  const patch: Partial<Lead> = {};
  const text = (key: string, max: number) => {
    const value = input[key];
    if (typeof value !== "string" || value.length > max) throw new Error(`Check ${key}: use at most ${max} characters.`);
    return value.trim();
  };
  for (const key of ["name", "phone", "address", "website", "area"] as const) if (key in input) patch[key] = text(key, key === "phone" ? 50 : 400);
  if (patch.name !== undefined && !patch.name) throw new Error("Enter the business name.");
  if (patch.phone && !/^[+\d\s().-]{5,50}$/.test(patch.phone)) throw new Error("Enter a valid phone number, or leave it blank.");
  if (patch.website) {
    try { const url = new URL(patch.website); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { throw new Error("Enter a full http or https website address."); }
  }
  if ("emails" in input) {
    if (!Array.isArray(input.emails) || input.emails.length > 10 || input.emails.some(e => typeof e !== "string" || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error("Enter valid email addresses, one per line (up to 10).");
    patch.emails = [...new Set(input.emails.map(e => (e as string).trim().toLowerCase()))];
  }
  if ("owner" in input) { if (!["", "usman", "mehroz"].includes(String(input.owner))) throw new Error("Choose an owner."); patch.owner = input.owner as string; }
  if ("vertical" in input) { if (!isVertical(String(input.vertical))) throw new Error("Choose an industry."); patch.vertical = input.vertical as Lead["vertical"]; }
  if ("status" in input) { if (!STATUSES.includes(input.status as any)) throw new Error("Choose a valid status."); patch.status = input.status as Lead["status"]; }
  if (current.status === "do_not_contact" && patch.status && patch.status !== current.status) throw new Error("Contact details can be corrected, but this contact's opt-out stays in place.");
  if ("nextAt" in input) {
    if (input.nextAt !== null && (typeof input.nextAt !== "string" || !Number.isFinite(Date.parse(input.nextAt)))) throw new Error("Choose a valid follow-up date.");
    patch.nextAt = input.nextAt === null ? null : new Date(input.nextAt as string).toISOString();
  }
  const next = { ...current, ...patch };
  if (next.status === "call_back" && !next.nextAt) throw new Error("A call back needs a follow-up date.");
  const changed = fields.filter(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(current[k]));
  if (!changed.length) return current;
  const origins = { ...current.fieldSources };
  for (const key of changed) if (["name", "phone", "address", "website", "emails"].includes(key)) origins[key] = "manual";
  const websiteChanged = changed.includes("website");
  const optedOut = next.status === "do_not_contact" || next.emails.some(e => isOptedOut(db, e)) || !!next.phone && isOptedOut(db, next.phone);
  db.transaction(() => {
    // Only changed fields are written: live Places display values never get copied by a save.
    const columns: Record<string, string> = { nextAt: "next_at" };
    const values: (string | null)[] = [];
    const assignments = changed.map(k => { values.push(k === "emails" ? JSON.stringify(next[k]) : next[k] as string | null); return `${columns[k] ?? k} = ?`; });
    assignments.push("field_sources = ?"); values.push(JSON.stringify(origins));
    if (optedOut) { assignments.push("email_ok = 0", "status = 'do_not_contact'"); }
    if (changed.includes("phone")) assignments.push("phone_source = 'manual'", "phone_confidence = NULL", "phone_checked_at = NULL", "suggested_phone = ''");
    if (websiteChanged) assignments.push("website_source = 'manual'", "website_confidence = NULL", "website_checked_at = NULL", `website_check = '${patch.website ? "found" : "not-checked"}'`, "score = 0", "pitch = 'audit_pending'", "reasons = '[]'");
    db.query(`UPDATE leads SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    if (optedOut) for (const value of [...next.emails, next.phone].filter(Boolean)) db.query("INSERT OR IGNORE INTO optouts (value) VALUES (?)").run(value.includes("@") ? value.toLowerCase() : value.replace(/\D/g, ""));
    db.query("INSERT INTO activities (lead_id, at, kind, outcome, note, by) VALUES (?, ?, ?, '', ?, ?)").run(id, new Date().toISOString(), websiteChanged ? "website_edit" : "lead_edit", `Updated ${changed.join(", ")}.`, input.by as string);
  })();
  return findLead(db, id)!;
}
