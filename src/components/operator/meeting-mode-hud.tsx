import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Ear, Lightbulb, Loader2, NotebookPen, Square, X } from "lucide-react";
import { clock } from "@/lib/meeting-words";
import {
  answerConsent,
  closeMeetingPanel,
  coachGranola,
  endMeeting,
  keepMeetingTranscript,
  logNotesToLead,
  meetingView,
  openLastNotes,
  setMeetingCues,
  setMeetingPip,
  startMeeting,
  stopMeeting,
  submitDebrief,
  subscribeMeeting,
  type MeetingNotesView,
  type MeetingView,
} from "@/lib/meeting-mode";
import { fmtDay } from "@/lib/format";

/**
 * Meeting mode (docs/MEETING-MODE.md). The header control arms it or, while it's on, shows the
 * always-visible "listening · 12:34" pill with Stop. The panel walks the consent gate, shows
 * optional cue cards during the call, and the notes and coaching afterwards.
 */
function useMeeting() {
  const [v, setV] = useState<MeetingView>(() => meetingView());
  useEffect(() => subscribeMeeting(setV), []);
  return v;
}

function useElapsed(startedAt: number | null, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return startedAt && on ? now - startedAt : 0;
}

export function MeetingModeControl({ labels = "xl" }: { labels?: "xl" | "always" } = {}) {
  const v = useMeeting();
  const listening = v.phase === "listening";
  const elapsed = useElapsed(v.startedAt, listening);
  if (listening)
    return (
      <div
        className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 py-1 pl-2.5 pr-1 text-[11px] text-red-300"
        role="status"
        aria-live="polite"
        title="Meeting mode is listening (the other party agreed). Nothing is recorded to disk."
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
        <button className="tabular-nums" onClick={() => window.dispatchEvent(new CustomEvent("jarvis:meeting-open"))}>
          listening · {clock(elapsed)}
        </button>
        <button className="ml-1 rounded-full p-1 hover:bg-white/10" onClick={() => void stopMeeting()} title="Stop now and keep nothing">
          <Square className="h-3 w-3" />
        </button>
      </div>
    );
  return (
    <button
      className="op-header-ask inline-flex items-center gap-1.5"
      onClick={() => window.dispatchEvent(new CustomEvent("jarvis:meeting-open"))}
      aria-label="Meeting mode"
      title="Meeting mode: Jarvis takes notes on a consented call and coaches you afterwards"
    >
      <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" />
      <span className={labels === "always" ? "" : "hidden xl:inline"}>Meeting</span>
    </button>
  );
}

const btn = "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const primary = `${btn} bg-primary text-primary-foreground`;
const quiet = `${btn} text-muted-foreground hover:text-foreground`;
const input = "w-full rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs text-foreground";
const CATEGORY: Record<string, [string, number]> = {
  opener: ["Opener", 15], discovery: ["Discovery", 25], value: ["Value & fit", 15], objection: ["Objections", 20], nextStep: ["Next step", 20], delivery: ["Delivery", 5],
};

