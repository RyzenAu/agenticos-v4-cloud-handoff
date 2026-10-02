/**
 * Round 5 reviews (2 Oct 2026): the screen is MONOTONE against the base guard (af45e77). Both reviewers' corpora of synthetic strings
 * (fixtures/r5-review-corpus.ts and fixtures/r5-review2-corpus.ts) are run, and fixtures/r5-base-blocked.json lists the keys of every string the base refused.
 * Each of those must still be refused, unless its text is in ALLOW below: an explicit list of ordinary strings, each inside one of six narrow shapes:
 *   (1) a Windows drive path whose slash is glued to it; (2) a variable NAME with no value after it; (3) a type annotation "label: <typeword>" with nothing
 *   value-shaped after it on that line or the next; (4) a run/job/commit/ticket id in parentheses straight after a participle ("never logged (run 1ff900c)");
 *   (5) a compound noun phrase whose whole tail is ordinary words; (6) a glued "?token=abc" with an all-lowercase value under 8 characters.
 * Plus two URL shapes the owner hits: "Label: https://host/a/b?x=1#frag" and a "login?next=/home" link.
 * Strings the base passed may be refused too (additive hardening); they are not asserted here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screenFact } from "./guard";
import { S as SA } from "./fixtures/r5-review-corpus";
import { S1, S2, ORD3, LIST4 } from "./fixtures/r5-review2-corpus";

const baseBlocked = new Set<string>((JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "r5-base-blocked.json"), "utf8")) as { blocked: string[] }).blocked);

/** text -> shape. Every entry must be a string the base refused and the head now saves. */
const ALLOW: Record<string, string> = {
  "open https://x.test/cb?token=abc": "(6) glued ?token= with a short all-lowercase value",
  "Callback is https://x.test/cb?token=abc for the demo": "(6)",
  "key=abcdefg": "(6) 7 lowercase characters",
  "token=abcdefg": "(6)",
  "secret=abcdefg": "(6)",
  "https://x.test/cb?token=sunflow": "(6) 7 lowercase characters",
  "https://x.test/cb?token=abcdefg&next=home": "(6)",
  "the password is never logged (run 1ff900c)": "(4) hex id in parentheses after a participle",
  "Make sure the password is stored hashed and the api key is never logged (run 1ff900cc)": "(4)",
  "Land creative project mu-creative in C:/Users/Nebula PC/source/repos/mu-creative and run bun test": "(1) drive path glued to its slash",
  "type Creds = { user: string, password: string }": "(3) type annotations, nothing value-shaped after",
  "interface Creds { user: string; password: string; token?: string }": "(3)",
  "token: string, onSubmit: () => void, and password: string are the form props": "(3) the password label is followed by stop words and short words only",
  "password: str | None = None": "(3) None after the type word",
  "password: string | undefined": "(3)",
  "Preview: https://x.test/a/b": "URL after a label",
  "PR: https://github.com/Nahda/MU-Receptionist/pull/57": "URL after a label",
  "PR for the booking fix: https://github.com/Nahda/MU-Receptionist/pull/57/files?diff=split&w=1#diff-3": "URL after a label",
  "Dental R15 flagship preview: https://dental-preview.muventures.com.au/?variant=room&utm_campaign=q4-launch": "URL after a label",
  "Docs are at https://x.test/login?next=/home": "login?next= link",
  "The login page is at https://mu-receptionist.vercel.app/login?next=/agency/feed": "login?next= link",
};

const corpora: { name: string; rows: [string, string][] }[] = [
  { name: "A", rows: SA },
  { name: "B", rows: S1 },
  { name: "C", rows: S2 },
  { name: "D", rows: ORD3.map((s, i) => [String(i), s] as [string, string]) },
  { name: "E", rows: LIST4.map((s, i) => [String(i), s] as [string, string]) },
];

describe("monotone against the base: every string the base refused is still refused, except the allowlist", () => {
  let total = 0;
  for (const c of corpora)
    for (const [id, text] of c.rows) {
      if (!baseBlocked.has(`${c.name}:${id}`)) continue;
      total++;
      if (text in ALLOW) test(`allowed (${ALLOW[text]}) ${c.name}:${id}: ${text.slice(0, 60)}`, () => expect(screenFact(text).ok).toBe(true));
      else test(`blocked ${c.name}:${id}: ${JSON.stringify(text).slice(0, 70)}`, () => expect(screenFact(text).ok).toBe(false));
    }
  test("the base-blocked list is the size it was generated at, and every allowlist entry is a real base-blocked corpus string", () => {
    expect(total).toBe(582);
    const texts = new Set<string>();
    for (const c of corpora) for (const [id, text] of c.rows) if (baseBlocked.has(`${c.name}:${id}`)) texts.add(text);
    for (const t of Object.keys(ALLOW)) expect(texts.has(t), t).toBe(true);
  });
});

