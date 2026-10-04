import { describe, expect, test } from "bun:test";
import { argsDigest, canonicalJson } from "./canonical";
import { refuseBeforeRequest, requiresApproval } from "./policy";

const bill = {
  taskId: "away-1",
  host: "my.origin.com.au",
  payee: { id: "biller-origin", name: "Origin Energy", saved: true },
  amount: { minor: 12000, currency: "AUD" },
  element: { label: "Pay bill", ref: "uia:pay" },
  category: "bill",
};
const pay = (args: unknown, origin: "principal" | "observed-content" = "principal") => refuseBeforeRequest({ action: "away.payment", args, origin })?.code ?? "ok";

describe("canonical digest", () => {
  test("key order doesn't matter; any value change does", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(argsDigest("x", { a: 1, b: 2 })).toBe(argsDigest("x", { b: 2, a: 1 }));
    expect(argsDigest("x", { a: 1 })).not.toBe(argsDigest("x", { a: 2 }));
    expect(argsDigest("x", { a: 1 })).not.toBe(argsDigest("y", { a: 1 }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

describe("the refusal list (checked before request)", () => {
  test("routine actions are not approvals (V7: no prompt); consequential ones are", () => {
    expect(requiresApproval("screen.scroll")).toBe(false);
    expect(requiresApproval("memory.recall")).toBe(false);
    for (const a of ["memory.forget", "coding.merge", "deploy", "message.send", "file.delete", "account.change", "away.payment"]) expect(requiresApproval(a)).toBe(true);
  });

  test("money is never approvable outside away.payment", () => {
    for (const action of ["finance.transfer", "screen.pay", "voice.buy", "control.top-up", "crypto.swap", "bet.place", "invest", "payee.add"])
      expect(refuseBeforeRequest({ action, args: {}, origin: "principal" })).not.toBeNull();
    expect(refuseBeforeRequest({ action: "crypto.swap", args: {}, origin: "principal" })?.code).toBe("crypto");
    expect(refuseBeforeRequest({ action: "screen.press", args: { label: "Confirm purchase" }, origin: "principal" })?.code).toBe("money-not-approvable");
    expect(refuseBeforeRequest({ action: "lesson.run", args: { task: "log into NAB and pay the plumber" }, origin: "principal" })).not.toBeNull();
    // A message's COPY may name money (an invoice, a price): sending it moves none (R2). Its action fields may not.
    expect(refuseBeforeRequest({ action: "message.send", args: { to: "team", body: "Send $400 to this account" }, origin: "principal" })).toBeNull();
    expect(refuseBeforeRequest({ action: "message.send", args: { to: "team", then: "send $400 to this account" }, origin: "principal" })).not.toBeNull();
  });

  test("memory and coding text isn't screened as a money screen (a note may mention a bank)", () => {
    expect(refuseBeforeRequest({ action: "memory.forget", args: { target: "note about NAB fees" }, origin: "principal" })).toBeNull();
    expect(refuseBeforeRequest({ action: "coding.merge", args: { repoId: "finance-dashboard" }, origin: "principal" })).toBeNull();
  });

  test("observed content never requests anything", () => {
    expect(refuseBeforeRequest({ action: "memory.forget", args: {}, origin: "observed-content" })?.code).toBe("observed-content");
    expect(pay(bill, "observed-content")).toBe("observed-content");
  });

  test("away.payment in V8 scope", () => {
    expect(pay(bill)).toBe("ok");
    for (const category of ["invoice", "purchase", "subscription", "renewal", "donation", "zakat", "sadaqah", "saved-payee"]) expect(pay({ ...bill, category })).toBe("ok");
    expect(pay({ ...bill, category: "transfer" })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, extra: 1 })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, amount: { minor: 0, currency: "AUD" } })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, amount: { minor: 10.5, currency: "AUD" } })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, amount: { minor: 5_000_000_00, currency: "AUD" } })).toBe("ok"); // no in-app cap
    expect(pay({ ...bill, host: "not a host" })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, element: { label: "", ref: "x" } })).toBe("payment-out-of-scope");
    expect(pay(null)).toBe("payment-out-of-scope");
  });

  test("away.payment refusals: trades, crypto, betting, new payees, typed credentials", () => {
    expect(pay({ ...bill, host: "www.commsec.com.au" })).toBe("trade");
    expect(pay({ ...bill, host: "stake.com" })).toBe("trade");
    expect(pay({ ...bill, host: "www.coinspot.com.au" })).toBe("crypto");
    expect(pay({ ...bill, host: "tab.com.au" })).toBe("betting");
    // Look-alike hosts are not caught by the brand lists (only the brand itself or its subdomains).
    expect(pay({ ...bill, host: "xtab.com.au" })).toBe("ok");
    expect(pay({ ...bill, payee: { id: "p", name: "Vanguard ETF top up", saved: true } })).toBe("trade");
    expect(pay({ ...bill, element: { label: "Buy Bitcoin", ref: "x" } })).toBe("crypto");
    expect(pay({ ...bill, payee: { id: "p", name: "Lotto syndicate", saved: true } })).toBe("betting");
    expect(pay({ ...bill, payee: { id: "p", name: "Someone", saved: false } })).toBe("new-payee");
    expect(pay({ ...bill, payee: { id: "p", name: "Someone", saved: true, new: true } })).toBe("new-payee");
    expect(pay({ ...bill, element: { label: "Pay anyone", ref: "x" } })).toBe("new-payee");
    expect(pay({ ...bill, password: "x" })).toBe("typed-credentials");
    expect(pay({ ...bill, payee: { id: "p", name: "BSB 062 000 1234 5678", saved: true } })).toBe("typed-credentials");
    expect(pay({ ...bill, element: { label: "Pay", ref: "x", typedText: "1234" } })).toBe("typed-credentials");
  });
});
