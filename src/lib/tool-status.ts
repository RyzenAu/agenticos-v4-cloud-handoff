// ONE status per AI tool (R7 audit 2, items 4 and 5). The Claude Code page said "Ready" while System said "Sign-in needed" and Settings said
// "Installed · not connected"; Hermes had three wordings on three pages. All three now read the model-provider check (GET /__operator/models,
// the same read System makes) and word it with providerView, so a tool can only ever have one state and one label.
import { useQuery } from "@tanstack/react-query";
import { providerView, type ModelSnapshot, type ProviderStatus, type ProviderView } from "@/components/shell/system-facts";

export function useToolStatuses() {
  return useQuery({
    queryKey: ["system", "models"], // the same key System uses: one read, shared
    queryFn: async () => {
      const res = await fetch("/__operator/models?snapshot=1", { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => null);
      if (!res.ok || body === null) throw new Error(`The tool check answered HTTP ${res.status}`);
      return body as ModelSnapshot;
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.checking ? 2_000 : false),
  });
}

/** The tool's one view, or null when the check has not produced a row for it (never a guess). */
export function toolView(statuses: ProviderStatus[] | undefined | null, id: string): ProviderView | null {
  const row = (statuses ?? []).find((s) => s.id === id);
  return row ? providerView(row) : null;
}

/** Tone for the widgets and dots that take success / warn / muted. */
export function toolTone(view: ProviderView | null): "success" | "warn" | "muted" {
  if (!view) return "muted";
  return view.state === "verified" ? "success" : view.state === "failed" || view.state === "setup" ? "warn" : "muted";
}

/** What to show while there is no row: the same words on every page. */
export function toolPlaceholder(snapshot: { isPending: boolean; isError: boolean } | undefined): string {
  if (!snapshot || snapshot.isPending) return "Checking…";
  return snapshot.isError ? "Check unavailable" : "Not checked yet";
}

/** ", last checked 3 Oct, 2:15 pm", or "" when the check has no time. */
function checkedWhen(checkedAt: string | null | undefined): string {
  const at = checkedAt ? Date.parse(checkedAt) : NaN;
  return Number.isFinite(at) ? `, last checked ${new Date(at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "";
}

/**
 * One line of next step, by state, used under the status word wherever it appears. The check itself is hub-only, so this never tells a person
 * to run it: it says where the check happens and when it last ran.
 */
export function toolNextStep(id: string, view: ProviderView | null, checkedAt?: string | null): string {
  const name = id === "claude" ? "Claude Code" : id === "hermes" ? "Hermes" : id === "codex" ? "Codex" : "This tool";
  const when = checkedWhen(checkedAt);
  if (!view) return `Not checked yet. The hub PC runs the tool check${when}.`;
  switch (view.state) {
    case "verified": return "Signed in and answering.";
    case "setup": return /sign/i.test(view.label) ? `Sign in to ${name} on the hub PC. It is re-checked there${when}.` : `Install ${name} on the hub PC. It is re-checked there${when}.`;
    case "failed": return `The last check failed${when}. It is re-checked on the hub PC.`;
    case "installed": return `${name} is installed but not confirmed${when}. The hub PC does the confirming.`;
    default: return `Not confirmed yet. The hub PC runs the check${when}.`;
  }
}

type HermesRun = { installed?: boolean; needsSetup?: boolean; defaultModel?: string | null } | null | undefined;

/**
 * Hermes page state. Installed and running come from the live Hermes read (it also drives the tabs); the shared tool check only supplies the
 * status word. They can disagree, so the install card, the tabs and the headline all follow the one live read and never both go missing.
 */
export function hermesPageState(opts: { status: HermesRun; isLoading: boolean; view: ProviderView | null; checkedAt?: string | null; placeholder: string; needsConfirm?: boolean }) {
  const { status, isLoading, view, checkedAt, placeholder, needsConfirm } = opts;
  // The hub refused the read because this browser isn't confirmed: say so, and don't guess installed or not (no install card, no tabs, no status word).
  if (needsConfirm) return { headline: "Hermes isn't shown until this browser is confirmed.", showInstall: false, showTabs: false, showNeedsConfirm: true, statusWord: "", tone: "warn" as const, note: null };
  const installed = Boolean(status?.installed);
  const running = installed && !status?.needsSetup;
  const headline = isLoading
    ? "Checking on Hermes."
    : running
      ? `Running ${status?.defaultModel ?? "your model"}. Ask it anything, or see what it knows about you.`
      : installed
        ? "Hermes is installed but needs one more step to finish setup."
        : "One command sets it up.";
  return {
    headline,
    showNeedsConfirm: false,
    showInstall: !isLoading && !installed,
    showTabs: !isLoading && installed,
    statusWord: running ? "Running" : view ? view.label : placeholder,
    tone: running ? ("success" as const) : ("warn" as const),
    note: running || !view ? null : toolNextStep("hermes", view, checkedAt),
  };
}

type ClaudeVerdictLike = { tone: string; title: string; why: string };

/**
 * Claude Code widget words. The shared word covers sign-in, but a plan-limit warning overrides it (never a green "Ready" at the limit), and
 * sign-in counts as satisfied when any connected account is usable (default signed out, claude:max-2 connected still runs jobs).
 */
export function claudeDisplay(opts: { view: ProviderView | null; verdict: ClaudeVerdictLike; anyUsable: boolean; placeholder: string; checkedAt?: string | null }) {
  const { view, verdict, anyUsable, placeholder, checkedAt } = opts;
  if (verdict.tone === "warn" && /plan limit/i.test(verdict.title)) return { state: "At its plan limit", tone: "warn" as const, line: verdict.why };
  if (view?.state === "setup" && /sign/i.test(view.label) && anyUsable) return { state: "Ready · signed in", tone: "success" as const, line: verdict.why };
  const state = view ? view.label : placeholder;
  const line = view ? (view.state === "verified" ? verdict.why : toolNextStep("claude", view, checkedAt)) : toolNextStep("claude", null, checkedAt);
  return { state, tone: toolTone(view), line };
}
