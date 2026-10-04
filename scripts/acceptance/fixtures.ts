import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synthetic M&U fixtures for the acceptance tasks. Nothing here is a real lead, client, number or address: every value
 * is invented, marked SYNTHETIC-ACCEPT, and uses reserved example domains and the 0400 000 000 style number.
 */
export type Fixtures = {
  tag: string;
  dir: string;
  lead: { id: string; business: string; contact: string; phone: string; email: string; stage: string; note: string };
  clientNote: { file: string; title: string; text: string };
  deck: { title: string; subtitle: string; slideTitles: string[] };
  files: { lead: string; clientNote: string; deck: string };
};

export function makeFixtures(dir: string, run: string): Fixtures {
  const tag = `SYNTHETIC-ACCEPT-${run}`;
  mkdirSync(dir, { recursive: true });
  const lead = {
    id: `lead-${tag}`,
    business: `Synthetic Bayside Dental ${run}`,
    contact: "Sam Example",
    phone: "+61 400 000 000",
    email: "sam@example.invalid",
    stage: "new",
    note: `${tag}: invented lead for acceptance runs; no real person or business.`,
  };
  const clientNote = {
    file: "client-note.md",
    title: `Synthetic client note ${run}`,
    text: `# Synthetic client note ${run}\n\n${tag}. The synthetic clinic wants a booking page and after-hours call answering. Invented for tests.\n`,
  };
  const deck = { title: `SYNTHETIC M&U Acceptance Deck ${run}`, subtitle: tag, slideTitles: ["Overview", "Pricing", "Next steps"] };
  const files = { lead: join(dir, "lead.json"), clientNote: join(dir, clientNote.file), deck: join(dir, "deck.json") };
  writeFileSync(files.lead, JSON.stringify(lead, null, 2));
  writeFileSync(files.clientNote, clientNote.text);
  writeFileSync(files.deck, JSON.stringify(deck, null, 2));
  return { tag, dir, lead, clientNote, deck, files };
}
