import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { plainSettingNames } from "../src/components/workspace/decision-row";

test("a decision shows setting names in plain words and keeps the raw name for the folded details", () => {
  const r = plainSettingNames("Vercel Pro, TRUST_PROXY_HEADERS and alert email");
  expect(r.plain).toBe("Vercel Pro, the trusted-proxy setting and alert email");
  expect(r.raw).toEqual(["TRUST_PROXY_HEADERS"]);
  expect(plainSettingNames("Set SOME_NEW_FLAG now").plain).toBe("Set the some new flag setting now");
  expect(plainSettingNames("Make the 5 retest calls")).toEqual({ plain: "Make the 5 retest calls", raw: [] });
});

test("the 'confirm this browser' line is said once above the list, not under every decision row", () => {
  const row = readFileSync("src/components/workspace/decision-row.tsx", "utf8");
  expect(row.match(/can't record decisions until you do/g)?.length).toBe(1); // the PendingBrowserNote only
  expect(readFileSync("src/components/workspace/today-panel.tsx", "utf8")).toContain("<PendingBrowserNote />");
});
