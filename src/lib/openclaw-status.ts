// OpenClaw in plain words (W-B, 29 Sep 2026). Owner: "I don't know the point of it." In this OS OpenClaw
// is only a bridge: a loopback gateway (tailnet-only on :8444) that paired devices (the owner's iPhone,
// Mehroz's PC) join as nodes, so Hermes can run a device action there through its `openclaw-nodes`
// skill. Nobody chats with it; there's no swarm. The page shows that sentence and the pairing status,
// read from /__operator/capabilities (devices.openclaw-nodes).

export const OPENCLAW_PURPOSE =
  "OpenClaw is the private bridge that lets Jarvis, through Hermes, do things on a paired device (your iPhone or Mehroz's PC) over Tailscale; you don't use it directly.";

export type OpenClawCapability = { status?: string; evidence?: string; ownerAction?: string } | null | undefined;
export type OpenClawDevice = { name: string; commands: number | null };
export type OpenClawView = {
  tone: "ok" | "warn" | "neutral";
  title: string;
  why: string;
  devices: OpenClawDevice[];
  gateway: "running" | "not running" | "unknown";
  next: string | null;
};

/** "connected: iPhone (12 commands), Mehroz PC (3 commands)" → devices. Anything else → none. */
export function connectedDevices(evidence: string | undefined): OpenClawDevice[] {
  const m = /^connected:\s*(.+)$/i.exec(evidence ?? "");
  if (!m) return [];
  return m[1].split(/,\s*(?![^()]*\))/).map((part) => {
    const d = /^(.*?)\s*\((\d+) commands?\)\s*$/.exec(part.trim());
    return d ? { name: d[1], commands: Number(d[2]) } : { name: part.trim(), commands: null };
  }).filter((d) => d.name);
}

export function openClawView(capability: OpenClawCapability, failed: boolean): OpenClawView {
  if (failed) return { tone: "neutral", title: "Couldn't read OpenClaw's status", why: "The status check didn't answer, so whether your phone is connected is unknown right now.", devices: [], gateway: "unknown", next: null };
  if (!capability) return { tone: "neutral", title: "Checking OpenClaw…", why: "Reading the bridge and paired devices.", devices: [], gateway: "unknown", next: null };
  const evidence = capability.evidence ?? "";
  if (capability.status === "available") {
    const devices = connectedDevices(evidence);
    const names = devices.map((d) => d.name).join(" and ") || "a device";
    return { tone: "ok", title: `${names} ${devices.length > 1 ? "are" : "is"} connected`, why: "Jarvis can ask Hermes to act on it. Anything consequential still asks you first.", devices, gateway: "running", next: null };
  }
  const gatewayDown = /^OpenClaw gateway /i.test(evidence);
  if (gatewayDown)
    return { tone: "warn", title: "The bridge isn't running", why: `No device can be reached (${evidence.replace(/^OpenClaw gateway /i, "gateway ")}). Nothing else in the OS depends on it.`, devices: [], gateway: "not running", next: capability.ownerAction ?? null };
  const paired = /(\d+) paired node/.exec(evidence);
  return {
    tone: "warn",
    title: paired ? "Your phone is paired but not connected" : "No device is paired",
    why: paired ? "The bridge is running, but no paired device is online. Open Tailscale and the OpenClaw app on the phone." : "The bridge is running and waiting for a device.",
    devices: [],
    gateway: "running",
    next: capability.ownerAction ?? null,
  };
}
