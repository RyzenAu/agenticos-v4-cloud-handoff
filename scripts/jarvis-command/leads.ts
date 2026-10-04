/**
 * CRM actions by voice or typing (Track 2, AUDIT-F4 F11), through the leads service's own API. Pure over
 * the injected API: the live server passes createLeadsApi(root); tests pass a fake.
 */
import type { Principal } from "../identity/principal";
import { selectLeadResults } from "../../src/lib/lead-search";
import type { LeadAction } from "./plan";

/** The leads service's own API (scripts/leads/api.ts createLeadsApi().handle). */
export type LeadsApiLike = {
  handle(
    path: string,
    method: string,
    body: unknown,
    params: URLSearchParams,
    remote: boolean,
  ): Promise<unknown>;
};

const OUTCOME_WORDS: Record<string, string> = {
  no_answer: "no answer",
  voicemail: "voicemail",
  call_back: "call back",
  interested: "interested",
  not_interested: "not interested",
  meeting: "meeting",
  proposal: "proposal",
  won: "won",
  lost: "lost",
  do_not_contact: "do not contact",
};

/**
 * A spoken or typed CRM action (AUDIT-F4 F11) through the leads service: the lead is found by name in the
 * CRM (one match acts; several ask which; none says so), the write goes through /leads/log, and the new
 * status is read back independently (/leads/list by status) before anything is called done.
 */
export async function runLeadAction(
  api: LeadsApiLike,
  action: LeadAction,
  principal: Pick<Principal, "personId">,
  options: { eventId?: string; jobId?: string } = {},
): Promise<{ ok: boolean; said: string; verified: boolean | null }> {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  if (action.action === "count") {
    // Same uncapped, exclusion/merge-aware total the Leads pipeline shows. Never sum stage
    // counts or substitute total records for open leads when an older API omits this field.
    const r = (await api.handle("/leads/pipeline", "GET", {}, q({ summary: "1" }), false)) as { open?: unknown; ok?: boolean; error?: unknown } | null;
    const open = r?.open;
    return r?.ok !== false && !r?.error && typeof open === "number" && Number.isSafeInteger(open) && open >= 0
      ? { ok: true, said: `We have ${open} open lead${open === 1 ? "" : "s"}.`, verified: true }
      : { ok: false, said: "The Leads pipeline didn't return a verified open-lead count, so I won't guess.", verified: null };
  }
  if (action.action === "next") {
    const r = (await api.handle("/leads/cards", "GET", {}, q({ n: "1" }), false)) as {
      cards?: Array<{
        leadId: number;
        name: string;
        vertical?: string;
        area?: string;
        status?: string;
      }>;
    };
    const c = r.cards?.[0];
    return c
      ? {
          ok: true,
          said: `Next to call: ${c.name}${c.vertical ? ` (${c.vertical}${c.area ? `, ${c.area}` : ""})` : ""}. Its call card is in Leads.`,
          verified: true,
        }
      : { ok: true, said: "There's no one waiting to be called right now.", verified: true };
  }
  // The same multiword, accent- and punctuation-folded search the Leads page uses (a misheard order or a missing accent still finds the lead), plus the
  // palette search's phone, email and id matches. Exact (folded) name wins; several matches ask which one; none says so. Nothing is guessed.
  const candidates = new Map<number, string>();
  try {
    const all = (await api.handle("/leads/list", "GET", {}, q({ all: "1" }), false)) as {
      leads?: Array<{ id: number; name?: string }>;
    };
    for (const lead of selectLeadResults((all.leads ?? []) as never, { q: action.lead }))
      candidates.set(lead.id, lead.name || `Lead #${lead.id}`);
  } catch {
    /* fall back to the palette search alone */
  }
  const found = (await api.handle("/leads/search", "GET", {}, q({ q: action.lead }), false)) as {
    hits?: Array<{ group: string; leadId: number; title: string }>;
  };
  for (const h of found.hits ?? [])
    if (h.group === "leads" && !candidates.has(h.leadId)) candidates.set(h.leadId, h.title);
  const leads = [...candidates].map(([leadId, title]) => ({ leadId, title }));
  const exact = leads.filter((h) => fold(h.title) === fold(action.lead));
  const pick = exact.length === 1 ? exact : leads;
  if (!pick.length)
    return {
      ok: false,
      said: `I can't find a lead called ${action.lead} in the CRM, so nothing changed.`,
      verified: null,
    };
  if (pick.length > 1)
    return {
      ok: false,
      said: `${pick.length} leads match "${action.lead}" (${pick
        .slice(0, 3)
        .map((h) => h.title)
        .join(", ")}). Which one?`,
      verified: null,
    };
  const lead = pick[0];
  // A stable key per spoken or typed event: the Leads service already ignores a second /leads/log with the same `event`, so a double submit logs once.
  // The command's own event id when the client minted one (stable across a replay), else this command's job id: the command service answers a repeat
  // of the same words with the same job, so a double submit shares the key, while a genuine second redial is a new job and logs again. No time bucket.
  const event = options.eventId
    ? `jarvis:${options.eventId}`
    : options.jobId
      ? `jarvis:job:${options.jobId}`
      : undefined;
  await api.handle(
    "/leads/log",
    "POST",
    {
      lead: lead.leadId,
      outcome: action.outcome,
      kind: action.action === "log" ? "call" : "note",
      by: principal.personId,
      ...(event ? { event } : {}),
    },
    q({}),
    false,
  );
  // Independent read-back: the lead now lists under that status.
  const listed = (await api.handle(
    "/leads/list",
    "GET",
    {},
    q({ status: action.outcome, all: "1" }),
    false,
  )) as { leads?: Array<{ id: number }> };
  const verified = !!listed.leads?.some((l) => l.id === lead.leadId);
  const words = OUTCOME_WORDS[action.outcome] ?? action.outcome;
  return verified
    ? {
        ok: true,
        said:
          action.action === "log"
            ? `Logged a call to ${lead.title} as ${words}.`
            : `Marked ${lead.title} as ${words}.`,
        verified: true,
      }
    : {
        ok: false,
        said: `I sent it to the CRM, but ${lead.title} doesn't read back as ${words}, so I'm not calling it done.`,
        verified: false,
      };
}

const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
