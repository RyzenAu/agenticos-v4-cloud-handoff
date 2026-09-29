// A line to one person's OWN Telegram DM (people.json), through `hermes send` (the gateway's own
// credentials; nothing here reads a token). Used for a program's one-time approval code and for the
// "your codes are paused" notice. Nobody else is ever messaged.
import { hermesNotifier } from "../away-mode/notify";
import { normalisePersonId } from "../devices/types";
import { readPeople } from "../remote-access";

export type PersonNotifier = (personId: string, text: string) => Promise<{ ok: boolean; detail: string }>;

export function personNotifier(root: string): PersonNotifier {
  return (personId, text) => {
    const person = readPeople(root).find((p) => normalisePersonId(p.name) === personId);
    const chat = (person?.telegram ?? []).map(String).find((t) => /^\d{5,15}$/.test(t)) ?? "";
    return hermesNotifier(() => chat)({ text });
  };
}

/** Every listed person's Telegram user ids (the relay's rate limiter never evicts these). */
export function listedTelegramIds(root: string): Set<string> {
  try {
    return new Set(readPeople(root).flatMap((p) => (p.telegram ?? []).map(String)));
  } catch {
    return new Set();
  }
}
