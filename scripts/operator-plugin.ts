import { setOwnServerPort } from "../src/lib/money-policy";
import { loopbackJson } from "./workspace/sources";
import { businessDemoSettings } from "./business-demo-settings";
import { privateAdvisorStatus, runPrivateAdvisor } from "./private-advisor";
import { mailArchive } from "./mail-archive";
import { createMailSync } from "./mail-sync";
import { mailProvider } from "./mail-provider";
import { createPhotoIndex } from "./photo-index";
import { extractChatAttachment } from "./chat-attachments";
import { workspaceProfile } from "./workspace-profile";
import { privacyPaneAction, setupDiscovery } from "./setup-discovery";
import { openAIVoice } from "./openai-voice";
import { freeVoice as freeVoiceEngine } from "./free-voice";
import { codingVoiceFor, codingRuntime } from "./coding/plugin";
import { createCodingCommandEntry } from "./coding/command-entry";
import { claudeBridge } from "./claude-bridge";
import { clineBridge } from "./cline-bridge";
import { pageTokenMatches, requestPrincipal } from "./identity/gate";
import { authorise, isAtHub, isBrowserPrincipal, type Resource as IdentityResource } from "./identity/principal";
import { modelFleetReceiptSink, modelFleetReceiptRoute } from "./model-fleet/receipt-sink";
import { modelRouterRoute } from "./model-router/api";
import { createClaudeVision, createPointEyes } from "./claude-vision";
import { refreshCapabilities } from "./capability-registry";
import { serialRefresher } from "./serial-refresh";
import { tailnetPerson } from "./remote-access";
import { hubRole } from "./cloud/hub-role";
import { operatorRemoteRefusal, operatorSiteClass, serverWorkAllowed } from "./identity/operator-sites";
import type { MemoryVoiceTurn } from "./memory/voice-turn";
import type { Principal as MemoryPrincipal } from "./memory/types";
import { createDevicesService } from "./devices/service";
import { mountComputers } from "./computers/plugin";
import { mountActivityStream } from "./events/plugin";
import { computerCommand } from "./computers/jarvis";
import { withComputerResolution } from "./jarvis-command/computer-target";
import { wireThreadNotices } from "./jarvis-command/thread-notify";
import { readShorthand } from "./shorthand";
import { readJarvisSettings, writeJarvisSettings } from "./jarvis-settings";
import { connectedGranolaNotes } from "./granola-connected";
import { connectedNotionPages } from "./notion-connected";
import { granolaApi } from "./granola-api";
import { agentJobs } from "./agent-jobs";
import { agentJobsRoute } from "./agent-jobs-route";
import { hasVerifiedUiSession } from "./approvals/principal";
import { voiceLocalImages } from "./voice-local-images";
import { voiceImages } from "./voice-images";
import { voiceRecentCreations } from "./voice-recent-creations";
import { voiceRecentEmails } from "./voice-recent-emails";
import { voiceMemory } from "./voice-memory";
import { conversationStore, ConversationConflict, ConversationForbidden } from "./conversations";
import { createAutomationsApi } from "./automations";
import { mountTriggers } from "./triggers/mount";
import { createLeadsApi, LocalOnly } from "./leads/api";
import { saveDecision } from "./workspace/decisions";
import { meetingService } from "./meeting-mode/service";
import { createJarvisEvents } from "./jarvis-events";
import { createInboxTriage } from "./inbox-triage/service";
import { showWindowsToast } from "./windows/jarvis-toast";
import { createJarvisSkills, type JarvisSkills } from "./jarvis-skills";
import { openedWhereLine } from "./jarvis-skills/windows";
import { parseLiveChats } from "./jarvis-skills/agent-watch";
import { createStatusCache, type CalendarItem, type NextCall } from "./jarvis-status";
import { createJarvisProtocols } from "./jarvis-protocols";
import { voiceCompanion } from "./voice-companion";
import { memoryApps, type ImportedParts } from "./memory-apps";
import { memoryVault } from "./memory-vault";
import { memoryPhotos, readMemoryPhoto, saveMemoryPhoto } from "./memory-photos";
import { readBrainPreferences, writeBrainPreferences } from "./brain-preferences";
import { createStateCache, filesStamp } from "./workspace-state-cache";
import { FINANCE_MEMORY_ID, businessMemoryDocuments, businessEvidence } from "./business-memory";
import { readWikiFacts } from "./business-wiki-facts";
import { resolveMemorySettings } from "./memory/settings";
import { sourcedFinanceSummaries } from "./finance/manual-sourced";
import { memorySpaces } from "../src/lib/operator";
import {
  localMemoryFiles,
  readLocalMemories,
  imageFile,
  imageOCRAvailable,
  readImageOnCPU,
  fetchNotionPage,
  emailText,
} from "./memory-imports";
import {
  BRAIN_SOURCES,
  brainEnabled,
  sourceOrigin,
  nodeOrigin,
  brainContext,
} from "../src/lib/brain-sources";
import { accountConnections } from "./account-connections";
import { nativeConnectionDiscovery } from "./native-connection-discovery";
import { nativeInboxSync } from "./native-inbox-sync";
import { nativeCalendarSync } from "./native-calendar-sync";
import { calendarHealthReader, startCalendarBackgroundSync } from "./calendar-health";
import { nativeBusinessSync } from "./native-business-sync";
import { createFinanceSync } from "./finance/sync";
import { handleLegacyNabRoute } from "./finance/legacy-admission";
import { createStripeSync } from "./finance/stripe";
import { skoolMessages as createSkoolMessages } from "./skool-messages";
import { importInboxSnapshot } from "./inbox-imports";
import { inboxQuestions } from "./inbox-questions";
import { inboxQuestionModelAvailable, generateInboxQuestionAnswer } from "./inbox-question-model";
import { updateSkoolInboxPreviews } from "./skool-inbox-preview";
import { businessWorkspace } from "./business-workspace";
import { mirrorRunLog } from "./jobs/mirror-run-log";
import { jobsRuntime } from "./jobs/runtime";
import { businessGoalContext } from "../src/lib/business-goal-context";
import { appDisplayName, chatAppFocus, chatTimeWindow, closestRecordLabel, recordActivityRange, recordApp, recordMatchesApp, sameDayDistance, type ChatAppFocus, type ChatTimeWindow } from "../src/lib/chat-retrieval-routing";
import { isOperatorSelfPath, isOperatorSelfTranscript } from "../src/lib/memory-self-filter";
import { discoverBusinessIntegrations, syncBusinessIntegration, configureYouTubeChannel } from "./business-integrations";
import { businessContent } from "./business-content";
import { competitorWatch } from "./competitor-watch";
import { briefModelSettings, businessBrief, checkedBriefModelKey } from "./business-brief";
import { generateBusinessBrief } from "./business-brief-generation";
import { act as browserAct, jarvisChromePid, openInJarvisChrome, parseActRequest } from "./browser-hands";
import { createScreenHands, parseScreenRequest } from "./screen-hands";
import { entryFor, lessonRoute } from "./screen-hands/routes";
import { commandRoute } from "./jarvis-command/route";
import { createLiveCommandService } from "./jarvis-command/live";
import { createJobThreads } from "./jarvis-command/threads";
import { codingSnapshotOf } from "./jarvis-command/coding-snapshot";
import { receptionistSnapshot } from "./receptionist/plugin";
import { awayVoiceIntent } from "./away-mode/policy";
import { createAwayService } from "./away-mode/service";
import { quickActionsRoute } from "./quick-actions";
import { skillDraftsRoute } from "./meeting-mode/narrate-api";
import { handleNarrateCall, narrateFullService } from "./meeting-mode/narrate-service";
import { providerKey } from "./provider-config";
import { warmHermes } from "./hermes-api";
import { jevShim } from "./jev-hermes";
import { controlDispatchGate } from "./jarvis-execution/server-approval";
import { controlExecution } from "./jarvis-execution/runtime";
import { controlReceiptRoute } from "./jarvis-execution/routes";
import { parsePcRequest, pcAct, startApps } from "./pc-hands";
import { backgroundJobsDisabled } from "./preview-guard";
import { cadAct, parseCadRequest } from "./cad-hands";
import { describeScreen, parseVisionRequest } from "./vision";
import { businessToday, cityFromTimeZone } from "./business-today";
import { findMemoryFiles, allowedMemoryFile, BANK_EXPORT_REFUSAL } from "./local-memory-search";
import { looksLikeBankTransactions } from "./finance/manual-nab-csv";
import { basename } from "node:path";
import { assistantCatalog, peekAssistantCatalog, runAssistant } from "./assistant-adapters";
import type { Plugin } from "vite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import ical from "node-ical";
import type { OperatorState, MemorySource, InboxItem, CalendarEvent } from "../src/lib/operator";
import { auditDir, createAuditLog } from "./control-audit";
import { operatorErrorStatus, operatorSettingsError, PayloadTooLarge } from "./http/operator-checks";
import { dataDirFor } from "./cloud/data-dir";

const runFile = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
const now = () => new Date().toISOString();
const text = (v: unknown, max = 1000000) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const digest = (s: string) => createHash("sha256").update(s.trim()).digest("hex");
const id = () => randomUUID();
export function privateAddress(ip: string): boolean {
  if (ip.includes(":")) return /^(::|fe[89ab]|f[cd]|2001:db8)/i.test(ip);
  const p = ip.split(".").map(Number);
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}
export async function fetchPublic(
  raw: string,
  redirects = 0,
): Promise<{ body: string; url: string; type: string }> {
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["443", "80"].includes(url.port))
  )
    throw new Error("Use a public HTTP or HTTPS article URL.");
  if (/localhost|\.local$|\.internal$/i.test(url.hostname))
    throw new Error("Private network addresses cannot be imported.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new Error("Private network addresses cannot be imported.");
  const address = addresses[0];
  return new Promise((accept, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        headers: {
          "User-Agent": "OperatorOS/1.0 ArticleReader",
          Accept: "text/html,text/plain,application/json",
        },
        lookup: ((_hostname: any, options: any, callback: any) =>
          options?.all
            ? callback(null, [address])
            : callback(null, address.address, address.family)) as any,
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirects >= 4) return reject(new Error("This link redirected too many times."));
          fetchPublic(new URL(response.headers.location, url).href, redirects + 1).then(
            accept,
            reject,
          );
          return;
        }
        if (!response.statusCode || response.statusCode >= 400) {
          response.resume();
          reject(
            new Error(`The source returned HTTP ${response.statusCode}. Paste its text instead.`),
          );
          return;
        }
        const type = response.headers["content-type"] || "";
        if (!/text\/|json|xml/.test(type)) {
          response.resume();
          reject(new Error("Download this document and use Upload file to import it."));
          return;
        }
        let body = "",
          size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > LIMIT) request.destroy(new Error("This page is too large to import."));
          else body += chunk;
        });
        response.on("end", () => accept({ body, type, url: url.href }));
        response.on("error", reject);
      },
    );
    request.setTimeout(20000, () =>
      request.destroy(new Error("The source timed out. Paste its text or try again.")),
    );
    request.on("error", reject);
    request.end();
  });
}
export function articleText(html: string, url: string) {
  const { document } = parseHTML(html);
  document
    .querySelectorAll("script,style,nav,footer,header,noscript,svg")
    .forEach((n) => n.remove());
  const article = new Readability(document as any).parse();
  const title = article?.title || document.title || new URL(url).hostname;
  const content =
    article?.textContent ||
    document.querySelector("main,article")?.textContent ||
    document.body?.textContent ||
    "";
  return {
    title,
    text: content
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim()
      .slice(0, 600000),
  };
}
/** One /search hit. `appMatch` is false only when the question named another app.
 * `recent` marks the named app's records from the last 7 days when no window was set. */
export type MemorySearchHit = {
  inWindow: boolean;
  appMatch: boolean;
  sameDay: boolean;
  recent: boolean;
  id: string;
  title: string;
  collection: string;
  origin: string;
  /** The memory app the record came from (codex, claude, gmail…), or null for notes. */
  app: string | null;
  /** When the underlying activity happened, from the sync stamp or a dated name. */
  activityAt?: string;
  connector?: { provider: string };
  url?: string;
  image?: MemorySource["image"];
  imageUrl?: string;
  thumbnailUrl?: string;
  extraction?: MemorySource["extraction"];
  score: number;
  excerpt: string;
  updatedAt: string;
};
export type MemorySearch = {
  results: MemorySearchHit[];
  /** Apps the question named; their records rank first and other apps' records are dropped once one matches. */
  focus: ChatAppFocus[];
  /** The nearest same-day record when the named window holds none, e.g. "12:31 Codex session". */
  closest?: { id: string; title: string; label: string };
  /** Ready records per memory app across the whole library, for the "Checked" line. */
  appRecords: Record<string, number>;
};
const RECENT_WINDOW = 7 * 24 * 60 * 60 * 1000;
// Words that describe asking an app rather than a topic. A question made only of
// these and app names ("How about Claude?", "what did I say to Codex") is about the
// app's recent activity, so its last 7 days rank first. Any other word ("Hermes
// design", "invoice") makes it a topic search where recency is only a tiebreak.
const GENERIC_TERMS = new Set([
  "how", "did", "do", "does", "say", "said", "tell", "told", "talk", "talked", "ask", "asked", "work", "worked", "working",
  "use", "used", "using", "session", "sessions", "conversation", "conversations", "chat", "chats", "recent", "recently",
  "latest", "last", "earlier", "today", "yesterday", "morning", "afternoon", "evening", "tonight", "week", "time", "times",
  "same", "thing", "things", "just", "now", "then", "also", "again", "there", "here", "was", "were", "been", "has", "had",
  "any", "all", "some", "something", "anything", "which", "who", "why", "one", "ones", "stuff", "memory", "memories",
  "record", "records", "in", "on", "at", "to", "of", "me", "my", "you", "we", "us", "it", "its", "those", "these", "them",
  "they", "bro", "hey", "hi", "hello",
  "codex", "claude", "hermes", "gmail", "outlook", "slack", "notion", "granola", "obsidian", "chatgpt",
]);
/** Keyword search over ready sources. A dated question ranks records from that
 * window first, then the nearest same-day records; a named app ranks its own
 * records first, and without a window its records from the last 7 days come
 * before older ones. Among equal scores dated records beat undated ones and
 * newer activity beats older. The OS's own check and runtime transcripts never appear.
 * `options.focus` carries a follow-up's inherited app; `options.now` fixes the clock for tests. */
export function searchMemory(
  sources: MemorySource[],
  query: string,
  collection?: string,
  window?: ChatTimeWindow | null,
  options: { focus?: ChatAppFocus[]; now?: number } = {},
): MemorySearch {
  const lower = query.toLowerCase();
  const now = options.now ?? Date.now();
  // A token with punctuation ("rollout-2026-09-18T12-31") is a phrase: the exact
  // title match must beat records that merely repeat its digits.
  const phrases = [...new Set(lower.split(/\s+/).filter((p) => p.length >= 6 && /[^\p{L}\p{N}]/u.test(p)))];
  const focus = options.focus?.length ? options.focus : chatAppFocus(query);
  const terms = [...new Set(lower.match(/[\p{L}\p{N}]{2,}/gu) || [])].filter(
    (t) =>
      ![
        "what",
        "when",
        "where",
        "does",
        "this",
        "that",
        "with",
        "have",
        "from",
        "about",
        "your",
        "please",
        "the",
        "and",
        "for",
        "are",
        "can",
        "our",
      ].includes(t),
  );
  const library = sources.filter(
    (s) =>
      !s.deletedAt &&
      s.status === "ready" &&
      (!collection || s.collection === collection) &&
      !isOperatorSelfPath(s.connector?.path) &&
      !isOperatorSelfTranscript(s.text),
  );
  const appRecords: Record<string, number> = {};
  for (const s of library) {
    const app = recordApp(s);
    if (app) appRecords[app] = (appRecords[app] || 0) + 1;
  }
  const aboutApp = focus.length > 0 && !window && terms.every((t) => GENERIC_TERMS.has(t));
  const ranked = library
    .map((s) => {
      const title = s.title.toLowerCase(), body = s.text.toLowerCase(), hay = `${title} ${body}`;
      const score =
        terms.reduce((n, t) => n + (title.includes(t) ? 6 : 0) + Math.min(8, hay.split(t).length - 1), 0) +
        phrases.reduce((n, p) => n + (title.includes(p) ? 40 : hay.includes(p) ? 14 : 0), 0);
      const at = Math.max(0, [...phrases, ...terms].map((t) => body.indexOf(t)).find((n) => n >= 0) ?? 0);
      const range = recordActivityRange(s);
      const distance = window && range ? sameDayDistance(range, window) : null;
      const inWindow = distance === 0;
      const appMatch = !focus.length || focus.some((app) => recordMatchesApp(s, app.id));
      // Without a window, a named app's records from the last 7 days answer before its older ones.
      const recent = !window && focus.length > 0 && appMatch && !!range && now - range.end <= RECENT_WINDOW && range.start <= now + RECENT_WINDOW;
      const hit: MemorySearchHit = {
        inWindow,
        appMatch,
        sameDay: distance !== null,
        recent,
        id: s.id,
        title: s.title,
        collection: s.collection,
        origin: sourceOrigin(s),
        app: recordApp(s),
        ...(range ? { activityAt: new Date(range.start).toISOString() } : {}),
        ...(s.connector ? { connector: { provider: s.connector.provider } } : {}),
        url: s.url,
        ...(s.image ? { image: s.image, imageUrl: s.image.url, thumbnailUrl: s.image.thumbnailUrl, extraction: s.extraction } : {}),
        score: score + (inWindow ? 12 : 0),
        excerpt: s.text.slice(Math.max(0, at - 100), at + 1600),
        updatedAt: s.updatedAt,
      };
      return { hit, range, distance: distance === null ? Number.MAX_SAFE_INTEGER : distance, activity: range ? range.end : Number.NEGATIVE_INFINITY };
    })
    .filter((s) => !terms.length || s.hit.score > 0 || s.hit.sameDay || (aboutApp && s.hit.recent));
  // Records from the named app answer the question; other apps' records only stand in when it has none.
  const candidates = focus.length && ranked.some((s) => s.hit.appMatch) ? ranked.filter((s) => s.hit.appMatch) : ranked;
  candidates.sort(
    (a, b) =>
      Number(b.hit.inWindow) - Number(a.hit.inWindow) ||
      a.distance - b.distance ||
      (aboutApp ? Number(b.hit.recent) - Number(a.hit.recent) : 0) ||
      b.hit.score - a.hit.score ||
      Number(!!b.range) - Number(!!a.range) ||
      b.activity - a.activity ||
      b.hit.updatedAt.localeCompare(a.hit.updatedAt),
  );
  const nearest = window && !candidates.some((s) => s.hit.inWindow) ? candidates.find((s) => s.hit.sameDay) : undefined;
  return {
    results: candidates.slice(0, 8).map((s) => s.hit),
    focus,
    ...(nearest && nearest.range ? { closest: { id: nearest.hit.id, title: nearest.hit.title, label: closestRecordLabel(nearest.hit, nearest.range) } } : {}),
    appRecords,
  };
}
/** The ranked hits alone. */
export function searchSources(sources: MemorySource[], query: string, collection?: string, window?: ChatTimeWindow | null, options?: { focus?: ChatAppFocus[]; now?: number }) {
  return searchMemory(sources, query, collection, window, options).results;
}

