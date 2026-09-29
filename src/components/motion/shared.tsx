/** Shared pieces for Motion Library: the runner hook, RISE view, brand marks, "Open in". */
import claudeMark from "@/assets/logo-claude.svg?raw";
import openaiMark from "@/assets/logo-openai.svg?raw";
import codexLogo from "@/assets/logos/codex.png";
import { motionTargetPrompt, type MotionTarget } from "@/motion/engine/launch";
import { MotionRunner } from "@/motion/engine/runner";
import { parseRise, RISE_LABELS, type PromptAsset, type RiseKey } from "@/motion/engine/prompt";
import { Check, ChevronDown, Copy, FolderOpen, Loader2, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, chatgptUrl, copyText, WORDS, type Status, type Tool } from "./api";

/** One runner per page, created lazily on the client (children mount first). */
export function useRunner() {
  const ref = useRef<MotionRunner | null>(null);
  const ensure = useCallback(() => {
    if (!ref.current) ref.current = new MotionRunner({ budgetMs: 9 });
    return ref.current;
  }, []);
  useEffect(
    () => () => {
      ref.current?.destroy();
      ref.current = null;
    },
    [],
  );
  return ensure;
}

const svgMark = (raw: string) =>
  raw.replace(/<title>[^<]*<\/title>/, "").replace(/<path /g, '<path fill="currentColor" ');

export function ClaudeMark({ className = "ml-mark ml-mark-claude" }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svgMark(claudeMark) }}
    />
  );
}
export function OpenAIMark({ className = "ml-mark ml-mark-openai" }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svgMark(openaiMark) }}
    />
  );
}
export function CodexMark({ className = "ml-mark ml-mark-codex" }: { className?: string }) {
  return <img className={className} src={codexLogo} alt="" aria-hidden="true" />;
}

export function RiseView({ text }: { text: string }) {
  const parts = parseRise(text);
  return (
    <div className="ml-rise">
      {(Object.keys(RISE_LABELS) as RiseKey[]).map((key) =>
        parts[key] ? (
          <section key={key}>
            <header>
              <b>{key}</b>
              <span>{RISE_LABELS[key]}</span>
            </header>
            <pre>{parts[key]}</pre>
          </section>
        ) : null,
      )}
    </div>
  );
}

export type Notify = (message: string) => void;

export type Target = MotionTarget;
export const TARGETS: { id: Target; label: string; hint: string }[] = [
  { id: "claude-code", label: "Claude · Opus 5.5", hint: "local Claude Code, model pinned" },
  { id: "chatgpt", label: "ChatGPT", hint: "handoff to local Claude Code · Opus 5.5" },
  { id: "codex", label: "Codex / Astra", hint: "delegates graphics to Claude Code · Opus 5.5" },
];

export function TargetMark({ target }: { target: Target }) {
  if (target === "chatgpt") return <OpenAIMark />;
  if (target === "codex") return <CodexMark />;
  return <ClaudeMark />;
}

