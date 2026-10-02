// "Add a shared computer": the one place a founder creates Research, Builder or any other shared computer.
// The hub only lets a person do this (a confirmed browser or paired device), and says so itself: its refusal text is shown as it was said,
// and what was typed stays put. Hosts and what they lack come from GET /__computers/host; nothing here guesses.
import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Notice, Surface } from "@/components/ds";
import { hostLabel, hostProblem, hostReadiness, nameProblem, provisionComputer, provisionSequence, readHosts, suggestPair, type HostEntry } from "@/lib/computers-client";

const field = "h-11 w-full min-w-0 rounded-xl border border-input bg-background px-3 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";
export const ISOLATION_SENTENCE = "Shared computers on one host have separate Linux users and files but share that host; they are not separate machines.";

type Phase = { kind: "idle" } | { kind: "creating"; what: string } | { kind: "done"; message: string } | { kind: "failed"; message: string };

export function AddComputer({ existing, onCreated }: { existing: string[]; onCreated?: () => void }) {
  const hostsQ = useQuery({ queryKey: ["computers-hosts"], queryFn: readHosts, staleTime: 10_000, retry: false });
  const hosts = hostsQ.data?.status === "ok" ? hostsQ.data.hosts : [];
  const usable = hosts.filter((h) => !hostProblem(h));
  const [adapter, setAdapter] = useState<string>("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inFlight = useRef(false); // a double click must not send twice, even before the state has re-rendered
  const chosen = hosts.find((h) => h.kind === adapter && !hostProblem(h)) ?? usable[0] ?? null;
  const problem = name ? nameProblem(name, existing) : null;
  const creating = phase.kind === "creating";
  const pair = suggestPair(hosts, existing);

  async function run(what: string, job: () => Promise<{ ok: boolean; message: string }>, onOk?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "creating", what });
    try {
      const r = await job();
      if (r.ok) {
        setPhase({ kind: "done", message: r.message });
        onOk?.();
        onCreated?.();
      } else setPhase({ kind: "failed", message: r.message });
    } finally {
      inFlight.current = false;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen || nameProblem(name, existing)) return;
    void run(
      name,
      async () => {
        const r = await provisionComputer({ name, adapter: chosen.kind, label });
        return r.ok ? { ok: true, message: `Created ${name} on ${hostLabel(chosen)}.` } : { ok: false, message: r.message };
      },
      () => {
        setName("");
        setLabel("");
      },
    );
  }

  const suggest = (h: HostEntry) =>
    run("Research and Builder", () =>
      provisionSequence([
        { name: "research", adapter: h.kind, label: "Research" },
        { name: "builder", adapter: h.kind, label: "Builder" },
      ]),
    );

  return (
    <Surface variant="inset" className="mb-6" data-testid="add-computer">
      <h3 className="text-base font-medium">Add a shared computer</h3>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="isolation-sentence">{ISOLATION_SENTENCE}</p>
      {hostsQ.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Reading the hosts…</p>
      ) : hostsQ.data?.status === "unavailable" ? (
        <p className="mt-3 text-sm text-muted-foreground">{hostsQ.data.reason} Nothing can be added until it answers.</p>
      ) : hosts.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No computer host is configured on this hub, so there is nowhere to add one.</p>
      ) : (
        <>
          {pair && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-background p-3" data-testid="suggest-pair">
              <p className="min-w-0 flex-1 text-[15px]">Research and Builder do not exist yet.</p>
              <Button variant="accent" className="h-auto min-h-11 w-full whitespace-normal py-2 text-center sm:w-auto" disabled={creating} onClick={() => void suggest(pair)}>Create Research and Builder on {hostLabel(pair)}</Button>
            </div>
          )}
          <form onSubmit={submit} className="mt-4 flex flex-col gap-3" aria-label="Add a shared computer">
            <fieldset className="flex flex-col gap-2" disabled={creating}>
              <legend className="mb-1 text-sm text-muted-foreground">Where it runs</legend>
              {hosts.map((h) => {
                const why = hostProblem(h);
                return (
                  <label key={h.kind} className={`flex min-h-11 items-start gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-[15px] ${why ? "opacity-70" : ""}`}>
                    <input type="radio" name="host" className="mt-1" checked={!why && chosen?.kind === h.kind} disabled={!!why} onChange={() => setAdapter(h.kind)} />
                    <span className="min-w-0">
                      <span className="font-medium">{hostLabel(h)}</span>
                      {why && <span className="mt-0.5 block text-sm text-muted-foreground" data-testid={`host-problem-${h.kind}`}>Not available: {why}</span>}
                      {!why && hostReadiness(h) && <span className="mt-0.5 block text-sm text-muted-foreground" data-testid={`host-ready-${h.kind}`}>{hostReadiness(h)}</span>}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              Name
              <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className={field} placeholder="research" maxLength={32} disabled={creating} autoCapitalize="none" spellCheck={false} aria-invalid={!!problem} />
              {problem ? <span className="text-sm text-destructive" role="status">{problem}</span> : <span className="text-xs">Lowercase letters, digits and hyphens.</span>}
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              Label (optional)
              <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} placeholder="Research" maxLength={48} disabled={creating} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="accent" disabled={creating || !chosen || !name || !!problem}>{creating ? "Creating…" : "Add computer"}</Button>
            </div>
          </form>
        </>
      )}
      {phase.kind === "creating" && <Notice className="mt-4" tone="info" title={`Creating ${phase.what}`}>This can take a minute: the host sets up the desktop and pairs it. Keep this page open.</Notice>}
      {phase.kind === "done" && <Notice className="mt-4" tone="success" title="Created">{phase.message}</Notice>}
      {phase.kind === "failed" && <Notice className="mt-4" tone="warn" title="Didn't work">{phase.message}</Notice>}
    </Surface>
  );
}
