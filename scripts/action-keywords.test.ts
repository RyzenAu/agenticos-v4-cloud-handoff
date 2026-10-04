import { describe, expect, test } from "bun:test";
import { ACTION_KEYWORDS, FINAL_BUTTON, matchKeywords, TASK_GATE } from "../src/lib/action-keywords";
import { needsConfirmation } from "../src/lib/jarvis-control";
import { FINAL_BUTTON as PLAN_FINAL_BUTTON } from "./screen-hands/plan";

// The two lists as they were on jarvis-voice before 27 Sep, verbatim. Every entry must still be covered.
const OLD_OUTBOUND =
  /\b(?:send|sent|e-?mail|mail\s+(?!app|client|folder)|message|whatsapp|sms|dm|reply|respond\s+to|post|publish|tweet|share|upload|book|schedule|invite|rsvp|pay|payment|purchase|buy|order\s+(?!by|them|these|the\s+files)|checkout|transfer|wire|refund|delete|remove|erase|wipe|format|uninstall|deploy|push|merge|submit|cancel\s+(?:my|the|his|her)\s+\w*\s*(?:subscription|order|booking|meeting|appointment))\b|\btext\s+(?!file|files|document|editor|box|field)\w+/i;
const OLD_FINAL_BUTTON =
  /\b(?:submit|pay|pay now|send|delete|remove|erase|publish|post|confirm|buy|purchase|place (?:my )?order|order now|check ?out|transfer|sign ?up|register|book(?: now)?|reserve|donate|subscribe|unsubscribe|apply|deploy|merge|uninstall|install|accept|agree|finish|complete|log ?out|sign ?out|save password|share|invite|upload|withdraw|deposit|cancel (?:my )?(?:order|subscription|booking|account|plan))\b/i;

/** Top-level alternatives of a group body, respecting nested parentheses. */
function alternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0,
    current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      current += c + body[++i];
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "|" && depth === 0) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out;
}
const groupBody = (source: string) => {
  const start = source.indexOf("(?:") + 3;
  let depth = 1,
    i = start;
  for (; i < source.length && depth; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
  }
  return source.slice(start, i - 1);
};

// One real phrase per old entry (task phrasing for OUTBOUND, button labels for FINAL_BUTTON).
const TASK_SAMPLES = [
  "send the invoice to Sam", "I sent it already, resend", "email Brooke the draft", "e-mail the team", "mail Sam the contract",
  "message Mehroz about lunch", "whatsapp my brother", "sms the plumber", "dm Jev on X", "reply to the last email",
  "respond to the client", "post this on LinkedIn", "publish the blog", "tweet the launch", "share the folder with Sam",
  "upload the video", "book a table for two", "schedule a call with Sam", "invite Sam to the meeting", "rsvp yes to the party",
  "pay the Vercel invoice", "make a payment to the ATO", "purchase the domain", "buy a new mouse", "order a pizza",
  "go to checkout", "transfer $50 to Mehroz", "wire the deposit", "refund the customer", "delete my downloads",
  "remove the old files", "erase the drive", "wipe the laptop", "format the USB stick", "uninstall Zoom",
  "deploy the dental site", "push the repo", "merge the branch", "submit the form", "cancel my Netflix subscription",
  "text Mehroz that I'm late",
];
const BUTTON_SAMPLES = [
  "Submit", "Pay", "Pay now", "Send", "Delete", "Remove", "Erase", "Publish", "Post", "Confirm", "Buy", "Purchase",
  "Place order", "Place my order", "Order now", "Checkout", "Check out", "Transfer", "Sign up", "Signup", "Register",
  "Book", "Book now", "Reserve", "Donate", "Subscribe", "Unsubscribe", "Apply", "Deploy", "Merge", "Uninstall",
  "Install", "Accept", "Agree", "Finish", "Complete", "Log out", "Logout", "Sign out", "Save password", "Share",
  "Invite", "Upload", "Withdraw", "Deposit", "Cancel order", "Cancel my subscription", "Cancel booking",
  "Cancel account", "Cancel plan",
];

describe("one shared keyword list", () => {
  test("plan.ts uses the shared FINAL_BUTTON, not its own copy", () => {
    expect(PLAN_FINAL_BUTTON).toBe(FINAL_BUTTON);
  });

  test("every entry of the old OUTBOUND regex is still covered by the task gate", () => {
    const alts = [...alternatives(groupBody(OLD_OUTBOUND.source)), "TEXT"];
    expect(alts.length).toBe(40); // 39 words in the group + "text <someone>"
    for (const alt of alts) {
      const re = alt === "TEXT" ? /\btext\s+(?!file|files|document|editor|box|field)\w+/i : new RegExp(`\\b(?:${alt})\\b`, "i");
      const samples = TASK_SAMPLES.filter((s) => re.test(s));
      expect({ alt, covered: samples.length > 0 }).toEqual({ alt, covered: true });
      for (const s of samples) {
        expect({ s, old: OLD_OUTBOUND.test(s) }).toEqual({ s, old: true });
        expect({ s, now: TASK_GATE.test(s) && needsConfirmation(s) }).toEqual({ s, now: true });
      }
    }
  });

  test("every entry of the old FINAL_BUTTON regex is still covered by the button gate", () => {
    const alts = alternatives(groupBody(OLD_FINAL_BUTTON.source));
    expect(alts.length).toBe(41);
    for (const alt of alts) {
      const re = new RegExp(`^(?:${alt})$`, "i");
      const samples = BUTTON_SAMPLES.filter((s) => re.test(s));
      expect({ alt, covered: samples.length > 0 }).toEqual({ alt, covered: true });
      for (const s of samples) {
        expect({ s, old: OLD_FINAL_BUTTON.test(s) }).toEqual({ s, old: true });
        expect({ s, now: FINAL_BUTTON.test(s) }).toEqual({ s, now: true });
      }
    }
  });

  test("the old negatives still pass through", () => {
    for (const s of ["Open Spotify and play my focus playlist", "What's using all my CPU?", "open the text file on my desktop", "order these files by date", "Open the mail app", "Take a screenshot"])
      expect({ s, gated: TASK_GATE.test(s) }).toEqual({ s, gated: false });
    for (const s of ["Postcode", "Format", "Message", "Reply", "Schedule", "Cancel", "Next", "Search"]) expect({ s, final: FINAL_BUTTON.test(s) }).toEqual({ s, final: false });
  });

  test("one new case per category, in each scope that category covers", () => {
    const task: Record<string, string> = {
      communication: "invite Sam to the retro",
      publishing: "upload the reel to Instagram",
      money: "donate $20 to the mosque appeal",
      commitment: "register for the webinar",
      destructive: "wipe the old laptop",
      software: "install Blender",
    };
    const button: Record<string, string> = {
      communication: "RSVP",
      publishing: "Tweet",
      money: "Refund",
      commitment: "Reserve",
      destructive: "Erase",
      software: "Install",
      account: "Sign out",
    };
    for (const [category, s] of Object.entries(task)) expect({ category, hit: matchKeywords(s, "task").some((k) => k.category === category) }).toEqual({ category, hit: true });
    for (const [category, s] of Object.entries(button)) expect({ category, hit: matchKeywords(s, "button").some((k) => k.category === category) }).toEqual({ category, hit: true });
  });

  test("every single-scope entry says why", () => {
    for (const k of ACTION_KEYWORDS) if (k.scopes.length === 1) expect({ id: k.id, why: !!k.why }).toEqual({ id: k.id, why: true });
    expect(new Set(ACTION_KEYWORDS.map((k) => k.id)).size).toBe(ACTION_KEYWORDS.length);
  });
});
