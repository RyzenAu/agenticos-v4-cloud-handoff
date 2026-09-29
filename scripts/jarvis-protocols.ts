// Named protocols ("start my day", "call mode", "shutdown") and the deterministic voice rules
// that reach them and "status" before Jev or the brain. Every step is local and read-only or a
// reversible OS flag (call mode, quiet mode). A protocol NEVER dials, sends, deploys, pays,
// deletes, closes apps or powers anything off; outbound work stays behind control_pc's own
// confirmation gate. Step states are persisted so a failure is named, not glossed over.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JarvisEvents } from "./jarvis-events";
import { sydneyParts } from "./jarvis-events";
import { ageWords, spokenTime, statusSentences, type StatusSnapshot } from "./jarvis-status";

export const PROTOCOLS = ["start-day", "call-mode", "end-call-mode", "shutdown"] as const;
export type ProtocolName = (typeof PROTOCOLS)[number];
export const PROTOCOL_LABELS: Record<ProtocolName, string> = {
  "start-day": "Start my day",
  "call-mode": "Call mode",
  "end-call-mode": "End call mode",
  shutdown: "Shutdown",
};
export function isProtocol(value: unknown): value is ProtocolName {
  return typeof value === "string" && (PROTOCOLS as readonly string[]).includes(value);
}

// --- voice rules -------------------------------------------------------------------------------

export type JarvisIntent = { kind: "status" } | { kind: "protocol"; name: ProtocolName };

/**
 * Deterministic, anchored phrases only: anything longer or unclear falls through to the other
 * rules, Jev and the brain. "Shut down my PC" is NOT the shutdown protocol (and the protocol
 * never powers off anyway).
 */
