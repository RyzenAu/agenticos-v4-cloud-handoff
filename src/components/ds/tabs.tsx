import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number | null };

/**
 * An ARIA tablist of rounded pills. Arrow keys, Home and End move between tabs and select them
 * (roving tabindex); only the tab row scrolls sideways on a narrow screen, never the page. The
 * selected tab is raised, not gold (gold stays for the one primary action).
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  idBase,
  label,
  className,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Tab i is `${idBase}-tab-${id}`, its panel `${idBase}-panel-${id}`. */
  idBase: string;
  label: string;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };
  return (
    <div className={cn("-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden", className)}>
      <div role="tablist" aria-label={label} className="inline-flex min-w-max gap-1 rounded-full border border-border bg-inset p-1">
        {tabs.map((t, i) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${idBase}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => move(e, i)}
              className={cn(
                "ds-interactive inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-medium sm:text-base",
                selected ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className="ds-num grid h-5 min-w-5 place-items-center rounded-full bg-surface-raised px-1.5 text-xs text-foreground">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The panel for one tab. Inactive panels stay mounted but `hidden`, so their facts stay in the DOM. */
export function TabPanel({ idBase, id, active, children, className }: { idBase: string; id: string; active: boolean; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} hidden={!active} tabIndex={0} className={cn("outline-none", className)}>
      {children}
    </div>
  );
}
