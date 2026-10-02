import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDay } from "./format";

export const COLLECTIONS = [
  {
    id: "business",
    name: "Business",
    color: "#c8afe9",
    description: "Strategy, offers & decisions",
  },
  { id: "content", name: "Content", color: "#e6be84", description: "Ideas, research & your voice" },
  { id: "projects", name: "Projects", color: "#96c7bd", description: "The things you're building" },
  {
    id: "personal",
    name: "Personal",
    color: "#c49ab3",
    description: "Preferences & life outside work",
  },
] as const;
export type SourceKind = "note" | "article" | "video" | "document" | "meeting";
export interface MemorySpace {
  id: string;
  name: string;
  color: string;
  description: string;
  icon?: string;
}
export function memorySpaces(state: Pick<OperatorState, "memorySpaces">): MemorySpace[] {
  return [...COLLECTIONS, ...(state.memorySpaces || [])];
}
export interface MemorySource {
  id: string;
  title: string;
  kind: SourceKind;
  origin?: string;
  collection: string;
  text: string;
  textTruncated?: boolean;
  url?: string;
  filename?: string;
  createdAt: string;
  updatedAt: string;
  status: "indexing" | "ready" | "error";
  error?: string;
  deletedAt?: string;
  pinned: boolean;
  words: number;
  hash: string;
  connector?: {
    provider: string;
    itemId: string;
    path?: string;
    syncedAt: string;
    supersededAt?: string;
    /** When the imported source file itself last changed (set by memory app sync). */
    activityAt?: string;
  };
  extraction?: "local-ocr" | "design-vision" | "local-vision" | "cloud-vision";
  image?: {
    url: string;
    thumbnailUrl: string;
    mimeType: string;
    bytes: number;
    sha256: string;
    original: "upload" | "design-library" | "photo-index";
    designId?: string;
    indexedAt?: string;
  };
}
export interface InboxItem {
  bodyStatus?: "legacy-full" | "metadata" | "cached";
  bodyTruncated?: boolean;
  direction?: "inbound" | "outbound";
  remoteId?: string;
  threadId?: string;
  account?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  rfcMessageId?: string;
  references?: string;
  labelIds?: string[];
  /** A List-Unsubscribe or List-Id header was present: bulk or marketing mail (src/lib/inbox-bulk.ts). */
  listUnsubscribe?: boolean;
  gmailDraftId?: string;
  draftTo?: string;
  draftCc?: string;
  draftBcc?: string;
  url?: string;
  gmailSendState?: "sent" | "uncertain";
  gmailSendRequestId?: string;
  gmailSentAt?: string;
  gmailSentMessageId?: string;
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  category: "needs-you" | "sponsors" | "waiting" | "updates";
  status: "open" | "done";
  draft?: string;
  read?: boolean;
  readOverride?: boolean;
  starred?: boolean;
  triageReason?: string;
  source: "capture" | "gmail" | "outlook" | "slack" | "skool";
}

export type ExistingAppConnection = {
  harness?: "codex" | "claude";
  id: string;
  name: string;
  isAccessible: boolean | null;
  isEnabled: boolean | null;
  runtimeEnabled: boolean | null;
  callable: boolean | null;
  observed: boolean;
  directAuthorization: false;
};
export type ConnectionDiscovery = {
  version: 1;
  harness: "codex";
  harnesses?: Array<{ id: string; detail: string }>;
  scope: "global";
  /** "unchecked": nothing has asked Codex yet (a GET never does; T8c). */
  status: "available" | "unavailable" | "unsupported" | "timeout" | "error" | "unchecked";
  checkedAt: string | null;
  expiresAt: string | null;
  runtimeFresh: boolean;
  apps: ExistingAppConnection[];
  plugins?: Array<{ id: string; name: string; enabled: boolean }>;
  truncated: boolean;
  detail: string;
};
export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  account?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  color?: { backgroundColor: string; textColor: string };
}
export interface CalendarEvent {
  calendarId?: string;
  calendarName?: string;
  importedAt?: string;
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  attendees?: string;
  notes: string;
  source: "local" | "ics" | "google" | "outlook" | "cal";
  actions: Array<{ id: string; text: string; done: boolean }>;
  sourceUid?: string;
}
export interface OperatorSettings {
  mission: boolean;
  openclaw: boolean;
  news: boolean;
  inboxAccounts?: {
    gmail: boolean;
    outlook: boolean;
    capture: boolean;
    slack?: boolean;
    skool?: boolean;
  };
  inboxAutoRead?: boolean;
  inboxShowAccounts?: boolean;
  inboxShowCategories?: boolean;
}
export interface WorkspaceGoals {
  longTerm: string;
  quarter: string;
  week: string;
  metrics: Array<{
    id: string;
    label: string;
    kind: "leading" | "lagging";
    value: number;
    target: number;
    unit: string;
  }>;
}
export interface OperatorState {
  gmailLabels?: GmailLabel[];
  gmailLabelsUpdatedAt?: string;
  memorySpaces?: MemorySpace[];
  inboxImports?: Array<{
    provider: "gmail" | "outlook" | "slack" | "skool";
    account: string;
    importedAt: string;
    count: number;
    via: "codex" | "file";
  }>;
  brainSources?: Record<string, boolean>;
  brainRevision?: number;
  goals: WorkspaceGoals;
  hiddenMemoryTitles: string[];
  version: number;
  sources: MemorySource[];
  inbox: InboxItem[];
  events: CalendarEvent[];
  settings: OperatorSettings;
}
export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string;
  source: string;
  source_url: string;
  published_at: string;
  category?: string;
  image_url?: string;
}
export const EMPTY_STATE: OperatorState = {
  version: 1,
  goals: { longTerm: "", quarter: "", week: "", metrics: [] },
  hiddenMemoryTitles: [],
  sources: [],
  inbox: [],
  events: [],
  settings: { mission: false, openclaw: false, news: true },
};

