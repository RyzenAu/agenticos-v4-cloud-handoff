import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisSkills, parseSkillRequest, skillIntent } from "./index";
import type { PsHost } from "./ps-host";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-skills-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = Date.UTC(2026, 8, 24, 0, 0);
const idlePs: PsHost = { run: async () => "OK", close: () => undefined, warm: () => undefined };

describe("skillIntent routes every spec phrase to one skill", () => {
  test.each([
    ["set a timer for 10 minutes", "timer"],
    ["timer 90 seconds", "timer"],
    ["cancel the timer", "timer"],
    ["how long left", "timer"],
    ["alarm at 7:30 am", "timer"],
    ["remind me in 20 minutes to call Smile Dental", "reminder"],
    ["remind me at 3 pm to send the proposal", "reminder"],
    ["what are my reminders", "reminder"],
    ["what time is it", "time"],
    ["what's the date", "time"],
    ["what day is Friday the 3rd", "time"],
    ["what's 18% of 4,850", "maths"],
    ["convert 25 km to miles", "units"],
    ["AUD 200 in USD", "currency"],
    ["battery level", "system"],
    ["CPU and memory usage", "system"],
    ["disk space", "system"],
    ["what's my IP", "system"],
    ["is the internet working", "system"],
    ["read my clipboard", "clipboard"],
    ["copy that", "clipboard"],
    ["note: call the bank", "notes"],
    ["take a note buy milk", "notes"],
    ["read my notes", "notes"],
    ["type hello world", "type"],
    ["dictate: see you at 3", "type"],
    ["show desktop", "window"],
    ["minimise everything", "window"],
    ["switch to WhatsApp", "window"],
    ["maximise this", "window"],
    ["snap left", "window"],
    ["what's the weather", "weather"],
    ["is it going to rain tomorrow", "weather"],
    ["how hot is it in Melbourne", "weather"],
    ["what's my balance", "finance"],
    ["how much came in today", "finance"],
    ["how much did we make this month", "finance"],
    ["what did I spend this week", "finance"],
    ["what did I spend on software", "finance"],
    ["who's paid", "finance"],
    ["who owes me", "finance"],
    ["what's overdue", "finance"],
    ["when's my next payout", "finance"],
    ["what's my ai spend", "ai_usage"],
    ["receptionist status", "receptionist"],
    ["is the receptionist ready to sell", "receptionist"],
    ["any receptionist calls today", "receptionist"],
    ["how much have I spent on AI this month", "ai_usage"],
    ["how much claude usage have I got left", "ai_usage"],
    ["which codex account is nearly out", "ai_usage"],
  ])("%s → %s", (phrase, skill) => {
    expect(skillIntent(phrase)?.skill).toBe(skill as any);
  });

  test("ambiguous times ask back; his answer completes it", () => {
    expect(skillIntent("remind me at 3 to send the proposal")).toEqual({ skill: "say", text: "Is that 3 in the morning or the afternoon, sir?" });
    expect(skillIntent("pm", { previousUser: "remind me at 3 to send the proposal", lastAssistant: "Is that 3 in the morning or the afternoon, sir?" })).toMatchObject({ skill: "reminder", clock: { hour: 15 } });
  });

  test("copy that carries his last answer", () => {
    expect(skillIntent("copy that", { lastAnswer: "18% of 4850 is 873, sir." })).toEqual({ skill: "clipboard", action: "copy", text: "18% of 4850 is 873, sir." });
  });

  test("inbox questions are answered from the triage log (scripts/inbox-triage)", () => {
    expect(skillIntent("what's in my inbox")).toEqual({ skill: "inbox", action: "summary" });
    expect(skillIntent("anything important")).toEqual({ skill: "inbox", action: "important" });
    expect(skillIntent("any client emails")).toEqual({ skill: "inbox", action: "clients" });
  });

  test("everything else is left for the other tiers", () => {
    for (const phrase of [
      "open notepad", "open spotify", "what's on my screen", "status", "call mode", "start my day", "next song", "pause", "go back",
      "click the first video", "draft a reply to Brooke", "check my email", "search memory for Aldergate",
      "delegate the dental hero to Codex", "open my notes", "memory", "switch to call mode",
      "how many leads do I have", "who is Mehroz", "send the proposal to Brooke", "delete that email", "pay the invoice",
      "shut down my PC", "what type of dentist is Brooke", "convert this to PDF", "take notes of the meeting",
    ])
      expect(skillIntent(phrase)).toBeNull();
  });
});

