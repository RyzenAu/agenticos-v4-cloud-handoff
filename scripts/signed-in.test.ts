// The sidebar names the signed-in person from /__devices/me, never from a typed or picked name (V7).
import { expect, test } from "bun:test";
import { signedInFrom } from "../src/components/shell/signed-in";

test("an authorised person is shown by their real name", () => {
  expect(signedInFrom({ authorised: true, via: "loopback", person: { id: "usman", name: "Usman" }, displayAs: "usman" })).toEqual({ id: "usman", name: "Usman", via: "loopback" });
});
test("a picked display name never replaces the authorised person", () => {
  expect(signedInFrom({ authorised: true, via: "session", person: { id: "mehroz", name: "Mehroz" }, displayAs: "usman", sharedOnly: true })?.name).toBe("Mehroz");
});
test("unauthorised, missing or malformed answers show nobody", () => {
  for (const me of [null, {}, { authorised: false, person: { id: "usman", name: "Usman" } }, { authorised: true, person: null }, { authorised: true, person: { id: "x", name: "  " } }]) expect(signedInFrom(me)).toBeNull();
});