/** A failed /__operator request, with its HTTP status so callers can tell a bad request (4xx: retrying
 *  won't help) from a transient failure. */
export class OperatorRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OperatorRequestError";
  }
}

/** react-query `retry`: retry transient failures up to 3 times, never a 4xx (e.g. "Lead not found."). */
export function retryUnlessClientError(failures: number, error: unknown): boolean {
  const status = error instanceof OperatorRequestError ? error.status : 0;
  return !(status >= 400 && status < 500) && failures < 3;
}

// The page token for writes, fetched once and reused (audit F3-24: every save used to wait on its
// own GET /__token first, which under load held /setup on "Saving…" for seconds before the save
// was even sent). A failed read isn't cached.
const STALE_TOKEN_ERROR = "Refresh this page and try again."; // scripts/operator-plugin.ts
let pageTokenRequest: Promise<string> | null = null;
function pageToken(): Promise<string> {
  pageTokenRequest ??= fetch("/__token")
    .then((r) => r.json())
    .then((j) => String(j?.token ?? ""))
    .catch((error) => {
      pageTokenRequest = null;
      throw error;
    });
  return pageTokenRequest;
}
/** Forget the cached page token (tests; after pairing changes who this browser is). */
export function resetOperatorToken() {
  pageTokenRequest = null;
}

export async function operatorRequest<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const send = async (token: string | undefined) =>
    fetch(
      `/__operator${path}`,
      body === undefined
        ? undefined
        : {
            method,
            headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token ?? "" },
            body: JSON.stringify(body),
          },
    );
  let response = await send(body !== undefined ? await pageToken() : undefined);
  let result = await response.json();
  // A cached token goes stale when the server restarts or this browser is paired: the server
  // refuses the write before running it, so fetch a fresh token and send it once more.
  if (body !== undefined && response.status === 403 && result?.error === STALE_TOKEN_ERROR) {
    pageTokenRequest = null;
    response = await send(await pageToken());
    result = await response.json();
  }
  if (!response.ok) throw new OperatorRequestError(result.error || `Request failed (${response.status})`, response.status);
  return result as T;
}
export function useOperator() {
  const qc = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const query = useQuery<OperatorState>({
    enabled: hydrated,
    queryKey: ["operator-state"],
    queryFn: () => operatorRequest("/state"),
    refetchInterval: (q) =>
      q.state.data?.sources.some((s) => s.status === "indexing") ? 1200 : 30000,
  });
  return {
    ...query,
    state: hydrated ? (query.data ?? EMPTY_STATE) : EMPTY_STATE,
    isLoading: !hydrated || query.isLoading,
    refresh: () => qc.invalidateQueries({ queryKey: ["operator-state"] }),
  };
}
export function askOperator(
  question = "",
  context = "",
  submit = false,
  modelKey?: string,
  contextSource?: string,
  persona?: "advisor" | "assistant",
) {
  window.dispatchEvent(
    new CustomEvent("operator:ask", {
      detail: { question, context, submit, modelKey, contextSource, persona },
    }),
  );
}
export function humanDate(iso: string) {
  return fmtDay(new Date(iso));
}
export function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
