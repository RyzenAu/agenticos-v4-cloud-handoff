// The Setup tab's state machine, with no React in it so the rules are testable against the fake client:
//  - one write at a time, each carrying the rev the person was looking at;
//  - a stale rev (409) is refused honestly: the server's copy is kept aside, the person's text stays where it is,
//    and nothing is written until they choose to reload;
//  - an error never clears a form; a save updates the bot AND its readiness (read again when the PATCH answer
//    didn't carry it);
//  - drafts exist only for the text fields (name, purpose, instructions) that are saved with an explicit Save;
//  - duplicating and archiving go through the same controller, so they carry the same rev and meet the same conflict notice.
import { validateInstructions, validateName, validatePurpose, type AgentBotsClient, type Bot, type BotId, type BotPatch, type BotReadiness, type BotView, type WorkItem, STALE_MESSAGE } from "@/lib/agent-bots";
import type { SectionKey } from "./setup-model";

export type DraftField = "name" | "purpose" | "instructions";
/** Archiving in progress: the confirmation, what stood in its way, and the last thing that went wrong. */
export type ManageState = {
  confirming: "archive" | null;
  busy: "duplicate" | "archive" | "unarchive" | null;
  /** Archiving was refused because of open work (the list) or a rule (no list): nothing changed. */
  blocked: { code: string; message: string; work: WorkItem[] } | null;
  error: string | null;
  /** The copy that was just made, so the page can offer to open it. */
  duplicated: BotView | null;
};
const IDLE_MANAGE: ManageState = { confirming: null, busy: null, blocked: null, error: null, duplicated: null };
export type Conflict = { section: SectionKey; current: BotView | null; attempted: BotPatch };

export type SetupState = {
  load: "loading" | "ready" | "missing" | "unavailable";
  loadError: string | null;
  /** The last copy the server confirmed. Controls show this, never an optimistic guess. */
  bot: BotView | null;
  /** Unsaved text, present only for a field that differs from `bot`. */
  drafts: Partial<Record<DraftField, string>>;
  /** The section whose write is in flight (null = idle). */
  saving: SectionKey | null;
  /** When each section's last write landed (ms); cleared when that section is edited again. */
  savedAt: Partial<Record<SectionKey, number>>;
  errors: Partial<Record<SectionKey, string>>;
  conflict: Conflict | null;
  /** True when the last save succeeded but its readiness could not be read again. */
  readinessStale: boolean;
  /** A bump on every readiness refresh, so the page can announce it. */
  readinessAt: number | null;
  manage: ManageState;
};

export const SECTION_OF: Record<keyof BotPatch, SectionKey> = {
  name: "purpose",
  purpose: "purpose",
  instructions: "purpose",
  computer: "computer",
  coding: "model",
  modelPreference: "model",
  routines: "routines",
  memory: "memory",
};

const INITIAL: SetupState = { load: "loading", loadError: null, bot: null, drafts: {}, saving: null, savedAt: {}, errors: {}, conflict: null, readinessStale: false, readinessAt: null, manage: IDLE_MANAGE };

export type SetupController = ReturnType<typeof createSetupController>;

/** Unsaved Setup text by bot, kept for the life of the page so switching to Chat or Tasks and back loses nothing. */
export const workspaceDrafts = new Map<string, Partial<Record<DraftField, string>>>();

