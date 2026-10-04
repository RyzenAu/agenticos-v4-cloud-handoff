import { expect, test } from "bun:test";
import { localReceivablesLine, LOCAL_RECEIVABLES } from "./receivables";

test("localReceivablesLine is empty when there's nothing to add", () => {
  expect(localReceivablesLine([])).toBe("");
});

test("localReceivablesLine always says the money is from the client record, not Stripe", () => {
  const line = localReceivablesLine([{ client: "Test Co", amountAud: 500, note: "half up front" }]);
  expect(line).toBe("From the client record, not Stripe: Test Co $500.00 (half up front).");
});

test("localReceivablesLine formats several entries in AUD", () => {
  const line = localReceivablesLine([
    { client: "Test Co", amountAud: 500, note: "deposit" },
    { client: "Other Co", amountAud: 1250.5, note: "final invoice" },
  ]);
  expect(line).toBe("From the client record, not Stripe: Test Co $500.00 (deposit), Other Co $1,250.50 (final invoice).");
});

test("the default list carries Bianca Brown Realty's remaining 50%", () => {
  const bianca = LOCAL_RECEIVABLES.find((r) => r.client === "Bianca Brown Realty");
  expect(bianca?.amountAud).toBe(825);
});
