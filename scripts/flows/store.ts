import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What the everyday flows made (F1): email drafts Jarvis wrote for the owner to read and send, and calendar events
 * he added, so the Inbox and Calendar pages can show them with Copy, Open and Undo. One small JSON file in
 * `.operator-data/flows/` (atomic writes, owner-only), capped. Nothing here is ever sent anywhere.
 */

export type EmailDraft = {
  id: string;
  to: { name: string; email: string | null };
  subject: string;
  body: string;
  createdAt: string;
  by: string;
  via: "voice" | "typed";
  state: "draft" | "discarded";
};

export type EventAdd = {
  id: string;
  title: string;
  start: string;
  end: string;
  /** Where it went: the OS calendar, or a connected Google / Outlook calendar. */
  where: "os" | "google" | "outlook";
  /** The id of the OS calendar event (where === "os"), so Undo removes exactly that one. */
  localId?: string;
  createdAt: string;
  by: string;
  state: "added" | "undone";
};

export type FlowsState = { version: 1; drafts: EmailDraft[]; events: EventAdd[] };
const empty = (): FlowsState => ({ version: 1, drafts: [], events: [] });
const MAX = 50;

export class FlowsStore {
  private readonly file: string;
  constructor(root: string, private readonly dir = join(root, ".operator-data", "flows")) {
    this.file = join(dir, "state.json");
  }
  read(): FlowsState {
    try {
      if (!existsSync(this.file)) return empty();
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as FlowsState;
      return parsed?.version === 1 && Array.isArray(parsed.drafts) && Array.isArray(parsed.events) ? parsed : empty();
    } catch {
      return empty();
    }
  }
  private write(state: FlowsState) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, drafts: state.drafts.slice(-MAX), events: state.events.slice(-MAX) }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  addDraft(draft: EmailDraft) { const s = this.read(); s.drafts.push(draft); this.write(s); return draft; }
  updateDraft(id: string, by: string, patch: { email: string | null; subject: string; body: string }): EmailDraft | null {
    const s = this.read();
    const d = s.drafts.find((x) => x.id === id && x.by === by && x.state === "draft");
    if (!d) return null;
    d.to.email = patch.email;
    d.subject = patch.subject;
    d.body = patch.body;
    this.write(s);
    return d;
  }
  discardDraft(id: string): EmailDraft | null {
    const s = this.read();
    const d = s.drafts.find((x) => x.id === id);
    if (!d || d.state === "discarded") return null;
    d.state = "discarded";
    this.write(s);
    return d;
  }
  addEvent(event: EventAdd) { const s = this.read(); s.events.push(event); this.write(s); return event; }
  markUndone(id: string): EventAdd | null {
    const s = this.read();
    const e = s.events.find((x) => x.id === id);
    if (!e || e.state === "undone") return null;
    e.state = "undone";
    this.write(s);
    return e;
  }
  draft(id: string) { return this.read().drafts.find((d) => d.id === id) ?? null; }
  event(id: string) { return this.read().events.find((e) => e.id === id) ?? null; }
}
