// The browser side of an outward action that the hub puts behind a B2 approval (scripts/approvals/gated-action.ts): publishing or
// taking down a lead preview (/__lead-sites/deploy, /takedown) and posting Design content (/__design_publish).
//
// In the server role (a headless hub a founder uses remotely) the first POST answers 202 with an approval and NOTHING happens.
// The founder confirms on the approval card; then the same request is sent once more with { approvalId } and the hub runs it,
// exactly once. In the pc role the first POST just does it (200) and none of this machinery is used.
//
// Layers, each small and tested without a browser:
//   interpretReply     what a hub answer means (asked / done directly / a refusal worded honestly)
//   publishReduce      the state machine (pure)
//   claimRun           "this tab runs it" (a second tab, a refresh or a re-render never runs it again; the server's single use
//                      is the real guard, this just stops the attempt and keeps the screen honest)
//   PublishFlow        the controller: ask, follow the approval on the activity stream (/__events) with ONE read to start and a
//                      slow fallback only while the stream is down, run once on approval, report the server's answer as it is.
// Nothing in this file decides who may approve or what is allowed: the hub does.

export type ApprovalState = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "consumed";
export type ApprovalView = {
  id: string;
  state: ApprovalState;
  action: string;
  summary: string;
  expiresAt?: string;
  outcome?: "succeeded" | "failed" | "unknown";
  reason?: string;
  requester?: { personId?: string; via?: string; actor?: string };
};

export type EndedWhy = "rejected" | "cancelled" | "expired" | "voided" | "already-used" | "error";
export type FlowState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "waiting"; approval: ApprovalView }
  | { kind: "approved"; approval: ApprovalView }
  | { kind: "running"; approval: ApprovalView }
  | { kind: "done"; via: "direct" | "approved"; approvalId?: string; result: unknown }
  | { kind: "ended"; why: EndedWhy; message: string; approval?: ApprovalView };

export type FlowEvent =
  | { t: "ask" }
  | { t: "asked"; approval: ApprovalView }
  | { t: "direct"; result: unknown }
  | { t: "seen"; approval: ApprovalView }
  | { t: "run" }
  | { t: "ran"; result: unknown }
  | { t: "ended"; why: EndedWhy; message: string }
  | { t: "reset" };

export const IDLE: FlowState = { kind: "idle" };

const TERMINAL: Record<string, EndedWhy> = { rejected: "rejected", cancelled: "cancelled", expired: "expired" };

export function endedMessage(why: EndedWhy, approval?: ApprovalView): string {
  switch (why) {
    case "rejected": return "The approval was declined, so nothing was published.";
    case "cancelled": return approval?.reason === "digest-mismatch" ? VOIDED : "The request was withdrawn, so nothing was published.";
    case "expired": return "The approval expired before it was used, so nothing was published. Ask again when you are ready.";
    case "voided": return VOIDED;
    case "already-used": return "That approval was already used (from another window or tab). This page shows the current state.";
    default: return "That didn't work.";
  }
}
const VOIDED = "What would go out changed after it was approved, so the approval is void and nothing was published. Ask again.";

/** The pure state machine. Unknown or out-of-order events leave the state alone (a replayed event is harmless). */
export function publishReduce(state: FlowState, e: FlowEvent): FlowState {
  switch (e.t) {
    case "reset":
      return IDLE;
    case "ask":
      return state.kind === "asking" || state.kind === "waiting" || state.kind === "approved" || state.kind === "running" ? state : { kind: "asking" };
    case "direct":
      return state.kind === "asking" ? { kind: "done", via: "direct", result: e.result } : state;
    case "asked":
      if (state.kind !== "asking" && state.kind !== "idle") return state;
      return fromApproval(e.approval);
    case "seen": {
      if (state.kind !== "waiting" && state.kind !== "approved" && state.kind !== "running") return state;
      if (state.approval.id !== e.approval.id) return state;
      const a = e.approval;
      if (state.kind === "running") return { kind: "running", approval: a }; // the run's own answer ends it, not the event
      const why = TERMINAL[a.state];
      if (why) return { kind: "ended", why, message: endedMessage(why, a), approval: a };
      if (a.state === "consumed") return { kind: "ended", why: "already-used", message: endedMessage("already-used"), approval: a };
      if (a.state === "approved") return state.kind === "waiting" ? { kind: "approved", approval: a } : state;
      return state.kind === "waiting" ? { kind: "waiting", approval: a } : state;
    }
    case "run":
      return state.kind === "approved" ? { kind: "running", approval: state.approval } : state;
    case "ran":
      return state.kind === "running" ? { kind: "done", via: "approved", approvalId: state.approval.id, result: e.result } : state;
    case "ended":
      return state.kind === "done" ? state : { kind: "ended", why: e.why, message: e.message, approval: "approval" in state ? state.approval : undefined };
  }
}

