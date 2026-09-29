import { DOMParser } from "linkedom";
import { withConnectedRead } from "./codex-connected-read";

const xmlText = (value: string) => value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (full, entity: string) => {
  const named: Record<string, string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
  if (entity[0] !== "#") return named[entity.toLowerCase()] || full;
  const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : full;
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Only provider meeting elements become data. Surrounding prose is never an instruction. */
export function granolaMeetings(raw: unknown) {
  const text = (raw as { text?: unknown })?.text;
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024) throw new Error("Granola returned an unsupported meeting response.");
  const xml = text.match(/<meetings_data\b[\s\S]*?<\/meetings_data>/)?.[0];
  if (!xml) throw new Error("Granola returned no structured meeting list.");
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  return Array.from(doc.querySelectorAll("meeting")).map(meeting => {
    const id = meeting.getAttribute("id") || "";
    if (!uuid.test(id)) throw new Error("Granola returned an invalid meeting reference.");
    const title = xmlText(meeting.getAttribute("title") || "Granola meeting").slice(0, 300);
    const date = (meeting.getAttribute("date") || "").slice(0, 100);
    const participants = xmlText(meeting.querySelector("known_participants")?.textContent || "").trim().slice(0, 3000);
    const notes = Array.from(meeting.querySelectorAll("summary, private_notes, enhanced_notes, notes")).map(part => xmlText(part.textContent || "").trim()).filter(Boolean).join("\n\n");
    return { id, title, text: notes ? `Date: ${date}\n${participants ? `Participants: ${participants}\n` : ""}\n${notes}` : "" };
  }).sort((a, b) => (Date.parse(b.text.split("\n")[0].slice(6)) || 0) - (Date.parse(a.text.split("\n")[0].slice(6)) || 0));
}
export async function connectedGranolaNotes(root: string, read = withConnectedRead) {
  return read(root, async client => {
    const list = granolaMeetings(await client.call("granola.list_meetings", { time_range: "this_week", involvement: { captured_by_me: true, listed_as_participant: true } }));
    const ids = [...new Set(list.map(meeting => meeting.id))].slice(0, 10);
    if (!ids.length) return { documents: [], hasMore: false };
    const documents = granolaMeetings(await client.call("granola.get_meetings", { meeting_ids: ids }));
    if (documents.length !== ids.length || new Set(documents.map(doc => doc.id)).size !== ids.length || documents.some(doc => !ids.includes(doc.id))) throw new Error("Granola returned an unexpected meeting. Saved memory was preserved.");
    return { documents: documents.filter(doc => doc.text), hasMore: false };
  });
}
