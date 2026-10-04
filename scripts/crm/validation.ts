/** Plain-word validation shared by the operations and the CSV import. */

export const AU_PHONE_MESSAGE =
  "Enter an Australian phone number, such as 02 9999 0000 or 0412 345 678.";

/**
 * An Australian number in the ways people write it: 02 9999 0000, (02) 9999 0000, 9999 0000 (no area code), 0412 345 678, +61 412 345 678,
 * 1300 123 456, 1800 123 456 and 13 12 34. Another country's number is accepted only with its + prefix. Empty is allowed (the field is optional).
 */
export function isAuPhone(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (!/^[+\d\s().-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    if (digits.startsWith("61")) return /^61[2-478]\d{8}$/.test(digits);
    return digits.length >= 8 && digits.length <= 15;
  }
  return (
    /^0[2-478]\d{8}$/.test(digits) || // 02 9999 0000, 0412 345 678
    /^[2-9]\d{7}$/.test(digits) || // 9999 0000
    /^1[38]00\d{6}$/.test(digits) || // 1300 / 1800
    /^13\d{4}$/.test(digits) // 13 12 34
  );
}

/** Time zones for a select: Australia first (Sydney at the top), then every other zone the runtime knows. */
export function timeZoneNames(): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
  } catch {
    all = [];
  }
  const fallback = [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Adelaide",
    "Australia/Perth",
    "Australia/Hobart",
    "Australia/Darwin",
    "Pacific/Auckland",
    "UTC",
  ];
  const names = [...new Set([...all, ...fallback])];
  const au = names
    .filter((n) => n.startsWith("Australia/"))
    .sort((a, b) =>
      a === "Australia/Sydney" ? -1 : b === "Australia/Sydney" ? 1 : a.localeCompare(b),
    );
  return [...au, ...names.filter((n) => !n.startsWith("Australia/")).sort()];
}
