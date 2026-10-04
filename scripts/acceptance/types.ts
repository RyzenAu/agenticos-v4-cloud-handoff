/**
 * Outcome-based acceptance (1 Oct 2026), adapted from OSWorld's idea (xlang-ai/OSWorld, Apache-2.0, pinned in
 * docs/programme-20261001/REFERENCE-ADOPTION.md): a task is DATA (an instruction, the initial state to set up, and
 * an evaluator that reads the OBSERVED state of the application or output afterwards). What the agent, the model or
 * a driver SAYS ("done", "ok", a spoken line) is never an input to an evaluator.
 *
 * Every result is labelled with how real the run was, so a green line can't be read as more than it is.
 */

/**
 * mocked                 in-process fakes stand in for the application, the device and the provider.
 * synthetic-integration  the real OS code paths (stores, routes, dispatcher, leases) driven end to end with synthetic
 *                        companions/computers and temp data; no real application or device.
 * real-local-computer    a real process, application or WSL computer on THIS PC, observed from outside.
 * real-cloud-vm          a real cloud virtual machine. None exists yet: every such check is blocked with the blocker.
 * real-remote-device     a real second device (the other founder's PC, a phone). Needs the owner.
 * live-provider          a real paid or external provider (Claude account, Hindsight pilot, ElevenLabs...).
 */
export type Label = "mocked" | "synthetic-integration" | "real-local-computer" | "real-cloud-vm" | "real-remote-device" | "live-provider";
export const LABELS: readonly Label[] = ["mocked", "synthetic-integration", "real-local-computer", "real-cloud-vm", "real-remote-device", "live-provider"];

export type Check = { name: string; ok: boolean; observed: unknown };

/** One way of observing a task. A task usually has a synthetic probe (run now, repeatable) and a real one. */
export type ProbeResult = {
  label: Label;
  /** "run-now": executed by this run. "earlier-evidence": an artefact of a real run made earlier, re-read and re-evaluated now. */
  freshness: "run-now" | "earlier-evidence";
  /** For earlier evidence: when that artefact was written (file time). */
  evidenceAt?: string;
  source: string;
  checks: Check[];
  notes?: string[];
};

export type Status =
  /** Every probe that ran passed and at least one real (non-mocked, non-synthetic) probe did, or the task only asks for synthetic. */
  | "pass"
  /** A probe ran and an evaluator found the observed state wrong. */
  | "fail"
  /** It passes at a weaker label only (synthetic/mocked); the real run is blocked by `blocker`. */
  | "partial"
  /** Nothing could run: `blocker` names exactly what is missing. */
  | "blocked"
  /** The evaluator is ready; the run needs the owner (e.g. his microphone). */
  | "owed";

export type TaskResult = {
  id: number;
  key: string;
  title: string;
  status: Status;
  /** The strongest label among the probes that PASSED (null when none did). */
  bestLabel: Label | null;
  probes: ProbeResult[];
  /** The exact thing that stops a stronger run; set for blocked / partial / owed. */
  blocker?: string;
  ms: number;
};

/** OSWorld-style task config: what is asked, what must exist first, and what the evaluator reads. */
export type TaskConfig = {
  id: number;
  key: string;
  title: string;
  /** The instruction as a person would give it. */
  instruction: string;
  /** Initial state to set up (fixtures) before anything runs. */
  setup: string[];
  /** What the evaluator reads after: observed state only. */
  evaluator: { reads: string[]; expects: string[] };
  /** Resources this task creates and will remove (cleanup touches only these). */
  creates: string[];
};

export type Ctx = {
  /** A per-run scratch folder on D: (never C:). */
  scratch: string;
  run: string;
  fixtures: import("./fixtures").Fixtures;
  root: string;
  /** Register a cleanup that touches only what this run created; runs last-in first-out, always. */
  onCleanup(name: string, fn: () => void | Promise<void>): void;
  log(line: string): void;
  /** Probes that need a long or heavy real run are skipped with --quick. */
  quick: boolean;
};

export type Task = { config: TaskConfig; run(ctx: Ctx): Promise<Omit<TaskResult, "id" | "key" | "title" | "ms">> };