describe("the reviewer's ordinary content that the base also saved still saves", () => {
  for (const c of corpora)
    for (const [id, text] of c.rows) {
      if (baseBlocked.has(`${c.name}:${id}`) || c.name === "E") continue; // E is a mixed list (it includes card numbers, now refused)
      if (c.name === "A" && !id.startsWith("o")) continue; // secret-shaped strings the base passed are gaps, not ordinary content
      if ((c.name === "B" || c.name === "C") && !/^o/.test(id)) continue;
      test(`saves ${c.name}:${id}: ${text.slice(0, 60)}`, () => expect(screenFact(text).ok).toBe(true));
    }
});

describe("the six shapes, tight on both sides", () => {
  const BLOCK = [
    'password: str | None = "Hunter2x9!"', "password: string\nHunter2x9!", "password: any, Hunter2x9!", "private password: string; // Hunter2x9!", "login(user: string, password: string) Hunter2x9!",
    "password: string = 'sunflowerfield'", "password: string Hunter2x9!", "the pin is only ticket 4821", "the alarm code is always job 4821", "the api key is only sha 3a18f6d4b290",
    "the password is never logged, it is run 4821", "the password is never logged (ticket 4821)", "the api key is used: commit 3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4",
    "password format: sunflowerfield", "the wifi password name is sunflowerfield", "password storage: correct horse battery staple", "password rotation: Hunter2x9!",
    "the api key environment variable is set to Xk9mP2vLq8Zr4TnW", "the key is MY_SECRET_KEY", "sign in to Xero with admin and ADMIN_PWD", "token=abcdefgh", "?token=sunflower",
    "Xero: /jane.admin / Winter-Is-Coming", "Notes C:/Users/x/jane.admin / Winter-Is-Coming", "C:\\Users\\x\\notes: password hunter2x9",
    "Xero://jane.admin / Winter-Is-Coming", "https://user:Sup3rS3cret@host.example.com/path",
  ];
  for (const t of BLOCK) test(`blocks ${JSON.stringify(t).slice(0, 80)}`, () => expect(screenFact(t).ok).toBe(false));
  const PASS = [
    "password: str | None = None", "type Creds = { user: string, password: string }", "the password is never logged (run 1ff900c)", "key rotation page is in settings", "key rotation page to the settings screen",
    "Rotate the OpenRouter key: set OPENROUTER_API_KEY in the Windows user env var", "Wire Stripe webhook secret STRIPE_WEBHOOK_SECRET from env and verify signatures",
    "The key name is PLACES_API_KEY and the password field is optional", "Copy the files into D:/prog-scratch/film/final and C:/Users/x/Documents/Brand",
    "Preview: https://x.test/a/b", "Docs are at https://x.test/login?next=/agency/feed", "open https://x.test/cb?token=abc",
  ];
  for (const t of PASS) test(`saves ${t.slice(0, 80)}`, () => expect(screenFact(t).ok).toBe(true));
});

describe("cheap pre-existing gaps closed", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const BLOCK = [
    "Visa 4111111111111111 12/29 123", "card 4111 1111 1111 1111, 12/29, 123", "Authorization: Basic " + b64("admin:Hunter2x9"), "sshpass -p Hunter2x9 ssh x@y", "docker login -u a -p Hunter2x9",
    "redis://:Hunter2x9@host:6379", "https://Xk9mP2vLq8Zr4TnWb7Jd3HsY@github.com/org/repo.git", "pass=Hunter2x9", "pass: Hunter2x9!", "curl -u admin:Hunter2x9 https://x.test", "mysql -u root -pHunter2x9",
    "--password Hunter2x9", "ElevenLabs sk_" + "3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4b2907e5c", "Retell key_3a18f6d4b2907e5c3a18f6d4b290", "Authorization: Bearer Xk9mP2vLq8Zr4TnWb7Jd3HsY",
  ];
  for (const t of BLOCK) test(`blocks ${JSON.stringify(t).slice(0, 80)}`, () => expect(screenFact(t).ok).toBe(false));
  test("a test count and an expiry date alone are not a card", () => {
    expect(screenFact("pass: 3 tests, fail: 0, 12/29").ok).toBe(true);
    expect(screenFact("The card reader needs firmware 4.1.1 by 12/29").ok).toBe(true);
  });
});
