/**
 * "Read me this page" speaks the page's words, but the conversation history must not keep them (J3: a page can
 * carry text written at an assistant, and it would otherwise be stored as something Jarvis said and sent to the
 * next model call). The skill result travels as this small envelope; the server speaks `said`, and the client
 * stores `keep` in its history in place of both the tool result and the reply.
 *
 * The envelope only counts when it came from the `skill` tool and its `keep` is the ONE fixed neutral line below
 * (J3 review F5): another tool's result can't smuggle a line into the history through it.
 */
export const PAGE_READ_TYPE = "page_read";
/** The only line the history ever stores for a page read aloud. */
export const PAGE_READ_KEPT = "Read the page aloud.";

export type PageRead = { type: typeof PAGE_READ_TYPE; said: string; keep: string };

export const pageReadEnvelope = (said: string): string => JSON.stringify({ type: PAGE_READ_TYPE, said, keep: PAGE_READ_KEPT } satisfies PageRead);

export function parsePageRead(content: unknown): PageRead | null {
  if (typeof content !== "string" || !content.startsWith('{"type":"page_read"')) return null;
  try {
    const v = JSON.parse(content);
    return v?.type === PAGE_READ_TYPE && typeof v.said === "string" && v.keep === PAGE_READ_KEPT ? v : null;
  } catch {
    return null;
  }
}

type Msg = { role: string; content?: string | null; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> };

/** The name of the tool a tool-result message answers: the nearest earlier assistant turn that made that call. */
export function toolNameAt(messages: Msg[], index: number): string | undefined {
  const id = messages[index]?.tool_call_id;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === "user") return undefined;
    const call = messages[i].role === "assistant" ? messages[i].tool_calls?.find((c) => c.id === id) : undefined;
    if (call) return call.function.name;
  }
  return undefined;
}

/** A page-read envelope in a `skill` tool result, or null (any other tool's result is just text). */
const skillPageRead = (messages: Msg[], index: number): PageRead | null => (messages[index].role === "tool" && toolNameAt(messages, index) === "skill" ? parsePageRead(messages[index].content) : null);

/**
 * After a turn's reply has been spoken: every page-read result since the last user message is replaced, in
 * place, by its neutral line, and the line to store for the spoken reply is returned (the neutral line when
 * this turn read a page, else the reply itself). Pure over what it is given except for that in-place rewrite.
 */
export function neutralisePageReads(history: Msg[], reply: string): string {
  let stored = reply;
  for (let i = history.length - 1; i >= 0 && history[i].role !== "user"; i--) {
    const read = skillPageRead(history, i);
    if (!read) continue;
    history[i].content = read.keep;
    stored = read.keep;
  }
  return stored;
}

/**
 * The messages as a MODEL may see them: every page-read result is its neutral line. The server speaks a page read
 * from the envelope itself, without a model, so a model call (a mixed batch, a later turn) never needs the words.
 */
export function neutralisedForModel<T extends Msg>(messages: T[]): T[] {
  return messages.map((m, i) => {
    const read = skillPageRead(messages, i);
    return read ? { ...m, content: read.keep } : m;
  });
}

/** Older turns: a page-read envelope in a `skill` result is shown to the model as its neutral line only. */
export function pageReadForModel(messages: Msg[], index: number): string {
  return skillPageRead(messages, index)?.keep ?? String(messages[index].content ?? "");
}
