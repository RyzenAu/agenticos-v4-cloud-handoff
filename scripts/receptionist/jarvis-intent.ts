export type ReceptionistRequest = { skill: "receptionist"; action: "status" };
export function receptionistIntent(utterance: string): ReceptionistRequest | null {
  const u = utterance
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^(?:hey |ok |okay )?jarvis[, ]+/, "")
    .replace(/[?.!,]+/g, " ")
    .replace(/\b(?:please|mate|sir|right now|currently)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (u.length > 120) return null;
  return /^(?:receptionist status|how(?:'s| is) the receptionist|is the receptionist (?:ok|okay|healthy|working|ready to sell)|any receptionist calls today)$/.test(
    u,
  )
    ? { skill: "receptionist", action: "status" }
    : null;
}
