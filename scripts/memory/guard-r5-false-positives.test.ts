/**
 * 2 Oct 2026 (round 5): the false positives behind two coding handoffs that reached memory as "withheld" or "prohibited-content",
 * reproduced with SYNTHETIC equivalents (no real handoff text was read). Each pass case is ordinary engineering or business language;
 * each block case is a near neighbour that must stay refused, so the screen is narrowed, never loosened.
 */
import { describe, expect, test } from "bun:test";
import { screenFact } from "./guard";
import { handoffFact, handoffFactTitle } from "../coding/orchestrator";

const ok = (t: string) => screenFact(t).ok === true;
const refused = (t: string) => screenFact(t).ok === false;

describe("ordinary objectives that were read as credentials", () => {
  const PASS = [
    // A Windows path after a drive letter (the creative job's briefed folder).
    "Land creative project mu-creative-20261001 in C:/Users/Nebula PC/source/repos/mu-creative and run bun test",
    "Copy the files into D:/prog-scratch/film/final and C:/Users/x/Documents/Brand",
    // Environment variable NAMES.
    "Rotate the OpenRouter key: set OPENROUTER_API_KEY in the Windows user env var, restart servers",
    "Wire Stripe webhook secret STRIPE_WEBHOOK_SECRET from env and verify signatures",
    "The key name is PLACES_API_KEY and the password field is optional",
    "The token is read from STRIPE_WEBHOOK_TOKEN in the env file",
    // Type annotations in code.
    "Refactor src/lib/auth.ts: token: string, apiKey: string, secret: string",
    // Nouns that make "password" or "key" part of a phrase.
    "Add a password strength meter, password reset email, and API key rotation page to the settings screen",
    "Add an API key name column and a token prefix input to the settings form",
    // Prose about a login, a login host and a login path.
    "Redirect https://example.com/login/reset to the account page",
    // A provider:model slug in an account sentence.
    // A short query value that is not a secret.
    "Open https://app.example.com/reset?token=abc and check expiry handling",
    "Maps link https://maps.google.com/?q=Mount+Druitt&key=value for the contact page",
    // An identifier after a reference word follows a handling phrase: a run, job, ticket or commit, not a value.
    "Make sure the password is stored hashed and the api key is never logged (run 1ff900c)",
    "The password is never logged (job 4465ff87)",
  ];
  for (const t of PASS) test(`passes: ${t.slice(0, 80)}`, () => expect(ok(t)).toBe(true));

  test("whole handoff facts with those objectives pass the screen with the request's words copied", () => {
    // An objective that ends on a type annotation is followed by the next line of the fact ("Branch coding/..."), which the type-annotation shape reads, so it is left out here.
    for (const objective of PASS.filter((o) => !/:\s*string$/.test(o))) {
      const h: any = {
        id: "x", jobId: "4465ff87-1b2c-4d3e-8f90-123456789abc", repoId: "AgenticOS-v4", baseSha: "a".repeat(40), jobBranch: "coding/land-creative-4465ff",
        headSha: "0123456789abcdef0123456789abcdef01234567", outcome: "failed", objective, changedFiles: [{ path: "a", status: "M" }],
        tests: [{ commandId: "bun-test", passed: 3, failed: 1, exitCode: 1 }], review: { verdict: "request-changes", blockers: 1, majors: 0, minors: 0 },
        usage: [{ roleId: "builder", model: "claude-sonnet-5-5", accountSlot: "claude:max-2" }, { roleId: "reviewer", model: "claude-opus-5-5", accountSlot: "claude:max-2" }],
        followUps: [], notDone: [], links: { job: "/coding/4465ff87-1b2c-4d3e-8f90-123456789abc", work: "", memory: null }, createdAt: "",
      };
      expect(screenFact(handoffFact(h, "4465ff"), handoffFactTitle(objective)).ok, objective).toBe(true);
    }
  });
});

/** Shapes the first version of this round saved but that fall outside the six narrow ones: refused again, as the base refused them (monotone rule). */
describe("kept refused because the base refused them and no narrow shape covers them", () => {
  const KEPT = [
    "Review src/pages/Login.tsx: user: string, password: string, onSubmit(username, password)",
    "Make the login page accept username and password with the password hashed with bcrypt, token expiry 15 minutes",
    "Check the Tailscale tray app: C:/Program Files/Tailscale/tailscale-ipn.exe and login via Google SSO at https://login.tailscale.com/admin/machines",
    "Check the account fallback for claude:max-2 and codex:openai-1",
    "The token is never logged (see ticket #4412)",
  ];
  for (const t of KEPT) test(`refused: ${t.slice(0, 70)}`, () => expect(screenFact(t).ok).toBe(false));
});

describe("the near neighbours stay refused", () => {
  const BLOCK = [
    "Xero://jane.admin / Winter-Is-Coming",
    "Wifi: KestrelGuest / sunflowerfield",
    "the password is hunter2x9",
    "set OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop1234",
    "OPENROUTER_API_KEY: Xk9mP2vLq8Zr4TnW",
    "the api key is Xk9mP2vLq8",
    "apiKey: Xk9mP2vLq8Zr",
    "password: Sunflower99",
    "user jane password hunter2",
    "username: jane password: hunter22",
    "login admin / Sunflower99",
    "C:/Users/x password is hunter2x9",
    "https://example.com/cb?token=Xk9mP2vLq8Zr4TnW",
    "https://maps.google.com/?q=Mount+Druitt&key=AbCdEf9",
    "token=Xk9mP2vLq8Zr4TnW",
    "the token is Xk9#mP2vL",
    "Portal: https://portal.example.com jane.admin / Winter-Is-Coming",
    "account: jane / Sunflower99",
    "use test card 4242 4242 4242 4242 in tests",
    "the password is never logged (commit hunter2x9)",
    "the password is stored hashed run Winter2026x",
    "the password is run hunter2x9",
  ];
  for (const t of BLOCK) test(`refused: ${t}`, () => expect(refused(t)).toBe(true));
});
