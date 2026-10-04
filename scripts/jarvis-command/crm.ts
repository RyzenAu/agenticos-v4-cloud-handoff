/**
 * CRM by voice or typing (Open Dot CRM integration). Narrow on purpose: it parses a few spoken forms and one typed form, then hands the
 * operation to the CRM's own typed registry (crmRuntime(root).operations.run) with the VERIFIED principal only. Nothing here sends a
 * message, takes a payment or touches a provider; there is no second implementation of any CRM rule.
 *
 *   spoken   "overdue follow-ups", "what follow-ups are overdue", "my overdue follow-ups"   -> crm.followups.overdue
 *            "what have we promised this client"                                             -> crm.promises.list (the open record)
 *            "add a note to this deal: sent the revised scope"                               -> crm.activity.add (kind note, the open record)
 *   typed    `crm.task.complete {"id":"...","expectedVersion":3}`                           -> any registered operation below
 *
 * Bulk, destructive or configuration operations (CSV commit, merge, template/pipeline/automation edits) stay in the CRM page.
 */
import { createHash } from "node:crypto";
import { isBrowserPrincipal, type Principal } from "../identity/principal";
import { serverWorkAllowed } from "../identity/operator-sites";
import { SUBJECT_REF } from "../jobs/types";
import { parseCrmRef, crmRefString, type CrmRef } from "../../src/lib/crm-ref";
import { businessIntentIn, runBusinessIntent, type BusinessIntent } from "./business";

type CrmContextLike =
  | {
      /** The page's own snapshot (src/lib/page-context.ts): the CRM page publishes the open record as selection.search.ref on /crm. */
      selection?: { to?: string; search?: Record<string, string> } | null;
      /** The server's parsed context (jarvis-command/context.ts): the same selection arrives as an item whose href is "/crm?ref=...". */
      selected?: readonly { href?: string }[] | null;
      focused?: { href?: string } | null;
      crm?: unknown;
    }
  | null
  | undefined;

export type CrmIntent =
  | { kind: "overdue"; mine: boolean }
  | { kind: "promises" }
  | { kind: "note"; text: string }
  | { kind: "typed"; name: string; input: unknown }
  | { kind: "invalid"; said: string }
  | BusinessIntent;

/** Typed operations Jarvis may run: whatever the registry exposes, minus bulk, destructive and configuration edits (those stay in the page). */
export const JARVIS_CRM_READS: readonly string[] = [
  "crm.record.get",
  "crm.companies.query",
  "crm.contacts.query",
  "crm.deals.query",
  "crm.followups.overdue",
  "crm.promises.list",
  "crm.workflow.templates",
  "crm.views.list",
  "crm.duplicates.list",
  "crm.automations.list",
  "crm.search",
  "crm.next.list",
  "crm.drafts.list",
];
export const JARVIS_CRM_WRITES: readonly string[] = [
  "crm.company.create",
  "crm.company.update",
  "crm.contact.add",
  "crm.contact.create",
  "crm.contact.update",
  "crm.deal.create",
  "crm.deal.update",
  "crm.deal.move",
  "crm.task.create",
  "crm.task.add",
  "crm.task.update",
  "crm.task.complete",
  "crm.task.reopen",
  "crm.task.assign",
  "crm.activity.add",
  "crm.project.create",
  "crm.project.update",
  "crm.document.create",
  "crm.document.update",
  "crm.proposal.draft",
  "crm.invoice.draft",
  "crm.quote.package",
  "crm.workflow.apply",
];
/** Drafts carry the client's price and private text: like the CRM page, only a CONFIRMED browser may make one. */
const CONFIRMED_ONLY: readonly string[] = ["crm.proposal.draft", "crm.invoice.draft", "crm.quote.package"];

/** The CRM record the open page is about: only an explicit CRM selection counts (`selection.search.ref` on /crm), never a guess. */
export function activeCrmRef(ctx: CrmContextLike): CrmRef | null {
  const sel = ctx?.selection;
  if (sel && sel.to === "/crm" && typeof sel.search?.ref === "string")
    return parseCrmRef(sel.search.ref);
  for (const item of [...(ctx?.selected ?? []), ctx?.focused]) {
    const href = item?.href;
    if (typeof href !== "string" || !/^\/crm\?/.test(href)) continue;
    try {
      const ref = new URL(href, "http://hub.invalid").searchParams.get("ref");
      const parsed = ref ? parseCrmRef(ref) : null;
      if (parsed) return parsed;
    } catch {
      /* not a CRM link */
    }
  }
  return null;
}

