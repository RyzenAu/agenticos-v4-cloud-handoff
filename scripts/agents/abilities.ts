import type { Bot } from "./types";

/**
 * What a bot can actually do, derived from the workflows and executors its set-up reaches (never stored, never edited: "skills are not configurable yet").
 * A bot with a computer does the workflows that computer's hub offers; a bot with coding on also runs coding jobs, but only while the coding executor
 * could honour it (a configured account: the one the bot names, or any when it leaves it automatic).
 *
 * Skills (the catalogue the hub lists) are NOT loaded by any execution path: the job brief (brief.ts) carries a bot's instructions and recalled facts,
 * and the computers' executors are chosen by the request, not by a bot's skill list. So there is nothing for a person to pick, and nothing is stored.
 */
export type Ability = { id: "research" | "builder" | "audit" | "bizprep" | "coding"; name: string; description: string };

export const ABILITIES: readonly Ability[] = [
  { id: "research", name: "Research", description: "Finds, reads and compares public sources on its own computer and returns a cited report." },
  { id: "builder", name: "Build components", description: "Builds or changes a small website component in an isolated checkout and shows a preview." },
  { id: "audit", name: "Website audit", description: "Reads an allowed website and reports what it finds. Read-only." },
  { id: "bizprep", name: "Business preparation", description: "Drafts a comparison table or a proposal from the information it is given." },
  { id: "coding", name: "Coding jobs", description: "Runs Claude and Codex coding jobs on the shared accounts: plan, build, test, review." },
];

export type Capabilities = {
  research: boolean;
  workflows: boolean;
  /** The shared computers that exist now. Present: a computer ability needs the bot's computer to be one of them. */
  computers?: string[];
  /** The coding account slots configured now. Present: coding needs the bot's account (or, when automatic, any account) to be among them. */
  codingSlots?: string[];
};

/** The abilities this bot has right now. */
export function abilitiesOf(bot: Bot, caps: Capabilities): Ability[] {
  const has = (id: Ability["id"]) => {
    if (id === "coding") {
      if (!bot.coding.enabled) return false;
      if (!caps.codingSlots) return true;
      return bot.coding.accountSlot ? caps.codingSlots.includes(bot.coding.accountSlot) : caps.codingSlots.length > 0;
    }
    if (!bot.computer) return false;
    if (caps.computers && !caps.computers.includes(bot.computer)) return false;
    return id === "research" ? caps.research : caps.workflows;
  };
  return ABILITIES.filter((a) => has(a.id));
}
