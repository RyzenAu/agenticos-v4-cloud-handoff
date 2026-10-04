import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  bulkReason,
  isBulkMail,
  senderParts,
} from "../src/lib/inbox-bulk";
import {
  currencyPrefix,
  fmtAgo,
  fmtAudProse,
  fmtDataProse,
  fmtDateTime,
  fmtDay,
  fmtMoney,
  fmtMoneyCents,
  fmtMoneyCompact,
  fmtMonthYear,
  fmtProse,
  fmtRate,
  fmtTime,
  fmtUsdProse,
  fmtWeekday,
  fmtWhenShort,
  formatViolations,
  staleNote,
} from "../src/lib/format";
import { classifyMessage } from "./account-connections";
import { photoCaption } from "../src/lib/memory-title";

// L10 (29 Sep 2026): ONE formatter for money, dates and times (audit AUD-OS P2-6).
// Local-time constructors keep these independent of the machine's time zone.

test("times are 12-hour, lower-case, with no leading zero", () => {
  expect(fmtTime(new Date(2026, 8, 29, 4, 56))).toBe("4:56 am");
  expect(fmtTime(new Date(2026, 8, 29, 16, 5))).toBe("4:05 pm");
  expect(fmtTime(new Date(2026, 8, 29, 0, 0))).toBe("12:00 am");
  expect(fmtTime(new Date(2026, 8, 29, 12, 30))).toBe("12:30 pm");
  expect(fmtTime(new Date(2026, 8, 29, 13, 36, 9), { seconds: true })).toBe("1:36:09 pm");
  expect(fmtTime(null)).toBe("—");
  expect(fmtTime("not a date")).toBe("—");
  // never 24-hour, never "AM", never a leading zero
  for (const h of [0, 3, 7, 10, 14, 23]) expect(fmtTime(new Date(2026, 8, 29, h, 7))).toMatch(/^(?:[1-9]|1[0-2]):07 (?:am|pm)$/);
});

test("times can be read in a named zone", () => {
  // 2026-09-29 04:56 UTC is 2:56 pm in Sydney (AEST, UTC+10, before daylight saving starts on 4 Oct).
  const at = new Date(Date.UTC(2026, 8, 29, 4, 56));
  expect(fmtTime(at, { timeZone: "Australia/Sydney" })).toBe("2:56 pm");
  expect(fmtDay(at, { timeZone: "Australia/Sydney" })).toBe("29 Sept");
  expect(fmtTime(at, { timeZone: "UTC" })).toBe("4:56 am");
});

test("dates are en-AU, day first, 'Sept', and never ISO in prose", () => {
  expect(fmtDay(new Date(2026, 8, 29))).toBe("29 Sept");
  expect(fmtDay(new Date(2026, 8, 29), { year: true })).toBe("29 Sept 2026");
  expect(fmtDay(new Date(2026, 0, 5))).toBe("5 Jan");
  expect(fmtDay(new Date(2026, 5, 1))).toBe("1 Jun");
  expect(fmtDay(new Date(2026, 8, 29), { weekday: true })).toBe("Tue 29 Sept");
  expect(fmtDay(new Date(2026, 8, 29), { weekday: "long" })).toBe("Tuesday 29 Sept");
  expect(fmtDay("2026-09-28")).toBe("28 Sept"); // a bare calendar day is that day, in any zone
  expect(fmtDay("2026-09-28", { year: true })).toBe("28 Sept 2026");
  expect(fmtDay(new Date(2020, 8, 29), { year: "auto" })).toBe("29 Sept 2020");
  expect(fmtDay(new Date(), { year: "auto" })).not.toMatch(/20\d\d/);
  expect(fmtDateTime(new Date(2026, 8, 29, 16, 56))).toBe("29 Sept, 4:56 pm");
  expect(fmtDateTime(new Date(2026, 8, 29, 16, 56), { weekday: true, year: true })).toBe("Tue 29 Sept 2026, 4:56 pm");
  expect(fmtMonthYear(new Date(2026, 8, 1))).toBe("Sept 2026");
  expect(fmtMonthYear(new Date(2026, 8, 1), { longMonth: true })).toBe("September 2026");
  expect(fmtWeekday(new Date(2026, 8, 29))).toBe("Tue");
  expect(fmtDay(undefined)).toBe("—");
});

