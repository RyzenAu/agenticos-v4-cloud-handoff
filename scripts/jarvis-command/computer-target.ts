/**
 * Which shared computer did the person mean? "use the Research computer to ..." names one by the word they said, not always by its stored name:
 * the name is lowercase (research), the label is what the Computers page shows ("Research"). The word is matched without regard to case, first
 * against the names, then the labels. If it matches nothing the existing refusal by name stands (nothing runs anywhere else); if it could mean
 * two, the person is asked, and nothing runs. Resolution only ever picks among SHARED computers (both founders may assign those); a personal
 * PC is never a candidate here, and who may use a computer is still decided by the verified principal inside the computers service.
 */
import { parseComputerCommand } from "../computers/jarvis";

export type SharedComputer = { name: string; label: string };
export type Resolved = { kind: "one"; name: string } | { kind: "none" } | { kind: "many"; names: string[] };

/** "Research", "research computer", "Research bot" -> "research". */
const bare = (s: string) => s.toLowerCase().replace(/\b(?:cloud\s+)?(?:computer|bot|agent|desktop|machine)\b/g, "").replace(/\s+/g, " ").trim();

/** Pure. Exact name, then exact label, then a name or label that starts with the word. One match wins, two or more is ambiguous. */
export function resolveComputerWord(word: string, computers: SharedComputer[]): Resolved {
  const w = bare(word);
  if (!w) return { kind: "none" };
  const byName = computers.filter((c) => c.name.toLowerCase() === w);
  if (byName.length) return { kind: "one", name: byName[0].name };
  const byLabel = computers.filter((c) => bare(c.label) === w);
  if (byLabel.length === 1) return { kind: "one", name: byLabel[0].name };
  const starts = byLabel.length ? byLabel : computers.filter((c) => c.name.toLowerCase().startsWith(`${w}-`) || bare(c.label).startsWith(`${w} `));
  if (starts.length === 1) return { kind: "one", name: starts[0].name };
  if (starts.length > 1) return { kind: "many", names: starts.map((c) => c.name) };
  return { kind: "none" };
}

const SHOW_FORM = /^(?:please\s+)?(?:show|open|bring up|pull up|check on|what'?s|how'?s|how is|what is)\b/i;
const NOUNED = /\bthe\s+([a-z0-9][a-z0-9-]{0,31})\s+(?:cloud\s+)?(?:computer|bot|agent|desktop|machine)\b/i;

type Delegate<R> = (utterance: string, principal: any) => Promise<R | null>;

/**
 * Wrap the computers delegate: resolve the named computer first, say so honestly when it is ambiguous, otherwise hand the same request on with the
 * real name in it. Everything else (unknown names, ownership, "show", "continue") is the wrapped delegate's, unchanged.
 */
export function withComputerResolution<R extends { ok: boolean; said: string }>(list: () => SharedComputer[], delegate: Delegate<R>): Delegate<R | { ok: false; said: string }> {
  return async (utterance, principal) => {
    const computers = list();
    let cmd = parseComputerCommand(utterance, computers.map((c) => c.name));
    // "show me the research computer" when only the label says research: the parser needs the name, so look for the same shape by label.
    if (!cmd && SHOW_FORM.test(utterance.trim())) {
      const named = NOUNED.exec(utterance);
      const found = named && resolveComputerWord(named[1], computers);
      if (found?.kind === "many") return { ok: false, said: `More than one shared computer could be "${named![1]}": ${found.names.join(", ")}. Which one do you mean? Nothing ran.` };
      if (found?.kind === "one") cmd = { kind: "show", name: named![1].toLowerCase() };
    }
    const word = cmd && "name" in cmd ? cmd.name : null;
    if (!cmd || !word || computers.some((c) => c.name.toLowerCase() === word.toLowerCase())) return delegate(utterance, principal);
    const found = resolveComputerWord(word, computers);
    if (found.kind === "many")
      return { ok: false, said: `More than one shared computer could be "${word}": ${found.names.join(", ")}. Which one do you mean? Nothing ran.` };
    if (found.kind === "none") return delegate(utterance, principal);
    // Same words, the computer's real name: only the mention that is followed by "computer" (or bot, agent...) is replaced, never an earlier use of the
    // same word in the goal ("research halal ETFs on the research computer").
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`\\b${escaped}\\b(?=\\s+(?:cloud\\s+)?(?:computer|bot|agent|desktop|machine)\\b)`, "i");
    const first = new RegExp(`\\b${escaped}\\b`, "i");
    return delegate(utterance.replace(named.test(utterance) ? named : first, found.name), principal);
  };
}
