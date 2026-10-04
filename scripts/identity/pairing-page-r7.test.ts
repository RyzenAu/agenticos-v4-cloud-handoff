import { expect, test } from "bun:test";
import { PAIRING_PAGE } from "./gate";

// Round 7 (G's proposal P1): on a server hub a founder whose only browser was revoked has no paired device; the gate's own page names the real
// route, the console command, instead of "one of your paired devices".
test("the gate's pairing page names the console command on a server hub, and keeps the paired-device wording elsewhere", () => {
  expect(PAIRING_PAGE).toContain('<span id="codeLabel">Or a one-time code from one of your paired devices</span>');
  expect(PAIRING_PAGE).toContain('if (me.hubRole === "server") $("codeLabel").textContent');
  expect(PAIRING_PAGE).toContain("bun scripts/identity/pair-code.ts --for ");
  expect(PAIRING_PAGE).toContain("System › Devices and people");
});
