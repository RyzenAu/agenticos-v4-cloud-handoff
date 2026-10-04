/**
 * Brand from URL: Firecrawl's branding format → a Motion Library theme.
 * The key is read server-side only and never leaves this process.
 *
 * M&U: Firecrawl is a paid key we do not hold, so without one the brand comes
 * from the free reader the lead engine already uses (scripts/site-draft/brand.ts):
 * colours, fonts and logo from the site's own home page and one first-party
 * stylesheet, fetched politely (robots.txt, public addresses only).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isDisallowed } from "../../../scripts/leads/enrich";
import { extractBrandTokens, stylesheetUrls } from "../../../scripts/site-draft/brand";
import { brandTheme, cleanName } from "../engine/brand";
import type { Theme } from "../engine/types";

export const FIRECRAWL_SETUP = "https://www.firecrawl.dev/app/api-keys";

export class BrandError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly setup = false,
  ) {
    super(message);
  }
}

/** Loopback, private, link-local and CGNAT (Tailscale) ranges. */
export function privateAddress(ip: string): boolean {
  return /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|::ffff:|fc|fd|fe80)/i.test(
    ip,
  );
}

/** Public http(s) pages only. */
export function brandURL(input: unknown): URL {
  if (typeof input !== "string" || !input.trim() || input.length > 2048)
    throw new BrandError("Paste a website address.");
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BrandError("That doesn't look like a website address.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new BrandError("Use an http or https address.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net") ||
    !host.includes(".") ||
    (isIP(host) && privateAddress(host))
  )
    throw new BrandError("Use a public website; Firecrawl can't read local addresses.");
  url.hash = "";
  return url;
}

type Branding = {
  colorScheme?: string;
  logo?: string | null;
  colors?: Record<string, string | undefined>;
  fonts?: { family?: string }[];
  typography?: { fontFamilies?: Record<string, string | undefined> };
  images?: { logo?: string | null; favicon?: string | null };
};

export interface BrandResult {
  theme: Theme;
  logoUrl: string | null;
  site: string;
  colors: string[];
}

export async function brandFromUrl(
  input: unknown,
  key: string,
  fallback: Theme,
  fetchImpl: typeof fetch = fetch,
): Promise<BrandResult> {
  const url = brandURL(input);
  if (!key)
    throw new BrandError(
      "Add a Firecrawl key to brand from a URL. Get one at firecrawl.dev, then set FIRECRAWL_API_KEY.",
      412,
      true,
    );
  let response: Response;
  try {
    response = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.href,
        formats: ["branding"],
        onlyMainContent: false,
        timeout: 60000,
      }),
      signal: AbortSignal.timeout(75000),
    });
  } catch (error) {
    throw new BrandError(
      error instanceof Error && error.name === "TimeoutError"
        ? "Firecrawl took too long. Try again in a moment."
        : "Couldn't reach Firecrawl. Check your connection.",
      502,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new BrandError("Firecrawl rejected the key. Check FIRECRAWL_API_KEY.", 401, true);
  if (response.status === 402)
    throw new BrandError("Your Firecrawl credits have run out.", 402, true);
  if (response.status === 429)
    throw new BrandError("Firecrawl is rate limiting. Try again in a minute.", 429);
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { branding?: Branding; metadata?: Record<string, unknown> };
  } | null;
  if (!response.ok || !body?.success || !body.data?.branding)
    throw new BrandError(
      body?.error
        ? `Firecrawl: ${String(body.error).slice(0, 160)}`
        : "Firecrawl couldn't read that site's brand.",
      502,
    );
  const b = body.data.branding;
  const meta = body.data.metadata ?? {};
  const c = b.colors ?? {};
  const colors = [
    c.primary,
    c.accent,
    c.secondary,
    c.link,
    c.background,
    c.textPrimary,
    c.textSecondary,
  ].filter((x): x is string => typeof x === "string");
  const family =
    b.typography?.fontFamilies?.heading ||
    b.typography?.fontFamilies?.primary ||
    b.fonts?.[0]?.family ||
    null;
  const siteName =
    (typeof meta.ogSiteName === "string" && meta.ogSiteName) ||
    (typeof meta["og:site_name"] === "string" && (meta["og:site_name"] as string)) ||
    (typeof meta.title === "string" && meta.title) ||
    (Array.isArray(meta.title) && typeof meta.title[0] === "string" && meta.title[0]) ||
    "";
  const hostLabel = url.hostname.replace(/^www\./, "").split(".")[0];
  const name =
    cleanName(siteName) || cleanName(hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1));
  const theme = brandTheme(
    {
      colors: [c.primary, c.accent, c.secondary, c.link].filter(
        (x): x is string => typeof x === "string",
      ),
      background: c.background,
      text: c.textPrimary,
      font: family,
      name,
    },
    fallback,
  );
  const logo = b.logo || b.images?.logo || null;
  return {
    theme,
    logoUrl: typeof logo === "string" && /^https?:\/\//.test(logo) ? logo : null,
    site: url.hostname.replace(/^www\./, ""),
    colors,
  };
}

