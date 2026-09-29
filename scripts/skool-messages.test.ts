import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { skoolMessages } from "./skool-messages";

const dirs: string[] = [];
const uid = (n: number) => n.toString(16).padStart(32, "0");
const self = uid(90000), other = uid(90001);
const sent = (id: number, channelId = 1, from = other) => ({ id: uid(id), channel_id: uid(channelId), created_at: new Date(1700000000000 + id * 1000).toISOString(), metadata: { content: `Message ${id}`, src: from, dst: from === self ? other : self, attachments: "[]" } });
const channel = (id: number) => ({ id: uid(id), user_ids: [self, other], metadata: { unread: 1, num_unread: 2 }, updated_at: "2026-09-16T15:00:00Z", user: { id: other, first_name: "Alex", last_name: "Member", name: "alex", email: "private@example.com", metadata: { picture_bubble: "https://assets.skool.com/avatar.png", secret: "not-for-cache" } }, last_message: sent(300 + id, id), request_group: { metadata: { api_keys: "never-cache-this" } } });
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "skool-test-")); dirs.push(root);
  mkdirSync(join(root, "Skool Scraper"));
  writeFileSync(join(root, "Skool Scraper", ".env"), 'SKOOL_COOKIE="auth_token=private-session; client_id=private-client; unwanted_cookie=never-forward"\n');
  return root;
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Skool read-only connection", () => {
  test("connecting verifies first, stores only allowed cookies privately and loads real provider rows", async () => {
    const root = workspace(); let forwarded = "";
    const app = skoolMessages(root, { homeDir: root, request: (async (_: any, init: RequestInit) => {
      forwarded = new Headers(init.headers).get("Cookie") || "";
      return response({ channels: [channel(1)] });
    }) as typeof fetch });
    const result = await app.handle("/connections/skool/connect", "POST", { session: "auth_token=new-session; client_id=browser; unrelated=drop" });
    const file = join(root, ".operator-data", "skool-connection.env");
    expect(forwarded).toBe("auth_token=new-session; client_id=browser");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("unrelated");
    expect(result).toMatchObject({ connected: true, count: 1, capabilities: { send: true } });
    expect(JSON.stringify(result)).not.toContain("new-session");
  });
  test("failed session verification preserves the working session and cached conversations", async () => {
    const root = workspace(); let fail = false;
    const app = skoolMessages(root, { homeDir: root, request: (async () => fail ? response({}, 401) : response({ channels: [channel(1)] })) as typeof fetch });
    await app.handle("/connections/skool/connect", "POST", { session: "working-session==" });
    const file = join(root, ".operator-data", "skool-connection.env");
    const before = readFileSync(file, "utf8"); fail = true;
    await expect(app.handle("/connections/skool/connect", "POST", { session: "invalid-session" })).rejects.toThrow("sign in again");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(app.snapshot()).toMatchObject({ connected: true, count: 1 });
  });
  test("connecting a different account cannot mix its messages into the saved inbox", async () => {
    const root = workspace(); let changed = false;
    const app = skoolMessages(root, { homeDir: root, request: (async () => response({ channels: [{ ...channel(1), user_ids: changed ? [uid(100000), other] : [self, other] }] })) as typeof fetch });
    await app.handle("/connections/skool/connect", "POST", { session: "first-session" });
    changed = true;
    await expect(app.handle("/connections/skool/connect", "POST", { session: "other-session" })).rejects.toThrow("saved Skool account");
    expect(app.snapshot().channels[0].selfId).toBe(self);
  });
  test("an explicitly saved workspace session takes precedence over the legacy integration", async () => {
    const root = workspace();
    mkdirSync(join(root, ".operator-data"));
    writeFileSync(join(root, ".operator-data", "skool-connection.env"), 'SKOOL_COOKIE="auth_token=workspace-session; unrelated=not-forwarded"\n', { mode: 0o600 });
    let cookie = "";
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (_input: any, init: RequestInit) => {
      cookie = new Headers(init.headers).get("Cookie") || "";
      return response({ channels: [channel(1)] });
    }) as typeof fetch });
    await app.sync();
    expect(cookie).toBe("auth_token=workspace-session");
    expect(app.snapshot().connected).toBe(true);
    writeFileSync(join(root, ".operator-data", "skool-connection.env"), "");
    expect(app.snapshot().configured).toBe(false);
  });

  test("configuration is not a verified connection and discovery makes no requests", () => {
    const root = workspace(); let called = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => { called++; return response({}); }) as typeof fetch });
    expect(app.snapshot()).toMatchObject({ configured: true, connected: false, count: 0, readOnly: true });
    expect(called).toBe(0);
  });

  test("channel pagination is bounded and sanitized; more resumes the cursor", async () => {
    const root = workspace(); const calls: { url: URL; init: RequestInit }[] = [];
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any, init: RequestInit) => {
      const url = new URL(input); calls.push({ url, init });
      const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return response({ channels: Array.from({ length: Math.min(limit, 65 - offset) }, (_, i) => channel(offset + i + 1)) });
    }) as typeof fetch });
    const first = await app.sync({ limit: 60 });
    expect(first).toMatchObject({ connected: true, count: 60, hasMore: true, nextOffset: 60 });
    const next = await app.sync({ more: true, limit: 30 });
    expect(next).toMatchObject({ count: 65, hasMore: false, nextOffset: 65 });
    expect(calls.map(x => x.url.searchParams.get("offset"))).toEqual(["0", "30", "60"]);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://api2.skool.com");
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("error");
      const header = new Headers(call.init.headers);
      expect(header.get("Cookie")).toBe("auth_token=private-session; client_id=private-client");
      expect(call.url.searchParams.get("unread-only")).toBe("false");
    }
    const cached = readFileSync(join(root, ".operator-data", "skool-messages.json"), "utf8");
    expect(cached).not.toMatch(/private-session|private-client|never-cache-this|not-for-cache|private@example/);
    if (process.platform !== "win32") expect(statSync(join(root, ".operator-data", "skool-messages.json")).mode & 0o777).toBe(0o600);
    expect(next.channels[0].originalUrl).toMatch(/^https:\/\/www\.skool\.com\/\?ch=[a-f0-9]{32}$/);
  });

  test("refreshing the head preserves a partially loaded archive continuation", async () => {
    const root = workspace(); const offsets: number[] = [];
    const all = Array.from({ length: 950 }, (_, i) => channel(i + 1));
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any) => {
      const url = new URL(input), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      offsets.push(offset); return response({ channels: all.slice(offset, offset + limit) });
    }) as typeof fetch });
    await app.sync(); await app.sync({ more: true });
    expect(app.snapshot()).toMatchObject({ count: 600, nextOffset: 600, hasMore: true });
    const refresh = await app.sync();
    expect(refresh).toMatchObject({ count: 600, nextOffset: 600, hasMore: true });
    offsets.length = 0;
    const more = await app.sync({ more: true });
    expect(offsets[0]).toBe(600);
    expect(more).toMatchObject({ count: 900, nextOffset: 900, hasMore: true });
  });

  test("newly observed head conversations shift the continuation without reloading cached pages", async () => {
    const root = workspace(); let all = Array.from({ length: 950 }, (_, i) => channel(i + 1));
    const offsets: number[] = [];
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any) => {
      const url = new URL(input), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      offsets.push(offset); return response({ channels: all.slice(offset, offset + limit) });
    }) as typeof fetch });
    await app.sync(); await app.sync({ more: true });
    all = [channel(10001), channel(10002), ...all];
    const refresh = await app.sync();
    expect(refresh).toMatchObject({ count: 602, nextOffset: 602, hasMore: true });
    offsets.length = 0;
    await app.sync({ more: true });
    expect(offsets[0]).toBe(602);
    expect(app.snapshot().channels.some(item => item.id === uid(601))).toBe(true);
  });

  test("refreshing a complete archive retains known completion", async () => {
    const root = workspace(); let calls = 0;
    const all = Array.from({ length: 650 }, (_, i) => channel(i + 1));
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any) => {
      calls++; const url = new URL(input), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return response({ channels: all.slice(offset, offset + limit) });
    }) as typeof fetch });
    await app.sync(); await app.sync({ more: true }); await app.sync({ more: true });
    expect(app.snapshot()).toMatchObject({ count: 650, nextOffset: 650, hasMore: false });
    const refresh = await app.sync();
    expect(refresh).toMatchObject({ count: 650, nextOffset: 650, hasMore: false });
    const callsBefore = calls; await app.sync({ more: true });
    expect(calls).toBe(callsBefore);
  });

  test("thread and older pages merge in order with sender identity and no mark-read", async () => {
    const root = workspace(); const urls: URL[] = [];
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any, init: RequestInit) => {
      expect(init.method).toBe("GET"); const url = new URL(input); urls.push(url);
      if (url.pathname === "/self/chat-channels") return response({ channels: [channel(1)] });
      const older = url.searchParams.has("no-msg");
      return response({ messages: older ? [sent(299, 1, self)] : [sent(301), sent(300, 1, self)], has_more_before: !older, has_more_after: false, channel: { id: uid(1), request_group: { api_keys: "secret" } } });
    }) as typeof fetch });
    await app.sync(); const first = await app.thread({ id: uid(1) });
    expect(first.channel.messages?.map(m => m.id)).toEqual([uid(300), uid(301)]);
    expect(first.channel.messages?.map(m => m.fromSelf)).toEqual([true, false]);
    expect(first.channel.hasMoreBefore).toBe(true);
    const older = await app.thread({ id: uid(1), older: true });
    expect(older.channel.messages?.map(m => m.id)).toEqual([uid(299), uid(300), uid(301)]);
    expect(older.channel.unread).toBe(true);
    expect(older.channel.hasMoreBefore).toBe(false);
    expect(urls[2].searchParams.get("msg")).toBe(uid(300));
    expect(urls[2].searchParams.get("no-msg")).toBe("true");
  });

  test("only synced channels can be requested, send requires an ID and read mutation is rejected", async () => {
    const root = workspace(); let called = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => { called++; return response({ channels: [] }); }) as typeof fetch });
    await expect(app.thread({ id: "../../private" })).rejects.toThrow("Choose a synced");
    await expect(app.thread({ id: uid(500) })).rejects.toThrow("Choose a synced");
    await expect(app.handle("/connections/skool/send", "POST", {})).rejects.toThrow("stable request ID");
    await expect(app.handle("/connections/skool/read", "POST", {})).rejects.toThrow("supported Skool action");
    expect(called).toBe(0);
  });

  test("failed sync preserves cached conversations and timestamp with a sanitized error", async () => {
    const root = workspace(); let fail = false;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => {
      if (fail) throw new Error("leaked private-session URL auth-token");
      return response({ channels: [channel(1)] });
    }) as typeof fetch });
    const first = await app.sync(); fail = true;
    await expect(app.sync()).rejects.toThrow("Skool could not refresh messages");
    const after = app.snapshot();
    expect(after.channels).toEqual(first.channels);
    expect(after.lastSync).toBe(first.lastSync);
    expect(after.connected).toBe(false);
    expect(after.error).not.toMatch(/private-session|auth-token/);
  });

  test("provider errors, oversized responses and malformed data never replace saved messages", async () => {
    for (const bad of [() => response({ secrets: "token" }, 401), () => response({ secrets: "token" }, 429), () => new Response("{}", { headers: { "content-length": "999999999" } }), () => response({ channels: [{}] })]) {
      const root = workspace(); let fail = false;
      const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => fail ? bad() : response({ channels: [channel(1)] })) as typeof fetch });
      await app.sync(); fail = true; await expect(app.sync()).rejects.toThrow();
      expect(app.snapshot().channels).toHaveLength(1);
      expect(app.snapshot().error).not.toContain("token");
    }
  });

  test("corrupt local cache is preserved without requests or overwrite", async () => {
    const root = workspace(); const directory = join(root, ".operator-data");
    mkdirSync(directory); const file = join(directory, "skool-messages.json");
    const corrupted = '{"version":1,"channels":[unexpected-data';
    writeFileSync(file, corrupted); let called = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => { called++; return response({ channels: [] }); }) as typeof fetch });
    expect(() => app.snapshot()).toThrow("saved copy has been kept unchanged");
    await expect(app.sync()).rejects.toThrow("saved copy has been kept unchanged");
    expect(readFileSync(file, "utf8")).toBe(corrupted);
    expect(called).toBe(0);
  });

  test("status endpoint omits conversation payloads while mailbox endpoint includes them", async () => {
    const root = workspace();
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => response({ channels: [channel(1)] })) as typeof fetch });
    await app.sync();
    const status = await app.handle("/connections/skool/status", "GET");
    expect(status).toMatchObject({ count: 1, connected: true, readOnly: false, capabilities: { read: true, send: true, markRead: false } });
    expect(status).not.toHaveProperty("channels");
    expect(status).not.toHaveProperty("sendRequests");
    const mailbox = await app.handle("/connections/skool", "GET");
    expect(mailbox).toHaveProperty("channels");
  });

  test("untrusted avatar URLs and provider group metadata are not returned", async () => {
    const root = workspace(); const raw = channel(1); raw.user.metadata.picture_bubble = "https://unrelated.example/tracker.png";
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async () => response({ channels: [raw] })) as typeof fetch });
    const result = await app.sync();
    expect(result.channels[0].avatar).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/api_keys|request_group|unrelated.example|email/);
  });
});


