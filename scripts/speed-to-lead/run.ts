// Speed-to-lead watcher: run this on a schedule (see "Patch for lead" in
// docs/SPEED-TO-LEAD.md — it is NOT registered anywhere yet, that needs the owner's yes).
//
// Each run: reads the existing inbox-triage metadata log (sender/subject/received-at only — the
// same log the Workspace "email" panel already reads; see scripts/inbox-triage/store.ts) for the
// marketing site's own enquiry notification emails, opens/updates a CRM enquiry record with a
// business-hours-aware response clock, and — for a genuinely new one — DMs the owner on Telegram
// through the same Hermes path inbox-triage already uses (scripts/inbox-triage/alerts.ts's
// hermesTelegram). It never opens a message body and never calls a mail provider itself: the
// metadata is already sitting in inbox-triage's own sqlite log, kept fresh by that existing
// pipeline.
//
// Idempotent: every run re-scans a lookback window (default 24h) and re-upserts by ref, but
// openEnquiryStore().upsert only ever inserts once per ref, so overlapping runs (or a missed one
// catching up) never reset the clock or send a second Telegram DM.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermesTelegram } from "../inbox-triage/alerts";
import { openTriageStore, type TriageStore } from "../inbox-triage/store";
import { crmPath, openCrm } from "../leads/crm";
import { startClock } from "./clock";
import { alertMessage } from "./notify";
import { openEnquiryStore, type EnquiryStore } from "./store";
import { detectNewEnquiries, normalizeAddress, type MetadataRow } from "./watcher";

const LOOKBACK_HOURS = 24;
const DEFAULT_OS_BASE_URL = "http://127.0.0.1:8081";

/** SPEED_TO_LEAD_FROM_EMAIL — the marketing route's ENQUIRY_FROM_EMAIL, so the watcher knows
 *  which sender to treat as an enquiry notification. process.env first (tests, overrides), then
 *  ~/.config/agentic-os.env — same convention as places.ts's placesKey() / watch.ts's
 *  changeDetectionApiKeyFromFile(): never logged, never returned wrapped in an error. */
export function enquiryFromAddress(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const direct = env.SPEED_TO_LEAD_FROM_EMAIL?.trim();
  if (direct) return normalizeAddress(direct);
  try {
    const file = join(home, ".config", "agentic-os.env");
    if (!existsSync(file)) return "";
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*SPEED_TO_LEAD_FROM_EMAIL\s*=\s*(.*)$/);
      if (match) return normalizeAddress(match[1].trim().replace(/^["']|["']$/g, ""));
    }
  } catch {
    /* reported below as "not configured" */
  }
  return "";
}

export type RunResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      checked: number;
      detected: number;
      results: { ref: string; created: boolean; notified: boolean }[];
    };

export type RunDeps = {
  root: string;
  now?: Date;
  osBaseUrl?: string;
  fromAddress?: string;
  lookbackHours?: number;
  /** Injected for tests; defaults to the real inbox-triage log, read-only. */
  triage?: Pick<TriageStore, "since" | "close">;
  /** Injected for tests; defaults to the real CRM. */
  enquiries?: EnquiryStore & { close?: () => void };
  /** Injected for tests; defaults to hermesTelegram() (a real `hermes send`). */
  notify?: (text: string) => Promise<{ ok: boolean; detail: string }>;
};

export async function runOnce(deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? new Date();
  const fromAddress = deps.fromAddress ?? enquiryFromAddress();
  if (!fromAddress) return { ok: false, reason: "SPEED_TO_LEAD_FROM_EMAIL is not configured" };

  const triage = deps.triage ?? openTriageStore(deps.root, { readonly: true });
  const closeTriage = deps.triage ? () => {} : () => triage.close();
  let crmDb: ReturnType<typeof openCrm> | null = null;
  const enquiries =
    deps.enquiries ??
    (() => {
      crmDb = openCrm(crmPath(deps.root));
      return openEnquiryStore(crmDb);
    })();

  try {
    const since = new Date(
      now.getTime() - (deps.lookbackHours ?? LOOKBACK_HOURS) * 3_600_000,
    ).toISOString();
    const rows: MetadataRow[] = triage.since(since, 500).map((r) => ({
      messageId: r.messageId,
      senderAddress: r.senderAddress,
      subject: r.subject,
      receivedAt: r.receivedAt,
    }));
    const detected = detectNewEnquiries(rows, { fromAddress });
    const notify = deps.notify ?? hermesTelegram();
    const results: { ref: string; created: boolean; notified: boolean }[] = [];

    for (const enquiry of detected) {
      const clock = startClock(new Date(enquiry.receivedAt));
      const { created } = enquiries.upsert({
        ref: enquiry.ref,
        topic: enquiry.topic,
        receivedAt: enquiry.receivedAt,
        detectedAt: now.toISOString(),
        startedAt: clock.startedAt,
        dueAt: clock.dueAt,
        outsideHoursAtArrival: clock.outsideHoursAtArrival,
      });
      let notified = false;
      // Only a genuinely new ref gets a DM — a re-detected one (still inside the lookback window
      // on a later run) is already sitting in the owner's Telegram history.
      if (created) {
        const text = alertMessage(
          enquiry.topic,
          deps.osBaseUrl ?? DEFAULT_OS_BASE_URL,
          enquiry.ref,
        );
        const sent = await notify(text).catch(() => ({ ok: false, detail: "notify threw" }));
        notified = sent.ok;
        if (sent.ok) enquiries.markNotified(enquiry.ref, now.toISOString());
      }
      results.push({ ref: enquiry.ref, created, notified });
    }
    return { ok: true, checked: rows.length, detected: detected.length, results };
  } finally {
    closeTriage();
    crmDb?.close();
  }
}

if (import.meta.main) {
  runOnce({ root: process.cwd() })
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
