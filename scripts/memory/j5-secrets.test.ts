// J5: the remaining findings of the second independent review of the secrets work (REVIEW-J3-R2.md sections 2, 3, 4).
// Every value below is obviously fake (test card numbers, the ATO's documented example TFN, invented passwords).
import { describe, expect, test } from "bun:test";
import { foldForMatching, MAX_FACT_SCAN_CHARS, MAX_NOTE_CHARS, normaliseForSecrets, screenFact, screenNote, sensitiveCategory } from "./guard";
import { noteRefusal } from "../jarvis-skills/notes";

const refused = (t: string) => !screenFact(t).ok;
const CARD = "4111111111111111";
const spread = (sep: string) => CARD.split("").join(sep);

describe("F3/F4: a year inside a password no longer clears a credential pair", () => {
  const MUST_REFUSE = [
    // Strong cues (login, log in, sign in, cred, creds, credentials): any password-shaped value refuses, year or not.
    "cred: jane/Summer2026",
    "creds admin / Summer2026",
    "log in as jane, Summer2026",
    "credentials jane / Summer2026",
    "router login is admin, Summer2026",
    "router login is admin then Summer2026",
    "router login admin colon Summer2026",
    "login for Stripe is usman at example dot com and Summer2026",
    "the login for Xero is jane, Summer2026",
    "creds jane Summer2026",
    "creds admin / Coventry2019",
    "cred: jane/hunter2024xyz",
    "log in as jane, Qwerty2010!",
    // Weak cues with a pair separator, a device cue, or a value that ends the clause.
    "usr jane / Summer2026",
    "router: admin / Summer2026",
    "admin / Summer2026 for the router",
    "my details are jane and Summer2026",
    "the Netflix account is usman@example.com with Summer2026",
    "account: usman@example.com Summer2026",
    // New joiners: an em or en dash, and "it is" / "it's" / "that is" before the value.
    "netflix \u2014 usman@example.com / Sunflower99",
    "netflix \u2013 usman@example.com / Sunflower99",
    "the login is jane and it is Sunflower99",
    "the login is jane and it's Sunflower99",
    "the login is jane and that is Sunflower99",
    "login is jane, it's Sunflower99",
  ];
  for (const t of MUST_REFUSE)
    test(`refused: ${t}`, () => {
      expect([t, refused(t)]).toEqual([t, true]);
      expect([t, screenNote(`# Note\n\n${t}\n`).ok]).toEqual([t, false]);
      expect([t, noteRefusal(t) !== null]).toEqual([t, true]);
    });

  // A whole date, a code name, or a business identifier after a WEAK cue is still a note, not a credential.
  const STILL_ALLOWED = [
    "the account is Mehroz with 12-Oct-2026 renewal date",
    "the email is jane@example.com with Sunflower2026 attached",
    "the account is Mehroz and DentalDemo2026 preview",
    "user is Mehroz and Q4-Launch2026 campaign",
    "the account is Bianca and MU-Ventures-2026 pilot",
    "the user is Usman, Nexus-v2-Release goes out Friday",
    "the email is jane@example.com, Invoice10042 attached",
    "the email is jane@example.com with Proposal12345 attached",
    "the account is jane with Sprint14Plan",
    "account is bianca, Ticket88231 open",
    "the details are jane and Proposal12345",
    "the router is admin with Firmware1234 installed",
    "netflix \u2014 the streaming account for the client demo",
    "Hours \u2014 Monday / Friday",
    "Contact \u2014 jane@example.com / info@example.com",
  ];
  for (const t of STILL_ALLOWED)
    test(`allowed: ${t}`, () => {
      expect([t, screenFact(t).ok]).toEqual([t, true]);
      expect([t, screenNote(`# Note\n\n${t}\n`).ok]).toEqual([t, true]);
    });

  // Refusals that stay by design: a password-shaped token after a STRONG cue always refuses, even when it reads like a name.
  for (const t of ["the login is jane, Version12345 is out", "log in as jane, Sprint14Plan", "login is bianca, Nexus-v2-Release"])
    test(`still refused after a strong cue: ${t}`, () => expect(refused(t)).toBe(true));
});

