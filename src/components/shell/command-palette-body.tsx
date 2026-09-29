// The ONE command palette (Ctrl/⌘K): OS pages, named sections, package answers, projects, websites,
// authorised files, installed apps and CRM leads, ranked by the same resolver Jarvis uses
// (src/lib/commands/registry.ts). A device action shows its target device (resolveTarget via
// /__commands/target) BEFORE it can run, and runs through the Jarvis entry, which records the job.
// Lazy-loaded on the first open (command-palette.tsx), so it costs nothing on page load.
import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { AppWindow, AudioLines, Building2, Calculator, FileText, FolderKanban, Globe2, LayoutGrid, Loader2, MonitorSmartphone, Search, Sparkles, X } from "lucide-react";
import { buildCommandIndex, mayRunEntry, orderPaletteResults, planCommand, parseCommandText, resolveCommand, searchCommands, type DynamicSources } from "@/lib/commands/registry";
import { explainFromContext } from "@/lib/commands/jarvis-route";
import { actsOrPays } from "@/lib/commands/action-guard";
import type { CommandEntry, CommandKind, CommandSourceStatus, TargetPreview } from "@/lib/commands/types";
import { hasCommandClient, runTypedEntry, APPS_LOADING, cachedApps, focusAnchor, loadApps, loadProjects, loadSites, previewTarget, runDevicePlan, searchFiles, searchLeads, type DeviceRunEvent } from "@/lib/commands/client";
import { readPageContext } from "@/lib/page-context";
import { ruleAnswerFirst } from "@/lib/commands/rule-guard";
import { useSignedIn } from "./signed-in";
import { useOperator } from "@/lib/operator";
import { HONEST_LABEL } from "@/lib/honest-state";

const KIND: Record<CommandKind, { label: string; icon: typeof Search }> = {
  page: { label: "Page", icon: LayoutGrid },
  section: { label: "Section", icon: Sparkles },
  answer: { label: "Figure", icon: Calculator },
  project: { label: "Project", icon: FolderKanban },
  site: { label: "Website", icon: Globe2 },
  file: { label: "File", icon: FileText },
  app: { label: "App", icon: AppWindow },
  lead: { label: "Lead", icon: Building2 },
};

type Run = { entryId: string; steps: string[]; done: (DeviceRunEvent & { type: "done" }) | null };

