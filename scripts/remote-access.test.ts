import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePeople, readPeople, syntheticTailnetForTests, tailnetPerson } from "./remote-access";

const root = mkdtempSync(join(tmpdir(), "people-"));
mkdirSync(join(root, ".operator-data"));
writeFileSync(
  join(root, ".operator-data", "people.json"),
  JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: ["owner@example.com"], telegram: ["111"] }, { name: "Mehroz", role: "co-founder", tailscale: ["partner@example.com"] }] }),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NAME = "desktop-abc.tail123.ts.net";
const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => ({ socket: { remoteAddress }, headers });
/** Serve simulated: this test's fake sockets have no real peer. The real check is in identity/serve-peer.test.ts. */
const SERVE = () => true;

test("a known Tailscale login through Serve is recognised", () => {
  expect(tailnetPerson(req({ host: `${NAME}:8443`, "tailscale-user-login": "Partner@Example.com", "x-forwarded-for": "100.64.0.12" }), root, NAME, SERVE, syntheticTailnetForTests(NAME, ["100.64.0.1"]))?.name).toBe("Mehroz");
});

test("REVIEW-S1 F2a: the same headers are not believed unless the socket's peer is Tailscale Serve", () => {
  const forged = req({ host: `${NAME}:8443`, "tailscale-user-login": "owner@example.com" });
  expect(tailnetPerson(forged, root, NAME, () => false)).toBeNull();
  // The default check asks the OS who owns the other end; a socket with no real peer is not Serve.
  expect(tailnetPerson(forged, root, NAME)).toBeNull();
});

test("unknown logins, other hosts, non-loopback sockets and missing headers are refused", () => {
  expect(tailnetPerson(req({ host: NAME, "tailscale-user-login": "stranger@example.com" }), root, NAME, SERVE)).toBeNull();
  expect(tailnetPerson(req({ host: "evil.example.com", "tailscale-user-login": "owner@example.com" }), root, NAME, SERVE)).toBeNull();
  expect(tailnetPerson(req({ host: NAME, "tailscale-user-login": "owner@example.com" }, "100.64.0.9"), root, NAME, SERVE)).toBeNull();
  expect(tailnetPerson(req({ host: NAME }), root, NAME, SERVE)).toBeNull();
  expect(tailnetPerson(req({ host: NAME, "tailscale-user-login": "owner@example.com" }), root, "", SERVE)).toBeNull();
});

test("people are described for Jarvis without anything secret", () => {
  expect(readPeople(root)).toHaveLength(2);
  expect(describePeople(readPeople(root))[0]).toBe("- **Usman** — owner; Telegram 111; Tailscale owner@example.com");
});
