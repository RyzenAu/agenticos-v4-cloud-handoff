// The two edge cases REVIEW-FINANCE (R2) left documented: #1 NAB re-orders AND re-words a day in a
// later export; #3 NAB renames an unknown merchant, so a founder's vendor rule stopped applying.
// SYNTHETIC data only.
import { describe, expect, test } from "bun:test";
import { SHARED_LEDGER, merchantFamily, openManualFinanceStore } from "./manual-store";
import { buildNabCsv, type SyntheticLine } from "./manual-fixtures";
import { summary } from "./manual-summary";

const L = SHARED_LEDGER;
const mem = () => openManualFinanceStore(":memory:", { now: () => new Date("2026-09-27T09:00:00Z") });
const line = (over: Partial<SyntheticLine>): SyntheticLine => ({ date: "03 Sep 26", amount: "-10.00", type: "EFTPOS DEBIT", details: "SYNTH A", merchant: "Synth A", ...over });
const cashOut = (s: ReturnType<typeof mem>) => summary(L, "all", { store: s, today: "2026-09-27" }).cashOutCents;

describe("#1: a day re-ordered and re-worded in a later export is not counted twice", () => {
  const day = [line({}), line({ amount: "-20.00", details: "SYNTH B", merchant: "Synth B" }), line({ amount: "-30.00", details: "SYNTH C", merchant: "Synth C" })];
  const reworded = (l: SyntheticLine) => ({ ...l, details: `${l.details} ENRICHED`, category: "Recategorised" });
  const later = [day[2], day[0], day[1]].map(reworded);

  test("3 rows stay 3 (the review saw 3 become 5); re-importing either export adds nothing", () => {
    const s = mem();
    expect(s.importCsv(L, buildNabCsv(day), "test")).toMatchObject({ inserted: 3 });
    expect(s.importCsv(L, buildNabCsv(later), "test")).toMatchObject({ inserted: 0, unchanged: 3 });
    expect(s.count(L)).toBe(3);
    expect(cashOut(s)).toBe(6000);
    expect(s.importCsv(L, buildNabCsv(later), "test")).toMatchObject({ inserted: 0, unchanged: 3 });
    expect(s.importCsv(L, buildNabCsv(day), "test")).toMatchObject({ inserted: 0, unchanged: 3 });
    expect(s.count(L)).toBe(3);
    s.close();
  });

  test("a mid-day export, then the whole day re-ordered and re-worded, adds only the new rows", () => {
    const s = mem();
    const coffee = line({ amount: "-5.00", details: "SYNTH CAFE", merchant: "Synth Cafe" });
    s.importCsv(L, buildNabCsv([coffee]), "test");
    const whole = [coffee, { ...coffee }, line({ amount: "-12.00", details: "SYNTH LUNCH", merchant: "Synth Lunch" })].reverse().map(reworded);
    expect(s.importCsv(L, buildNabCsv(whole), "test")).toMatchObject({ inserted: 2, unchanged: 1 });
    expect(s.count(L)).toBe(3);
    expect(cashOut(s)).toBe(2200);
    s.close();
  });

  test("the preview says the same as the import", () => {
    const s = mem();
    s.importCsv(L, buildNabCsv(day), "test");
    expect(s.previewCsv(L, buildNabCsv(later))).toMatchObject({ inserted: 0, unchanged: 3, preview: true });
    expect(s.count(L)).toBe(3);
    s.close();
  });
});

