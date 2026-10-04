// R11: the Jarvis page IS the conversation. This reads the same Jarvis thread the companion panel shows (the server's
// "Jarvis" conversation: requests, job starts, progress, results, the coding "Finished … Changes:" links), newest at the
// bottom, and pins the composer under it. Sending uses the existing command path (the companion's typed request) through
// sendJarvisRequest, which waits for the companion to accept it: the box clears only then, and says so if nothing took it.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, AudioLines, Send, Square } from "lucide-react";
import { Button, RouteText } from "@/components/ds";
import { operatorRequest } from "@/lib/operator";
import { useActivity } from "@/lib/use-activity";
import { ENTRY_LABEL, entryKind, hasSavedResult, jobIdOf, openJobHref, type EntryKind } from "@/lib/thread-events";
import { useDraft } from "@/lib/use-draft";
import { cn } from "@/lib/utils";
import { openJarvis } from "../jarvis-slot";
import { sendDecision, sendJarvisRequest, retryRequestId, readInterruptedRequest, rememberInterruptedRequest, type InterruptedRequest, type PendingSend } from "@/lib/jarvis-send";
import { readSent, rememberSent, unshownSent, type SentRequest } from "@/lib/jarvis-sent";
import { openJobs } from "@/lib/handoff-status";
import { stopJobFromThread } from "@/lib/thread-stop";
import { useJourneys } from "@/components/departments/use-departments";
import { JobCard, JourneyItem, groupThread, type JobFacts } from "./jarvis-work";

/** R12: what the jobs API knows about each job (its bot, CRM records, real step count), for the work cards. Null when unreadable. */
async function readJobFacts(): Promise<Map<string, JobFacts>> {
  const r = await fetch("/__jobs?limit=100", { cache: "no-store", headers: { Accept: "application/json" } });
  const body = (await r.json().catch(() => null)) as { jobs?: Record<string, unknown>[] } | null;
  const out = new Map<string, JobFacts>();
  for (const j of body?.jobs ?? []) {
    if (typeof j.id !== "string") continue;
    out.set(j.id, { id: j.id, title: String(j.title ?? ""), state: String(j.state ?? ""), bot: typeof j.bot === "string" ? j.bot : null, subjects: Array.isArray(j.subjects) ? j.subjects.filter((x): x is string => typeof x === "string") : [], stepCount: typeof j.stepCount === "number" ? j.stepCount : 0, createdAt: Date.parse(String(j.createdAt)) || 0, updatedAt: Date.parse(String(j.updatedAt)) || 0 });
  }
  return out;
}
async function readThreadId(): Promise<string | null> {
  const head = await operatorRequest<{ conversationId: string }>("/screen/command/thread?after=999999999").catch(() => null);
  return head?.conversationId ?? null;
}

export type ThreadMessage = { role: string; text: string; via?: string };
type Conversation = { id: string; title?: string; updatedAt?: string; messages?: ThreadMessage[] };

/** How many messages the page shows (the conversation itself keeps more). */
export const THREAD_SHOWN = 80;

export async function readJarvisThread(): Promise<ThreadMessage[]> {
  // The thread endpoint names the person's Jarvis conversation; a huge `after` returns no entries, only the id.
  const head = await operatorRequest<{ conversationId: string }>("/screen/command/thread?after=999999999").catch(() => null);
  const { conversations } = await operatorRequest<{ conversations: Conversation[] }>("/conversations");
  const mine = (head && conversations.find((c) => c.id === head.conversationId)) ?? [...conversations].filter((c) => c.title === "Jarvis").sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
  return (mine?.messages ?? []).slice(-THREAD_SHOWN);
}

const QUIET: readonly (EntryKind | null)[] = ["started", "progress", "update"];
const TONE: Partial<Record<EntryKind, string>> = { failed: "text-danger", waiting: "text-warn", stopped: "text-muted-foreground", unknown: "text-muted-foreground", finished: "text-success", result: "text-foreground" };

