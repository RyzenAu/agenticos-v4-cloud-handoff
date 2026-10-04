/**
 * Founder-AUTHORISED mailboxes for the Dot gateway (`mail.read`, `mail.draft`).
 *
 * Nothing is authorised by default. A founder authorises one mailbox address at a time from the hub's console
 * (`bun scripts/gateway/cli.ts authorise-mailbox <address> --by usman`; `revoke-mailbox` takes it back, at once). The hub
 * keeps one mail archive for every connected mailbox (scripts/mail-archive.ts) with no per-founder split, so the gateway's
 * own allow-list IS the boundary: every message it returns is checked against it, case-insensitively.
 *
 *   mail.read   list threads and read a thread, from the hub's LOCAL archive only. No provider call is made (so no
 *               credential is used on Dot's behalf and nothing is fetched or cached because Dot asked); a body the hub
 *               has not cached yet comes back as "metadata" (the subject, people and snippet).
 *   mail.draft  save a reply draft the way the OS already does: a CRM activity of kind "draft-reply", communicationState
 *               "drafted", on the company or deal it is about, attributed to Dot. Nothing is sent; a Gmail-side draft and
 *               sending stay a founder's (the founders' Gmail action shares one code path for draft and send).
 *
 * Never returned: Bcc, raw provider JSON, provider links, message-ids, the archive's storage path, tokens or connection files.
 */
import { createHash } from "node:crypto";

export type ArchiveItem = {
  id: string;
  account?: string;
  source?: string;
  subject?: string;
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  body?: string;
  receivedAt?: string;
  threadId?: string;
  direction?: string;
  labelIds?: string[];
  bodyStatus?: string;
};
export type MailArchiveLike = { search(query?: string, limit?: number, offset?: number, provider?: string, account?: string): { items: ArchiveItem[]; total: number }; get(id: string): ArchiveItem | undefined };

export class MailRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const normaliseMailbox = (address: unknown) => {
  const a = String(address ?? "").trim().toLowerCase();
  return /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(a) ? a : null;
};

const people = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : (v ?? "")).slice(0, 2000);
const view = (m: ArchiveItem, full: boolean) => ({
  id: m.id,
  mailbox: (m.account ?? "").toLowerCase(),
  threadId: m.threadId ?? null,
  subject: m.subject ?? "",
  from: m.from ?? "",
  to: people(m.to),
  cc: people(m.cc),
  receivedAt: m.receivedAt ?? null,
  direction: m.direction ?? null,
  labels: Array.isArray(m.labelIds) ? m.labelIds.slice(0, 20) : [],
  ...(full ? { body: String(m.body ?? "").slice(0, 20_000), bodyStatus: m.bodyStatus ?? "full" } : { snippet: String(m.body ?? "").replace(/\s+/g, " ").slice(0, 200) }),
});

export function createGatewayMail(deps: { archive: () => MailArchiveLike | null; authorised: () => string[] }) {
  const allowed = () => new Set(deps.authorised().map((a) => a.toLowerCase()));
  const archive = () => {
    const a = deps.archive();
    if (!a) throw new MailRefusal(503, "The mail archive is not running on this hub.");
    return a;
  };
  const mailbox = (address: unknown) => {
    const a = normaliseMailbox(address);
    if (!a) throw new MailRefusal(400, "Name the mailbox by its address.");
    if (!allowed().has(a)) throw new MailRefusal(403, "That mailbox is not authorised for the gateway. A founder authorises it at the hub's console.");
    return a;
  };
  /** Messages of one authorised mailbox, newest first (the archive's own order), at most `scan` of them. */
  // Filtered by the authorised mailbox IN the archive's query, before its limit, so other mailboxes never crowd it out; re-checked here.
  const messagesOf = (address: string, query: string, scan = 500) => archive().search(query, scan, 0, "", address).items.filter((m) => (m.account ?? "").toLowerCase() === address);

  return {
    mailboxes: () => ({ mailboxes: [...allowed()].sort() }),
    threads(address: unknown, query: unknown, limit: number) {
      const a = mailbox(address);
      const q = typeof query === "string" ? query.slice(0, 200) : "";
      const groups = new Map<string, { threadId: string; subject: string; from: string; lastAt: string | null; messages: number }>();
      for (const m of messagesOf(a, q)) {
        const key = m.threadId || m.id;
        const g = groups.get(key);
        if (g) g.messages++;
        else groups.set(key, { threadId: key, subject: m.subject ?? "", from: m.from ?? "", lastAt: m.receivedAt ?? null, messages: 1 });
      }
      return { mailbox: a, threads: [...groups.values()].slice(0, limit) };
    },
    thread(address: unknown, threadId: unknown) {
      const a = mailbox(address);
      if (typeof threadId !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(threadId)) throw new MailRefusal(400, "threadId is required.");
      const ids = messagesOf(a, "").filter((m) => (m.threadId || m.id) === threadId).map((m) => m.id);
      if (!ids.length) throw new MailRefusal(404, "No such thread in that mailbox.");
      const messages = ids.map((id) => archive().get(id)).filter((m): m is ArchiveItem => !!m && (m.account ?? "").toLowerCase() === a);
      return { mailbox: a, threadId, messages: messages.sort((x, y) => String(x.receivedAt).localeCompare(String(y.receivedAt))).map((m) => view(m, true)) };
    },
    /** The message a draft replies to, re-checked against the allow-list (a message from another mailbox does not exist here). */
    message(address: unknown, messageId: unknown) {
      const a = mailbox(address);
      if (typeof messageId !== "string" || messageId.length > 300) throw new MailRefusal(400, "messageId is required.");
      const m = archive().get(messageId);
      if (!m || (m.account ?? "").toLowerCase() !== a) throw new MailRefusal(404, "No such message in that mailbox.");
      return view(m, false);
    },
    /** The CRM activity that IS a reply draft in this OS (kind "draft-reply", communicationState "drafted"). */
    draftActivity(input: { messageId: string; subject: string; ref: { kind: string; id: string }; body: string; title?: string }) {
      const digest = createHash("sha256").update(`${input.messageId}|${input.body}`).digest("hex").slice(0, 16);
      return {
        ref: input.ref,
        eventId: `gw-draft-reply:${digest}`,
        kind: "draft-reply",
        title: (input.title || `Reply draft: ${input.subject || "(no subject)"}`).replace(/[\r\n]+/g, " ").slice(0, 300),
        note: input.body,
        communicationState: "drafted",
      };
    },
  };
}

export type GatewayMail = ReturnType<typeof createGatewayMail>;
