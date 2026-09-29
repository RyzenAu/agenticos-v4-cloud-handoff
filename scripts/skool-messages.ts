import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const API = "https://api2.skool.com";
const PAGE_SIZE = 30;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CHANNELS = 10000;
const MAX_THREAD_MESSAGES = 5000;
const ID = /^[a-f0-9]{32}$/i;
const INVALID_RESPONSE = "Skool returned an incomplete response. Your saved conversations are unchanged.";
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UNCERTAIN_SEND = "Skool may have received this reply, but its delivery could not be confirmed. Check the conversation in Skool before sending anything again.";

export type SkoolMessage = {
  id: string;
  content: string;
  createdAt: string;
  senderId: string;
  fromSelf: boolean;
  attachmentCount: number;
};
export type SkoolChannel = {
  id: string;
  name: string;
  avatar?: string;
  selfId?: string;
  lastMessage: SkoolMessage | null;
  updatedAt: string;
  unread: boolean;
  unreadCount: number;
  originalUrl: string;
  messages?: SkoolMessage[];
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
  threadSyncedAt?: string;
  threadLimitReached?: boolean;
};
type Cache = {
  version: 1;
  channels: SkoolChannel[];
  lastSync?: string;
  lastError?: string;
  hasMore: boolean;
  nextOffset: number;
};
type Options = { homeDir?: string; request?: typeof fetch; paceMs?: number; connectionFile?: string };
type SendRequest = {
  requestId: string;
  channelId: string;
  contentHash: string;
  status: "pending" | "sent" | "failed" | "uncertain";
  createdAt: string;
  finishedAt?: string;
  messageId?: string;
  error?: string;
};
export type SkoolSendResult = {
  status: "sent" | "failed" | "uncertain";
  requestId: string;
  channelId: string;
  messageId?: string;
  message?: SkoolMessage;
  channel?: SkoolChannel;
  error?: string;
  duplicate: boolean;
  retryable: boolean;
};

async function providerJSON(response: Response) {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error(INVALID_RESPONSE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(INVALID_RESPONSE);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function configuration(home: string, connectionFile?: string, workspaceFile?: string) {
  // This named, existing integration is the sole credential source. Never
  // inspect browser cookie stores, refresh sessions, or expose the cookie.
  let content = "";
  // An explicit integration file is portable; retain the old location only for existing installs.
  const explicit = connectionFile || process.env.AGENTIC_SKOOL_CONNECTION_FILE;
  const file = explicit || (workspaceFile && existsSync(workspaceFile) ? workspaceFile : join(home, "Skool Scraper", ".env"));
  if (explicit && !isAbsolute(explicit)) return "";
  try { if (statSync(file).size > 65536) return ""; content = readFileSync(file, "utf8"); } catch { return ""; }
  let cookie = "";
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?SKOOL_COOKIE\s*=\s*(.*)$/);
    if (!match) continue;
    cookie = match[1].trim();
    if ((cookie.startsWith('"') && cookie.endsWith('"')) || (cookie.startsWith("'") && cookie.endsWith("'"))) cookie = cookie.slice(1, -1);
  }
  return sessionCookie(cookie);
}
function sessionCookie(cookie: string) {
  const auth = cookie.match(/(?:^|;\s*)auth_token=([^;\r\n]+)/)?.[1];
  const client = cookie.match(/(?:^|;\s*)client_id=([^;\r\n]+)/)?.[1];
  return auth ? `auth_token=${auth}${client ? `; client_id=${client}` : ""}` : "";
}