function Entry({ m, running, onStopped }: { m: ThreadMessage; running?: boolean; onStopped?: () => void }) {
  const kind = entryKind(m.via);
  const [stop, setStop] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null });
  const href = openJobHref(m.via, m.text);
  // The "(job 1a2b3c4d)" tail and the "Saved result:" line are what the link is for: say them once, as the link.
  const text = m.text.replace(/\s*\(job [0-9a-f]{8}\)\.?\s*$/i, "").replace(/\nSaved result: [^\n]+$/m, "").trim();
  if (m.role === "user")
    return (
      <li className="flex justify-end">
        <p className="max-w-[min(42rem,85%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-[15px] text-foreground">{m.text}</p>
      </li>
    );
  if (kind && QUIET.includes(kind))
    return (
      <li className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-1 text-sm text-muted-foreground" data-entry={kind}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-border-strong" />
        <span className="min-w-0 flex-1">{text}</span>
        {/* A job that has started and not ended can be stopped right here; the line under it says what the hub confirmed. */}
        {kind === "started" && running && jobIdOf(m.via) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 rounded-full px-3"
            disabled={stop.busy}
            data-stop-job={jobIdOf(m.via)!}
            onClick={async () => {
              setStop({ busy: true, said: null });
              const said = await stopJobFromThread(jobIdOf(m.via)!);
              setStop({ busy: false, said });
              onStopped?.();
            }}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" /> {stop.busy ? "Stopping…" : "Stop"}
          </Button>
        )}
        {stop.said && <span role="status" className="basis-full pl-3.5 text-sm text-foreground">{stop.said}</span>}
      </li>
    );
  const isCoding = !!href?.startsWith("/coding/");
  // The label above already says "Failed" / "Finished" / "Outcome unclear": the sentence doesn't repeat it.
  const body = kind ? text.replace(/^(Failed|Stopped|Finished|Ended without a confirmed outcome):\s*/i, "").replace(/^./, (c) => c.toUpperCase()) : text;
  return (
    <li className="max-w-[min(48rem,100%)]" data-entry={kind ?? "reply"}>
      {kind && <p className={cn("mb-1 text-xs font-medium", TONE[kind] ?? "text-muted-foreground")}>{ENTRY_LABEL[kind]}</p>}
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground"><RouteText>{body}</RouteText></p>
      {href && (
        <a href={href} className="-mb-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {isCoding ? "See the changes" : hasSavedResult(m.text) ? "Open the result" : `Open job ${jobIdOf(m.via)?.slice(0, 8) ?? ""}`}
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
      )}
    </li>
  );
}

