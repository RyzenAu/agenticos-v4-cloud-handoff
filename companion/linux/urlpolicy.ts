import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Which addresses a shared computer's browser may be sent to. A cloud computer is a sandbox that browses the PUBLIC web; it sits
 * beside the hub (or on its bridge), so it must never be aimed at the hub, the host, the tailnet or a cloud metadata service.
 *
 *  - only http(s), no user:pass@, no non-standard schemes;
 *  - the host must not be localhost, a *.local / *.internal / *.localdomain name, or (after DNS) any loopback, private,
 *    link-local (169.254.0.0/16 holds cloud metadata), CGNAT/tailnet (100.64.0.0/10), multicast or unspecified address;
 *  - a numeric host the URL parser normalises (2130706433, 0x7f.1) is judged as the address it really is.
 *
 * DNS can change between this check and the browser's own lookup (rebinding), so the companion checks again on the page it
 * actually landed on (executors-linux.ts). It narrows the gap; a network-level egress rule on the VM (deploy/computers/README.md)
 * closes it.
 */

export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, tailnet
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === "::" || x === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x)) return false; // ULA, link-local, multicast
    return true;
  }
  return false;
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

export async function checkPublicUrl(raw: unknown, resolve: Resolver = systemResolver): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Only http and https pages can be opened." };
  if (url.username || url.password) return { ok: false, reason: "No credentials in the address." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/.test(host)) return { ok: false, reason: "That address is on a private network, so the computer won't open it." };
  if (isIP(host)) return isPublicAddress(host) ? { ok: true, url } : { ok: false, reason: "That address is on a private network, so the computer won't open it." };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: `Couldn't find ${host}.` };
  }
  if (!addresses.length) return { ok: false, reason: `Couldn't find ${host}.` };
  if (!addresses.every(isPublicAddress)) return { ok: false, reason: "That name points at a private network address, so the computer won't open it." };
  return { ok: true, url };
}
