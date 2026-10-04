import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import "./inbox-refinements.css";
import "./inbox-white.css";
import {
  ArrowLeft,
  ArrowUpRight,
  BookmarkPlus,
  Check,
  Inbox,
  Mail,
  Plus,
  Search,
  FileText,
  Archive,
  RefreshCw,
  MessageSquare,
  SlidersHorizontal,
  MailOpen,
  Send,
  ChevronDown,
  ChevronRight,
  Tag,
  Star,
  Reply,
  Layers,
  X,
  Users,
  Hash,
} from "lucide-react";
import { useOperator, operatorRequest, askOperator, type InboxItem } from "@/lib/operator";
import { brainEnabled } from "@/lib/brain-sources";
import { INBOX_OPEN_KEY, inboxOpenRequest } from "@/lib/voice-email-review";
import { Busy, Modal } from "./ui";
import { Notice, PageFoot, PageHeader, PageSkeleton, Widget, WidgetGrid, WidgetList } from "@/components/ds";
import { cn } from "@/lib/utils";
import { AccountConnections, ProviderLogo, useAccounts, useNativeConnections } from "./account-connections";
import { InboxDailyBrief } from "./inbox-daily-brief";
import { MailArchivePanel } from "./mail-archive-panel";
import { fmtDateTime, fmtDay, fmtTime } from "@/lib/format";
import { isBulkMail } from "@/lib/inbox-bulk";