test("a dense list shows the time for today and the date for anything older", () => {
  const now = new Date(2026, 8, 29, 18, 0);
  expect(fmtWhenShort(new Date(2026, 8, 29, 9, 5), now)).toBe("9:05 am");
  expect(fmtWhenShort(new Date(2026, 8, 27, 9, 5), now)).toBe("27 Sept");
  expect(fmtWhenShort(new Date(2025, 11, 27, 9, 5), now)).toBe("27 Dec 2025");
});

test("Australian dollars are A$, every other currency is named, nothing prints a bare $", () => {
  expect(fmtMoney(1234.5)).toBe("A$1,234.50");
  expect(fmtMoney(120, { trimZeros: true })).toBe("A$120");
  expect(fmtMoney(120.5, { trimZeros: true })).toBe("A$120.50");
  expect(fmtMoney(0.97, { currency: "USD" })).toBe("US$0.97");
  expect(fmtMoney(0)).toBe("A$0.00");
  expect(fmtMoney(1234.56, { whole: true })).toBe("A$1,235");
  expect(fmtMoney(-42, { whole: true })).toBe("-A$42");
  expect(fmtMoney(0.0042, { currency: "USD", precise: true })).toBe("US$0.0042");
  expect(fmtMoney(0.731, { currency: "USD", precise: true })).toBe("US$0.731");
  expect(fmtMoney(5, { currency: "NZD" })).toBe("NZ$5.00");
  expect(fmtMoney(5, { currency: "gbp" })).toBe("£5.00");
  expect(fmtMoney(5, { currency: "XYZ" })).toBe("XYZ 5.00");
  expect(fmtMoney(null)).toBe("—"); // missing is never "$0"
  expect(fmtMoney(Number.NaN)).toBe("—");
  expect(fmtMoneyCents(12400)).toBe("A$124.00");
  expect(currencyPrefix("aud")).toBe("A$");
  expect(currencyPrefix("USD")).toBe("US$");
});

test("compact money and rates keep the A$ prefix ($100k -> A$100k, $120/h -> A$120/h)", () => {
  expect(fmtMoneyCompact(100000)).toBe("A$100k");
  expect(fmtMoneyCompact(1_250_000)).toBe("A$1.25m");
  expect(fmtMoneyCompact(9500)).toBe("A$9,500");
  expect(fmtMoneyCompact(1500, { compactFrom: 1000 })).toBe("A$1.5k");
  expect(fmtMoneyCompact(2_500_000, { currency: "USD" })).toBe("US$2.5m");
  expect(fmtRate(120, "h")).toBe("A$120/h");
  expect(fmtRate(120, "h", { currency: "USD" })).toBe("US$120/h");
  expect(fmtRate(null, "h")).toBe("—");
});

test("prose tidy-ups: ISO days, year-months, USD and AUD text, UTC probe times", () => {
  expect(fmtProse("checked 2026-09-28 · effective date 2026-08")).toBe("checked 28 Sept 2026 · effective date Aug 2026");
  expect(fmtProse("expired unreviewed on 2026-09-28")).toBe("expired unreviewed on 28 Sept 2026");
  // a date that is part of a file name or path is a name, not prose
  expect(fmtProse("docs/sales/dental-call-pack-2026-09-28/receptionist-prompt/v3-live-2026-09-27.md")).toBe("docs/sales/dental-call-pack-2026-09-28/receptionist-prompt/v3-live-2026-09-27.md");
  expect(fmtProse("see v3-live-2026-09-27.md, checked 2026-09-27.")).toBe("see v3-live-2026-09-27.md, checked 27 Sept 2026.");
  expect(fmtProse("27 Sep 13:17Z succeeded")).toBe("27 Sept 1:17 pm UTC succeeded");
  expect(fmtProse("no dates here, v2026-09 or 12345")).not.toContain("Sept");
  expect(fmtProse(null)).toBe("");
  expect(fmtUsdProse("listed $0.14/$0.28 and an exact $0 :free id")).toBe("listed US$0.14/US$0.28 and an exact US$0 :free id");
  expect(fmtUsdProse("A$5 and US$5 are already labelled")).toBe("A$5 and US$5 are already labelled");
  expect(fmtAudProse("Scale to $100k/month")).toBe("Scale to A$100k/month");
  expect(fmtAudProse("already A$100k and US$3")).toBe("already A$100k and US$3");
  expect(fmtDataProse("probe 27 Sep succeeded, $0")).toBe("probe 27 Sept succeeded, US$0");
});

