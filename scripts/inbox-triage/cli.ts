// Inbox triage command line (run from the AgenticOS-v4 folder):
//
//   bun scripts/inbox-triage/cli.ts shadow [--limit 50] [--db <path>]   triage the newest archived emails, log only, print the shadow report
//   bun scripts/inbox-triage/cli.ts status                              switches, shadow progress, call-hook readiness
//   bun scripts/inbox-triage/cli.ts digest                              the last 24 h digest lines
//   bun scripts/inbox-triage/cli.ts alerts on|off                       THE switch for live alerts (Telegram DM + voice)
//   bun scripts/inbox-triage/cli.ts telegram|voice|leads on|off         per-channel switches (alerts must also be on)
//   bun scripts/inbox-triage/cli.ts test-dm                             one "[test] inbox triage alert" DM to the owner
//
// Nothing here replies to, sends, archives, labels or deletes an email.
import { providerKey } from "../provider-config";
import { callReadiness, hermesTelegram, readSettings, telegramText, writeSettings } from "./alerts";
import { archivedEmails, digest, loadContacts, runTriage, shadowReport } from "./engine";
import { openTriageStore, type TriageRow } from "./store";
import { CATEGORIES, IMPORTANCE } from "./rules";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const jevKey = () => providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY");

function table(rows: TriageRow[]) {
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length]));
  const byImp = Object.fromEntries(IMPORTANCE.map((i) => [i, rows.filter((r) => r.importance === i).length]));
  const jevCat = Object.fromEntries(CATEGORIES.map((c) => [c, rows.filter((r) => r.jevCategory === c).length]));
  const jevImp = Object.fromEntries(IMPORTANCE.map((i) => [i, rows.filter((r) => r.jevImportance === i).length]));
  return { byCategory: byCat, byImportance: byImp, jevByCategory: jevCat, jevByImportance: jevImp };
}
const line = (r: TriageRow) => `${r.receivedAt.slice(5, 16)} ${r.senderDomain.padEnd(28).slice(0, 28)} ${r.subject.slice(0, 60).padEnd(60)} rules=${r.rulesCategory}/${r.rulesImportance} jev=${r.jevCategory ?? "-"}/${r.jevImportance ?? "-"}${r.jev ? ` (c${Math.round(r.jev.categoryConfidence * 100)} i${Math.round(r.jev.importanceConfidence * 100)} m${Math.round(r.jev.manipulation * 100)})` : r.jevError ? ` (${r.jevError})` : ""}`;

async function main() {
  const [command, value] = args;
  if (command === "shadow") {
    const limit = Math.max(1, Math.min(Number(flag("--limit") ?? 50), 500));
    const store = openTriageStore(root, flag("--db") ? { path: flag("--db") } : {});
    try {
      const emails = archivedEmails(root, limit * 3).slice(0, limit);
      const result = await runTriage({ store, settings: readSettings(root), contacts: loadContacts(root), emails, jevKey: jevKey(), backfill: true, concurrency: 4 });
      const ids = new Set(emails.map((e) => e.id));
      const rows = store.recent(2000).filter((r) => ids.has(r.messageId));
      const report = shadowReport(rows);
      console.log(JSON.stringify({ scanned: emails.length, newlyLogged: result.logged.length, ...table(rows), shadow: { withJev: report.withJev, jevErrors: report.jevErrors, agreeCategory: report.agreeCategory, agreeImportance: report.agreeImportance, jevHigher: report.jevHigher, jevLower: report.jevLower } }, null, 2));
      console.log("\nWould alert (rules OR Jev-urgent):");
      for (const r of rows.filter((r) => r.wouldAlert)) console.log(`  [${r.alertBasis}] ${line(r)}\n      why: ${r.alertReason.slice(0, 160)}`);
      console.log("\nJev and rules disagree:");
      for (const r of report.disagreements) console.log(`  ${line(r)}`);
      console.log("\nAll:");
      for (const r of rows) console.log(`  ${r.category.padEnd(10)} ${r.importance.padEnd(6)} ${line(r)}`);
    } finally {
      store.close();
    }
    return;
  }
  if (command === "status") {
    const s = readSettings(root);
    const store = openTriageStore(root);
    try {
      const counts = store.counts();
      console.log(JSON.stringify({
        alerts: s.alerts, jev: { ...s.jev, shadowDone: Math.min(counts.withJev, s.jev.shadowTarget), keyPresent: !!jevKey() },
        call: { enabled: s.call.enabled, missing: callReadiness(s, !!providerKey(root, "RETELL_API_KEY")) }, log: counts,
      }, null, 2));
    } finally { store.close(); }
    return;
  }
  if (command === "digest") {
    const store = openTriageStore(root);
    try { console.log(digest(store).lines.join("\n")); } finally { store.close(); }
    return;
  }
  if (["alerts", "telegram", "voice", "leads"].includes(command ?? "")) {
    if (value !== "on" && value !== "off") throw new Error(`Say: ${command} on|off`);
    const s = readSettings(root);
    const on = value === "on";
    if (command === "alerts") s.alerts.enabled = on;
    if (command === "telegram") s.alerts.telegram = on;
    if (command === "voice") s.alerts.voice = on;
    if (command === "leads") s.alerts.leadReplies = on;
    writeSettings(root, s);
    console.log(`${command} ${value}. Live alerts are ${s.alerts.enabled ? "ON" : "OFF (armed: every would-be alert is logged as armed-off)"}.`);
    return;
  }
  if (command === "test-dm") {
    const row = {
      messageId: "test", account: "", threadId: "test", receivedAt: new Date().toISOString(), loggedAt: new Date().toISOString(),
      senderName: "Jarvis self-test", senderAddress: "", senderDomain: "agentic-os", subject: "Inbox triage alert path check",
      summary: "No real email: this proves Jarvis can DM you from inbox triage.", category: "client", importance: "today",
      reason: "", rulesCategory: "client", rulesImportance: "today", jevCategory: null, jevImportance: null, jev: null, jevMs: null, jevError: null,
      relationship: "unknown", flags: {}, wouldAlert: true, alertBasis: "rules",
      alertReason: `Test only. Live alerts are ${readSettings(root).alerts.enabled ? "ON" : "still OFF until you switch them on"}.`,
      alertStatus: "", mode: "test", policyVersion: "test", backfill: false,
    } as TriageRow;
    const sent = await hermesTelegram()(telegramText(row, true));
    console.log(sent.ok ? "Test DM sent to the owner's Telegram." : `Test DM failed: ${sent.detail}`);
    if (!sent.ok) process.exitCode = 1;
    return;
  }
  console.log("Commands: shadow [--limit N] | status | digest | alerts on|off | telegram|voice|leads on|off | test-dm");
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
