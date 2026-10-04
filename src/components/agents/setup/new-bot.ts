// The "New bot" form's state machine, with no React in it so every rule is testable against the fake client. The hub is the authority (it checks
// the computer, the account, the model route, and that the name and id are free); this checks only what can be said without asking, then shows
// whatever the hub refused against the field it names.
import { NAME_MAX, validateInstructions, validateName, validatePurpose, type AgentBotsClient, type BotView, type FieldProblem, type NewBotInput } from "@/lib/agent-bots";

export type NewBotField = "name" | "purpose" | "instructions" | "computer" | "coding" | "accountSlot" | "route";
export type NewBotDraft = {
  name: string;
  purpose: string;
  instructions: string;
  /** A shared computer's name, or "" for none yet. */
  computer: string;
  /** Can it run coding jobs? Chosen here, not later: a bot's coding authority is set when it is made. */
  coding: boolean;
  /** "" = the hub picks an account that can take work. Only used when coding is on. */
  accountSlot: string;
  route: string;
};
export type NewBotState = {
  draft: NewBotDraft;
  errors: Partial<Record<NewBotField, string>>;
  submitting: boolean;
  /** Something that isn't one field's: not signed in, the service is down. */
  formError: string | null;
  /** The bot the hub made; the page then opens it. */
  created: BotView | null;
};

export const EMPTY_DRAFT: NewBotDraft = { name: "", purpose: "", instructions: "", computer: "", coding: false, accountSlot: "", route: "auto" };

/** Which form field a hub field name belongs to. */
const FIELD_OF: Record<string, NewBotField> = { name: "name", id: "name", purpose: "purpose", instructions: "instructions", computer: "computer", coding: "coding", "coding.enabled": "coding", "coding.accountSlot": "accountSlot", "coding.model": "accountSlot", modelPreference: "route", "modelPreference.route": "route" };

export function inputOf(d: NewBotDraft): NewBotInput {
  return {
    name: d.name.replace(/\s+/g, " ").trim(),
    purpose: d.purpose.trim(),
    ...(d.instructions.trim() ? { instructions: d.instructions.trim() } : {}),
    computer: d.computer || null,
    coding: { enabled: d.coding, accountSlot: d.coding && d.accountSlot ? d.accountSlot : null, model: null },
    modelPreference: { route: d.route || "auto" },
  };
}

/** Pure: what can be said about a draft without asking the hub. */
export function localErrors(d: NewBotDraft): Partial<Record<NewBotField, string>> {
  const out: Partial<Record<NewBotField, string>> = {};
  const n = validateName(d.name);
  if (n) out.name = n;
  const p = validatePurpose(d.purpose);
  if (p) out.purpose = p;
  const i = validateInstructions(d.instructions);
  if (i) out.instructions = i;
  return out;
}

export function createNewBotController(opts: { client: AgentBotsClient }) {
  let state: NewBotState = { draft: EMPTY_DRAFT, errors: {}, submitting: false, formError: null, created: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NewBotState> | ((s: NewBotState) => Partial<NewBotState>)) => {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    listeners.forEach((l) => l());
  };
  const hubErrors = (errors: FieldProblem[], message: string) => {
    const out: Partial<Record<NewBotField, string>> = {};
    for (const e of errors) {
      const f = FIELD_OF[e.field];
      if (f && !out[f]) out[f] = e.message;
    }
    // A refusal that names no field of this form is still said, once, above the buttons.
    return { errors: out, formError: Object.keys(out).length ? null : message };
  };

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setField<K extends keyof NewBotDraft>(key: K, value: NewBotDraft[K]) {
      set((s) => {
        const errors = { ...s.errors };
        delete errors[key as NewBotField];
        if (key === "coding") delete errors.accountSlot;
        return { draft: { ...s.draft, [key]: value }, errors, formError: null };
      });
    },
    reset: () => set({ draft: EMPTY_DRAFT, errors: {}, submitting: false, formError: null, created: null }),
    /** Make the bot. One request at a time; a refusal keeps every field as typed. */
    async submit(): Promise<BotView | null> {
      // One request at a time, and one bot per form: once the hub made it, a second click makes nothing.
      if (state.submitting || state.created) return null;
      const local = localErrors(state.draft);
      if (Object.keys(local).length) {
        set({ errors: local, formError: null });
        return null;
      }
      set({ submitting: true, errors: {}, formError: null });
      const r = await opts.client.create(inputOf(state.draft));
      if (r.kind === "ok") {
        set({ submitting: false, created: r.bot });
        return r.bot;
      }
      if (r.kind === "invalid" || r.kind === "taken") set({ submitting: false, ...hubErrors(r.errors, r.message) });
      else set({ submitting: false, formError: r.message });
      return null;
    },
  };
}

export type NewBotController = ReturnType<typeof createNewBotController>;
export { NAME_MAX };
