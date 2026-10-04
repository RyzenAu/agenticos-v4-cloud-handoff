import type { UnreadResult } from "@/lib/voice-completions";

/** The results that arrived while no voice session could say them (voice off, minimised, or an engine that cannot announce). Shown, never claimed as spoken. */
export function UnreadResults({ results, onClear }: { results: UnreadResult[]; onClear: () => void }) {
  if (!results.length) return null;
  return (
    <section className="jarvis-unread" aria-label="Unread results" role="status">
      <strong>{results.length === 1 ? "1 unread result" : `${results.length} unread results`}</strong>
      <ul>
        {results.slice(-3).map((r) => (
          <li key={r.key}>{r.text}</li>
        ))}
      </ul>
      <button type="button" onClick={onClear}>
        Mark as read
      </button>
    </section>
  );
}