export function createSetupController(opts: { botId: BotId; client: AgentBotsClient; now?: () => number; /** Where unsaved text is kept across an unmount. Absent: nowhere (tests). */ draftStore?: Map<string, Partial<Record<DraftField, string>>> }) {
  const now = opts.now ?? (() => Date.now());
  // Unsaved text outlives this controller when the page gives a store (a tab switch unmounts Setup; coming back finds the text where it was).
  let state: SetupState = { ...INITIAL, drafts: opts.draftStore?.get(opts.botId) ?? {} };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SetupState> | ((s: SetupState) => Partial<SetupState>)) => {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    if (opts.draftStore) {
      if (Object.keys(state.drafts).length) opts.draftStore.set(opts.botId, state.drafts);
      else opts.draftStore.delete(opts.botId);
    }
    listeners.forEach((l) => l());
  };
  const without = <T extends object>(o: T, k: keyof T): T => {
    const { [k]: _gone, ...rest } = o;
    return rest as T;
  };
  /** Drop any draft the server copy already matches, so "unsaved" always means "differs from what's saved". */
  const settleDrafts = (bot: Bot, drafts: SetupState["drafts"]) => {
    const out: SetupState["drafts"] = {};
    (["name", "purpose", "instructions"] as const).forEach((f) => {
      if (drafts[f] !== undefined && drafts[f] !== bot[f]) out[f] = drafts[f];
    });
    return out;
  };

  async function load() {
    set({ load: "loading", loadError: null });
    const r = await opts.client.get(opts.botId);
    if (r.kind === "ok") set((s) => ({ load: "ready", bot: r.bot, drafts: settleDrafts(r.bot, s.drafts), conflict: null, errors: {} }));
    else if (r.kind === "missing") set({ load: "missing", loadError: "This bot doesn't exist on this hub." });
    else set({ load: "unavailable", loadError: r.message });
  }

  /** The person chose to see the latest: adopt the server's copy (and its rev). Unsaved text is kept. */
  async function reload() {
    const r = await opts.client.get(opts.botId);
    if (r.kind === "ok") set((s) => ({ bot: r.bot, drafts: settleDrafts(r.bot, s.drafts), conflict: null, errors: {}, readinessStale: false, readinessAt: now() }));
    else set((s) => ({ errors: { ...s.errors, [s.conflict?.section ?? "purpose"]: r.kind === "missing" ? "That bot no longer exists." : r.message } }));
  }

  /** Read the bot again for its readiness only: never adopts fields, so a conflict is never hidden by a refresh. */
  async function refreshReadiness(expectRev: number) {
    const r = await opts.client.get(opts.botId);
    if (r.kind === "ok" && state.bot) {
      const readiness: BotReadiness = r.bot.readiness;
      set((s) => ({ bot: s.bot ? { ...s.bot, readiness, ...(r.bot.conversationId ? { conversationId: r.bot.conversationId } : {}) } : s.bot, readinessStale: r.bot.rev !== expectRev, readinessAt: now() }));
    } else set({ readinessStale: true });
  }

  async function write(patch: BotPatch, section: SectionKey): Promise<boolean> {
    const bot = state.bot;
    if (!bot || state.saving || state.conflict) return false;
    set((s) => ({ saving: section, errors: without(s.errors, section) }));
    const r = await opts.client.patch(opts.botId, bot.rev, patch);
    if (r.kind === "ok") {
      const saved = r.bot;
      set((s) => {
        const drafts = { ...s.drafts };
        if (patch.name !== undefined && drafts.name === patch.name) delete drafts.name;
        if (patch.purpose !== undefined && drafts.purpose === patch.purpose) delete drafts.purpose;
        if (patch.instructions !== undefined && drafts.instructions === patch.instructions) delete drafts.instructions;
        return { bot: saved, drafts: settleDrafts(saved, drafts), saving: null, savedAt: { ...s.savedAt, [section]: now() }, readinessStale: false };
      });
      if (r.readinessReported) set({ readinessAt: now() });
      else await refreshReadiness(saved.rev);
      return true;
    }
    if (r.kind === "stale") {
      let current = r.current;
      if (!current) {
        const again = await opts.client.get(opts.botId);
        current = again.kind === "ok" ? again.bot : null;
      }
      set({ saving: null, conflict: { section, current, attempted: patch } });
      return false;
    }
    set((s) => ({ saving: null, errors: { ...s.errors, [section]: r.message } }));
    return false;
  }

  function setDraft(field: DraftField, text: string) {
    set((s) => {
      const base = s.bot?.[field] ?? "";
      const drafts = { ...s.drafts };
      if (text === base) delete drafts[field];
      else drafts[field] = text;
      return { drafts, savedAt: without(s.savedAt, "purpose"), errors: without(s.errors, "purpose") };
    });
  }
  const discardDraft = (field: DraftField) => set((s) => ({ drafts: without(s.drafts, field) }));

  /** Explicit Save for the two text fields: only what changed, only if it is valid. */
  async function savePurpose(): Promise<boolean> {
    const { drafts } = state;
    const patch: BotPatch = {};
    if (drafts.name !== undefined) {
      const e = validateName(drafts.name);
      if (e) {
        set((s) => ({ errors: { ...s.errors, purpose: e } }));
        return false;
      }
      patch.name = drafts.name.replace(/\s+/g, " ").trim();
    }
    if (drafts.purpose !== undefined) {
      const e = validatePurpose(drafts.purpose);
      if (e) {
        set((s) => ({ errors: { ...s.errors, purpose: e } }));
        return false;
      }
      patch.purpose = drafts.purpose.trim();
    }
    if (drafts.instructions !== undefined) {
      const e = validateInstructions(drafts.instructions);
      if (e) {
        set((s) => ({ errors: { ...s.errors, purpose: e } }));
        return false;
      }
      patch.instructions = drafts.instructions;
    }
    if (Object.keys(patch).length === 0) return false;
    return write(patch, "purpose");
  }

  const manage = (patch: Partial<ManageState>) => set((s) => ({ manage: { ...s.manage, ...patch } }));

  /** A conflict, a write in flight or another manage action in flight stops this one. */
  const mayManage = () => !!state.bot && !state.saving && !state.conflict && !state.manage.busy;

  /** Archive (after the person confirmed) or, with `afterCurrentWork`, archive and let running jobs finish. Refusals leave everything as it was. */
  async function archive(options: { afterCurrentWork?: boolean } = {}): Promise<boolean> {
    if (!mayManage()) return false;
    const bot = state.bot!;
    // Already archived (a second click after the first landed): nothing to ask the hub.
    if (bot.lifecycle === "archived" || bot.lifecycle === "archiving" || bot.archived) return false;
    manage({ busy: "archive", error: null });
    const r = await opts.client.archive(opts.botId, bot.rev, { archived: true, ...(options.afterCurrentWork ? { afterCurrentWork: true } : {}) });
    if (r.kind === "ok") {
      set((s) => ({ bot: r.bot, drafts: settleDrafts(r.bot, s.drafts), manage: IDLE_MANAGE, savedAt: { ...s.savedAt, manage: now() } }));
      return true;
    }
    if (r.kind === "stale") {
      let current = r.current;
      if (!current) {
        const again = await opts.client.get(opts.botId);
        current = again.kind === "ok" ? again.bot : null;
      }
      set((s) => ({ conflict: { section: "manage", current, attempted: {} }, manage: { ...s.manage, busy: null, confirming: null } }));
      return false;
    }
    if (r.kind === "blocked") {
      // Open work: stay in the confirmation so "archive after current work" is one click away. A rule (the last active bot) is just said.
      manage(r.code === "has-running-work" ? { busy: null, blocked: { code: r.code, message: r.message, work: r.work } } : { busy: null, confirming: null, blocked: null, error: r.message });
      return false;
    }
    manage({ busy: null, error: r.message });
    return false;
  }

  async function unarchive(): Promise<boolean> {
    if (!mayManage()) return false;
    const bot = state.bot!;
    if (!(bot.lifecycle === "archived" || bot.lifecycle === "archiving" || bot.archived)) return false;
    manage({ busy: "unarchive", error: null });
    const r = await opts.client.archive(opts.botId, bot.rev, { archived: false });
    if (r.kind === "ok") {
      set((s) => ({ bot: r.bot, manage: IDLE_MANAGE, savedAt: { ...s.savedAt, manage: now() } }));
      return true;
    }
    if (r.kind === "stale") {
      set((s) => ({ conflict: { section: "manage", current: r.current, attempted: {} }, manage: { ...s.manage, busy: null } }));
      return false;
    }
    manage({ busy: null, error: r.message });
    return false;
  }

  /** Make "<name> copy": configuration only. The new bot is offered to the person; this one is untouched. */
  async function duplicate(): Promise<BotView | null> {
    // A copy was just made and its notice is still up: a second click (a double-click on a fast hub) makes no second copy. Dismissing the notice
    // is the deliberate way to make another.
    if (!mayManage() || state.manage.duplicated) return null;
    manage({ busy: "duplicate", error: null, duplicated: null });
    const r = await opts.client.duplicate(opts.botId);
    if (r.kind === "ok") {
      set((s) => ({ manage: { ...IDLE_MANAGE, duplicated: r.bot }, savedAt: { ...s.savedAt, manage: now() } }));
      return r.bot;
    }
    manage({ busy: null, error: r.message });
    return null;
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    load,
    reload,
    setDraft,
    discardDraft,
    savePurpose,
    askArchive: () => mayManage() && manage({ confirming: "archive", blocked: null, error: null }),
    cancelArchive: () => manage({ confirming: null, blocked: null }),
    archive,
    unarchive,
    duplicate,
    dismissDuplicated: () => manage({ duplicated: null }),
    save: (section: SectionKey, patch: BotPatch) => write(patch, section),
    dismissError: (section: SectionKey) => set((s) => ({ errors: without(s.errors, section) })),
  };
}

export const CONFLICT_REASON = `${STALE_MESSAGE}. Nothing more is saved until you reload.`;