function Notes({ n, markdown }: { n: MeetingNotesView; markdown: string }) {
  const [lead, setLead] = useState("");
  const [copied, setCopied] = useState("");
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => setCopied(what)).catch(() => undefined);
  const list = (items: string[], none = "None noted.") => (items.length ? <ul className="ml-4 list-disc space-y-0.5">{items.map((i, k) => <li key={k}>{i}</li>)}</ul> : <p className="text-muted-foreground">{none}</p>);
  return (
    <div className="space-y-3 text-xs leading-relaxed">
      <div>
        <div className="text-sm font-medium text-foreground">{n.title}</div>
        <div className="text-muted-foreground">
          {fmtDay(new Date(n.at), { year: true, timeZone: "Australia/Sydney" })} · {n.source === "meeting" ? "meeting mode" : n.source === "granola" ? "Granola" : "your debrief"}
          {n.durationMs ? ` · ${Math.max(1, Math.round(n.durationMs / 60000))} min` : ""}
        </div>
      </div>
      <p className="rounded-md bg-primary/10 p-2 text-foreground">{n.recap}</p>
      <section>
        <h4 className="mb-1 font-medium text-foreground">Summary</h4>
        <p><span className="text-muted-foreground">Who:</span> {n.summary.who || "Not clear."}</p>
        <div className="mt-1 text-muted-foreground">Needs</div>
        {list(n.summary.needs)}
        <div className="mt-1 text-muted-foreground">Objections</div>
        {list(n.summary.objections.map((o) => `${o.tag ? `[${o.tag}] ` : ""}${o.said}${o.handled ? ` (handled: ${o.handled})` : ""}`), "None raised.")}
        <div className="mt-1 text-muted-foreground">Decisions</div>
        {list(n.summary.decisions)}
        <div className="mt-1 text-muted-foreground">Next steps</div>
        {list(n.summary.nextSteps.map((s) => `${s.what}${s.who ? ` (${s.who})` : ""}${s.when ? ` · ${s.when}` : ""}`), "None secured.")}
      </section>
      <section>
        <h4 className="mb-1 font-medium text-foreground">CRM</h4>
        <p>
          {n.crm.outcome || "no outcome"}
          {n.crm.next ? ` · next ${n.crm.next}` : ""} · {n.crm.applied ? <span className="text-emerald-400">{n.crm.detail}</span> : <span className="text-amber-300">{n.crm.detail || "not logged"}</span>}
        </p>
        {!n.crm.applied && (
          <form className="mt-1 flex gap-2" onSubmit={(e) => (e.preventDefault(), lead.trim() && void logNotesToLead(lead.trim()))}>
            <input className={input} placeholder="Lead number or name" value={lead} onChange={(e) => setLead(e.target.value)} />
            <button className={primary} type="submit">Log</button>
          </form>
        )}
      </section>
      <section>
        <h4 className="mb-1 font-medium text-foreground">Coaching · {n.coaching.score}/100</h4>
        <div className="space-y-1">
          {Object.entries(CATEGORY).map(([key, [label, max]]) => {
            const got = n.coaching.categories[key];
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  {got !== undefined && <span className="block h-full rounded-full bg-primary" style={{ width: `${(got / max) * 100}%` }} />}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums">{got !== undefined ? `${got}/${max}` : "not observed"}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-2 text-muted-foreground">What went well</div>
        {list(n.coaching.wentWell)}
        <div className="mt-2 text-muted-foreground">The 3 highest-impact fixes</div>
        <ol className="ml-4 list-decimal space-y-1.5">
          {n.coaching.fixes.map((f, k) => (
            <li key={k}>
              <span className="text-foreground">{f.issue}</span>
              {f.framework && <span className="text-muted-foreground"> · {f.framework}</span>}
              <div className="mt-0.5 rounded bg-muted/50 px-2 py-1 italic">Say instead: “{f.betterLine}”</div>
            </li>
          ))}
        </ol>
        {n.coaching.frameworks.length > 0 && (
          <>
            <div className="mt-2 text-muted-foreground">Frameworks</div>
            {list(n.coaching.frameworks)}
          </>
        )}
      </section>
      <section>
        <h4 className="mb-1 font-medium text-foreground">Follow-ups (drafts, nothing sent)</h4>
        {n.followUps.length ? (
          <ul className="space-y-1.5">
            {n.followUps.map((f, k) => (
              <li key={k} className="rounded border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <span>{f.task}{f.due ? ` · due ${f.due}` : ""}</span>
                  {f.draft && (
                    <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => copy(f.draft, `draft-${k}`)} title="Copy the draft">
                      {copied === `draft-${k}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                {f.draft && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{f.draft}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None.</p>
        )}
      </section>
      <div className="flex items-center justify-between border-t border-border pt-2">
        <span className="text-muted-foreground">On Telegram: “notes from my last call”.</span>
        <button className={quiet} onClick={() => copy(markdown, "all")}>{copied === "all" ? "Copied" : "Copy notes"}</button>
      </div>
    </div>
  );
}

export function MeetingModePanel() {
  const v = useMeeting();
  const [lead, setLead] = useState("");
  // Started from a lead (the drawer's Start call): prefill its field (AUDIT-F1 F1-04).
  useEffect(() => {
    if (v.leadRef) setLead((current) => current || v.leadRef);
  }, [v.leadRef]);
  const [debrief, setDebrief] = useState("");
  const [mounted, setMounted] = useState(false);
  const elapsed = useElapsed(v.startedAt, v.phase === "listening");
  useEffect(() => setMounted(true), []);
  const [showIdle, setShowIdle] = useState(false);
  useEffect(() => {
    const show = () => setShowIdle(true);
    window.addEventListener("jarvis:meeting-open", show);
    return () => window.removeEventListener("jarvis:meeting-open", show);
  }, []);
  if (!mounted) return null;
  const visible = v.open || showIdle || v.phase === "listening" || v.phase === "consent" || v.phase === "summarising";
  if (!visible) return null;
  const close = () => {
    setShowIdle(false);
    closeMeetingPanel();
  };

  return createPortal(
    <aside
      className="fixed bottom-4 left-4 z-[70] flex max-h-[min(80vh,720px)] w-[380px] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-md"
      aria-label="Meeting mode"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {v.phase === "listening" ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden /> : <NotebookPen className="h-4 w-4" />}
          {v.phase === "listening" ? <span className="tabular-nums">Listening · {clock(elapsed)}</span> : "Meeting mode"}
        </div>
        {!["listening", "consent", "summarising"].includes(v.phase) && (
          <button className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={close} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        )}
      </header>
      <div className="overflow-y-auto px-4 py-3 text-xs">
        {v.error && <p className="mb-2 rounded-md bg-red-500/10 p-2 text-red-300">{v.error}</p>}

        {v.phase === "idle" && (
          <div className="space-y-3">
            <p className="leading-relaxed text-muted-foreground">
              Arm it before you dial. Nothing is captured until you confirm the other person agreed. Jarvis stays silent during the call,
              then gives you notes and coaching. Audio never touches the disk; the transcript is discarded after the summary.
            </p>
            <input className={input} placeholder="Lead number or name (optional)" value={lead} onChange={(e) => setLead(e.target.value)} />
            <button className={primary} disabled={v.busy} onClick={() => void startMeeting(lead.trim() || undefined)}>
              Arm meeting mode
            </button>
            <div className="border-t border-border pt-3">
              <div className="mb-1 text-muted-foreground">No capture? Debrief instead, in your own words:</div>
              <textarea className={`${input} h-20`} value={debrief} onChange={(e) => setDebrief(e.target.value)} placeholder="Spoke to Sarah, the practice manager. They miss calls at lunch…" />
              <div className="mt-1 flex flex-wrap gap-2">
                <button className={primary} disabled={v.busy || debrief.trim().length < 12} onClick={() => void submitDebrief(debrief.trim(), lead.trim() || undefined)}>
                  Coach my debrief
                </button>
                <button className={quiet} disabled={v.busy} onClick={() => void coachGranola("", lead.trim() || undefined)}>Coach last Granola meeting</button>
                <button className={quiet} disabled={v.busy} onClick={() => void openLastNotes()}>Last call's notes</button>
              </div>
            </div>
          </div>
        )}

        {v.phase === "consent" && (
          <div className="space-y-3">
            <p className="text-muted-foreground">Not listening yet{v.lead ? ` · ${v.lead.name}` : v.leadRef ? ` · ${v.leadRef} (not in the CRM)` : ""}. Say this to them first:</p>
            <blockquote className="rounded-md border-l-2 border-primary bg-primary/10 p-3 text-sm text-foreground">{v.script}</blockquote>
            <p className="text-muted-foreground">
              {v.captureMode === "two-channel"
                ? "Two-channel capture is ready: mic and system audio separately, so cue cards know who's talking. Headphones recommended, so the mic doesn't also pick up their voice."
                : "Mixed audio (one mic, or system loopback isn't available here) — this still works, but speaker isn't known, so cloud cues will abstain."}
            </p>
            <p className="text-muted-foreground">Then tell Jarvis "they agreed" or "they said no", or press:</p>
            <div className="flex gap-2">
              <button className={primary} disabled={v.busy} onClick={() => void answerConsent("agreed")}>They agreed</button>
              <button className={`${btn} border border-border text-foreground`} disabled={v.busy} onClick={() => void answerConsent("declined")}>They said no</button>
              <button className={quiet} onClick={() => void stopMeeting()}>Cancel</button>
            </div>
          </div>
        )}

        {v.phase === "listening" && (
          <div className="space-y-3">
            {v.captureMode === "two-channel" ? (
              <div className="space-y-1 text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Ear className="h-3.5 w-3.5" />
                  <span className="w-14 shrink-0">Me</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-sky-400 transition-[width]" style={{ width: `${Math.round(v.levels.me * 100)}%` }} />
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="w-14 shrink-0">Prospect</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-red-400 transition-[width]" style={{ width: `${Math.round(v.levels.prospect * 100)}%` }} />
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Two-channel capture — speaker labels are real</span>
                  <span className="tabular-nums">{v.chunks} chunks{v.sttAvgMs ? ` · ${(v.sttAvgMs / 1000).toFixed(1)} s` : ""}</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Ear className="h-3.5 w-3.5" />
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-red-400 transition-[width]" style={{ width: `${Math.round(v.level * 100)}%` }} />
                </span>
                <span className="tabular-nums">{v.chunks} chunks{v.sttAvgMs ? ` · ${(v.sttAvgMs / 1000).toFixed(1)} s` : ""}</span>
              </div>
            )}
            {v.captureMode === "mixed" && v.cloudCuesOptIn && (
              <p className="text-muted-foreground">
                Mixed audio (one mic) — speaker isn't known, so cloud cues will abstain. For live objection cues, take the call on this PC with
                loopback available, or wear headphones so the mic only hears you.
              </p>
            )}
            {v.silencePrompt && <p className="rounded-md bg-amber-500/10 p-2 text-amber-200">It's gone quiet. Has the call finished?</p>}
            {v.cuesOn && (
              <div className="space-y-1.5">
                {v.cues.length ? (
                  v.cues.map((c) => (
                    <div key={c.tag} className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2">
                      <div className="flex items-center gap-1 font-medium text-amber-200"><Lightbulb className="h-3.5 w-3.5" />{c.title}</div>
                      <div className="mt-0.5 text-foreground">{c.line}</div>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">Cue cards appear here when they raise price, timing, “send me info” and so on.</p>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={v.cuesOn} onChange={(e) => void setMeetingCues(e.target.checked)} /> Cue cards</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={v.pip} onChange={(e) => setMeetingPip(e.target.checked)} /> Minute pip</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={v.keepTranscript} disabled={v.keepTranscript} onChange={() => void keepMeetingTranscript()} /> Keep transcript</label>
            </div>
            <div className="flex gap-2">
              <button className={primary} onClick={() => void endMeeting()}>End meeting</button>
              <button className={`${btn} border border-red-500/40 text-red-300`} onClick={() => void stopMeeting()} title="Stop now; nothing from this call is kept">
                Stop (keep nothing)
              </button>
            </div>
            <p className="text-muted-foreground">Or say “Jarvis, end meeting” / “Jarvis, stop”.</p>
          </div>
        )}

        {v.phase === "summarising" && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Writing up your notes and coaching…</p>
        )}

        {v.phase === "failed" && (
          <div className="space-y-2">
            <p className="text-muted-foreground">The notes couldn't be written. The transcript is still in memory only.</p>
            <div className="flex gap-2">
              <button className={primary} onClick={() => void endMeeting()}>Try again</button>
              <button className={quiet} onClick={() => void stopMeeting()}>Discard</button>
            </div>
          </div>
        )}

        {v.phase === "declined" && (
          <div className="space-y-2">
            <p className="text-muted-foreground">Nothing was captured. After the call, tell Jarvis how it went (“debrief: …”) or type it here:</p>
            <textarea className={`${input} h-24`} value={debrief} onChange={(e) => setDebrief(e.target.value)} />
            <button className={primary} disabled={v.busy || debrief.trim().length < 12} onClick={() => void submitDebrief(debrief.trim(), v.lead ? String(v.lead.id) : undefined)}>
              Coach my debrief
            </button>
          </div>
        )}

        {v.phase === "done" && v.notes && <Notes n={v.notes} markdown={v.markdown} />}
        {v.phase === "done" && !v.notes && !v.busy && <p className="text-muted-foreground">No notes this time.</p>}
      </div>
    </aside>,
    document.body,
  );
}