/** The review's 72 ordinary business notes (dates, ABN, phone numbers, addresses, invoice numbers, hyphenated project names, git refs). */
const BUSINESS_NOTES = [
  "meeting with Bianca on 12 October 2026 at 3pm", "renewal due 12-Oct-2026", "invoice due 2026-10-12", "call Bianca back on 0412 345 678", "call Bianca on 02 9876 5432 tomorrow",
  "Bianca's number is 0412 345 678", "Mehroz's mobile is 0423 456 789", "the ABN is 51 824 753 556", "ABN 51824753556 for M&U Ventures", "our ACN is 123 456 789",
  "invoice INV-2026-0042 is paid", "invoice number 10042 sent to Bianca", "quote Q-2026-117 approved", "PO number 55-2231-19 received", "deposit A$825 received from the first client",
  "the address is 12 Smith Street, Mount Druitt NSW 2770", "office at Level 3, 100 George Street, Sydney 2000", "Bianca lives at 5/22 Railway Parade, Blacktown", "postcode is 2770",
  "the project is Project-Nahda-2026", "the dental demo is DentalDemo2026", "the branch is f/int-j3-20260929", "the repo is muv-demo-dental", "the site is bianca-preview.muventures.com.au",
  "deploy Aldergate-v2-Release on Friday", "ticket TKT-20261001 is open for the account", "order 3 hosting plans for the client account", "the account manager is Mehroz",
  "the user story is login flow with Google", "user research with Bianca on 12 October", "the login page needs a new hero", "the login button is broken on mobile", "login is slow on the dental site",
  "account is overdue by 14 days", "the account is Bianca Dental Pty Ltd", "email is jane@example.com and phone is 0412 345 678",
  "our login provider is Clerk and the account is muventuresau", "sign in with Google works on the marketing site", "the router is a TP-Link Archer AX55", "router login page is at 192.168.0.1",
  "wifi network is KestrelGuest and it's in the office", "the details are in the Xero account", "the details are jane and the Q4 plan", "the account is jane and the launch is 2026-10-12",
  "the account number for the invoice is 12345678 at ANZ", "pay Bianca invoice 20260042 by Friday", "the meeting id is 123 456 7890", "zoom passcode is in the calendar invite",
  "reset the password for Bianca's site tomorrow", "remind me to change my password on Friday", "the password manager is Bitwarden", "the pin on the map is in Mount Druitt",
  "promo code SPRING25 gives 25 percent off", "the tracking number is AP123456789", "the flight is QF-401 on 12-Oct-2026",
  "Mehroz's UTS student ID is 12345678", "Usman's Macquarie ID is 45678901", "the domain is muventures.com.au, renewal 2027-03-01", "PayID is muventuresau@muventures.com.au",
  "the client's preferred login is email and password", "user jane wants a demo on 2026-10-12", "user Mehroz approved Deploy-2026-10-01", "account jane approved the quote Q4-Launch2026",
  "the wifi in the new office is fast", "the version is 2.4.1-beta.3", "commit hash is 4d3a569", "merge f/j3-20260929 into jarvis-voice", "the build number is 20260929-1", "sha 77b775c passed",
];
/** Refused by the guard before J3 too (weak "code" labels); listed so the gap is on record, not silently accepted. */
const KNOWN_REFUSALS = ["call code 04 for Sydney", "the code for the discount is SUMMER2026", "user is Mehroz, project code MU-Ventures-2026"];

describe("F4: ordinary business notes stay storable", () => {
  test("the review's business-note set has no new refusals", () => {
    expect(BUSINESS_NOTES.length).toBe(69);
    const wrong = BUSINESS_NOTES.filter((t) => refused(t) || !screenNote(`# Note\n\n${t}\n`).ok);
    expect(wrong).toEqual([]);
  });
  test("the three documented refusals are unchanged (not loosened)", () => {
    for (const t of KNOWN_REFUSALS) expect([t, refused(t)]).toEqual([t, true]);
  });
});

