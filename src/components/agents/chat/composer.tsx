// The one command box of a bot: typed requests (Enter sends, Shift+Enter is a new line). Always usable: a request sent while a job runs is sent
// anyway (background work continues; the bot answers in the thread). The voice button sits beside it.
import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ds";

export function Composer({ botName, onSend, voice, hint, initialDraft = "", disabled }: { botName: string; /** The box is off, with the reason in words (it replaces the placeholder): an archived bot, a bot with no computer. */ disabled?: string; onSend: (text: string) => void; voice?: ReactNode; hint?: string; /** A draft to start with (a shell restoring one, or a test). */ initialDraft?: string }) {
  const [text, setText] = useState(initialDraft);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
    ref.current?.focus();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2" aria-label={`Ask ${botName}`}>
      <label htmlFor={id} className="sr-only">
        Ask {botName}
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={1}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={key}
        disabled={!!disabled}
        placeholder={disabled ?? hint ?? `Ask ${botName} to do something`}
        className="min-h-11 max-h-40 min-w-0 flex-1 resize-none rounded-xl border border-input bg-card px-4 py-2.5 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {voice}
      <Button type="submit" variant="accent" className="h-11 shrink-0 gap-2 px-4 text-sm" disabled={!text.trim() || !!disabled}>
        <SendHorizontal aria-hidden="true" />
        <span className="hidden sm:inline">Send</span>
        <span className="sr-only sm:hidden">Send</span>
      </Button>
    </form>
  );
}
