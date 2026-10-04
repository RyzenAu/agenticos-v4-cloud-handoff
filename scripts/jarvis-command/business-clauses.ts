import { maskInstructionData } from "./quotes";

/** Only a new question/order can end a business target. Plain name conjunctions (Smith and Jones,
 * Key & Castle, Smith and Sons) and commas in names are data. Quoted names keep every separator.
 * Offsets come from the masked copy; clauses always retain the person's original words. */
export function businessClauses(text: string): string[] {
  const masked = maskInstructionData(text);
  const start = "(?:(?:please|also)\\s+)*(?:what(?:['’]s)?|how|which|who|where|when|why|is|are|do|does|can|could|would|will|show|tell\\s+me|list|find|search|look\\s+up|open|pull\\s+up|bring\\s+up|go\\s+to|take\\s+me|add|save|create|make|set|draft|prepare|write|put|send|email|e-mail|mail|message|text|call|share|post|publish|upload|delete|remove|submit|pay|buy|transfer|book|schedule|cancel|mark|log|record|move|start|run|fix|build|review|change|update|edit|crm(?=\\.)|next\\s+(?:real\\s+)?actions?|overdue\\s+(?:follow[- ]?ups?|tasks)|promises|view|number\\s+of\\s+open\\s+leads)\\b";
  const splitter = new RegExp(`(?:\\s*[,;?!]\\s*(?:(?:and|then|also)\\s+)*(?:then\\s+)?|\\.\\s+(?:(?:and|then|also)\\s+)*|\\s+(?:and\\s+then|and|then|after\\s+that|also)\\s+)(?=${start})`, "gi");
  const parts: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(splitter)) {
    const part = text.slice(from, m.index).trim();
    // A polite preamble isn't a separate question ("Jarvis, what's ...").
    if (!part || /^(?:(?:hey|ok|okay)\s+)?jarvis$/i.test(part)) continue;
    parts.push(part);
    from = m.index! + m[0].length;
  }
  parts.push(text.slice(from).trim());
  return parts;
}
