import { activeRegistry, type DeviceRegistry } from "./registry";
import { isSharedComputer, normalisePersonId, PERSON_IDS, SHARED_OWNER, type PersonId, type ResolveContext, type ResolveResult, type TargetDevice } from "./types";

/**
 * resolveTarget — which machine a person's command runs on (WAVE2-CONTRACT.md).
 *
 * Rules, all fail-closed:
 *  - A person's commands go only to a device that person owns. Usman's PC (the hub) is just
 *    another device owned by Usman; it is never a fallback for anyone else.
 *  - "here" / "this pc" / "this computer" means the device the request came from (originDeviceId: the
 *    companion, or the mic-owner companion), else that person's own primary/only device. Never someone else's.
 *  - A spoken target ("on my laptop") must match exactly one device that person owns.
 *    Naming someone else's device ("on Usman's PC" from Mehroz) is refused.
 *  - No spoken target: the device the command came from (if it is theirs), else their primary
 *    device, else their only device, else their only online device. Several online and none
 *    primary → ask which, never guess.
 *  - The chosen device offline → { ok: false, reason: "device offline" }. Never re-routed.
 *
 * The Jev track calls this before any desktop or browser action.
 */
export function resolveTarget(ctx: ResolveContext, registry: DeviceRegistry = activeRegistry()): ResolveResult {
  const person = normalisePersonId(ctx?.personId);
  if (!person) return { ok: false, reason: "unknown person" };
  const targets = registry.targets();
  const mine = targets.filter((d) => d.owner === person);
  const pick = (d: TargetDevice): ResolveResult =>
    registry.isOnline(d)
      ? { ok: true, deviceId: d.id, owner: d.owner, online: true }
      : { ok: false, reason: "device offline", deviceId: d.id };

  // The computers service names a shared computer exactly ("computer:<device id>"). Only a shared cloud computer can be
  // reached this way: a personal device's id (or its display name) never routes anywhere but through its owner's rules below.
  const exact = /^computer:([\w.-]{1,80})$/.exec(String(ctx.spokenTarget ?? "").trim());
  if (exact) {
    const computer = targets.find((d) => d.id === exact[1] && isSharedComputer(d));
    return computer ? pick(computer) : { ok: false, reason: "no such shared computer" };
  }

  const spoken = parseSpokenTarget(ctx.spokenTarget ?? "", person);
  if (spoken) {
    if (spoken.owner !== person)
      return { ok: false, reason: `that device belongs to ${spoken.owner}; you can only run commands on your own devices` };
    if (!spoken.words.length) return pickDefault(); // also "here" / "this pc": origin first, then their own primary
    const matches = mine.filter((d) => matchesWords(d, spoken.words));
    if (matches.length === 1) return pick(matches[0]);
    if (matches.length > 1)
      return { ok: false, reason: `"${ctx.spokenTarget?.trim()}" matches more than one of your devices (${matches.map((d) => d.label).join(", ")}); say which` };
    // A shared cloud computer, by name ("the research computer"): both founders may. Never by "here" or as a default, and
    // never on a bare "computer"/"pc" (that means the person's own PC).
    const shared = sharedComputerFor(spoken.words);
    if (shared === "ambiguous") return { ok: false, reason: `"${ctx.spokenTarget?.trim()}" matches more than one shared computer; say which` };
    if (shared) return pick(shared);
    if (targets.some((d) => d.owner !== person && d.owner !== SHARED_OWNER && matchesWords(d, spoken.words)))
      return { ok: false, reason: `that device isn't yours; you can only run commands on your own devices` };
    return { ok: false, reason: `none of your devices is called "${ctx.spokenTarget?.trim()}"` };
  }
  return pickDefault();

  /** The one shared computer the words name (a distinctive word beyond "pc"), "ambiguous", or null. */
  function sharedComputerFor(words: string[]): TargetDevice | "ambiguous" | null {
    if (!words.some((w) => w !== "pc")) return null;
    const found = targets.filter((d) => isSharedComputer(d) && matchesWords(d, words));
    return found.length === 1 ? found[0] : found.length > 1 ? "ambiguous" : null;
  }

  function pickDefault(): ResolveResult {
    if (ctx.originDeviceId) {
      const origin = targets.find((d) => d.id === ctx.originDeviceId);
      if (!origin || origin.owner !== person) return { ok: false, reason: "the device this came from isn't one of yours" };
      return pick(origin);
    }
    if (!mine.length) return { ok: false, reason: `no device registered for ${person}` };
    const primary = mine.filter((d) => d.primary);
    if (primary.length === 1) return pick(primary[0]);
    if (mine.length === 1) return pick(mine[0]);
    const online = mine.filter((d) => registry.isOnline(d));
    if (online.length === 1) return pick(online[0]);
    if (!online.length) return { ok: false, reason: "device offline" };
    return { ok: false, reason: `you have ${online.length} devices online (${online.map((d) => d.label).join(", ")}); say which one` };
  }
}

const SYNONYMS: Record<string, string> = {
  computer: "pc", desktop: "pc", machine: "pc", pc: "pc",
  laptop: "laptop", notebook: "laptop",
  phone: "phone", mobile: "phone",
};
const FILLER = new Set(["on", "in", "using", "at", "from", "the", "a", "an", "my", "mine", "own", "to", "please", "run", "it", "this", "that", "device"]);

const HERE_NOUNS = new Set(["pc", "device"]);

function tokens(text: string) {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function canon(word: string) {
  return SYNONYMS[word] ?? word;
}

/**
 * "on my laptop" → { owner: speaker, words: ["laptop"] };
 * "on Usman's PC" → { owner: "usman", words: ["pc"] }. Empty text → null.
 */
export function parseSpokenTarget(text: string, speaker: PersonId): { owner: PersonId; words: string[]; here?: boolean } | null {
  const raw = tokens(text);
  if (!raw.length) return null;
  // "here", "right here", "this pc", "this computer": the machine the request came from, no name to match.
  const here = raw.includes("here") || raw.some((t, i) => t === "this" && HERE_NOUNS.has(canon(raw[i + 1] ?? "")));
  let owner: PersonId = speaker;
  const words: string[] = [];
  for (const token of raw) {
    const bare = token.replace(/'s$|s'$|'$/, "");
    const named = PERSON_IDS.find((id) => bare === id || (token.endsWith("s") && token.slice(0, -1) === id));
    if (named) {
      owner = named;
      continue;
    }
    const word = bare.replace(/'/g, "");
    if (!word || FILLER.has(word) || (here && (word === "here" || word === "right" || HERE_NOUNS.has(canon(word))))) continue;
    words.push(canon(word));
  }
  return { owner, words, ...(here ? { here: true } : {}) };
}

function vocabulary(device: TargetDevice) {
  const words = new Set<string>();
  for (const phrase of [device.label, ...device.aliases]) {
    for (const token of tokens(phrase)) {
      const bare = token.replace(/'s$|s'$|'$/, "").replace(/'/g, "");
      if (!bare || FILLER.has(bare) || (PERSON_IDS as readonly string[]).includes(bare)) continue;
      words.add(canon(bare));
    }
  }
  return words;
}

function matchesWords(device: TargetDevice, words: string[]) {
  const vocab = vocabulary(device);
  return words.every((w) => vocab.has(w));
}