function iso(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(INVALID_RESPONSE);
  return new Date(value).toISOString();
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(INVALID_RESPONSE);
  return value;
}
function string(value: unknown, limit = 100000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function attachments(value: unknown): number {
  try { const list = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(list) ? list.length : 0; } catch { return 0; }
}
function message(raw: any, channelId: string, selfId?: string): SkoolMessage {
  if (!raw || raw.channel_id !== channelId) throw new Error(INVALID_RESPONSE);
  return {
    id: identifier(raw.id),
    content: string(raw.metadata?.content),
    createdAt: iso(raw.created_at),
    senderId: identifier(raw.metadata?.src),
    fromSelf: !!selfId && raw.metadata?.src === selfId,
    attachmentCount: attachments(raw.metadata?.attachments),
  };
}
function avatar(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "assets.skool.com" && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}
function normalizeChannel(raw: any, previous?: SkoolChannel): SkoolChannel {
  const id = identifier(raw?.id);
  const user = raw.user;
  if (!user || !ID.test(user.id) || !Array.isArray(raw.user_ids)) throw new Error(INVALID_RESPONSE);
  const userIds = [...new Set(raw.user_ids.filter((value: unknown) => typeof value === "string" && ID.test(value)))];
  const selfId = userIds.length === 2 && userIds.includes(user.id) ? userIds.find(value => value !== user.id) as string : undefined;
  const unreadCount = Number.isSafeInteger(raw.metadata?.num_unread) && raw.metadata.num_unread >= 0 ? raw.metadata.num_unread : 0;
  return {
    ...(previous || {}),
    id,
    name: [string(user.first_name, 100), string(user.last_name, 100)].filter(Boolean).join(" ") || string(user.name, 200) || "Skool member",
    avatar: avatar(user.metadata?.picture_bubble || user.metadata?.picture_profile),
    selfId,
    lastMessage: raw.last_message ? message(raw.last_message, id, selfId) : null,
    updatedAt: iso(raw.last_message_at || raw.updated_at || raw.created_at),
    unread: raw.metadata?.unread === 1 || raw.metadata?.unread === true || unreadCount > 0,
    unreadCount,
    // This route is used by the installed Wingman/Goosify Skool client.
    originalUrl: `https://www.skool.com/?ch=${id}`,
  };
}
function mergeMessages(old: SkoolMessage[], fresh: SkoolMessage[]) {
  const byId = new Map(old.map(item => [item.id, item]));
  for (const item of fresh) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Read conversations and explicitly send replies through the installed Skool connection. */
export function skoolMessages(root: string, options: Options = {}) {
  const directory = join(root, ".operator-data");
  const file = join(directory, "skool-messages.json");
  const sendDirectory = join(directory, "skool-send-requests");
  const home = options.homeDir || homedir();
  const credentials = () => configuration(home, options.connectionFile, join(directory, "skool-connection.env"));
  const fetcher = options.request || fetch;
  const paceMs = options.paceMs ?? 300;
  let busy = false;
  const read = (): Cache => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.channels) || typeof value.hasMore !== "boolean" || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0 || value.channels.some((item: any) => !item || typeof item.id !== "string" || !ID.test(item.id) || typeof item.name !== "string" || typeof item.updatedAt !== "string")) throw new Error();
      return { ...value, channels: value.channels.map((item: SkoolChannel) => ({ ...item, originalUrl: `https://www.skool.com/?ch=${item.id}` })) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, channels: [], hasMore: false, nextOffset: 0 };
      throw new Error("Your local Skool messages could not be read. The saved copy has been kept unchanged.");
    }
  };
  const write = (value: Cache) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const sendFile = (requestId: string) => join(sendDirectory, `${requestId}.json`);
  function readSend(requestId: string): SendRequest | undefined {
    try {
      const item = JSON.parse(readFileSync(sendFile(requestId), "utf8"));
      if (item.requestId !== requestId || !ID.test(item.channelId) || !/^[a-f0-9]{64}$/.test(item.contentHash) || !["pending", "sent", "failed", "uncertain"].includes(item.status)) throw new Error();
      return item;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("The saved record for this Skool reply could not be read. Check Skool before sending again.");
    }
  }
  function saveSend(item: SendRequest) {
    const target = sendFile(item.requestId), tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(item), { mode: 0o600 });
    renameSync(tmp, target);
  }
  function sendHistory() {
    let files: string[];
    try { files = readdirSync(sendDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("The saved Skool send history could not be read.");
    }
    return files.filter(name => name.endsWith(".json") && REQUEST_ID.test(name.slice(0, -5)))
      .map(name => readSend(name.slice(0, -5))!).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((item, index) => index < 100 || item.status === "pending" || item.status === "uncertain")
      .map(item => ({ ...item, status: item.status === "pending" ? "uncertain" as const : item.status }));
  }
  function sendResult(item: SendRequest, duplicate = false): SkoolSendResult {
    const status = item.status === "pending" ? "uncertain" : item.status;
    return {
      status, requestId: item.requestId, channelId: item.channelId,
      messageId: item.messageId,
      error: status === "uncertain" ? UNCERTAIN_SEND : item.error,
      duplicate, retryable: status === "failed",
    };
  }
  function snapshot() {
    const cache = read();
    const configured = !!credentials();
    const connected = configured && !!cache.lastSync && !cache.lastError;
    return {
      id: "skool" as const,
      configured,
      connected,
      lastSync: cache.lastSync,
      error: cache.lastError,
      count: cache.channels.length,
      hasMore: cache.hasMore,
      nextOffset: cache.nextOffset,
      readOnly: !connected,
      capabilities: { read: connected, send: connected, markRead: false as const },
      sendRequests: sendHistory(),
      channels: [...cache.channels].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }
  async function request(path: string, params: Record<string, string>, session?: string) {
    const cookie = session || credentials();
    if (!cookie) throw new Error("Skool is optional. Use it directly or configure your own local Skool integration before syncing.");
    try {
      const url = new URL(path, API);
      if (url.origin !== API || !(/^\/self\/chat-channels$/.test(path) || /^\/channels\/[a-f0-9]{32}\/messages$/i.test(path))) throw new Error(INVALID_RESPONSE);
      url.search = new URLSearchParams(params).toString();
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          Origin: "https://www.skool.com",
          Referer: "https://www.skool.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        },
      });
      if (response.status === 401 || response.status === 403) throw new Error("Skool needs you to sign in again through your existing connection.");
      if (response.status === 429) throw new Error("Skool is limiting refreshes. Try again in a minute.");
      if (!response.ok) throw new Error("Skool could not refresh messages. Try again; your saved conversations are unchanged.");
      return await providerJSON(response);
    } catch (error) {
      const safe = error instanceof Error ? error.message : "";
      if ([INVALID_RESPONSE, "Skool needs you to sign in again through your existing connection.", "Skool is limiting refreshes. Try again in a minute.", "Skool could not refresh messages. Try again; your saved conversations are unchanged."].includes(safe)) throw new Error(safe);
      // Provider bodies, request URLs and credentials never leave this adapter.
      throw new Error("Skool could not refresh messages. Try again; your saved conversations are unchanged.");
    }
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("Wait for the Skool refresh to finish.");
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function connect(body: { session?: string } = {}) {
    return locked(async () => {
      if (options.connectionFile || process.env.AGENTIC_SKOOL_CONNECTION_FILE) throw new Error("Update the Skool connection file configured for this workspace, then refresh.");
      const value = typeof body.session === "string" ? body.session.trim() : "";
      if (!value || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new Error("Paste your Skool auth_token or session cookie.");
      const cookie = sessionCookie(/(?:^|;\s*)auth_token=/.test(value) ? value : `auth_token=${value}`);
      if (!cookie) throw new Error("The session must contain Skool's auth_token.");
      const current = read();
      const result = await request("/self/chat-channels", { offset: "0", limit: String(PAGE_SIZE), last: "true", "unread-only": "false" }, cookie);
      if (!Array.isArray(result?.channels) || result.channels.length > PAGE_SIZE) throw new Error(INVALID_RESPONSE);
      const fresh = result.channels.map((raw: any) => normalizeChannel(raw)) as SkoolChannel[];
      const previousSelf = new Set(current.channels.map(item => item.selfId).filter(Boolean));
      const nextSelf = new Set(fresh.map(item => item.selfId).filter(Boolean));
      if (nextSelf.size > 1 || (previousSelf.size && (nextSelf.size !== 1 || [...nextSelf].some(id => !previousSelf.has(id))))) throw new Error("This session could not be matched to the saved Skool account. Your existing conversations were preserved.");
      const channels = new Map(current.channels.map(item => [item.id, item]));
      for (const item of fresh) channels.set(item.id, { ...channels.get(item.id), ...item });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, "skool-connection.env"), temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `SKOOL_COOKIE=${cookie}\n`, { mode: 0o600 });
      renameSync(temporary, target);
      write({ version: 1, channels: [...channels.values()], hasMore: fresh.length === PAGE_SIZE || current.hasMore, nextOffset: Math.max(fresh.length, current.nextOffset), lastSync: new Date().toISOString() });
      return snapshot();
    });
  }
  async function sync(body: { more?: boolean; limit?: number } = {}) {
    return locked(async () => {
      const current = read();
      const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit) ? Math.max(1, Math.min(body.limit, 300)) : 300;
      let offset = body.more ? current.nextOffset : 0;
      if (body.more && !current.hasMore) return snapshot();
      const collected: any[] = [];
      let hasMore = false;
      try {
        do {
          const pageLimit = Math.min(PAGE_SIZE, limit - collected.length);
          const result = await request("/self/chat-channels", { offset: String(offset), limit: String(pageLimit), last: "true", "unread-only": "false" });
          if (!Array.isArray(result?.channels) || result.channels.length > pageLimit) throw new Error(INVALID_RESPONSE);
          for (const raw of result.channels) normalizeChannel(raw);
          if (result.channels.length && result.channels.every((raw: any) => collected.some(item => item.id === raw.id))) throw new Error("Skool repeated a conversation page. Refresh again to continue.");
          collected.push(...result.channels);
          offset += result.channels.length;
          hasMore = result.channels.length === pageLimit;
          if (hasMore && collected.length < limit && paceMs > 0) await new Promise(resolve => setTimeout(resolve, paceMs));
        } while (hasMore && collected.length < limit);
        const merged = new Map(current.channels.map(channel => [channel.id, channel]));
        const newHeadCount = new Set(collected.filter(raw => !merged.has(raw.id)).map(raw => raw.id)).size;
        for (const raw of collected) merged.set(raw.id, normalizeChannel(raw, merged.get(raw.id)));
        if (merged.size > MAX_CHANNELS) throw new Error("The local Skool conversation limit has been reached.");
        // Refreshing recent conversations must not rewind the archive cursor.
        // Newly observed conversations at the head shift that continuation by
        // one each. A short provider page still establishes the actual end.
        if (!body.more && current.lastSync && current.nextOffset > 0 && hasMore) {
          offset = Math.max(offset, current.nextOffset + newHeadCount);
          hasMore = current.hasMore;
        }
        const now = new Date().toISOString();
        write({ version: 1, channels: [...merged.values()], hasMore, nextOffset: offset, lastSync: now });
        return snapshot();
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Skool could not refresh messages.";
        write({ ...current, lastError: reason });
        throw error;
      }
    });
  }
  async function thread(body: { id?: string; older?: boolean } = {}) {
    return locked(async () => {
      const current = read();
      const channel = current.channels.find(item => item.id === body.id);
      if (!channel || !ID.test(channel.id)) throw new Error("Choose a synced Skool conversation first.");
      if (body.older && !channel.hasMoreBefore) return { channel };
      if (body.older && (channel.messages?.length || 0) >= MAX_THREAD_MESSAGES) return { channel: { ...channel, threadLimitReached: true } };
      const anchor = body.older ? channel.messages?.[0]?.id : channel.lastMessage?.id;
      if (!anchor || !ID.test(anchor)) return { channel: { ...channel, messages: channel.messages || [], hasMoreBefore: false, hasMoreAfter: false } };
      const params: Record<string, string> = body.older ? { msg: anchor, "no-msg": "true", before: "35" } : { msg: anchor, before: "35", after: "35" };
      const result = await request(`/channels/${channel.id}/messages`, params);
      if (!Array.isArray(result?.messages) || typeof result.has_more_before !== "boolean" || typeof result.has_more_after !== "boolean" || (result.channel && result.channel.id !== channel.id)) throw new Error(INVALID_RESPONSE);
      const fresh = result.messages.map((item: any) => message(item, channel.id, channel.selfId));
      const messages = mergeMessages(channel.messages || [], fresh);
      if (messages.length > MAX_THREAD_MESSAGES) throw new Error("This conversation has reached the local history limit. Open Skool for its full history.");
      if (body.older && result.has_more_before && !fresh.some((item: SkoolMessage) => !channel.messages?.some(existing => existing.id === item.id))) throw new Error("Skool repeated the previous page. Open Skool for older messages.");
      const updated: SkoolChannel = {
        ...channel,
        messages,
        hasMoreBefore: body.older || !channel.threadSyncedAt ? result.has_more_before : channel.hasMoreBefore,
        hasMoreAfter: result.has_more_after,
        threadSyncedAt: new Date().toISOString(),
        threadLimitReached: messages.length >= MAX_THREAD_MESSAGES && result.has_more_before,
      };
      write({ ...current, channels: current.channels.map(item => item.id === channel.id ? updated : item) });
      return { channel: updated };
    });
  }
  async function send(body: { id?: string; content?: string; requestId?: string } = {}): Promise<SkoolSendResult> {
    if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) throw new Error("Create a stable request ID before sending this reply.");
    if (typeof body.id !== "string" || !ID.test(body.id)) throw new Error("Choose a synced Skool conversation first.");
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 10000 || body.content.includes("\0")) throw new Error("Write a reply between 1 and 10,000 characters.");
    const content = body.content.trim(), requestId = body.requestId.toLowerCase(), channelId = body.id;
    const contentHash = createHash("sha256").update(JSON.stringify([channelId, content])).digest("hex");
    const previous = readSend(requestId);
    if (previous) {
      if (previous.channelId !== channelId || previous.contentHash !== contentHash) throw new Error("This request ID already belongs to a different Skool reply.");
      return sendResult(previous, true);
    }
    return locked(async () => {
      const current = read();
      const channel = current.channels.find(item => item.id === channelId);
      if (!channel || !channel.selfId || !ID.test(channel.selfId)) throw new Error("Choose a synced Skool conversation with a verified sender first.");
      const cookie = credentials();
      if (!cookie || !current.lastSync || current.lastError) throw new Error("Refresh your Skool connection before sending a reply.");
      const pending: SendRequest = { requestId, channelId, contentHash, status: "pending", createdAt: new Date().toISOString() };
      mkdirSync(sendDirectory, { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation is durable before POST and also guards duplicate
        // requests handled by another process or a previous hot-reload instance.
        writeFileSync(sendFile(requestId), JSON.stringify(pending), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const duplicate = readSend(requestId)!;
          if (duplicate.channelId !== channelId || duplicate.contentHash !== contentHash) throw new Error("This request ID already belongs to a different Skool reply.");
          return sendResult(duplicate, true);
        }
        throw new Error("The reply could not be recorded safely. Nothing was sent to Skool.");
      }
      const finish = (status: SendRequest["status"], error?: string, messageId?: string): SkoolSendResult => {
        const finished: SendRequest = { ...pending, status, finishedAt: new Date().toISOString(), ...(error ? { error } : {}), ...(messageId ? { messageId } : {}) };
        // If final bookkeeping fails, the durable pending record still blocks
        // another POST for this request ID after restart.
        try { saveSend(finished); } catch { /* The known delivery result remains accurate. */ }
        return sendResult(finished);
      };
      let response: Response;
      try {
        response = await fetcher(`${API}/channels/${channelId}/messages`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json", Origin: "https://www.skool.com", Referer: "https://www.skool.com/", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
          body: JSON.stringify({ content, attachments: [] }),
        });
      } catch { return finish("uncertain", UNCERTAIN_SEND); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) {
          const reason = response.status === 429 ? "Skool declined this reply because its message limit was reached. Wait before choosing Retry."
            : response.status === 401 || response.status === 403 ? "Skool did not allow this reply. Refresh your connection or check conversation access before choosing Retry."
            : "Skool declined this reply. Check the conversation and message before choosing Retry.";
          return finish("failed", reason);
        }
        return finish("uncertain", UNCERTAIN_SEND);
      }
      let data: any;
      try { data = await providerJSON(response); } catch { return finish("uncertain", UNCERTAIN_SEND); }
      // The installed Wingman proxy recognizes these three response shapes.
      const raw = data?.message || data?.data || data;
      if (data?.error || !raw || typeof raw.id !== "string" || !ID.test(raw.id)) return finish("uncertain", UNCERTAIN_SEND);
      const sentId = raw.id;
      let confirmed: SkoolMessage | undefined;
      const verifyMessage = (value: any) => {
        const parsed = message(value, channelId, channel.selfId);
        if (parsed.id !== sentId || !parsed.fromSelf || parsed.content !== content) throw new Error();
        return parsed;
      };
      if (raw.metadata && raw.channel_id) {
        try { confirmed = verifyMessage(raw); } catch { return finish("uncertain", UNCERTAIN_SEND); }
      }
      const result = finish("sent", undefined, sentId);
      try {
        if (!confirmed) {
          const verified = await request(`/channels/${channelId}/messages`, { msg: sentId, before: "0", after: "0" });
          const matching = Array.isArray(verified?.messages) ? verified.messages.find((item: any) => item?.id === sentId) : undefined;
          if (matching) confirmed = verifyMessage(matching);
        }
        if (confirmed) {
          const latest = read();
          const target = latest.channels.find(item => item.id === channelId) || channel;
          const messages = mergeMessages(target.messages || [], [confirmed]);
          const isNewest = confirmed.createdAt >= (target.lastMessage?.createdAt || "");
          const updated: SkoolChannel = { ...target, ...(isNewest ? { lastMessage: confirmed, updatedAt: confirmed.createdAt } : {}), ...(messages.length <= MAX_THREAD_MESSAGES ? { messages } : {}) };
          write({ ...latest, channels: latest.channels.map(item => item.id === channelId ? updated : item) });
          result.message = confirmed; result.channel = updated;
        }
      } catch { result.error = "Your reply was sent. Refresh this conversation to update the local copy."; }
      return result;
    });
  }
  return {
    snapshot, sync, thread, send,
    async handle(path: string, method: string, body: any = {}) {
      if (path === "/connections/skool/status" && method === "GET") {
        const { channels: _channels, sendRequests: _sendRequests, ...status } = snapshot();
        return status;
      }
      if (path === "/connections/skool" && method === "GET") return snapshot();
      if (path === "/connections/skool/connect" && method === "POST") return connect(body || {});
      if (path === "/connections/skool/sync" && method === "POST") return sync(body || {});
      if (path === "/connections/skool/thread" && method === "POST") return thread(body || {});
      if (path === "/connections/skool/send" && method === "POST") return send(body || {});
      throw new Error("Choose a supported Skool action.");
    },
  };
}