const READER_AGENT =
  "Mozilla/5.0 (compatible; MU-Ventures-MotionLibrary/1.0; +https://muventures.com.au)";

/** Every hop must still be a public address once DNS has answered (no rebinding to the LAN). */
async function publicHop(url: URL, resolve: typeof lookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!answers.length || answers.some((a) => privateAddress(a.address)))
    throw new BrandError("Use a public website; that address points inside this network.");
}

async function politeGet(
  start: URL,
  fetchImpl: typeof fetch,
  resolve: typeof lookup,
  accept: string,
  limit: number,
): Promise<{ url: URL; text: string } | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    await publicHop(url, resolve);
    const response = await fetchImpl(url.href, {
      headers: { "User-Agent": READER_AGENT, Accept: accept },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) return null;
      url = brandURL(new URL(next, url).href);
      continue;
    }
    if (!response.ok) return null;
    return { url, text: (await response.text()).slice(0, limit) };
  }
  return null;
}

async function robotsAllow(url: URL, fetchImpl: typeof fetch, resolve: typeof lookup) {
  try {
    const robots = await politeGet(new URL("/robots.txt", url), fetchImpl, resolve, "text/plain", 200_000);
    if (!robots) return true;
    // Same reader and precedence as the lead engine (User-agent: *, longest match wins).
    return !isDisallowed(robots.text, url.pathname || "/");
  } catch {
    return true;
  }
}

/** Free brand reader: no key, no third party; the site's own HTML and CSS only. */
export async function brandFromSite(
  input: unknown,
  fallback: Theme,
  fetchImpl: typeof fetch = fetch,
  resolve: typeof lookup = lookup,
): Promise<BrandResult & { source: "site" }> {
  const url = brandURL(input);
  if (!(await robotsAllow(url, fetchImpl, resolve)))
    throw new BrandError("That site asks not to be read by tools, so its brand wasn't pulled.", 403);
  let page: { url: URL; text: string } | null;
  try {
    page = await politeGet(url, fetchImpl, resolve, "text/html", 2_000_000);
  } catch (error) {
    if (error instanceof BrandError) throw error;
    throw new BrandError("Couldn't reach that site. Check the address and try again.", 502);
  }
  if (!page) throw new BrandError("That site didn't return a page to read.", 502);
  let css = "";
  const sheet = stylesheetUrls(page.text, page.url.href)[0];
  if (sheet)
    try {
      css = (await politeGet(brandURL(sheet), fetchImpl, resolve, "text/css", 400_000))?.text ?? "";
    } catch {
      /* The page alone still carries inline colours and fonts. */
    }
  const tokens = extractBrandTokens(page.text, page.url.href, css);
  if (!tokens.colours.length && !tokens.fonts.length && !tokens.logoUrl)
    throw new BrandError("Couldn't find colours, fonts or a logo on that page.", 422);
  const decode = (text: string) =>
    text
      .replace(/&(?:amp|#0*38|#x0*26);/gi, "&")
      .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
      .replace(/&(?:quot|#0*34);/gi, '"')
      .replace(/&nbsp;/gi, " ");
  const meta = (name: string) =>
    decode(
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, "i").exec(
        page.text,
      )?.[1] ?? "",
    );
  const title = decode(/<title[^>]*>([^<]*)<\/title>/i.exec(page.text)?.[1] ?? "");
  const hostLabel = url.hostname.replace(/^www\./, "").split(".")[0];
  const name =
    cleanName(meta("og:site_name")) ||
    cleanName(title.trim()) ||
    cleanName(hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1));
  const colours = tokens.primary
    ? [tokens.primary, ...tokens.colours.filter((c) => c !== tokens.primary)]
    : tokens.colours;
  // extractBrandTokens skips quoted families (font-family:"Fraunces",serif), which most
  // sites use, so read the first named family here too.
  const quoted = /font-family\s*:\s*["']([^"']{2,48})["']/i.exec(`${page.text}\n${css}`)?.[1] ?? null;
  const theme = brandTheme(
    { colors: colours.slice(0, 4), font: tokens.fonts[0] ?? quoted, name },
    fallback,
  );
  return {
    theme,
    logoUrl: tokens.logoUrl && /^https?:\/\//.test(tokens.logoUrl) ? tokens.logoUrl : null,
    site: url.hostname.replace(/^www\./, ""),
    colors: colours,
    source: "site",
  };
}
