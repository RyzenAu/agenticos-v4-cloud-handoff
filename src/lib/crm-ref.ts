/** Stable record references shared by CRM, Jarvis and the Agents workspace. */
export const CRM_KINDS = ["company", "contact", "deal", "project", "document", "lead"] as const;
export type CrmKind = (typeof CRM_KINDS)[number];
export type CrmRef = { kind: CrmKind; id: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export function isCrmRef(value: unknown): value is CrmRef {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    CRM_KINDS.includes(r.kind as CrmKind) &&
    typeof r.id === "string" &&
    r.id.trim() === r.id &&
    ID.test(r.id)
  );
}
export function crmRefString(ref: CrmRef): string {
  if (!isCrmRef(ref)) throw new Error("Invalid CRM record reference.");
  return `crm:${ref.kind}:${ref.id}`;
}
export function parseCrmRef(value: string): CrmRef | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "crm") return null;
  const ref = { kind: parts[1], id: parts[2] };
  return isCrmRef(ref) ? ref : null;
}
/** A missing mapping preserves the old lead link; never guesses a company from its name. */
export function resolveLegacyLead(
  id: string | number,
  lookup?: (id: string) => CrmRef | null,
): CrmRef {
  const ref: CrmRef = { kind: "lead", id: String(id) };
  crmRefString(ref);
  const mapped = lookup?.(ref.id);
  return mapped && isCrmRef(mapped) ? mapped : ref;
}
export type CrmContext = { crm?: CrmRef | null; candidates?: readonly CrmRef[] };
export type CrmTargetResult =
  | { ok: true; ref: CrmRef; how: "explicit" | "active-record" | "only-candidate" }
  | { ok: false; ask: string; candidates: CrmRef[] };
/** Resolve an explicit record or a genuinely unambiguous active context. No fuzzy name matching. */
export function resolveCrmContext(input: {
  ref?: CrmRef | string | null;
  context?: CrmContext;
  kinds?: readonly CrmKind[];
}): CrmTargetResult {
  const allowed = (r: CrmRef) => !input.kinds || input.kinds.includes(r.kind);
  if (input.ref != null) {
    const ref = typeof input.ref === "string" ? parseCrmRef(input.ref) : input.ref;
    return ref && isCrmRef(ref) && allowed(ref)
      ? { ok: true, ref, how: "explicit" }
      : { ok: false, ask: "Choose a valid CRM record of the required type.", candidates: [] };
  }
  const active = input.context?.crm;
  if (active && isCrmRef(active) && allowed(active))
    return { ok: true, ref: active, how: "active-record" };
  const unique = new Map<string, CrmRef>();
  for (const ref of input.context?.candidates ?? [])
    if (isCrmRef(ref) && allowed(ref)) unique.set(crmRefString(ref), ref);
  const candidates = [...unique.values()];
  return candidates.length === 1
    ? { ok: true, ref: candidates[0], how: "only-candidate" }
    : {
        ok: false,
        ask: candidates.length
          ? "Which CRM record do you mean?"
          : "Open or name the CRM record first.",
        candidates,
      };
}
