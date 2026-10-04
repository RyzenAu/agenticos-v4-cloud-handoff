import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { ArrowUpRight } from "lucide-react";
import { Button, DetailDrawer } from "@/components/ds";
import { cn } from "@/lib/utils";

/** The label names its control by `for`/`id`, so a filled-in textarea does not become part of its own accessible name; a hint is its description. */
export function Field({
  label,
  hint,
  error,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  /** This field's validation message, shown beside it by the field's own name. */
  error?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [error ? errorId : "", hint ? hintId : ""].filter(Boolean).join(" ");
  const props = isValidElement(children) ? (children.props as { id?: string }) : null;
  const controlId = props?.id ?? id;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm", wide && "sm:col-span-2")}>
      <label htmlFor={controlId} className="font-medium">
        {label}
      </label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id: controlId,
            ...(described ? { "aria-describedby": described } : {}),
            ...(error ? { "aria-invalid": true } : {}),
          })
        : children}
      {error && (
        <span id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}
export function NativeSelect({
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "ds-interactive min-h-11 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}
/** What Escape does in a CRM dialog: close it only when nothing has been typed or chosen; a save in flight and typed text are never thrown away by it. */
export function escapeAction(state: { busy: boolean; typed: boolean }): "close" | "keep" | "block" {
  return state.busy ? "block" : state.typed ? "keep" : "close";
}
export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  // Typed text is never thrown away by a stray Escape: once anything has been typed or chosen, Escape does nothing but say so, and Cancel is the deliberate way out.
  const typed = useRef(false);
  const [kept, setKept] = useState(false);
  // R12 rollout: CRM records are edited in the shared detail drawer (right side; full width on a phone), not a centred dialog.
  return (
    <DetailDrawer
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      description={description}
      onInput={() => {
        typed.current = true;
      }}
      onEscapeKeyDown={(event) => {
        const action = escapeAction({ busy, typed: typed.current });
        if (action !== "close") event.preventDefault();
        if (action === "keep") setKept(true);
      }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      {kept && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Your changes are still here. Use Cancel to discard them.
        </p>
      )}
      {children}
    </DetailDrawer>
  );
}
export function ExternalLink({ href, children }: { href?: string | null; children: ReactNode }) {
  const safe = safeExternalHref(href);
  return safe ? (
    <a
      className="ds-interactive inline-flex max-w-full items-center gap-1.5 break-all rounded text-sm underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
    </a>
  ) : (
    <span className="text-sm text-muted-foreground">{children} (link unavailable)</span>
  );
}
export function safeExternalHref(href?: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function SaveActions({
  busy,
  onClose,
  label = "Save changes",
  disabled = false,
}: {
  busy: boolean;
  onClose: () => void;
  label?: string;
  /** Saving waits on something the person must do first (for example reload a changed record). */
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant="accent" disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}
export function ownerName(owner: string | null | undefined): string {
  return owner === "usman" ? "Usman" : owner === "mehroz" ? "Mehroz" : "Unassigned";
}
export const ownerOptions = (
  <>
    <option value="">Unassigned</option>
    <option value="usman">Usman</option>
    <option value="mehroz">Mehroz</option>
  </>
);
