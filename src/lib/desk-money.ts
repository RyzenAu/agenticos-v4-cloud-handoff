// Desk payments: how an amount reads on the confirm card and out loud. Pure and browser-safe (the card and the server share it).
const PREFIX: Record<string, string> = { AUD: "A$", USD: "US$", NZD: "NZ$", CAD: "C$", HKD: "HK$", SGD: "S$", EUR: "€", GBP: "£", "$": "$" };

/** "5000.00" → "5,000.00": thousands grouped (there is no cap, so a large amount must be easy to read). */
const group = (amount: string) => amount.replace(/^(\d+)(\.\d+)?$/, (_m, whole: string, frac: string | undefined) => `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ?? ""}`);

/** "A$120.00", "US$12.50", "€9.99", "A$5,000.00", "AUD 40.00"; "$5.00" when the page shows only "$". */
export function formatMoney(amount: string, currency: string | null | undefined): string {
  const c = (currency ?? "").toUpperCase();
  const a = group(amount);
  if (!c) return `$${a}`;
  return PREFIX[c] ? `${PREFIX[c]}${a}` : `${c} ${a}`;
}

/** The same for speech: whole amounts drop ".00" ("A$120", "A$5,000"). */
export function spokenMoney(amount: string, currency: string | null | undefined): string {
  return formatMoney(amount.replace(/\.00$/, ""), currency);
}