// System page: the last model check and its time, never blocking on the CLI probes.
/**
 * AUDIT-A1-4: /__operator POSTs that act as the hub itself (a forced connector sync spawns Codex/Claude
 * probes and reads this PC's app folders; Gmail/Outlook/calendar/Notion/Granola syncs run the hub's own
 * sign-ins; the macOS privacy pane opens on this PC). Refused for anyone not at the PC. An uploaded
 * export (/memory/apps/<app>/import) carries the caller's own data and stays shared.
 * REVIEW-S1 F4 (lead's decision): connecting, configuring or disconnecting the hub's Google, Outlook,
 * Cal.com, Slack or Skool sign-in changes the hub's own credentials (disconnect wipes its tokens), so
 * those are hub-only too. Syncing a connected account (/connections/sync, /connections/skool/sync)
 * stays shared.
 */
const HUB_CONNECTOR_WRITE =
  /^\/(?:connections\/(?:configure|start|disconnect|skool\/connect)|setup\/connections\/check|models\/refresh|memory\/apps\/(?:sync-all|refresh-settings|[a-z]+\/sync|[a-z]+)|memory\/import-(?:local|notion)|memory\/(?:notion|granola)-config|native-connections\/(?:sync|check)|calendar\/native\/(?:sync|disconnect|check)|setup\/open-privacy|mail-archive\/(?:sync|pause|provider-search))$/;

