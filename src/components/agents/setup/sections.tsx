// The six Setup sections and the two notices above them. Presentational: each takes the bot, what the real services
// report, and callbacks; the state machine is in setup-controller.ts. A control is disabled (with its reason beside
// it) when it can't change anything.
import { ArrowUpRight } from "lucide-react";
import { Button, Notice, Surface } from "@/components/ds";
import { INSTRUCTIONS_MAX, NAME_MAX, PURPOSE_MAX, READINESS_WORD, STALE_MESSAGE, diffBots, validateInstructions, validateName, validatePurpose, type Bot, type BotPatch, type BotView } from "@/lib/agent-bots";
import type { ComputersRead } from "@/lib/computers-client";
import type { CodingAccount, CodingAccounts } from "@/lib/coding-client";
import { CheckRow, SelectField, SetupSection, StateLine, SwitchRow, TextArea, TextInput, type SectionStatus } from "./controls";
import type { Conflict, DraftField } from "./setup-controller";
import {
  READINESS_TONE,
  SECTION_IDS,
  accountOptions,
  codingGate,
  computerOptions,
  computerStateLine,
  memoryGate,
  modelOptions,
  poolLine,
  readinessItems,
  routeDisclosure,
  routeGroups,
  routinesGate,
  routineItems,
  skillAbilities,
  skillsSectionShown,
  computerAbilities,
  type Gate,
  type RecoveryAction,
  type SectionKey,
} from "./setup-model";
import type { MemoryPool, Read, RoutineRow, RouterLite, SkillOption } from "./sources";

export type Save = (section: SectionKey, patch: BotPatch) => void;
/** `locked` is true for a pending conflict, or the reason in words (an archived bot can't be edited). */
type Common = { bot: Bot; busy: boolean; locked: boolean | string; status: SectionStatus; save: Save };
export type Navigate = (to: string) => void;

const LOCKED = "Reload the latest first; see the notice at the top.";
/** A pending conflict blocks every write: the reason says so instead of leaving a dead control. */
const lockReason = (locked: boolean | string) => (typeof locked === "string" ? locked : LOCKED);
const lock = (g: Gate, locked: boolean | string): Gate => (locked && !g.disabled ? { disabled: true, reason: lockReason(locked) } : g);
const OPEN: Gate = { disabled: false, reason: null };

