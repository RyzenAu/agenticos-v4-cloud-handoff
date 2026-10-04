import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AudienceMeasurementScope } from "../src/lib/audience-measurement";

type Provider = "skool" | "youtube";
type AdapterOptions = { homeDir?: string; request?: typeof fetch };
export type BusinessIntegrationSnapshot = {
  platform: Provider;
  recordedAt: string;
  metrics: Record<string, number>;
  origin: "connector";
  sourceLabel: string;
  sourceUrl: string;
  measurementScope?: AudienceMeasurementScope;
};

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Read only the named integration's existing configuration. Do not copy credentials
// into the workspace, expose them through discovery, or scan unrelated providers.
function readConfig(file: string, keys: string[]) {
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match || !keys.includes(match[1])) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      values[match[1]] = value.replace(/\\n$/, "").trim();
    }
  } catch {
    /* Missing configuration is reported as unavailable, without its path. */
  }
  return values;
}

/** Named configuration only. A key never implies ownership of a default channel. */
export function youtubeConfiguration(home = homedir()) {
  const keys = ["YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID"];
  const env = {
    ...readConfig(join(home, ".config", "agentic-os.env"), keys),
  };
  return {
    key: env.YOUTUBE_API_KEY || "",
    channelId: /^UC[A-Za-z0-9_-]{22}$/.test(env.YOUTUBE_CHANNEL_ID || "")
      ? env.YOUTUBE_CHANNEL_ID
      : "",
  };
}

/** Resolve only channel identifiers. User URLs are never fetched directly. */
export function youtubeChannelSelector(
  input: unknown,
): { id: string } | { forHandle: string } | { forUsername: string } {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("Enter a YouTube channel URL or @handle.");
  const value = input.trim();
  if (/^UC[A-Za-z0-9_-]{22}$/.test(value)) return { id: value };
  if (/^@[\p{L}\p{N}\p{M}._-]{1,100}$/u.test(value)) return { forHandle: value };
  try {
    const url = new URL(/^(?:www\.|m\.)?youtube\.com\//i.test(value) ? `https://${value}` : value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error();
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (
      parts.length > 2 ||
      (parts.length === 2 &&
        parts[0].startsWith("@") &&
        !["videos", "shorts", "streams", "featured", "about", "playlists", "community"].includes(
          parts[1],
        ))
    )
      throw new Error();
    if (/^@[\p{L}\p{N}\p{M}._-]{1,100}$/u.test(parts[0] || "")) return { forHandle: parts[0] };
    if (parts[0] === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || ""))
      return { id: parts[1] };
    if (parts[0] === "user" && /^[A-Za-z0-9._-]{1,100}$/.test(parts[1] || ""))
      return { forUsername: parts[1] };
  } catch {
    /* Return one actionable message without echoing the input. */
  }
  throw new Error("Enter a YouTube channel URL or @handle, rather than a video link.");
}

export async function configureYouTubeChannel(
  input: unknown,
  options: AdapterOptions = {},
): Promise<{ id: string; title: string; url: string }> {
  const selector = youtubeChannelSelector(input);
  const home = options.homeDir || homedir();
  const before = youtubeConfiguration(home);
  if (!before.key)
    throw new Error("The YouTube key has to be added on the hub PC before a channel can be chosen.");
  let channel: { id: string; title: string; url: string };
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.search = new URLSearchParams({ part: "snippet", ...selector, key: before.key }).toString();
    const response = await (options.request || fetch)(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error();
    const data = JSON.parse(await responseText(response));
    if (!Array.isArray(data.items) || data.items.length !== 1) throw new Error();
    const item = data.items[0];
    if (
      !/^UC[A-Za-z0-9_-]{22}$/.test(item?.id || "") ||
      ("id" in selector && item.id !== selector.id) ||
      typeof item.snippet?.title !== "string" ||
      !item.snippet.title.trim()
    )
      throw new Error();
    channel = {
      id: item.id,
      title: item.snippet.title
        .replace(/[\u0000-\u001f]/g, "")
        .trim()
        .slice(0, 200),
      url: `https://www.youtube.com/channel/${item.id}`,
    };
  } catch {
    throw new Error(
      "YouTube could not find that channel. Check the link and your API connection, then try again. Your saved channel is unchanged.",
    );
  }
  const current = youtubeConfiguration(home);
  if (current.key !== before.key || current.channelId !== before.channelId)
    throw new Error("Your YouTube connection changed while checking the channel. Try again.");
  const directory = join(home, ".config"),
    file = join(directory, "agentic-os.env");
  const temporary = file + "." + randomUUID();
  try {
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
      throw new Error();
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    let replaced = false;
    const lines = existing.split(/\r?\n/).flatMap((line) => {
      if (!/^\s*(?:export\s+)?YOUTUBE_CHANNEL_ID\s*=/.test(line)) return [line];
      if (replaced) return [];
      replaced = true;
      return [`YOUTUBE_CHANNEL_ID=${channel.id}`];
    });
    if (!replaced) {
      if (lines.at(-1) === "") lines.pop();
      lines.push(`YOUTUBE_CHANNEL_ID=${channel.id}`);
    }
    const updated = lines
      .join(existing.includes("\r\n") ? "\r\n" : "\n")
      .replace(/(?:\r?\n)*$/, existing.includes("\r\n") ? "\r\n" : "\n");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
    throw new Error(
      "The channel was found, but its selection could not be saved. Your other connection settings are unchanged.",
    );
  }
  return channel;
}