export default function CommandPaletteBody({ open, onOpenChange, initialQuery = "" }: { open: boolean; onOpenChange: (open: boolean) => void; initialQuery?: string }) {
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [dynamic, setDynamic] = useState<DynamicSources>(() => ({ apps: cachedApps() ?? APPS_LOADING }));
  const [active, setActive] = useState("");
  const [preview, setPreview] = useState<{ key: string; value: TargetPreview | null }>({ key: "", value: null });
  const [run, setRun] = useState<Run | null>(null);
  const [waitNote, setWaitNote] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const runAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setQ(initialQuery);
      // Escape (or any close) returns focus to where he was (review item 11).
      const el = document.activeElement;
      returnFocus.current = el instanceof HTMLElement && el !== document.body && !el.closest(".cp-dialog") ? el : null;
    }
  }, [open, initialQuery]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 120);
    return () => window.clearTimeout(t);
  }, [q]);

  // The slow-changing sources, once per open.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadApps().then((apps) => live && setDynamic((d) => ({ ...d, apps })));
    void loadSites().then((sites) => live && setDynamic((d) => ({ ...d, sites })));
    void loadProjects().then((projects) => live && setDynamic((d) => ({ ...d, projects })));
    return () => {
      live = false;
    };
  }, [open]);

  // Query-driven sources: CRM leads and authorised files (names only).
  const object = parseCommandText(debounced).object;
  useEffect(() => {
    if (!open) return;
    if (object.length < 2) {
      setDynamic((d) => ({ ...d, leads: undefined, files: undefined }));
      return;
    }
    const ctl = new AbortController();
    void searchLeads(object, ctl.signal).then((leads) => setDynamic((d) => ({ ...d, leads }))).catch(() => undefined);
    void searchFiles(object, ctl.signal).then((files) => setDynamic((d) => ({ ...d, files }))).catch(() => undefined);
    return () => ctl.abort();
  }, [open, object]);

  const { state: operatorState } = useOperator();
  const navSettings = operatorState.settings;
  const index = useMemo(() => buildCommandIndex(dynamic, Date.now(), { settings: navSettings }), [dynamic, navSettings]);
  const context = open ? readPageContext() : null;
  // Rules answer first (Track 2), and money, action and compound words are never cut to a plain open
  // (REVIEW-T1 fix 2): both get "Ask Jarvis" first, which sends his words whole to the gated path. For
  // money or action words, device and site entries are not offered at all.
  const ruleKind = useMemo(() => (q.trim() ? ruleAnswerFirst(q) : null), [q]);
  const gate = useMemo(() => (q.trim() ? actsOrPays(q) : null), [q]);
  const askEntry: CommandEntry | null =
    ruleKind || gate
      ? {
          id: "rule:ask-jarvis",
          kind: "answer",
          title: `Ask Jarvis: “${q.trim().slice(0, 80)}”`,
          detail: ruleKind
            ? `Answered by Jarvis's ${ruleKind} rules, with its source`
            : gate === "money"
              ? "Goes to Jarvis whole, money words and all (paying, buying and transfers are never done without you)"
              : gate === "action"
                ? "Goes to Jarvis whole: sending, deleting, pressing and publishing need your spoken yes"
                : "Goes to Jarvis whole, every part of it (not just the first thing named)",
          phrases: [],
          action: { type: "navigate", to: "/jarvis" },
          source: "static",
        }
      : null;
  // Page context (review item 9): "explain this margin" answers from the figures on this page; "open that
  // call" resolves to the focused or only call, or says which it can't tell (never a guess).
  const contextEntry: CommandEntry | null = useMemo(() => {
    if (!q.trim() || !context) return null;
    const explained = explainFromContext(q, context);
    if (explained) {
      const state = context.sources.find((src) => src.state)?.state ?? "unknown";
      return { id: "context:explain", kind: "answer", title: "Explain this", detail: context.page?.title ?? "This page", phrases: [], action: { type: "navigate", to: context.page?.path ?? "/today" }, source: "static", answer: { headline: explained.said, figures: [], source: (explained.kind === "explain" ? explained.source : null) ?? "this page's own figures", state } };
    }
    const r = resolveCommand(q, index, { context });
    if (!r.parsed.deictic) return null;
    if (r.status === "resolved") return r.entry;
    const said = r.status === "ambiguous" ? r.ask : r.reason;
    return { id: "context:ask", kind: "section", title: "Which one?", detail: said, phrases: [], action: { type: "navigate", to: context.page?.path ?? "/today" }, source: "static" };
  }, [q, index, context]);
  const results = useMemo(() => {
    const obj = parseCommandText(q).object;
    const found = searchCommands(q, index, 40, context).filter((f) =>
      gate === "money" || gate === "action" ? f.entry.action.type !== "device" && f.entry.action.type !== "open-url" : mayRunEntry(f, obj),
    );
    return orderPaletteResults(q, found, index, { context: contextEntry, ask: askEntry });
    // askEntry derives from q, ruleKind and gate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, index, context, ruleKind, gate, contextEntry]);
  const parsed = useMemo(() => parseCommandText(q), [q]);
  const activeEntry = results.find((r) => r.entry.id === active)?.entry ?? results[0]?.entry ?? null;

  // A device entry shows where it would run before anything runs.
  const previewKey = activeEntry && activeEntry.action.type === "device" ? `${activeEntry.id}|${parsed.spokenTarget ?? ""}` : "";
  useEffect(() => {
    if (!previewKey) return;
    if (preview.key === previewKey && preview.value) return;
    setPreview({ key: previewKey, value: null });
    const ctl = new AbortController();
    void previewTarget(parsed.spokenTarget, ctl.signal)
      .then((value) => setPreview({ key: previewKey, value }))
      .catch(() => undefined);
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  useEffect(() => {
    if (!open) {
      runAbort.current?.abort();
      setRun(null);
      setActive("");
    }
  }, [open]);

  const shownPreview = preview.key === previewKey ? preview.value : null;
  useEffect(() => {
    if (shownPreview) setWaitNote("");
  }, [shownPreview]);
  const unavailable = index.sources.filter((s) => s.state !== "live" && s.state !== "simulated" && !(s.state === "unknown" && (s.id === "files" || s.id === "leads") && object.length < 2));

  async function choose(entry: CommandEntry) {
    if (entry.id === "rule:ask-jarvis") {
      const words = q.trim();
      if (!hasCommandClient()) {
        // This build has no command client for rule answers: Jarvis in Text mode runs the same turn as speech.
        onOpenChange(false);
        window.dispatchEvent(new CustomEvent("operator:voice-text", { detail: { request: words } }));
        return;
      }
      runAbort.current?.abort();
      const ctl = new AbortController();
      runAbort.current = ctl;
      setRun({ entryId: entry.id, steps: [], done: null });
      await runTypedEntry(words, { signal: ctl.signal, onEvent: (e) => setRun((r) => (r && r.entryId === entry.id ? (e.type === "step" ? { ...r, steps: [...r.steps, e.text].slice(-4) } : { ...r, done: e }) : r)) });
      return;
    }
    if (entry.id === "context:explain" || entry.id === "context:ask") return; // the answer or question is on screen
    const plan = planCommand(entry, parsed, { personId: signedIn?.id || undefined });
    if (plan.kind === "navigate") {
      onOpenChange(false);
      await navigate({ to: plan.to as never, search: (plan.search ?? {}) as never });
      if (plan.focus) focusAnchor(plan.focus);
      return;
    }
    if (plan.kind === "open-url") {
      window.open(plan.url, "_blank", "noopener,noreferrer");
      onOpenChange(false);
      return;
    }
    // Device: only once its target has been shown for THIS entry, and only if it resolved (REVIEW-T1 fix 3).
    // While it still says "Checking which device", Enter waits: nothing runs on an unseen device.
    const target = shownPreview;
    if (!target) {
      setWaitNote(entry.id);
      return;
    }
    if (!target.ok) {
      setRun({ entryId: entry.id, steps: [], done: { type: "done", ok: false, said: `Not run: ${target.reason}` } });
      return;
    }
    runAbort.current?.abort();
    const ctl = new AbortController();
    runAbort.current = ctl;
    setRun({ entryId: entry.id, steps: [], done: null });
    await runDevicePlan(plan, (e) => setRun((r) => (r && r.entryId === entry.id ? (e.type === "step" ? { ...r, steps: [...r.steps, e.text].slice(-4) } : { ...r, done: e }) : r)), ctl.signal);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="cp-overlay" />
        <DialogPrimitive.Content
          className="cp-dialog"
          onCloseAutoFocus={(e) => {
            // Where he was, or the header's "Go to…" trigger when he opened it from nowhere (Ctrl+K on the page).
            const back = returnFocus.current?.isConnected ? returnFocus.current : document.querySelector<HTMLElement>(".cp-trigger");
            if (back && back.isConnected) {
              e.preventDefault();
              back.focus();
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          {/* The dialog's description (Radix links it as aria-describedby; audit P2-9). */}
          <DialogPrimitive.Description className="sr-only">
            Type a page, project, website, file, app or lead. Arrow keys move, Enter opens. A device action shows the device it will run on first.
          </DialogPrimitive.Description>
          <Command shouldFilter={false} value={activeEntry?.id ?? ""} onValueChange={setActive} loop label="Command palette" className="cp-command">
            <div className="cp-input-row">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Command.Input value={q} onValueChange={setQ} placeholder="Open a page, project, site, file or app…" className="cp-input" aria-label="Command" />
              <kbd className="cp-kbd" aria-hidden="true">Esc</kbd>
              <DialogPrimitive.Close className="cp-close" aria-label="Close command palette">
                <X className="h-4 w-4" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <div className="cp-body">
              <Command.List className="cp-list" aria-label="Results">
                <Command.Empty className="cp-empty">
                  {q.trim() ? <>Nothing matches “{q.trim()}”.</> : "Start typing."}
                  {unavailable.some((s) => s.id === "apps") && (parsed.verb === "launch" || !!parsed.spokenTarget) ? <span className="block pt-1 text-xs">{unavailable.find((s) => s.id === "apps")?.reason}</span> : null}
                </Command.Empty>
                {!q.trim() && <div className="cp-group-label">Pages</div>}
                {results.map(({ entry }) => {
                  const k = entry.id === "rule:ask-jarvis" ? { label: "Jarvis", icon: AudioLines } : KIND[entry.kind];
                  return (
                    <Command.Item key={entry.id} value={entry.id} onSelect={() => void choose(entry)} className="cp-item">
                      <k.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{entry.title}</span>
                        {entry.detail && <span className="block truncate text-xs text-muted-foreground">{entry.detail}</span>}
                      </span>
                      <span className="cp-kind">{k.label}</span>
                    </Command.Item>
                  );
                })}
              </Command.List>
              <aside className="cp-detail" aria-live="polite" aria-label="Selected command">
                {activeEntry ? <Detail entry={activeEntry} preview={activeEntry.action.type === "device" ? shownPreview : null} previewing={activeEntry.action.type === "device" && !shownPreview} run={run?.entryId === activeEntry.id ? run : null} spokenTarget={parsed.spokenTarget} waiting={waitNote === activeEntry.id} /> : <p className="text-sm text-muted-foreground">Nothing selected.</p>}
              </aside>
            </div>
            <SourceFooter sources={unavailable} />
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Detail({ entry, preview, previewing, run, spokenTarget, waiting }: { entry: CommandEntry; preview: TargetPreview | null; previewing: boolean; run: Run | null; spokenTarget?: string; waiting?: boolean }) {
  const k = entry.id === "rule:ask-jarvis" ? { label: "Jarvis", icon: AudioLines } : KIND[entry.kind];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="cp-eyebrow">{k.label}</p>
        <p className="cp-detail-title">{entry.title}</p>
        {entry.detail && <p className="text-xs text-muted-foreground">{entry.detail}</p>}
      </div>
      {entry.answer && (
        <div className="cp-answer">
          <p className="text-sm text-foreground">{entry.answer.headline}</p>
          <dl className="cp-figures">
            {entry.answer.figures.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            <span className="cp-state" data-state={entry.answer.state}>{HONEST_LABEL[entry.answer.state]}</span> · {entry.answer.source}
          </p>
          {entry.answer.caveat && <p className="text-xs text-muted-foreground">{entry.answer.caveat}</p>}
        </div>
      )}
      {entry.action.type === "device" && (
        <div className="cp-target" data-ok={preview ? String(preview.ok) : undefined}>
          <MonitorSmartphone className="h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Runs on{spokenTarget ? ` (“${spokenTarget}”)` : ""}</p>
            {previewing ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Checking which device…
              </p>
            ) : preview?.ok ? (
              <p className="text-sm text-foreground">
                {preview.label} <span className="text-xs text-muted-foreground">· online · {preview.owner}</span>
              </p>
            ) : (
              <p className="text-sm text-danger">{preview?.reason ?? "Unknown device."} Nothing will run.</p>
            )}
          </div>
        </div>
      )}
      {waiting && previewing && (
        <p className="text-xs text-warn" role="status">
          Nothing runs until the device is shown. Press Enter again once it appears.
        </p>
      )}
      {run && (
        <div className="cp-run" role="status">
          {run.steps.map((s, i) => (
            <p key={i} className="text-xs text-muted-foreground">{s}</p>
          ))}
          {run.done ? (
            <p className={run.done.ok ? "text-sm text-foreground" : "text-sm text-danger"}>{run.done.said}</p>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Running through Jarvis…
            </p>
          )}
          {/* Only when a job was actually created (REVIEW-T1 fix 4); a refusal before the run records nothing. */}
          {run.done?.runId && <p className="text-xs text-muted-foreground">Recorded in the job history (Jarvis → Activity).</p>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <kbd className="cp-kbd">Enter</kbd> {entry.id === "rule:ask-jarvis" ? "asks Jarvis" : entry.action.type === "device" ? "runs it on that device" : entry.action.type === "open-url" ? "opens the site in a new tab" : "opens it"}
      </p>
    </div>
  );
}

function SourceFooter({ sources }: { sources: CommandSourceStatus[] }) {
  if (!sources.length) return null;
  return (
    <div className="cp-footer" role="note" aria-label="Sources not available">
      {sources.map((s) => (
        <p key={s.id} className="text-xs text-muted-foreground">
          <span className="cp-state" data-state={s.state}>{HONEST_LABEL[s.state]}</span> {s.label}
          {s.reason ? `: ${s.reason}` : ""}
        </p>
      ))}
    </div>
  );
}