function fromApproval(a: ApprovalView): FlowState {
  const why = TERMINAL[a.state];
  if (why) return { kind: "ended", why, message: endedMessage(why, a), approval: a };
  if (a.state === "consumed") return { kind: "ended", why: "already-used", message: endedMessage("already-used"), approval: a };
  return a.state === "approved" ? { kind: "approved", approval: a } : { kind: "waiting", approval: a };
}

// ── what a hub answer means ───────────────────────────────────────────────────────────────────────────────────

export type Reply = { status: number; json: any };
export type Interpreted =
  | { kind: "asked"; approval: ApprovalView }
  | { kind: "done"; result: any }
  | { kind: "ended"; why: EndedWhy; message: string };

/** The hub's answer to the ASK (first) POST. 202 = approval; 2xx otherwise = it simply ran (pc role). */
export function interpretAsk(r: Reply): Interpreted {
  if (r.status === 202 && r.json?.needsApproval && r.json?.approval?.id) return { kind: "asked", approval: r.json.approval as ApprovalView };
  if (r.status >= 200 && r.status < 300) return { kind: "done", result: r.json };
  return { kind: "ended", why: "error", message: String(r.json?.error ?? `Request failed (${r.status})`) };
}

/** The hub's answer to the RUN (second) POST, worded as the server meant it: never softened into "done". */
export function interpretRun(r: Reply): Interpreted {
  if (r.status >= 200 && r.status < 300) return { kind: "done", result: r.json };
  const code = String(r.json?.code ?? "");
  const text = String(r.json?.error ?? "");
  if (code === "digest-mismatch") return { kind: "ended", why: "voided", message: VOIDED };
  if (code === "consumed" || /already used/i.test(text) || r.json?.approval?.state === "consumed") return { kind: "ended", why: "already-used", message: endedMessage("already-used") };
  if (code === "expired" || /expired/i.test(text)) return { kind: "ended", why: "expired", message: endedMessage("expired") };
  const state = r.json?.approval?.state;
  if (state === "rejected" || state === "cancelled") return { kind: "ended", why: state, message: endedMessage(state, r.json.approval) };
  if (r.json?.outcome === "failed") return { kind: "ended", why: "error", message: `${text || "That didn't work."} The approval is spent, so ask again to retry.` };
  return { kind: "ended", why: "error", message: text || `Request failed (${r.status})` };
}

// ── "this tab runs it" ─────────────────────────────────────────────────────────────────────────────────────────

export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const memoryClaims = new Set<string>();
/**
 * True exactly once per approval id in this browser: first by an in-memory set (re-render, two flows in one page), then by a
 * localStorage mark (a second tab, a refresh). A tab that loses the claim does not run; it watches the approval instead.
 */
export function claimRun(approvalId: string, storage: KV | null, claims: Set<string> = memoryClaims): boolean {
  if (claims.has(approvalId)) return false;
  claims.add(approvalId);
  if (!storage) return true;
  const key = `mu-publish-claim:${approvalId}`;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, String(Date.now()));
  } catch {
    /* storage blocked: the server's single use still holds */
  }
  return true;
}

// ── the controller ────────────────────────────────────────────────────────────────────────────────────────────