type Message = InboxItem & {
  draftTo?: string;
  cc?: string[];
  bcc?: string[];
  draftCc?: string;
  draftBcc?: string;
  labelIds?: string[];
  remoteId?: string;
  threadId?: string;
  to?: string[];
  replyTo?: string;
  url?: string;
  starred?: boolean;
  remoteDraftId?: string;
};
type InboxAskResult = {
  id: string;
  source: InboxItem["source"];
  title: string;
  from: string;
  excerpt: string;
  threadId?: string;
  url?: string;
  receivedAt: string;
  direction?: "inbound" | "outbound";
  reason: string;
};
type InboxAskResponse = {
  question: string;
  answer: string;
  mode: "answer" | "search";
  results: InboxAskResult[];
  totalSearched: number;
  matchedCount: number;
  coverage: string;
  notice?: string;
  canSummarize?: boolean;
};
type InboxAskState = {
  question: string;
  busy: boolean;
  thinking: boolean;
  error: string;
  response?: InboxAskResponse;
};
type GmailLabel = {
  account?: string;
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  color?: { backgroundColor?: string; textColor?: string };
};
type MailCapabilities = { modify?: boolean; send?: boolean; drafts?: boolean };
const providers = [
  { id: "all", label: "Overview" },
  { id: "gmail", label: "Gmail" },
  { id: "slack", label: "Slack" },
  { id: "outlook", label: "Outlook" },
  { id: "skool", label: "Skool" },
];
const categories = [
  { id: "needs-you", label: "Primary" },
  { id: "sponsors", label: "Opportunities" },
  { id: "waiting", label: "Waiting" },
  { id: "updates", label: "Updates" },
];
function SourceLogo({ source }: { source: string }) {
  return source === "all" ? (
    <Layers size={17} />
  ) : source === "skool" ? (
    <img className="ar-provider-logo" src="/business-sources/skool.png" alt="Skool" />
  ) : source === "capture" ? (
    <Mail size={16} />
  ) : (
    <ProviderLogo provider={source} />
  );
}
function isStarred(item: Message) {
  return item.starred ?? item.labelIds?.includes("STARRED") ?? false;
}
function sourceName(source: string) {
  return providers.find((p) => p.id === source)?.label || "Captured message";
}
function senderName(value: string) {
  return (
    value
      .replace(/\s*<[^>]+>\s*$/, "")
      .replace(/^\"|\"$/g, "")
      .trim() ||
    value ||
    "You"
  );
}
function messageDate(value: string) {
  const date = new Date(value),
    now = new Date();
  if (!Number.isFinite(date.getTime())) return "";
  return date.toDateString() === now.toDateString()
    ? fmtTime(date)
    : fmtDay(date);
}
function originalUrl(item: Message) {
  if (item.url && /^https:\/\//.test(item.url)) return item.url;
  if (item.source === "gmail")
    return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(item.threadId || item.remoteId || item.id.replace(/^google[:_-]|^gmail[:_-]/, ""))}`;
  return item.source === "slack"
    ? "https://app.slack.com/"
    : String(item.source) === "skool"
      ? "https://www.skool.com/chat"
      : "https://outlook.live.com/mail/";
}

const INBOX_DEMO_KEY = "agentic-os:inbox-demo";

// Hiding real subject lines is a screenshot aid for recording demos, not
// something the owner needs day to day — keep it out of the way unless a
// developer opts in with ?dev=1.
function isDevMode() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("dev");
}

export function InboxWorkspace() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(search).get("demo") === "1";
    let enabled = requested;
    try {
      enabled ||= localStorage.getItem(INBOX_DEMO_KEY) === "true";
      if (requested) localStorage.setItem(INBOX_DEMO_KEY, "true");
    } catch {
      // If the preference cannot be read, keep private mail off screen.
      enabled = true;
    }
    setDemo(enabled);
  }, [search]);
  // Do not mount the real inbox, archive, search or account UI before privacy resolves.
  if (demo === null) return <div className="op-page"><PageSkeleton rows={3} label="Loading inbox" /></div>;
  return demo ? <GmailDemoWorkspace onExit={() => {
    try { localStorage.removeItem(INBOX_DEMO_KEY); } catch { /* Keep the private view if storage fails. */ }
    window.location.assign("/inbox");
  }} /> : <LiveInboxWorkspace />;
}

function GmailDemoWorkspace({ onExit }: { onExit: () => void }) {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const update = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return <div className="op-page ar-mail-page ar-white-inbox" data-inbox-theme={theme} data-inbox-demo="true">
    <PageHeader
      title="Inbox"
      description="Gmail, Outlook, Slack and Skool in one place — what needs your reply comes first."
    />
    <div className="wi-mode-bar">
      <span className="wi-demo-badge">DEMO</span>
      <p>Your real emails are hidden. Fictional messages for your walkthrough.</p>
      <div><button onClick={onExit}>Show my real inbox</button></div>
    </div>
    <ProviderPreview provider="gmail" />
  </div>;
}

function LiveInboxWorkspace() {
  const { state, refresh, error } = useOperator(),
    accounts = useAccounts();
  const nativeAccounts = useNativeConnections();
  const nativeReady = (nativeAccounts.data?.providers || []).filter(a => a.enabled && a.available);
  const [openedBodies, setOpenedBodies] = useState<Record<string, InboxItem>>({});
  // One theme for the whole OS: the Inbox follows More > Dark mode. It used to carry its own switch (audit P2-7).
  const [globalDark, setGlobalDark] = useState(false);
  const [requestedSkoolChannel, setRequestedSkoolChannel] = useState("");
  const [overviewAsk, setOverviewAsk] = useState<InboxAskState>({
    question: "",
    busy: false,
    thinking: false,
    error: "",
  });
  const overviewAskLock = useRef(false);
  const overviewAskRequest = useRef<{ sequence: number; controller?: AbortController }>({
    sequence: 0,
  });
  useEffect(() => () => overviewAskRequest.current.controller?.abort(), []);
  function stopOverviewAnswer() {
    overviewAskRequest.current.sequence += 1;
    overviewAskRequest.current.controller?.abort();
    overviewAskLock.current = false;
  }
  const inboxQuestionScope = JSON.stringify([brainEnabled(state, "email"), state.settings.inboxAccounts || {}]);
  const previousQuestionScope = useRef(inboxQuestionScope);
  useEffect(() => {
    if (previousQuestionScope.current === inboxQuestionScope) return;
    previousQuestionScope.current = inboxQuestionScope;
    stopOverviewAnswer();
    setOverviewAsk((old) => ({ ...old, response: undefined, busy: false, thinking: false, error: "" }));
  }, [inboxQuestionScope]);
  async function askOverview() {
    const question = overviewAsk.question.trim();
    if (!question || question.length > 600 || overviewAskLock.current) return;
    let model: { backend: "deepseek" | "local"; provider: string; name: string } | undefined;
    try {
      const selectedModel = JSON.parse(localStorage.getItem("os-oracle-brain-model") || "null");
      if (["deepseek", "local"].includes(selectedModel?.backend) &&
          typeof selectedModel.provider === "string" && typeof selectedModel.name === "string")
        model = { backend: selectedModel.backend, provider: selectedModel.provider, name: selectedModel.name };
    } catch {}
    stopOverviewAnswer();
    const sequence = overviewAskRequest.current.sequence;
    const controller = new AbortController();
    overviewAskRequest.current.controller = controller;
    overviewAskLock.current = true;
    setOverviewAsk((old) => ({
      ...old,
      question,
      busy: true,
      thinking: false,
      error: "",
      response: undefined,
    }));
    let found: InboxAskResponse | undefined;
    async function request(summarize: boolean) {
      const tokenResponse = await fetch("/__token", { signal: controller.signal });
      const { token } = await tokenResponse.json();
      const response = await fetch("/__operator/inbox/ask", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
        body: JSON.stringify({ question, summarize, model }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The inbox search could not be completed.");
      if (
        !Array.isArray(result.results) ||
        typeof result.answer !== "string" ||
        !["answer", "search"].includes(result.mode)
      )
        throw new Error("The search result could not be read. Please try your question again.");
      return result as InboxAskResponse;
    }
    try {
      found = await request(false);
      if (sequence !== overviewAskRequest.current.sequence) return;
      overviewAskLock.current = false;
      setOverviewAsk((old) => ({
        ...old,
        response: found,
        busy: false,
        thinking: found?.canSummarize === true,
        error: "",
      }));
      if (found.canSummarize) {
        const response = await request(true);
        if (sequence !== overviewAskRequest.current.sequence) return;
        setOverviewAsk((old) => ({ ...old, response, thinking: false }));
      }
    } catch (e) {
      if (sequence !== overviewAskRequest.current.sequence || controller.signal.aborted) return;
      setOverviewAsk((old) => ({
        ...old,
        error: found
          ? "Your matches are ready, but the answer could not be generated. You can open the conversations below or try again."
          : (e as Error).message,
      }));
    } finally {
      if (sequence === overviewAskRequest.current.sequence) {
        overviewAskLock.current = false;
        setOverviewAsk((old) => ({ ...old, busy: false, thinking: false }));
      }
    }
  }
  useEffect(() => {
    const update = () => setGlobalDark(document.documentElement.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const effectiveTheme = globalDark ? "dark" : "light";
  const [provider, setProvider] = useState("all"),
    [folder, setFolder] = useState("inbox"),
    [category, setCategory] = useState("all"),
    [label, setLabel] = useState(""),
    [labelAccount, setLabelAccount] = useState("");
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [replyTo, setReplyTo] = useState(""),
    [replyCc, setReplyCc] = useState(""),
    [replyBcc, setReplyBcc] = useState(""),
    [showCc, setShowCc] = useState(false),
    [showBcc, setShowBcc] = useState(false),
    [replyOpen, setReplyOpen] = useState(false);
  const [sourceModes, setSourceModes] = useState<Record<string, "preview" | "live">>({});
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [add, setAdd] = useState(false),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [failure, setFailure] = useState(""),
    [savingView, setSavingView] = useState(false);
  const sendAttempts = useRef<
    Record<string, { requestId: string; to: string; cc: string; bcc: string; body: string }>
  >({});
  const [pendingView, setPendingView] = useState<Partial<typeof state.settings>>({});
  const skoolStatus = useQuery<SkoolStatus>({
    queryKey: ["operator-skool"],
    queryFn: () => operatorRequest("/connections/skool"),
    enabled: provider === "skool" || provider === "all",
    refetchInterval: 30000,
  });
  // No sample Slack, Outlook or Skool conversations (the fictional "Northstar Studio" and "Builders Circle") in a real inbox: an unconnected source shows its connect state.
  const previewAvailable = false;
  const sourceConnected =
    provider === "skool"
      ? skoolStatus.data?.connected === true
      : nativeReady.some(a => a.id === provider) || !!accounts.data?.accounts.find((a) => a.id === provider && a.connected);
  const hasSourceMessages = state.inbox.some((message) => message.source === provider);
  const isPreview =
    previewAvailable &&
    (sourceModes[provider] || (sourceConnected || hasSourceMessages ? "live" : "preview")) ===
      "preview";
  const viewSettings = { ...state.settings, ...pendingView };
  const visibleAccounts: Record<string, boolean> = {
    gmail: true,
    outlook: true,
    capture: true,
    slack: true,
    skool: true,
    ...viewSettings.inboxAccounts,
  };
  const autoRead = viewSettings.inboxAutoRead !== false,
    showAccounts = viewSettings.inboxShowAccounts === true,
    showCategories = viewSettings.inboxShowCategories !== false;
  const emailEnabled = brainEnabled(state, "email");
  const allMessages = state.inbox as Message[];
  const enabledMessages = allMessages.filter((i) => visibleAccounts[i.source] !== false);
  const visibleInbox = enabledMessages.filter((i) => provider === "all" || i.source === provider);
  const selectedItem = enabledMessages.find((i) => i.id === selected);
  const openedBody = selectedItem && openedBodies[selectedItem.id];
  const item = selectedItem && openedBody ? {
    ...selectedItem,
    body: openedBody.body,
    bodyStatus: openedBody.bodyStatus,
    bodyTruncated: openedBody.bodyTruncated,
    to: openedBody.to || selectedItem.to,
    cc: openedBody.cc || selectedItem.cc,
    bcc: openedBody.bcc || selectedItem.bcc,
    replyTo: openedBody.replyTo || selectedItem.replyTo,
  } : selectedItem;
  useEffect(() => {
    if (!selectedItem || selectedItem.bodyStatus !== "metadata" || openedBodies[selectedItem.id]) return;
    let cancelled = false;
    operatorRequest<{ item: InboxItem }>(`/mail-archive/message?id=${encodeURIComponent(selectedItem.id)}`)
      .then(({ item }) => { if (!cancelled) setOpenedBodies(old => ({ ...Object.fromEntries(Object.entries(old).slice(-19)), [item.id]: item })); })
      .catch(error => { if (!cancelled) setFailure((error as Error).message); });
    return () => { cancelled = true; };
  }, [selectedItem?.id, selectedItem?.bodyStatus]);
  const hiddenCount = allMessages.length - enabledMessages.length;
  const gmailLabels = (state as unknown as { gmailLabels?: GmailLabel[] }).gmailLabels || [];
  const userLabels = gmailLabels.filter((l) => l.type === "user" || !/^[A-Z_]+$/.test(l.id));
  const connected =
    accounts.data?.accounts.filter(
      (a) => a.connected && ["google", "outlook", "slack"].includes(a.id),
    ) || [];
  function capability(message: Message): MailCapabilities {
    const account = accounts.data?.accounts.find(
      (a) => a.id === (message.source === "gmail" ? "google" : message.source),
    );
    return message.source === "gmail" &&
      account?.connected &&
      !!message.account &&
      account.email?.toLowerCase() === message.account.toLowerCase()
      ? account.capabilities || {}
      : {};
  }
  function matchesFolder(i: Message, key: string) {
    if (key === "all") return true;
    if (key === "starred") return isStarred(i);
    if (key === "drafts") return !!i.draft || i.labelIds?.includes("DRAFT");
    if (key === "sent") return i.labelIds?.includes("SENT");
    if (key === "archive")
      return (
        (i.status === "done" ||
          (i.source === "gmail" && i.labelIds && !i.labelIds.includes("INBOX"))) &&
        !i.labelIds?.some((l) => ["TRASH", "SPAM", "SENT", "DRAFT"].includes(l))
      );
    return (
      i.status === "open" &&
      !i.labelIds?.some((l) => ["TRASH", "SPAM", "DRAFT", "SENT"].includes(l)) &&
      (i.source !== "gmail" || !i.labelIds || i.labelIds.includes("INBOX"))
    );
  }
  const items = visibleInbox
    .filter(
      (i) =>
        (label
          ? i.labelIds?.includes(label) && (!labelAccount || i.account === labelAccount)
          : matchesFolder(i, folder)) &&
        (category === "all" || i.category === category) &&
        `${i.from} ${i.subject} ${i.body}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const canSend = item ? capability(item).send === true : false;
  const canDraft = item ? capability(item).drafts === true : false;
  const uncertainSend = item?.gmailSendState === "uncertain";
  const briefInbox = visibleInbox.filter((i) => matchesFolder(i, "inbox"));
  const folderLabelId =
    label ||
    (
      { inbox: "INBOX", starred: "STARRED", sent: "SENT", drafts: "DRAFT" } as Record<
        string,
        string
      >
    )[folder];
  const mailboxCount =
    provider === "gmail" ||
    (provider === "all" && (!!label || visibleInbox.every((i) => i.source === "gmail")))
      ? gmailLabels
          .filter((l) => l.id === folderLabelId && (!labelAccount || l.account === labelAccount))
          .reduce<
            number | undefined
          >((total, l) => (l.messagesTotal == null ? total : (total || 0) + l.messagesTotal), undefined)
      : undefined;
  const canModify = item ? capability(item).modify === true : false;
  const activeSource = accounts.data?.accounts.find((a) =>
    provider === "all"
      ? a.id === "google" && a.connected
      : a.id === (provider === "gmail" ? "google" : provider),
  );
  const snapshot = state.inboxImports
    ?.filter((s) => provider === "all" || s.provider === provider)
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
  const activeNative = nativeReady.find(a => provider === "all" || a.id === provider);
  const sourceState = activeSource?.connected
    ? activeSource.lastSync
      ? `Updated ${fmtTime(new Date(activeSource.lastSync))}`
      : "Connected · refresh to load"
    : activeNative?.error
      ? "Refresh needs attention"
    : activeNative?.lastSync
      ? `Refreshed through Codex · ${fmtTime(new Date(activeNative.lastSync))}`
    : snapshot
      ? "Saved snapshot"
      : provider === "all"
        ? `${enabledMessages.length} saved conversations`
        : "Not connected";
  async function mutate(data: unknown, message: string) {
    setBusy(true);
    setFailure("");
    try {
      await operatorRequest("/inbox", data);
      await refresh();
      if (message) setNotice(message);
      return true;
    } catch (e) {
      setFailure((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function messageAction(
    message: Message,
    action: "read" | "unread" | "archive" | "restore" | "star" | "unstar",
  ) {
    const remote = capability(message).modify === true;
    const data =
      action === "read" || action === "unread"
        ? { read: action === "read" }
        : action === "archive" || action === "restore"
          ? { status: action === "archive" ? "done" : "open" }
          : { starred: action === "star" };
    if (remote) {
      setBusy(true);
      setFailure("");
      try {
        await operatorRequest("/connections/gmail/action", { id: message.id, action });
        await refresh();
        setNotice("Updated in Gmail.");
        return true;
      } catch (e) {
        setFailure((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    }
    return mutate(
      { id: message.id, ...data },
      `${action === "read" ? "Marked read" : action === "unread" ? "Marked unread" : action === "archive" ? "Archived" : action === "restore" ? "Moved to inbox" : action === "star" ? "Starred" : "Star removed"}${remote ? ` in ${sourceName(message.source)}` : " in this workspace"}.`,
    );
  }
  function openMessage(message: Message, markRead = true) {
    setSelected(message.id);
    setDraft(message.draft || (message.labelIds?.includes("DRAFT") ? message.body : ""));
    setReplyTo(
      message.draftTo ||
        (message.labelIds?.includes("DRAFT")
          ? message.to?.join(", ") || ""
          : message.replyTo || message.from.match(/<([^>]+)>/)?.[1] || message.from),
    );
    const cc =
      message.draftCc ?? (message.labelIds?.includes("DRAFT") ? message.cc?.join(", ") || "" : "");
    const bcc =
      message.draftBcc ??
      (message.labelIds?.includes("DRAFT") ? message.bcc?.join(", ") || "" : "");
    setReplyCc(cc);
    setReplyBcc(bcc);
    setShowCc(!!cc);
    setShowBcc(!!bcc);
    setReplyOpen(!!message.draft || !!message.labelIds?.includes("DRAFT"));
    setFailure("");
    if (markRead && autoRead && message.read !== true) void messageAction(message, "read");
  }
  useEffect(() => {
    const openRequestedMessage = (value: unknown) => {
      const request = inboxOpenRequest(value);
      if (!request) return;
      const message = state.inbox.find((entry) => entry.id === request.id);
      if (!message || !["gmail", "outlook"].includes(message.source)) return;
      setProvider(message.source);
      setFolder(message.draft ? "drafts" : "all");
      setCategory("all");
      setQuery("");
      setLabel("");
      setLabelAccount("");
      openMessage(message, false);
      if (request.reply) setReplyOpen(true);
      try { sessionStorage.removeItem(INBOX_OPEN_KEY); } catch { /* Optional handoff storage. */ }
    };
    const onOpen = (event: Event) => openRequestedMessage((event as CustomEvent).detail);
    window.addEventListener("operator:inbox-open", onOpen);
    try {
      const pending = sessionStorage.getItem(INBOX_OPEN_KEY);
      if (pending) {
        const request = inboxOpenRequest(JSON.parse(pending));
        if (request) openRequestedMessage(request);
        else sessionStorage.removeItem(INBOX_OPEN_KEY);
      }
    } catch { /* Browser storage can be disabled. The live event still works. */ }
    return () => window.removeEventListener("operator:inbox-open", onOpen);
  }, [state.inbox]);
  async function changeView(patch: Partial<typeof state.settings>) {
    setSavingView(true);
    setPendingView(patch);
    setFailure("");
    try {
      await operatorRequest("/settings", patch);
      await refresh();
      if (patch.inboxAccounts) setSelected(null);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setPendingView({});
      setSavingView(false);
    }
  }
  function askEmail(prompt: string) {
    if (!emailEnabled || !item || !prompt.trim()) return;
    askOperator(
      prompt.trim(),
      JSON.stringify({
        id: item.id,
        from: item.from,
        subject: item.subject,
        body: item.body,
        receivedAt: item.receivedAt,
        source: item.source,
        draft: item.draft,
      }),
      true,
      undefined,
      "email",
    );
  }
  // Fetching new mail (a Gmail sync or a Codex run through /native-connections/sync) only ever
  // happens here, from the refresh button: the page makes no automatic writes (T8b, lead decision).
  async function sync() {
    const targets = connected.filter(
      (a) => provider === "all" || a.id === (provider === "gmail" ? "google" : provider),
    );
    const native = nativeReady.filter(a => (provider === "all" || a.id === provider) && !targets.some(d => (d.id === "google" ? "gmail" : d.id) === a.id));
    if (!targets.length && !native.length) return;
    setBusy(true);
    setFailure("");
    try {
      let total = 0,
        limited = false;
      for (const a of targets) {
        const result = await operatorRequest("/connections/sync", { provider: a.id });
        total += result.messages || 0;
        limited ||= result.limited === true;
      }
      if (native.length) {
        const result = await operatorRequest<{ messages: number; results: Array<{ ok: boolean; error?: string }> }>("/native-connections/sync", { providers: native.map(a => a.id) });
        total += result.messages; limited = true;
        const errors = result.results.filter(r => !r.ok).map(r => r.error).join(" ");
        if (errors) setFailure(errors);
        await nativeAccounts.refetch();
      }
      await refresh();
      await accounts.refetch();
      setNotice(
        `Updated ${total} messages.${limited ? " More history is available in the source app." : ""}`,
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveReply(action: "draft" | "send") {
    if (!item || !draft.trim()) return;
    if (action === "draft" && !canDraft) {
      await mutate(
        { id: item.id, draft, draftTo: replyTo, draftCc: replyCc, draftBcc: replyBcc },
        "Draft saved locally. Nothing was sent.",
      );
      return;
    }
    if ((action === "send" && (!canSend || uncertainSend)) || !replyTo.trim()) return;
    const previous = sendAttempts.current[item.id];
    const attempt =
      previous &&
      previous.to === replyTo &&
      previous.cc === replyCc &&
      previous.bcc === replyBcc &&
      previous.body === draft
        ? previous
        : { requestId: crypto.randomUUID(), to: replyTo, cc: replyCc, bcc: replyBcc, body: draft };
    if (action === "send") sendAttempts.current[item.id] = attempt;
    setBusy(true);
    setFailure("");
    try {
      const result = await operatorRequest("/connections/gmail/action", {
        id: item.id,
        action,
        to: replyTo,
        cc: replyCc,
        bcc: replyBcc,
        body: draft,
        ...(action === "send" ? { requestId: attempt.requestId } : {}),
      });
      await refresh();
      if (result.uncertain) {
        setFailure(
          result.message ||
            "Gmail has not confirmed delivery. Check Sent in Gmail before another attempt.",
        );
        return;
      }
      if (action === "send") {
        setDraft("");
        setNotice("Reply sent with Gmail.");
      } else setNotice("Draft saved in Gmail.");
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Every minute while visible the page RE-READS what the server already has (GETs only): the saved
  // inbox, the account list and the mailbox connections. It never syncs on its own (T8b, lead
  // decision): opening /inbox used to POST /native-connections/sync (a Codex run that rewrites the
  // mail cache), and a 60-second timer kept POSTing /connections/sync and /native-connections/sync.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      void accounts.refetch();
      void nativeAccounts.refetch();
    }, 60000);
    return () => window.clearInterval(timer);
  }, []);
  function beginReply(all = false) {
    if (!item) return;
    if (all) {
      const own = (item.account || "").toLowerCase();
      const getAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] || value).trim();
      const recipient = getAddress(item.replyTo || item.from);
      const copied = [...(item.to || []), ...(item.cc || [])]
        .map(getAddress)
        .filter(
          (value, index, array) =>
            value &&
            value.toLowerCase() !== own &&
            value.toLowerCase() !== recipient.toLowerCase() &&
            array.findIndex((v) => v.toLowerCase() === value.toLowerCase()) === index,
        );
      setReplyTo(recipient);
      setReplyCc(copied.join(", "));
      setShowCc(copied.length > 0);
      setReplyBcc("");
      setShowBcc(false);
    }
    if (!all && !item.labelIds?.includes("DRAFT")) {
      setReplyTo(item.replyTo || item.from.match(/<([^>]+)>/)?.[1] || item.from);
      setReplyCc("");
      setReplyBcc("");
      setShowCc(false);
      setShowBcc(false);
    }
    setReplyOpen(true);
    window.setTimeout(() => {
      replyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      replyRef.current?.focus({ preventScroll: true });
    }, 50);
  }
  function selectFolder(value: string) {
    setFolder(value);
    setLabel("");
    setLabelAccount("");
    setCategory("all");
    setSelected(null);
  }
  const folderItems = [
    { id: "inbox", label: "Inbox", icon: Inbox },
    { id: "starred", label: "Starred", icon: Star },
    { id: "sent", label: "Sent", icon: Send },
    { id: "drafts", label: "Drafts", icon: FileText },
    { id: "archive", label: "Archive", icon: Archive },
    { id: "all", label: "All messages", icon: Layers },
  ];
  const selectedLabels =
    item?.labelIds
      ?.map((id) =>
        gmailLabels.find((l) => l.id === id && (!l.account || l.account === item?.account)),
      )
      .filter((l): l is GmailLabel => !!l && l.type !== "system") || [];
  return (
    <div className="op-page ar-mail-page ar-white-inbox" data-inbox-theme={effectiveTheme}>
      <PageHeader
        title="Inbox"
        // L1 (29 Sep 2026): one headline sentence (the owner's own words for this page).
        actions={
          <>
            {isDevMode() && (
              <button className="op-button" onClick={() => window.location.assign("/inbox?demo=1")}>Hide emails for demo</button>
            )}
            <AccountConnections compact messages />
          </>
        }
      />
      {(failure || error) && <Notice tone="danger">{failure || error?.message}</Notice>}
      {notice && (
        <Notice
          action={
            <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setNotice("")}>
              Dismiss
            </button>
          }
        >
          {notice}
        </Notice>
      )}
      <nav className="wi-provider-tabs" aria-label="Message sources">
        {providers.map((p) => {
          const count =
            p.id === "all"
              ? 0
              : p.id === "skool"
                ? (skoolStatus.data?.count ??
                  enabledMessages.filter((i) => i.source === "skool").length)
                : enabledMessages.filter((i) => i.source === p.id).length;
          return (
            <button
              key={p.id}
              className={provider === p.id ? "active" : ""}
              aria-pressed={provider === p.id}
              onClick={() => {
                setProvider(p.id);
                setRequestedSkoolChannel("");
                setNotice("");
                setFailure("");
                selectFolder("inbox");
              }}
            >
              <SourceLogo source={p.id} />
              <span>{p.label}</span>
              {count > 0 && <small>{count.toLocaleString()}</small>}
            </button>
          );
        })}
      </nav>
      {previewAvailable && (
        <div className="wi-mode-bar">
          <span className={isPreview ? "wi-demo-badge" : "wi-live-badge"}>
            {isPreview
              ? "DEMO"
              : sourceConnected
                ? "CONNECTED"
                : hasSourceMessages
                  ? "SAVED MESSAGES"
                  : "NOT CONNECTED"}
          </span>
          <p>
            {isPreview
              ? "A fictional workspace to try the experience. Demo replies stay in this browser."
              : sourceConnected && provider === "skool"
                ? "Live Skool conversations · press refresh to fetch new messages."
                : activeNative
                  ? "Recent messages through Codex · press refresh to fetch new ones. Open the original to reply."
                : hasSourceMessages
                  ? "Your saved conversations. Use the original app for the latest messages."
                  : "Your connected account and saved messages. No sample conversations."}
          </p>
          <div>
            <button
              aria-pressed={isPreview}
              onClick={() => setSourceModes({ ...sourceModes, [provider]: "preview" })}
            >
              Try demo
            </button>
            <button
              aria-pressed={!isPreview}
              onClick={() => setSourceModes({ ...sourceModes, [provider]: "live" })}
            >
              {sourceConnected ? "View account" : "View saved"}
            </button>
          </div>
        </div>
      )}
      {provider === "all" ? (
        <InboxOverview
          messages={enabledMessages}
          accounts={accounts.data?.accounts || []}
          nativeAccounts={nativeReady}
          skool={skoolStatus.data}
          ask={overviewAsk}
          onQuestion={(question) => {
            stopOverviewAnswer();
            setOverviewAsk((old) => ({ ...old, question, busy: false, thinking: false }));
          }}
          onAsk={() => void askOverview()}
          onResetAsk={() => {
            stopOverviewAnswer();
            setOverviewAsk({ question: "", busy: false, thinking: false, error: "" });
          }}
          onResult={(result) => {
            if (result.source === "skool" && result.threadId) {
              setProvider("skool");
              setSourceModes((old) => ({ ...old, skool: "live" }));
              setRequestedSkoolChannel(result.threadId);
              return;
            }
            const message = enabledMessages.find((m) => m.id === result.id);
            if (!message) {
              setOverviewAsk((old) => ({
                ...old,
                error:
                  "This message is no longer in the loaded inbox. Refresh its source to open it here.",
              }));
              return;
            }
            setProvider(message.source);
            setSourceModes((old) => ({ ...old, [message.source]: "live" }));
            openMessage(message);
          }}
          onSource={(id) => {
            setProvider(id);
            selectFolder("inbox");
            setRequestedSkoolChannel("");
          }}
          onMessage={(message) => {
            setProvider(message.source);
            setSourceModes((old) => ({ ...old, [message.source]: "live" }));
            if (message.source === "skool") {
              setRequestedSkoolChannel(message.threadId || message.id.replace(/^skool[:_-]/, ""));
            } else {
              openMessage(message);
            }
          }}
        />
      ) : isPreview ? (
        <ProviderPreview key={provider} provider={provider as "slack" | "outlook" | "skool"} />
      ) : provider === "skool" ? (
        <SkoolMailbox
          status={skoolStatus.data}
          loading={skoolStatus.isLoading}
          error={skoolStatus.error?.message}
          initialChannelId={requestedSkoolChannel}
        />
      ) : (
        <>
          <details className="wi-brief">
            <summary>
              <span className="wi-brief-icon">
                <MessageSquare size={14} />
              </span>
              <strong>Your daily brief</strong>
              <span>
                {enabledMessages.filter((i) => matchesFolder(i, "inbox") && i.read !== true).length}{" "}
                unread in your workspace
              </span>
              <ChevronDown size={15} />
            </summary>
            <InboxDailyBrief
              state={state}
              inbox={briefInbox}
              accounts={accounts.data?.accounts || []}
              onSelect={openMessage}
            />
          </details>
          <div className="ar-mail-shell wi-shell">
            <aside className="ar-mail-folders wi-folders">
              <button className="wi-capture" onClick={() => setAdd(true)}>
                <Plus size={19} />
                <span>Capture message</span>
              </button>
              <nav aria-label="Mail folders">
                {folderItems.map((f) => (
                  <button
                    key={f.id}
                    className={folder === f.id && !label ? "active" : ""}
                    onClick={() => selectFolder(f.id)}
                  >
                    <f.icon size={16} />
                    <span>{f.label}</span>
                    <small>{visibleInbox.filter((i) => matchesFolder(i, f.id)).length || ""}</small>
                  </button>
                ))}
              </nav>
              {(provider === "all" || provider === "gmail") && (
                <div className="wi-labels">
                  <div className="wi-label-heading">
                    Labels <span>{userLabels.length || ""}</span>
                  </div>
                  {userLabels.length ? (
                    userLabels.map((l) => {
                      const loaded = visibleInbox.filter(
                        (i) =>
                          i.labelIds?.includes(l.id) && (!l.account || i.account === l.account),
                      ).length;
                      return (
                        <button
                          key={`${l.account || ""}:${l.id}`}
                          className={
                            label === l.id && labelAccount === (l.account || "") ? "active" : ""
                          }
                          title={`${l.name}${l.account ? ` · ${l.account}` : ""}${l.messagesTotal != null ? ` · ${l.messagesTotal} in Gmail` : ""} · ${loaded} loaded here`}
                          onClick={() => {
                            setLabel(l.id);
                            setLabelAccount(l.account || "");
                            setCategory("all");
                            setSelected(null);
                          }}
                        >
                          <Tag size={14} style={{ color: l.color?.backgroundColor || "var(--muted-foreground)" }} />
                          <span>{l.name}</span>
                          <small>{loaded || ""}</small>
                        </button>
                      );
                    })
                  ) : (
                    <p>
                      Your Gmail labels will appear here after importing or connecting your account.
                    </p>
                  )}
                </div>
              )}
              {showAccounts && (
                <div className="wi-account-detail">
                  <small>ACCOUNTS</small>
                  {providers
                    .filter((p) => p.id !== "all")
                    .map((p) => (
                      <div key={p.id}>
                        <SourceLogo source={p.id} />
                        <span>
                          {p.label}
                          <small>
                            {accounts.data?.accounts.find(
                              (a) => a.id === (p.id === "gmail" ? "google" : p.id),
                            )?.connected
                              ? "Connected"
                              : state.inboxImports?.some((s) => s.provider === p.id)
                                ? "Saved snapshot"
                                : "Not connected"}
                          </small>
                        </span>
                      </div>
                    ))}
                </div>
              )}
              <div className="wi-folder-note">
                <span
                  className={`wi-status-dot ${activeSource?.connected ? "is-connected" : ""}`}
                />
                <span>
                  {sourceState}
                  <small>Folder counts show loaded messages.</small>
                </span>
              </div>
            </aside>
            <section className="ar-mail-content wi-content">
              <div className="ar-mail-search wi-search">
                <label>
                  <Search size={19} />
                  <input
                    aria-label="Search inbox"
                    placeholder={
                      provider === "all"
                        ? "Search all conversations"
                        : `Search ${sourceName(provider)}`
                    }
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelected(null);
                    }}
                  />
                  {query && (
                    <button aria-label="Clear search" onClick={() => setQuery("")}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                <button
                  className="op-icon-button"
                  disabled={
                    busy ||
                    !nativeReady.some(a => provider === "all" || a.id === provider) && !connected.some(
                      (a) =>
                        provider === "all" || a.id === (provider === "gmail" ? "google" : provider),
                    )
                  }
                  aria-label="Sync inbox"
                  title="Refresh connected accounts"
                  onClick={() => void sync()}
                >
                  <RefreshCw size={16} className={busy ? "wi-spinning" : ""} />
                </button>
                <details className="ar-mail-view">
                  <summary>
                    <SlidersHorizontal size={15} />
                    <span>View</span>
                  </summary>
                  <div className="ar-mail-view-panel">
                    <h3>Show messages from</h3>
                    {[
                      ["gmail", "Gmail"],
                      ["outlook", "Outlook"],
                      ["slack", "Slack"],
                      ["skool", "Skool"],
                      ["capture", "Captured messages"],
                    ].map(([id, name]) => (
                      <label key={id}>
                        <span>
                          <SourceLogo source={id} />
                          {name}
                        </span>
                        <input
                          type="checkbox"
                          aria-label={`Show ${name}`}
                          checked={visibleAccounts[id]}
                          disabled={savingView}
                          onChange={(e) =>
                            void changeView({
                              inboxAccounts: {
                                ...visibleAccounts,
                                [id]: e.target.checked,
                              } as typeof state.settings.inboxAccounts,
                            })
                          }
                        />
                      </label>
                    ))}
                    <hr />
                    {[
                      ["inboxShowAccounts", "Show account details", showAccounts],
                      ["inboxShowCategories", "Show categories", showCategories],
                      ["inboxAutoRead", "Mark read when opened", autoRead],
                    ].map(([key, name, checked]) => (
                      <label key={String(key)}>
                        <span>{name}</span>
                        <input
                          type="checkbox"
                          aria-label={String(name)}
                          checked={!!checked}
                          disabled={savingView}
                          onChange={(e) => void changeView({ [String(key)]: e.target.checked })}
                        />
                      </label>
                    ))}
                    <p>
                      Account filters change this view. Memory controls what chat can use. Snapshot
                      actions stay in this workspace; connected Gmail actions require write access.
                    </p>
                  </div>
                </details>
              </div>
              {!item ? (
                <>
                  <div className="wi-list-toolbar">
                    <strong>
                      {label
                        ? gmailLabels.find(
                            (l) => l.id === label && (!labelAccount || l.account === labelAccount),
                          )?.name
                        : folderItems.find((f) => f.id === folder)?.label}
                    </strong>
                    <span>
                      {items.length} loaded
                      {mailboxCount != null ? ` · ${mailboxCount.toLocaleString()} in Gmail` : ""}
                    </span>
                  </div>
                  {showCategories && !label && folder === "inbox" && (
                    <div className="ar-mail-categories wi-categories">
                      {[{ id: "all", label: "All" }, ...categories].map((c) => (
                        <button
                          key={c.id}
                          className={category === c.id ? "active" : ""}
                          onClick={() => setCategory(c.id)}
                        >
                          {c.label}
                          {category === c.id && <span />}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="ar-mail-rows wi-rows">
                    {items.length ? (
                      items.map((i) => (
                        <div
                          key={i.id}
                          className={`wi-row ${i.read === true ? "is-read" : "is-unread"}`}
                        >
                          <button
                            className={`wi-row-star ${isStarred(i) ? "is-starred" : ""}`}
                            aria-label={`${isStarred(i) ? "Unstar" : "Star"} ${i.subject}`}
                            disabled={busy}
                            onClick={() => void messageAction(i, isStarred(i) ? "unstar" : "star")}
                          >
                            <Star size={16} />
                          </button>
                          <button
                            className="wi-row-main"
                            aria-label={`${i.read === true ? "" : "Unread. "}${i.from || "You"}: ${i.subject}`}
                            onClick={() => openMessage(i)}
                          >
                            <span className="wi-row-sender">
                              {provider === "all" && <SourceLogo source={i.source} />}
                              <span>{senderName(i.from)}</span>
                            </span>
                            <span className="wi-row-copy">
                              <strong>{i.subject || "(No subject)"}</strong>
                              <span className="wi-row-preview">
                                {" "}
                                — {i.body.replace(/\s+/g, " ")}
                              </span>
                              {i.draft && <b>Draft</b>}
                            </span>
                            <time>{messageDate(i.receivedAt)}</time>
                          </button>
                          <div className="wi-row-actions">
                            <button
                              aria-label={`${i.read === true ? "Mark unread" : "Mark read"}: ${i.subject}`}
                              title={i.read === true ? "Mark unread" : "Mark read"}
                              disabled={busy}
                              onClick={() =>
                                void messageAction(i, i.read === true ? "unread" : "read")
                              }
                            >
                              {i.read === true ? <Mail size={16} /> : <MailOpen size={16} />}
                            </button>
                            <button
                              aria-label={`${i.status === "done" ? "Restore" : "Archive"}: ${i.subject}`}
                              title={i.status === "done" ? "Move to inbox" : "Archive"}
                              disabled={busy}
                              onClick={() =>
                                void messageAction(i, i.status === "done" ? "restore" : "archive")
                              }
                            >
                              {i.status === "done" ? <Inbox size={16} /> : <Archive size={16} />}
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="ar-mail-empty wi-empty">
                        <div className="wi-empty-icon">
                          <SourceLogo source={provider} />
                        </div>
                        <h2>
                          {query
                            ? "No matching conversations"
                            : label
                              ? "No loaded messages with this label"
                              : provider !== "all" && !visibleInbox.length
                                ? `Bring ${sourceName(provider)} into the conversation.`
                                : folder === "inbox"
                                  ? "A little breathing room."
                                  : `No ${folder === "archive" ? "archived messages" : folder === "all" ? "messages" : folder} here yet.`}
                        </h2>
                        <p>
                          {query
                            ? "Try a sender, subject or phrase."
                            : label
                              ? "Labels are from Gmail. This view shows the messages currently loaded in your workspace."
                              : provider === "skool"
                                ? "Your Skool conversations will appear here after they are imported."
                                : !visibleInbox.length
                                  ? "Connect an account or capture a message. Your conversations will stay together here."
                                  : "Messages you move to this view will appear here."}
                        </p>
                        {provider === "skool" && !visibleInbox.length && (
                          <a
                            className="op-button"
                            href="https://www.skool.com/chat"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Skool
                            <ArrowUpRight size={12} />
                          </a>
                        )}
                        {!visibleInbox.length && provider !== "skool" && (
                          <AccountConnections
                            compact
                            messages
                            only={
                              provider === "all"
                                ? undefined
                                : provider === "gmail"
                                  ? "google"
                                  : provider
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                  {hiddenCount > 0 && (
                    <p className="ar-mail-hidden-count">
                      {hiddenCount} message{hiddenCount === 1 ? "" : "s"} hidden by View settings.
                    </p>
                  )}
                  <div className="wi-bottom-status">
                    <span className="wi-status-dot" />
                    {connected.some((a) => a.id === "google" && ["all", "gmail"].includes(provider))
                      ? `Connected Gmail · press refresh to fetch new mail. ${activeSource?.lastSync ? `Last updated ${fmtTime(new Date(activeSource.lastSync))}.` : "Use refresh to check your accounts now."}`
                      : activeNative
                        ? `Recent messages through Codex · press refresh to fetch new ones. ${activeNative.lastSync ? `Updated ${fmtTime(new Date(activeNative.lastSync))}.` : ""}`
                      : snapshot
                        ? `Saved snapshot · ${fmtDay(new Date(snapshot.importedAt))} · Connect for refresh and remote actions`
                        : "Original conversations stay in their source apps."}
                  </div>
                </>
              ) : (
                <div className="wi-reader-wrap">
                  <div className="ar-mail-reader wi-reader">
                    <div className="ar-reader-tools wi-reader-tools">
                      <button
                        className="op-icon-button"
                        aria-label="Back to messages"
                        onClick={() => setSelected(null)}
                      >
                        <ArrowLeft size={18} />
                      </button>
                      <span className="wi-tool-divider" />
                      <button
                        className="op-icon-button"
                        aria-label={item.status === "done" ? "Restore message" : "Archive message"}
                        title={item.status === "done" ? "Move to inbox" : "Archive"}
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await messageAction(
                              item,
                              item.status === "done" ? "restore" : "archive",
                            )
                          )
                            setSelected(null);
                        }}
                      >
                        <Archive size={17} />
                      </button>
                      <button
                        className="op-icon-button"
                        disabled={busy}
                        aria-label={item.read === true ? "Mark unread" : "Mark read"}
                        title={item.read === true ? "Mark unread" : "Mark read"}
                        onClick={() =>
                          void messageAction(item, item.read === true ? "unread" : "read")
                        }
                      >
                        {item.read === true ? <Mail size={17} /> : <MailOpen size={17} />}
                      </button>
                      <span className="wi-reader-write-status">
                        {canModify
                          ? `${sourceName(item.source)} sync enabled`
                          : "Changes saved in this workspace"}
                      </span>
                      {item.source !== "capture" && (
                        <a
                          href={originalUrl(item)}
                          className="wi-original"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open {sourceName(item.source)}
                          <ArrowUpRight size={13} />
                        </a>
                      )}
                    </div>
                    <div className="wi-reader-heading">
                      <h2>{item.subject || "(No subject)"}</h2>
                      {selectedLabels.length > 0 && (
                        <div className="wi-reader-labels">
                          {selectedLabels.map((l) => (
                            <span
                              key={l.id}
                              style={{
                                background: l.color?.backgroundColor,
                                color: l.color?.textColor,
                              }}
                            >
                              {l.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="ar-reader-byline wi-byline">
                      <span className="op-message-avatar">
                        {senderName(item.from).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{senderName(item.from)}</strong>
                        {item.from.includes("<") && (
                          <span className="wi-sender-email">
                            {item.from.match(/<([^>]+)>/)?.[1]}
                          </span>
                        )}
                        <small>
                          {item.to ? `to ${item.to.join(", ")}` : `via ${sourceName(item.source)}`}{" "}
                          <ChevronDown size={10} />
                        </small>
                      </div>
                      <time>
                        {fmtDateTime(new Date(item.receivedAt))}
                      </time>
                    </div>
                    <div className="op-detail-text wi-message-body">{item.body}</div>
                    <div className="wi-next-step">
                      <span className="wi-next-step-icon">
                        <MessageSquare size={15} />
                      </span>
                      <div>
                        <strong>A little context</strong>
                        <p>
                          {item.triageReason ||
                            "Ask for a summary, check the context, or draft your next move."}
                        </p>
                      </div>
                      <button
                        disabled={!emailEnabled}
                        onClick={() =>
                          askEmail(
                            "Summarise this message and suggest the next step, using relevant enabled memory. Do not send anything.",
                          )
                        }
                      >
                        Think with me <ChevronRight size={13} />
                      </button>
                    </div>
                    <div className="wi-reply-actions">
                      <button className="wi-main-reply" onClick={() => beginReply(false)}>
                        <Reply size={17} />
                        Reply
                      </button>
                      <button onClick={() => beginReply(true)}>
                        <Users size={16} />
                        Reply all
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await operatorRequest("/memory", {
                              title: item.subject,
                              text: `From: ${item.from}\n\n${item.body}`,
                              collection: "business",
                              kind: "note",
                              origin: "email",
                            });
                            await refresh();
                            setNotice("Saved to memory.");
                          } catch (e) {
                            setFailure((e as Error).message);
                          }
                        }}
                      >
                        <BookmarkPlus size={16} />
                        Save to Memory
                      </button>
                      <span>
                        {canSend ? "Connected to Gmail" : item.source === "gmail" ? "Draft here, authorize Gmail to send" : `Draft here, reply in ${sourceName(item.source)}`}
                      </span>
                    </div>
                    {replyOpen && (
                      <form
                        className="wi-reply"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveReply("draft");
                        }}
                      >
                        <div className="wi-reply-heading">
                          <Reply size={16} />
                          <strong>Your reply</strong>
                          <span>
                            {canSend
                              ? `Send with ${sourceName(item.source)}`
                              : "Local draft"}
                          </span>
                        </div>
                        <label className="wi-reply-to">
                          <span>To</span>
                          <input
                            aria-label="Reply recipient"
                            value={replyTo}
                            onChange={(e) => setReplyTo(e.target.value)}
                            placeholder="Recipient"
                          />
                          <button
                            type="button"
                            aria-pressed={showCc || !!replyCc}
                            onClick={() => setShowCc(!showCc)}
                          >
                            Cc
                          </button>
                          <button
                            type="button"
                            aria-pressed={showBcc || !!replyBcc}
                            onClick={() => setShowBcc(!showBcc)}
                          >
                            Bcc
                          </button>
                        </label>
                        {(showCc || !!replyCc) && (
                          <label className="wi-reply-to">
                            <span>Cc</span>
                            <input
                              aria-label="Reply Cc"
                              value={replyCc}
                              onChange={(e) => setReplyCc(e.target.value)}
                              placeholder="Add recipients"
                            />
                          </label>
                        )}
                        {(showBcc || !!replyBcc) && (
                          <label className="wi-reply-to">
                            <span>Bcc</span>
                            <input
                              aria-label="Reply Bcc"
                              value={replyBcc}
                              onChange={(e) => setReplyBcc(e.target.value)}
                              placeholder="Add hidden recipients"
                            />
                          </label>
                        )}
                        <textarea
                          ref={replyRef}
                          aria-label="Reply message"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="Write your reply…"
                        />
                        <div className="wi-reply-footer">
                          <button
                            className="wi-help-reply"
                            type="button"
                            disabled={!emailEnabled}
                            onClick={() =>
                              askEmail(
                                "Draft a useful, concise reply to this message with my context. Do not send it.",
                              )
                            }
                          >
                            <MessageSquare size={14} />
                            Help me reply
                          </button>
                          <button
                            type="submit"
                            className="op-button"
                            disabled={busy || !draft.trim() || (canDraft && !replyTo.trim())}
                          >
                            {busy ? <Busy /> : <Check size={14} />}Save draft
                          </button>
                          <button
                            type="button"
                            className="wi-send"
                            disabled={
                              busy || !canSend || !draft.trim() || !replyTo.trim() || uncertainSend
                            }
                            title={
                              uncertainSend
                                ? "Check Gmail Sent before another attempt"
                                : canSend
                                  ? `Send this reply to ${replyTo}`
                                  : "Connect a sending-enabled account to send from here"
                            }
                            onClick={() => void saveReply("send")}
                          >
                            <Send size={14} />
                            Send
                          </button>
                        </div>
                        {uncertainSend ? (
                          <p className="wi-send-note wi-send-uncertain">
                            Delivery is unconfirmed. Your reply is saved.{" "}
                            <a
                              href="https://mail.google.com/mail/u/0/#sent"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Check Gmail Sent
                            </a>{" "}
                            before sending another copy.
                          </p>
                        ) : !canSend ? (
                          <p className="wi-send-note">
                            You can prepare replies here. Sending needs an account with send access.
                          </p>
                        ) : (
                          <p className="wi-send-note">
                            Send delivers this reply to the recipient above using your connected
                            Gmail account.
                          </p>
                        )}
                      </form>
                    )}
                  </div>
                  <aside className="wi-context-panel">
                    <span className="wi-context-eyebrow">CONNECTED CONTEXT</span>
                    <h3>See the bigger picture.</h3>
                    <p>
                      Ask about this conversation alongside the sources you’ve enabled in Memory.
                    </p>
                    <div className="wi-context-item">
                      <SourceLogo source={item.source} />
                      <span>
                        This conversation
                        <small>
                          {sourceName(item.source)} ·{" "}
                          {item.read === true ? "Read here" : "Unread here"}
                        </small>
                      </span>
                    </div>
                    <a className="wi-context-item" href="/memory">
                      <Layers size={18} />
                      <span>
                        Your memory<small>Manage enabled sources</small>
                      </span>
                      <ArrowUpRight size={12} />
                    </a>
                    <button
                      className="wi-remember"
                      onClick={async () => {
                        try {
                          await operatorRequest("/memory", {
                            title: item.subject,
                            text: `From: ${item.from}\n\n${item.body}`,
                            collection: "business",
                            kind: "note",
                            origin: "email",
                          });
                          await refresh();
                          setNotice("Saved to memory.");
                        } catch (e) {
                          setFailure((e as Error).message);
                        }
                      }}
                    >
                      <BookmarkPlus size={14} />
                      Save to Memory
                    </button>
                    <div className="wi-context-prompts">
                      {[
                        "What needs my attention?",
                        "What should I reply?",
                        "Find related context",
                      ].map((p) => (
                        <button key={p} disabled={!emailEnabled} onClick={() => askEmail(p)}>
                          {p}
                          <ChevronRight size={12} />
                        </button>
                      ))}
                    </div>
                  </aside>
                </div>
              )}
            </section>
          </div>
        </>
      )}
      {/* The saved-email library: a search tool, after the conversations (L1). */}
      <div className="mt-6">
        <MailArchivePanel />
      </div>
      <PageFoot title="Gmail, Outlook, Slack and Skool in one place: what needs your reply comes first.">From loaded conversations · nothing syncs or sends on its own</PageFoot>
      <Modal
        open={add}
        onClose={() => setAdd(false)}
        title="Capture a message"
        description="Save an email, DM or follow-up in your workspace."
      >
        <form
          className="op-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await mutate({ subject, body, from }, "Message captured.")) {
              setAdd(false);
              setSubject("");
              setBody("");
              setFrom("");
            }
          }}
        >
          <label>
            From or source
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="A person or company"
            />
          </label>
          <label>
            Subject
            <input required value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            Message
            <textarea required value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {failure && <Notice tone="danger">{failure}</Notice>}
          <button className="op-button primary" disabled={busy}>
            {busy ? <Busy /> : <Plus size={14} />}Capture message
          </button>
        </form>
      </Modal>
    </div>
  );
}

function InboxOverview({
  messages,
  accounts,
  nativeAccounts,
  skool,
  onSource,
  onMessage,
  ask,
  onQuestion,
  onAsk,
  onResetAsk,
  onResult,
}: {
  messages: Message[];
  accounts: { id: string; connected: boolean }[];
  nativeAccounts: { id: string; lastSync?: string; error?: string }[];
  skool?: SkoolStatus;
  onSource: (id: string) => void;
  onMessage: (message: Message) => void;
  ask: InboxAskState;
  onQuestion: (question: string) => void;
  onAsk: () => void;
  onResetAsk: () => void;
  onResult: (result: InboxAskResult) => void;
}) {
  const sources = providers.filter((p) => p.id !== "all");
  const candidates = messages
    .filter((m) => {
      if (m.source === "skool") return false;
      if (
        m.status === "done" ||
        m.labelIds?.some((id) => ["DRAFT", "SENT", "TRASH", "SPAM"].includes(id))
      )
        return false;
      if (m.source === "gmail" && m.labelIds && !m.labelIds.includes("INBOX")) return false;
      // Bulk, newsletter and marketing mail is never a conversation to answer (audit P2-10). Mail stored
      // before the ingest rule existed is still filtered here, from its sender, labels and wording.
      if (
        !m.draft &&
        isBulkMail({ from: m.from, subject: m.subject, body: m.body, labelIds: m.labelIds, listUnsubscribe: m.listUnsubscribe, isReply: !!m.references })
      )
        return false;
      return (
        !!m.draft ||
        m.category === "needs-you" ||
        m.category === "sponsors" ||
        m.category === "waiting"
      );
    })
    .sort(
      (a, b) =>
        Number(!!b.draft) - Number(!!a.draft) ||
        Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
    );
  const grouped = sources.map((source) => {
    const loaded = messages.filter((m) => m.source === source.id);
    const native = nativeAccounts.find((account) => account.id === source.id);
    const connected =
      source.id === "skool"
        ? !!skool?.connected
        : !!accounts.find(
            (a) => a.id === (source.id === "gmail" ? "google" : source.id) && a.connected,
          );
    const count = source.id === "skool" ? (skool?.count ?? loaded.length) : loaded.length;
    const review: Message[] =
      source.id === "skool"
        ? (skool?.channels || [])
            .filter((c) => c.unread && c.lastMessage && !c.lastMessage.fromSelf)
            .slice(0, 2)
            .map(
              (c) =>
                ({
                  id: `skool:${c.id}`,
                  source: "skool",
                  threadId: c.id,
                  from: c.name,
                  subject: "Unread community message",
                  body: c.lastMessage!.content,
                  receivedAt: c.updatedAt,
                  read: false,
                  category: "needs-you",
                  status: "open",
                  url: c.originalUrl,
                }) as Message,
            )
        : candidates.filter((m) => m.source === source.id).slice(0, 2);
    return { ...source, connected, native, count, review };
  });
  const review = grouped.flatMap((source) => source.review);
  function nextStep(message: Message) {
    if (message.draft) return "Review your draft reply";
    if (message.source === "skool") return "Read and reply";
    if (message.category === "sponsors") return "Review opportunity";
    if (message.category === "waiting") return "Check the follow-up";
    return "Review and decide";
  }
  // L1 (29 Sep 2026): the owner liked this page's structure (source cards filling the width, even
  // spacing, one headline, icon pill tabs) but "it isn't perfect". The redesign keeps that structure
  // on the shared widget grid and leads with what the page DOES: the conversations to answer, and
  // asking about them. The four source cards follow as equal widgets. Nothing is removed.
  const sourceStatus = (source: (typeof grouped)[number]) =>
    source.connected
      ? "Connected"
      : source.native
        ? source.native.error
          ? "Refresh needs attention"
          : "Read through Codex"
        : source.count
          ? "Saved messages"
          : "Not connected";
  // With no account connected and nothing saved, "no conversations" would be a guess, not a fact.
  const anySource = grouped.some((source) => source.connected || source.native || source.count);
  return (
    <section className="wi-overview wi-overview-grid" aria-label="Inbox overview">
      <WidgetGrid mobile={2}>
        <WidgetList
          id="inbox-to-answer"
          span={2}
          icon={Reply}
          title="To answer"
          badge={review.length || undefined}
          empty={
            <>
              <span className="block text-base font-medium text-foreground">{anySource ? "No conversations flagged here." : "Nothing to answer yet."}</span>
              <span className="mt-1 block">{anySource ? "Drafts, flagged and unread messages show here." : "Connect an account above. Until then this is unknown, not empty."}</span>
            </>
          }
        >
          {review.map((message) => (
            <li key={message.id} className="py-1.5 first:pt-0 last:pb-0">
              <button className="wi-overview-item" onClick={() => onMessage(message)}>
                <span className="wi-overview-item-logo">
                  <SourceLogo source={message.source} />
                </span>
                <span className="wi-overview-item-copy">
                  <span>
                    <strong>{senderName(message.from)}</strong>
                    <small>
                      {sourceName(message.source)} · {messageDate(message.receivedAt)}
                    </small>
                  </span>
                  <b>{message.subject}</b>
                  <p>{message.body || "Open the conversation to review its contents."}</p>
                </span>
                <span className="wi-overview-next">
                  {nextStep(message)}
                  <ArrowUpRight size={14} />
                </span>
              </button>
            </li>
          ))}
        </WidgetList>

        <Widget id="inbox-ask" span={2} icon={MessageSquare} title="Ask your inbox">
          <div className="wi-overview-ask">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onAsk();
              }}
              aria-label="Ask Worth a look"
            >
              <Search size={18} />
              <input
                aria-label="Question about your inbox"
                placeholder="What needs my reply? Ask about a person, topic or conversation…"
                maxLength={600}
                value={ask.question}
                disabled={ask.busy}
                onChange={(e) => onQuestion(e.target.value)}
              />
              <button
                type="submit"
                aria-label={ask.busy ? "Finding conversations" : "Ask about your inbox"}
                disabled={ask.busy || !ask.question.trim()}
              >
                {ask.busy ? <Busy /> : <ArrowUpRight size={17} />}
                <span>{ask.busy ? "Finding…" : "Ask"}</span>
              </button>
            </form>
            {ask.busy ? (
              <p className="wi-ask-pending" role="status">
                Finding relevant conversations in your loaded inbox…
              </p>
            ) : null}
            {ask.error && (
              <div className="wi-ask-error" role="alert">
                <p>{ask.error}</p>
                <button disabled={ask.busy || !ask.question.trim()} onClick={onAsk}>
                  Try again
                  <RefreshCw size={12} />
                </button>
              </div>
            )}
          </div>
          {ask.response && !ask.busy ? (
            <div className="wi-ask-results" aria-label="Inbox question results">
              <header>
                <div>
                  <span>
                    {ask.response.mode === "answer"
                      ? "ANSWER FROM YOUR CONVERSATIONS"
                      : "CONVERSATION SEARCH"}
                  </span>
                  <h4>{ask.response.question}</h4>
                </div>
                <button aria-label="Clear question results" onClick={onResetAsk}>
                  <X size={15} />
                </button>
              </header>
              {ask.thinking && (
                <p className="wi-ask-thinking" role="status">
                  <Busy />
                  Thinking about these conversations…
                </p>
              )}
              {ask.response.answer && <p className="wi-ask-answer">{ask.response.answer}</p>}
              {ask.response.notice && <p className="wi-ask-notice">{ask.response.notice}</p>}
              {ask.response.results.length ? (
                <div className="wi-ask-source-list">
                  {ask.response.results.map((result) => (
                    <article className="wi-ask-source" key={`${result.source}:${result.id}`}>
                      <div className="wi-ask-source-heading">
                        <span className="wi-overview-item-logo">
                          <SourceLogo source={result.source} />
                        </span>
                        <div>
                          <strong>{senderName(result.from)}</strong>
                          <small>
                            {sourceName(result.source)} · {messageDate(result.receivedAt)}
                            {result.direction === "outbound" ? " · Sent by you" : ""}
                          </small>
                        </div>
                      </div>
                      <h5>{result.title}</h5>
                      <blockquote>
                        {result.excerpt || "Open this conversation to read its contents."}
                      </blockquote>
                      <footer>
                        <span>{result.reason}</span>
                        <button onClick={() => onResult(result)}>
                          Read &amp; reply
                          <Reply size={14} />
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="wi-ask-no-results">
                  <Search size={22} />
                  <h5>No matching conversations in the loaded inbox.</h5>
                  <p>
                    Try a person’s name or a more specific topic, or refresh the source to load recent
                    messages.
                  </p>
                </div>
              )}
              <div className="wi-ask-coverage">
                <span>
                  {ask.response.results.length < ask.response.matchedCount
                    ? `Showing ${ask.response.results.length} of ${ask.response.matchedCount.toLocaleString()} matches`
                    : `${ask.response.matchedCount.toLocaleString()} ${ask.response.matchedCount === 1 ? "match" : "matches"}`}{" "}
                  · {ask.response.totalSearched.toLocaleString()} searched
                </span>
                <p>{ask.response.coverage}</p>
              </div>
            </div>
          ) : null}
        </Widget>

        {/* Four identical "Not connected" tiles are noise: the tabs above open each source, Connect accounts connects them. */}
        {anySource && grouped.map((source) => (
          <Widget
            key={source.id}
            data-source={source.id}
            title={
              <span className="inline-flex min-w-0 items-center gap-2.5">
                <span aria-hidden="true" className="wi-overview-source-logo grid size-9 shrink-0 place-items-center rounded-full bg-inset">
                  <SourceLogo source={source.id} />
                </span>
                <span className="truncate">{source.label}</span>
              </span>
            }
            badge={source.review.length ? `${source.review.length} to answer` : undefined}
            value={source.count ? source.count.toLocaleString() : null}
            line={
              <span className="flex items-center gap-2">
                <i aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", source.connected || (source.native && !source.native.error) ? "bg-success" : "bg-muted-foreground/50")} />
                <span className="min-w-0">
                  {source.count ? `${source.id === "skool" ? "Conversations" : "Messages"} loaded · ` : <span className="sr-only">No messages loaded · </span>}
                  {sourceStatus(source)}
                </span>
              </span>
            }
            action={
              <button type="button" aria-label={`Open ${source.label}`} className="wi-overview-open inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-raised" onClick={() => onSource(source.id)}>
                Open<span className="hidden sm:inline"> {source.label}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            }
          />
        ))}
      </WidgetGrid>
    </section>
  );
}

type PreviewMessage = { id: string; name: string; body: string; time: string; mine?: boolean };
type PreviewThread = {
  id: string;
  name: string;
  title: string;
  initials: string;
  color: string;
  action: string;
  context: string;
  channel?: boolean;
  unread: boolean;
  archived?: boolean;
  messages: PreviewMessage[];
};
const PREVIEW_THREADS: Record<"slack" | "outlook" | "skool", PreviewThread[]> = {
  slack: [
    {
      id: "launch",
      name: "launch-team",
      title: "Thursday launch",
      initials: "#",
      color: "violet",
      channel: true,
      unread: true,
      action: "Approve the launch headline so the team can schedule the announcement.",
      context:
        "This example team has finished the page and email. The headline is the last decision before scheduling.",
      messages: [
        {
          id: "s1",
          name: "Lena Brooks",
          time: "09:42",
          body: "Morning team! The launch page and welcome email are ready for the final check.",
        },
        {
          id: "s2",
          name: "Noah Ellis",
          time: "09:45",
          body: "I’ve attached the final headline options in the project. My vote is ‘Make room for your best work.’",
        },
        {
          id: "s3",
          name: "Lena Brooks",
          time: "09:48",
          body: "Could you give us the green light on the headline? Then I can schedule everything for Thursday.",
        },
      ],
    },
    {
      id: "design",
      name: "design-review",
      title: "A calmer first impression",
      initials: "#",
      color: "blue",
      channel: true,
      unread: false,
      action: "Choose one of the two onboarding directions.",
      context:
        "The example design team has prepared two directions. Both use the same feature set.",
      messages: [
        {
          id: "s4",
          name: "Theo James",
          time: "08:30",
          body: "I’ve simplified the first screen. There are now just two decisions instead of five.",
        },
        {
          id: "s5",
          name: "Lena Brooks",
          time: "08:34",
          body: "The quieter version feels much easier to use. Let’s walk through it in our next review.",
        },
      ],
    },
    {
      id: "maya",
      name: "Maya Turner",
      title: "A quick handover",
      initials: "MT",
      color: "rose",
      unread: true,
      action: "Confirm the owner of Friday’s customer handover.",
      context: "Maya is handing off an example customer project before taking Friday off.",
      messages: [
        {
          id: "s6",
          name: "Maya Turner",
          time: "Yesterday",
          body: "Hey! I’m away Friday. Would you be able to cover the 15-minute customer handover? The notes are all ready.",
        },
      ],
    },
  ],
  outlook: [
    {
      id: "proposal",
      name: "Elena Wright",
      title: "Partnership proposal — your thoughts?",
      initials: "EW",
      color: "blue",
      unread: true,
      action: "Review the proposed scope and confirm whether the dates work.",
      context:
        "This fictional partnership is at the proposal stage. The sender needs a scope decision before preparing an agreement.",
      messages: [
        {
          id: "o1",
          name: "Elena Wright",
          time: "10:24",
          body: "Hi,\n\nThanks for the conversation yesterday. I’ve put together the partnership outline based on the three outcomes we discussed.\n\nThe proposed start is the first week of next month, with a short review after the initial two weeks. Does that timing work for you?\n\nIf the scope looks right, I can prepare the agreement this afternoon.\n\nBest,\nElena",
        },
      ],
    },
    {
      id: "workshop",
      name: "Daniel Park",
      title: "Workshop agenda for next week",
      initials: "DP",
      color: "mint",
      unread: false,
      action: "Add your preferred topic before the agenda is finalised.",
      context: "The fictional workshop covers customer discovery, automation and delivery.",
      messages: [
        {
          id: "o2",
          name: "Daniel Park",
          time: "09:10",
          body: "Hello,\n\nHere’s the draft agenda for our workshop next week. We have time for one additional topic.\n\nIs there anything you’d particularly like the group to work through?\n\nThanks,\nDaniel",
        },
      ],
    },
    {
      id: "recap",
      name: "Mira Chen",
      title: "Notes from our planning session",
      initials: "MC",
      color: "violet",
      unread: false,
      action: "No immediate reply needed. Keep the decisions for the next planning session.",
      context: "This is an example recap with three decisions and a follow-up date.",
      messages: [
        {
          id: "o3",
          name: "Mira Chen",
          time: "Yesterday",
          body: "Hi,\n\nA short recap of today’s planning session:\n\n1. Start with the onboarding experience.\n2. Keep the first release focused.\n3. Review customer feedback together next Friday.\n\nLet me know if I missed anything.\n\nMira",
        },
      ],
    },
  ],
  skool: [
    {
      id: "maya",
      name: "Maya Turner",
      title: "Feedback on my first offer",
      initials: "MT",
      color: "rose",
      unread: true,
      action: "Give Maya feedback on the audience and outcome of her first offer.",
      context:
        "Maya is a fictional member in the Builders Circle demo community. She has finished the positioning lesson and is shaping her first offer.",
      messages: [
        {
          id: "k1",
          name: "Maya Turner",
          time: "10:12",
          body: "Hey! I finished the positioning lesson and finally wrote down my first offer 🙌",
        },
        {
          id: "k2",
          name: "You",
          mine: true,
          time: "10:14",
          body: "Love it. Who is it for, and what will they walk away with?",
        },
        {
          id: "k3",
          name: "Maya Turner",
          time: "10:16",
          body: "Small design studios. I help them turn client enquiries into a clear brief without spending hours going back and forth. Is that specific enough?",
        },
      ],
    },
    {
      id: "oscar",
      name: "Oscar Reed",
      title: "Our next community session",
      initials: "OR",
      color: "mint",
      unread: true,
      action: "Confirm whether a live build would be useful for the next session.",
      context:
        "Oscar is a fictional member suggesting a practical example for the next community session.",
      messages: [
        {
          id: "k4",
          name: "Oscar Reed",
          time: "09:22",
          body: "Would you consider doing a live build in the next community session? Seeing the decisions as you go would help me a lot.",
        },
      ],
    },
    {
      id: "isla",
      name: "Isla Morgan",
      title: "A small win to share",
      initials: "IM",
      color: "violet",
      unread: false,
      action: "Celebrate Isla’s progress. No urgent action is required.",
      context: "Isla is a fictional member sharing a milestone after completing the first project.",
      messages: [
        {
          id: "k5",
          name: "Isla Morgan",
          time: "Yesterday",
          body: "Small win: I shipped the first version today. I kept wanting to add more, but the three-step plan helped me finish. Thanks for the nudge!",
        },
        {
          id: "k6",
          name: "You",
          mine: true,
          time: "Yesterday",
          body: "That’s a great milestone. What did you learn from the first person who tried it?",
        },
      ],
    },
  ],
};

/** Standalone fictional previews. Never passed to operatorRequest, shared memory or assistant context. */
function ProviderPreview({ provider }: { provider: "gmail" | "slack" | "outlook" | "skool" }) {
  const isEmail = provider === "gmail" || provider === "outlook";
  const seed = PREVIEW_THREADS[provider === "gmail" ? "outlook" : provider];
  const key = `aos-inbox-demo-v1:${provider}`;
  const [threads, setThreads] = useState<PreviewThread[]>(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        Array.isArray(stored) &&
        stored.length === seed.length &&
        stored.every(
          (t: PreviewThread) =>
            seed.some((s) => s.id === t.id) &&
            typeof t.unread === "boolean" &&
            Array.isArray(t.messages) &&
            t.messages.every((m) => typeof m.body === "string" && typeof m.name === "string"),
        )
      )
        return stored;
    } catch {}
    return structuredClone(seed);
  });
  const [selected, setSelected] = useState(threads[0].id),
    [text, setText] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [context, setContext] = useState(false),
    [folder, setFolder] = useState("inbox"),
    [writing, setWriting] = useState(!isEmail),
    [ccOpen, setCcOpen] = useState(false),
    [bccOpen, setBccOpen] = useState(false),
    [cc, setCc] = useState(""),
    [bcc, setBcc] = useState("");
  const visible = threads.filter(
    (t) =>
      (!isEmail || (folder === "archive" ? t.archived : !t.archived)) &&
      `${t.name} ${t.title} ${t.messages.map((message) => message.body).join(" ")}`.toLowerCase().includes(search.toLowerCase()),
  );
  const thread = visible.find((t) => t.id === selected) || visible[0];
  const lastMessage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(threads));
    } catch {}
  }, [key, threads]);
  function choose(id: string) {
    setSelected(id);
    setText("");
    setContext(false);
    setWriting(!isEmail);
    setStatus("");
    setThreads((old) => old.map((t) => (t.id === id ? { ...t, unread: false } : t)));
  }
  function send() {
    if (!thread || !text.trim()) return;
    const message: PreviewMessage = {
      id: crypto.randomUUID(),
      name: "You",
      body: text.trim(),
      time: fmtTime(new Date()),
      mine: true,
    };
    setThreads((old) =>
      old.map((t) =>
        t.id === thread.id ? { ...t, unread: false, messages: [...t.messages, message] } : t,
      ),
    );
    setText("");
    setStatus("Demo reply added. Nothing was sent.");
    window.setTimeout(
      () => lastMessage.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      50,
    );
  }
  return (
    <section
      className={`wi-preview wi-preview-${provider} ${provider === "gmail" ? "wi-preview-outlook" : ""}`}
      aria-label={`${sourceName(provider)} demo workspace`}
    >
      {isEmail && (
        <div className="wi-outlook-command">
          <SourceLogo source={provider} />
          <strong>{sourceName(provider)}</strong>
          <span>Demo mailbox</span>
          <button
            onClick={() => {
              if (thread) setWriting(true);
            }}
          >
            <Mail size={15} />
            Reply
          </button>
          <button
            disabled={!thread}
            onClick={() => {
              if (thread) {
                setThreads((old) =>
                  old.map((t) => (t.id === thread.id ? { ...t, archived: !t.archived } : t)),
                );
                setStatus("Moved in this demo only.");
              }
            }}
          >
            <Archive size={15} />
            {folder === "archive" ? "Restore" : "Archive"}
          </button>
        </div>
      )}
      <div className="wi-preview-layout">
        {provider !== "skool" && (
          <aside className="wi-preview-rail">
            {provider === "slack" ? (
              <>
                <div className="wi-slack-workspace">
                  <strong>Northstar Studio</strong>
                  <ChevronDown size={15} />
                  <small>Fictional team workspace</small>
                </div>
                <div className="wi-preview-home">
                  <MessageSquare size={16} />
                  Conversations
                </div>
                <span className="wi-preview-group">Channels</span>
                {threads
                  .filter((t) => t.channel)
                  .map((t) => (
                    <button
                      key={t.id}
                      className={thread?.id === t.id ? "active" : ""}
                      onClick={() => choose(t.id)}
                    >
                      <Hash size={15} />
                      <span>{t.name}</span>
                      {t.unread && <i />}
                    </button>
                  ))}
                <span className="wi-preview-group">Direct messages</span>
                {threads
                  .filter((t) => !t.channel)
                  .map((t) => (
                    <button
                      key={t.id}
                      className={thread?.id === t.id ? "active" : ""}
                      onClick={() => choose(t.id)}
                    >
                      <span className={`wi-preview-avatar ${t.color}`}>{t.initials}</span>
                      <span>{t.name}</span>
                      {t.unread && <i />}
                    </button>
                  ))}
              </>
            ) : (
              <>
                <small>FAVOURITES</small>
                <button
                  className={folder === "inbox" ? "active" : ""}
                  onClick={() => setFolder("inbox")}
                >
                  <Inbox size={16} />
                  Inbox<span>{threads.filter((t) => !t.archived).length}</span>
                </button>
                <button
                  className={folder === "archive" ? "active" : ""}
                  onClick={() => setFolder("archive")}
                >
                  <Archive size={16} />
                  Archive<span>{threads.filter((t) => t.archived).length || ""}</span>
                </button>
                <div className="wi-preview-rail-note">
                  Your example mailbox.
                  <br />
                  All changes are local to this demo.
                </div>
              </>
            )}
          </aside>
        )}
        {provider !== "slack" && (
          <aside className="wi-preview-conversations">
            <header>
              {provider === "skool" ? (
                <>
                  <span className="wi-skool-word">skool</span>
                  <h2>Messages</h2>
                  <small>Builders Circle · demo community</small>
                </>
              ) : (
                <>
                  <h2>{folder === "archive" ? "Archive" : "Inbox"}</h2>
                  <small>
                    {provider === "gmail" ? "Primary" : "Focused"} <span>{provider === "gmail" ? "Updates" : "Other"}</span>
                  </small>
                </>
              )}
            </header>
            <label className="wi-preview-search">
              <Search size={15} />
              <input
                aria-label={`Search ${sourceName(provider)} demo`}
                placeholder="Search conversations"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div>
              {visible.map((t) => (
                <button
                  className={`wi-preview-conversation ${thread?.id === t.id ? "active" : ""}`}
                  key={t.id}
                  onClick={() => choose(t.id)}
                >
                  <span className={`wi-preview-avatar ${t.color}`}>{t.initials}</span>
                  <span>
                    <strong>{t.name}</strong>
                    {isEmail && <b>{t.title}</b>}
                    <small>{t.messages.at(-1)?.body.replace(/\s+/g, " ")}</small>
                  </span>
                  {t.unread && <i />}
                </button>
              ))}
            </div>
          </aside>
        )}
        {thread ? (
          <div className="wi-preview-thread">
            <header className="wi-preview-thread-heading">
              <div>
                {provider === "slack" ? (
                  <h2>
                    {thread.channel ? (
                      <Hash size={21} />
                    ) : (
                      <span className={`wi-preview-avatar ${thread.color}`}>{thread.initials}</span>
                    )}
                    {thread.name}
                  </h2>
                ) : provider === "skool" ? (
                  <h2>
                    <span className={`wi-preview-avatar ${thread.color}`}>{thread.initials}</span>
                    {thread.name}
                  </h2>
                ) : (
                  <h2>{thread.title}</h2>
                )}
                <p>
                  {provider === "slack"
                    ? thread.channel
                      ? "Launch plans and decisions from your team."
                      : "Direct message · fictional teammate"
                    : provider === "skool"
                      ? "Community member · demo conversation"
                      : "Example email · fictional sender"}
                </p>
              </div>
              <button
                aria-label={thread.unread ? "Mark read in demo" : "Mark unread in demo"}
                title={thread.unread ? "Mark read in demo" : "Mark unread in demo"}
                onClick={() =>
                  setThreads((old) =>
                    old.map((t) => (t.id === thread.id ? { ...t, unread: !t.unread } : t)),
                  )
                }
              >
                {thread.unread ? <MailOpen size={17} /> : <Mail size={17} />}
              </button>
            </header>
            <div className="wi-preview-next-step">
              <span>EXAMPLE NEXT STEP</span>
              <p>{thread.action}</p>
              <button onClick={() => setContext(!context)} aria-expanded={context}>
                {context ? "Hide context" : "Why this matters"}
                <ChevronDown size={12} />
              </button>
              {context && <div>{thread.context}</div>}
            </div>
            <div className="wi-preview-transcript" role="log" aria-label="Demo conversation">
              <span className="wi-preview-day">Demo conversation</span>
              {thread.messages.map((m) => (
                <article key={m.id} className={`wi-preview-message ${m.mine ? "mine" : ""}`}>
                  {isEmail ? (
                    <div className="wi-outlook-message-sender">
                      <span className={`wi-preview-avatar ${m.mine ? "blue" : thread.color}`}>
                        {m.mine ? "YO" : thread.initials}
                      </span>
                      <strong>
                        {m.name}
                        <small>
                          {m.mine
                            ? "to fictional recipient"
                            : `${thread.name.toLowerCase().replace(/\s/g, ".")}@example.test`}
                        </small>
                      </strong>
                      <time>{m.time}</time>
                    </div>
                  ) : provider === "slack" ? (
                    <span className={`wi-preview-avatar ${m.mine ? "blue" : thread.color}`}>
                      {m.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .slice(0, 2)}
                    </span>
                  ) : null}
                  <div>
                    {provider === "slack" && (
                      <header>
                        <strong>{m.name}</strong>
                        <time>{m.time}</time>
                      </header>
                    )}
                    <p>{m.body}</p>
                    {provider === "skool" && (
                      <time>
                        {m.time}
                        {m.mine && <Check size={10} />}
                      </time>
                    )}
                  </div>
                </article>
              ))}
              <div ref={lastMessage} />
            </div>
            {isEmail && !writing ? (
              <div className="wi-demo-reply-actions">
                <button onClick={() => setWriting(true)}>
                  <Reply size={16} />
                  Reply
                </button>
                <button
                  onClick={() => {
                    setWriting(true);
                    setCcOpen(true);
                  }}
                >
                  <Users size={16} />
                  Reply all
                </button>
              </div>
            ) : (
              <form
                className={`wi-preview-compose ${isEmail ? "is-email" : ""}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                {isEmail && (
                  <>
                    <div className="wi-demo-recipients">
                      <Reply size={16} />
                      <span>To {thread.name.toLowerCase().replace(/\s/g, ".")}@example.test</span>
                      <button type="button" onClick={() => setCcOpen(!ccOpen)}>
                        Cc
                      </button>
                      <button type="button" onClick={() => setBccOpen(!bccOpen)}>
                        Bcc
                      </button>
                    </div>
                    {ccOpen && (
                      <label className="wi-demo-recipients">
                        Cc
                        <input
                          aria-label="Demo Cc"
                          value={cc}
                          onChange={(e) => setCc(e.target.value)}
                          placeholder="Fictional recipients"
                        />
                      </label>
                    )}
                    {bccOpen && (
                      <label className="wi-demo-recipients">
                        Bcc
                        <input
                          aria-label="Demo Bcc"
                          value={bcc}
                          onChange={(e) => setBcc(e.target.value)}
                          placeholder="Fictional recipients"
                        />
                      </label>
                    )}
                  </>
                )}
                <textarea
                  aria-label={`Reply in ${sourceName(provider)} demo`}
                  placeholder={
                    provider === "slack"
                      ? `Message ${thread.channel ? "# " : ""}${thread.name}…`
                      : provider === "skool"
                        ? "Write a message…"
                        : "Write your reply…"
                  }
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <footer>
                  <span>{status || "Demo only · replies are not sent"}</span>
                  <button type="submit" disabled={!text.trim()}>
                    <Send size={15} />
                    <span>Send demo reply</span>
                  </button>
                </footer>
              </form>
            )}
          </div>
        ) : (
          <div className="wi-preview-no-results">
            <Mail size={28} />
            <h3>No conversations here</h3>
            <p>Choose a different folder or search.</p>
          </div>
        )}
      </div>
    </section>
  );
}

type SkoolMessage = {
  id: string;
  content: string;
  createdAt: string;
  senderId: string;
  fromSelf: boolean;
  attachmentCount: number;
};
type SkoolChannel = {
  id: string;
  name: string;
  avatar?: string;
  lastMessage: SkoolMessage | null;
  updatedAt: string;
  unread: boolean;
  unreadCount: number;
  originalUrl: string;
  messages?: SkoolMessage[];
  hasMoreBefore?: boolean;
};
type SkoolSendRecord = {
  requestId: string;
  channelId: string;
  contentHash: string;
  status: "sent" | "failed" | "uncertain";
  createdAt: string;
  finishedAt?: string;
  messageId?: string;
  error?: string;
};
type SkoolSendResult = {
  status: "sent" | "failed" | "uncertain";
  requestId: string;
  channelId: string;
  messageId?: string;
  message?: SkoolMessage;
  channel?: SkoolChannel;
  error?: string;
  duplicate?: boolean;
  retryable: boolean;
};
type SkoolStatus = {
  error?: string;
  id: "skool";
  configured: boolean;
  connected: boolean;
  lastSync?: string;
  count: number;
  hasMore: boolean;
  nextOffset: number;
  readOnly: boolean;
  capabilities?: { read: boolean; send: boolean; markRead: false };
  sendRequests?: SkoolSendRecord[];
  channels: SkoolChannel[];
};
function SkoolAvatar({ channel }: { channel: SkoolChannel }) {
  const [failed, setFailed] = useState(false);
  return channel.avatar?.startsWith("https://") && !failed ? (
    <img
      className="wi-preview-avatar wi-skool-real-avatar"
      src={channel.avatar}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="wi-preview-avatar violet">
      {channel.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)}
    </span>
  );
}
function SkoolMailbox({
  status,
  loading,
  error,
  initialChannelId,
}: {
  status?: SkoolStatus;
  loading: boolean;
  error?: string;
  initialChannelId?: string;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState(""),
    [thread, setThread] = useState<SkoolChannel | null>(null),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [threadBusy, setThreadBusy] = useState(false),
    [failure, setFailure] = useState("");
  const [skoolSession, setSkoolSession] = useState("");
  async function connectSession() {
    if (syncLock.current || !skoolSession.trim()) return;
    syncLock.current = true;
    setBusy(true);
    setFailure("");
    try {
      const data = await operatorRequest<SkoolStatus>("/connections/skool/connect", { session: skoolSession });
      setSkoolSession("");
      client.setQueryData(["operator-skool"], data);
      void client.invalidateQueries({ queryKey: ["operator-skool-status"] });
      void client.invalidateQueries({ queryKey: ["operator-state"] });
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      syncLock.current = false;
      setBusy(false);
    }
  }
  const openedInitial = useRef("");
  useEffect(() => {
    if (
      initialChannelId &&
      initialChannelId !== openedInitial.current &&
      status?.channels?.some((c) => c.id === initialChannelId)
    ) {
      openedInitial.current = initialChannelId;
      void loadThread(initialChannelId);
    }
  }, [initialChannelId, status?.channels]);
  const syncLock = useRef(false),
    threadRequest = useRef(0),
    selectedRef = useRef("");
  selectedRef.current = selected;
  const channels = (status?.channels || []).filter((c) =>
    `${c.name} ${c.lastMessage?.content || ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const active = thread?.id === selected ? thread : channels.find((c) => c.id === selected);
  async function sync(more = false) {
    if (syncLock.current) return;
    syncLock.current = true;
    setBusy(true);
    setFailure("");
    try {
      const data = await operatorRequest<SkoolStatus>("/connections/skool/sync", { more });
      client.setQueryData(["operator-skool"], data);
      if (!more && selectedRef.current) await loadThread(selectedRef.current);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      syncLock.current = false;
      setBusy(false);
    }
  }
  async function loadThread(id: string, older = false) {
    setSelected(id);
    const request = ++threadRequest.current;
    setThreadBusy(true);
    setFailure("");
    try {
      const result = await operatorRequest<{ channel: SkoolChannel }>("/connections/skool/thread", {
        id,
        older,
      });
      if (request === threadRequest.current) setThread(result.channel);
    } catch (e) {
      if (request === threadRequest.current) setFailure((e as Error).message);
    } finally {
      if (request === threadRequest.current) setThreadBusy(false);
    }
  }
  // No timed POST /connections/skool/sync (T8b: /inbox makes no automatic writes). The Skool status
  // query already re-reads (GET) every 30 s; fetching new conversations is the refresh button.
  const messages = active?.messages || (active?.lastMessage ? [active.lastMessage] : []);
  return (
    <section className="wi-preview wi-preview-skool wi-skool-live" aria-label="Skool conversations">
      {!loading && !status?.connected && <form className="wi-skool-connect" onSubmit={event => { event.preventDefault(); void connectSession(); }}>
        <div><strong>Connect your Skool session</strong><p>Load your real conversations and profile photos, and reply from here.</p></div>
        <label htmlFor="skool-session">Skool session token</label>
        <div className="wi-skool-connect-fields">
          <input id="skool-session" type="password" autoComplete="off" spellCheck={false} disabled={busy} value={skoolSession} onChange={event => setSkoolSession(event.target.value)} placeholder="Paste auth_token or the session cookie" />
          <button type="submit" disabled={busy || !skoolSession.trim()}>{busy ? "Verifying…" : "Connect Skool"}</button>
        </div>
        <details><summary>Where to find it</summary><p>In your signed-in Skool tab, open Developer Tools → Application → Cookies → https://www.skool.com. Copy the value of auth_token into the field above. The connection is verified with Skool before it is saved privately on this Mac.</p></details>
      </form>}
      <div className="wi-skool-live-toolbar">
        <span className={`wi-status-dot ${status?.connected ? "is-connected" : ""}`} />
        <p>
          {status?.lastSync
            ? `Updated ${fmtDateTime(new Date(status.lastSync))}`
            : status?.connected
              ? "Connected to Skool"
              : loading
                ? "Checking Skool connection…"
                : "Connect Skool to load conversations"}
          <small>
            <strong>{(status?.count || 0).toLocaleString()} loaded</strong> ·{" "}
            {status?.capabilities?.send ? "Replies enabled" : "Read-only access"}
          </small>
        </p>
        {status?.hasMore && (
          <button
            className="wi-skool-more-prominent"
            disabled={busy}
            onClick={() => void sync(true)}
          >
            Load more
            <ChevronDown size={14} />
          </button>
        )}
        <button disabled={busy || !status?.configured} onClick={() => void sync()}>
          <RefreshCw size={14} className={busy ? "wi-spinning" : ""} />
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <a href="https://www.skool.com/chat" target="_blank" rel="noreferrer">
          Open Skool
          <ArrowUpRight size={13} />
        </a>
      </div>
      {(failure || error || status?.error) && (
        <Notice tone="danger">{failure || error || status?.error}</Notice>
      )}
      <div className="wi-preview-layout">
        <aside className="wi-preview-conversations">
          <header>
            <span className="wi-skool-word">skool</span>
            <h2>Messages</h2>
            <small>Your community conversations</small>
          </header>
          <label className="wi-preview-search">
            <Search size={15} />
            <input
              aria-label="Search Skool messages"
              placeholder="Search people and messages"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div>
            {channels.map((c) => (
              <button
                key={c.id}
                className={`wi-preview-conversation ${selected === c.id ? "active" : ""}`}
                onClick={() => void loadThread(c.id)}
              >
                <SkoolAvatar channel={c} />
                <span>
                  <strong>{c.name}</strong>
                  <small>
                    {c.lastMessage?.fromSelf ? "You: " : ""}
                    {c.lastMessage?.content ||
                      (c.lastMessage?.attachmentCount ? "Attachment" : "Conversation")}
                  </small>
                </span>
                {c.unread && <i title={`${c.unreadCount || 1} unread in Skool`} />}
              </button>
            ))}
          </div>
          {status?.hasMore && (
            <button className="wi-skool-load" disabled={busy} onClick={() => void sync(true)}>
              Load more conversations
              <ChevronDown size={13} />
            </button>
          )}
        </aside>
        {active ? (
          <div className="wi-preview-thread">
            <header className="wi-preview-thread-heading">
              <div>
                <h2>
                  <SkoolAvatar key={active.id} channel={active} />
                  {active.name}
                </h2>
                <p>
                  {active.unread ? "Unread in Skool" : "Conversation in Skool"} · Opening here does
                  not change read status
                </p>
              </div>
            </header>
            <div className="wi-preview-transcript">
              {threadBusy && (
                <div className="wi-skool-loading">
                  <Busy />
                  Loading conversation…
                </div>
              )}
              {active.hasMoreBefore && (
                <button
                  className="wi-skool-load"
                  disabled={threadBusy}
                  onClick={() => void loadThread(active.id, true)}
                >
                  Load older messages
                  <ChevronDown size={13} />
                </button>
              )}
              {messages.map((m) => (
                <article className={`wi-preview-message ${m.fromSelf ? "mine" : ""}`} key={m.id}>
                  <div>
                    <p>
                      {m.content ||
                        (!m.attachmentCount ? "Message content is available in Skool." : "")}
                    </p>
                    {m.attachmentCount > 0 && (
                      <a
                        className="wi-skool-attachment"
                        href={active.originalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.attachmentCount} attachment{m.attachmentCount === 1 ? "" : "s"} · View in
                        Skool
                        <ArrowUpRight size={11} />
                      </a>
                    )}
                    <time>
                      {fmtDateTime(new Date(m.createdAt))}
                    </time>
                  </div>
                </article>
              ))}
            </div>
            <SkoolReplyComposer
              key={active.id}
              channel={active}
              status={status}
              loading={threadBusy}
              onSent={(result) => {
                if (selectedRef.current === active.id) {
                  if (result.channel) setThread(result.channel);
                  else void loadThread(active.id);
                }
                void client.invalidateQueries({ queryKey: ["operator-skool"] });
                void client.invalidateQueries({ queryKey: ["operator-state"] });
              }}
            />
          </div>
        ) : (
          <div className="wi-preview-no-results">
            <MessageSquare size={34} />
            <h3>
              {loading
                ? "Loading your conversations…"
                : channels.length
                  ? "Your conversations, together."
                  : "No conversations loaded yet"}
            </h3>
            <p>
              {channels.length
                ? "Choose a person to read the conversation."
                : status?.configured
                  ? "Refresh Skool to load your messages."
                  : "Your real Skool conversations will appear after connecting."}
            </p>
            <span className="wi-skool-readonly">
              {status?.capabilities?.send ? "Read and reply" : "Read-only"} · Refreshes every 60
              seconds while this page is visible
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

type SkoolReplyDraft = {
  content: string;
  attempt?: {
    requestId: string;
    content: string;
    status: "pending" | "sent" | "failed" | "uncertain";
    error?: string;
  };
  reviewed: string[];
};
function SkoolReplyComposer({
  channel,
  status,
  loading,
  onSent,
}: {
  channel: SkoolChannel;
  status?: SkoolStatus;
  loading: boolean;
  onSent: (result: SkoolSendResult) => void;
}) {
  const key = `agentic-skool-reply-v1:${channel.id}`;
  const [draft, setDraft] = useState<SkoolReplyDraft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null") as SkoolReplyDraft | null;
      if (saved && typeof saved.content === "string" && Array.isArray(saved.reviewed))
        return {
          ...saved,
          attempt:
            saved.attempt?.status === "pending"
              ? {
                  ...saved.attempt,
                  status: "uncertain",
                  error:
                    "The page closed before delivery was confirmed. Check the conversation in Skool.",
                }
              : saved.attempt,
        };
    } catch {}
    return { content: "", reviewed: [] };
  });
  const [storageError, setStorageError] = useState("");
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const current = useRef(draft);
  current.current = draft;
  const unresolved = status?.sendRequests?.find(
    (r) =>
      r.channelId === channel.id &&
      r.status === "uncertain" &&
      r.requestId !== draft.attempt?.requestId &&
      !draft.reviewed.includes(r.requestId),
  );
  const uncertain = draft.attempt?.status === "uncertain" || !!unresolved;
  const canSend = status?.connected === true && status.capabilities?.send === true;
  function storeDraft(next: SkoolReplyDraft) {
    current.current = next;
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError("");
      return true;
    } catch {
      setStorageError(
        "Your draft could not be saved in this browser. Enable browser storage before sending.",
      );
      return false;
    }
  }
  useEffect(() => {
    const attempt = current.current.attempt;
    const result =
      attempt &&
      status?.sendRequests?.find(
        (r) => r.requestId === attempt.requestId && r.channelId === channel.id,
      );
    if (
      !result ||
      lock.current ||
      (attempt?.status === result.status && attempt.error === result.error)
    )
      return;
    storeDraft({
      ...current.current,
      content: result.status === "sent" ? "" : current.current.content,
      attempt: { ...attempt!, status: result.status, error: result.error },
    });
  }, [status?.sendRequests, channel.id]);
  async function send() {
    const before = current.current;
    if (lock.current || uncertain || !canSend || loading || !before.content.trim()) return;
    const content = before.content.trim();
    if (content.length > 10000) return;
    const requestId = crypto.randomUUID();
    const next: SkoolReplyDraft = { ...before, attempt: { requestId, content, status: "pending" } };
    if (!storeDraft(next)) return;
    lock.current = true;
    setSending(true);
    try {
      const result = await operatorRequest<SkoolSendResult>("/connections/skool/send", {
        id: channel.id,
        content,
        requestId,
      });
      if (
        result.requestId !== requestId ||
        result.channelId !== channel.id ||
        !["sent", "failed", "uncertain"].includes(result.status)
      )
        throw new Error(
          "Delivery could not be confirmed. Check this conversation in Skool before trying again.",
        );
      storeDraft({
        ...next,
        content: result.status === "sent" ? "" : content,
        attempt: { requestId, content, status: result.status, error: result.error },
      });
      if (result.status === "sent") onSent(result);
    } catch (e) {
      storeDraft({
        ...next,
        content,
        attempt: { requestId, content, status: "uncertain", error: (e as Error).message },
      });
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  function startAfterReview() {
    const ids = [draft.attempt?.requestId, unresolved?.requestId].filter(
      (id): id is string => !!id,
    );
    storeDraft({ content: "", reviewed: [...new Set([...draft.reviewed, ...ids])] });
  }
  return (
    <form
      className="wi-skool-compose"
      aria-label="Reply to Skool conversation"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="wi-skool-compose-heading">
        <span>
          <Reply size={15} />
          Reply to {channel.name}
        </span>
        <a href={channel.originalUrl} target="_blank" rel="noreferrer">
          Open in Skool
          <ArrowUpRight size={13} />
        </a>
      </div>
      {uncertain && (
        <div className="wi-skool-send-notice uncertain" role="status">
          <strong>Delivery is unconfirmed.</strong>
          <p>
            {draft.attempt?.error || unresolved?.error || "An earlier send has not been confirmed."}{" "}
            Your message will not be sent again automatically.
          </p>
          <a href={channel.originalUrl} target="_blank" rel="noreferrer">
            Check the conversation in Skool
            <ArrowUpRight size={13} />
          </a>
          <button type="button" onClick={startAfterReview}>
            I checked Skool — start a new reply
          </button>
        </div>
      )}
      {draft.attempt?.status === "failed" && !uncertain && (
        <div className="wi-skool-send-notice" role="status">
          <strong>Message was not sent.</strong>
          <p>{draft.attempt.error || "Skool declined this message."} You can edit it and retry.</p>
        </div>
      )}
      {draft.attempt?.status === "sent" && !uncertain && (
        <div className="wi-skool-send-confirmed" role="status">
          <Check size={14} />
          Sent to Skool
        </div>
      )}
      <textarea
        aria-label="Reply in Skool"
        placeholder={canSend ? "Write a reply…" : "Connect Skool to reply here…"}
        value={draft.content}
        maxLength={10000}
        disabled={sending || uncertain || !canSend}
        onChange={(e) =>
          storeDraft({
            ...draft,
            content: e.target.value,
            attempt: draft.attempt?.status === "sent" ? undefined : draft.attempt,
          })
        }
      />
      {storageError && (
        <p className="wi-skool-send-storage" role="status">
          {storageError}
        </p>
      )}
      <footer>
        <span>
          {sending
            ? "Sending once. Please wait…"
            : !canSend
              ? "Sending is unavailable for this connection. Use Open in Skool."
              : uncertain
                ? "Check delivery before writing another reply."
                : "Sends directly to this Skool conversation."}
        </span>
        <button
          type="submit"
          disabled={sending || uncertain || !canSend || loading || !draft.content.trim()}
        >
          {sending ? <Busy /> : <Send size={15} />}{" "}
          {sending ? "Sending…" : draft.attempt?.status === "failed" ? "Retry send" : "Send"}
        </button>
      </footer>
    </form>
  );
}
