import { describe, expect, test } from "bun:test";
import { screenFact, screenNote } from "./guard";

// Lead review, 1 Oct 2026: these formats passed the screen at e586622 and after round 3 (credential URLs other than postgres,
// and a secret-named key assignment). Synthetic values only.
const blocked = (v: string) => (screenFact(v) as { ok: boolean }).ok === false && (screenNote(v) as { ok: boolean }).ok === false;
const saved = (v: string) => (screenFact(v) as { ok: boolean }).ok === true;

describe("known secret formats are refused", () => {
  test.each([
    "prod db is mongodb+srv://admin:Zq8vLm2pX9@cluster0.example.net/app",
    "queue at amqp://worker:Tq4nBv8Lp2@mq.example.com:5672",
    "redis://default:Wm3kRt9Lq1@cache.example.org:6379",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "client_secret: 9fK2mQ7vX4pL8rT1zW6n",
    "refresh_token=1//0gAbCdEfGhIjKlMnOpQrStUv",
  ])("%s", (v) => expect(blocked(v)).toBe(true));
});

// Known pre-existing over-block (live at e586622, not changed here): some URLs with a path ("the docs are at
// https://example.com/guide", "ssh://git@github.com/org/repo") are refused as secrets. Logged on the board as a follow-up.
describe("ordinary URLs and wording still save", () => {
  test.each([
    "see https://example.com",
    "the queue host is amqp://mq.example.com:5672 (no password in the URL)",
    "the client secret is stored in the vault, never in code",
    "set client_secret in the provider dashboard",
    "the api key is never logged",
  ])("%s", (v) => expect(saved(v)).toBe(true));
});