describe("parseSkillRequest (what the client posts back)", () => {
  test("accepts what skillIntent produces", () => {
    for (const phrase of ["set a timer for 10 minutes", "remind me at 3 pm to send the proposal", "what day is the 3rd of October", "what's 18% of 4,850", "convert 25 km to miles", "AUD 200 in USD", "switch to WhatsApp", "type hello", "what's the weather", "is it going to rain tomorrow"]) {
      const request = skillIntent(phrase)!;
      expect(parseSkillRequest(JSON.parse(JSON.stringify(request)))).toEqual(request as any);
    }
  });
  test("rejects anything off-menu", () => {
    for (const bad of [
      null,
      {},
      { skill: "shell", action: "run" },
      { skill: "timer", action: "start", seconds: 999_999, phrase: "x" },
      { skill: "timer", action: "start", seconds: 60 },
      { skill: "maths", action: "calc", expr: "process.exit()" },
      { skill: "units", action: "convert", value: 1, from: "toString", to: "km" },
      { skill: "currency", action: "convert", amount: 1, from: "constructor", to: "USD" },
      { skill: "window", action: "close" },
      { skill: "type", action: "type", text: "" },
      { skill: "reminder", action: "set", text: "x", clock: { hour: 25, minute: 0 } },
      { skill: "system", action: "shutdown" },
    ])
      expect(() => parseSkillRequest(bad)).toThrow();
  });
});

describe("running skills", () => {
  test("timer set, listed for the HUD, then cancelled; time and maths answered locally", async () => {
    const events: unknown[] = [];
    const skills = createJarvisSkills(temp(), { events: { submit: (e) => events.push(e) }, now: () => NOW, ps: idlePs, vault: () => null });
    expect(await skills.run(skillIntent("set a timer for 1 minute"))).toMatchObject({ ok: true, said: "Timer set for 1 minute, sir.", skill: "timer" });
    expect(skills.timers().items).toEqual([expect.objectContaining({ kind: "timer", label: "1 minute" })]);
    expect((await skills.run(skillIntent("cancel the timer"))).said).toBe("Cancelled your 1-minute timer, sir.");
    expect((await skills.run(skillIntent("what time is it"))).said).toBe("It's 10 am, sir.");
    expect((await skills.run(skillIntent("what's 18% of 4,850"))).said).toBe("18% of 4850 is 873, sir.");
    skills.close();
  });
  test("bad input and remote callers get a plain refusal", async () => {
    const skills = createJarvisSkills(temp(), { events: { submit: () => undefined }, now: () => NOW, ps: idlePs, vault: () => null });
    expect(await skills.run({ skill: "nope" })).toMatchObject({ ok: false, said: "That isn't a skill I know, sir." });
    expect(await skills.run(skillIntent("type hello"), { remote: true })).toMatchObject({ ok: false, said: "That one only works at the PC itself, sir." });
    expect(await skills.run(skillIntent("what time is it"), { remote: true })).toMatchObject({ ok: true });
    skills.close();
  });
  test("weather is read-only (remote-safe) and reuses the dashboard's city and forecast feed", async () => {
    const fetchOpenMeteo = (async (url: string) => {
      if (url.includes("geocoding-api")) return Response.json({ results: [{ name: new URL(url).searchParams.get("name"), latitude: -33.87, longitude: 151.21 }] });
      return Response.json({ current: { temperature_2m: 19, apparent_temperature: 18, weather_code: 3, is_day: 1 }, daily: { temperature_2m_max: [21, 23], temperature_2m_min: [11, 12], precipitation_probability_max: [5, 60] } });
    }) as typeof fetch;
    const skills = createJarvisSkills(temp(), { events: { submit: () => undefined }, now: () => NOW, ps: idlePs, vault: () => null, fetch: fetchOpenMeteo, city: () => ({ name: "Sydney", source: "profile" }) });
    expect(await skills.run(skillIntent("what's the weather"), { remote: true })).toMatchObject({ ok: true, skill: "weather", said: "Overcast, 19° right now, feels like 18°." });
    skills.close();
  });
});
