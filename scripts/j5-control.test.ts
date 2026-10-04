// J5: control_pc regressions from REVIEW-J3-R2.md: STT spellings of the vault, the classifier's superlinear time (and the
// task-length cap). Synthetic text only; nothing is executed.
import { describe, expect, test } from "bun:test";
import { classifyControlTask, controlTaskRefusal, MAX_CONTROL_TASK_CHARS, planControlTask, SECRET_BEARING, writesToVault } from "../src/lib/control-risk";
import { gateControlTask } from "../src/lib/jarvis-control";
import { moneyRefusal } from "../src/lib/money-policy";
import { controlPolicyDecision } from "./jarvis-execution/control-policy";

const tier = (task: string) => classifyControlTask(task).tier;

describe("item 4: STT and typo spellings of Obsidian and the vault ask, never run", () => {
  const SPELLINGS = ["absidian", "obsedian", "opsidian", "obisidian", "obsidain", "Obsdian", "obsidians", "ob sidian", "o b s i d i a n", "\u043Ebsidian", "Obs\u00EDdian", "OBSIDIAN"];
  for (const name of SPELLINGS)
    for (const verb of ["save this to", "write the summary in", "add a note to", "type this into"])
      test(`${verb} ${name}`, () => {
        const task = `${verb} ${name}`;
        expect([task, writesToVault(task)]).toEqual([task, true]);
        expect([task, tier(task)]).toEqual([task, "external-effect"]);
        const g = gateControlTask({ task, confirmed: false, pending: null, lastUserUtterance: task, now: 1_000 });
        expect([task, g.action]).toEqual([task, "ask"]);
      });
  test("other spellings and neighbours of the vault", () => {
    for (const t of ["save this in vaullt", "put this in my vualt", "add this to Logseq", "write it in my journal", "save this to the zettelkasten", "write this in my notebook"])
      expect([t, tier(t)]).toEqual([t, "external-effect"]);
  });
  test("ordinary tasks are not caught by the fuzzy match", () => {
    for (const t of ["open notepad", "open Obsidian", "what is Obsidian", "open Obs1dian", "save this to D:\\tmp\\a.txt", "write a note in Notepad", "the fault report is done", "save the invoice as a PDF in D:\\tmp\\inv.pdf", "open the obsolete file list", "play some music"])
      expect([t, writesToVault(t)]).toEqual([t, false]);
  });
});

