// A small fake of the bot backend, written against the plan's contract (GET /__agents/bots/:id/thread?after, the Jarvis command with
// { conversationId, target: { bot } }, the /__events "thread" topic). BotChat is built and tested against this; when the real routes land
// the lead points src/lib/agent-chat.ts at them and this file stays as the test double.
import type { ActivityMessage } from "@/lib/activity-stream";
import type { AgentChatApi, BotSendInput, BotThreadEntry, StoredItem } from "@/lib/agent-chat";

export const JOB_A = "0a1b2c3d-1111-4222-8333-444455556666";
export const JOB_B = "0b1b2c3d-2222-4222-8333-444455556666";
export const JOB_C = "0c1b2c3d-3333-4222-8333-444455556666";
export const JOB_D = "0d1b2c3d-4444-4222-8333-444455556666";

export type FakeHub = ReturnType<typeof createFakeBotHub>;

export function createFakeBotHub(opts: { botId?: string; conversationId?: string; jobIds?: string[]; /** Like B1's backend: the request and the acknowledgement are written into the thread under `<eventId>:request` / `:ack`. */ serverLines?: boolean; /** The next send is refused (a bot whose computer is missing). */ refuse?: string } = {}) {
  const botId = opts.botId ?? "research";
  const conversationId = opts.conversationId ?? `agent:p1:${botId}`;
  const entries: BotThreadEntry[] = [];
  const sent: BotSendInput[] = [];
  const cancelled: string[] = [];
  const cancelKinds: Array<string | undefined> = [];
  let cancelRefusal: string | null = null;
  const handlers = new Set<(m: ActivityMessage) => void>();
  const fetches: Array<{ botId: string; after: number }> = [];
  let seq = 0;
  let eventId = 0;
  let jobNo = 0;
  const jobIds = opts.jobIds ?? [JOB_A, JOB_B, JOB_C, JOB_D];
  let failFetch = false;

  const at = () => new Date().toISOString();
  const emit = (message: ActivityMessage) => {
    for (const h of [...handlers]) h(message);
  };
  const entryEvent = (e: BotThreadEntry): ActivityMessage => ({
    kind: "event",
    event: { id: ++eventId, at: Date.now(), topic: "thread", type: "entry", final: false, data: { conversationId, eventId: `${conversationId}:${e.key}`, entry: e } },
  });
  /** Append to the server thread. `live: false` models an entry appended while the client was not listening. */
  function append(entry: Omit<BotThreadEntry, "seq" | "at"> & { at?: string }, o: { live?: boolean } = {}): BotThreadEntry {
    const existing = entries.find((e) => e.key === entry.key);
    if (existing) return existing;
    const full: BotThreadEntry = { ...entry, seq: ++seq, at: entry.at ?? at() };
    entries.push(full);
    if (o.live !== false) emit(entryEvent(full));
    return full;
  }

  const api: AgentChatApi = {
    async fetchThread(id, after) {
      fetches.push({ botId: id, after });
      if (failFetch) throw new Error("The conversation could not be read (status 503).");
      return { conversationId, entries: entries.filter((e) => e.seq > after).map((e) => ({ ...e })) };
    },
    async send(input) {
      sent.push(input);
      if (opts.serverLines) append({ key: `${input.eventId}:request`, jobId: "", state: "request", text: input.source === "voice" ? "Spoken request." : input.utterance });
      if (opts.refuse) {
        if (opts.serverLines) append({ key: `${input.eventId}:ack`, jobId: "", state: "ack", text: opts.refuse });
        return { ok: false, said: opts.refuse, jobId: null };
      }
      const jobId = jobIds[jobNo++ % jobIds.length];
      append({ key: `${jobId}:started`, jobId, state: "started", text: `Started: ${input.utterance.slice(0, 60)} (job ${jobId.slice(0, 8)}).` });
      if (opts.serverLines) append({ key: `${input.eventId}:ack`, jobId, state: "ack", text: "On it. I will keep working in the background." });
      return { ok: true, said: "On it. I will keep working in the background.", jobId };
    },
    async cancel(jobId, jobKind) {
      cancelled.push(jobId);
      cancelKinds.push(jobKind);
      return cancelRefusal ? { ok: false, reason: cancelRefusal } : { ok: true };
    },
  };

  return {
    botId,
    conversationId,
    api,
    sent,
    cancelled,
    cancelKinds,
    /** The next Stops are refused with this reason (null: accepted again). */
    refuseCancel: (reason: string | null) => void (cancelRefusal = reason),
    fetches,
    entries,
    append,
    entryEvent,
    /** Subscribe like the real stream does. */
    subscribe: (h: (m: ActivityMessage) => void) => {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    subscribers: () => handlers.size,
    emit,
    /** A hub restart: the stream reconnects and sends a fresh snapshot (a new epoch). */
    restart: () => emit({ kind: "snapshot", snapshot: { epoch: `boot-${++eventId}`, head: 0, jobs: [], jobsHead: 0, approvals: [], computers: [], devices: [], at: Date.now() } }),
    setFetchFailing: (v: boolean) => void (failFetch = v),
    step: (jobId: string, n: number, text: string, o?: { live?: boolean }) => append({ key: `${jobId}:step:${n}`, jobId, state: "progress", text }, o),
    waiting: (jobId: string, state: string, text: string, blocker?: BotThreadEntry["blocker"]) => append({ key: `${jobId}:${state}`, jobId, state, text, ...(blocker ? { blocker } : {}) }),
    result: (jobId: string, text: string, saved = true) =>
      append({ key: `${jobId}:report:1`, jobId, state: "report", text: saved ? `${text}\nSaved result: Dentists near Parramatta\n(job ${jobId.slice(0, 8)})` : text }),
    finish: (jobId: string) => append({ key: `${jobId}:succeeded`, jobId, state: "succeeded", text: "Finished." }),
    fail: (jobId: string, text: string) => append({ key: `${jobId}:failed`, jobId, state: "failed", text }),
    stopped: (jobId: string) => append({ key: `${jobId}:cancelled`, jobId, state: "cancelled", text: "Stopped." }),
  };
}

/** The person's own lines for a seeded demo thread (what a visit keeps on the device). */
export function demoStored(): StoredItem[] {
  const t = Date.now() - 60 * 60_000;
  return [
    { type: "request", key: "demo-1", at: t, text: "Find dentists near Parramatta with a poor website and list the top five.", source: "typed", jobId: JOB_A },
    { type: "ack", key: "demo-1", at: t + 1, text: "On it. I will research this in the background and post the list here.", jobId: JOB_A },
    { type: "request", key: "demo-2", at: t + 20 * 60_000, text: "Log into the booking portal and download this month's report.", source: "voice", jobId: JOB_B },
    { type: "ack", key: "demo-2", at: t + 20 * 60_000 + 1, text: "Starting that now.", jobId: JOB_B },
    { type: "request", key: "demo-3", at: t + 35 * 60_000, text: "Draft the Q3 summary for Mehroz.", source: "typed", jobId: JOB_C },
    { type: "ack", key: "demo-3", at: t + 35 * 60_000 + 1, text: "On it.", jobId: JOB_C },
  ];
}

/** Seed a hub with a done job, one that needs the person, one that failed and one still running (the states a screenshot should show). */
export function seedDemoThread(hub: FakeHub) {
  const base = Date.now() - 60 * 60_000;
  const iso = (m: number) => new Date(base + m * 60_000).toISOString();
  const put = (e: Omit<BotThreadEntry, "seq" | "at">, m: number) => hub.append({ ...e, at: iso(m) }, { live: false });
  put({ key: `${JOB_A}:started`, jobId: JOB_A, state: "started", text: `Started: Find dentists near Parramatta (job ${JOB_A.slice(0, 8)}).` }, 0);
  put({ key: `${JOB_A}:step:1`, jobId: JOB_A, state: "progress", text: "Step 1 of 3 (search the web): found 14 practices." }, 4);
  put({ key: `${JOB_A}:step:2`, jobId: JOB_A, state: "progress", text: "Step 2 of 3 (check each website): scored 14 sites." }, 9);
  put({ key: `${JOB_A}:report:1`, jobId: JOB_A, state: "report", text: `Five practices stand out: the sites are slow on a phone, hide the booking button and show no prices.\nParramatta Smiles, Westfield Dental, Church Street Dental, Harris Park Family Dental and Granville Dental Care. I saved the scores and screenshots with the result.\nSaved result: Dentists near Parramatta\n(job ${JOB_A.slice(0, 8)})` }, 12);
  put({ key: `${JOB_B}:started`, jobId: JOB_B, state: "started", text: `Started: Download this month's booking report (job ${JOB_B.slice(0, 8)}).` }, 20);
  put({ key: `${JOB_B}:step:1`, jobId: JOB_B, state: "progress", text: "Opened the booking portal sign-in page." }, 22);
  put({ key: `${JOB_B}:needs_owner`, jobId: JOB_B, state: "needs_owner", text: "The portal is asking for a one-time code sent to your phone.", blocker: { kind: "take-over", recovery: "Take over, type the code, then hand back and it carries on from the report page." } }, 24);
  put({ key: `${JOB_C}:started`, jobId: JOB_C, state: "started", text: `Started: Draft the Q3 summary (job ${JOB_C.slice(0, 8)}).` }, 35);
  put({ key: `${JOB_C}:failed`, jobId: JOB_C, state: "failed", text: "The model account it uses ran out of allowance before the draft was saved." }, 38);
  put({ key: `${JOB_D}:started`, jobId: JOB_D, state: "started", text: `Started: Compare three competitor pricing pages (job ${JOB_D.slice(0, 8)}).` }, 50);
  put({ key: `${JOB_D}:step:1`, jobId: JOB_D, state: "progress", text: "Reading the first pricing page." }, 52);
}
