// J5 review F2: a label carries over a whole header block on a page read (REVIEW-J3-R2.md section 2, "Tables, medium").
// Fake values only.
import { describe, expect, test } from "bun:test";
import { HIDDEN, safePageText } from "./page-redact";

const PASSWORD = "Sunflower99!";
const said = (page: string) => safePageText(page).text;

describe("a label hides its whole header block and the value rows", () => {
  const SECRETS: [string, string, string][] = [
    ["a header row then a value row (one cell per line)", "Users\nUsername\nPassword\nEmail\nPhone\nRole\nStatus\nCreated\nUpdated\nadmin\nSunflower99!\nadmin@example.test\n0412 345 678\nOwner\nActive\nToday\nToday\nThanks for visiting.", PASSWORD],
    ["a label and several unrelated cells before the value", "Password\nAlpha\nBravo\nCharlie\nDelta\nEcho\nFoxtrot\nGolf\nSunflower99!", PASSWORD],
    ["a markdown row", "Account details\n| Username | admin |\n| Password | Sunflower99! |\n| Role | Owner |", PASSWORD],
    ["a markdown table with a header row and a value row", "| Username | Password |\n|---|---|\n| admin | Sunflower99! |", PASSWORD],
    ["markdown emphasis on the label", "**Password**\nSunflower99!", PASSWORD],
    ["a JSON key: pass", '{"user": "admin", "pass": "Sunflower99!"}', PASSWORD],
    ["a JSON key: recovery", '{"recovery": "abandon ability able about above absent"}', "abandon"],
    ["a JSON key: seed_phrase", '{"seed_phrase": "abandon ability able about above absent"}', "abandon"],
    ["a JSON key on its own line", '{\n  "pass": "Sunflower99!"\n}', PASSWORD],
    ["a config line", "pass: Sunflower99!", PASSWORD],
    ["a recovery phrase, one word per line", "Recovery phrase\nabandon\nability\nable\nabout\nabove\nabsent\nabsorb\nabstract\nabsurd\nabuse\naccess\naccident", "accident"],
    ["a seed phrase, one word per line (24 words)", `Seed phrase\n${Array.from({ length: 24 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join("\n")}`, "wordx"],
    ["a backup phrase label", "Backup phrase\nsunflower\nharbour\nlantern\nmarble", "marble"],
    ["a token label", "Token\nsk_test_fakefakefakefake", "sk_test_fake"],
    ["a secret label", "Secret\nSunflower99!", PASSWORD],
    ["a single-line IBAN", "Pay to GB82 WEST 1234 5698 7654 32 today.", "5698"],
    ["an IBAN with its label, one group per line", "IBAN\nGB82\nWEST\n1234\n5698\n7654\n32", "5698"],
    ["an IBAN one group per line with no label", "Details\nGB82\nWEST\n1234\n5698\n7654\n32\nThanks.", "5698"],
  ];
  for (const [label, page, fragment] of SECRETS)
    test(`hidden: ${label}`, () => {
      const r = safePageText(page);
      expect([label, r.text.includes(fragment)]).toEqual([label, false]);
      expect([label, r.hidden > 0]).toEqual([label, true]);
    });
  test("the table's own title and the closing sentence are still spoken", () => {
    const r = safePageText(SECRETS[0][1]);
    expect(r.text).toContain("Users");
    expect(r.text).toContain("Thanks for visiting.");
  });
  test("an ordinary sentence after the block is not hidden", () => {
    const t = said("Password\nSunflower99!\nWelcome to the customer portal, where you can view your invoices.");
    expect(t).toContain("Welcome to the customer portal");
    expect(t).not.toContain(PASSWORD);
  });
});

describe("ordinary pages keep their words", () => {
  const OK: string[] = [
    "Call us on 02 9876 5432 or 0412 345 678.",
    "ABN 51 824 753 556. ACN 123 456 789.",
    "Since 2010 we've served 12,000 patients across Sydney.",
    "Open Mon-Fri 9am-5pm. 12 Smith St, Mount Druitt NSW 2770.",
    "Our plans\n1\n2\n3\nEssential\nA$699\nProfessional\nA$1,099\nOpen 9 to 5.",
    "Login\nSign up\nPricing\nContact\nBook now",
    "Our tokens are used for design. The secret to good dental care is brushing.",
    "Version 2.4.1 released 2026-09-28. Commit 4d3a569.",
    "Reception\nOpen weekdays\nBook online\nCall us",
    "Mount Druitt\nNSW\n2770\nAustralia",
  ];
  for (const page of OK)
    test(`kept: ${page.slice(0, 40).replace(/\n/g, " / ")}`, () => {
      const r = safePageText(page);
      expect(r.text).not.toContain(HIDDEN);
    });
});

describe("timing: many short lines with labels stay linear", () => {
  test("6,000 characters of labels and cells is judged in well under 100 ms", () => {
    const page = "Password\nx\n".repeat(600);
    const t0 = performance.now();
    safePageText(page);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
