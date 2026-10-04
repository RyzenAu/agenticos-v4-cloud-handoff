"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { EnquiryKind } from "@/lib/enquiry";
import { site } from "@/data/site";
import { Check } from "@/components/ui/Icons";
import styles from "./EnquiryForm.module.css";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "email" | "tel" | "textarea" | "select" | "date";
  required?: boolean;
  options?: string[];
  placeholder?: string;
  autoComplete?: string;
  half?: boolean;
  defaultValue?: string;
  rows?: number;
}

type Status = "idle" | "submitting" | "success" | "error";

/**
 * One form component for every enquiry on the site. Fields are declared
 * by the page; validation, spam protection, submission and the four UI
 * states live here.
 */
export function EnquiryForm({
  kind,
  fields,
  context,
  submitLabel = "Send enquiry",
  successTitle = "Preview only.",
  successBody = site.responseExpectation,
  tone = "paper",
  compact = false,
  onSuccess,
}: {
  kind: EnquiryKind;
  fields: Field[];
  context?: Record<string, string>;
  submitLabel?: string;
  successTitle?: string;
  successBody?: string;
  tone?: "paper" | "bone" | "ink";
  compact?: boolean;
  onSuccess?: () => void;
}) {
  const uid = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current = Date.now();
  }, []);

  function validate(data: FormData) {
    const next: Record<string, string> = {};
    for (const f of fields) {
      const v = String(data.get(f.name) ?? "").trim();
      if (f.required && !v) next[f.name] = `Please enter ${f.label.toLowerCase()}.`;
      else if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) next[f.name] = "That email address doesn't look right.";
    }
    if (!data.get("consent")) next.consent = "Please tick the box so we can contact you.";
    return next;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const errs = validate(data);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0];
      (form.elements.namedItem(first) as HTMLElement | null)?.focus();
      return;
    }
    setStatus("submitting");
    setServerError(null);
    // Static prospect preview: validate locally and never collect or transmit contact data.
    setStatus("success");
  }

  if (status === "success") {
    return (
      <div className={`${styles.success} ${styles[tone]}`} role="status">
        <span className={styles.successMark}>
          <Check />
        </span>
        <h3 className="h-3">{"Demo complete — nothing sent."}</h3>
        <p>{"This was a local form demonstration. No message, booking or inspection was created."}</p>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => { setStatus("idle"); setErrors({}); mounted.current = Date.now(); }}>
          Send another
        </button>
      </div>
    );
  }

  return (
    <form className={`${styles.form} ${styles[tone]} ${compact ? styles.compact : ""}`} onSubmit={onSubmit} noValidate>
      <div className={styles.grid}>
        {fields.map((f) => {
          const id = `${uid}-${f.name}`;
          const err = errors[f.name];
          const common = {
            id,
            name: f.name,
            required: f.required,
            "aria-invalid": err ? true : undefined,
            "aria-describedby": err ? `${id}-err` : undefined,
            autoComplete: f.autoComplete,
            placeholder: f.placeholder,
            defaultValue: f.defaultValue,
          };
          return (
            <div key={f.name} className={`${styles.field} ${f.half ? styles.half : ""}`}>
              <label htmlFor={id}>
                {f.label}
                {f.required && <span aria-hidden="true"> *</span>}
              </label>
              {f.type === "textarea" ? (
                <textarea {...common} rows={f.rows ?? 4} />
              ) : f.type === "select" ? (
                <select {...common} defaultValue={f.defaultValue ?? ""}>
                  <option value="" disabled>
                    Select…
                  </option>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input {...common} type={f.type ?? "text"} inputMode={f.type === "tel" ? "tel" : f.type === "email" ? "email" : undefined} />
              )}
              {err && (
                <p className={styles.error} id={`${id}-err`}>
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.trap} aria-hidden="true">
        <label htmlFor={`${uid}-company`}>Company</label>
        <input id={`${uid}-company`} name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className={styles.consent}>
        <input id={`${uid}-consent`} name="consent" type="checkbox" aria-invalid={errors.consent ? true : undefined} aria-describedby={errors.consent ? `${uid}-consent-err` : undefined} />
        <label htmlFor={`${uid}-consent`}>
          I&rsquo;m happy for {site.name} to contact me about this enquiry. Details are handled under the{" "}
          <a href="/privacy" className="link">
            privacy policy
          </a>
          . <span className={styles.demoNote}>Preview form only. Do not enter private information; nothing is sent.</span>
        </label>
      </div>
      {errors.consent && (
        <p className={styles.error} id={`${uid}-consent-err`}>
          {errors.consent}
        </p>
      )}

      <div className={styles.actions}>
        <button type="submit" className={`btn ${tone === "ink" ? "btn--paper" : "btn--ink"}`} disabled={status === "submitting"}>
          {status === "submitting" ? "Sending…" : submitLabel}
        </button>
        <p className={styles.expect}>{site.responseExpectation.split(".")[0]}.</p>
      </div>
      <p className={styles.server} role="alert" aria-live="assertive">
        {status === "error" ? serverError : ""}
      </p>
    </form>
  );
}
