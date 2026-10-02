import { useEffect, useId, useState } from "react";
import {
  loadReplyStyle,
  REPLY_STYLES,
  replyStyle,
  saveReplyStyle,
  type ReplyStyle,
} from "@/lib/voice-style";
import {
  DEFAULT_PERSONALITY,
  HUMOUR_LEVELS,
  loadPersonality,
  savePersonality,
  validPersonality,
  type VoicePersonality,
} from "@/lib/voice-personality";

export function VoiceStyleControls() {
  const id = useId();
  const [style, setStyle] = useState<ReplyStyle>("current");
  const [error, setError] = useState(false);
  const [personality, setPersonality] = useState<VoicePersonality>(DEFAULT_PERSONALITY);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setStyle(loadReplyStyle());
    const p = loadPersonality();
    setPersonality(p);
    setDraft(p.prompt);
  }, []);
  const update = (value: VoicePersonality) => {
    const next = validPersonality(value);
    const saved = savePersonality(next);
    setError(!saved);
    if (saved) setPersonality(next);
    return saved;
  };
  return (
    <div className="vc-personality space-y-2">
      <label htmlFor={id}>Reply tone</label>
      <select
        id={id}
        value={style}
        onChange={(e) => {
          const next = replyStyle(e.target.value);
          const saved = saveReplyStyle(next);
          setError(!saved);
          if (saved) setStyle(next);
        }}
        className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {REPLY_STYLES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <details className="space-y-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          Customise Jarvis
        </summary>
        <label htmlFor={`${id}-humour`} className="block text-sm">
          Humour · {HUMOUR_LEVELS[personality.humour]}
        </label>
        <input
          id={`${id}-humour`}
          type="range"
          min="0"
          max={HUMOUR_LEVELS.length - 1}
          step="1"
          value={personality.humour}
          aria-valuetext={HUMOUR_LEVELS[personality.humour]}
          onChange={(e) => update({ ...personality, humour: Number(e.target.value) })}
          className="min-h-11 w-full accent-primary"
        />
        <label htmlFor={`${id}-speed`} className="block text-sm">
          Speech speed · {personality.speed.toFixed(2)}×
        </label>
        <input
          id={`${id}-speed`}
          type="range"
          min="0.85"
          max="1.15"
          step="0.05"
          value={personality.speed}
          aria-valuetext={`${personality.speed.toFixed(2)} times normal speed`}
          onChange={(e) => update({ ...personality, speed: Number(e.target.value) })}
          className="min-h-11 w-full accent-primary"
        />
        <label htmlFor={`${id}-prompt`} className="block text-sm">
          How Jarvis talks
        </label>
        <textarea
          id={`${id}-prompt`}
          rows={3}
          maxLength={1000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Calm, direct, brief. Keep banter occasional."
          className="min-h-24 w-full resize-y rounded-lg border border-border bg-card p-3 text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={draft.trim() === personality.prompt}
            onClick={() => {
              if (update({ ...personality, prompt: draft })) setDraft(draft.trim());
            }}
            className="min-h-11 rounded-lg border border-border px-3 disabled:opacity-50"
          >
            Save tone
          </button>
          <button
            type="button"
            onClick={() => {
              if (update(DEFAULT_PERSONALITY)) setDraft("");
            }}
            className="min-h-11 px-3"
          >
            Reset customisation
          </button>
        </div>
      </details>
      <p className="text-sm text-muted-foreground" role="status">
        {error
          ? "Couldn't save in this browser. The previous preference is still in use."
          : "Applies to the next reply here. Action confirmations keep their exact wording."}
      </p>
    </div>
  );
}