/** The "Open in" picker: pinned Claude Code, ChatGPT handoff, or Astra coordinator. */
export function OpenInPicker({
  value,
  onChange,
  status,
  compact = false,
}: {
  value: Target;
  onChange: (t: Target) => void;
  status: Status | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = TARGETS.find((t) => t.id === value) ?? TARGETS[0];
  const missing = (t: Target) =>
    (t === "claude-code" && status && !status.claudeCli) ||
    (t === "codex" && status && !status.codex);
  return (
    <div className="ml-openin" ref={box}>
      <button
        type="button"
        className="ml-openin-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Where the prompt goes"
      >
        {!compact && <span className="ml-openin-label">Open in</span>}
        <TargetMark target={current.id} />
        <span>{current.label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ml-menu up right" role="listbox" aria-label="Open in">
          {TARGETS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={t.id === value}
              className="ml-menu-item"
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
            >
              <TargetMark target={t.id} />
              <span>
                <b>{t.label}</b>
                <small>{missing(t.id) ? "Not installed on this computer" : t.hint}</small>
              </span>
              {t.id === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Copy prompt + "Open in <target>". ChatGPT receives a browser handoff. Claude
 * (including the legacy "claude" target) and Codex show the exact pinned CLI
 * command first and only run it on click.
 */
export function OpenActions({
  name,
  prompt,
  assets,
  target,
  status,
  notify,
  size = "normal",
}: {
  name: string;
  prompt: string;
  assets: PromptAsset[];
  target: Target;
  status: Status | null;
  notify: Notify;
  size?: "normal" | "large";
}) {
  const [copied, setCopied] = useState(false);
  const [run, setRun] = useState<null | {
    tool: Tool;
    command: string;
    display: string;
    folder?: string;
    dryRun: boolean;
    terminal: boolean;
    state: "ready" | "running" | "done" | "error";
    message?: string;
  }>(null);
  useEffect(() => {
    setRun(null);
    setCopied(false);
  }, [target, prompt]);
  const handoffPrompt = motionTargetPrompt(prompt, target);
  const label = TARGETS.find((t) => t.id === target)?.label ?? TARGETS[0].label;
  const assetNote = assets.length
    ? ` Attach ${assets.map((a) => a.name).join(", ")} from ~/motion-studio-projects/assets.`
    : "";

  const copy = async () => {
    const ok = await copyText(handoffPrompt);
    setCopied(ok);
    notify(
      ok
        ? "Execution prompt copied."
        : "Couldn't reach the clipboard. Expand Execution prompt below and copy it.",
    );
    if (ok) setTimeout(() => setCopied(false), 1600);
  };

  const open = async () => {
    if (target === "chatgpt") {
      const ok = await copyText(handoffPrompt);
      const url = chatgptUrl(handoffPrompt);
      window.open(url, "_blank", "noopener,noreferrer");
      const modelNote =
        " The prompt requires local Claude Code with Opus 5.5; the browser cannot enforce or run that CLI.";
      notify(
        ok
          ? `Prompt copied and opened in ${label}. If the box is empty, paste it (${WORDS.paste}).${modelNote}${assetNote}`
          : `Opened ${label}. Copy the Execution prompt below and paste it.${modelNote}${assetNote}`,
      );
      return;
    }
    const tool: Tool = target === "codex" ? "codex" : "claude";
    if (run && run.tool === tool) return setRun(null);
    try {
      const plan = await api.launchPreview(name, tool);
      setRun({ ...plan, state: "ready" });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't plan the project folder.");
    }
  };

  const doRun = async () => {
    if (!run) return;
    setRun({ ...run, state: "running" });
    try {
      const r = await api.launch(name, prompt, assets, run.tool);
      setRun({
        ...run,
        display: r.display,
        folder: r.folder,
        command: r.command,
        state: "done",
        message: r.launched
          ? `Opened ${WORDS.terminal} in ${r.display}. ${run.tool === "codex" ? "Codex received the Opus 5.5 delegation instructions" : "Claude Code is starting with Opus 5.5 selected"}. Completion is reported in ${WORDS.terminal}.`
          : r.dryRun
            ? `Dry run: wrote PROMPT.md and GRAPHICS.md in ${r.display}. ${WORDS.terminal} stays closed while MOTION_STUDIO_DRY_RUN is on.`
            : `Wrote PROMPT.md and GRAPHICS.md in ${r.display}. Run the command above in your terminal.`,
      });
    } catch (error) {
      setRun({
        ...run,
        state: "error",
        message: error instanceof Error ? error.message : `Couldn't open ${WORDS.terminal}.`,
      });
    }
  };

  const cli = run?.tool === "codex" ? "Codex" : "Claude Code";
  const cliMissing =
    run &&
    ((run.tool === "codex" && status && !status.codex) ||
      (run.tool === "claude" && status && !status.claudeCli));
  return (
    <>
      <div className={`ml-actions ${size === "large" ? "large" : ""}`}>
        <button className="ml-btn" onClick={copy}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
        <button className="ml-btn primary" onClick={open} aria-expanded={Boolean(run)}>
          <TargetMark target={target} />
          Open in {label}
        </button>
      </div>
      <p className="ml-note">
        Graphics run in Claude Code with Opus 5.5. Other targets receive the CLI handoff.
      </p>
      <details className="ml-note">
        <summary>Execution prompt</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{handoffPrompt}</pre>
      </details>
      {run && (
        <div className="ml-panel" role="region" aria-label={`Run in ${cli}`}>
          <p>
            Makes <strong>{run.display}</strong> with PROMPT.md and GRAPHICS.md
            {assets.length ? " and your files" : ""}, then opens{" "}
            {run.terminal ? `a new ${WORDS.terminal} window` : "nothing (copy the command)"} running:
          </p>
          <code className="ml-cmd">{run.command}</code>
          <div className="ml-row">
            {
              <button
                className="ml-btn primary small"
                onClick={doRun}
                disabled={run.state === "running"}
              >
                {run.state === "running" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <SquareTerminal size={14} />
                )}
                {run.terminal
                  ? run.state === "done"
                    ? "Run again"
                    : `Run in ${WORDS.terminal}`
                  : "Create project"}
              </button>
            }
            <button
              className="ml-btn small"
              onClick={async () =>
                notify((await copyText(run.command)) ? "Command copied." : "Couldn't copy.")
              }
            >
              <Copy size={14} /> Copy command
            </button>
            {run.state === "done" && run.folder && (
              <button
                className="ml-btn ghost small"
                onClick={async () => {
                  const r = await api.reveal(run.folder as string).catch(() => null);
                  if (r && !r.revealed)
                    notify(
                      r.dryRun
                        ? `Dry run: ${WORDS.files} stays closed.`
                        : "Open the folder from your terminal.",
                    );
                }}
              >
                <FolderOpen size={14} /> Show folder
              </button>
            )}
            {(status?.dryRun || run.dryRun) && <span className="ml-badge">Dry run</span>}
          </div>
          {cliMissing && (
            <p className="ml-note">
              {cli} isn't installed on this computer yet; the folder and PROMPT.md still work with
              it later.
            </p>
          )}
          {run.message && (
            <p className={run.state === "error" ? "ml-error" : "ml-note"}>{run.message}</p>
          )}
        </div>
      )}
    </>
  );
}
