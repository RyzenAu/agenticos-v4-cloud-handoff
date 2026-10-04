// Inbox triage inside the running OS: /__operator/inbox/triage* and the run lock.
//
//   GET  /inbox/triage          today's log, shadow progress, settings (no phone numbers), digest
//   GET  /inbox/triage/digest   the daily digest lines (the morning brief reads this)
//   POST /inbox/triage/run      { sync?: true } refresh the selected mailboxes (read-only), then
//                               triage every new email and dispatch any alerts
//
// Local only: someone signed in over the tailnet gets 403 (this is the owner's own mail).
import { callReadiness, hermesTelegram, readSettings, retellCall, type Channels } from "./alerts";
import { archivedEmails, digest, loadContacts, runTriage, shadowReport } from "./engine";
import { openTriageStore } from "./store";

export type InboxTriageDeps = {
  /** Refresh the selected native mailboxes into the archive (read-only provider access). */
  sync?: () => Promise<unknown>;
  submitEvent: (body: unknown) => unknown;
  jevKey: () => string;
  retellKey: () => string;
  telegram?: Channels["telegram"];
  now?: () => number;
};

export function createInboxTriage(root: string, deps: InboxTriageDeps) {
  const now = deps.now ?? Date.now;
  let running: Promise<unknown> | null = null;
  const channels = (): Channels => ({
    telegram: deps.telegram ?? hermesTelegram(),
    voice: async (event) => {
      const result = deps.submitEvent(event) as { accepted?: boolean; duplicate?: boolean; event?: { delivery?: string; reason?: string } | null };
      return { ok: !!(result?.accepted || result?.duplicate), detail: result?.duplicate ? "duplicate" : `${result?.event?.delivery ?? "queued"}${result?.event?.reason ? ` (${result.event.reason})` : ""}` };
    },
    call: retellCall(() => readSettings(root), deps.retellKey),
  });

  async function run(options: { sync?: boolean } = {}) {
    if (running) return { busy: true };
    const task = (async () => {
      let synced: string = "skipped";
      if (options.sync && deps.sync) {
        try { await deps.sync(); synced = "ok"; } catch (error) { synced = `failed: ${String((error as Error)?.message ?? "").slice(0, 160)}`; }
      }
      const settings = readSettings(root);
      const store = openTriageStore(root);
      try {
        // The very first run over an existing mailbox only logs: a backlog never becomes DMs.
        const backfill = store.counts().total === 0;
        const result = await runTriage({ store, settings, contacts: loadContacts(root), emails: archivedEmails(root, 200), jevKey: deps.jevKey(), backfill, channels: channels(), now: now() });
        return {
          synced,
          backfill,
          alertsEnabled: settings.alerts.enabled,
          scanned: result.scanned,
          logged: result.logged.length,
          wouldAlert: result.logged.filter((r) => r.wouldAlert).length,
          alerts: result.alerts,
        };
      } finally {
        store.close();
      }
    })();
    running = task;
    try { return await task; } finally { running = null; }
  }

  function overview() {
    const settings = readSettings(root);
    const store = openTriageStore(root);
    try {
      const at = now();
      const rows = store.since(new Date(at - 24 * 3_600_000).toISOString(), 300);
      const counts = store.counts();
      const shadow = shadowReport(store.recent(500));
      return {
        alerts: { ...settings.alerts },
        call: { enabled: settings.call.enabled, ready: callReadiness(settings, !!deps.retellKey()).length === 0, missing: callReadiness(settings, !!deps.retellKey()) },
        jev: { mode: settings.jev.mode, shadowTarget: settings.jev.shadowTarget, shadowDone: Math.min(counts.withJev, settings.jev.shadowTarget), keyPresent: !!deps.jevKey() },
        counts,
        shadow: { ...shadow, disagreements: shadow.disagreements.slice(0, 50) },
        digest: digest(store, at),
        rows,
      };
    } finally {
      store.close();
    }
  }

  return {
    run,
    overview,
    /** Returns null for paths it doesn't own. */
    async handle(method: string, path: string, body: any, remote: boolean): Promise<{ status: number; value: unknown } | null> {
      if (!path.startsWith("/inbox/triage")) return null;
      if (remote) return { status: 403, value: { error: "Inbox triage is for this PC only." } };
      if (method === "GET" && path === "/inbox/triage") return { status: 200, value: overview() };
      if (method === "GET" && path === "/inbox/triage/digest") {
        const settings = readSettings(root);
        const store = openTriageStore(root);
        try {
          return { status: 200, value: { enabled: settings.alerts.enabled, ...digest(store, now()) } };
        } finally {
          store.close();
        }
      }
      if (method === "POST" && path === "/inbox/triage/run") return { status: 200, value: await run({ sync: body?.sync === true }) };
      return { status: 404, value: { error: "Unknown inbox triage route." } };
    },
  };
}
export type InboxTriage = ReturnType<typeof createInboxTriage>;