describe("F1: folding closes the invisible-character, digit-lookalike and entity bypasses", () => {
  const CARDS: [string, string][] = [
    ["a combining acute between digits", `card ${spread("\u0301")}`],
    ["variation selector 16 between digits", `card ${spread("\uFE0F")}`],
    ["a keycap sequence per digit", `card ${CARD.split("").map((d) => `${d}\uFE0F\u20E3`).join("")}`],
    ["combining grapheme joiner U+034F", `card ${spread("\u034F")}`],
    ["Hangul filler U+3164", `card ${spread("\u3164")}`],
    ["Hangul choseong and jungseong fillers", `card ${CARD.split("").map((d, i) => d + (i % 2 ? "\u115F" : "\u1160")).join("")}`],
    ["a braille blank between groups", `card ${CARD.match(/.{4}/g)!.join("\u2800")}`],
    ["l for 1", "card 4l11 1l11 1l11 1l11"],
    ["O for 0 inside a run of digit groups", "card 5500 OOOO OOOO 0004"],
    ["lower-case o for 0", "card 5500 oooo oooo 0004"],
    ["HTML decimal entities", `card ${CARD.split("").map((d) => `&#${d.charCodeAt(0)};`).join("")}`],
    ["double-encoded hex entities", `card ${CARD.split("").map((d) => `&amp;#x${d.charCodeAt(0).toString(16)};`).join("")}`],
  ];
  for (const [label, text] of CARDS)
    test(`refused: card with ${label}`, () => {
      expect([label, refused(text)]).toEqual([label, true]);
      expect([label, sensitiveCategory(text)]).toEqual([label, "bank-record"]);
      expect([label, screenNote(`# Note\n\n${text}\n`).ok]).toEqual([label, false]);
    });
  test("a password label with an accent or a combining mark is still a password label", () => {
    expect(refused("Passw\u00F3rd is sunflowerfield")).toBe(true);
    expect(refused("Passwo\u0301rd: sunflowerfield")).toBe(true);
  });
  test("ordinary text with l, o, ampersands and entities is untouched", () => {
    for (const t of ["Call Bianca on 0412 345 678 about the lo-fi playlist", "lol 100 percent", "we have 100 units of oo", "hello world 2026", "Ref: &amp; company &#169; 2026", "Tom &amp; Jerry &lt;3"])
      expect([t, screenFact(t).ok]).toEqual([t, true]);
  });
  test("folding is idempotent and never leaves an entity, a mark on a digit or a filler behind", () => {
    const once = foldForMatching(`card ${spread("\u0301\u3164")} &#52;&amp;#x31; \u2800`);
    expect(foldForMatching(once)).toBe(once);
    expect(once).toBe(`card ${CARD} 41 `);
    expect(normaliseForSecrets("4l11 1l11")).toBe("41111111");
  });
});

describe("F2/F3: scan length is bounded and every entry point is fast at 200 KB", () => {
  test("a note or memory over the scan limit is refused unread, not skipped", () => {
    const big = "word ".repeat(MAX_NOTE_CHARS / 5 + 10);
    expect(screenNote(big).ok).toBe(false);
    const long = "ok ".repeat(MAX_FACT_SCAN_CHARS);
    const f = screenFact(long);
    expect(f.ok).toBe(false);
    expect(!f.ok && f.code).toBe("too-large");
    expect(noteRefusal(long)).not.toBeNull();
    expect(sensitiveCategory("x ".repeat(MAX_NOTE_CHARS))).toBe("too-long");
    // Folding can lengthen text (U+FDFA is 18 characters under NFKC): the folded length is bounded too.
    expect(sensitiveCategory("\uFDFA".repeat(MAX_NOTE_CHARS / 2))).toBe("too-long");
  });
  test("a secret is still refused, with its own category, inside the scan limit", () => {
    const f = screenFact(`${"filler ".repeat(200)} password is sunflowerfield`);
    expect(!f.ok && f.code).toBe("prohibited-content");
  });
  const UNITS = ["key ", "token ", "password ", "1\u0301", "1\uFE0F", "\u3164", "\u2800", "&#49;", "&amp;#x31;", "l1", "1o ", "\u0661", "1\u0661\u0967\u09E7", "\uFDFA", "a\u0301", "\u2014 a / ", "it's ", "login is a and it is ", "Summer2026 ", "1.", "(((((.)))))", "a\n"];
  const fastest = (fn: () => unknown) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  test("screenNote, sensitiveCategory and folding stay well under 100 ms at 200 KB (linear)", () => {
    const worst: Record<string, number> = {};
    for (const unit of UNITS) {
      const text = unit.repeat(Math.ceil(MAX_NOTE_CHARS / unit.length)).slice(0, MAX_NOTE_CHARS);
      const runs: Record<string, number> = {
        screenNote: fastest(() => screenNote(text)),
        sensitiveCategory: fastest(() => sensitiveCategory(text)),
        foldForMatching: fastest(() => foldForMatching(`${text}\u200B`)),
        normaliseForSecrets: fastest(() => normaliseForSecrets(`${text}\u200B`)),
        screenFact: fastest(() => screenFact(text.slice(0, MAX_FACT_SCAN_CHARS))),
      };
      for (const [k, ms] of Object.entries(runs)) {
        worst[k] = Math.max(worst[k] ?? 0, ms);
        expect([JSON.stringify(unit), k, ms < 100]).toEqual([JSON.stringify(unit), k, true]);
      }
    }
    console.log("J5 worst-case ms per entry over 200 KB:", JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, Math.round(v)]))));
  }, 120_000);
});
