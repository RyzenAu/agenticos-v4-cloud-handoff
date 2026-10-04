// One clipboard helper for every Copy button (audit F3-18). navigator.clipboard.writeText can reject
// (insecure origin, no permission, unfocused document) or never settle (a permission prompt nobody
// answers), so it gets a short deadline and then a hidden-textarea + execCommand fallback. Callers
// must show the result: "Copied" only on success, "Couldn't copy" otherwise, never silence.
import { useCallback, useEffect, useRef, useState } from "react";

const CLIPBOARD_DEADLINE_MS = 1_500;

function withDeadline(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      () => (clearTimeout(t), resolve(true)),
      () => (clearTimeout(t), resolve(false)),
    );
  });
}

function textareaCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Copy text; true only when a copy is known to have happened. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clip?.writeText && (typeof window === "undefined" || window.isSecureContext !== false)) {
    let attempt: Promise<void>;
    try {
      attempt = clip.writeText(text);
    } catch {
      attempt = Promise.reject(new Error("clipboard unavailable"));
    }
    if (await withDeadline(attempt, CLIPBOARD_DEADLINE_MS)) return true;
  }
  return textareaCopy(text);
}

export type CopyState = "idle" | "copied" | "failed";

/** The button label for a copy state. */
export function copyLabel(state: CopyState, idle = "Copy", copied = "Copied") {
  return state === "copied" ? copied : state === "failed" ? "Couldn't copy" : idle;
}

/** Copy with a visible outcome that resets after `ms` (failures stay a little longer). */
export function useCopyState(ms = 1_500) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      setState(ok ? "copied" : "failed");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), ok ? ms : Math.max(ms, 4_000));
      return ok;
    },
    [ms],
  );
  return { state, copy, copied: state === "copied", failed: state === "failed" };
}