describe("#3: a vendor rule follows a merchant NAB renamed", () => {
  test("merchant families fold corporate suffixes and store numbers, and nothing else", () => {
    expect(merchantFamily("m-officeworks-pty-ltd")).toBe("m-officeworks");
    expect(merchantFamily("m-officeworks-0423")).toBe("m-officeworks");
    expect(merchantFamily("m-the-synth-cafe")).toBe("m-synth-cafe");
    expect(merchantFamily("m-synth-co-op")).toBe("m-synth-co-op");
    expect(merchantFamily("m-officeworks-bankstown")).toBe("m-officeworks-bankstown");
    expect(merchantFamily("retell")).toBe("retell");
    expect(merchantFamily("m-pty-ltd")).toBe("m-pty");
  });

  test("a rule on 'Officeworks' applies to new 'OFFICEWORKS PTY LTD' rows and to the refreshed old ones", () => {
    const s = mem();
    const a = line({ date: "05 Sep 26", amount: "-45.99", details: "OFFICEWORKS 0000", merchant: "Officeworks" });
    s.importCsv(L, buildNabCsv([a]), "test");
    s.setVendorOverride(L, "m-officeworks", { scope: "business", category: "Office" }, "usman");
    const renamed = (l: SyntheticLine) => ({ ...l, merchant: "OFFICEWORKS PTY LTD" });
    const b = line({ date: "19 Sep 26", amount: "-12.00", details: "OFFICEWORKS 0000", merchant: "Officeworks" });
    s.importCsv(L, buildNabCsv([a, b].map(renamed)), "test");
    const rows = s.rows(L);
    expect(rows.map((r) => r.vendorId)).toEqual(["m-officeworks-pty-ltd", "m-officeworks-pty-ltd"]);
    expect(rows.map((r) => [r.scope, r.category, r.edited.scope?.source, r.edited.scope?.by])).toEqual([["business", "Office", "vendor", "usman"], ["business", "Office", "vendor", "usman"]]);
    // Same merchant family: the one rule covers both spellings, so nothing is copied.
    expect(s.vendorOverrides(L).map((o) => o.vendorId)).toEqual(["m-officeworks", "m-officeworks"]);
    s.close();
  });

  test("a wholly new name on the same transaction (seen in an overlapping export) carries the rule, logged", () => {
    const s = mem();
    const a = line({ date: "05 Sep 26", amount: "-45.99", merchant: "Synth Stationers" });
    s.importCsv(L, buildNabCsv([a]), "test");
    s.setVendorOverride(L, "m-synth-stationers", { scope: "business", category: "Office" }, "usman");
    const b = line({ date: "19 Sep 26", amount: "-12.00", merchant: "Synth Stationers" });
    s.importCsv(L, buildNabCsv([a, b].map((l) => ({ ...l, merchant: "SS Retail Group" }))), "test");
    expect(s.rows(L).map((r) => [r.vendorId, r.scope, r.category])).toEqual([["m-ss-retail-group", "business", "Office"], ["m-ss-retail-group", "business", "Office"]]);
    expect(s.vendorOverrides(L).map((o) => [o.vendorId, o.field, o.value, o.by])).toEqual([
      ["m-ss-retail-group", "category", "Office", "usman"], ["m-ss-retail-group", "scope", "business", "usman"],
      ["m-synth-stationers", "category", "Office", "usman"], ["m-synth-stationers", "scope", "business", "usman"],
    ]);
    expect(s.editLog(L).filter((e) => e.action === "carried").map((e) => [e.target, e.targetId, e.oldValue]).sort()).toEqual([
      ["vendor", "m-ss-retail-group", "m-synth-stationers"], ["vendor", "m-ss-retail-group", "m-synth-stationers"],
    ]);
    // A founder's own rule on the new name is never overwritten by a carry.
    s.setVendorOverride(L, "m-ss-retail-group", { category: "Stationery" }, "mehroz");
    s.importCsv(L, buildNabCsv([a, b]), "test"); // NAB flips back: rows refresh to the old name
    s.importCsv(L, buildNabCsv([a, b].map((l) => ({ ...l, merchant: "SS Retail Group" }))), "test");
    expect(s.vendorOverrides(L).find((o) => o.vendorId === "m-ss-retail-group" && o.field === "category")).toMatchObject({ value: "Stationery", by: "mehroz" });
    s.close();
  });

  test("a new spelling with no overlapping row still picks up the rule; its own rule wins; row corrections still win", () => {
    const s = mem();
    s.importCsv(L, buildNabCsv([line({ date: "05 Sep 26", amount: "-45.99", merchant: "Officeworks" })]), "test");
    s.setVendorOverride(L, "m-officeworks", { scope: "business", category: "Office" }, "usman");
    s.importCsv(L, buildNabCsv([line({ date: "20 Sep 26", amount: "-9.00", merchant: "OFFICEWORKS PTY LTD" })]), "test");
    const later = s.rows(L).find((r) => r.vendorId === "m-officeworks-pty-ltd")!;
    expect(later).toMatchObject({ scope: "business", category: "Office" });
    s.setVendorOverride(L, "m-officeworks-pty-ltd", { category: "Stationery" }, "mehroz");
    expect(s.row(L, later.id)).toMatchObject({ scope: "business", category: "Stationery", edited: { category: { by: "mehroz", source: "vendor" } } });
    expect(s.rows(L).find((r) => r.vendorId === "m-officeworks")).toMatchObject({ category: "Office" });
    s.setTxOverride(L, later.id, { scope: "personal" }, "mehroz");
    expect(s.row(L, later.id)).toMatchObject({ scope: "personal", edited: { scope: { source: "row" } } });
    // A different merchant that only shares a word is not the same family.
    s.importCsv(L, buildNabCsv([line({ date: "21 Sep 26", amount: "-3.00", merchant: "Officeworks Bankstown" })]), "test");
    expect(s.rows(L).find((r) => r.vendorId === "m-officeworks-bankstown")).toMatchObject({ scope: "unreviewed" });
    s.close();
  });
});
