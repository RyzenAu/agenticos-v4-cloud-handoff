// Small form pieces for the Setup tab. Every control has a visible label, a one-line effect and, when it can't be
// used, the reason in words next to it (also wired to the control with aria-describedby).
import { fmtTime } from "@/lib/format";
import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Surface } from "@/components/ds";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Gate, Option, RouteGroup, Tone } from "./setup-model";

export type SectionStatus = { saving: boolean; savedAt: number | null; error: string | null };

const fmtClock = (ms: number) => fmtTime(ms);

/** A card for one section: a heading, one line saying what it controls, and the section's save receipt. */
export function SetupSection({ id, title, description, status, children }: { id: string; title: string; description: ReactNode; status: SectionStatus; children: ReactNode }) {
  return (
    <Surface as="section" id={id} aria-labelledby={`${id}-title`} data-testid={id} className="scroll-mt-6 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-x-4">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} tabIndex={-1} className="text-lg font-semibold leading-snug tracking-[-0.01em] outline-none">
            {title}
          </h2>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{description}</p>
        </div>
        <Receipt status={status} />
      </div>
      {status.error && (
        <p role="alert" data-testid={`${id}-error`} className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-foreground">
          {status.error}
        </p>
      )}
      {children}
    </Surface>
  );
}

/** "Saving…", "Saved 2:05 pm", or nothing. A polite live region so a screen reader hears the change. */
export function Receipt({ status }: { status: SectionStatus }) {
  return (
    <span role="status" aria-live="polite" data-testid="receipt" className="inline-flex shrink-0 items-center gap-1.5 text-sm">
      {status.saving ? (
        <span className="text-muted-foreground">Saving…</span>
      ) : status.savedAt ? (
        <span className="inline-flex items-center gap-1.5 text-success">
          <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
          Saved {fmtClock(status.savedAt)}
        </span>
      ) : null}
    </span>
  );
}

const FIELD =
  "w-full rounded-lg border border-input bg-inset px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export function Field({ label, help, reason, error, htmlFor, children }: { label: ReactNode; help?: ReactNode; reason?: string | null; error?: string | null; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {help && (
        <p id={`${htmlFor}-help`} className="max-w-[62ch] text-sm text-muted-foreground">
          {help}
        </p>
      )}
      {reason && (
        <p id={`${htmlFor}-reason`} data-reason="" className="max-w-[62ch] text-sm text-muted-foreground">
          {reason}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, o: { help?: boolean; reason?: boolean; error?: boolean }) => [o.help && `${id}-help`, o.reason && `${id}-reason`, o.error && `${id}-error`].filter(Boolean).join(" ") || undefined;

export function SelectField({ id, label, help, value, options, groups, gate, busy, onChange, below }: { id: string; label: ReactNode; help?: ReactNode; value: string; options?: Option[]; groups?: RouteGroup[]; gate: Gate; busy: boolean; onChange: (v: string) => void; below?: ReactNode }) {
  const lock = gate.disabled || busy;
  const render = (o: Option) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  );
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} help={help} reason={gate.reason} htmlFor={id}>
        <select id={id} value={value} disabled={lock} aria-describedby={describedBy(id, { help: !!help, reason: !!gate.reason })} onChange={(e) => onChange(e.target.value)} className={cn(FIELD, "h-10 appearance-none bg-[length:1rem] pr-8")}>
          {groups ? groups.map((g) => (g.options.length ? <optgroup key={g.label} label={g.label}>{g.options.map(render)}</optgroup> : null)) : options?.map(render)}
        </select>
      </Field>
      {below}
    </div>
  );
}

/** A one-line text field with the same label, help, error and count as the text areas. */
export function TextInput({ id, label, help, value, max, error, disabled, placeholder, autoFocus, onChange, onSubmit }: { id: string; label: string; help?: string; value: string; max: number; error?: string | null; disabled?: boolean; placeholder?: string; autoFocus?: boolean; onChange: (v: string) => void; onSubmit?: () => void }) {
  const over = value.length > max;
  return (
    <Field label={label} htmlFor={id} error={error} help={help}>
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        aria-invalid={over || !!error || undefined}
        aria-describedby={describedBy(id, { help: !!help, error: !!error })}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onSubmit && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={cn(FIELD, "h-10")}
      />
      {over && <span className="text-sm ds-num text-danger">{value.length} of {max} characters</span>}
    </Field>
  );
}

export function TextArea({ id, label, help, value, rows, max, error, disabled, onChange, onSubmit }: { id: string; label: string; help?: string; value: string; rows: number; max: number; error?: string | null; disabled?: boolean; onChange: (v: string) => void; onSubmit?: () => void }) {
  const over = value.length > max;
  return (
    <Field label={label} htmlFor={id} error={error} help={help}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        aria-invalid={over || !!error || undefined}
        aria-describedby={describedBy(id, { help: !!help, error: !!error })}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onSubmit && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={cn(FIELD, "min-h-[5.5rem] resize-y leading-relaxed")}
      />
      <span className={cn("text-sm ds-num", over ? "text-danger" : "text-muted-foreground")}>
        {value.length.toLocaleString("en-AU")} of {max.toLocaleString("en-AU")} characters
      </span>
    </Field>
  );
}

/** A labelled switch with its effect line and, when it can't be turned on, why. */
export function SwitchRow({ id, label, help, checked, gate, busy, onChange }: { id: string; label: string; help: string; checked: boolean; gate: Gate; busy: boolean; onChange: (v: boolean) => void }) {
  const lock = gate.disabled || busy;
  return (
    <div className="flex items-start gap-4">
      <Switch id={id} checked={checked} disabled={lock} onCheckedChange={onChange} aria-labelledby={`${id}-label`} aria-describedby={describedBy(id, { help: true, reason: !!gate.reason })} className="mt-0.5" />
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <p id={`${id}-help`} className="max-w-[62ch] text-sm text-muted-foreground">
          {help}
        </p>
        {gate.reason && (
          <p id={`${id}-reason`} data-reason="" className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {gate.reason}
          </p>
        )}
      </div>
    </div>
  );
}

export function CheckRow({ label, meta, line, checked, disabled, reason, onChange }: { label: string; meta?: string; line?: string; checked: boolean; disabled: boolean; reason?: string | null; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <li className="flex items-start gap-3 py-3">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={line || reason ? `${id}-d` : undefined} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)] disabled:cursor-not-allowed" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
          {meta && <span className="ml-2 font-normal text-muted-foreground">{meta}</span>}
        </label>
        {(line || reason) && (
          <p id={`${id}-d`} className="max-w-[62ch] text-sm text-muted-foreground">
            {line}
            {line && reason ? " " : ""}
            {reason}
          </p>
        )}
      </div>
    </li>
  );
}

const DOT: Record<Tone, string> = { neutral: "bg-muted-foreground", success: "bg-success", warn: "bg-warn", danger: "bg-danger", info: "bg-info" };

/** A line of state with a leading dot; the words carry the meaning, the dot only the tone. */
export function StateLine({ tone, children, testid }: { tone: Tone; children: ReactNode; testid?: string }) {
  return (
    <p data-testid={testid} className="flex max-w-[62ch] items-start gap-2 text-sm text-foreground">
      <span aria-hidden="true" className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", DOT[tone])} />
      <span>{children}</span>
    </p>
  );
}
