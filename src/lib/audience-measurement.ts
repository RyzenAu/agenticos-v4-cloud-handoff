/** Only scopes whose metric definitions are verified by a shipped adapter. */
export type AudienceMeasurementScope = "youtube-channel-totals-v1" | "skool-community-totals-v1";

/** A label or API key does not establish measurement scope or channel identity. */
export function audienceMeasurementIdentity(platform: unknown, scope: unknown, sourceUrl: unknown): string | undefined {
  if (typeof sourceUrl !== "string") return undefined;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    const path = url.pathname.replace(/\/$/, "");
    if (platform === "youtube" && scope === "youtube-channel-totals-v1" && ["youtube.com", "www.youtube.com"].includes(url.hostname)) {
      const id = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1];
      if (id) return `youtube:${id}`;
    }
    if (platform === "skool" && scope === "skool-community-totals-v1" && ["skool.com", "www.skool.com"].includes(url.hostname)) {
      const group = path.match(/^\/([a-z0-9][a-z0-9-]{0,100})$/)?.[1];
      if (group) return `skool:${group}`;
    }
  } catch { /* Unknown or malformed metadata remains non-comparable. */ }
  return undefined;
}
