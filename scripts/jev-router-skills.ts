// The jarvis-skills pack as Jev router intents. The skills' own grammars run as rules first in
// free-voice.ts; in the router they give Jev a complete catalogue (so "set a timer" isn't mistaken
// for a PC action) and a second, normalised try at the same deterministic slot parser. A skill's
// question back ({ skill: "say" }) is never produced here: that stays with the rules.
import { normaliseUtterance, type RouterSkill } from "./jev-router";
import { SKILL_NAMES, skillIntent, type SkillName } from "./jarvis-skills";

export const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  timer: "Start, cancel or check a countdown timer or an alarm.",
  reminder: "Remind him about something at a time or after a delay, or list his reminders.",
  time: "Tell the time, the date or the day.",
  maths: "Do arithmetic or percentages.",
  units: "Convert between units (distance, weight, temperature, volume…).",
  currency: "Convert between currencies.",
  system: "Report battery, CPU, memory, disk space, IP address or internet status.",
  clipboard: "Read out or copy something to the clipboard.",
  notes: "Add a quick note or read back recent notes.",
  type: "Type or dictate words into the window he's in.",
  window: "Arrange windows: switch to, bring up or move an app to his main/other/left/right screen, say which screen, minimise, maximise, snap or show the desktop.",
  weather: "The weather, temperature or chance of rain, for his city or one he names.",
  settings: "Turn Bluetooth or Wi-Fi on or off, mute or unmute notifications, or make a new folder on the Desktop.",
  deploys: "The status of his latest Vercel deploys (read-only).",
  files: "Rename the screenshots or photos in one of his folders by date, or undo that rename.",
  capabilities: "What Jarvis can do on this PC: a spoken summary, or the full list shown.",
  filejob: "Zip a folder, copy or move a file between his folders, save a file as PDF, take a screenshot, total a column in the open Excel sheet or bold a line in the open Word document.",
  finance: "NAB bank income, spend, balance or paid invoices; or Stripe outstanding/overdue invoices and next payout.",
  ai_usage: "AI subscription/API spend this month, or which Codex or Claude plan is closest to its limit.",
  receptionist: "Read receptionist health, calls today and sale readiness.",
  inbox: "A summary of his sorted inbox from the triage log: what's in it, anything important or urgent, or client emails.",
  skill_candidates: "What skills he should build next, from last night's Dream 30-day skill-mining pass.",
  browser: "In Jarvis Chrome: open a site (our website, a client site, Gmail), search Google or YouTube, a new tab, back, refresh, close the tab, scroll, read the page, click a link on it.",
};

export function routerSkills(parse: typeof skillIntent = skillIntent): RouterSkill[] {
  return SKILL_NAMES.map((id) => ({
    id,
    description: SKILL_DESCRIPTIONS[id],
    // Typing into a window acts on whatever has focus: same bar as locking the PC.
    tier: id === "type" ? ("strong" as const) : ("act" as const),
    extract: (utterance: string) => {
      for (const text of [utterance, normaliseUtterance(utterance)]) {
        const request = parse(text);
        if (request && request.skill === id) return { name: "skill", arguments: request as unknown as Record<string, unknown> };
      }
      return null;
    },
  }));
}