describe("explicit Skool replies", () => {
  const content = "Thanks, I will take a look.";
  const sentReply = () => ({ ...sent(500, 1, self), metadata: { content, src: self, dst: other, attachments: "[]" } });
  test("sends exact text to a known channel and persists the send before POST", async () => {
    const root = workspace(), requestId = randomUUID(); let posts = 0;
    const fetcher = (async (input: any, init: RequestInit) => {
      if (init.method !== "POST") return response({ channels: [channel(1)] });
      posts++;
      expect(String(input)).toBe(`https://api2.skool.com/channels/${uid(1)}/messages`);
      expect(JSON.parse(String(init.body))).toEqual({ content, attachments: [] });
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      expect(init.redirect).toBe("error");
      const ledger = JSON.parse(readFileSync(join(root, ".operator-data", "skool-send-requests", `${requestId}.json`), "utf8"));
      expect(ledger.status).toBe("pending");
      expect(ledger).not.toHaveProperty("content");
      return response({ message: sentReply() });
    }) as typeof fetch;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher });
    await app.sync();
    const result = await app.send({ id: uid(1), content, requestId });
    expect(result).toMatchObject({ status: "sent", requestId, channelId: uid(1), messageId: uid(500), retryable: false, duplicate: false });
    expect(result.message).toMatchObject({ content, fromSelf: true, senderId: self });
    expect(result.channel?.lastMessage?.id).toBe(uid(500));
    expect(result.channel?.unread).toBe(true);
    expect(posts).toBe(1);
    if (process.platform !== "win32") expect(statSync(join(root, ".operator-data", "skool-send-requests", `${requestId}.json`)).mode & 0o777).toBe(0o600);
    const restarted = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher });
    expect(await restarted.send({ id: uid(1), content, requestId })).toMatchObject({ status: "sent", duplicate: true, messageId: uid(500) });
    expect(posts).toBe(1);
    await expect(restarted.send({ id: uid(1), content: "Changed content", requestId })).rejects.toThrow("different Skool reply");
    expect(posts).toBe(1);
  });

  test("invalid replies and unverified senders never make provider POSTs", async () => {
    const root = workspace(); let posts = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (_: any, init: RequestInit) => {
      if (init.method === "POST") posts++;
      const raw = channel(1); raw.user_ids = [other]; return response({ channels: [raw] });
    }) as typeof fetch });
    const id = uid(1), requestId = randomUUID();
    await expect(app.send({ id, content, requestId })).rejects.toThrow("verified sender");
    await app.sync();
    await expect(app.send({ id, content, requestId })).rejects.toThrow("verified sender");
    await expect(app.send({ id, content: "   ", requestId })).rejects.toThrow("Write a reply");
    await expect(app.send({ id, content: "x".repeat(10001), requestId })).rejects.toThrow("Write a reply");
    await expect(app.send({ id: "../../private", content, requestId })).rejects.toThrow("synced Skool");
    await expect(app.send({ id, content, requestId: "../../escape" })).rejects.toThrow("stable request ID");
    expect(posts).toBe(0);
  });

  test("network loss, server errors and malformed successful responses are never automatically retried", async () => {
    for (const fail of [() => { throw new Error("private-session-secret"); }, () => response({ secret: "private-session-secret" }, 500), () => response({ ok: true })]) {
      const root = workspace(), requestId = randomUUID(); let posts = 0;
      const fetcher = (async (_: any, init: RequestInit) => { if (init.method === "POST") { posts++; return fail(); } return response({ channels: [channel(1)] }); }) as typeof fetch;
      const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher }); await app.sync();
      const result = await app.send({ id: uid(1), content, requestId });
      expect(result).toMatchObject({ status: "uncertain", retryable: false });
      expect(result.error).not.toContain("private-session-secret");
      const restarted = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher });
      expect(await restarted.send({ id: uid(1), content, requestId })).toMatchObject({ status: "uncertain", duplicate: true });
      expect(posts).toBe(1);
      expect(restarted.snapshot().sendRequests[0]).toMatchObject({ requestId, status: "uncertain" });
    }
  });

  test("known rejection can be retried only through an explicit new request ID", async () => {
    const root = workspace(); let posts = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (_: any, init: RequestInit) => {
      if (init.method !== "POST") return response({ channels: [channel(1)] });
      posts++; return posts === 1 ? response({ error: "do not expose body" }, 429) : response(sentReply());
    }) as typeof fetch }); await app.sync();
    const first = randomUUID();
    expect(await app.send({ id: uid(1), content, requestId: first })).toMatchObject({ status: "failed", retryable: true });
    expect(await app.send({ id: uid(1), content, requestId: first })).toMatchObject({ status: "failed", duplicate: true });
    expect(posts).toBe(1);
    expect(await app.send({ id: uid(1), content, requestId: randomUUID() })).toMatchObject({ status: "sent" });
    expect(posts).toBe(2);
  });

  test("an ID-only success is verified by read before adding a message to the cache", async () => {
    const root = workspace(); const calls: { method: string; url: URL }[] = [];
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (input: any, init: RequestInit) => {
      const url = new URL(input); calls.push({ method: String(init.method), url });
      if (init.method === "POST") return response({ id: uid(500) });
      if (url.pathname === "/self/chat-channels") return response({ channels: [channel(1)] });
      return response({ messages: [sentReply()] });
    }) as typeof fetch }); await app.sync();
    const result = await app.send({ id: uid(1), content, requestId: randomUUID() });
    expect(result).toMatchObject({ status: "sent", message: { id: uid(500), fromSelf: true } });
    expect(calls.map(item => item.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls[2].url.searchParams.get("msg")).toBe(uid(500));
    expect(calls[2].url.searchParams.get("before")).toBe("0");
  });

  test("a response from another sender is not fabricated as a sent reply", async () => {
    const root = workspace();
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (_: any, init: RequestInit) => init.method === "POST" ? response({ ...sentReply(), metadata: { content, src: other, dst: self } }) : response({ channels: [channel(1)] })) as typeof fetch }); await app.sync();
    expect(await app.send({ id: uid(1), content, requestId: randomUUID() })).toMatchObject({ status: "uncertain" });
    expect(app.snapshot().channels[0].lastMessage?.id).not.toBe(uid(500));
  });

  test("durable pending record blocks another process or restarted request", async () => {
    const root = workspace(), requestId = randomUUID(); let posts = 0;
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const fetcher = (async (_: any, init: RequestInit) => {
      if (init.method !== "POST") return response({ channels: [channel(1)] });
      posts++; started(); await wait; return response(sentReply());
    }) as typeof fetch;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher }); await app.sync();
    const sending = app.send({ id: uid(1), content, requestId }); await began;
    const another = skoolMessages(root, { homeDir: root, paceMs: 0, request: fetcher });
    const duplicate = await another.send({ id: uid(1), content, requestId });
    expect(duplicate).toMatchObject({ status: "uncertain", duplicate: true, retryable: false });
    expect(posts).toBe(1); finish(); expect((await sending).status).toBe("sent");
  });

  test("corrupt send ledger never permits a replacement POST", async () => {
    const root = workspace(), requestId = randomUUID(); let posts = 0;
    const app = skoolMessages(root, { homeDir: root, paceMs: 0, request: (async (_: any, init: RequestInit) => { if (init.method === "POST") posts++; return response({ channels: [channel(1)] }); }) as typeof fetch }); await app.sync();
    const directory = join(root, ".operator-data", "skool-send-requests"); mkdirSync(directory);
    const file = join(directory, `${requestId}.json`); writeFileSync(file, "broken-record");
    await expect(app.send({ id: uid(1), content, requestId })).rejects.toThrow("saved record");
    expect(readFileSync(file, "utf8")).toBe("broken-record"); expect(posts).toBe(0);
  });
});