export function JarvisThread() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["jarvis-thread"], queryFn: readJarvisThread, staleTime: 5_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 1 });
  const refresh = () => void client.invalidateQueries({ queryKey: ["jarvis-thread"] });
  useActivity(refresh, ["thread"]);
  useEffect(() => {
    window.addEventListener("operator:conversations-changed", refresh);
    return () => window.removeEventListener("operator:conversations-changed", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [request, setRequest] = useDraft("jarvis-request");
  // Read-only until hydrated: text typed into the server-rendered box was wiped by hydration and its Send never fired (round 11, reliability).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // Requests this browser handed over, kept (across reloads) until the conversation shows them.
  const [sent, setSent] = useState<SentRequest[]>([]);
  useEffect(() => setSent(readSent()), []);
  const messages = useMemo(() => q.data ?? [], [q.data]);
  const shownSent = unshownSent(sent, messages);
  const running = useMemo(() => openJobs(messages), [messages]);
  const factsQ = useQuery({ queryKey: ["jarvis-job-facts"], queryFn: readJobFacts, staleTime: 5_000, refetchInterval: running.size ? 8_000 : 30_000, refetchIntervalInBackground: false, retry: false });
  const threadIdQ = useQuery({ queryKey: ["jarvis-thread-id"], queryFn: readThreadId, staleTime: 60_000, retry: false });
  const journeysQ = useJourneys(threadIdQ.data ? { conversationId: threadIdQ.data } : {});
  const journeys = useMemo(() => (journeysQ.data?.status === "ok" ? journeysQ.data.journeys.filter((j) => !threadIdQ.data || !j.conversationId || j.conversationId === threadIdQ.data) : []), [journeysQ.data, threadIdQ.data]);
  const items = useMemo(() => groupThread(messages, journeys), [messages, journeys]);
  const facts = factsQ.data ?? new Map<string, JobFacts>();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, shownSent.length]);

  // M5: one identity per composed request. While it waits (the companion may still be loading; the shell replays it then), the words
  // stay, Send on the same words is the same request, and editing them cancels it.
  const pendingRef = useRef<PendingSend | null>(null);
  const retryRef = useRef<PendingSend | null>(null);
  const [sendError, setSendError] = useState("");
  const interruptedRef = useRef<InterruptedRequest | null>(null);
  useEffect(() => {
    const interrupted = readInterruptedRequest();
    interruptedRef.current = interrupted;
    if (interrupted) setSendError(`Request ${interrupted.requestId} was interrupted by a reload. Its outcome is unknown. Check the saved conversation before starting a new request; browser tool steps cannot be safely replayed.`);
  }, []);
  const [waiting, setWaiting] = useState<"no" | "sending" | "slow">("no");
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!hydrated || !request.trim()) return;
    if (sendDecision(pendingRef.current, request) === "same") return;
    if (interruptedRef.current?.text === request.trim()) return;
    const p = sendJarvisRequest(request, { requestId: retryRequestId(retryRef.current, request), onSlow: () => pendingRef.current === p && setWaiting("slow") });
    pendingRef.current = p;
    rememberInterruptedRequest({ requestId: p.requestId, text: p.text });
    setWaiting("sending");
    setSendError("");
    void p.done.then((outcome) => {
      if (pendingRef.current !== p) return;
      pendingRef.current = null;
      setWaiting("no");
      if (outcome === "rejected") {
        retryRef.current = p;
        setSendError(p.failure || "Not confirmed saved. Retry this same request.");
        return;
      }
      if (outcome !== "accepted") return;
      retryRef.current = null;
      rememberInterruptedRequest(null);
      setSent(rememberSent({ requestId: p.requestId, text: p.text, at: Date.now() }));
      setRequest("");
      window.setTimeout(refresh, 2500);
    });
  };
  const edit = (next: string) => {
    if (interruptedRef.current && next.trim() !== interruptedRef.current.text) {
      interruptedRef.current = null;
      rememberInterruptedRequest(null);
      setSendError("");
    }
    if (retryRef.current && next.trim() !== retryRef.current.text) {
      retryRef.current = null;
      rememberInterruptedRequest(null);
      setSendError("");
    }
    // Before effects begin, editing cancels queued admission. Afterward it only detaches this draft waiter; owned work continues.
    if (pendingRef.current && next.trim() !== pendingRef.current.text) {
      const hadStarted = pendingRef.current.started;
      pendingRef.current.cancel();
      if (!hadStarted) rememberInterruptedRequest(null);
      pendingRef.current = null;
      setWaiting("no");
    }
    setRequest(next);
  };
  useEffect(() => () => pendingRef.current?.cancel(), []);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e as unknown as FormEvent);
  };

  return (
    <section aria-label="Conversation with Jarvis" className="flex min-h-0 flex-1 flex-col" data-jarvis-thread>
      <div ref={listRef} className="max-h-[calc(100dvh-22rem)] min-h-[12rem] flex-1 overflow-y-auto pr-1 pt-4 [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)] lg:max-h-none lg:min-h-0" role="log" aria-live="polite" aria-relevant="additions">
        {q.isLoading ? (
          <p className="mx-auto w-full max-w-4xl py-6 text-sm text-muted-foreground" role="status">Reading the conversation…</p>
        ) : q.isError ? (
          <p className="mx-auto w-full max-w-4xl py-6 text-sm text-muted-foreground" role="status">
            The conversation couldn't be read. <button type="button" className="underline underline-offset-4" onClick={refresh}>Try again</button>
          </p>
        ) : messages.length === 0 && shownSent.length === 0 ? (
          <p className="mx-auto w-full max-w-4xl py-6 text-sm text-muted-foreground">Nothing yet. Ask Jarvis below, or press Use voice.</p>
        ) : (
          <ol className="mx-auto flex w-full max-w-4xl flex-col gap-4 py-2">
            {items.map((it) =>
              it.type === "message" ? (
                <Entry key={`${it.index}:${it.m.via ?? ""}`} m={it.m} />
              ) : it.type === "job" ? (
                <JobCard key={it.jobId} jobId={it.jobId} entries={it.entries} facts={facts.get(it.jobId) ?? null} all={facts} running={running.has(it.jobId)} onChanged={() => window.setTimeout(refresh, 1500)} />
              ) : (
                <JourneyItem key={it.journey.id} journey={it.journey} />
              ),
            )}
            {shownSent.map((r) => (
              <li key={r.requestId} className="flex flex-col items-end gap-1" data-sent={r.requestId}>
                <p className="max-w-[min(42rem,85%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-[15px] text-foreground">{r.text}</p>
                <span className="text-xs text-muted-foreground">Sent to Jarvis · {new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(r.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <form onSubmit={send} className="@container mx-auto mt-3 flex w-full max-w-4xl items-end gap-2 border-t border-border pt-3" data-assistant-request>
        <label htmlFor="assistant-request" className="sr-only">Request for Jarvis</label>
        <textarea
          id="assistant-request"
          value={request}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKey}
          aria-describedby={waiting === "slow" || sendError ? "jarvis-send-status" : undefined}
          readOnly={!hydrated}
          maxLength={600}
          rows={1}
          placeholder="Ask Jarvis to do something"
          className="max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-2.5 text-[15px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [field-sizing:content]"
        />
        <Button type="button" variant="outline" className="min-h-11 rounded-full px-4" onClick={openJarvis} aria-label="Use voice">
          <AudioLines className="h-4 w-4" aria-hidden="true" /> <span className="hidden @xl:inline">Use voice</span>
        </Button>
        <Button type="submit" variant="accent" className="min-h-11 rounded-full px-4" disabled={!request.trim() || waiting !== "no"} aria-label={waiting !== "no" ? "Sending" : "Send request"}>
          <Send className="h-4 w-4" aria-hidden="true" /> <span className="hidden @xl:inline">Send</span>
        </Button>
      </form>
      {sendError && <p id="jarvis-send-status" role="alert" className="mx-auto mt-2 w-full max-w-4xl whitespace-pre-wrap text-sm text-muted-foreground">{sendError}</p>}
      {waiting === "slow" && (
        <p id="jarvis-send-status" role="status" className="mx-auto mt-2 w-full max-w-4xl text-sm text-muted-foreground">
          Waiting for Jarvis to confirm your request and reply are saved. Keep these words to retry with the same request ID if saving fails.
        </p>
      )}
    </section>
  );
}
