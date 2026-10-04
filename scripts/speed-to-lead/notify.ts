// Speed-to-lead: the Telegram DM text and the link into the OS. Deliberately name-free — Jarvis
// already reaches only the owner's own chat (see inbox-triage/alerts.ts's hermesTelegram /
// away-mode/notify.ts's hermesNotifier, both reused as-is by run.ts), so this isn't about
// stranger-safety, it's about not putting a visitor's name on a lock-screen notification.
const SLA_LABEL = "1h";

export function alertText(topic: string): string {
  return `New M&U enquiry · ${topic} · reply within ${SLA_LABEL}`;
}

/**
 * The link into the OS the Telegram DM carries. `osBaseUrl` is wherever the Workspace app is
 * reachable (default: the local dev/production origin); the path itself is a convention for the
 * os-shell track to route (see docs/SPEED-TO-LEAD.md) — this module doesn't own any routing.
 */
export function osLeadUrl(osBaseUrl: string, ref: string): string {
  return `${osBaseUrl.replace(/\/+$/, "")}/today?enquiry=${encodeURIComponent(ref)}`;
}

export function alertMessage(topic: string, osBaseUrl: string, ref: string): string {
  return `${alertText(topic)}\n${osLeadUrl(osBaseUrl, ref)}`;
}
