#!/usr/bin/env bun
/**
 * R11 visual pass 2: realistic SYNTHETIC records for Calendar, Inbox (+triage) and Design/Studio on a synthetic hub.
 * Activity already has finished, failed, stopped and unknown jobs from the seed-gate hub. The Receptionist reads Retell, which a synthetic
 * hub does not have, so it keeps its honest "unknown" state.
 * Usage: bun scripts/r11-visual-seed2.ts [port] [data dir, e.g. D:\AgenticOS-r11-data\pages2]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { classifyMessage } from "./account-connections";
const port = Number(process.argv[2] ?? 8193);
const data = process.argv[3] ?? "D:\\AgenticOS-r11-data\\pages2";
if (port === 8081 || port < 8120 || port > 8199 || !/AgenticOS-r\d+-data/.test(data)) throw new Error("synthetic hub only");
const base = `http://127.0.0.1:${port}`;
const token = ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
const H = { "content-type": "application/json", "x-claude-os-token": token };
const post = async (path: string, body: unknown) => (await (await fetch(`${base}/__operator${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;

// ---- calendar: an .ics with this week and next
const d = (days: number, h: number, m = 0) => {
  const t = new Date();
  t.setDate(t.getDate() + days);
  t.setHours(h, m, 0, 0);
  return t;
};
const ics = (t: Date) => t.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
const events: [string, Date, Date, string][] = [
  ["Kickoff call: Synthetic Parramatta and Western Sydney Family Dental and Orthodontic Specialists Pty Ltd", d(0, 15), d(0, 16), "Zoom"],
  ["Website review with Orchard Hills Real Estate", d(1, 10), d(1, 11), "Orchard Hills office"],
  ["Receptionist acceptance calls (5 retest calls)", d(1, 14), d(1, 15, 30), "Phone"],
  ["Mehroz and Usman weekly planning", d(2, 9), d(2, 10), ""],
  ["Blacktown Conveyancing: sign agreement", d(3, 11), d(3, 11, 45), "Video"],
  ["Care plan renewal check, Castle Hill Smiles", d(4, 13), d(4, 13, 30), ""],
  ["Mount Druitt Physio: content walkthrough", d(6, 16), d(6, 17), "Studio"],
  ["Quarterly BAS and GST review", d(8, 9), d(8, 10), ""],
  ["Penrith Plumbing and Gas launch check", d(9, 12), d(9, 13), ""],
];
const raw = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//synthetic//EN",
  ...events.flatMap(([s, a, b, loc], i) => [
    "BEGIN:VEVENT",
    `UID:synthetic-${i}@example.test`,
    `DTSTAMP:${ics(new Date())}`,
    `DTSTART:${ics(a)}`,
    `DTEND:${ics(b)}`,
    `SUMMARY:${s}`,
    ...(loc ? [`LOCATION:${loc}`] : []),
    "END:VEVENT",
  ]),
  "END:VCALENDAR",
].join("\r\n");
const imp = await post("/calendar/import", { ics: raw, timeMin: d(-30, 0).toISOString(), timeMax: d(120, 0).toISOString() });
console.log("calendar", imp.added ?? imp.error);

// ---- inbox: archive rows (read by the inbox page and the triage log)
const db = new Database(join(data, "mail-archive.sqlite"));
db.exec("PRAGMA busy_timeout=10000");
const mails: [string, string, string, number][] = [
  ["Dana Orchard <dana@orchard-hills.example>", "Re: homepage draft: two changes before we approve", "Hi, the hero photo needs to be the front of the clinic, not the stock one. Can you also move the booking button higher? Happy to approve after that.", 2],
  ["Priya Raman-Whitfield <priya@blacktown-law.example>", "Signed agreement attached, please confirm start date for the Blacktown Conveyancing and Property Law Group website", "Please find the signed agreement. Can you confirm the start date and when the first preview is due?", 5],
  ["Stripe <notifications@stripe.example>", "Payment failed for invoice 2041", "A payment of $1,650.00 failed. Update the payment method to retry.", 9],
  ["Google Security <no-reply@accounts.example>", "Security alert: new sign-in on a Windows device", "A new sign-in to your account was detected.", 20],
  ["Vercel <notifications@vercel.example>", "Deployment ready: muventures-marketing", "Your deployment is ready.", 30],
  ["Sam Nguyen <sam@orchard-hills.example>", "Quick question about GST on the care plan", "Is the monthly care plan quoted ex GST? Our accountant asked.", 45],
  ["Newsletter <hello@news.example>", "Ten tips for faster websites", "This week we cover images, fonts and caching.", 70],
  ["Alex Kowalczyk-Smith <alex@mount-druitt-physio.example>", "Can we move the Thursday walkthrough to Friday afternoon?", "Something came up on Thursday. Does Friday at 4pm suit you both?", 95],
];
let n = 0;
for (const [from, subject, body, minutesAgo] of mails) {
  const account = "synthetic@example.test";
  const remoteId = `syn-${n++}`;
  const id = `gmail:synthetic:${remoteId}`;
  const receivedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const item = {
    id, remoteId, account, source: "gmail", subject, from, to: [account], body, receivedAt, status: "open",
    ...classifyMessage(subject, body),
    read: n > 4, labelIds: n > 4 ? ["INBOX"] : ["INBOX", "UNREAD"], threadId: remoteId, direction: "inbound", url: "",
  };
  db.prepare("INSERT OR REPLACE INTO messages(id,provider,account,remote_id,received_at,subject,sender,body,item_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "gmail", account, remoteId, receivedAt, subject, from, body, JSON.stringify(item), "{}");
}
db.close();
console.log("mail", n, "triage:", JSON.stringify(await post("/inbox/triage/run", {})).slice(0, 160));

// ---- design / studio assets: real small images + ledger lines in the synthetic home
const crc = (b: Buffer) => {
  let t = 0xffffffff;
  for (const x of b) {
    let c = (t ^ x) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t = (t >>> 8) ^ c;
  }
  return (t ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type), body]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const png = (w: number, h: number, rgb: [number, number, number]) => {
  const px = Array.from({ length: w }, (_, x) => [Math.round(rgb[0] * (0.6 + (0.4 * x) / w)), rgb[1], rgb[2]]).flat();
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(px)]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
};
const home = `${data}-side\\home`;
const dir = join(home, "Desktop", "designs", "synthetic");
mkdirSync(dir, { recursive: true });
mkdirSync(join(home, ".claude-os", "design"), { recursive: true });
const names = ["hero-orchard-hills-clinic-front.png", "blacktown-conveyancing-og-image-with-a-rather-long-file-name-for-wrapping.png", "castle-hill-smiles-social-square.png", "mount-druitt-physio-banner.png", "receptionist-explainer-still.png", "penrith-plumbing-truck-mockup.png"];
const ledger = join(home, ".claude-os", "design", "ledger.jsonl");
writeFileSync(ledger, "");
const colours: [number, number, number][] = [[200, 90, 60], [60, 120, 200], [90, 170, 120], [180, 150, 60], [120, 80, 180], [70, 140, 150]];
names.forEach((name, i) => {
  const p = join(dir, name);
  writeFileSync(p, png(640, 400, colours[i]));
  appendFileSync(ledger, JSON.stringify({ path: p, ts: Date.now() - i * 3_600_000, agent: ["studio", "claude", "hermes", "studio", "claude", "studio"][i], kind: "image", tool: "synthetic", prompt: `Synthetic prompt ${i + 1}: a calm, bright hero image for a local business website`, model: "synthetic-model", w: 640, h: 400, costUsd: 0.04 }) + "\n");
});
console.log("design", names.length);
