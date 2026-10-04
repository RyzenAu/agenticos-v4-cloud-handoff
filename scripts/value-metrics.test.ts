import { expect, test } from "bun:test";
import { apiEquivalentValue, runsInWindow, subscriptionMultiple, timeSavedValue } from "../src/lib/value-metrics";
import { ASSUMED_HOURLY_RATE, currencyForTimeZone, effectiveHourlyRate } from "../src/lib/workspace-profile";

const ld = { summary: { valueExtracted7d: 11830, value: { last7d: 11830, last28d: 40100, last30d: 42000 } } };

test("API-equivalent value uses real windows, never 7 days scaled to a month", () => {
  expect(apiEquivalentValue(ld, 7)).toBe(11830);
  expect(apiEquivalentValue(ld, 30)).toBe(42000);
  expect(apiEquivalentValue(ld, 30)).not.toBeCloseTo(11830 * (30 / 7), 0);
  expect(apiEquivalentValue({ summary: { valueExtracted7d: 5 } }, 30)).toBeNull();
  expect(subscriptionMultiple(ld, 240)).toBeCloseTo(175, 0);
});

test("the profile's hourly rate wins; an unset rate is an assumption and says so", () => {
  const unset = effectiveHourlyRate({ hourlyRate: null, currency: "AUD" });
  expect(unset).toMatchObject({ rate: ASSUMED_HOURLY_RATE, assumed: true });
  expect(unset.label).toBe("at A$120/h (assumed) — set your rate in Settings"); // L10: an AUD rate is A$, never a bare $
  const set = effectiveHourlyRate({ hourlyRate: 90, currency: "AUD" });
  expect(set).toMatchObject({ rate: 90, assumed: false, label: "at your rate of A$90/h" });
  expect(timeSavedValue(120, set)).toMatchObject({ minutes: 120, amount: 180, assumed: false });
  expect(runsInWindow(14, 28)).toBe(56);
});

test("Australian time zones suggest AUD", () => {
  expect(currencyForTimeZone("Australia/Sydney")).toBe("AUD");
  expect(currencyForTimeZone("America/New_York")).toBe("USD");
  expect(currencyForTimeZone("UTC")).toBe("AUD");
  expect(currencyForTimeZone(undefined)).toBe("AUD");
});
