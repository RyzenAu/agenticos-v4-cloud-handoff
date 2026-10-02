// Lead request 1 Oct 2026: a blocked charge reads "Billing blocked", never zero; a null setup fee means "not approved".
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETUP_NOT_APPROVED_HINT, blockedBilling } from "../src/components/receptionist/dashboard/usage-economics";

const row = (billingBlocked: { reason: string; message: string } | null) => ({ commercial: { mrrCents: null, setupFeeCents: null, marginCents: null, marginPct: null, caveat: "", billingBlocked } });

describe("receptionist commercial tiles", () => {
  test("a blocked client is named with its reason; unblocked clients add nothing", () => {
    const data = { clients: { ok: true, rows: [row({ reason: "usage-unreadable", message: "Usage could not be read." }), row(null)] } } as never;
    expect(blockedBilling(data)).toEqual(["Billing blocked — usage-unreadable: Usage could not be read."]);
  });
  test("an unreadable client block yields no claim either way", () => {
    expect(blockedBilling({ clients: { ok: false } } as never)).toEqual([]);
  });
  test("the setup fee tile says setup fees are not approved, not 'no package assigned'", () => {
    expect(SETUP_NOT_APPROVED_HINT).toBe("Setup fees are not approved yet");
    const src = readFileSync(join(import.meta.dir, "..", "src/components/receptionist/dashboard/usage-economics.tsx"), "utf8");
    const line = src.split("\n").find((l) => l.includes('label="Setup fees"')) ?? "";
    expect(line).toContain("unknownHint={SETUP_NOT_APPROVED_HINT}");
    expect(line).not.toContain("No client has a package assigned");
  });
});