test("the guard flags raw ISO dates, unlabelled dollars and 24-hour AM/PM strings, and passes clean text", () => {
  expect(formatViolations("Updated 2026-09-22 at $100k, $120/h")).toEqual(["$100k", "$120", "2026-09-22"]);
  expect(formatViolations("1:36 AM")).toEqual(["1:36 AM"]);
  expect(formatViolations("29 Sept 2026, 4:56 am, A$100k, US$0.97, A$120/h")).toEqual([]);
});

test("freshness shows only when it means something", () => {
  const now = Date.UTC(2026, 8, 29, 6, 0);
  expect(staleNote(now - 60_000, now)).toBeNull(); // fresh: nothing in the reading path
  expect(staleNote(now - 3 * 3_600_000, now)).toBe("Stale: last read 3 h ago");
  expect(staleNote(null, now)).toBe("No successful read yet");
  expect(staleNote(now, 0)).toBeNull(); // before the first client tick
  expect(fmtAgo(now - 30_000, now)).toBe("just now");
  expect(fmtAgo(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(fmtAgo(now - 2 * 86_400_000, now)).toBe("2 days ago");
});

test("photo captions read 'Photo · date' for ids and camera names, and keep real names", () => {
  const when = new Date(2026, 8, 29, 10, 0);
  expect(photoCaption("f97cf22b-c4e5-45c9-831c-3b2a1d4e5f60.png", when)).toBe("Photo · 29 Sept");
  expect(photoCaption("IMG_2041.jpg", when)).toBe("Photo · 29 Sept");
  expect(photoCaption("Screenshot 2026-09-29 at 10.00.00.png", when)).toBe("Screenshot 2026-09-29 at 10.00.00.png");
  expect(photoCaption("Team lunch.jpg", when)).toBe("Team lunch.jpg");
  expect(photoCaption("f97cf22b-c4e5-45c9-831c-3b2a1d4e5f60.png", null)).toBe("Photo");
});

// ── Inbox: bulk / newsletter / marketing mail never reaches "To answer" ────────────────────────────

test("senderParts reads plain and display-name addresses", () => {
  expect(senderParts('"Acme Cloud" <Offers@e.acmecloud.example>')).toEqual({ local: "offers", domain: "e.acmecloud.example" });
  expect(senderParts("jo@example.com.au")).toEqual({ local: "jo", domain: "example.com.au" });
  expect(senderParts("no address")).toBeNull();
});

test("bulk rule (synthetic mail only): headers, Gmail categories and sender patterns", () => {
  // Gmail's own category label
  expect(bulkReason({ from: "Ada <ada@example.com>", subject: "Hi", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })).toMatch(/promotions/);
  // List-Unsubscribe header
  expect(isBulkMail({ from: "Team <team@vendor.example>", subject: "Your week", listUnsubscribe: true })).toBe(true);
  expect(bulkReason({ from: "a@b.example", subject: "s", precedence: "bulk" })).toMatch(/bulk/);
  // robot / campaign senders
  expect(isBulkMail({ from: "Acme <no-reply@acme.example>", subject: "Your account" })).toBe(true);
  expect(isBulkMail({ from: "deals@shop.example", subject: "Hello" })).toBe(true);
  expect(isBulkMail({ from: "News <hello@news.brand.example>", subject: "Weekly" })).toBe(true); // mailer subdomain
  // marketing-style subjects (a price alert from a shopping site)
  expect(isBulkMail({ from: "alerts@x.example", subject: "Price drop: 20% off your watched item" })).toBe(true);
  expect(isBulkMail({ from: "someone@x.example", subject: "Sale ends tonight" })).toBe(true);
  expect(isBulkMail({ from: "someone@x.example", subject: "Hi", body: "Thanks!\n\nTo unsubscribe from these emails click here." })).toBe(true);
});

test("bulk rule never hides a person's message or a conversation", () => {
  expect(isBulkMail({ from: "Brooke <brooke@client.example.com.au>", subject: "Can you call me?", body: "Hi Usman, are you free tomorrow?" })).toBe(false);
  expect(isBulkMail({ from: "hello@smallbiz.example", subject: "Quote for the website" })).toBe(false); // info@/hello@ can be a real client
  expect(isBulkMail({ from: "no-reply@acme.example", subject: "Re: your request", isReply: true })).toBe(false);
  expect(isBulkMail({ from: "no-reply@acme.example", subject: "Promo", hasDraft: true })).toBe(false);
  expect(isBulkMail({ from: "mehroz@example.com", subject: "Sale ends when?", isReply: true })).toBe(false);
});

test("classifyMessage sends bulk mail to the low-priority group and keeps real mail in needs-you", () => {
  const promo = classifyMessage("Save 30% off cloud credits", "Limited time. Unsubscribe any time.", { from: "Cloud <offers@e.cloud-vendor.example>", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], listUnsubscribe: true });
  expect(promo.category).toBe("updates");
  expect(promo.reason).toMatch(/Bulk or marketing mail/);
  const alert = classifyMessage("Price alert: back in stock", "The item you watched is back.", { from: "alerts@shopping.example" });
  expect(alert.category).toBe("updates");
  const person = classifyMessage("Can we move the call?", "Hi Usman, could we do Thursday instead?", { from: "Brooke <brooke@client.example.com.au>", labelIds: ["INBOX", "CATEGORY_PERSONAL"], isReply: true });
  expect(person.category).toBe("needs-you");
  // With no metadata at all (Outlook, imports) the existing rules still decide.
  expect(classifyMessage("Hello", "Are you free?").category).toBe("needs-you");
  expect(classifyMessage("Our newsletter", "unsubscribe below").category).toBe("updates");
  expect(classifyMessage("Sponsor your channel?", "A brand deal for you").category).toBe("sponsors");
});

// ── Guard: no ad-hoc date, time or currency formatting left in the app's own source ──────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// Reviewed exceptions: a machine key rather than prose, a third-party UI kit, the formatter itself,
// and two purely numeric day/weekday cells in the voice overlay.
const ALLOWED = new Set([
  "src/lib/format.ts",
  "src/components/ui/calendar.tsx",
  "src/components/operator/leads-crm.tsx", // en-CA gives a sortable YYYY-MM-DD key, never shown
  "src/components/operator/voice-visuals.tsx",
  "src/components/profile/profile-panel.tsx", // dateStyle/timeStyle short forms
]);

test("guard: dates, times and currency go through src/lib/format.ts", () => {
  const offenders: string[] = [];
  for (const file of walk(join(import.meta.dir, "..", "src"))) {
    const rel = relative(join(import.meta.dir, ".."), file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    if (/\.toLocaleTimeString\(/.test(src)) offenders.push(`${rel}: toLocaleTimeString`);
    if (/\.toLocaleDateString\(/.test(src)) offenders.push(`${rel}: toLocaleDateString`);
    if (/style:\s*["']currency["']/.test(src)) offenders.push(`${rel}: Intl currency`);
    if (/hour12\s*:\s*false|["']en-GB["']\s*,\s*\{[^}]*hour:/.test(src)) offenders.push(`${rel}: 24-hour clock`);
  }
  expect(offenders).toEqual([]);
});

test("guard: the touched pages have no clutter chips, rings or unlabelled estimates left in source", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  // Receptionist: no "Updated just now · Sources" line in the reading path, no ring on the tiles or the gates.
  const rx = read("src/components/receptionist/dashboard/index.tsx");
  expect(rx).not.toContain("Sources: /__receptionist");
  expect(rx).not.toMatch(/Updated \$\{fmtRelative/);
  expect(read("src/components/receptionist/dashboard/sell-status.tsx")).not.toContain("<ProgressRing");
  expect(read("src/components/receptionist/gates.tsx")).not.toContain("<ProgressRing");
  // Mission Control: the assumption-times-assumption figures live only under an "Estimates" disclosure.
  const mc = read("src/routes/-pages/dashboard.tsx");
  expect(mc).not.toContain("Skills saved (estimate)");
  expect(mc).not.toContain("value per dollar (estimate)");
  expect((mc.match(/Assumed, not measured/g) ?? []).length).toBeGreaterThanOrEqual(2);
  const kpiGrid = mc.slice(mc.indexOf('aria-label="Key numbers"'), mc.indexOf("<Disclosure", mc.indexOf('aria-label="Key numbers"')));
  expect(kpiGrid).not.toContain("Skills saved");
  expect(kpiGrid).toContain('label="AI spend"');
  // The ChatGPT plan price carries "+ GST" here as it does on /usage.
  expect(mc).toContain('" + GST"');
});

test("page output: the package economics view prints no ISO date in prose and no bare dollar sign", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { EconomicsWorkbench } = await import("../src/components/business/economics-workbench");
  const html = renderToStaticMarkup(React.createElement(EconomicsWorkbench));
  const text = html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
  // File names in the evidence list keep their own dates; everything else is a "28 Sept 2026" style date.
  const prose = text.replace(/\S*\/\S*/g, " ");
  expect(formatViolations(prose)).toEqual([]);
  expect(text).toContain("28 Sept 2026");
});