/** Every well-formed CRM reference a request is about: its own `subjects`, the open CRM record, and any `crm` field. At most 8. */
export function crmSubjectsFrom(ctx: CrmContextLike, explicit?: readonly string[]): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && SUBJECT_REF.test(v) && !out.includes(v)) out.push(v);
  };
  for (const s of explicit ?? []) add(s);
  const active = activeCrmRef(ctx);
  if (active) add(crmRefString(active));
  const c = ctx?.crm;
  for (const r of Array.isArray(c) ? c : c ? [c] : []) {
    if (typeof r === "string") add(r);
    else if (r && typeof r === "object")
      add(`crm:${String((r as { kind?: unknown }).kind)}:${String((r as { id?: unknown }).id)}`);
  }
  return out.slice(0, 8);
}

const OVERDUE =
  /^(?:(?:what|which|show(?: me)?|list|any)\s+)?(?:(?:are|do i have)\s+)?(my\s+|our\s+|the\s+)?overdue\s+(?:follow[- ]?ups?|tasks)(?:\s+(?:are\s+)?(?:there|overdue))?$|^(?:what|which)\s+(?:follow[- ]?ups?|tasks)\s+are\s+overdue$/i;
const PROMISES =
  /^(?:what|which)\s+(?:have\s+we|did\s+we)\s+promised?(?:\s+(?:to\s+)?(?:this|that|the\s+open)\s+(?:client|company|deal))?$|^(?:open\s+|client\s+)?promises\s+(?:for|to|on)\s+(?:this|that)\s+(?:client|company|deal)$/i;
const NOTE =
  /^(?:please\s+)?(?:add\s+(?:a\s+)?)?note\s+(?:to|on)\s+(?:this|the\s+open|the\s+current)\s+(?:client|company|deal|contact|project)\s*[:,-]\s*(.{2,500})$/i;