export type ApprovalFeed = {
  /** Notified with an approval's latest view (stream events and snapshots). Returns the unsubscribe. */
  subscribe(listener: (approvals: ApprovalView[]) => void): () => void;
  /** False while the stream is down: then, and only then, the controller reads on a slow timer. */
  healthy(): boolean;
};
export type FlowDeps = {
  /** POST the request; with an approvalId it is the RUN. Never throws for an HTTP error: returns the status and body. */
  send(approvalId?: string): Promise<Reply>;
  /** One read of an approval (GET /__approvals/<id>); null when it can't be read. */
  fetchApproval(id: string): Promise<ApprovalView | null>;
  feed?: ApprovalFeed;
  storage?: KV | null;
  claims?: Set<string>;
  /** Where a still-open approval is remembered across a refresh (null = don't). */
  resumeKey?: string | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** After a run (or anything that changed the hub's state), so the screen can refetch what it shows. */
  onSettled?: (state: FlowState) => void;
};
/** Fallback read interval while the stream is down. */
export const FALLBACK_READ_MS = 5_000;

export class PublishFlow {
  private state: FlowState = IDLE;
  private listeners = new Set<() => void>();
  private off: (() => void) | undefined;
  private timer: unknown;
  private disposed = false;
  private readonly setTimer: NonNullable<FlowDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<FlowDeps["clearTimer"]>;

  constructor(private readonly deps: FlowDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as number));
  }

  getState = (): FlowState => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  /**
   * The screen showing this flow is mounted (again): React's StrictMode, or a drawer closing and reopening, runs the effect's
   * cleanup and then its setup on the SAME flow, so dispose() must be undoable. A flow that was waiting starts following again.
   */
  attach() {
    this.disposed = false;
    if (this.state.kind === "waiting" || this.state.kind === "approved") this.afterChange();
  }
  /** The screen went away: stop following. An open approval stays remembered (resumeKey) and a run already sent still finishes. */
  dispose() {
    this.disposed = true;
    this.stopWatching();
  }

  private dispatch(e: FlowEvent) {
    const next = publishReduce(this.state, e);
    if (next === this.state) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  /** Step 1. Safe to call twice: a flow already asking, waiting or running ignores it. */
  async start(): Promise<void> {
    if (this.state.kind === "asking" || this.state.kind === "waiting" || this.state.kind === "approved" || this.state.kind === "running") return;
    if (this.state.kind !== "idle") this.dispatch({ t: "reset" });
    this.dispatch({ t: "ask" });
    let reply: Reply;
    try {
      reply = await this.deps.send();
    } catch (e) {
      return this.dispatch({ t: "ended", why: "error", message: e instanceof Error ? e.message : "Couldn't reach the hub." });
    }
    const r = interpretAsk(reply);
    if (r.kind === "done") {
      this.dispatch({ t: "direct", result: r.result });
      return this.settle();
    }
    if (r.kind === "ended") return this.dispatch({ t: "ended", why: r.why, message: r.message });
    this.remember(r.approval.id);
    this.dispatch({ t: "asked", approval: r.approval });
    this.afterChange();
  }

  /** After a refresh: pick up an approval that was left open for this key (one read, then the same watching). */
  async resume(): Promise<void> {
    const key = this.deps.resumeKey;
    if (!key || this.state.kind !== "idle") return;
    let id: string | null = null;
    try {
      id = this.deps.storage?.getItem(key) ?? null;
    } catch {
      id = null;
    }
    if (!id) return;
    const a = await this.deps.fetchApproval(id).catch(() => null);
    if (this.disposed || this.state.kind !== "idle") return;
    // Gone, finished or spent: nothing to resume (a spent one's result is on the page itself).
    if (!a || (a.state !== "pending" && a.state !== "approved")) return this.forget();
    this.dispatch({ t: "asked", approval: a });
    this.afterChange();
  }

  /** Leave a finished or refused flow. */
  dismiss() {
    this.stopWatching();
    this.forget();
    this.dispatch({ t: "reset" });
  }

  /** The viewer's own click on the card ("Approve" / "Decline") already went to the hub; read the answer now. */
  async refresh(): Promise<void> {
    const s = this.state;
    if (s.kind !== "waiting" && s.kind !== "approved") return;
    const a = await this.deps.fetchApproval(s.approval.id).catch(() => null);
    if (a) this.see(a);
  }

  private see(a: ApprovalView) {
    this.dispatch({ t: "seen", approval: a });
    this.afterChange();
  }

  private afterChange() {
    const s = this.state;
    if (s.kind === "waiting") return this.watch(s.approval.id);
    if (s.kind === "approved") return void this.runOnce(s.approval);
    this.stopWatching();
    if (s.kind === "ended" || s.kind === "done") {
      this.forget();
      this.settle();
    }
  }

  /** Step 3. Exactly once per approval in this browser; the server's single use is the guard behind it. */
  private async runOnce(approval: ApprovalView) {
    if (!claimRun(approval.id, this.deps.storage ?? null, this.deps.claims)) {
      // Another window (or an earlier render) already took it. Keep watching: its result arrives as the approval changing.
      this.watch(approval.id);
      return;
    }
    this.stopWatching();
    this.dispatch({ t: "run" });
    let reply: Reply;
    try {
      reply = await this.deps.send(approval.id);
    } catch (e) {
      this.dispatch({ t: "ended", why: "error", message: `${e instanceof Error ? e.message : "Couldn't reach the hub."} The approval may or may not have been used; check before asking again.` });
      return this.afterChange();
    }
    const r = interpretRun(reply);
    if (r.kind === "done") this.dispatch({ t: "ran", result: r.result });
    else if (r.kind === "ended") this.dispatch({ t: "ended", why: r.why, message: r.message });
    this.afterChange();
  }

  private watch(id: string) {
    if (this.off || this.disposed) return;
    const feed = this.deps.feed;
    const mine = (list: ApprovalView[]) => list.find((a) => a.id === id);
    if (feed) {
      this.off = feed.subscribe((list) => {
        const a = mine(list);
        if (a) this.see(a);
      });
    } else this.off = () => {};
    // One read to start (an event may have been missed before we subscribed), then events. The timer only exists while the
    // stream is down.
    void this.deps.fetchApproval(id).then((a) => a && !this.disposed && this.see(a)).catch(() => {});
    const tick = () => {
      this.timer = undefined;
      if (this.disposed || (this.state.kind !== "waiting" && this.state.kind !== "approved")) return;
      if (!feed || !feed.healthy()) void this.deps.fetchApproval(id).then((a) => a && this.see(a)).catch(() => {});
      this.timer = this.setTimer(tick, FALLBACK_READ_MS);
    };
    this.timer = this.setTimer(tick, FALLBACK_READ_MS);
  }

  private stopWatching() {
    this.off?.();
    this.off = undefined;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private remember(id: string) {
    try {
      if (this.deps.resumeKey) this.deps.storage?.setItem(this.deps.resumeKey, id);
    } catch {
      /* not remembered */
    }
  }
  private forget() {
    try {
      if (this.deps.resumeKey) this.deps.storage?.removeItem(this.deps.resumeKey);
    } catch {
      /* nothing to forget */
    }
  }
  private settle() {
    try {
      this.deps.onSettled?.(this.state);
    } catch {
      /* a refetch failing never changes the flow */
    }
  }
}

// ── the hub's own routes, thin ────────────────────────────────────────────────────────────────────────────────

export type Fetcher = typeof fetch;

async function pageToken(f: Fetcher): Promise<string> {
  const r = await f("/__token");
  return String((await r.json())?.token ?? "");
}

/** A POST with the caller's own page token; never throws for an HTTP status. */
export async function postJson(path: string, body: unknown, f: Fetcher = fetch): Promise<Reply> {
  const res = await f(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await pageToken(f) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export async function fetchApproval(id: string, f: Fetcher = fetch): Promise<ApprovalView | null> {
  const res = await f(`/__approvals/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return ((await res.json().catch(() => null)) as { approval?: ApprovalView } | null)?.approval ?? null;
}

/** The viewer confirms on the card: ask for the card's nonce, then decide with it (B2 checks the session and the nonce). */
export async function decideOnCard(id: string, decision: "approve" | "reject", f: Fetcher = fetch): Promise<{ ok: boolean; message: string; approval?: ApprovalView }> {
  const token = await pageToken(f);
  const headers = { "Content-Type": "application/json", "X-Claude-OS-Token": token };
  let evidence: unknown;
  if (decision === "approve") {
    const card = await f(`/__approvals/${encodeURIComponent(id)}/card`, { method: "POST", headers, body: "{}" });
    const cj = await card.json().catch(() => ({}));
    if (!card.ok || !cj?.cardNonce) return { ok: false, message: String(cj?.error ?? "This browser can't confirm it. Confirm from your own signed-in session.") };
    evidence = { uiConfirm: true, cardNonce: cj.cardNonce };
  }
  const res = await f(`/__approvals/${encodeURIComponent(id)}/decide`, { method: "POST", headers, body: JSON.stringify(decision === "approve" ? { decision, evidence } : { decision }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: String(j?.reason ?? j?.error ?? `The hub said ${res.status}.`), approval: j?.approval };
  return { ok: true, message: "", approval: j?.approval };
}

/** Approvals out of an activity message (an "approval" event, or a snapshot's list). Pure. */
export function approvalsFromActivity(m: { kind: "event"; event: { topic: string; data?: any } } | { kind: "snapshot"; snapshot: { approvals?: any[] } }): ApprovalView[] {
  if (m.kind === "snapshot") return (m.snapshot.approvals ?? []) as ApprovalView[];
  if (m.event.topic !== "approval") return [];
  const a = m.event.data?.approval;
  return a?.id ? [a as ApprovalView] : [];
}
