// Settings › Jarvis: what the page can tell the person BEFORE it sends anything (R7 audit 2, item 14). The server validates all three parts before
// writing any (scripts/jarvis-settings.ts), so a refusal changes nothing; the page now says the same thing in plain words, up front, and says "Nothing was saved".

export type PersonDraft = { name: string; role: string };

export function jarvisSettingsProblem(greeting: string, people: PersonDraft[]): string | null {
  const text = greeting.trim();
  if (!text) return "Add a greeting (1 to 120 characters).";
  if (text.length > 120) return "Keep the greeting to 120 characters.";
  if (people.length === 0) return "Add at least one person, with the role owner.";
  if (people.length > 20) return "Keep it to 20 people.";
  const unnamed = people.findIndex((p) => !p.name.trim());
  if (unnamed >= 0) return `Person ${unnamed + 1} needs a name.`;
  if (!people.some((p) => /owner/i.test(p.role))) return "Keep one person with the role owner, so nobody is locked out.";
  const names = people.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two people have the same name.";
  return null;
}

/** A server refusal, said once and with the outcome. Only a refusal (no request sent, or a 4xx answer) proves nothing changed; any other failure may have saved. */
export const notSaved = (message: string, status?: number) => {
  const said = message.replace(/\s+$/, "").replace(/([^.!?])$/, "$1.");
  const refused = status === undefined || (status >= 400 && status < 500);
  return `${said} ${refused ? "Nothing was saved." : "This may not have been saved. Reload to check."}`;
};
