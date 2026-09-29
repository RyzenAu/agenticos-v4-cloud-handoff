// REVIEW-STAGE-D B2, as adjusted by the owner (28 Sep 2026): ONLY credentials and financial secrets
// are refused (passwords and login pairs, API keys and tokens, BSB + account, card numbers, TFNs, bank
// codes / OTPs), including the evasions the reviewer found; ordinary personal and business data is
// stored and synced. Every row goes through remember, save to the vault AND vault-note sync.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseForSecrets, screenFact, screenNote } from "./guard";
import { allText, cleanup, setup, snapshot, usman } from "./testing/harness";

afterEach(cleanup);

/** Refused everywhere. Synthetic values only (test card numbers, the ATO's documented example TFN). */
const SECRETS: [string, string][] = [
  ["BSB in plain words", "Kestrel's BSB is 062-000 and account 1234 5678"],
  ["bank name, BSB and account, no labels", "CBA 062000 12345678"],
  ["BSB spaced", "bsb 062 000 acc 1234-5678"],
  ["account number with a dash", "Pay into acc no. 1234-5678 please"],
  ["card with dots", "card 4111.1111.1111.1111"],
  ["card with spaces", "Use 4111 1111 1111 1111 for the deposit"],
  ["card in words", "card four one one one one one one one one one one one one one one one"],
  ["password without digits", "wifi password is correcthorsebatterystaple"],
  ["password with digits", "The staging password: Synth3tic!pass"],
  ["password for a named thing", "the password for the Xero account is marmalade"],
  ["login pair", "Xero login is admin / Winter-Is-Coming"],
  ["username and password", "username jane.doe and password bluesky"],
  ["door pin", "door pin 4821"],
  ["passcode", "The alarm passcode is 7 7 3 1"],
  ["TFN with dashes", "TFN 123-456-782"],
  ["TFN in words", "tax file number one two three four five six seven eight two"],
  ["OTP", "the OTP is 482913"],
  ["bank code spaced", "NetCode 55 21 09"],
  ["verification code in words", "verification code: four eight two nine one three"],
  ["one-time code", "one-time code 9 9 1 2 3 4"],
  ["OpenRouter key", "key sk-or-v1-0123456789abcdefABCDEF0123456789abcdef"],
  ["API key label", "the api key is kQ9zX2mB7vR4tY1w"],
  ["access token", "access token: ghp_abcdefghijklmnopqrstuvwxyz0123"],
  // REVIEW-STAGE-D R2-2: everyday phrasing.
  ["password is now X", "The Xero password is now sunflowerfield"],
  ["password changed to X", "password changed to sunflowerfield"],
  ["set the password to X", "I set the Xero password to sunflowerfield"],
  ["password stored as X", "The wifi password is stored as sunflowerfield"],
  ["same as the old one", "The password is the same as the old one: sunflowerfield"],
  ["password: X", "Kestrel portal password: sunflowerfield"],
  ["wifi pw X", "wifi pw sunflowerfield"],
  ["the wifi key is X", "the wifi key is sunflower"],
  ["the key is X", "the key is sunflowerfield"],
  ["user X pass Y", "user jane pass bluesky"],
  ["sign in with X and Y", "sign in to Xero with admin@kestrel.test and Winter-Is-Coming"],
  ["spelled-out password", "the password is s u n f l o w e r f i e l d"],
  ["Stripe key split by spaces", "stripe key sk_live_51H8xYz 9abcDEF12 34567ghij"],
  ["card with x separators", "card 4111x1111x1111x1111"],
  ["card in full-width digits", "card ４１１１ １１１１ １１１１ １１１１"],
  ["full-width password", "ｐａｓｓｗｏｒｄ is sunflowerfield"],
  ["password is required, then the value", "the password is required: Xk9#mTr2"],
  ["hyphenated label", "the wifi-password is sunflowerfield"],
  // REVIEW-STAGE-D R3.
  ["use X as the password", "Use sunflowerfield as the Xero password"],
  ["service: user / pass", "Xero: jane.admin / Winter-Is-Coming"],
  ["wifi: network / pass", "Wifi: KestrelGuest / sunflowerfield"],
  ["uses passphrase X", "The router uses passphrase sunflowerfield"],
  ["typo passwrod", "the Xero passwrod is sunflowerfield"],
  ["leetspeak P@ssword", "Xero P@ssword: sunflowerfield"],
  // J3 (Jarvis audit, UNSAFE 3): spoken login pairs.
  ["spoken slash pair", "The router login is admin slash Sunflower99"],
  ["spoken 'at … dot …' and pair", "Login for Stripe is usman at example dot com and Sunflower99"],
  ["account with an email and 'with'", "The Netflix account is usman@example.com with Sunflower99!"],
  ["spoken pair, multi-level domain", "Xero login is jane at kestrel dot com dot au with Winter-Is-Coming9"],
  ["pair with a comma", "the username is jane.doe, Sunflower99x"],
  ["sign in pair with 'password'", "the portal login is admin and password Sunflower99"],
  // J3 review F1: invisible characters, other scripts, secrets split over lines.
  ["TFN with zero-width spaces", "my TFN is 123​456​782"],
  ["BSB and account with zero-width spaces", "BSB 062​000 acct 1234​5678"],
  ["card with zero-width joiners", "card 4111‍1111‍1111‍1111"],
  ["card with U+2060", "card 4111⁠1111⁠1111⁠1111"],
  ["card with a soft hyphen", "card 4111­1111­1111­1111"],
  ["card with mid-dots", "card 4111·1111·1111·1111"],
  ["card with bullets", "card 4111•1111•1111•1111"],
  ["card, one group per line", "card\n4111\n1111\n1111\n1111"],
  ["card in digit words, one group per line", "card\nfour one one one\none one one one\none one one one\none one one one"],
  ["card in Arabic-Indic digits", "card ٤١١١ ١١١١ ١١١١ ١١١١"],
  ["TFN in Arabic-Indic digits", "TFN ١٢٣ ٤٥٦ ٧٨٢"],
  ["password label with a Cyrillic a", "pаssword is sunflowerfield"],
  ["password label with a zero-width space", "pass​word is sunflowerfield"],
  ["bidi marks inside a TFN", "TFN 123‎456‏782"],
  // J3 review F3: login pairs the first version still missed.
  ["forward slash pair", "the router login is admin forward slash Sunflower99"],
  ["colon pair", "router login admin colon Sunflower99"],
  ["cred: user/pass", "cred: jane/Winter-Is-Coming"],
  ["creds pair", "creds admin / Sunflower99"],
  ["router: pair", "router: admin / Sunflower99"],
  ["log in as", "log in as jane, Sunflower99"],
  ["pair before its cue", "admin / Sunflower99 for the router"],
  ["usr pair", "usr jane / hunter2hunter2"],
  ["account: email then secret", "account: usman@example.com Sunflower99!"],
  ["'the pass is'", "the xero login is jane and the pass is bluesky"],
  ["login then the secret on the next line", "login is jane\nSunflower99"],
  ["my details are", "my details are jane and Sunflower99"],
];

