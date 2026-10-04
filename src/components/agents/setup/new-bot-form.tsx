// "New bot": a calm single-column form opened from the selector. It makes a bot that POINTS at what already exists: it never makes a computer,
// and a computer another bot uses can be chosen again (they then share its one control lease: it runs one task at a time). Everything the hub refuses is shown on its field.
import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Surface } from "@/components/ds";
import { INSTRUCTIONS_MAX, NAME_MAX, PURPOSE_MAX, agentBots, type AgentBotsClient, type BotView } from "@/lib/agent-bots";
import { SelectField, StateLine, SwitchRow, TextArea, TextInput } from "./controls";
import { createNewBotController } from "./new-bot";
import { accountOptions, computerOptions, routeGroups } from "./setup-model";
import { liveSources, type SetupSources } from "./sources";

type Sharer = { id: string; name: string; computer?: string | null; lifecycle?: string };

function useSource<T>(name: keyof SetupSources, sources: SetupSources) {
  return useQuery({ queryKey: ["agent-setup", name], queryFn: () => (sources[name] as () => Promise<T>)(), staleTime: 20_000 });
}

export function NewBotPanel({ bots, client = agentBots, sources = liveSources, onCreated, onCancel }: { bots: readonly Sharer[]; client?: AgentBotsClient; sources?: SetupSources; onCreated: (bot: BotView) => void; onCancel: () => void }) {
  const controller = useMemo(() => createNewBotController({ client }), [client]);
  const s = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const computers = useSource<Awaited<ReturnType<SetupSources["computers"]>>>("computers", sources);
  const accounts = useSource<Awaited<ReturnType<SetupSources["accounts"]>>>("accounts", sources);
  const router = useSource<Awaited<ReturnType<SetupSources["router"]>>>("router", sources);
  const d = s.draft;

  const computer = computers.data ? computerOptions(computers.data, d.computer || null) : { options: [{ value: "", label: "No computer yet" }], gate: { disabled: true, reason: "Reading the shared computers…" } };
  const noneYet = { value: "", label: "No computer yet" };
  const computerChoices = computer.options.map((o) => (o.value === "" ? noneYet : o));
  const sharers = d.computer ? bots.filter((b) => b.computer === d.computer && b.lifecycle !== "archived") : [];
  const route = router.data ? routeGroups(router.data, d.route) : null;
  const acc = accounts.data ? accountOptions(accounts.data, d.accountSlot || null) : null;
  const hasAccounts = accounts.data?.status === "ok" && accounts.data.accounts.length > 0;
  const codingGate = !accounts.data ? { disabled: true, reason: "Reading the coding accounts…" } : hasAccounts ? { disabled: false, reason: null } : { disabled: true, reason: accounts.data.status === "unavailable" ? `${accounts.data.reason} Coding can't be turned on until it can be read.` : "No coding accounts are set up on this hub, so coding jobs couldn't run." };
  const busy = s.submitting;

  async function submit() {
    const bot = await controller.submit();
    if (bot) {
      controller.reset();
      onCreated(bot);
    }
  }

  return (
    <Surface as="section" aria-labelledby="new-bot-title" data-testid="new-bot" className="flex max-w-[46rem] flex-col gap-5">
      <div>
        <h2 id="new-bot-title" className="text-lg font-semibold leading-snug tracking-[-0.01em]">New bot</h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">A bot works on a shared computer that already exists, and runs whatever you ask it in your own conversation with it. Making one never makes a computer.</p>
      </div>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextInput id="new-bot-name" label="Name" help={'What you and Jarvis call it: "Ask Scout to ...". No two bots share a name.'} value={d.name} max={NAME_MAX} error={s.errors.name} disabled={busy} autoFocus placeholder="Scout" onChange={(t) => controller.setField("name", t)} />
        <TextArea id="new-bot-purpose" label="Purpose" help="One or two sentences on what it is for." value={d.purpose} rows={3} max={PURPOSE_MAX} error={s.errors.purpose} disabled={busy} onChange={(t) => controller.setField("purpose", t)} />
        <SelectField
          id="new-bot-computer"
          label="Computer"
          help="Where its tasks run. Pick a shared computer that exists, or none for now and choose one in its Setup."
          value={d.computer}
          options={computerChoices}
          gate={computer.gate}
          busy={busy}
          onChange={(v) => controller.setField("computer", v)}
          below={
            <>
              {s.errors.computer && <p role="alert" className="text-sm text-danger">{s.errors.computer}</p>}
              {sharers.length > 0 && <StateLine tone="info">{sharers.map((b) => b.name).join(", ")} already {sharers.length === 1 ? "uses" : "use"} this computer. They share its one control lease: it runs one task at a time, so ask again when the other bot finishes.</StateLine>}
            </>
          }
        />
        <SelectField
          id="new-bot-route"
          label="Model it uses first"
          help="Which model its own writing and extraction try first. Automatic is right for most bots."
          value={d.route}
          groups={route?.groups ?? [{ label: "Let the hub decide", options: [{ value: "auto", label: "Automatic" }, { value: "free-only", label: "Free models only" }] }]}
          gate={{ disabled: false, reason: null }}
          busy={busy}
          onChange={(v) => controller.setField("route", v)}
          below={s.errors.route ? <p role="alert" className="text-sm text-danger">{s.errors.route}</p> : undefined}
        />
        <TextArea id="new-bot-instructions" label="Instructions (optional)" help="Standing orders added to every computer task it runs. Don't put passwords or keys here: they travel with every task." value={d.instructions} rows={5} max={INSTRUCTIONS_MAX} error={s.errors.instructions} disabled={busy} onChange={(t) => controller.setField("instructions", t)} />
        <div className="flex flex-col gap-4 border-t border-border pt-5">
          <SwitchRow id="new-bot-coding" label="Can run coding jobs" help="Claude and Codex coding jobs on the shared accounts. This is chosen now: it can't be switched on or off from Setup later." checked={d.coding} gate={codingGate} busy={busy} onChange={(v) => controller.setField("coding", v)} />
          {d.coding && acc && (
            <SelectField id="new-bot-account" label="Coding account" help="Which account its coding jobs use. Automatic lets the hub pick one that can take work." value={d.accountSlot} options={acc.options} gate={acc.gate.disabled && hasAccounts ? { disabled: false, reason: null } : acc.gate} busy={busy} onChange={(v) => controller.setField("accountSlot", v)} below={s.errors.accountSlot ? <p role="alert" className="text-sm text-danger">{s.errors.accountSlot}</p> : undefined} />
          )}
          {s.errors.coding && <p role="alert" className="text-sm text-danger">{s.errors.coding}</p>}
        </div>
        {s.formError && (
          <p role="alert" data-testid="new-bot-error" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-foreground">
            {s.formError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? "Creating…" : "Create bot"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Surface>
  );
}