function configuration(provider: Provider, home: string) {
  if (provider === "youtube") return { ...youtubeConfiguration(home), group: "", cookie: "" };
  const env = readConfig(join(home, "Skool Scraper", ".env"), ["SKOOL_COOKIE", "SKOOL_GROUP_NAME"]);
  const fullCookie = env.SKOOL_COOKIE || "";
  const auth = fullCookie.match(/(?:^|;\s*)auth_token=([^;\r\n]+)/)?.[1];
  const client = fullCookie.match(/(?:^|;\s*)client_id=([^;\r\n]+)/)?.[1];
  const group = /^[a-z0-9][a-z0-9-]{0,100}$/.test(env.SKOOL_GROUP_NAME || "")
    ? env.SKOOL_GROUP_NAME
    : "";
  return {
    key: "",
    channelId: "",
    group,
    cookie: auth ? `auth_token=${auth}${client ? `; client_id=${client}` : ""}` : "",
  };
}

export function discoverBusinessIntegrations(options: AdapterOptions = {}) {
  const home = options.homeDir || homedir();
  return (["skool", "youtube"] as const).map((id) => {
    const config = configuration(id, home);
    return {
      id,
      configured:
        id === "skool"
          ? Boolean(config.cookie && config.group)
          : Boolean(config.key && config.channelId),
      ...(id === "youtube"
        ? { keyConfigured: Boolean(config.key), channelId: config.channelId }
        : {}),
    };
  });
}

async function responseText(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body)
    throw new Error("Invalid provider response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Invalid provider response");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function metric(value: unknown) {
  // Empty strings, absent fields and provider errors never become zero metrics.
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export async function syncBusinessIntegration(
  provider: Provider,
  options: AdapterOptions = {},
): Promise<{ snapshots: BusinessIntegrationSnapshot[] }> {
  if (provider !== "skool" && provider !== "youtube")
    throw new Error("Choose a supported business connection.");
  const config = configuration(provider, options.homeDir || homedir());
  const request = options.request || fetch;
  if (provider === "skool" && (!config.cookie || !config.group))
    throw new Error("No saved Skool connection was found on this Mac.");
  if (provider === "youtube" && (!config.key || !config.channelId))
    throw new Error(
      "Configure your YouTube API key and channel ID in ~/.config/agentic-os.env first.",
    );

  try {
    let snapshot: BusinessIntegrationSnapshot;
    if (provider === "skool") {
      const sourceUrl = `https://www.skool.com/${config.group}`;
      const response = await request(sourceUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Cookie: config.cookie,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html",
          Referer: sourceUrl,
          Origin: "https://www.skool.com",
        },
      });
      if (!response.ok) throw new Error("Provider unavailable");
      const html = await responseText(response);
      const json = html.match(
        /<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i,
      )?.[1];
      if (!json) throw new Error("Missing provider data");
      const page = JSON.parse(json)?.props?.pageProps;
      const group = page?.currentGroup;
      if (!page?.self || group?.name !== config.group)
        throw new Error("Connection needs attention");
      const members = metric(group.metadata?.totalMembers);
      // This established community has thousands of members; an unexpected zero
      // is not evidence of a lost audience. Preserve previous observations.
      if (members === undefined || members === 0) throw new Error("Missing member count");
      const values: Record<string, number> = { members };
      const online = metric(group.metadata?.totalOnlineMembers),
        posts = metric(group.metadata?.totalPosts);
      if (online !== undefined) values.onlineMembers = online;
      if (posts !== undefined) values.posts = posts;
      snapshot = {
        platform: "skool",
        recordedAt: new Date().toISOString(),
        metrics: values,
        origin: "connector",
        sourceLabel: "Skool · live community total",
        measurementScope: "skool-community-totals-v1",
        sourceUrl,
      };
    } else {
      const url = new URL("https://www.googleapis.com/youtube/v3/channels");
      url.search = new URLSearchParams({
        part: "statistics",
        id: config.channelId,
        key: config.key,
      }).toString();
      const response = await request(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Provider unavailable");
      const item = JSON.parse(await responseText(response)).items?.find(
        (entry: any) => entry.id === config.channelId,
      );
      if (!item?.statistics || item.statistics.hiddenSubscriberCount)
        throw new Error("Missing channel count");
      const subscribers = metric(item.statistics.subscriberCount);
      if (subscribers === undefined) throw new Error("Missing channel count");
      const values: Record<string, number> = { followers: subscribers };
      const views = metric(item.statistics.viewCount),
        videos = metric(item.statistics.videoCount);
      if (views !== undefined) values.views = views;
      if (videos !== undefined) values.videos = videos;
      snapshot = {
        platform: "youtube",
        recordedAt: new Date().toISOString(),
        metrics: values,
        origin: "connector",
        sourceLabel: "YouTube · live API, rounded subscribers",
        measurementScope: "youtube-channel-totals-v1",
        sourceUrl: `https://www.youtube.com/channel/${config.channelId}`,
      };
    }
    if (provider === "youtube") {
      const current = youtubeConfiguration(options.homeDir || homedir());
      if (current.key !== config.key || current.channelId !== config.channelId)
        throw new Error("Connection changed");
    }
    return { snapshots: [snapshot] };
  } catch {
    // Network exceptions can contain request URLs (including API keys), so never
    // forward a provider error, header, response body or credential path.
    throw new Error(
      provider === "skool"
        ? "Skool could not confirm a member total. Check the saved connection and retry; existing numbers are unchanged."
        : "YouTube could not confirm a subscriber total. Check the saved connection and retry; existing numbers are unchanged.",
    );
  }
}