/** Stored and synced: ordinary personal and business data (the owner doesn't want these screened). */
const ALLOWED: [string, string][] = [
  ["mobile", "The synthetic Kea contact's mobile is 0412 345 678."],
  ["mobile with dots", "Call Jane on 0412.345.678."],
  ["landline", "Reception is (02) 9876 5432."],
  ["email", "Jane's email is jane.doe@example.com."],
  ["address", "The clinic is at Unit 4/12 Smith Blvd."],
  ["date of birth", "Jane's birthday is 26/12/1990."],
  ["health", "The synthetic client mentioned knee surgery next month."],
  ["pay", "The synthetic assistant earns $45 an hour."],
  ["name", "Brooke Tan runs the synthetic Harbourview front desk."],
  ["price", "Essential is A$699 a month, 400 minutes."],
  ["password as a topic", "The password is required on the new portal."],
  ["login state", "The Xero login is broken again."],
  ["ABN", "The synthetic ABN is 51 824 753 556."],
  ["one-time as a word", "It was a one time favour for the clinic."],
  // Near misses that must still be stored.
  ["password on a portal", "Reset your password on the portal every 90 days."],
  ["password for the portal is required", "The password for the portal is required."],
  ["password manager", "We keep logins in the password manager."],
  ["pin a message", "Pin the message to the top of the channel."],
  ["the secret is advice", "The secret is consistency: call back within five minutes."],
  ["key dates", "The key dates are Monday and Friday."],
  ["discount code", "The discount code for the launch is SPRING26."],
  ["token of thanks", "Send a token of thanks to the synthetic clinic."],
  ["sign in with Google", "Sign in with Google and Microsoft accounts works."],
  ["set a reminder", "Set the reminder to 9am on Mondays."],
  // REVIEW-STAGE-D R3: rules and whereabouts, not values.
  ["password length rule", "The password is required to be 12 characters."],
  ["stored in 1Password", "The Xero password is stored in 1Password."],
  ["password on the fridge", "The wifi password is on the fridge."],
  ["access code on the invite", "The access code for the webinar is on the invite."],
  ["token budget", "The token budget is 800 tokens per turn."],
  ["hours with a slash", "Hours: Monday / Friday"],
  ["times with a slash", "Times: 9am / 10am"],
  // J3: ordinary sentences that share words with a login pair must stay.
  ["the login page needs a redesign", "The login page needs a redesign."],
  ["Mehroz prefers calls after 2", "Mehroz prefers calls after 2."],
  ["account is with a bank", "The account is with Westpac and Macquarie."],
  ["account and a count", "The account is Bianca and 2 others."],
  ["account and a quarter code", "The account is Acme and Q3-2026 renewals are due."],
  ["login and reset", "The Stripe login is broken and the reset email never arrives."],
  ["user is a person", "The user is Mehroz and he prefers calls."],
  ["email is a contact", "The email is jane.doe@example.com and the phone is 0412 345 678."],
  // J3 review F4: business notes that share words with a login pair.
  ["account with a renewal date", "the account is Mehroz with 12-Oct-2026 renewal date"],
  ["login and a plan name", "the login is jane and the launch2026 plan"],
  ["user and a campaign code", "user is Mehroz and Q4-Launch2026 campaign"],
  ["email and a filename-like token", "the email is jane@example.com with Sunflower2026 attached"],
  ["account and a pilot name", "the account is Bianca and MU-Ventures-2026 pilot"],
  ["user and a release name", "the user is Usman, Nexus-v2-Release goes out Friday"],
  ["account manager and a project", "account manager is Mehroz, Project-Nahda-2026 kicks off"],
  ["account and a demo name", "the account is Mehroz and DentalDemo2026 preview"],
  ["router is being replaced", "the router is at the office and the modem is in the cupboard"],
  ["login for the portal is by email", "the portal login is by email and the details are in the handover doc"],
  ["cred as a word", "his cred with the clinic is strong and the details are fine"],
  ["a list of names", "the user is jane and the team is Bianca, Mehroz and Usman"],
  ["phone and account numbers as words", "the account is with the bank and the phone is 0412 345 678"],
];

