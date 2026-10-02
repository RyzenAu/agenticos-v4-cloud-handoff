import type { FeedTask } from "@/lib/agent-feed";

/** Details retain the action history; the surface shows the current step first. */
export function TaskProgress({ task, activity }: { task: FeedTask; activity?: string }) {
  const label = (text: string) =>
    text
      .replace(/,?\s*sha256 [a-f0-9]{8}/gi, "")
      .replace(/(?:typed\s+)?\[typed (\d+) characters?\]/gi, "Typed $1 characters");
  const latest = task.steps.at(-1);
  const current = !task.endedAt ? activity || (latest ? label(latest.text) : "Working…") : null;
  return (
    <>
      {current && (
        <p className="alp-current" role="status">
          {current}
        </p>
      )}
      {task.steps.length > 0 && (
        <details className="alp-details">
          <summary>
            {task.steps.length} step{task.steps.length === 1 ? "" : "s"}
          </summary>
          <ol className="alp-steps">
            {task.steps.map((step, i) => (
              <li key={i} data-kind={step.kind}>
                <span className="alp-step-mark" aria-hidden="true">
                  {step.kind === "error" ? "!" : step.kind === "tool" ? "›" : "·"}
                </span>
                {step.name && <code className="alp-step-name">{step.name}</code>}
                <span className="alp-step-text">{label(step.text)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
