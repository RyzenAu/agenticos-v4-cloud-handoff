import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GREETING, readJarvisSettings, validatePeople, validateShorthand, writeJarvisSettings } from "./jarvis-settings";

const owner = { name: "Usman", role: "owner", tailscale: ["owner@example.com"], telegram: ["123456789"] };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-settings-"));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ _about: "who is who", people: [owner] }));
  return root;
}

describe("jarvis settings", () => {
  test("defaults, then a validated write of all three parts", () => {
    const root = sandbox();
    try {
      const before = readJarvisSettings(root);
      expect(before.greeting).toBe(DEFAULT_GREETING);
      expect(before.shorthand.defaults.yt).toBe("YouTube");
      const after = writeJarvisSettings(root, {
        greeting: "Evening, sir.",
        shorthand: { " CRM ": "GoHighLevel" },
        people: [owner, { name: "Mehroz", role: "co-founder", telegram: "987654321", tailscale: "" }],
      });
      expect(after.greeting).toBe("Evening, sir.");
      expect(after.shorthand.own).toEqual({ crm: "GoHighLevel" });
      expect(after.people[1]).toEqual({ name: "Mehroz", role: "co-founder", telegram: ["987654321"] });
      const file = JSON.parse(readFileSync(join(root, ".operator-data", "people.json"), "utf8"));
      expect(file._about).toBe("who is who");
      expect(existsSync(join(root, ".operator-data", "people.json.bak"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("nothing is written when any part is invalid", () => {
    const root = sandbox();
    try {
      expect(() => writeJarvisSettings(root, { greeting: "Hello", people: [{ name: "Guest", role: "friend" }] })).toThrow("owner");
      expect(readJarvisSettings(root).greeting).toBe(DEFAULT_GREETING);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects bad shorthand and bad identities", () => {
    expect(() => validateShorthand({ "two words": "x" })).toThrow();
    expect(() => validateShorthand({ ok: "" })).toThrow();
    expect(() => validatePeople([{ ...owner, telegram: ["@usman"] }])).toThrow("Telegram");
    expect(() => validatePeople([{ ...owner, tailscale: ["not-an-email"] }])).toThrow("Tailscale");
    expect(() => validatePeople([owner, { ...owner }])).toThrow("same name");
    expect(() => validatePeople([])).toThrow();
  });
});