export function jarvisIntent(utterance: string): JarvisIntent | null {
  const u = utterance
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?,]+$/g, "")
    .replace(/^\s*(?:(?:okay|ok|right|alright)[,\s]+)?(?:hey\s+)?(?:jarvis[,\s]+)?/, "")
    .replace(/^(?:can you|could you|would you|will you|please|let's|lets)\s+/, "")
    .replace(/,?\s+(?:please|for me|now|jarvis|sir)$/g, "")
    .replace(/[,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!u || u.length > 60) return null;
  if (/^(?:give me (?:a |the |my )?|run (?:a |the )?|what's (?:the |my )?|what is (?:the |my )?)?(?:status|status report|status update|sitrep)$/.test(u)) return { kind: "status" };
  if (/^(?:what's|what is) next$|^how am i (?:going|doing|tracking)(?: today)?$/.test(u)) return { kind: "status" };
  if (/^(?:start|begin|kick off) (?:my|the) day$|^start of day$|^start-day protocol$/.test(u)) return { kind: "protocol", name: "start-day" };
  if (/^(?:end|exit|stop|leave|finish|turn off|switch off) call(?:ing)? mode$|^call(?:ing)? mode off$/.test(u)) return { kind: "protocol", name: "end-call-mode" };
  if (/^(?:start |enter |switch to |go into |turn on |switch on )?call(?:ing)? mode(?: on)?$/.test(u)) return { kind: "protocol", name: "call-mode" };
  if (/^(?:shut ?down|shutdown protocol|end (?:my|the) day|wrap up (?:my|the) day|end of day|close out (?:my|the) day)$/.test(u)) return { kind: "protocol", name: "shutdown" };
  return null;
}

// --- running them ------------------------------------------------------------------------------

export type StepState = "pending" | "done" | "failed" | "skipped";
export type Step = { id: string; label: string; state: StepState; detail?: string; at?: string; client?: boolean };
export type ProtocolRun = {
  id: string;
  name: ProtocolName;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  steps: Step[];
  said: string;
  navigate: string | null;
  card: { id: number; name: string; vertical: string; area?: string; phone?: string; opener?: string } | null;
};

export type ProtocolDeps = {
  status: () => Promise<StatusSnapshot>;
  events: Pick<JarvisEvents, "setCallMode" | "setQuiet">;
  /** Mission Control is optional in Settings; without it "start my day" opens Home. */
  missionControl: () => boolean;
  now?: () => number;
};

const MAX_RUNS = 20;

function greeting(at: number) {
  const hour = sydneyParts(at).hour;
  return hour < 12 ? "Good morning, sir." : hour < 17 ? "Good afternoon, sir." : "Good evening, sir.";
}

/** 07:00 Sydney on the next morning, as an ISO instant (quiet mode after shutdown). */
export function nextSydneyMorning(now: number, hour = 7) {
  // Walk forward in 15-minute steps to the first instant whose Sydney clock reads hour:00 on a
  // later date (or today, if it's still before that hour). DST-safe without a tz library.
  const today = sydneyParts(now);
  for (let t = now + 60_000; t < now + 48 * 3_600_000; t += 15 * 60_000) {
    const p = sydneyParts(t);
    if (p.hour === hour && p.minute < 15 && (p.date !== today.date || today.hour < hour))
      return new Date(t - p.minute * 60_000).toISOString().replace(/:\d\d\.\d{3}Z$/, ":00.000Z");
  }
  return new Date(now + 9 * 3_600_000).toISOString();
}

export function createJarvisProtocols(root: string, deps: ProtocolDeps) {
  const now = deps.now ?? Date.now;
  const directory = join(root, ".operator-data");
  const file = join(directory, "jarvis-protocols.json");

  function read(): ProtocolRun[] {
    try {
      if (!existsSync(file) || statSync(file).size > 256 * 1024) return [];
      const data = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(data?.runs) ? data.runs : [];
    } catch {
      return [];
    }
  }
  function persist(run: ProtocolRun) {
    const runs = read().filter((r) => r.id !== run.id);
    runs.push(run);
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runs: runs.slice(-MAX_RUNS) }, null, 1));
    renameSync(temporary, file);
  }

  async function run(body: unknown): Promise<ProtocolRun> {
    const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined;
    if (!isProtocol(name)) throw new Error(`Choose a protocol: ${PROTOCOLS.join(", ")}.`);
    const started = now();
    const record: ProtocolRun = {
      id: `pr_${started.toString(36)}`,
      name,
      label: PROTOCOL_LABELS[name],
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      ok: false,
      steps: [],
      said: "",
      navigate: null,
      card: null,
    };
    const lines: string[] = [];
    let halted = false;
    /** Run one server step; a failure halts the rest (they're recorded as skipped). */
    const step = async <T>(id: string, label: string, work: () => Promise<T> | T): Promise<T | undefined> => {
      const entry: Step = { id, label, state: "pending" };
      record.steps.push(entry);
      if (halted) {
        entry.state = "skipped";
        entry.detail = "an earlier step failed";
        return undefined;
      }
      try {
        const value = await work();
        entry.state = "done";
        entry.at = new Date(now()).toISOString();
        return value;
      } catch (error) {
        entry.state = "failed";
        entry.detail = ((error as Error)?.message || "failed").slice(0, 200);
        entry.at = new Date(now()).toISOString();
        halted = true;
        return undefined;
      }
    };
    /** A step the browser does (navigation); it reports back through /jarvis/protocol/step. */
    const clientStep = (id: string, label: string, path: string) => {
      record.steps.push({ id, label, state: halted ? "skipped" : "pending", client: true, ...(halted ? { detail: "an earlier step failed" } : {}) });
      if (!halted) record.navigate = path;
    };

    if (name === "start-day") {
      const mission = deps.missionControl();
      // Home is the OS's landing page (Today merged into it, 29 Sep 2026; "/today" still redirects there);
      // Mission Control only when he turned it on. The step names the page the way the OS does (J4).
      clientStep("open", mission ? "Open Mission Control" : "Open Home", mission ? "/dashboard" : "/today");
      const snapshot = await step("status", "Read the status snapshot", deps.status);
      if (snapshot) {
        lines.push(`${greeting(now())} ${statusSentences(snapshot, now()).join(" ")}`);
        const lead = snapshot.nextCall.ok ? snapshot.nextCall.data : null;
        await step("first-call", "Find the first call card", () => {
          if (!snapshot.nextCall.ok) throw new Error(snapshot.nextCall.error || "The call list isn't available.");
          return lead;
        });
        if (lead) {
          record.card = lead;
          lines.push(`First call on the list: ${lead.name}. The card is on screen; I won't dial.`);
        } else if (snapshot.nextCall.ok) lines.push("There's nobody on the call list right now.");
      }
    } else if (name === "call-mode") {
      await step("flag", "Turn on call mode (interjections held)", () => deps.events.setCallMode(true));
      clientStep("open", "Open Leads", "/leads");
      const lead = await step("next-lead", "Find the next lead", async () => {
        const snapshot = await deps.status();
        if (!snapshot.nextCall.ok) throw new Error(snapshot.nextCall.error || "The call list isn't available.");
        return snapshot.nextCall.data;
      });
      if (lead) record.card = lead;
      if (!halted)
        lines.push(
          `Call mode on; I'll hold interjections. ${lead ? `Next up: ${lead.name}${lead.area ? ` in ${lead.area}` : ""}. The number's on screen when you're ready; I won't dial.` : "The call list is empty, so there's nobody queued."}`,
        );
      else if (record.steps[0].state === "done") lines.push("Call mode on; I'll hold interjections.");
    } else if (name === "end-call-mode") {
      await step("flag", "Turn off call mode", () => deps.events.setCallMode(false));
      if (!halted) lines.push("Call mode off. Interjections are back on.");
    } else {
      const snapshot = await step("scorecard", "Read today's scorecard", deps.status);
      if (snapshot) {
        const at = now();
        const calls = snapshot.calls;
        if (calls.ok && calls.data) {
          const board = calls.data.founders.map((f) => `${f.who[0].toUpperCase()}${f.who.slice(1)} ${f.calls}${f.target ? ` of ${f.target}` : ""} calls`).join(", ");
          lines.push(`Today's scorecard: ${board || "no calls logged"}.`);
          lines.push(
            calls.data.followUpsDue
              ? `${calls.data.followUpsDue} follow-up${calls.data.followUpsDue === 1 ? "" : "s"} still outstanding, starting with ${calls.data.overdue!.name}.`
              : "No follow-ups outstanding.",
          );
        } else lines.push("The CRM isn't answering, so I have no scorecard.");
        const next = snapshot.next;
        if (!next.ok || !next.data) lines.push("I can't read tomorrow's calendar.");
        else if (next.data.tomorrowFirst)
          lines.push(
            `Tomorrow starts with ${next.data.tomorrowFirst.title} ${spokenTime(next.data.tomorrowFirst.start, at).replace(/^tomorrow /, "")}${next.stale ? `, as of a calendar sync ${ageWords(next.ageMs)} old` : ""}.`,
          );
        else lines.push(next.stale ? `Nothing booked for tomorrow as of a sync ${ageWords(next.ageMs)} old.` : "Nothing booked for tomorrow yet.");
      }
      const until = nextSydneyMorning(now());
      await step("quiet", "Turn on quiet mode until 7 am", () => deps.events.setQuiet({ on: true, until }));
      if (record.steps.find((s) => s.id === "quiet")?.state === "done")
        lines.push("Quiet mode is on until 7 am. I haven't closed anything or powered off.");
    }

    const failed = record.steps.find((s) => s.state === "failed");
    if (failed) lines.push(`${record.label} stopped at "${failed.label}": ${failed.detail}.`);
    record.ok = !record.steps.some((s) => s.state === "failed" || s.state === "skipped");
    record.said = lines.filter(Boolean).join(" ");
    record.finishedAt = record.steps.some((s) => s.client && s.state === "pending") ? null : new Date(now()).toISOString();
    persist(record);
    return record;
  }

  /** The browser reports its step (the page it opened, or why it couldn't). */
  function report(body: unknown) {
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (typeof input.runId !== "string" || typeof input.step !== "string" || typeof input.ok !== "boolean")
      throw new Error("Give runId, step and ok.");
    const runs = read();
    const record = runs.find((r) => r.id === input.runId);
    if (!record) throw new Error("That protocol run isn't on record.");
    const entry = record.steps.find((s) => s.id === input.step && s.client);
    if (!entry || entry.state !== "pending") throw new Error("That step isn't waiting for a report.");
    entry.state = input.ok ? "done" : "failed";
    entry.at = new Date(now()).toISOString();
    if (typeof input.detail === "string") entry.detail = input.detail.slice(0, 200);
    record.ok = !record.steps.some((s) => s.state === "failed" || s.state === "skipped");
    if (!record.steps.some((s) => s.state === "pending")) record.finishedAt = entry.at;
    persist(record);
    return record;
  }

  return { run, report, runs: () => read().slice(-5).reverse() };
}

export type JarvisProtocols = ReturnType<typeof createJarvisProtocols>;