function Link({ to, navigate, children }: { to: string; navigate: Navigate; children: React.ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4 hover:text-brand"
    >
      {children}
      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}

// ---------------------------------------------------------------------------------------------------------------

const SECTION_LABEL = { purpose: "Purpose", computer: "Computer", model: "Model and account", skills: "Skills", routines: "Routines", memory: "Memory", manage: "Copy or archive" } as const;

/** The jump list to each section: real links, so it works without a script and focus lands on the section. */
export function SetupNav({ onAction, className, omit = [] }: { onAction: (a: RecoveryAction) => void; className?: string; /** Sections that aren't on the page (a bot with no skills has no Skills section), so no link leads nowhere. */ omit?: readonly SectionKey[] }) {
  return (
    <nav aria-label="Setup sections" className={className ?? "flex flex-wrap gap-x-5 gap-y-1 text-sm"}>
      {(["purpose", "computer", "model", "skills", "routines", "memory", "manage"] as const).filter((k) => !omit.includes(k)).map((k) => (
        <a key={k} href={`#${SECTION_IDS[k]}`} onClick={(e) => { e.preventDefault(); onAction({ label: "", section: k }); }} className="py-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {SECTION_LABEL[k]}
        </a>
      ))}
    </nav>
  );
}

/** What stops this bot working, each with the way to fix it. The page shows it only when something does; a ready bot says so once, in the header. */
export function ReadinessCard({ bot, stale, onAction, omit }: { bot: BotView; stale: boolean; onAction: (a: RecoveryAction) => void; omit?: readonly SectionKey[] }) {
  const r = bot.readiness;
  const items = readinessItems(r);
  return (
    <Surface as="section" aria-labelledby="setup-readiness-title" data-testid="setup-readiness" data-state={r.state} className="flex flex-col gap-3">
      <h2 id="setup-readiness-title" className="text-base font-semibold leading-snug">
        {bot.name}: <span data-testid="readiness-word">{READINESS_WORD[r.state]}</span>
      </h2>
      <div aria-live="polite" className="flex flex-col gap-3">
        {items.length === 0 ? (
          <StateLine tone={READINESS_TONE[r.state]}>{r.state === "ready" ? "Nothing needs doing. Changes below take effect on its next job." : r.state === "working" ? "It is busy with a job right now." : "The hub reported no reasons."}</StateLine>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((it) => (
              <li key={it.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <StateLine tone={READINESS_TONE[r.state]}>{it.text}</StateLine>
                {it.action && (
                  <Button type="button" size="sm" variant="outline" onClick={() => onAction(it.action!)}>
                    {it.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {stale && <p className="text-sm text-muted-foreground">Readiness couldn't be refreshed just now; this is the last state the hub reported.</p>}
      </div>
      <SetupNav onAction={onAction} omit={omit} className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-sm" />
    </Surface>
  );
}

export function ConflictNotice({ conflict, bot, onReload, hasDrafts }: { conflict: Conflict; bot: BotView; onReload: () => void; hasDrafts: boolean }) {
  const diffs = conflict.current ? diffBots(bot, conflict.current) : [];
  return (
    <Notice
      tone="warn"
      title={STALE_MESSAGE}
      action={
        <Button type="button" variant="accent" size="sm" onClick={onReload}>
          Reload latest
        </Button>
      }
    >
      <p>Your last change wasn't saved, and nothing will be until you reload.{hasDrafts ? " The text you were typing stays where it is." : ""}</p>
      {diffs.length > 0 ? (
        <ul data-testid="conflict-diffs" className="mt-2 flex flex-col gap-1">
          {diffs.map((d) => (
            <li key={d.field}>
              <span className="font-medium">{d.label}</span> is now: {d.theirs}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2">The latest values couldn't be read yet; reloading will fetch them.</p>
      )}
    </Notice>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function PurposeSection({ bot, busy, locked, status, drafts, onDraft, onDiscard, onSave }: Omit<Common, "save"> & { drafts: Partial<Record<DraftField, string>>; onDraft: (f: DraftField, t: string) => void; onDiscard: (f: DraftField) => void; onSave: () => void }) {
  const name = drafts.name ?? bot.name;
  const purpose = drafts.purpose ?? bot.purpose;
  const instructions = drafts.instructions ?? bot.instructions;
  const dirty = drafts.name !== undefined || drafts.purpose !== undefined || drafts.instructions !== undefined;
  const nErr = drafts.name !== undefined ? validateName(name) : null;
  const pErr = drafts.purpose !== undefined ? validatePurpose(purpose) : null;
  const iErr = drafts.instructions !== undefined ? validateInstructions(instructions) : null;
  const why = locked ? lockReason(locked) : !dirty ? "Nothing to save yet." : nErr ?? pErr ?? iErr;
  const blocked = busy || !!locked || !dirty || !!nErr || !!pErr || !!iErr;
  return (
    <SetupSection id={SECTION_IDS.purpose} title="Purpose and instructions" description={`What ${bot.name} is for, and standing orders added to every job it is given.`} status={status}>
      <TextInput id="bot-name" label="Name" help={`What you and Jarvis call it: "Ask ${bot.name} to ...". No two bots share a name.`} value={name} max={NAME_MAX} error={nErr} disabled={busy || !!locked} onChange={(t) => onDraft("name", t)} onSubmit={() => !blocked && onSave()} />
      <TextArea id="bot-purpose" label="Purpose" help="One or two sentences. Shown wherever this bot is named." value={purpose} rows={3} max={PURPOSE_MAX} error={pErr} disabled={busy || !!locked} onChange={(t) => onDraft("purpose", t)} onSubmit={() => !blocked && onSave()} />
      <TextArea id="bot-instructions" label="Instructions" help="Given in full to the model on this bot's computer tasks (research, builder, business preparation); quick screen tasks get a short summary. Coding jobs don't use them. Don't put passwords or keys here: they travel with every task." value={instructions} rows={8} max={INSTRUCTIONS_MAX} error={iErr} disabled={busy || !!locked} onChange={(t) => onDraft("instructions", t)} onSubmit={() => !blocked && onSave()} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="accent" disabled={blocked} onClick={onSave} aria-describedby="purpose-save-why">
          Save
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => (["name", "purpose", "instructions"] as const).forEach((f) => drafts[f] !== undefined && onDiscard(f))}>
            Discard changes
          </Button>
        )}
        <span id="purpose-save-why" data-reason="" className="text-sm text-muted-foreground">
          {blocked && !busy ? why : dirty ? "Unsaved changes. Ctrl+Enter saves." : ""}
        </span>
      </div>
    </SetupSection>
  );
}

/** "Scout, Research copy (archived) and Builder". */
function listNames(list: ReadonlyArray<{ name: string; archived: boolean }>): string {
  const names = list.map((b) => (b.archived ? `${b.name} (archived)` : b.name));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------------------------

export function ComputerSection({ bot, busy, locked, status, save, computers, navigate }: Common & { computers: ComputersRead; navigate: Navigate }) {
  const { options, gate } = computerOptions(computers, bot.computer);
  const chosen = computers.status === "ok" ? computers.computers.find((c) => c.name === bot.computer) : undefined;
  const state = chosen ? computerStateLine(chosen) : null;
  return (
    <SetupSection id={SECTION_IDS.computer} title="Computer" description={`Where ${bot.name} does its work. Jobs it is given run on this shared computer.`} status={status}>
      <SelectField id="bot-computer" label="Assigned computer" help="Used from the bot's next job." value={bot.computer ?? ""} options={options} gate={lock(gate, locked)} busy={busy} onChange={(v) => save("computer", { computer: v || null })} />
            {state && <StateLine tone={state.tone} testid="computer-state">{chosen?.label || chosen?.name}: {state.text}</StateLine>}
      {bot.computer && computers.status === "ok" && !chosen && <StateLine tone="danger">“{bot.computer}” isn't one of this hub's shared computers.</StateLine>}
      {bot.computer && (bot.sharesComputerWith?.length ?? 0) > 0 && (
        <div data-testid="computer-shared" className="flex flex-col gap-1">
          <StateLine tone="info">
            Shared with {listNames(bot.sharesComputerWith!)}.
          </StateLine>
          <p className="max-w-[62ch] pl-4 text-sm text-muted-foreground">It runs one task at a time: while one of them is working, the others are asked to try again when it finishes.</p>
        </div>
      )}
      <div>
        <Link to="/computers" navigate={navigate}>Open Computers</Link>
      </div>
    </SetupSection>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function ModelSection({ bot, busy, locked, status, save, router, accounts }: Common & { router: Read<{ router: RouterLite }>; accounts: Read<{ accounts: CodingAccount[]; codexIsolation?: CodingAccounts["codexIsolation"] }> }) {
  const route = bot.modelPreference.route;
  const { groups, note } = routeGroups(router, route);
  const disclosure = routeDisclosure(router, route);
  const cg = codingGate(bot);
  const acc = accountOptions(accounts, bot.coding.accountSlot);
  const info = acc.infos.find((i) => i.slot === bot.coding.accountSlot) ?? null;
  const models = modelOptions(info, bot.coding.model, accounts.status === "ok");
  const accountGate = cg.disabled ? cg : acc.gate;
  const modelGate = cg.disabled ? cg : models.gate;
  const setAccount = (slot: string) => {
    const next = acc.infos.find((i) => i.slot === slot) ?? null;
    // A model belongs to one account: keep it only if the new account offers it.
    const keep = next && bot.coding.model && next.models.includes(bot.coding.model) ? bot.coding.model : null;
    save("model", { coding: { ...bot.coding, accountSlot: slot || null, model: keep } });
  };
  return (
    <SetupSection id={SECTION_IDS.model} title="Model and account" description={bot.coding.enabled ? "Which model this bot's replies use, and which account its coding jobs run on." : "Which model this bot's replies use."} status={status}>
      <SelectField
        id="bot-route"
        label="Model it uses first"
        help="Tried first for its writing and web reading. The receipt shows the model that answered."
        value={route}
        groups={groups}
        gate={lock(OPEN, locked)}
        busy={busy}
        onChange={(v) => save("model", { modelPreference: { route: v } })}
        below={
          <>
            <StateLine tone={disclosure.tone} testid="route-disclosure">{disclosure.text}</StateLine>
            {note && <p data-reason="" className="max-w-[62ch] text-sm text-muted-foreground">{note}</p>}
          </>
        }
      />
      {bot.coding.enabled && (
      <div className="flex flex-col gap-5 border-t border-border pt-5">
        <h3 className="text-base font-semibold">Coding jobs</h3>
        <SelectField
          id="bot-account"
          label="Coding account"
          help="Used the next time it starts a coding job; a running job keeps its account. Review and tests use the hub's own reviewer."
          value={bot.coding.accountSlot ?? ""}
          options={acc.options}
          gate={lock(accountGate, locked)}
          busy={busy}
          onChange={setAccount}
          below={
            info && !cg.disabled ? (
              <>
                <StateLine tone={info.tone} testid="account-state">{info.label}: {info.text}.</StateLine>
                <p className="max-w-[62ch] text-sm text-muted-foreground" data-testid="account-paid">{info.paid}</p>
              </>
            ) : !bot.coding.accountSlot && !cg.disabled && accounts.status === "ok" ? (
              <p className="max-w-[62ch] text-sm text-muted-foreground">The hub picks the first account that can take work when a job starts.</p>
            ) : null
          }
        />
        <SelectField id="bot-coding-model" label="Model" help="Only models this account reports." value={bot.coding.model ?? ""} options={models.options} gate={lock(modelGate, locked)} busy={busy} onChange={(v) => save("model", { coding: { ...bot.coding, model: v || null } })} />
      </div>
      )}
    </SetupSection>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** Read-only: what this bot is able to use. Skills and coding authority are set by the hub, not from this page. */
export function SkillsSection({ bot, status, skills, computers }: { bot: Bot; status: SectionStatus; skills: Read<{ skills: SkillOption[] }>; computers: ComputersRead }) {
  const rows = skillAbilities(skills, bot.skills);
  const onComputer = computerAbilities(computers, bot.computer);
  if (!skillsSectionShown(bot)) return null;
  return (
    <SetupSection id={SECTION_IDS.skills} title="What this bot can do" description="Set by the hub, so shown here and not edited." status={status}>
      {rows.length > 0 && (
      <div>
        <h3 className="text-base font-semibold">Skills</h3>
        {rows.length === 0 ? null : (
          <ul data-testid="skills-list" className="mt-1 divide-y divide-border">
            {rows.map((r) => (
              <li key={r.name} className="py-2.5 text-sm">
                <span className="font-medium text-foreground">{r.name}</span>
                {r.missing && <span className="ml-2 text-muted-foreground">no longer listed by the hub</span>}
                {r.description && <p className="max-w-[62ch] text-muted-foreground">{r.description}</p>}
              </li>
            ))}
          </ul>
        )}
        {skills.status === "unavailable" && rows.length > 0 && <p data-reason="" className="mt-2 max-w-[62ch] text-sm text-muted-foreground">Descriptions aren't shown: {skills.reason}</p>}
      </div>
      )}
      <dl className="flex flex-col gap-4 text-sm">
        {onComputer && bot.computer && (
          <div>
            <dt className="font-medium text-foreground">On its computer</dt>
            <dd data-testid="computer-abilities" className="max-w-[62ch] text-muted-foreground">{onComputer}</dd>
          </div>
        )}
        {bot.coding.enabled && (
          <div>
            <dt className="font-medium text-foreground">Coding jobs</dt>
            <dd data-testid="coding-abilities" className="max-w-[62ch] text-muted-foreground">
              {bot.abilities && !bot.abilities.some((a) => a.id === "coding")
                ? `Coding is on for ${bot.name}, but ${bot.coding.accountSlot ? `its account ${bot.coding.accountSlot} isn't configured on this hub` : "no coding account is configured on this hub"}, so it can't run coding jobs now.`
                : `${bot.name} can run Claude and Codex coding jobs on the shared accounts.`}
            </dd>
          </div>
        )}
      </dl>
    </SetupSection>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function RoutinesSection({ bot, busy, locked, status, save, routines, navigate }: Common & { routines: Read<{ routines: RoutineRow[] }>; navigate: Navigate }) {
  const items = routineItems(routines, bot.routines);
  const gate = lock(routinesGate(routines), locked);
  const toggle = (id: string, on: boolean) => save("routines", { routines: on ? [...bot.routines, id] : bot.routines.filter((r) => r !== id) });
  return (
    <SetupSection id={SECTION_IDS.routines} title="Routines" description={`Linked routines run as ${bot.name}; their progress appears in the conversation with it of the founder who linked them (a routine you link shows up in yours). A routine runs as one bot. Routines are made and scheduled in Automations.`} status={status}>
      {gate.reason && <p data-reason="" className="max-w-[62ch] text-sm text-muted-foreground">{gate.reason}</p>}
      <fieldset className="min-w-0">
        <legend className="mb-1 text-sm text-muted-foreground" data-testid="routines-count">
          {bot.routines.length === 0 ? "None linked." : `${bot.routines.length} linked.`}
        </legend>
        {items.length === 0 && routines.status === "ok" ? (
          <p className="py-3 text-sm text-muted-foreground">There are no routines yet. Create one in Automations, then link it here.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((r) => {
              const on = bot.routines.includes(r.id);
              return <CheckRow key={r.id} label={r.name} meta={r.state === "active" ? undefined : r.state === "paused" ? "paused" : "disabled"} line={r.schedule} checked={on} disabled={busy || (gate.disabled && !on)} onChange={(v) => toggle(r.id, v)} />;
            })}
          </ul>
        )}
      </fieldset>
      <div>
        <Link to="/automations" navigate={navigate}>Create a routine in Automations</Link>
      </div>
    </SetupSection>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function MemorySection({ bot, busy, locked, status, save, memory }: Common & { memory: Read<{ memory: MemoryPool }> }) {
  const pool = poolLine(memory);
  const set = (k: "recall" | "saveResults", v: boolean) => save("memory", { memory: { ...bot.memory, [k]: v } });
  // A switch the hub's memory can't honour is unavailable, and never shown On.
  const recallGate = memoryGate("recall", bot.memory.recall, memory);
  const saveGate = memoryGate("saveResults", bot.memory.saveResults, memory);
  return (
    <SetupSection id={SECTION_IDS.memory} title="Memory" description={`How ${bot.name} uses the shared business memory: one pool for everyone, none of its own.`} status={status}>
      <StateLine tone={pool.tone} testid="pool-status">{pool.text}</StateLine>
      <SwitchRow id="bot-recall" label="Recall from shared memory" help="Each new computer task starts with up to 5 relevant facts, each with its source. Coding jobs don't use this." checked={bot.memory.recall && !recallGate.disabled} gate={lock(recallGate, locked)} busy={busy} onChange={(v) => set("recall", v)} />
      <SwitchRow id="bot-save" label="Save results to shared memory" help="Each finished computer task adds one short memory of its saved result." checked={bot.memory.saveResults && !saveGate.disabled} gate={lock(saveGate, locked)} busy={busy} onChange={(v) => set("saveResults", v)} />
    </SetupSection>
  );
}
