/** 1 Oct 2026: ordinary URLs with paths and normal engineering language pass; credential URLs and key formats stay blocked. Synthetic values only. */
import { describe, expect, test } from "bun:test";
import { screenFact, screenOrigin } from "./guard";

const ok = (t: string) => screenFact(t).ok === true;
const refused = (t: string) => screenFact(t).ok === false;

describe("ordinary URLs and engineering language pass", () => {
  const PASS = [
    "Licensing rules are at https://www.fairtrading.nsw.gov.au/trades-and-businesses/licensing-and-registrations",
    "The handler lives at https://github.com/org/repo/blob/main/src/a.ts",
    "See https://docs.example.com/v2/api/reference?tab=auth for the auth section",
    "Rotate the API key in settings every quarter",
    "The token budget for the brief is 4000",
    "The secret sauce is the follow-up call",
    "The service needs read/write access to the shared drive",
    "We have Sydney / Melbourne offices and a Brisbane desk",
    "Calls are answered by the receptionist / staff overflow after 5pm",
    "Admin console is http://localhost:3000/admin/settings and the router is http://192.168.0.1/status",
  ];
  for (const t of PASS) test(`passes: ${t}`, () => expect(ok(t)).toBe(true));
  test("a URL as a source reference passes", () => {
    expect(screenOrigin({ ref: "https://www.fairtrading.nsw.gov.au/trades-and-businesses/licensing-and-registrations" }).ok).toBe(true);
    expect(screenOrigin({ ref: "https://docs.example.com/v2/api/reference?tab=auth" }).ok).toBe(true);
  });
});

describe("credential URLs and secrets stay blocked", () => {
  const BLOCK = [
    "connect with postgres://admin:hunter2pass@db.example.com/app",
    "use https://user:Sup3rS3cret@host.example.com/path",
    "mongodb+srv://svc:Xk9mP2vL@cluster0.example.net/db",
    "the password is Xk9#mP2vL",
    "api_key = abcd1234efgh5678",
    "https://docs.example.com/v2/api/reference?api_key=abcd1234efgh5678ijkl",
    "https://example.com/cb?token=Xk9mP2vLq8Zr4TnW",
    "Xero://jane.admin / Winter-Is-Coming",
    "Portal: https://portal.example.com jane.admin / Winter-Is-Coming",
    "Router: http://192.168.0.1 admin / Sunflower99",
    "Router: http://router/ admin / Sunflower99",
    "Portal: https://portal.example.com usman / Winter-Is-Coming-2026",
    "Router: http://192.168.0.1 admin / sunflowerfield",
    "Router: http://[::1]:8080 admin / Sunflower99",
  ];
  for (const t of BLOCK) test(`refused: ${t}`, () => expect(refused(t)).toBe(true));
});
