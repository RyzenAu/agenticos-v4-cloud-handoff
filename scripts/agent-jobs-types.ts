export type AgentId = "codex" | "claude";
export type AgentQuestion = { id: string; question: string; options?: string[] };
export type AgentPending = {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  choices?: string[];
  questions?: AgentQuestion[];
};
export type AgentAdapterEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string; append?: boolean }
  | { type: "progress"; label: string }
  | ({ type: "input" } & AgentPending)
  | { type: "input_resolved"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };
export type AgentRunInput = {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  readOnly?: boolean;
  /** The live OS checkout. Edits, grants or commands reaching it outside `cwd` are refused
   * without asking the owner (agents never edit the live checkout; OS work belongs to Coding). */
  protectedRoot?: string;
  onEvent: (event: AgentAdapterEvent) => void;
};
export type AgentRunHandle = {
  respond: (id: string, decision: "approve" | "deny", answers?: Record<string, string>) => void;
  done: Promise<void>;
  cancel: () => void;
};
export type AgentRunStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  /** The OS stopped or restarted while this run was active. Nothing is replayed; it stays
   * interrupted until someone explicitly starts it again. */
  | "interrupted";
export type AgentRun = {
  agent: AgentId;
  role: "execute" | "review" | "check";
  status: AgentRunStatus;
  sessionId?: string;
  text: string;
  events: Array<{ id: string; at: string; label: string }>;
  pending?: AgentPending;
  error?: string;
};
export type AgentJob = {
  id: string;
  requestId: string;
  prompt: string;
  kind: "task" | "check";
  workflow?: "build" | "improve-os";
  /** Who asked, from the verified principal (Stage B1); shown in the activity history. */
  requestedBy?: { personId: string; displayName: string; via: string };
  createdAt: string;
  updatedAt: string;
  runs: AgentRun[];
};
export type AgentStatus = {
  id: AgentId;
  installed: boolean;
  signedIn: boolean;
  detail: string;
  tools: string[];
  checkedAt: string;
  lastCheck?: { status: AgentRunStatus; at: string; detail: string };
};