export function operatorPlugin({
  root,
  token,
  modelKey = () => "",
  memoryHome,
  sharedMemory,
}: {
  root: string;
  token: string;
  modelKey?: () => string;
  memoryHome?: string;
  /**
   * The shared memory connector (scripts/memory/plugin.ts createMemoryService): Jarvis's memory
   * phrases go to the same API as /__memory. `principalFor` is the host's verified identity for the
   * request (the same function /__memory uses), never a body field.
   */
  sharedMemory?: { voiceTurn: MemoryVoiceTurn; principalFor: (req: IncomingMessage) => MemoryPrincipal | null };
}): Plugin {
  const directory = resolve(dataDirFor(root));
  const file = join(directory, "workspace.json");
  const blank = (): OperatorState => ({
    version: 1,
    goals: { longTerm: "", quarter: "", week: "", metrics: [] },
    hiddenMemoryTitles: [],
    sources: [],
    inbox: [],
    events: [],
    settings: { mission: false, openclaw: false, news: true },
  });
  const load = (): OperatorState => {
    let state = blank();
    try {
      if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      throw new Error("The workspace file could not be read. Your records were left untouched.");
    }
    return { ...state, ...readBrainPreferences(root, state) };
  };
  // Read-only paths share one parse per file version (scripts/workspace-state-cache.ts): the file is
  // tens of MB, and the sidebar polls GET /state every 15 s on every page. Anything that changes the
  // workspace still uses load() (a fresh, mutable copy) and save().
  const stateCache = createStateCache<OperatorState>([file, join(directory, "brain-preferences.json")], load);
  const peek = () => stateCache.peek() as OperatorState;
  const vault = memoryVault(root);
  const save = (state: OperatorState) => {
    const current = { ...state, ...readBrainPreferences(root, state) };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(current, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    stateCache.invalidate();
    readBrainPreferences(root, current);
    vault.schedule(current.sources);
  };
  const accounts = accountConnections(root, load, save, { homeDir: memoryHome });
  const existingConnections = nativeConnectionDiscovery(root, { homeDir: memoryHome });
  const skool = createSkoolMessages(root, { homeDir: memoryHome });
  const leadsApi = createLeadsApi(root);
  const automations = createAutomationsApi();
  // Triggers and routines (scripts/triggers): app events and schedules become deduplicated durable jobs.
  const triggers = mountTriggers({ root, origin: () => ownOrigin });
  const inboxAsk = inboxQuestions({
    load,
    archive: (question) => {
      const results = archive.search(question, 200);
      const status = archive.stats();
      return { items: results.items, total: status.total, fullBodies: status.fullBodies, metadata: status.metadata, matched: results.total, importing: status.accounts.some(account => account.status !== "complete") };
    },
    channels: () => skool.snapshot().channels,
    available: (model) => inboxQuestionModelAvailable(root, modelKey(), model),
    generate: (prompt, model, signal) => generateInboxQuestionAnswer(root, modelKey(), prompt, model, signal),
  });
  const conversations = conversationStore(root);
  const archive = mailArchive(root);
  const nativeInbox = nativeInboxSync(root, { load, save, archive });
  // A quiet/preview copy never starts Codex (and the owner's accounts) from a GET (audit F3-26).
  const nativeCalendar = nativeCalendarSync(root, { load, save, quiet: backgroundJobsDisabled() || process.env.ARGENTIC_PREVIEW === "1" });
  const calendarHealth = calendarHealthReader(root, { accounts, savedEvents: () => peek().events.length });
  const nativeBusiness = nativeBusinessSync(root, { quiet: backgroundJobsDisabled() || process.env.ARGENTIC_PREVIEW === "1" });
  // Legacy NAB via Basiq. Fail closed (scripts/finance/legacy-admission.ts): construction is
  // lazy and opens/reads nothing; every operation needs the code-owned reviewed live authorisation.
  const financeSync = createFinanceSync(root);
  // Stripe, read-only (see docs/STRIPE-FINANCE.md). Created eagerly but harmless when
  // unconfigured or given a full secret key instead of a restricted one — every call checks
  // stripeSync.configured() first, same pattern as financeSync above.
  const stripeSync = createStripeSync(root);
  let mailSync: ReturnType<typeof createMailSync> | undefined;
  const getMailSync = () => mailSync ??= createMailSync({ root, archive, identity: accounts.mailIdentity, request: accounts.readMail });
  const providerMail = mailProvider({ archive, identity: accounts.mailIdentity, request: accounts.readMail });
  const recentVoiceMail = voiceRecentEmails({
    load, nativeInbox, providerMail,
    directAccounts: async () => {
      const status = await accounts.handle("/connections", "GET", {}, undefined) as { accounts: Array<{ id: string; connected: boolean; email?: string }> };
      return status.accounts.flatMap(account => account.connected && account.email && ["google", "outlook"].includes(account.id)
        ? [{ provider: account.id === "google" ? "gmail" as const : "outlook" as const, account: account.email }] : []);
    },
  });
  const recentVoiceCreations = voiceRecentCreations({ allowed: () => brainEnabled(peek(), "images") });
  const companionVoice = voiceCompanion(root);
  const openaiVoice = openAIVoice(root);
  // Rebuilt from live probes at start-up and every 30 minutes (see configureServer).
  let capabilityVoiceLine = "";
  // Runtime only: a production build must never touch or interrupt live task history.
  let nativeTasks: ReturnType<typeof agentJobs> | undefined;
  // Movie-Jarvis layer: the interjection gate, the cached status snapshot and named protocols.
  // All read-only or reversible OS flags; nothing here sends, dials, deploys, pays or deletes.
  // A line that would have been spoken while no voice client is listening becomes a Windows toast.
  // S-stream: the live activity stream, once mounted, is told when the Jarvis layer changes (a timer fired, an event posted).
  let activityHint: (() => void) | undefined;
  const jarvisEvents = createJarvisEvents(root, { onFallbackToast: (e) => showWindowsToast(e.source, e.text), onChange: () => activityHint?.() });
  // Inbox triage (scripts/inbox-triage): logs and labels every new email, DMs/speaks alerts to the
  // owner only (armed-but-off until he switches them on). It never replies, sends, archives or deletes mail.
  const inboxTriage = createInboxTriage(root, {
    sync: () => nativeInbox.sync(),
    submitEvent: (body) => jarvisEvents.submit(body),
    jevKey: () => providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY"),
    retellKey: () => providerKey(root, "RETELL_API_KEY"),
  });
  // Everyday skills (timers, reminders, clipboard, notes, typing, windows…) and agent alerts;
  // runtime only, started in configureServer so a production build never schedules anything.
  let jarvisSkills: JarvisSkills | undefined;
  const readJson = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(dataDirFor(root), name), "utf8"));
    } catch {
      return null;
    }
  };
  const jarvisStatus = createStatusCache({
    calendar: async () => {
      // Same freshness answer as the Calendar page and Business (scripts/calendar-health.ts).
      const health = await calendarHealth();
      const events = (peek().events || []).map((e): CalendarItem => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay }));
      return { events, syncedAt: health.syncedAt, connected: health.state !== "none", problem: health.problem, ownerAction: health.ownerAction, headline: health.headline };
    },
    leads: async () => (await leadsApi.handle("/leads/summary", "GET", {}, new URLSearchParams(), false)) as any,
    nextCall: async () => {
      const result = (await leadsApi.handle("/leads/calls", "GET", {}, new URLSearchParams("n=1"), false)) as { leads: any[] };
      const lead = result.leads[0];
      return lead ? ({ id: lead.id, name: lead.name, vertical: lead.vertical, status: lead.status, area: lead.area, phone: lead.phone, opener: lead.opener } satisfies NextCall) : null;
    },
    approvals: () => (nativeTasks ? nativeTasks.list().jobs.reduce((n, job) => n + job.runs.filter((run) => run.status === "needs_input").length, 0) : null),
    capabilities: () => readJson("capabilities.json"),
    mode: () => jarvisEvents.status(),
  });
  const jarvisProtocols = createJarvisProtocols(root, {
    status: () => {
      jarvisStatus.invalidate();
      return jarvisStatus.snapshot();
    },
    events: jarvisEvents,
    missionControl: () => peek().settings?.mission === true,
  });
  // Hands on the real screen (scripts/screen-hands): its own warm PowerShell, started on first use.
  // The vision fallback sends one in-RAM screenshot to GPT-6 (Hermes), and only when the voice
  // client passes his "Allow" for screen analysis.
  // Pointing ("where's the export button?") looks with a warm Claude Sonnet 5 on his subscription
  // (the official claude -p; faster and at least as accurate as GPT-6 on the pointing bench), then
  // GPT-6 via Hermes, then Gemini, then free Groq (router task vision.point, a receipt per attempt).
  // Only with his "Allow", never on a private window.
  // Jarvis action audit (append-only JSONL, metadata only: see scripts/control-audit.ts).
  const controlAudit = createAuditLog({ dir: auditDir(root) });
  const claudeVision = createClaudeVision();
  // Model router task vision.point (private): warm Claude, then free Groq, then GPT-6 via Hermes; never Gemini.
  const pointEyes = createPointEyes(root, claudeVision);
  const screenHands = createScreenHands({
    key: (name) => providerKey(root, name),
    // screen_act's and take-over's pixels: the same routed eyes as pointing.
    vision: async (image, prompt, signal) => (await pointEyes(image, prompt, signal, "screen_act grounding"))?.text ?? null,
    pointLook: (image, prompt, signal) => pointEyes(image, prompt, signal, "pointing"),
    pointWarm: () => claudeVision.warm(),
  });
  // Away mode (scripts/away-mode): a task queue Jarvis works through while he's out, with Telegram
  // approvals, the lock-screen check, the kill switch and a 7-day audit log on D:.
  const awayMode = createAwayService(root, screenHands);
  // Narrate my workflow (scripts/meeting-mode/narrate.ts): "I'm going to walk you through how I do
  // X" -> local-Whisper mic-only capture -> a DRAFT skill via the Claude bridge. Never installs
  // anything on its own; see /skill-drafts (narrate-api.ts) for approve/edit/discard.
  const narrate = narrateFullService(root, join(dataDirFor(root)));
  // The port this server actually got (set once it listens), for the voice rule that reads the workspace panels over loopback.
  let ownOrigin = "http://127.0.0.1:8081";
  const jarvisChromeInFront = async () => {
    const [front, chrome] = await Promise.all([screenHands.frontPid(), jarvisChromePid()]);
    return !!front && !!chrome && front === chrome;
  };
  const freeVoice = freeVoiceEngine(root, {
    jarvisChromeInFront,
    elevenVoice: () => companionVoice.status().voiceId,
    capabilities: () => capabilityVoiceLine,
    shorthand: () => readShorthand(root),
    status: () => jarvisStatus.snapshot(),
    // "What needs me?": the same two workspace panels the Home page's "Needs you" list reads (scripts/workspace/needs-you-voice.ts).
    needsYou: async () => {
      const get = loopbackJson(() => ownOrigin);
      const signal = AbortSignal.timeout(14_000);
      const [needsYou, today] = await Promise.all([get("/__workspace/needs-you", signal), get("/__workspace/today", signal)]);
      return { needsYou, today };
    },
    warmHermes: () => warmHermes(),
    lessonActive: () => screenHands.lessons.active,
    away: async (utterance) => {
      const intent = awayVoiceIntent(utterance);
      return intent ? awayMode.away.voice(intent) : null;
    },
    meetingGate: () => meetings.meeting.gate(),
    narrateGate: () => narrate.gate(),
    memory: sharedMemory
      ? async (utterance, turn) => {
          const said = await sharedMemory.voiceTurn(turn.caller as MemoryPrincipal, utterance, { spokenYes: turn.spokenYes, previousAssistant: turn.previousAssistant });
          return said?.content ?? null;
        }
      : undefined,
    // Track 3: coding jobs by voice (scripts/coding/voice.ts), on the same verified caller as memory.
    coding: async (utterance, turn) => (await codingVoiceFor(root)).handle(utterance, { caller: turn.caller as never, spokenYes: turn.spokenYes, previousAssistant: turn.previousAssistant }),
  });
  const memoryImages = voiceImages(root, load);
  const localVoiceImages = voiceLocalImages({allowed:()=>brainEnabled(peek(), "images")});
  const photos = memoryPhotos(root, memoryHome);
  let photoAccess: { stamp: string; sources: Map<string, { origin: string; deleted: boolean }> } | undefined;
  const canReadSavedPhoto = (sourceId: string) => {
    const st = existsSync(file) ? statSync(file) : undefined;
    const stamp = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "empty";
    if (photoAccess?.stamp !== stamp) photoAccess = { stamp, sources: new Map(peek().sources.map(s => [s.id, { origin: sourceOrigin(s), deleted: !!s.deletedAt }])) };
    const source = photoAccess.sources.get(sourceId);
    return source && !source.deleted && brainEnabled(readBrainPreferences(root), source.origin);
  };
  const business = businessWorkspace(root);
  const personalProfile = workspaceProfile(root);
  const contentStudio = businessContent(root);
  const competitorStudio = competitorWatch(root);
  const morningBrief = businessBrief(root);
  // The assistant the operator chose for the brief; only a catalog key and label are kept.
  const briefModel = briefModelSettings(root);
  const businessDemo = businessDemoSettings(root);
  // Saved balances or any dated audience observation count as live data. Demo
  // numbers only appear while nothing real has been connected.
  const hasLiveBusinessData = (workspace = business.read()) => Boolean(workspace.finances?.accounts?.length) || (workspace.snapshots || []).length > 0;
  const demoState = () => { const live = hasLiveBusinessData(), requested = businessDemo.read().enabled; return { enabled: requested && !live, requested, liveData: live }; };
  const demoActive = () => demoState().enabled;
  // Real records switch the demo flag off so a stale flag can never resurface later.
  const demoOffForLiveData = () => { if (businessDemo.read().enabled && hasLiveBusinessData()) businessDemo.save(false); };
  const displayedBrief = () => demoActive() ? businessBrief(root, "demo") : morningBrief;
  let briefGenerating = false, briefGeneratingSince = "";
  const businessSyncing = new Set<string>();
  const notionFile = join(directory, "notion.json");
  const notionToken = () =>
    existsSync(notionFile) ? JSON.parse(readFileSync(notionFile, "utf8")).token || "" : "";
  const collectionOf = (value: string, state = load()) =>
    memorySpaces(state).some((s) => s.id === value) ? value : "business";
  const sourceExcerpts = (state: OperatorState) => ({
    ...state,
    sources: state.sources.map((s) => s.text.length > 2000 ? { ...s, text: s.text.slice(0, 2000), textTruncated: true } : s),
  });
  type ReadySourceInput = {
    id?: string;
    title: string;
    text: string;
    origin: string;
    collection: string;
    replaceCollection?: boolean;
    url?: string;
    connector?: MemorySource["connector"];
    image?: MemorySource["image"];
    extraction?: MemorySource["extraction"];
    filename?: string;
  };
  function importReadyBatch(inputs: ReadySourceInput[]) {
    const state = load();
    let changed = false;
    const results = inputs.map((input) => {
      if (input.collection && !memorySpaces(state).some((s) => s.id === input.collection)) throw new Error("Choose an existing memory space.");
      if (input.text.trim().length < 15)
        throw new Error("This source does not contain enough readable text.");
      const hash = digest(input.text + (input.image ? "\nimage:" + input.image.sha256 : "")), existing = state.sources.find(
        (s) =>
          (input.connector
            ? s.connector?.provider === input.connector.provider &&
              s.connector?.itemId === input.connector.itemId
            : !s.deletedAt && s.origin === input.origin && s.hash === hash),
      );
    if (existing?.deletedAt && !existing.connector?.supersededAt) return { source: existing, skipped: true };
    const targetCollection = collectionOf(input.collection, state);
    if (existing && !existing.deletedAt && existing.hash === hash && (!input.replaceCollection || existing.collection === targetCollection)) {
      // Identical text re-read by a newer reader still refreshes the activity stamp
      // and path, so dated questions can find records saved before stamps existed.
      const stamp = input.connector, current = existing.connector;
      if (stamp && current && ((stamp.activityAt && stamp.activityAt !== current.activityAt) || (stamp.path && stamp.path !== current.path))) {
        existing.connector = { ...current, ...stamp };
        changed = true;
      }
      return { source: existing, unchanged: true };
    }
    const source: MemorySource = {
      ...(existing || {}),
      id: existing?.id || input.id || id(),
      title: text(input.title, 200),
      text: text(input.text, 600000),
      kind: "document",
      origin: input.origin,
      collection: input.replaceCollection ? targetCollection : existing?.collection || targetCollection,
      url: input.url,
      connector: input.connector,
      ...(input.image ? { image: input.image, extraction: input.extraction, filename: input.filename } : {}),
      deletedAt: undefined,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      status: "ready",
      error: undefined,
      pinned: existing?.pinned || false,
      words: input.text.trim().split(/\s+/).length,
      hash,
    };
    state.sources = [source, ...state.sources.filter((s) => s.id !== source.id)];
    changed = true;
    return { source, updated: !!existing };
    });
    if (changed) save(state);
    return results;
  }
  function importReady(input: ReadySourceInput) { return importReadyBatch([input])[0]; }
  const photoIndex = createPhotoIndex({ root, home: memoryHome, key: modelKey, importSource: importReady, validCollection: value => memorySpaces(peek()).some(space => space.id === value) });
  function reconcileImportedParts(items: ImportedParts[]) {
    const state = load();
    let changed = false;
    for (const item of items) {
      for (const source of state.sources) {
        const c = source.connector;
        if (!c || c.provider !== item.provider || source.deletedAt) continue;
        const prefix = item.itemId + ":part:", suffix = c.itemId.slice(prefix.length);
        const part = c.itemId === item.itemId ? 0 : c.itemId.startsWith(prefix) && /^\d+$/.test(suffix) ? Number(suffix) : -1;
        if (part >= 0 && (part >= item.parts || (item.keepParts && !item.keepParts.includes(part)))) {
          source.deletedAt = now();
          c.supersededAt = source.deletedAt;
          changed = true;
        }
      }
    }
    if (changed) save(state);
  }
  function syncBusinessMemory(workspace = business.read()) {
    const inputs: ReadySourceInput[] = [], completed: ImportedParts[] = [];
    // Finance enters memory only as sourced period totals (scripts/finance/manual-sourced.ts); an
    // older balances document is retracted when there is no finance document to replace it.
    const docs = businessMemoryDocuments(workspace, { finance: () => sourcedFinanceSummaries({ root }) });
    if (!docs.some((d) => d.id === FINANCE_MEMORY_ID)) completed.push({ provider: "business-dashboard", itemId: FINANCE_MEMORY_ID, parts: 0 });
    for (const doc of docs) {
      for (let n = 0; n < doc.text.length; n += 180000) {
        let part = doc.text.slice(n, n + 180000);
        if (part.trim().length < 15) part = "Observation continued:\n" + part;
        inputs.push({ title: doc.title + (n ? ` · part ${n / 180000 + 1}` : ""), text: part, collection: "business", origin: "business",
          connector: { provider: "business-dashboard", itemId: doc.id + (n ? `:part:${n / 180000}` : ""), syncedAt: now() } });
      }
      completed.push({ provider: "business-dashboard", itemId: doc.id, parts: Math.ceil(doc.text.length / 180000) });
    }
    const results: ReturnType<typeof importReadyBatch> = [];
    for (let i = 0; i < inputs.length; i += 8) results.push(...importReadyBatch(inputs.slice(i, i + 8)));
    reconcileImportedParts(completed);
    return { added: results.filter((r) => !r.updated && !r.unchanged && !r.skipped).length, updated: results.filter((r) => r.updated).length, unchanged: results.filter((r) => r.unchanged).length, skipped: results.filter((r) => r.skipped).length };
  }
  const granola = granolaApi(root);
  const recentGranola = async () => {
    let connected = false;
    try { connected = (await nativeBusiness.status()).granola.available; } catch { /* Direct API credentials remain an independent connection. */ }
    if (connected) return { ...await connectedGranolaNotes(root), scope: "Up to 10 of your meetings from this week" };
    if (granola.configured()) return { ...await granola.notes(), scope: "The first page of up to 20 Granola notes" };
    throw new Error("Granola is not available through your current connection. Reconnect it in Memory.");
  };
  const voiceRecall = voiceMemory({ load, recentMeetings: recentGranola });
  // Meeting mode (docs/MEETING-MODE.md): consent-gated call notes and coaching; Granola meetings
  // go through the same coaching and CRM update.
  const meetings = meetingService(root, { recentGranola });
  const apps = memoryApps({
    root, home: memoryHome, importSource: importReady, importSources: importReadyBatch,
    reconcileSources: reconcileImportedParts,
    validCollection: (value) => memorySpaces(peek()).some((s) => s.id === value),
    notionConfigured: () => !!notionToken(),
    granolaConnection: async (force) => {
      try { if ((await nativeBusiness.status(force)).granola.available) return "codex"; } catch { /* Direct API remains an independent option. */ }
      return granola.configured() ? "api" : undefined;
    },
    granolaNotes: async (cursor, method) => method === "codex" ? connectedGranolaNotes(root) : granola.notes(cursor),
    notionConnection: async (force) => {
      try { if ((await nativeBusiness.status(force)).notion?.available) return "codex"; } catch { /* A page import remains an independent option. */ }
      return undefined;
    },
    notionPages: () => connectedNotionPages(root),
    sourceEnabled: origin => brainEnabled(readBrainPreferences(root), origin),
    syncInfo: () => syncBusinessMemory(),
    accountStatus: async () => ({
      ...(await accounts.handle("/connections", "GET", {}, {})),
      snapshots: { gmail: peek().inbox.filter((i) => i.source === "gmail").length, outlook: peek().inbox.filter((i) => i.source === "outlook").length },
    }),
    syncAccount: async (provider) => {
      const status = await accounts.handle("/connections", "GET", {}, {});
      if (!("accounts" in status) || !(status.accounts || []).find((a: any) => a.id === provider)?.connected) {
        throw new Error("These saved messages are snapshots. Connect this account in Connections for provider sync.");
      }
      const result = await accounts.handle("/connections/sync", "POST", { provider }, {});
      if (!("messages" in result) || !("events" in result) || typeof result.messages !== "number" || typeof result.events !== "number") throw new Error("Provider did not report a completed sync.");
      return { messages: result.messages, events: result.events };
    },
    mailDocuments: (provider) => peek().inbox.filter((i) => i.source === provider).map((i) => ({ id: i.id, title: i.subject, text: `From: ${i.from}\nDate: ${i.receivedAt}\nSubject: ${i.subject}\n\n${i.body}` })),
  });
  const jobs = new Set<string>();
  const updateSource = (sourceId: string, patch: Partial<MemorySource>) => {
    const state = load(),
      source = state.sources.find((s) => s.id === sourceId);
    if (!source || source.deletedAt || source.status !== "indexing") return;
    Object.assign(source, patch, { updatedAt: now() });
    save(state);
  };
  async function ingest(source: MemorySource, input: any) {
    jobs.add(source.id);
    let temporary: string | undefined;
    try {
      let content = source.text,
        title = source.title;
      if (input.base64) {
        const bytes = Buffer.from(input.base64, "base64");
        if (bytes.length > 5 * 1024 * 1024) throw new Error("Files must be under 5 MB.");
        if (imageFile(source.filename || "")) {
          const metadata = saveMemoryPhoto(root, source.id, bytes, "upload");
          updateSource(source.id, { image: metadata });
          content = await readImageOnCPU(root, join(directory, "uploads", source.id + ".image"));
          if (content.length < 15)
            throw new Error(
              "No readable text found in this image. Add a written description; local OCR reads text, not scenes.",
            );
        } else if (/\.eml$/i.test(source.filename || "")) {
          content = emailText(
            bytes.toString("utf8"),
            (html) => articleText(html, "https://email.local").text,
          );
        } else if (/\.pdf$/i.test(source.filename || "")) {
          temporary = mkdtempSync(join(tmpdir(), "operator-pdf-"));
          const pdf = join(temporary, "document.pdf");
          writeFileSync(pdf, bytes);
          const result = await runFile("pdftotext", ["-layout", pdf, "-"], {
            timeout: 25000,
            maxBuffer: LIMIT,
          });
          content = result.stdout;
        } else {
          if (!/\.(txt|md|markdown|csv|json|html|htm|vtt|srt)$/i.test(source.filename || ""))
            throw new Error("Upload a PDF, text, Markdown, CSV, JSON, HTML or transcript file.");
          content = bytes.toString("utf8");
          if (/\.html?$/i.test(source.filename || ""))
            content = articleText(content, "https://document.local").text;
        }
      } else if (
        source.extraction === "local-ocr" &&
        !content &&
        existsSync(join(directory, "uploads", source.id + ".image"))
      ) {
        content = await readImageOnCPU(root, join(directory, "uploads", source.id + ".image"));
      } else if (source.url && !content) {
        const url = new URL(source.url);
        if (/(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname)) {
          const videoId =
            url.hostname === "youtu.be"
              ? url.pathname.slice(1)
              : url.searchParams.get("v") || url.pathname.split("/").pop();
          if (!videoId || !/^[\w-]{11}$/.test(videoId))
            throw new Error("Use a link to one YouTube video.");
          temporary = mkdtempSync(join(tmpdir(), "operator-youtube-"));
          try {
            await runFile(
              "yt-dlp",
              [
                "--no-playlist",
                "--skip-download",
                "--write-info-json",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                "en.*",
                "--sub-format",
                "vtt",
                "-o",
                join(temporary, "video.%(ext)s"),
                `https://www.youtube.com/watch?v=${videoId}`,
              ],
              { timeout: 75000, maxBuffer: 1024 * 1024 },
            );
          } catch {
            throw new Error(
              "YouTube did not provide a transcript. Paste the transcript here or upload a VTT file.",
            );
          }
          const captions = readdirSync(temporary).find((n) => n.endsWith(".vtt"));
          if (!captions)
            throw new Error("No transcript was available. Paste or upload a transcript.");
          const lines = readFileSync(join(temporary, captions), "utf8")
            .split("\n")
            .filter((l) => l.trim() && !/^(WEBVTT|Kind:|Language:|NOTE|\d+$|\d\d:)/.test(l))
            .map((l) => l.replace(/<[^>]*>/g, "").trim());
          content = [...new Set(lines)].join("\n");
          const metadata = join(temporary, "video.info.json");
          if (existsSync(metadata))
            title = JSON.parse(readFileSync(metadata, "utf8")).title || title;
        } else {
          const page = await fetchPublic(source.url);
          const extracted = page.type.includes("html")
            ? articleText(page.body, page.url)
            : { title, text: page.body };
          content = extracted.text;
          if (!input.title) title = extracted.title;
        }
      }
      content = text(content, 600000);
      if (content.length < 15)
        throw new Error("There isn't enough readable text to index. Add a note or transcript.");
      updateSource(source.id, {
        text: content,
        title,
        status: "ready",
        error: undefined,
        words: content.split(/\s+/).length,
        hash: source.hash,
      });
    } catch (error) {
      updateSource(source.id, { status: "error", error: (error as Error).message });
    } finally {
      jobs.delete(source.id);
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
  let newsCache: { at: number; data: any } | undefined;
  // Weather follows the operator's own city, then their time zone; a fresh copy asks for nothing.
  // Shared with the weather skill (jarvis-skills/weather.ts) so "what's the weather" defaults to
  // the same city as the dashboard's daily brief.
  const resolveWeatherCity = () => {
    const profile = personalProfile.read() as { city?: string; timeZone?: string };
    const own = typeof profile.city === "string" ? profile.city.trim().slice(0, 80) : "";
    if (own) return { name: own, source: "profile" as const };
    const derived = cityFromTimeZone(profile.timeZone);
    return derived ? { name: derived, source: "timezone" as const } : undefined;
  };
  const today = businessToday({ city: resolveWeatherCity });
  return {
    name: "operator-workspace",
    configureServer(server) {
      // His own dashboard on loopback is THIS server at the port it actually got (money-policy ownDashboard,
      // REVIEW-S2C R2): a preview on another port, or any other local server, isn't exempt.
      const registerPort = () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          setOwnServerPort(address.port);
          ownOrigin = `http://127.0.0.1:${address.port}`;
        }
      };
      registerPort();
      server.httpServer?.once("listening", registerPort);
      // AGENTIC_OS_NO_BACKGROUND=1 (scripts/preview-guard.ts): a quiet second copy starts no
      // timers, syncs, skills scheduler or away mode, and never rewrites the live task history.
      const background = !backgroundJobsDisabled();
      nativeTasks = agentJobs(root, { readOnly: !background });
      // Load the Windows app list now, so the first "open Spotify" is instant (pc-hands).
      if (background) startApps();
      // Stage B2: screen, voice and away runs join the ONE durable job history (scripts/jobs).
      if (background) {
        try {
          mirrorRunLog(screenHands.runs, jobsRuntime(root).jobs);
        } catch {
          /* the job store is unavailable: runs keep their in-memory log */
        }
      }
      if (background) {
        triggers.start();
        server.httpServer?.once("close", () => triggers.close());
      }
      // Legacy NAB background refresh: creates no timer unless the code-owned reviewed live
      // authorisation covers "schedule" (scripts/finance/legacy-admission.ts).
      financeSync.schedule();
      jarvisSkills = createJarvisSkills(root, {
        events: jarvisEvents,
        city: resolveWeatherCity,
        agents: {
          jobs: () => nativeTasks?.list(),
          // Chat runs and their approval cards live in vite.config.ts; read their status only.
          chats: async () => {
            const address = server.httpServer?.address();
            if (!address || typeof address !== "object") return null;
            const response = await fetch(`http://127.0.0.1:${address.port}/__sessions_live`, { signal: AbortSignal.timeout(2000) });
            return response.ok ? parseLiveChats(await response.json()) : null;
          },
        },
      });
      if (background) jarvisSkills.start();
      // Compile the screen helper (UI Automation + SendInput) now, so the first "click that" is quick.
      if (background && process.platform === "win32") setTimeout(() => screenHands.warm(), 8_000).unref?.();
      // Build the model catalogue once in the background, so the first page's model pickers get an
      // answer at once instead of waiting 18-29 s for the Codex/Claude probes (audit F1-07).
      // Never under bun test: the whole suite shares one process, and these spawn the real Codex/Claude CLIs.
      const warmUps = background && process.env.NODE_ENV !== "test";
      if (warmUps) setTimeout(() => void assistantCatalog(root, modelKey()).catch(() => undefined), 15_000).unref?.();
      // ...and re-check it every 30 min (T8c: page reads no longer trigger the re-check).
      const catalogTimer = warmUps ? setInterval(() => void assistantCatalog(root, modelKey()).catch(() => undefined), 30 * 60_000) : undefined;
      catalogTimer?.unref?.();
      server.httpServer?.once("close", () => clearInterval(catalogTimer));
      // Same for the Codex connected-app check behind /memory/apps and the chat preflight (F3-16).
      if (warmUps) setTimeout(() => void nativeBusiness.status().catch(() => undefined), 25_000).unref?.();
      if (background) apps.startTimer();
      if (background) getMailSync();
      // Capability registry: probes need this server listening, so start after a pause. They probe THIS
      // server's real port (audit F5 P2-6: hard-coded 8081 made a preview describe the live server) and
      // know it is up (it is running this code), so a busy moment can't call the OS broken (F3-06).
      const serverOrigin = () => {
        const address = server.httpServer?.address();
        const port = address && typeof address === "object" ? address.port : server.config?.server?.port ?? 8081;
        return `http://127.0.0.1:${port}`;
      };
      // One refresh at a time; a request during a run queues exactly one more, and settings saves in
      // quick succession make one refresh 5 s after the last (P2-6: every Jarvis settings save ran a
      // full refresh, `claude -p` included when its cache was cold).
      const registry = serialRefresher(() =>
        refreshCapabilities(root, { origin: serverOrigin(), self: true })
          .then((result) => void (capabilityVoiceLine = result.voice))
          .catch((error) => console.warn("[capabilities] refresh failed:", (error as Error).message)),
      );
      const refreshRegistry = () => registry.now();
      const scheduleRegistry = () => registry.schedule();
      // One registry timer per process: a dev-server reload re-runs this hook without closing the old
      // server, and the stacked timers each spent a `claude -p` turn (see cachedClaudeInit).
      const registryGlobal = globalThis as { __agenticRegistryTimers?: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } };
      if (registryGlobal.__agenticRegistryTimers) {
        clearTimeout(registryGlobal.__agenticRegistryTimers.first);
        clearInterval(registryGlobal.__agenticRegistryTimers.every);
      }
      const firstRegistry = background ? setTimeout(refreshRegistry, 20_000) : undefined;
      const registryTimer = background ? setInterval(refreshRegistry, 30 * 60_000) : undefined;
      if (firstRegistry && registryTimer) registryGlobal.__agenticRegistryTimers = { first: firstRegistry, every: registryTimer };
      // Calendar refresh on the server (start + every 15 min), not only while /calendar is open.
      const calendarSync = background ? startCalendarBackgroundSync(root, { native: nativeCalendar, accounts, log: (line) => console.warn(line) }) : { stop() {} };
      server.httpServer?.once("close", () => { clearTimeout(firstRegistry); clearInterval(registryTimer); registry.stop(); calendarSync.stop(); apps.stop(); vault.stop(); photoIndex.close(); mailSync?.close(); existingConnections.close(); nativeTasks?.close(); leadsApi.close(); meetings.close(); jarvisSkills?.close(); screenHands.close(); claudeVision.close(); });
      // Claude on his Claude subscription, as an OpenAI-compatible provider for Hermes.
      // Machine-internal services answer only the owner at this PC (in practice Hermes and local CLIs);
      // the identity gate enforces the same rule first (Stage B1). A remote principal never spends
      // his Claude plan, Cline account or Jev key through these.
      const internalOnly = (service: string) => (req: IncomingMessage, res: ServerResponse) => {
        const decision = authorise(requestPrincipal(req, { root }), { kind: "internal", service }, "run");
        if (decision.ok) return true;
        res.statusCode = decision.status;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ error: { message: decision.reason } }));
        return false;
      };
      // Routed (task bridge.claude): one router receipt per attempt under .operator-data/model-router.
      const claude = claudeBridge({ root });
      const claudeInternal = internalOnly("The Claude bridge");
      server.middlewares.use("/__claude", (req, res) => void (claudeInternal(req, res) && claude.handle(req, res)));
      // Cline's free models (catalogue cline/*) via the official Cline CLI, text only. Routed (task
      // bridge.cline): one router receipt per attempt. The fleet receipts.sqlite (the Cline model usage
      // view) is still written; its rows for routed attempts carry the router's id, so readAllReceipts
      // counts each call once.
      const cline = clineBridge({ root, onReceipt: modelFleetReceiptSink(root) });
      const clineInternal = internalOnly("The Cline bridge");
      server.middlewares.use("/__cline", (req, res) => void (clineInternal(req, res) && cline.handle(req, res)));
      // Hermes' smart-approval guardian answered by Jev (~0.3 s instead of a ~3 s gpt-6-sol call):
      // an OpenAI-compatible, loopback-only, token-guarded endpoint that returns APPROVE only for
      // commands that just open, launch or read, and ESCALATE for anything else (scripts/jev-hermes.ts).
      const jevGuardian = jevShim(root, { log: (entry) => console.warn(`[jev-guardian] ${entry.verdict} in ${entry.ms} ms: ${entry.reason} (${entry.description.slice(0, 80)})`) });
      const jevInternal = internalOnly("The Jev guardian");
      server.middlewares.use("/__jev", (req, res, next) => void (jevInternal(req, res) && jevGuardian(req, res, next)));
      // Away mode: the Hermes gateway plugin relays his Telegram commands here (loopback, own token).
      server.middlewares.use("/__away", (req, res) => void awayMode.relay(req, res));
      // Devices and people (w2/devices): pairing, 30-day sessions, companion long-poll, and the
      // registry resolveTarget() routes Jarvis desktop/browser actions through.
      const devices = createDevicesService({ root, token, install: true });
      server.middlewares.use("/__devices", (req, res, next) => void devices.handle(req, res, next));
      server.httpServer?.once("close", () => devices.close());
      // Agent F: shared agent cloud computers (list, provision, agent jobs, control lease, viewer). Idle until a host is configured.
      const computers = mountComputers(server, { root, devices, jobs: () => jobsRuntime(root).jobs, conversations });
      // S-stream: the ONE authenticated live activity stream (/__events): jobs, approvals, computers, leases, devices, Jarvis hints.
      const activity = mountActivityStream(server, { root, computers: computers as never });
      activityHint = () => activity.jarvisChanged("events");
      // Track 2: the ONE Jarvis command entry (typed and spoken), job-backed, routed to the requester's own device.
      // Open Dot V: job results are appended to the person's durable Jarvis conversation by the server (scripts/jarvis-command/threads.ts).
      const jarvisThreads = createJobThreads({
        conversations,
        localFile: join(dataDirFor(root), "jarvis-thread-local.json"),
        jobs: () => jobsRuntime(root).jobs,
        coding: async (id) => {
          const rt = await codingRuntime(root);
          const job = rt.store.getJob(id);
          if (!job) return null;
          return codingSnapshotOf(job, rt.store.events(id, 0, 5000));
        },
      });
      // The short spoken line goes through the ONE interjection gate (dedupe by job+state, daily budget, quiet mode/hours, one claim, toast fallback);
      // the voice client says it at a conversational pause. Only for the person at this PC; everyone's full result is in their conversation.
      // Every entry appended to a person's conversation (the acknowledgement, a progress line, the returned research report, a job's end) is pushed
      // live to THAT person's /__events stream; the stable id (conversation + entry key) lets a replay or second tab apply it once. Notifications only.
      wireThreadNotices({ threads: jarvisThreads, activity, events: jarvisEvents });
      if (background) void jarvisThreads.start().catch(() => undefined);
      server.httpServer?.once("close", () => jarvisThreads.stop());
      const commands = createLiveCommandService({
        threads: jarvisThreads,
        screen: screenHands,
        entry: () => (process.platform === "win32" ? entryFor(screenHands) : null),
        devices,
        jobs: () => jobsRuntime(root).jobs,
        computers: withComputerResolution(() => computers.list().map((c) => ({ name: c.name, label: c.label })), (utterance, principal) => computerCommand(computers, utterance, principal)),
        memoryTurn: sharedMemory
          ? async (caller, utterance, spokenYes) => {
              const r = await sharedMemory.voiceTurn(caller as MemoryPrincipal, utterance, { spokenYes });
              return r ? { said: r.content, outcome: r.outcome } : null;
            }
          : undefined,
        receptionist: () => receptionistSnapshot(),
        leads: () => leadsApi,
        skills: () => jarvisSkills,
        jarvisChromeInFront,
        coding: async () => createCodingCommandEntry({ voice: await codingVoiceFor(root), store: (await codingRuntime(root)).store }),
      });
      if (background) void awayMode.away.start();
      server.httpServer?.once("close", () => awayMode.away.close());
      server.middlewares.use("/__operator", async (req, res, next) => {
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        try {
          if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
            return send({ error: "Local access only" }, 403);
          const host = req.headers.host || "";
          // Stage B1: the one verified principal (scripts/identity). Local at this PC, a paired session,
          // or a Serve-verified Tailscale login in people.json. Never a body field or a typed name.
          const principal = requestPrincipal(req, { root });
          if (!isBrowserPrincipal(principal))
            return send({ error: "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address." }, 401);
          // A changed Jarvis layer (a posted event, a claim, quiet mode, a protocol run, a timer set) is a hint for every open stream.
          if (req.method !== "GET" && String(req.url ?? "").startsWith("/jarvis/"))
            res.once("finish", () => {
              if (res.statusCode < 300) activity.jarvisChanged(String(req.url).startsWith("/jarvis/protocol") ? "protocol" : String(req.url).startsWith("/jarvis/events") ? "events" : "status");
            });
          // Not at this PC in person. Shared business work is open to both founders (V7); the hub's own
          // screen, mic and settings act only for the person sitting at it.
          // role comes from the verified person (the hub's owner is Usman), never from the request.
          const remote = isAtHub(principal)
            ? null
            : { name: principal.displayName, personId: principal.personId, role: principal.personId === "usman" ? "owner" : "co-founder" };
          // Device control is routing, not permission: it resolves to the requester's OWN device
          // (resolveTarget). These executors run on this PC, so anyone else's command is refused here
          // (never re-routed to the hub), with the reason resolveTarget gave.
          // True when refused (and the refusal has been sent).
          const deviceDenied = (resource: Omit<Extract<IdentityResource, { kind: "device" }>, "kind">) => {
            const decision = authorise(principal, { kind: "device", ...resource }, "control");
            if (decision.ok) return false;
            send({ error: decision.reason }, decision.status);
            return true;
          };
          // MU_HUB_ROLE=server: `remote` keeps its DEVICE meaning (the requester's own companion, or an honest refusal). The
          // "only at this PC" refusals for SERVER-SIDE WORK are decided by scripts/identity/operator-sites.ts instead: a
          // confirmed human founder session may do that work (serverWork); `permRemote` is what those sites test. Outside the
          // server role both are exactly `remote`.
          const serverWork = serverWorkAllowed(principal, hubRole());
          const ownOrigin = `${remote ? "https" : "http"}://${host}`;
          const callbackUrl = new URL(req.url || "/", ownOrigin);
          if (
            (req.method || "GET") === "GET" &&
            /^\/connections\/callback\/(google|outlook)$/.test(callbackUrl.pathname)
          ) {
            return await accounts.callback(callbackUrl.pathname, callbackUrl, req, res);
          }
          if (req.headers.origin && req.headers.origin !== ownOrigin)
            return send({ error: "Unknown origin" }, 403);
          if (req.headers["sec-fetch-site"] === "cross-site")
            return send({ error: "Cross-site request blocked" }, 403);
          const url = new URL(req.url || "/", "http://localhost"),
            path = url.pathname,
            method = req.method || "GET";
          // The caller's OWN page token: the internal one at this PC, a person-bound one remotely.
          if (method !== "GET" && !pageTokenMatches(principal, req.headers["x-claude-os-token"], token))
            return send({ error: "Refresh this page and try again." }, 403);
          let body: any = {};
          // A DELETE with no body needs no Content-Type (Audit F5 P3: DELETE skill-drafts/:id got 415).
          const bodiless = method === "DELETE" && !Number(req.headers["content-length"] || 0) && !req.headers["transfer-encoding"];
          if (method !== "GET" && !bodiless) {
            if (!req.headers["content-type"]?.includes("application/json"))
              return send({ error: "JSON required" }, 415);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > (/^\/memory\/apps\/(chatgpt|granola)\/import$/.test(path) ? 64 * 1024 * 1024 : LIMIT)) throw new PayloadTooLarge("The upload is too large.");
              chunks.push(Buffer.from(chunk));
            }
            body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          }
          // Server role, a remote founder: classify the site once (device / work / publish / console). Console sites stay at the
          // server's console; work sites need a confirmed human session, with a clear line when it is missing; after this
          // `permRemote` is null for a work site, so the site's own "only at this PC" check passes.
          const siteRefusal = remote ? operatorRemoteRefusal(hubRole(), method, path, serverWork) : null;
          if (siteRefusal) return send({ error: siteRefusal.error }, siteRefusal.status);
          const siteClass = remote && hubRole() === "server" ? operatorSiteClass(method, path) : null;
          const permRemote = siteClass === "work" || siteClass === "publish" ? null : remote;
          const workAuthed = (raw: boolean) => raw || permRemote === null && remote !== null;
          // AUDIT-A1-4: connector syncs, imports and settings that read this PC's own app data, spawn its
          // CLIs or run the hub's own sign-ins act AS the hub, so only the owner at this PC runs them (a
          // device rule, like screen and voice; what they bring in stays shared with both founders).
          // (Server role, a confirmed founder on a server-side-work connector site skips this device-style refusal.)
          if (siteClass !== "work")
          if (remote && method === "POST" && HUB_CONNECTOR_WRITE.test(path))
            return send({ error: "That runs this PC's own apps and sign-ins, so it runs only for Usman at the PC. What it brings in is shared with you once it has run." }, 403);
          // Voice "open YouTube": open the link in this PC's default browser. A page can't
          // open tabs reliably on its own (Chrome's pop-up blocker drops window.open outside a
          // click, silently when noopener is set). Only for people at this PC — someone signed
          // in from their phone gets the tab on their phone instead.
          if (path === "/open-url" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            let target: URL;
            try {
              target = new URL(String(body?.url ?? ""));
            } catch {
              return send({ error: "That is not a web address." }, 400);
            }
            if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
              return send({ error: "Only plain http(s) links can be opened." }, 400);
            // Jarvis Chrome first (24 Sep): a page opened there is one Jarvis can then act on
            // instantly ("click the first video", "pause") through browser_act. His everyday
            // Chrome can't be driven, so it's the fallback only if Jarvis Chrome won't start.
            // J-fix: opened is not enough; its window comes to the front on his main screen with that tab active,
            // and the reply says where (it was opened hidden behind other windows, on another monitor).
            if (await openInJarvisChrome(root, target.href)) {
              const host = target.hostname.replace(/^www\./, "");
              const placed = jarvisSkills ? await jarvisSkills.run({ skill: "window", action: "bring", target: "front", screen: "main" }).catch(() => null) : null;
              return send({ opened: target.href, browser: "jarvis-chrome", said: openedWhereLine(host, placed?.said ?? null) });
            }
            // His everyday browser is Chrome (Windows' default may still be something else):
            // chrome.exe <url> adds a tab to the open window. Otherwise the default browser via
            // rundll32's URL handler. No shell either way, so nothing is interpreted.
            const chrome = [
              join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
              join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
              join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
            ].find((path) => existsSync(path));
            if (chrome) execFile(chrome, [target.href], { windowsHide: false }, () => undefined);
            else execFile("rundll32.exe", ["url.dll,FileProtocolHandler", target.href], { windowsHide: true }, () => undefined);
            return send({ opened: target.href, browser: chrome ? "chrome" : "default" });
          }
          // Settings → Jarvis. Anyone signed in may read; only someone at this PC may change who
          // can reach Jarvis, his shorthand or greeting (a remote session can't add itself).
          // Voice browser_act: one DevTools call on the Jarvis Chrome tab he's looking at
          // (click / pause / back / search…), instead of a Hermes computer_use loop.
          if (path === "/browser/act" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            try {
              return send(await browserAct(root, parseActRequest(body)));
            } catch (error) {
              return send({ ok: false, said: (error as Error).message }, 400);
            }
          }
          // Voice screen_act: hands on the window he's looking at (click, type, fill, scroll, keys).
          // Streams NDJSON progress, then one "done" line. If he says stop (the client aborts this
          // request) or calls /screen/stop, the loop ends between any two sub-steps.
          // The ONE command entry (Track 2): open to every verified founder; their command runs on THEIR device.
          if (path.startsWith("/screen/command") && (await commandRoute({ path, method, url, body, principal, req, res, service: commands, send, memoryCaller: sharedMemory?.principalFor(req) ?? undefined }))) return;
          if (path === "/screen/act" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            let screenRequest;
            try {
              screenRequest = parseScreenRequest(body);
            } catch (error) {
              return send({ type: "done", ok: false, said: (error as Error).message, steps: 0, ms: 0, stepMs: [] }, 400);
            }
            const controller = new AbortController();
            // res, not req: a request's "close" fires once its body is read, not on disconnect.
            res.once("close", () => void (res.writableEnded || controller.abort()));
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/x-ndjson");
            res.setHeader("Cache-Control", "no-store");
            const write = (event: unknown) => void (res.writableEnded || res.write(`${JSON.stringify(event)}\n`));
            try {
              write(await screenHands.act(screenRequest, controller.signal, (event) => event.type !== "done" && write(event)));
            } catch (error) {
              write({ type: "done", ok: false, said: `Screen control failed: ${(error as Error).message}`.slice(0, 200), steps: 0, ms: 0, stepMs: [] });
            }
            res.end();
            return;
          }
          if (path === "/screen/stop" && method === "POST") {
            // His "stop": this person's running command jobs (any device) through the job service, and at
            // this PC the screen hands too.
            const jobs = await commands.cancelAllFor(principal).catch(() => [] as string[]);
            return send({ stopped: remote ? jobs.length > 0 : screenHands.stopAll() || jobs.length > 0, jobs });
          }
          // Lessons: Jarvis teaches a task with his own cursor (he clicks), or takes over (Jarvis acts).
          // Server role: Jarvis's lessons drive the screen, and the server has none: refused for every caller, honestly.
          if (await lessonRoute({ path, method, url, body, remote: remote ?? (hubRole() === "server" ? { name: "server" } : null), req, res, screen: screenHands, send: hubRole() === "server" ? (value, status) => send(status === 403 ? { error: "That drives a desktop; on the server use your own PC's companion." } : value, status) : send })) return;
          // Away mode: the OS card (status, on/off, stop, queue a task).
          if (await awayMode.route({ path, method, body, remote, send })) return;
          // Quick actions on /business (pins + run log) and the HUD's read-only feeds.
          if (await quickActionsRoute({ root, path, method, body, url, remote, send })) return;
          // Narrated-workflow skill drafts: review, edit, approve (installs the SKILL.md) or discard.
          if (await skillDraftsRoute({ root, path, method, body, remote: permRemote, send })) return;
          // Narrate my workflow: the voice client calls these once it gets a `narrate` tool_call
          // from free-voice.ts (start/stop), or polls status for a HUD "recording" indicator.
          // This PC only — a narration can hold a real transcript of what he or Mehroz said.
          if (path.startsWith("/narrate/")) {
            if (remote) return send({ error: "Narrate my workflow is only available at the PC itself." }, 403);
            if (method === "GET" && path === "/narrate/status") return send(narrate.status());
            if (method === "POST" && (path === "/narrate/start" || path === "/narrate/stop")) {
              try {
                const said = await handleNarrateCall(narrate, { action: path === "/narrate/start" ? "start" : "stop", topic: body?.topic });
                return send({ said });
              } catch (error) {
                return send({ error: (error as Error).message }, 400);
              }
            }
            return send({ error: "Unknown narrate route." }, 404);
          }
          // Screen vision: one frame he chose to share + his question → a spoken answer. The
          // frame exists only in this request (see scripts/vision.ts).
          if (path === "/vision/describe" && method === "POST") {
            try {
              return send(await describeScreen(root, parseVisionRequest(body)));
            } catch (error) {
              return send({ error: (error as Error).message }, 400);
            }
          }
          // Voice pc_act: open an app/folder, media keys, volume, lock, with no agent (~0.3 s).
          if (path === "/pc/act" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            try {
              return send(await pcAct(parsePcRequest(body)));
            } catch (error) {
              return send({ ok: false, said: (error as Error).message }, 400);
            }
          }
          // Voice cad: an LLM writes a build123d script, run only in the sandbox venv on D:
          // (scripts/cad-hands.ts). Slower than pc_act (an LLM call plus a sandboxed build, well
          // under a minute) but still no Hermes agent turn.
          if (path === "/cad/act" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            try {
              const result = await cadAct(parseCadRequest(body));
              // Show him what got made: the job folder (STEP, STL, PNG render) in Explorer.
              if (result.ok && result.files) execFile("explorer.exe", [result.files.dir], { windowsHide: false }, () => undefined);
              return send(result);
            } catch (error) {
              return send({ ok: false, said: (error as Error).message }, 400);
            }
          }
          // Jarvis action audit: the browser posts one metadata-only entry per control_pc event.
          // sanitizeAuditEntry drops anything but ids, tier, approval, outcome, target basename and hashes.
          if (path === "/control/audit" && method === "POST") {
            if (remote) return send({ error: "The audit log is written at this PC only." }, 403);
            try {
              controlAudit.append(body);
              return send({ ok: true });
            } catch (error) {
              return send({ ok: false, error: (error as Error).message }, 400);
            }
          }
          const receiptReply = controlReceiptRoute({ path, method, url, remote: !!remote,
            authenticated: req.headers["x-claude-os-token"] === token, body }, () => controlExecution(root));
          if (receiptReply) return send(receiptReply.body, receiptReply.status);
          const fleetReceiptReply = modelFleetReceiptRoute({ path, method, url, remote: !!permRemote,
            authenticated: workAuthed(req.headers["x-claude-os-token"] === token) }, root);
          if (fleetReceiptReply) return send(fleetReceiptReply.body, fleetReceiptReply.status);
          // System > Models: catalogue, health and receipt totals (metadata only; scripts/model-router/api.ts).
          const routerReply = await modelRouterRoute({ path, method, remote: !!permRemote,
            authenticated: workAuthed(req.headers["x-claude-os-token"] === token) }, root);
          if (routerReply) return send(routerReply.body, routerReply.status);
          // Page-token-authenticated local endpoint. The model does not get it as a tool, and the
          // CLI consumes the task-bound nonce once. It is not proof a person said yes (audit A-M3).
          if (path === "/control/approval" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            try { return send(controlDispatchGate.issue(body, body?.confirmation)); }
            catch { return send({ error: "A valid task and fresh explicit approval are required." }, 403); }
          }
          // The warm gateway cannot confirm child cancellation. Do not dispatch here:
          // hand off to the owned CLI tree so disconnect/Stop can terminate the work.
          if (path === "/hermes/task" && method === "POST") {
            if (remote && deviceDenied({ executor: "hub", presence: true })) return;
            return send({ error: "Use the cancellable owned CLI route.", fallback: true }, 503);
          }
          // Voice `skill` (scripts/jarvis-skills): timers, reminders, time, maths, system info,
          // clipboard, notes, typing, windows. Someone signed in remotely gets only the pure answers.
          if (path === "/jarvis/skill" && method === "POST") {
            if (!jarvisSkills) return send({ ok: false, said: "Skills aren't running yet, sir." }, 503);
            // Server role: the hub's own desktop (clipboard, typing, windows) is not for anyone, so even the owner at the console gets the pure answers only.
            return send(await jarvisSkills.run(body, { remote: !!remote || hubRole() === "server" }));
          }
          if (path === "/jarvis/timers" && method === "GET") return send(jarvisSkills ? jarvisSkills.timers() : { now: new Date().toISOString(), items: [] });
          if (path === "/jarvis/settings" && method === "GET") return send(readJarvisSettings(root));
          if (path === "/jarvis/settings" && method === "POST") {
            if (permRemote) return send({ error: "Jarvis settings can only be changed at this PC." }, 403);
            try {
              const result = writeJarvisSettings(root, body ?? {});
              scheduleRegistry();
              return send(result);
            } catch (error) {
              return send({ error: (error as Error).message }, 400);
            }
          }
          // Jarvis interjections, status and protocols (scripts/jarvis-*.ts). Cron scripts post
          // events with the page token from GET /__token; only someone at this PC may post,
          // claim speech, change quiet mode or run a protocol.
          if (path === "/jarvis/events" && method === "GET") return send(jarvisEvents.list(url.searchParams.get("since"), { person: principal?.personId, local: !remote }));
          if (path === "/jarvis/status" && method === "GET") return send(await jarvisStatus.snapshot());
          if (path === "/jarvis/protocols" && method === "GET") return send({ runs: jarvisProtocols.runs() });
          if (path.startsWith("/jarvis/") && ["/jarvis/events", "/jarvis/events/claim", "/jarvis/quiet", "/jarvis/protocol", "/jarvis/protocol/step"].includes(path) && method === "POST") {
            if (permRemote) return send({ error: "Jarvis alerts and protocols are for this PC only." }, 403);
            try {
              if (path === "/jarvis/events") return send(jarvisEvents.submit(body));
              if (path === "/jarvis/events/claim") return send(jarvisEvents.claim(body));
              if (path === "/jarvis/quiet") {
                const result = jarvisEvents.setQuiet(body);
                jarvisStatus.invalidate();
                return send(result);
              }
              if (path === "/jarvis/protocol") {
                const result = await jarvisProtocols.run(body);
                jarvisStatus.invalidate();
                return send(result);
              }
              return send(jarvisProtocols.report(body));
            } catch (error) {
              return send({ error: (error as Error).message }, 400);
            }
          }
          if (path === "/capabilities" && method === "GET") {
            try {
              return send(JSON.parse(readFileSync(join(dataDirFor(root), "capabilities.json"), "utf8")));
            } catch {
              return send({ generatedAt: null, capabilities: [], firstBuildAfterMs: background ? 20_000 : null });
            }
          }
          // Agent jobs run Claude and Codex on this PC's own logins: the identity gate classifies
          // /__operator/agent-jobs as the hub owner's (scripts/identity/routes.ts), and C1's route keeps its
          // own refusal as defence in depth. "Remote" is the verified principal's, never a Host guess.
          if (
            await agentJobsRoute({
              path,
              method,
              body,
              remote: !!permRemote,
              // Server role: the gate-admitted founder's relay headers (Tailscale Serve) are expected, not a reason to refuse.
              serverWork: remote !== null && permRemote === null,
              headers: req.headers,
              service: nativeTasks!,
              send,
              requestedBy: { personId: principal.personId, displayName: principal.displayName, via: principal.via },
              // T3c: checks, answers and stops need a signed-in person; a task only ever drafts.
              human: hasVerifiedUiSession(principal as never),
            })
          )
            return;
          if (path === "/connections/skool" || path.startsWith("/connections/skool/")) {
            const result = await skool.handle(path, method, body);
            const sentReply = path === "/connections/skool/send" && (result as { status?: string }).status === "sent";
            if (method === "POST" && (path === "/connections/skool/sync" || path === "/connections/skool/connect" || sentReply)) {
              // Keep the unified inbox and its source-gated memory context current.
              // Full conversation history remains in the dedicated Skool reader.
              const state = load();
              const channels = skool.snapshot().channels.filter(channel => !sentReply || channel.id === body.id);
              if (updateSkoolInboxPreviews(state, channels)) save(state);
            }
            return send(result);
          }
          if (path.startsWith("/connections"))
            return send(await accounts.handle(path, method, body, res));
          if (path.startsWith("/meeting/")) {
            res.setHeader("Cache-Control", "no-store");
            try {
              // A remote principal can't name someone else as the speaker (body.by); at this PC the
              // owner's own choice stands, as before.
              if (remote && body && typeof body === "object") body.by = principal.personId;
              return send(await meetings.api.handle(path, method, body, { person: remote?.personId ?? null }));
            } catch (error) {
              return send({ error: (error as Error).message }, (error as { status?: number }).status ?? 400);
            }
          }
          if (path.startsWith("/voice/")) {
            res.setHeader("Cache-Control", "no-store");
            if (path === "/voice/memory/read" && method === "POST") return send(voiceRecall.read(body.id, body.query));
            if (path === "/voice/recent-meetings" && method === "POST") return send(await voiceRecall.meetings(body.query || ""));
            if (path === "/voice/recent-emails" && method === "POST") return send(await recentVoiceMail.recent());
            if (path === "/voice/recent-creations" && method === "POST") return send(recentVoiceCreations.list());
            if (path.startsWith("/voice/creations/") && method === "GET") {
              try {
                const image = recentVoiceCreations.image(decodeURIComponent(path.slice("/voice/creations/".length)));
                res.setHeader("Content-Type", image.mimeType); res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Length", image.bytes.length); res.end(image.bytes); return;
              } catch { return send({ error: "This creation is no longer available." }, 404); }
            }
            if (path === "/voice/local-images/search" && method === "POST") return send(await localVoiceImages.search(body.query));
            if (path.startsWith("/voice/local-images/") && method === "GET") {
              try {
                const image = localVoiceImages.image(decodeURIComponent(path.slice("/voice/local-images/".length)));
                res.setHeader("Content-Type", image.mimeType); res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Length", image.bytes.length); res.end(image.bytes); return;
              } catch { return send({error:"Image not available."}, 404); }
            }
            if (path === "/voice/images" && method === "GET") return send(memoryImages.list());
            if (path.startsWith("/voice/images/") && method === "GET") {
              try {
                const image = memoryImages.image(decodeURIComponent(path.slice("/voice/images/".length)));
                res.setHeader("Content-Type", image.mimeType); res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Length", image.bytes.length); res.end(image.bytes); return;
              } catch { return send({ error: "Image not available." }, 404); }
            }
            if (path === "/voice/free/status" && method === "GET") return send(freeVoice.status());
            // First sentence of a reply as raw PCM while ElevenLabs is still producing it, so
            // Jarvis starts talking in ~0.3 s. { stream: false } tells the client to use /tts.
            if (path === "/voice/free/tts-stream" && method === "POST") {
              const out = await freeVoice.speakStream(body).catch(() => null);
              if (!out) return send({ stream: false });
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/octet-stream");
              res.setHeader("X-Sample-Rate", String(out.sampleRate));
              const reader = out.stream.getReader();
              // res, not req: a request's "close" fires once its body is read, not on disconnect.
              res.once("close", () => void (res.writableEnded || reader.cancel().catch(() => undefined)));
              try {
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  res.write(value);
                }
              } catch { /* he interrupted, or ElevenLabs dropped: the client falls back */ }
              res.end();
              return;
            }
            if (remote && path.startsWith("/voice/free/") && method === "POST") {
              // The hub's own voice settings are this PC's; change them at the PC.
              if (path === "/voice/free/configure" && deviceDenied({ executor: "hub", presence: true })) return;
              // A spoken yes approves actions on THIS PC; only speech at this PC can mint one.
              if (path === "/voice/free/stt" && body && typeof body === "object") body.turn = false;
              // Away mode runs tasks on this PC's screen: arming it or queueing work is device control.
              const said = Array.isArray(body?.messages) ? body.messages.filter((m: { role?: unknown }) => m?.role === "user").pop()?.content : "";
              if (path === "/voice/free/turn" && typeof said === "string" && awayVoiceIntent(said)) {
                const decision = authorise(principal, { kind: "device", executor: "hub", presence: true }, "control");
                if (!decision.ok) return send({ content: `${decision.reason} Away mode is for the PC it runs on.`, model: "rules" });
              }
            }
            // Track 2: the voice turn learns from the VERIFIED principal whether the speaker is at this PC,
            // so a remote founder's device actions go to his own device (never a client-sent flag).
            if (path === "/voice/free/turn" && method === "POST" && body && typeof body === "object" && !Array.isArray(body)) body.remote = !!remote;
            if (path.startsWith("/voice/free/") && method === "POST")
              return send(await freeVoice.handle(path, body, path === "/voice/free/turn" ? (sharedMemory?.principalFor(req) ?? undefined) : undefined));
            if (path === "/voice/openai/status" && method === "GET") return send(openaiVoice.status());
            if (path.startsWith("/voice/openai/") && method === "POST") return send(await openaiVoice.handle(path, body));
            if (path === "/voice/status" && method === "GET") return send(companionVoice.status());
            if (path === "/voice/setup" && method === "GET") return send(companionVoice.setup());
            if (method === "POST") return send(await companionVoice.handle(path, body));
          }
          if (method === "GET" && path === "/private-advisor") return send(privateAdvisorStatus(root));
          // A page read never builds the catalogue (building starts Codex and Claude; T8c). A GET answers with
          // the last build made with the CURRENT key, or notChecked, and ignores "?refresh=1": no GET can start
          // a provider check. The explicit check is POST /models/refresh (the model pickers' refresh and
          // System's Check again, both clicks), hub-only (HUB_CONNECTOR_WRITE refuses remote callers before
          // this line). The server also re-checks on its own schedule.
          if (method === "GET" && path === "/models" && url.searchParams.get("snapshot") === "1") {
            const last = peekAssistantCatalog(root, modelKey());
            return send({ ...last, checkedAt: last.builtAt ?? null });
          }
          if (method === "GET" && path === "/models") return send(peekAssistantCatalog(root, modelKey()));
          if (method === "POST" && path === "/models/refresh") {
            // { background: true } starts the check and answers at once ("checking": the page polls);
            // otherwise the answer waits for the fresh catalogue.
            const build = assistantCatalog(root, modelKey(), { refresh: true });
            if (body?.background === true) {
              build.catch(() => undefined);
              return send({ ...peekAssistantCatalog(root, modelKey()), checking: true });
            }
            return send(await build);
          }
          if (path === "/conversations" && method === "GET")
            return send({ conversations: conversations.list({ personId: principal.personId, hub: isAtHub(principal) }) });
          if (path === "/conversations" && method === "POST")
            return send({ conversation: conversations.save(body, { personId: principal.personId, hub: isAtHub(principal) }) });
          const conversationMatch = path.match(/^\/conversations\/([\w-]+)$/);
          if (conversationMatch && method === "POST" && body.action === "delete")
            return send(conversations.remove(conversationMatch[1], { personId: principal.personId, hub: isAtHub(principal) }));
          if (path === "/memory/apps" && method === "GET") return send(await apps.list(!permRemote && url.searchParams.get("refresh") === "1"));
          if (path === "/memory/apps/sync-all" && method === "POST") return send(await apps.syncAll(), 202);
          if (path === "/memory/apps/refresh-settings" && method === "POST") return send(apps.configureRefresh(body));
          const appMatch = path.match(/^\/memory\/apps\/([a-z]+)(?:\/(sync|import))?$/);
          if (appMatch && method === "POST") {
            if (appMatch[2] === "sync") return send(apps.start(appMatch[1], { catchUp: true }), 202);
            if (appMatch[2] === "import") return send(await apps.importExport(appMatch[1], body), 202);
            return send(apps.configure(appMatch[1], body));
          }
          if (path === "/memory/spaces" && method === "POST") {
            const state = load(), name = text(body.name, 61);
            if (name.length < 2 || name.length > 60) throw new Error("Name your space using 2–60 characters.");
            if (memorySpaces(state).some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error("A space with that name already exists.");
            const space = { id: "space-" + id(), name, color: /^#[a-f0-9]{6}$/i.test(body.color || "") ? body.color : "#c8afe9", description: text(body.description, 200), icon: text(body.icon, 40) || undefined };
            state.memorySpaces = [...(state.memorySpaces || []), space];save(state);return send({ space, spaces: memorySpaces(state) }, 201);
          }
          if (path === "/memory/search" && method === "GET") {
            const state = load(), terms = text(url.searchParams.get("q"), 500).toLowerCase().split(/\s+/).filter(Boolean), collection = url.searchParams.get("collection"), trash = url.searchParams.get("trash") === "1";
            if (collection && collection !== "all" && !memorySpaces(state).some((s) => s.id === collection)) throw new Error("Choose an existing memory space.");
            const found = state.sources.filter((s) => !!s.deletedAt === trash && (!collection || collection === "all" || s.collection === collection) && terms.every((term) => (s.title + " " + s.text).toLowerCase().includes(term)));
            return send({ ids: found.map((s) => s.id), total: found.length });
          }
          if (path === "/memory/connectors" && method === "GET")
            return send({
              connectors: ["codex", "claude"].map((provider) => {
                const listed = localMemoryFiles(provider, memoryHome);
                return {
                  id: provider,
                  name: provider === "codex" ? "Codex" : "Claude",
                  available: listed.files.length > 0,
                  count: listed.files.length,
                  truncated: listed.truncated,
                };
              }),
              notion: { configured: !!notionToken() },
              imageOCR: {
                available: imageOCRAvailable(),
                engine: "Apple Vision · CPU text recognition",
              },
            });
          if (path === "/memory/local" && method === "GET") {
            const result = localMemoryFiles(url.searchParams.get("provider") || "", memoryHome);
            return send({ ...result, files: result.files.map(({ absolute, ...file }) => file) });
          }
          if (path === "/memory/import-local" && method === "POST") {
            const files = readLocalMemories(body.provider, body.ids, memoryHome);
            if (files.some((f) => f.text.trim().length < 15))
              throw new Error("A selected file has no readable memory text. Choose another file.");
            if (files.reduce((sum, f) => sum + f.text.length, 0) > 8000000)
              throw new Error("This batch is too large. Import fewer memory files at a time.");
            const results = files.map((f) =>
              importReady({
                title: f.title,
                text: f.text,
                origin: body.provider,
                collection: body.collection,
                connector: {
                  provider: body.provider,
                  itemId: f.id,
                  path: f.path,
                  syncedAt: now(),
                },
              }),
            );
            return send({
              added: results.filter((r) => !r.unchanged && !r.updated && !r.skipped).length,
              updated: results.filter((r) => r.updated).length,
              unchanged: results.filter((r) => r.unchanged).length,
              skipped: results.filter((r) => r.skipped).length,
              sources: results.map((r) => r.source),
            });
          }
          if (path === "/memory/granola-config" && method === "GET") return send(granola.status());
          if (path === "/memory/granola-config" && method === "POST") return send(await granola.configure(body.apiKey));
          if (path === "/memory/notion-config" && method === "POST") {
            const value = text(body.token, 1000);
            if (value && (!/^[A-Za-z0-9_-]+$/.test(value) || value.length < 20))
              throw new Error("Enter a valid Notion integration token.");
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const tmp = notionFile + "." + id();
            writeFileSync(tmp, JSON.stringify({ token: value }), { mode: 0o600 });
            renameSync(tmp, notionFile);
            return send({ configured: !!value });
          }
          if (path === "/memory/import-notion" && method === "POST") {
            const token = notionToken();
            if (!token) throw new Error("Connect Notion with an integration token first.");
            const page = await fetchNotionPage(token, text(body.url, 2000));
            return send(
              importReady({
                title: page.title,
                text: page.text,
                url: page.url,
                origin: "notion",
                collection: body.collection,
                connector: { provider: "notion", itemId: page.id, syncedAt: now() },
              }),
            );
          }
          if (method === "POST" && (path === "/chat" || path === "/private-advisor/chat")) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-store");
            res.flushHeaders();
            const controller = new AbortController();
            res.on("close", () => controller.abort());
            const emit = (event: string, data: string) => {
              if (!res.destroyed)
                res.write(
                  `event: ${event}\n${data
                    .split("\n")
                    .map((l) => `data: ${l}`)
                    .join("\n")}\n\n`,
                );
            };
            try {
              if (path === "/private-advisor/chat")
                await runPrivateAdvisor(root, body, controller.signal, part => emit("chunk", part));
              else await runAssistant(root, body, modelKey(), controller.signal, (part) =>
                emit("chunk", part),
              );
              emit("done", "");
            } catch (e) {
              emit("error", (e as Error).message);
            }
            res.end();
            return;
          }
          if (method === "GET" && path === "/profile") return send(personalProfile.read());
          if (method === "GET" && path === "/setup/discovery") return send(setupDiscovery(root, memoryHome));
          if (method === "POST" && path === "/setup/open-privacy") {
            // Opens the macOS Files and Folders privacy pane so the operator can allow Documents. No settings are changed here.
            // Windows reads the user's own Documents without a prompt, so nothing opens there and the caller gets a hint instead of an error.
            const privacy = privacyPaneAction();
            if (privacy.kind === "unsupported") throw new Error(privacy.message);
            if (privacy.kind === "not-needed") return send({ opened: false, hint: privacy.hint });
            const { spawn } = await import("node:child_process");
            spawn("open", [privacy.target], { stdio: "ignore", detached: true }).unref();
            return send({ opened: true });
          }
          // GET never starts Codex or Claude (T8c): the last answer, or "unchecked". The check is the POST below.
          if (method === "GET" && path === "/setup/connections") return send(existingConnections.peek());
          if (method === "POST" && path === "/setup/connections/check") return send(await existingConnections.read(true));
          if (method === "GET" && path === "/native-connections") return send(await nativeInbox.status());
          if (method === "GET" && path === "/calendar/native") return send(await nativeCalendar.status());
          if (method === "GET" && path === "/calendar/health") return send(await calendarHealth());
          if (method === "POST" && path === "/calendar/native/sync") return send(await nativeCalendar.sync(body));
          // Asking Codex about the calendar connection: explicit only; the GET above never does (T8c).
          if (method === "POST" && path === "/calendar/native/check") return send(await nativeCalendar.check());
          if (method === "POST" && path === "/calendar/native/disconnect") return send(nativeCalendar.disable());
          if (method === "POST" && path === "/native-connections/sync") return send(await nativeInbox.sync(body.providers, body.replaceSelection === true));
          // Asking Codex which mailboxes it can read: explicit only; the GET above never does (T8b).
          if (method === "POST" && path === "/native-connections/check") return send(await nativeInbox.check());
          if (method === "POST" && path === "/profile") {
            // Check the memory destination before committing profile changes.
            // A corrupt workspace must not produce a half-successful save.
            load();
            const profile = personalProfile.update(body);
            if (["name", "role", "about", "responsePreferences", "timeZone", "hourlyRate", "currency", "publicProfiles"].some(key => body[key] !== undefined)) {
              const content = [["Name", profile.name], ["Role", profile.role], ["About", profile.about], ["Response preferences", profile.responsePreferences], ["Timezone", profile.timeZone], ["Hourly value", profile.hourlyRate === null ? "" : `${profile.currency} ${profile.hourlyRate}`], ...(profile.publicProfiles || []).map(link => [link.label, `${link.url}${link.source ? ` (Source: ${link.source.title})` : ""}`])].filter(([,value]) => value).map(([label,value]) => `${label}: ${value}`).join("\n");
              importReady({ title: "Your personal profile", text: `Your personal profile\n${content}`, origin: "personal", collection: "personal", connector: { provider: "workspace-profile", itemId: "profile", syncedAt: now() } });
            }
            return send(profile);
          }
          if (path.startsWith("/inbox/triage")) {
            const handled = await inboxTriage.handle(method, path, body, !!permRemote);
            if (handled) return send(handled.value, handled.status);
          }
          if (method === "GET" && path === "/mail-archive/status") { getMailSync(); return send(archive.stats()); }
          if (method === "GET" && path === "/mail-archive/sync") return send(getMailSync().status());
          if (method === "POST" && path === "/mail-archive/sync") return send(await getMailSync().start(body.provider));
          if (method === "POST" && path === "/mail-archive/pause") return send(getMailSync().pause(body.provider));
          if (method === "POST" && path === "/mail-archive/provider-search") return send(await providerMail.search(body.provider, body.query, body.limit));
          if (method === "GET" && path === "/mail-archive/search") {
            const result = archive.search((url.searchParams.get("q") || "").slice(0,600), Number(url.searchParams.get("limit")) || 50, Number(url.searchParams.get("offset")) || 0, url.searchParams.get("provider") || "");
            return send({ ...result, items: result.items.map(item => ({ ...item, body: item.body.slice(0,6000), bodyTruncated: item.body.length > 6000 })) });
          }
          if (method === "GET" && path === "/mail-archive/message") {
            const id = url.searchParams.get("id") || "", saved = archive.get(id);
            const item = saved && nativeInbox.owns(saved.source, saved.account || "") ? await nativeInbox.message(id) : await providerMail.message(id);
            return item ? send({ item }) : send({ error: "That archived email was not found." },404);
          }
          if (path === "/chat/attachments" && method === "POST") return send({ attachment: await extractChatAttachment(root, body) });
          if (method === "GET" && path === "/state") {
            // A quiet copy must not declare the live server's in-flight imports dead.
            const interrupted = (s: MemorySource) => s.status === "indexing" && !jobs.has(s.id);
            if (!background || !peek().sources.some(interrupted)) {
              // The usual case: one parse and one serialised reply per workspace version, however
              // many windows poll (Track 8: this GET took 17 s live and stalled the event loop).
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              return res.end(stateCache.body("state", (state) => JSON.stringify(sourceExcerpts(state as OperatorState))));
            }
            const state = load();
            for (const s of state.sources)
              if (interrupted(s)) {
                s.status = "error";
                s.error = "Import interrupted by a restart. Retry this source.";
              }
            save(state);
            return send(sourceExcerpts(state));
          }
          if (method === "GET" && path === "/brain/context") {
            if (url.searchParams.get("view") === "graph") {
              if (!brainEnabled(readBrainPreferences(root), "business")) return send({ business: null });
              const workspace = business.read(), { personalPriorities, preferredName, quarterGoal: legacyQuarterGoal, ...profile } = workspace.profile;
              const latest = new Map();
              for (const snapshot of workspace.snapshots) latest.set(snapshot.platform, snapshot);
              return send({ business: { profile, audience: [...latest.values()], finances: workspace.finances,
                progress: businessGoalContext(workspace).progress } });
            }
            const state = peek(), workspace = business.read();
            const { personalPriorities, preferredName, quarterGoal: legacyQuarterGoal, ...profile } = workspace.profile;
            const latest = new Map();
            for (const snapshot of workspace.snapshots) latest.set(snapshot.platform, snapshot);
            return send({ ...sourceExcerpts(brainContext(state)),
              goals: brainEnabled(state, "business") ? businessGoalContext(workspace).goals : { longTerm: "", quarter: "", month: "", week: "", metrics: [] },
              business: brainEnabled(state, "business") ? { evidence: businessEvidence(workspace), profile, audience: [...latest.values()], finances: workspace.finances, progress: businessGoalContext(workspace).progress, content: (() => { const c = contentStudio.read(); return { recordedAt: c.recordedAt, sampling: c.sampling, insights: c.insights, videos: c.videos.map((v: any) => ({ id: v.id, title: v.title, publishedAt: v.publishedAt, url: v.url, views: v.views, commentCount: v.commentCount })) }; })() } : null,
              mailArchive: brainEnabled(state, "email") ? archive.stats() : null,
              personalProfile: brainEnabled(state, "personal") ? (({ avatar, onboardingStep, onboardingFlowVersion, onboardingCompletedAt, updatedAt, ...context }) => ({ personalPriorities, preferredName: updatedAt ? context.name : preferredName, ...context }))(personalProfile.read()) : null,
            });
          }
          if (method === "GET" && path === "/business/demo") return send(demoState());
          if (method === "POST" && path === "/business/demo") { businessDemo.save(body.enabled); return send(demoState()); }
          if (method === "GET" && path === "/business/brief/status") return send({ generating: briefGenerating, ...(briefGenerating && briefGeneratingSince ? { since: briefGeneratingSince } : {}), demo: demoActive(), model: briefModel.read().model });
          if (method === "GET" && path === "/business") return send(business.read());
          if (method === "GET" && path === "/business/today") return send(await today.read());
          // Allow-listed M&U facts from the Obsidian wiki (goals, target, clients' deals). Read-only.
          if (method === "GET" && path === "/business/wiki-facts") return send(readWikiFacts(resolveMemorySettings().vaultRoot));
          if (method === "GET" && path === "/business/brief") return send(displayedBrief().read());
          if (method === "GET" && path === "/business/brief/context") return send(morningBrief.collect());
          if (method === "GET" && path === "/business/brief/archive") {
            const report = displayedBrief().get(new URL(req.url || "/", "http://localhost").searchParams.get("id") || "");
            if (!report) throw new Error("That saved brief was not found.");
            return send(report);
          }
          if (method === "POST" && path === "/business/brief") return send(morningBrief.save(body));
          if (method === "POST" && path === "/business/brief/actions") return send(displayedBrief().setAction(body));
          if (method === "POST" && path === "/business/brief/schedule") return send(morningBrief.configureSchedule(body));
          if (method === "POST" && path === "/business/brief/refresh") {
            if (briefGenerating) throw new Error("A brief is already being prepared. Give it a moment, then reopen the report.");
            // An explicit choice must exist in the current catalog and is remembered for later
            // briefs, including the scheduled morning run. A remembered choice that has since
            // disappeared from the catalog falls back to the default lane instead of failing.
            const requestedModel = body.model === undefined || body.model === null ? undefined : checkedBriefModelKey(body.model);
            briefGenerating = true; briefGeneratingSince = now();
            try {
              const catalog = requestedModel ? await assistantCatalog(root, modelKey()) : undefined;
              const model = requestedModel && catalog ? briefModel.choose(requestedModel, catalog).key : briefModel.read().model?.key;
              return send(await generateBusinessBrief(root, modelKey(), body.timezone, undefined, { mode: demoActive() ? "demo" : "live", baseUrl: `http://127.0.0.1:${req.socket.localPort}`, token, model, catalog }));
            }
            finally { briefGenerating = false; briefGeneratingSince = ""; }
          }
          if (method === "GET" && path === "/business/content") return send(contentStudio.read());
          if (method === "POST" && path === "/business/content/sync") return send(await contentStudio.sync());
          if (method === "GET" && path === "/business/competitors") return send(competitorStudio.read());
          if (method === "POST" && path === "/business/competitors/sync") return send(await competitorStudio.sync(body.inputs));
          if (method === "POST" && path === "/business/progress") return send(business.progress(body));
          if (method === "GET" && path === "/business/integrations") return send({ integrations: discoverBusinessIntegrations() });
          if (method === "GET" && path === "/business/native-connections") return send(await nativeBusiness.status(url.searchParams.get("refresh") === "1"));
          if (method === "GET" && path === "/business/mercury/preview") return send(await nativeBusiness.balances());
          if (method === "POST" && path === "/business/mercury/sync") {
            if (businessSyncing.has("mercury")) throw new Error("Mercury is already refreshing.");
            businessSyncing.add("mercury");
            try {
              const snapshot = await nativeBusiness.financeSnapshot();
              const result = business.importFinances(snapshot);
              demoOffForLiveData(); syncBusinessMemory(result);
              return send({ accounts: result.finances.accounts.length, recordedAt: result.finances.recordedAt, monthlyIncome: result.finances.monthlyIncome ?? null, ...(snapshot.monthlyIncomeError ? { monthlyIncomeError: snapshot.monthlyIncomeError } : {}) });
            }
            finally { businessSyncing.delete("mercury"); }
          }
          // Legacy NAB via Basiq: /business/finance/{status,connect,sync,summary,import-csv}.
          // Fail closed before any config, provider, store or file access unless the code-owned
          // reviewed live authorisation admits the route (scripts/finance/legacy-admission.ts).
          const legacyNabReply = await handleLegacyNabRoute({ method, path, body }, {
            finance: () => financeSync, syncing: businessSyncing,
            importFinances: snapshot => { const imported = business.importFinances(snapshot); demoOffForLiveData(); syncBusinessMemory(imported); return imported; },
          });
          if (legacyNabReply) return send(legacyNabReply.body, legacyNabReply.status);
          // Stripe, read-only (see docs/STRIPE-FINANCE.md). Its own namespace and its own
          // stripe_* tables in finance.sqlite — kept separate from NAB's /business/finance/*
          // routes above rather than merged into business.importFinances, since Stripe's shape
          // (invoices, payouts, MRR) doesn't fit the bank-account snapshot those expect.
          if (method === "GET" && path === "/business/finance/stripe/status") {
            return send({ configured: stripeSync.configured(), keyStatus: stripeSync.keyStatus() });
          }
          if (method === "POST" && path === "/business/finance/stripe/sync") {
            if (businessSyncing.has("stripe")) throw new Error("Stripe is already refreshing.");
            if (!stripeSync.configured()) throw new Error(stripeSync.keyStatus().message ?? "Add a restricted Stripe key (rk_…) to ~/.config/agentic-os.env first, then reconnect.");
            businessSyncing.add("stripe");
            try {
              const result = await stripeSync.sync();
              return send({ summary: result.summary, matchedPayouts: result.matched, bankMatching: result.bankMatching });
            } finally { businessSyncing.delete("stripe"); }
          }
          if (method === "GET" && path === "/business/finance/stripe/summary") {
            return send(stripeSync.summary());
          }
          if (method === "POST" && path === "/business/youtube/channel") {
            if (businessSyncing.has("youtube")) throw new Error("YouTube is already refreshing.");
            businessSyncing.add("youtube");
            try {
              const channel = await configureYouTubeChannel(body.channel);
              let numbersSynced = false, videosSynced = false, videoCount = 0;
              const warnings: string[] = [];
              try { const result = business.importSnapshots(await syncBusinessIntegration("youtube")); demoOffForLiveData(); syncBusinessMemory(result); numbersSynced = true; }
              catch (error) { warnings.push((error as Error).message); }
              try { const content = await contentStudio.sync(); videoCount = content.videos.length; videosSynced = true; }
              catch (error) { warnings.push((error as Error).message); }
              return send({ channel, numbersSynced, videosSynced, videoCount, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
            } finally { businessSyncing.delete("youtube"); }
          }
          if (method === "POST" && path === "/business/sync") {
            if (!["skool", "youtube"].includes(body.provider)) throw new Error("Choose Skool or YouTube.");
            if (businessSyncing.has(body.provider)) throw new Error("This account is already refreshing.");
            businessSyncing.add(body.provider);
            try { const result = business.importSnapshots(await syncBusinessIntegration(body.provider)); demoOffForLiveData(); syncBusinessMemory(result); return send(result); }
            finally { businessSyncing.delete(body.provider); }
          }
          if (method === "POST" && path === "/business") {
            const result = business.update(body);
            if (body.profile) {
              if (typeof body.profile.quarterGoal === "string") {
                const state = load(); state.goals.quarter = result.profile.quarterGoal; save(state);
              }
              for (const origin of ["business", "personal"]) {
                const keys = origin === "business" ? ["businessName", "whatYouDo", "whoYouHelp", "quarterGoal", "longTermDirection"] : ["preferredName", "personalPriorities"];
                if (!keys.some((key) => typeof body.profile[key] === "string")) continue;
                const content = keys.filter((key) => result.profile[key]).map((key) => `${key}: ${result.profile[key]}`).join("\n");
                if (content.length >= 15) importReady({
                  title: origin === "business" ? "Your business profile" : "Your personal priorities",
                  text: content, origin, collection: origin,
                  connector: { provider: "business-setup", itemId: origin, syncedAt: now() },
                });
                else {
                  const state = load();
                  for (const s of state.sources) if (s.connector?.provider === "business-setup" && s.connector?.itemId === origin && !s.deletedAt) s.deletedAt = now();
                  save(state);
                }
              }
            }
            return send(result);
          }
          if (method === "POST" && path === "/business/snapshots") { const result = business.importSnapshots(body); demoOffForLiveData(); syncBusinessMemory(result); return send(result); }
          if (method === "POST" && path === "/business/finances") { const result = business.importFinances(body); demoOffForLiveData(); syncBusinessMemory(result); return send(result); }
          if (method === "POST" && path === "/memory/business/sync") return send(syncBusinessMemory());
          if (method === "GET" && path === "/memory/storage") return send(vault.status());
          if (method === "POST" && path === "/memory/storage/export") return send(await vault.export(() => load().sources));
          if (method === "GET" && path === "/memory/photo-index/status") return send(await photoIndex.status());
          if (method === "POST" && path === "/memory/photo-index/preview") return send(await photoIndex.preview(body));
          if (method === "POST" && path === "/memory/photo-index/uploads") return send(await photoIndex.upload(body));
          if (method === "POST" && path === "/memory/photo-index/jobs") return send(await photoIndex.start(body));
          const photoControl = path.match(/^\/memory\/photo-index\/jobs\/([^/]+)\/(pause|resume)$/);
          if (method === "POST" && photoControl) return send(await photoIndex.control(photoControl[1], photoControl[2]));
          if (method === "GET" && path === "/memory/photos") {
            const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 48);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 96) throw new Error("Choose a valid photo page.");
            return send(photos.catalog(url.searchParams.get("q") || "", offset, limit, peek().sources));
          }
          if (method === "POST" && path === "/memory/photos/import") {
            const state = load();
            if (body.collection && !memorySpaces(state).some(s => s.id === body.collection)) throw new Error("Choose an existing memory space.");
            const selected = photos.selected(body.ids), inputs: ReadySourceInput[] = [];
            let skipped = 0;
            for (const entry of selected) {
              const existing = state.sources.find(s => s.connector?.provider === "design-photos" && s.connector.itemId === entry.id);
              if (existing?.deletedAt) { skipped++; continue; }
              inputs.push({ ...photos.prepare(entry, existing?.id || id()), collection: collectionOf(body.collection || "content", state) });
            }
            const results = importReadyBatch(inputs);
            return send({ added: results.filter(r => !r.updated && !r.unchanged && !r.skipped).length, updated: results.filter(r => r.updated).length, unchanged: results.filter(r => r.unchanged).length, skipped: skipped + results.filter(r => r.skipped).length, sources: sourceExcerpts({ ...state, sources: results.map(r => r.source) }).sources });
          }
          const photoDesign = path.match(/^\/memory\/photos\/design\/([a-f0-9]{64})\/image$/);
          const photoSaved = path.match(/^\/memory\/photos\/([\w-]+)\/(image|thumbnail)$/);
          if (method === "GET" && (photoDesign || photoSaved)) {
            try {
              if (photoSaved) {
                if (!canReadSavedPhoto(photoSaved[1])) return send({ error: "Photo not available." }, 404);
              }
              const image = photoDesign ? photos.image(photoDesign[1]) : await readMemoryPhoto(root, photoSaved![1], photoSaved![2] === "thumbnail");
              if (photoSaved && !canReadSavedPhoto(photoSaved[1])) return send({ error: "Photo not available." }, 404);
              res.setHeader("Content-Type", image.mimeType); res.setHeader("Content-Length", image.bytes.length);
              res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store");
              res.end(image.bytes); return;
            } catch { return send({ error: "Photo not available." }, 404); }
          }
          if (method === "GET" && path === "/brain/sources") return send(readBrainPreferences(root));
          if (method === "POST" && path === "/brain/sources") {
            const ids: unknown[] = body.ids === undefined ? [body.id] : body.ids;
            if (!Array.isArray(ids) || !ids.length || ids.length > BRAIN_SOURCES.length ||
              (body.ids !== undefined && body.id !== undefined) || new Set(ids).size !== ids.length ||
              ids.some((id) => typeof id !== "string" || !BRAIN_SOURCES.some((s) => s.id === id)) ||
              typeof body.enabled !== "boolean")
              throw new Error("Choose a valid brain source and toggle state.");
            const state = readBrainPreferences(root);
            const changed = (ids as string[]).filter((id) => brainEnabled(state, id) !== body.enabled);
            if (changed.length) {
              state.brainSources = { ...state.brainSources, ...Object.fromEntries(changed.map((id) => [id, body.enabled])) };
              state.brainRevision = (state.brainRevision || 0) + 1;
              writeBrainPreferences(root, state);
            }
            return send({ ok: true, changed: changed.length > 0, ...state });
          }
          if (method === "GET" && path === "/files")
            return send({
              files: await findMemoryFiles(
                url.searchParams.get("q") || "",
                peek().hiddenMemoryTitles,
              ),
            });
          if (method === "GET" && path === "/search") {
            const workspace = peek();
            if (url.searchParams.get("recent") === "1") return send({ results: workspace.sources.filter(s => !s.deletedAt && !s.connector?.supersededAt && s.status === "ready" && brainEnabled(workspace, sourceOrigin(s))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,5).map(s => ({ id: s.id, title: s.title, excerpt: s.text.slice(0,1200), origin: sourceOrigin(s), createdAt: s.createdAt, collection: s.collection })) });
            const library = workspace.sources.filter((s) =>
                brainEnabled(workspace, sourceOrigin(s)),
              ),
              snapshot = resolve(root, "src/data/live-data.json");
            if (existsSync(snapshot)) {
              const live = JSON.parse(filterWorkspaceMemory(readFileSync(snapshot, "utf8"), root));
              if (!live.isExample)
                for (const g of brainEnabled(workspace, "obsidian")
                  ? live.memory?.knowledge?.graphs || []
                  : [])
                  for (const n of g.notes || [])
                    if (n.excerpt)
                      library.push({
                        id: `note:${g.vault}:${n.id}`,
                        title: n.title,
                        text: n.excerpt,
                        collection: "existing",
                        status: "ready",
                        updatedAt: live.generatedAt || "",
                        kind: "note",
                        pinned: false,
                        hash: "",
                        words: 0,
                        createdAt: "",
                      });
            }
            if (existsSync(snapshot)) {
              const live = JSON.parse(filterWorkspaceMemory(readFileSync(snapshot, "utf8"), root));
              const metadata = (recordId: string, title: string, content: string, origin: string) =>
                library.push({
                  id: recordId,
                  title,
                  text: content,
                  origin,
                  collection: "existing",
                  kind: "note",
                  status: "ready",
                  updatedAt: live.generatedAt || "",
                  createdAt: "",
                  pinned: false,
                  hash: "",
                  words: 0,
                });
              if (!live.isExample) {
                for (const n of live.memory?.nodes || [])
                  if (
                    n.kind !== "hub" &&
                    n.source &&
                    brainEnabled(workspace, nodeOrigin(n)) &&
                    n.source !== "obsidian"
                  )
                    metadata(
                      `mapped:${n.id}`,
                      n.name,
                      `Mapped source metadata only; the file contents have not been loaded. Source: ${nodeOrigin(n)}. ${n.meta || ""}. ${n.name}`,
                      nodeOrigin(n),
                    );
                if (brainEnabled(workspace, "skills"))
                  for (const skill of live.skills?.active || [])
                    metadata(
                      `skill:${skill.name}`,
                      skill.name,
                      `Available skill metadata only: ${skill.name}. Uses in the past week: ${skill.uses7d || 0}. Instructions are not loaded here.`,
                      "skills",
                    );
                if (brainEnabled(workspace, "agents") && live.hermes?.installed)
                  metadata(
                    "agent:hermes",
                    "Hermes agent",
                    "Hermes is installed. This entry describes availability only; its private memory is not imported.",
                    "agents",
                  );
              }
            }
            const addContext = (id: string, title: string, body: string, origin: string) =>
              library.push({
                id,
                title,
                text: body,
                origin,
                collection: "existing",
                kind: "note",
                status: "ready",
                updatedAt: now(),
                createdAt: "",
                pinned: false,
                hash: "",
                words: 0,
              });
            if (brainEnabled(workspace, "email"))
              for (const m of workspace.inbox)
                addContext(`inbox:${m.id}`, m.subject, `From: ${m.from}\n${m.body}`, "email");
            if (brainEnabled(workspace, "meetings"))
              for (const e of workspace.events)
                addContext(
                  `event:${e.id}`,
                  e.title,
                  `${e.start}\n${e.notes}\n${e.actions.map((a) => a.text).join("\n")}`,
                  "meetings",
                );
            const query = url.searchParams.get("q") || "";
            // A follow-up passes the window and app it inherited from the previous question.
            const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to")), label = url.searchParams.get("label") || "";
            const window = from > 0 && to > from && label ? { label: label.slice(0, 120), start: from, end: to } : chatTimeWindow(query);
            const apps = (url.searchParams.get("apps") || "").split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[a-z]{2,20}$/.test(id)).map((id) => ({ id, name: appDisplayName(id) }));
            return send({
              ...searchMemory(library, query, url.searchParams.get("collection") || undefined, window, { focus: apps.length ? apps : undefined }),
              window,
            });
          }
          if (method === "GET" && path === "/news") {
            if (!newsCache || Date.now() - newsCache.at > 10 * 60 * 1000) {
              const response = await fetch(
                "https://ask-jack-api-production.up.railway.app/api/news?limit=16&sources=rundown&days=3",
                { signal: AbortSignal.timeout(15000) },
              );
              if (!response.ok)
                throw new Error("AI with Jack's news feed is unavailable. Try again shortly.");
              const data = await response.json();
              if (!Array.isArray(data.articles))
                throw new Error("The news feed returned an unexpected response.");
              newsCache = {
                at: Date.now(),
                data: { articles: data.articles, fetchedAt: now(), source: "aiwithjack.com" },
              };
            }
            return send(newsCache.data);
          }
          if (method === "POST" && path === "/goals") {
            const state = load();
            if (!Array.isArray(body.metrics) || body.metrics.length > 5)
              throw new Error("Choose up to five core metrics.");
            state.goals = {
              longTerm: text(body.longTerm, 3000),
              quarter: text(body.quarter, 3000),
              week: text(body.week, 3000),
              metrics: body.metrics.map((m: any) => {
                if (
                  !["leading", "lagging"].includes(m.kind) ||
                  !text(m.label, 120) ||
                  !Number.isFinite(m.value) ||
                  !Number.isFinite(m.target) ||
                  m.target <= 0
                )
                  throw new Error("Each metric needs a name, a number and a positive target.");
                return {
                  id: text(m.id, 100) || id(),
                  label: text(m.label, 120),
                  kind: m.kind,
                  value: m.value,
                  target: m.target,
                  unit: text(m.unit, 30),
                };
              }),
            };
            save(state);
            const updatedBusiness = business.update({ profile: { quarterGoal: state.goals.quarter } });
            const profileText = ["businessName", "whatYouDo", "whoYouHelp", "quarterGoal", "longTermDirection"].filter((key) => updatedBusiness.profile[key]).map((key) => `${key}: ${updatedBusiness.profile[key]}`).join("\n");
            if (profileText.length >= 15) importReady({ title: "Your business profile", text: profileText, origin: "business", collection: "business", connector: { provider: "business-setup", itemId: "business", syncedAt: now() } });
            else {
              const current = load();
              for (const source of current.sources) if (source.connector?.provider === "business-setup" && source.connector.itemId === "business" && !source.deletedAt) source.deletedAt = now();
              save(current);
            }
            return send(state.goals);
          }
          if (method === "POST" && path === "/memory/hide-existing") {
            const state = load();
            const title = text(body.title, 500).toLowerCase();
            if (!title) throw new Error("Choose a source title.");
            state.hiddenMemoryTitles = [...new Set([...state.hiddenMemoryTitles, title])];
            save(state);
            return send({ ok: true });
          }
          if (method === "POST" && path === "/settings") {
            // Only known switches, with the right types: {"news":"yes"} used to answer 200 unchanged (Audit F5 P2-3).
            const settingsError = operatorSettingsError(body);
            if (settingsError) return send({ error: settingsError }, 400);
            const state = load();
            for (const key of [
              "mission",
              "openclaw",
              "news",
              "inboxAutoRead",
              "inboxShowAccounts",
              "inboxShowCategories",
            ] as const)
              if (typeof body[key] === "boolean") state.settings[key] = body[key];
            if (body.inboxAccounts && typeof body.inboxAccounts === "object") {
              const enabled = {
                gmail: true,
                outlook: true,
                capture: true,
                slack: true,
                skool: true,
                ...state.settings.inboxAccounts,
              };
              for (const provider of ["gmail", "outlook", "capture", "slack", "skool"] as const)
                if (typeof body.inboxAccounts[provider] === "boolean")
                  enabled[provider] = body.inboxAccounts[provider];
              state.settings.inboxAccounts = enabled;
            }
            save(state);
            return send(state.settings);
          }
          if (method === "POST" && path === "/memory") {
            if (body.localFileId) {
              const path = allowedMemoryFile(
                Buffer.from(text(body.localFileId, 4000), "base64url").toString(),
                load().hiddenMemoryTitles,
              );
              body = {
                ...body,
                filename: basename(path),
                base64: readFileSync(path).toString("base64"),
              };
            }
            // A bank export uploaded directly (not from a local file) is refused the same way.
            if (typeof body.base64 === "string" && /\.(csv|txt)$/i.test(String(body.filename ?? "")) &&
                looksLikeBankTransactions(Buffer.from(body.base64.slice(0, 12_000), "base64").toString("utf8")))
              return send({ error: BANK_EXPORT_REFUSAL }, 400);

            const state = load(),
              urlValue = text(body.url, 2000);
            if (urlValue && !/^https?:\/\//i.test(urlValue))
              throw new Error("Enter an HTTP or HTTPS source URL.");
            const content = text(body.text, 600000);
            if (!urlValue && !body.base64 && content.length < 15)
              throw new Error("Add at least 15 characters of source text.");
            const hash = digest(urlValue || body.base64 || content);
            const duplicate = state.sources.find(
              (s) => !s.deletedAt && (s.hash === hash || (!!urlValue && s.url === urlValue)),
            );
            if (duplicate) return send({ source: duplicate, duplicate: true });
            if (body.collection && !memorySpaces(state).some((s) => s.id === body.collection)) throw new Error("Choose an existing memory space.");
            const collection = collectionOf(body.collection, state);
            const kind =
              body.kind && ["note", "article", "video", "document", "meeting"].includes(body.kind)
                ? body.kind
                : urlValue
                  ? /youtu/.test(urlValue)
                    ? "video"
                    : "article"
                  : body.filename
                    ? "document"
                    : "note";
            const source: MemorySource = {
              id: id(),
              title:
                text(body.title, 200) ||
                text(body.filename, 200) ||
                (urlValue ? new URL(urlValue).hostname : "Untitled note"),
              kind,
              extraction: imageFile(body.filename || "") ? "local-ocr" : undefined,
              origin: BRAIN_SOURCES.some((s) => s.id === body.origin)
                ? body.origin
                : imageFile(body.filename || "")
                  ? "images"
                  : /\.eml$/i.test(body.filename || "")
                    ? "email"
                    : kind === "meeting"
                      ? "meetings"
                      : kind === "article" || kind === "video"
                        ? "web"
                        : kind === "document"
                          ? "files"
                          : "manual",
              collection,
              text: content,
              url: urlValue || undefined,
              filename: text(body.filename, 200) || undefined,
              createdAt: now(),
              updatedAt: now(),
              status: "indexing",
              pinned: false,
              words: 0,
              hash,
            };
            state.sources.unshift(source);
            save(state);
            void ingest(source, body);
            return send({ source }, 201);
          }
          const memoryMatch = path.match(/^\/memory\/([\w-]+)$/);
          if (memoryMatch && method === "GET") {
            const source = peek().sources.find((s) => s.id === memoryMatch[1]);
            return source ? send({ source }) : send({ error: "Source not found" }, 404);
          }
          if (memoryMatch && method === "POST") {
            const state = load(),
              source = state.sources.find((s) => s.id === memoryMatch[1]);
            if (!source) return send({ error: "Source not found" }, 404);
            if (body.action === "trash" || body.action === "restore") {
              source.deletedAt = body.action === "trash" ? now() : undefined;
              if (source.connector) source.connector.supersededAt = undefined;
            }
            else if (body.action === "retry") {
              if (jobs.has(source.id)) return send({ source });
              source.status = "indexing";
              source.error = undefined;
              save(state);
              void ingest(source, {});
              return send({ source });
            } else {
              if (typeof body.title === "string")
                source.title = text(body.title, 200) || source.title;
              if (typeof body.text === "string") {
                source.text = text(body.text, 600000);
                if (source.text.length < 15)
                  throw new Error("Add at least 15 characters of source text.");
                source.status = "ready";
                source.error = undefined;
                source.words = source.text.split(/\s+/).length;
                source.hash = digest(source.text);
              }
              if (typeof body.pinned === "boolean") source.pinned = body.pinned;
              if (body.collection !== undefined) {
                if (!memorySpaces(state).some((s) => s.id === body.collection)) throw new Error("Choose an existing memory space.");
                source.collection = body.collection;
              }
            }
            source.updatedAt = now();
            save(state);
            return send({ source });
          }
          if (path === "/inbox/ask" && method === "POST") {
            const controller = new AbortController();
            const closed = () => { if (!res.writableEnded) controller.abort(); };
            res.once("close", closed);
            try { return send(await inboxAsk.ask(body, controller.signal)); }
            finally { res.removeListener("close", closed); }
          }
          if (path === "/inbox/import" && method === "POST") {
            const state = load();
            const result = importInboxSnapshot(state, body);
            save(state);
            return send(result);
          }
          if (path === "/inbox" && method === "POST") {
            const state = load();
            const existing = body.id ? state.inbox.find((x) => x.id === body.id) : undefined;
            if (body.id && !existing) return send({ error: "Message not found" }, 404);
            if (existing) {
              if (typeof body.starred === "boolean") existing.starred = body.starred;
              if (typeof body.read === "boolean") {
                existing.read = body.read;
                existing.readOverride = true;
              }
              if (["open", "done"].includes(body.status)) existing.status = body.status;
              if (typeof body.draft === "string") existing.draft = text(body.draft, 100000);
              if (typeof body.draftTo === "string") existing.draftTo = text(body.draftTo, 4000);
              if (typeof body.draftCc === "string") existing.draftCc = text(body.draftCc, 4000);
              if (typeof body.draftBcc === "string") existing.draftBcc = text(body.draftBcc, 4000);
              if (["needs-you", "sponsors", "waiting", "updates"].includes(body.category))
                existing.category = body.category;
            } else {
              if (!text(body.subject) || !text(body.body))
                throw new Error("Add a subject and message.");
              state.inbox.unshift({
                id: id(),
                from: text(body.from, 300) || "Quick capture",
                subject: text(body.subject, 250),
                body: text(body.body, 100000),
                receivedAt: now(),
                category: ["needs-you", "sponsors", "waiting", "updates"].includes(body.category)
                  ? body.category
                  : "needs-you",
                status: "open",
                source: "capture",
                read: false,
              });
            }
            save(state);
            return send({ ok: true });
          }
          if (path === "/calendar" && method === "POST") {
            const state = load();
            let event = state.events.find((e) => e.id === body.id);
            if (body.action === "delete") {
              state.events = state.events.filter((e) => e.id !== body.id);
              save(state);
              return send({ ok: true });
            }
            if (body.id && !event) return send({ error: "Event not found" }, 404);
            if (event) {
              if (typeof body.notes === "string") event.notes = text(body.notes);
              if (Array.isArray(body.actions))
                event.actions = body.actions.slice(0, 100).map((a: any) => ({
                  id: text(a.id, 50) || id(),
                  text: text(a.text, 1000),
                  done: a.done === true,
                }));
            } else {
              const start = new Date(body.start),
                end = new Date(body.end);
              if (
                !text(body.title) ||
                !Number.isFinite(+start) ||
                !Number.isFinite(+end) ||
                end <= start
              )
                throw new Error("Add a title and an end time after the start.");
              event = {
                id: id(),
                title: text(body.title, 250),
                start: start.toISOString(),
                end: end.toISOString(),
                allDay: body.allDay === true,
                location: text(body.location, 1000),
                attendees: text(body.attendees, 2000),
                notes: text(body.notes),
                source: "local",
                actions: [],
              };
              state.events.push(event);
            }
            save(state);
            return send({ event });
          }
          if (path === "/calendar/import" && method === "POST") {
            const raw = text(body.ics, 1000000);
            if (!raw.includes("BEGIN:VCALENDAR")) throw new Error("Choose an .ics calendar file.");
            const parsed = ical.sync.parseICS(raw),
              state = load();
            const rangeStart = body.timeMin
              ? new Date(body.timeMin)
              : new Date(Date.now() - 90 * 86400000);
            const rangeEnd = body.timeMax
              ? new Date(body.timeMax)
              : new Date(Date.now() + 365 * 86400000);
            if (
              !Number.isFinite(+rangeStart) ||
              !Number.isFinite(+rangeEnd) ||
              rangeStart >= rangeEnd ||
              +rangeEnd - +rangeStart > 740 * 86400000
            )
              throw new Error("Choose a recurrence range of up to two years.");
            const imported: CalendarEvent[] = [],
              recurringUids = new Set<string>(),
              cancelledUids = new Set<string>();
            let added = 0,
              updated = 0,
              recurring = 0;
            const dateOnly = (date: Date & { tz?: string }) => {
              const parts = new Intl.DateTimeFormat("en-CA", {
                timeZone: date.tz || "UTC",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).formatToParts(date);
              const part = (type: string) => parts.find((p) => p.type === type)?.value;
              return `${part("year")}-${part("month")}-${part("day")}T00:00:00`;
            };
            for (const entry of Object.values(parsed) as any[]) {
              if (entry.type !== "VEVENT" || !entry.uid) continue;
              if (entry.status === "CANCELLED") {
                cancelledUids.add(entry.uid);
                continue;
              }
              if (!entry.start) continue;
              const recurrence = !!entry.rrule;
              if (recurrence) {
                recurring++;
                recurringUids.add(entry.uid);
                const rule = entry.rrule.options;
                if (rule.freq >= 4 && (!rule.count || rule.count > 5000))
                  throw new Error(
                    "This calendar repeats more frequently than daily. Export individual occurrences or limit the series to 5,000 events.",
                  );
              }
              const instances = ical.expandRecurringEvent(entry, {
                from: recurrence ? rangeStart : new Date(+entry.start - 1),
                to: recurrence ? rangeEnd : new Date(+entry.end || +entry.start + 86400000),
                includeOverrides: true,
                excludeExdates: true,
                expandOngoing: true,
              });
              for (const instance of instances) {
                if (instance.event.status === "CANCELLED") continue;
                const originalDate =
                  instance.isOverride && instance.event.recurrenceid
                    ? instance.event.recurrenceid
                    : instance.start;
                const sourceUid = recurrence
                  ? `${entry.uid}::${new Date(originalDate).toISOString()}`
                  : entry.uid;
                const old = state.events.find(
                  (e) => e.source === "ics" && e.sourceUid === sourceUid,
                );
                imported.push({
                  id: old?.id || id(),
                  title:
                    text(
                      typeof instance.summary === "object"
                        ? instance.summary?.val
                        : instance.summary,
                      250,
                    ) || "Calendar event",
                  start: instance.isFullDay
                    ? dateOnly(instance.start)
                    : instance.start.toISOString(),
                  end: instance.isFullDay ? dateOnly(instance.end) : instance.end.toISOString(),
                  allDay: instance.isFullDay,
                  location: text(instance.event.location, 1000),
                  notes: old?.notes || text(instance.event.description),
                  actions: old?.actions || [],
                  source: "ics",
                  sourceUid,
                  importedAt: now(),
                });
                if (old) updated++;
                else added++;
                if (imported.length > 10000)
                  throw new Error(
                    "This calendar contains more than 10,000 occurrences. Import a shorter date range.",
                  );
              }
            }
            const importedIds = new Set(imported.map((event) => event.id));
            state.events = [
              ...state.events.filter((event) => {
                if (importedIds.has(event.id)) return false;
                if (event.source !== "ics" || !event.sourceUid) return true;
                if (
                  [...cancelledUids].some(
                    (uid) => event.sourceUid === uid || event.sourceUid!.startsWith(uid + "::"),
                  )
                )
                  return false;
                const matchesSeries = [...recurringUids].some((uid) =>
                  event.sourceUid!.startsWith(uid + "::"),
                );
                if (
                  matchesSeries &&
                  Date.parse(event.start) < +rangeEnd &&
                  Date.parse(event.end) > +rangeStart
                )
                  return false;
                return true;
              }),
              ...imported,
            ];
            save(state);
            return send({
              added,
              updated,
              recurring,
              timeMin: rangeStart.toISOString(),
              timeMax: rangeEnd.toISOString(),
              message: recurring
                ? `${recurring} recurring series expanded, including exceptions, from ${rangeStart.toISOString().slice(0, 10)} to ${rangeEnd.toISOString().slice(0, 10)}.`
                : "Calendar snapshot saved; re-import to refresh.",
            });
          }
          if (path === "/workspace/decision" && method === "POST") {
            return send(saveDecision(root, body, principal.personId));
          }
          if (path.startsWith("/leads/")) {
            // Activity history shows who did it, from the verified principal. At this PC the owner's
            // own "log as" choice stands (one shared machine); remotely, `by` is always the signer.
            if (remote && method === "POST" && body && typeof body === "object" && !Array.isArray(body)) body.by = principal.personId;
            return send(await leadsApi.handle(path, method, body, url.searchParams, !!permRemote));
          }
          if (path === "/triggers" || path.startsWith("/triggers/")) {
            const service = triggers.get();
            if (!service) return send(method === "GET" ? { triggers: [], poll: null } : { error: "This is a quiet read-only copy." }, method === "GET" ? 200 : 409);
            const result = await service.handle(path, method, body as Record<string, unknown> | undefined, !permRemote);
            return send(result.body, result.status);
          }
          if (path === "/automations" && method === "GET")
            return send({ automations: await automations.list(url.searchParams.get("refresh") === "1"), ...automations.state() });
          if (path === "/automations/run" && method === "POST") {
            if (permRemote) return send({ error: "Automations can only be run from this PC." }, 403);
            return send(await automations.runNow(String(body?.name ?? "")));
          }
          if (path === "/automations/pause" && method === "POST") {
            if (permRemote) return send({ error: "Automations can only be changed from this PC." }, 403);
            return send(await automations.pause(String(body?.name ?? "")));
          }
          if (path === "/automations/resume" && method === "POST") {
            if (permRemote) return send({ error: "Automations can only be changed from this PC." }, 403);
            return send(await automations.resume(String(body?.name ?? "")));
          }
          return send({ error: "Unknown workspace endpoint" }, 404);
        } catch (error) {
          // 413 for an oversize body, 503 when Hermes or a worker isn't running, 409/403 as before;
          // everything else is the caller's input (Audit F5 P3).
          const status = operatorErrorStatus(error, { conflict: ConversationConflict, localOnly: LocalOnly, forbidden: ConversationForbidden });
          if (status === 413) req.resume();
          return send({ error: (error as Error).message || "The request failed." }, status);
        }
      });
    },
    closeBundle() {
      // Each store closes on its own: one that is still locked (mail archive on a busy or shared file) is reported, and never
      // skips the rest or turns a finished build into exit 1.
      const steps: Array<[string, () => void]> = [["apps", () => apps.stop()], ["vault", () => vault.stop()], ["photo index", () => photoIndex.close()], ["mail sync", () => mailSync?.close()], ["existing connections", () => existingConnections.close()], ["native tasks", () => nativeTasks?.close()], ["mail archive", () => archive.close()], ["leads", () => leadsApi.close()]];
      for (const [name, close] of steps) {
        try { close(); } catch (e) { console.warn(`[closeBundle] ${name} did not close cleanly: ${(e as Error).message}`); }
      }
    },
  };
}