describe("item 6: classifyControlTask is linear, and over the length cap it asks", () => {
  const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const SHAPES: Record<string, string> = {
    digits: "1",
    dots: ".",
    "long token": "aB3",
    "many short lines": "a\n",
    "nested punctuation": "(((((.)))))",
    "slashes": "/",
    "dotted words": "a.b",
    "keywords": "key",
    "commas": ",",
    "spaces and digits": "1 ",
    "arabic-indic digits": "\u0661",
    "words": "open the file and ",
  };
  test("a task over the cap is a question for the owner and a refusal for the executor, before any scan", () => {
    const long = `open notepad ${"and then a ".repeat(MAX_CONTROL_TASK_CHARS / 10)}`;
    expect(long.length).toBeGreaterThan(MAX_CONTROL_TASK_CHARS);
    expect(classifyControlTask(long)).toMatchObject({ tier: "external-effect" });
    expect(classifyControlTask(long).reasons[0]).toMatch(/too long to check/);
    expect(planControlTask(long)).toMatchObject({ tier: "external-effect", needsApproval: true, executed: false, steps: [] });
    expect(controlTaskRefusal(long)).toBe("too-long");
    expect(controlPolicyDecision(long)).toEqual({ permitted: false, reason: "too-long" });
    const g = gateControlTask({ task: long, confirmed: false, pending: null, lastUserUtterance: long, now: 1_000 });
    expect(g.action).toBe("refuse");
    expect((g as { reply: string }).reply).toMatch(/too long to check/);
    // A yes never rescues it.
    const yes = gateControlTask({ task: long, confirmed: true, pending: { task: long, at: 1_000 }, lastUserUtterance: "yes", now: 2_000 });
    expect(yes.action).toBe("refuse");
    expect(writesToVault(long)).toBe(true);
  });
  test("the cap adds nothing to ordinary short requests, payments included (same answers as before the cap)", () => {
    for (const t of ["pay the Telstra bill", "transfer $500 to Mehroz", "send $50 to my brother on PayID", "buy 10 shares of Apple", "open netbank", "log in to NetBank", "open notepad", "play some music"]) {
      expect([t, controlTaskRefusal(t) === "too-long"]).toEqual([t, false]);
      expect([t, classifyControlTask(t).reasons.some((r) => /too long/.test(r))]).toEqual([t, false]);
    }
    expect(controlTaskRefusal("pay the Telstra bill")).toBe("money-or-trading");
    expect(controlTaskRefusal("open netbank")).toBe("bank-broker-or-exchange");
  });
  test("a task of exactly the cap length is still classified normally", () => {
    const task = `open notepad${" ".repeat(MAX_CONTROL_TASK_CHARS - "open notepad".length)}`;
    expect(task.length).toBe(MAX_CONTROL_TASK_CHARS);
    expect(tier(task)).toBe("local-reversible");
    expect(controlTaskRefusal(task)).toBeNull();
  });
  test("200 KB of each adversarial shape answers in under 50 ms (the cap is checked before any regular expression)", () => {
    for (const [name, unit] of Object.entries(SHAPES)) {
      const text = rep(unit, 200_000);
      const t0 = performance.now();
      classifyControlTask(text);
      planControlTask(text);
      controlTaskRefusal(text);
      controlPolicyDecision(text);
      writesToVault(text);
      const ms = performance.now() - t0;
      expect([name, ms < 50]).toEqual([name, true]);
    }
  });
  test("just under the cap, every shape is fast (the regular expressions themselves are linear)", () => {
    const worst: Record<string, number> = {};
    for (const [name, unit] of Object.entries(SHAPES)) {
      const text = rep(unit, MAX_CONTROL_TASK_CHARS - 1);
      const t0 = performance.now();
      classifyControlTask(text);
      const c = performance.now() - t0;
      const t1 = performance.now();
      controlTaskRefusal(text);
      const r = performance.now() - t1;
      worst[name] = Math.max(c, r);
      expect([name, Math.max(c, r) < 250]).toEqual([name, true]);
    }
    console.log("J5 classify/refusal worst ms just under the cap:", JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, Math.round(v)]))));
  });
  test("the secret-path pattern itself is linear on 200 KB (no cap in front of it for its other callers)", () => {
    for (const [name, unit] of Object.entries(SHAPES)) {
      const text = rep(unit, 200_000);
      const t0 = performance.now();
      SECRET_BEARING.test(text);
      expect([name, performance.now() - t0 < 100]).toEqual([name, true]);
    }
  });
  test("the secret-path pattern still names what it named", () => {
    for (const t of ["open D:\\Users\\me\\.aws\\credentials", "cat token.txt", "open C:\\tmp\\my-secret-notes.txt", "read the .env file", "open ~/.ssh/id_rsa", "read D:\\x\\api.key", "open notes/keys.json", "open a/b/c.d/token"])
      expect([t, SECRET_BEARING.test(t)]).toEqual([t, true]);
    for (const t of ["open the auth page", "open author.json", "read the README", "open package.json", "open D:\\tmp\\notes.txt"])
      expect([t, SECRET_BEARING.test(t)]).toEqual([t, false]);
  });
  test("the money amount pattern still refuses inside long runs (bounded scans, same answers)", () => {
    for (const t of [`send Sam ${"9".repeat(80)} dollars`, `pay ${"a ".repeat(40)}dollars`, `transfer ${"1,".repeat(30)}5 bucks`, `send Sam $${"1".repeat(90)}`, `pay Sam ${"7".repeat(70)} aud`])
      expect([t.slice(0, 30), moneyRefusal(t)?.kind]).toEqual([t.slice(0, 30), "money-or-trading"]);
  });
});