describe("secret screen: credentials and financial secrets only", () => {
  test("normalisation: words, dashes, dots and spacing collapse to digits", () => {
    expect(normaliseForSecrets("062-000 and 1234 5678")).toContain("062000 and 12345678");
    expect(normaliseForSecrets("four one one one")).toBe("4111");
    expect(normaliseForSecrets("double four seven")).toBe("447");
  });

  for (const [label, text] of SECRETS)
    test(`refused: ${label}`, () => {
      const f = screenFact(text);
      expect([label, f.ok, !f.ok && f.code]).toEqual([label, false, "prohibited-content"]);
      expect([label, screenNote(`# Note\n\n${text}\n`).ok]).toEqual([label, false]);
    });

  for (const [label, text] of ALLOWED)
    test(`allowed: ${label}`, () => {
      expect([label, screenFact(text).ok]).toEqual([label, true]);
      expect([label, screenNote(`# Note\n\n${text}\n`).ok]).toEqual([label, true]);
    });

  test(
    "end to end: no secret reaches the app store, the vault or Hindsight by any route; ordinary data does",
    async () => {
      const h = await setup({ proxy: true });
      const before = snapshot(h.vault);
      for (const [, text] of SECRETS) {
        expect((await h.api.remember(usman, { text, channel: "voice" })).ok).toBe(false);
        expect((await h.api.saveToVault(usman, { text })).ok).toBe(false);
      }
      expect(snapshot(h.vault)).toEqual(before);
      // A correction can't smuggle one in either.
      const m = await h.api.remember(usman, { text: "The synthetic Kea wifi is on the second floor.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect((await h.api.correct(usman, m.memory.id, { text: "The synthetic Kea wifi password is correcthorsebatterystaple." })).ok).toBe(false);
      // Vault notes carrying a secret are not synced; ordinary ones are.
      const dir = join(h.vault, "wiki", "topics", "business");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "synthetic-wifi.md"), "---\ntitle: Synthetic Wifi\n---\n\n# Synthetic Wifi\n\nwifi password is correcthorsebatterystaple\n");
      writeFileSync(join(dir, "synthetic-bank.md"), "---\ntitle: Synthetic Bank\n---\n\n# Synthetic Bank\n\nKestrel's BSB is 062-000 and account 1234 5678\n");
      writeFileSync(join(dir, "synthetic-contacts.md"), "---\ntitle: Synthetic Contacts\n---\n\n# Synthetic Contacts\n\nJane: 0412.345.678, jane.doe@example.com, Unit 4/12 Smith Blvd.\n");
      await h.api.sync({ force: true });
      const sent = [...h.bankDocs().values()].map((d) => d.content).join("\n");
      for (const [, text] of SECRETS) expect(sent).not.toContain(text);
      expect(sent).not.toContain("correcthorsebatterystaple");
      expect(sent).not.toContain("1234 5678");
      expect(sent).toContain("jane.doe@example.com");
      for (const [, text] of SECRETS) expect(allText(h.state)).not.toContain(text);
      const skipped = h.api.status().skipped.flatMap((s) => s.examples);
      expect(skipped.some((p) => p.includes("synthetic-wifi"))).toBe(true);
      expect(skipped.some((p) => p.includes("synthetic-bank"))).toBe(true);
      for (const [, text] of ALLOWED) expect((await h.api.remember(usman, { text, channel: "voice", onConflict: "keep-both" })).ok).toBe(true);
    },
    { timeout: 30_000 },
  );
});

test("labels are whole words: tool and product names that contain them stay", () => {
  for (const t of ["Saved via claude-code/2.1 by the synthetic agent.", "The pin-code-free door is at gate 2.", "Use key-value pairs for the config."])
    expect([t, screenFact(t).ok]).toEqual([t, true]);
});