/** hiddenMemoryTitles per workspace file version: /__live-data calls this on every read, and the
 *  file is tens of MB, so it is parsed once per version, not per request (Track 8). */
const hiddenTitlesCache = new Map<string, { stamp: string; hidden: Set<string> }>();
function hiddenMemoryTitles(file: string): Set<string> {
  const stamp = filesStamp([file]);
  const cached = hiddenTitlesCache.get(file);
  if (cached?.stamp === stamp) return cached.hidden;
  const hidden = new Set<string>(
    (JSON.parse(readFileSync(file, "utf8")).hiddenMemoryTitles || []).map((x: string) =>
      x.toLowerCase(),
    ),
  );
  hiddenTitlesCache.set(file, { stamp, hidden });
  return hidden;
}

// Exclusions belong to this workspace, never to the original vault files.
export function filterWorkspaceMemory(raw: string, root: string) {
  const file = resolve(dataDirFor(root), "workspace.json");
  if (!existsSync(file)) return raw;
  const hidden = hiddenMemoryTitles(file);
  if (!hidden.size) return raw;
  const d = JSON.parse(raw),
    m = d.memory;
  if (!m) return raw;
  const match = (n: any) =>
    [n.id, n.name, n.title].some((x) => hidden.has(String(x || "").toLowerCase()));
  m.nodes = (m.nodes || []).filter((n: any) => !match(n));
  const ids = new Set(m.nodes.map((n: any) => n.id));
  m.links = (m.links || []).filter((l: any) => ids.has(l.source) && ids.has(l.target));
  for (const g of m.knowledge?.graphs || []) {
    g.notes = (g.notes || []).filter((n: any) => !match(n));
    const keep = new Set(g.notes.map((n: any) => n.id));
    g.links = (g.links || []).filter((l: any) => keep.has(l.s) && keep.has(l.t));
  }
  return JSON.stringify(d);
}
