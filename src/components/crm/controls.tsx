import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ds";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Label wraps its control, keeping native selects and every field keyboard accessible. */
export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <label className={cn("flex min-w-0 flex-col gap-2 text-sm", wide && "sm:col-span-2")}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span id={id} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-2xl motion-reduce:animate-none"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
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
}: {
  busy: boolean;
  onClose: () => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant="accent" disabled={busy}>
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
