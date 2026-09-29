import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small round (i) that opens a short note: where a number comes from, how fresh it is, what a
 * label means. Provenance stays one click away instead of in the reading path. The note is in the
 * DOM while closed (`hidden`), so nothing true is removed. Escape or a click outside closes it and
 * focus returns to the button. Never put a state the owner must see (stale, failed) only in here.
 */
export function InfoTip({
  children,
  label = "About this",
  align = "end",
  className,
}: {
  children: ReactNode;
  /** Accessible name of the (i) button, e.g. "Sources". */
  label?: string;
  /** Which edge of the button the note lines up with. */
  align?: "start" | "end";
  className?: string;
}) {
  const id = `ds-info-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <span ref={wrap} className={cn("relative inline-flex", className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="ds-interactive grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground"
      >
        <Info aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </button>
      <span
        id={id}
        role="note"
        hidden={!open}
        className={cn(
          "absolute top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-3.5 text-left text-xs font-normal leading-relaxed tracking-normal text-foreground shadow-lg",
          align === "end" ? "right-0" : "left-0",
        )}
      >
        {children}
      </span>
    </span>
  );
}
