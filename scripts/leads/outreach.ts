// Outreach rules. Nothing here sends or dials: it decides *when* a founder may call, and writes
// drafts a founder reads, edits and sends himself.
//
// Calls: Telecommunications (Telemarketing and Research Calls) Industry Standard 2017 — calls
// Mon–Fri 9 am–8 pm, Sat 9 am–5 pm, never Sunday or a public holiday (recipient's time; NSW, where
// every business we call is, plus the national days);
// say who you are, the business and why you're calling; never withhold caller ID.
// Email: Spam Act 2003 — only to an address the business published itself, only about its
// business, identify M&U, and a working opt-out that the CRM honours (`optout`).
import { isVerifiedFact } from "./score";

/** National public holidays, recipient's date (update each December). */
export const NATIONAL_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-26", "2026-04-03", "2026-04-06", "2026-04-25", "2026-12-25", "2026-12-26",
  "2027-01-01", "2027-01-26", "2027-03-26", "2027-03-29", "2027-04-25", "2027-12-25", "2027-12-26",
]);

function sydneyParts(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * NSW public holidays that are not national days, including substitute ("additional") days and
 * Easter Saturday (Public Holidays Act 2010 (NSW)). The NSW Bank Holiday (first Monday in August)
 * is banks-only and is not listed. Update each December with NATIONAL_HOLIDAYS.
 */
export const NSW_PUBLIC_HOLIDAYS = new Set([
  "2026-04-04", "2026-06-08", "2026-10-05", "2026-12-28",
  "2027-03-27", "2027-06-14", "2027-10-04", "2027-12-27", "2027-12-28",
  "2028-01-03", "2028-04-14", "2028-04-15", "2028-04-17", "2028-04-25", "2028-06-12", "2028-10-02", "2028-12-25", "2028-12-26",
]);
/** Every day with no calls: national days plus NSW days (owner decision 27 Sep: no calls on public holidays). */
export const NO_CALL_HOLIDAYS: ReadonlySet<string> = new Set([...NATIONAL_HOLIDAYS, ...NSW_PUBLIC_HOLIDAYS]);

/** Is it lawful to make a B2B telemarketing call to a NSW business right now? */
export function callWindow(date = new Date()): { open: boolean; why: string } {
  const { ymd, weekday, minutes } = sydneyParts(date);
  if (NATIONAL_HOLIDAYS.has(ymd)) return { open: false, why: "national public holiday: no calls" };
  if (NSW_PUBLIC_HOLIDAYS.has(ymd)) return { open: false, why: "NSW public holiday: no calls" };
  if (weekday === "Sun") return { open: false, why: "Sunday: no calls" };
  const close = weekday === "Sat" ? 17 * 60 : 20 * 60;
  if (minutes < 9 * 60) return { open: false, why: "before 9 am: calls open at 9" };
  if (minutes >= close) return { open: false, why: weekday === "Sat" ? "after 5 pm Saturday" : "after 8 pm" };
  return { open: true, why: weekday === "Sat" ? "open until 5 pm (Saturday)" : "open until 8 pm" };
}

export type Sender = { name: string; business: string; website: string; phone?: string };

export const DEFAULT_SENDER: Sender = { name: "Usman", business: "M&U Ventures", website: "muventures.com.au" };

const WHAT = { dental: "practice", legal: "firm", "real-estate": "agency" } as const;

// score.ts's verdict is `reasons[0]` — built for a screen ("Redesign + receptionist: not
// mobile-friendly, no HTTPS"), not a sentence a founder says out loud. This turns it back into
// something natural for the live call opener. The drawer's separate AI call-script feature does
// its own thing and is untouched — this only affects the quick card/CLI "Say:" line.
const VERDICT_PREFIX = /^[A-Za-z][\w\s]*?(?:\s*\(maybe\))?(?:\s*\+\s*receptionist)?:\s*/;

/** A terse verdict fragment (score.ts's Signal.verdict values) -> a phrase you'd actually say. */
function naturalisePhrase(fragment: string): string {
  const f = fragment.trim();
  if (/^not mobile-friendly \(overflows at 390px\)$/i.test(f)) return "your site doesn't fit properly on a phone screen";
  if (/^not mobile-friendly$/i.test(f)) return "your site isn't set up for phones";
  if (/^no HTTPS$/i.test(f)) return "it doesn't have a secure https connection";
  if (/^SSL error$/i.test(f)) return "it's got a security certificate problem";
  if (/^no online booking$/i.test(f)) return "there's no way to book online";
  // No missed-call framing (review T5): name the cover that's missing, not calls "going unanswered".
  if (/^after-hours calls go unanswered$/i.test(f)) return "there's no after-hours phone cover listed on the site";
  let m: RegExpMatchArray | null;
  if ((m = f.match(/^©\s*(\d{4})$/))) return `the copyright says ${m[1]} — looks like it hasn't been updated in a while`;
  if ((m = f.match(/^homepage down\b/i))) return "your homepage was showing an error when I checked";
  if ((m = f.match(/^broken \(HTTP (\d+)\)$/i))) return "the site was showing an error when I checked";
  if ((m = f.match(/^LCP ([\d.]+)\s*s$/i))) return `it took about ${m[1]} seconds to load when I checked`;
  if ((m = f.match(/^([\d.]+)\s*s load$/i))) return `it took about ${m[1]} seconds to load`;
  if ((m = f.match(/^dated (\w+) template$/i))) return `it looks like it's still on an older ${m[1]} template`;
  return f.toLowerCase(); // never silently drop a real finding — say it plainly if it's not in the table above
}

function naturalJoin(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/** Rewrites reasons[0] (score.ts's verdict, e.g. "Redesign + receptionist: not mobile-friendly,
 *  no HTTPS") into a spoken hook ("your site isn't set up for phones and it doesn't have a secure
 *  https connection"). Mentions at most 2 findings. A verdict with no colon-separated fragment
 *  list (e.g. "No website found", "Audit pending — …") is left as its own already-plain sentence. */
export function humaniseOpenerHook(reasons: string[]): string {
  const verdict = reasons[0]?.trim();
  if (!verdict) return "";
  const match = verdict.match(VERDICT_PREFIX);
  if (!match) return verdict;
  const fragments = verdict
    .slice(match[0].length)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fragments.length) return verdict;
  return naturalJoin(fragments.slice(0, 2).map(naturalisePhrase));
}

/** 25 Sep 2026 (issues.ts): when a lead has an evidenced issue on file, the opener leads with it —
 *  still saying who's calling, from which business and why, before asking for 30 seconds (the
 *  Telemarketing Industry Standard's identify-yourself rule). `hook` completes "noticed …". */
export function issueOpener(lead: { name: string }, hook: string, sender = DEFAULT_SENDER) {
  const h = hook.trim().replace(/[.\s]+$/, "");
  return (
    `Hi, it's ${sender.name} from ${sender.business} — we're a small Sydney web and AI-receptionist studio. ` +
    `I was looking at ${lead.name ? `${lead.name}'s` : "your"} website and noticed ${h}. Have you got 30 seconds for me to explain why I'm calling?`
  );
}

export function callOpener(lead: { name: string; vertical: keyof typeof WHAT; reasons: string[]; hook?: string | null }, sender = DEFAULT_SENDER) {
  if (lead.hook?.trim()) return issueOpener(lead, lead.hook, sender);
  // "I noticed" only introduces what was seen on the site (score.ts isVerifiedFact), never a
  // directory or hours inference (review T5: no missed-call framing from score-only reasons).
  const hook = humaniseOpenerHook(lead.reasons.filter(isVerifiedFact));
  return (
    `Hi, it's ${sender.name} from ${sender.business}, a Sydney web and AI-receptionist studio. ` +
    `I'm calling about ${lead.name}'s website and phone handling — is now an OK time for 30 seconds?${hook ? ` I noticed ${hook}.` : ""}`
  );
}

/** The approved call to action and promise (sales pack build/common.py CTA, PROMISE). */
export const DEMO_CTA = "Book a 15-minute demo";
export const RECEPTIONIST_PROMISE = "Each business's booking, routing and texts are set up and tested before they go live.";

export type EmailPitch = "website" | "redesign" | "receptionist" | "both" | "audit_pending";

/** The CRM stores `pitch` as free text (default ''); the email wording has five. Anything else reads as a website pitch. */
export function emailPitch(pitch: string): EmailPitch {
  return pitch === "receptionist" || pitch === "both" || pitch === "redesign" || pitch === "audit_pending" ? pitch : "website";
}

/** A founder's contact note that rules email out ("phone only", "no emails", "don't email"). */
export function prefersNoEmail(contactPref: string | null | undefined): boolean {
  // Review R8: the negation must be about email itself ("no emails", "don't email"), not a
  // neighbouring channel: "no phone, email only" prefers email.
  const p = (contactPref ?? "").toLowerCase().replace(/[’']/g, "'");
  if (/\be-?mails?\s+only\b|\bonly\s+(by\s+)?e-?mail\b/.test(p)) return false;
  return /\b(no|don't|do not|never|not by|not via)\s+(e-?mail|e-?mails|emailing)\b/.test(p)
    || /\be-?mails?\s*[:=]?\s*(no|never)\b/.test(p)
    || /\b(phone|call|calls|text|sms)\s+only\b/.test(p);
}

/**
 * The cold-email draft (F1-03, F1-33). It only says "noticed" about something actually seen: the
 * lead's evidenced issue hook, or reasons verified on its own site (score.ts isVerifiedFact);
 * directory/score-only signals are never presented as observations. Receptionist lines follow the
 * catalogue: configurable cover (never missed-call framing), booking into a connected Google
 * Calendar or Cal.com calendar from go-live, set up and tested first. The ask is the approved CTA.
 * The founder's contact note is respected: it is never quoted, and a no-email note refuses a draft.
 */
export function emailDraft(
  lead: { name: string; vertical: keyof typeof WHAT; reasons: string[]; pitch: "website" | "redesign" | "receptionist" | "both" | "audit_pending"; hook?: string | null; contactPref?: string | null },
  sender = DEFAULT_SENDER,
  verified: (reason: string) => boolean = isVerifiedFact,
) {
  if (prefersNoEmail(lead.contactPref)) throw new Error("Their contact preference rules out email. Call instead (see the lead's contact note).");
  const what = WHAT[lead.vertical];
  const receptionist = `an AI receptionist that answers your calls in the cover you choose (after hours, overflow or alongside your team) and takes a clear message and callback request, then, once it's set up and tested, books into a connected Google Calendar or Cal.com calendar`;
  const offer =
    lead.pitch === "receptionist"
      ? receptionist
      : lead.pitch === "both"
        ? `a faster, mobile-first website, plus ${receptionist}`
        : lead.pitch === "redesign"
          ? `a redesign of your current site — faster, mobile-first, with online booking built in`
          : lead.pitch === "audit_pending"
            ? `a quick, honest look at your current site and what we could improve`
            : `a faster, mobile-first website with online booking built in`;
  // Only evidence counts as "noticed": an issue hook beats verified reasons; score-only signals never.
  const seen = lead.hook?.trim() ? lead.hook.trim().replace(/[.\s]+$/, "") : lead.reasons.filter(verified).slice(0, 2).join(" and ");
  const opening = seen
    ? `I had a look at your ${what} online and noticed ${seen}.`
    : `I had a look at your ${what} online and there are a couple of things worth a quick check together.`;
  const hasReceptionist = lead.pitch === "receptionist" || lead.pitch === "both";
  const subject = `A quick idea for ${lead.name}`;
  const body = [
    `Hi ${lead.name} team,`,
    ``,
    opening,
    `We build ${offer} for ${lead.vertical === "real-estate" ? "agencies" : lead.vertical === "legal" ? "firms" : "practices"} around Sydney.`,
    ...(hasReceptionist ? [RECEPTIONIST_PROMISE] : []),
    ``,
    hasReceptionist
      ? `If it's useful, ${DEMO_CTA.toLowerCase()} and I'll take you through a demonstration call and what your team would see. Just reply with a time.`
      : `If it's useful, ${DEMO_CTA.toLowerCase()} and I'll show you a short before/after for your ${what}. Just reply with a time.`,
    ``,
    `${sender.name}`,
    `${sender.business} · ${sender.website}${sender.phone ? ` · ${sender.phone}` : ""}`,
    ``,
    `You're getting this because your address is published on your website. Reply "stop" and we won't email you again.`,
  ].join("\n");
  return { subject, body };
}