const TYPED = /^(crm\.[a-z][a-z0-9.]{1,60})\s*(\{[\s\S]*)?$/i;

/** Pure: the CRM intent in an utterance, or null. */
export function crmIntentIn(utterance: string): CrmIntent | null {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  const typed = TYPED.exec(t);
  if (typed) {
    const name = typed[1].toLowerCase();
    if (!typed[2]) return { kind: "typed", name, input: {} };
    try {
      const input = JSON.parse(typed[2]);
      return input && typeof input === "object" && !Array.isArray(input)
        ? { kind: "typed", name, input }
        : { kind: "invalid", said: "That CRM input isn't a JSON object, so nothing changed." };
    } catch {
      return { kind: "invalid", said: "That CRM input isn't valid JSON, so nothing changed." };
    }
  }
  const overdue = OVERDUE.exec(t);
  if (overdue) return { kind: "overdue", mine: /^my$/i.test((overdue[1] ?? "").trim()) };
  if (PROMISES.test(t)) return { kind: "promises" };
  const note = NOTE.exec(t);
  if (note) return { kind: "note", text: note[1].trim() };
  return businessIntentIn(utterance);
}

export type CrmOperationsLike = {
  run(name: string, input: unknown, principal: Principal): unknown | Promise<unknown>;
};
type Receipt = { ok?: boolean; text?: string; code?: string; data?: unknown; href?: string };
export type CrmRunDeps = {
  operations: () => CrmOperationsLike;
  role: () => string;
  /** A quiet read-only copy refuses writes (the CRM page's own rule). */
  readOnly: () => boolean;
  now?: () => number;
};

/** Why this person may not write the CRM from Jarvis, or null. The CRM page's own gate: a browser principal; in the server role a confirmed human session. */
export function crmWriteRefusal(
  principal: Principal,
  role: string,
  readOnly: boolean,
): string | null {
  if (readOnly) return "This is a quiet read-only copy, so the CRM didn't change.";
  if (!isBrowserPrincipal(principal))
    return "CRM changes are made in the app or by voice at the hub, not from here, so nothing changed.";
  // Exactly the /__crm gate, in every role: a write is the hub owner's. That is the owner at this PC, or, in the server role only, a founder with a
  // confirmed human session. A bare tailnet login or a paired session on a pc or cloud hub never writes.
  if (principal.via === "loopback-owner") return null;
  if (role === "server" && serverWorkAllowed(principal, role)) return null;
  return role === "server"
    ? "CRM changes need a confirmed sign-in on this hub, so nothing changed."
    : "CRM changes are made at the hub itself, so nothing changed.";
}
/** Reads match /__crm: a browser principal (the owner at the hub, a paired session or a signed-in tailnet founder); never Telegram, a routine or a gateway. */
const crmReadRefusal = (principal: Principal): string | null =>
  isBrowserPrincipal(principal) ? null : "Only a signed-in founder can read the CRM from here.";

export type CrmAnswer = {
  ok: boolean;
  said: string;
  verified: boolean | null;
  /** A record to open in the app (an in-app path from the CRM's own links). */
  navigate?: { path: string };
  /** The answer is a question (which one?) that waits for the person. */
  ask?: boolean;
};

/** Run one CRM intent through the typed registry with the verified principal. Never throws: an unavailable CRM is a plain sentence. */
export async function runCrmIntent(
  deps: CrmRunDeps,
  intent: CrmIntent,
  principal: Principal,
  ctx: CrmContextLike,
  options: { eventId?: string } = {},
): Promise<CrmAnswer> {
  if (intent.kind === "invalid") return { ok: false, said: intent.said, verified: null };
  if (
    intent.kind === "search" ||
    intent.kind === "open" ||
    intent.kind === "named-note" ||
    intent.kind === "task" ||
    intent.kind === "quote" ||
    intent.kind === "invoice" ||
    intent.kind === "next" ||
    intent.kind === "drafts"
  )
    return runBusinessIntent(
      {
        operations: deps.operations,
        now: deps.now,
        writeRefusal: (p) => crmWriteRefusal(p, deps.role(), deps.readOnly()),
        readRefusal: crmReadRefusal,
      },
      intent,
      principal,
      options,
    );
  const active = activeCrmRef(ctx);
  let name: string;
  let input: unknown;
  let write = false;
  if (intent.kind === "overdue") {
    name = "crm.followups.overdue";
    input = intent.mine ? { mine: true } : {};
  } else if (intent.kind === "promises") {
    if (!active)
      return {
        ok: false,
        said: "Open a client in the CRM first, then ask again. I won't guess which one.",
        verified: null,
      };
    name = "crm.promises.list";
    input = { ref: active };
  } else if (intent.kind === "note") {
    if (!active)
      return {
        ok: false,
        said: "Open the record in the CRM first, then ask again. I won't guess which one.",
        verified: null,
      };
    name = "crm.activity.add";
    write = true;
    const minute = Math.floor((deps.now?.() ?? Date.now()) / 60_000);
    const key = options.eventId
      ? `jarvis:${options.eventId}`
      : `jarvis:${createHash("sha256")
          .update(`${principal.personId}|${crmRefString(active)}|${intent.text}`)
          .digest("hex")
          .slice(0, 24)}:${minute}`;
    input = {
      ref: active,
      eventId: key,
      kind: "note",
      title: `Note: ${intent.text.replace(/\s+/g, " ").slice(0, 80)}`.slice(0, 300),
      note: intent.text,
      by: { personId: principal.personId },
    };
  } else {
    name = intent.name;
    input = intent.input;
    if (JARVIS_CRM_WRITES.includes(name)) write = true;
    else if (!JARVIS_CRM_READS.includes(name))
      return {
        ok: false,
        said: `${name} isn't something I run from here. Use the CRM page for it; nothing changed.`,
        verified: null,
      };
  }
  const refusal = write
    ? crmWriteRefusal(principal, deps.role(), deps.readOnly())
    : crmReadRefusal(principal);
  if (refusal) return { ok: false, said: refusal, verified: null };
  if (CONFIRMED_ONLY.includes(name) && principal.actor !== "human")
    return {
      ok: false,
      said: "Confirm this browser before I draft that, so nothing was drafted.",
      verified: null,
    };
  let receipt: Receipt;
  try {
    receipt = (await deps.operations().run(name, input, principal)) as Receipt;
  } catch (error) {
    if ((error as { code?: string })?.code === "needs-upgrade")
      return { ok: false, said: String((error as Error).message), verified: null };
    return { ok: false, said: "The CRM didn't answer, so nothing changed.", verified: null };
  }
  if (!receipt || receipt.ok === false)
    return {
      ok: false,
      said: `The CRM didn't take it: ${String(receipt?.text ?? "refused").slice(0, 160)}`,
      verified: false,
    };
  if (name === "crm.followups.overdue") {
    const rows = Array.isArray(receipt.data) ? (receipt.data as { title?: string }[]) : [];
    if (!rows.length) return { ok: true, said: "Nothing is overdue.", verified: true };
    const first = rows
      .slice(0, 3)
      .map((r) => r.title)
      .filter(Boolean)
      .join("; ");
    return {
      ok: true,
      said: `${rows.length} overdue follow-up${rows.length === 1 ? "" : "s"}${first ? `: ${first}` : ""}. The list is in the CRM under Today.`,
      verified: true,
    };
  }
  return { ok: true, said: String(receipt.text ?? "Done.").slice(0, 240), verified: true };
}
