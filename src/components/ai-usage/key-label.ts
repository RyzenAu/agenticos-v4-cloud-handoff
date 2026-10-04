// What the usage page prints where it used to print a variable name (R7 audit 2, P11 / item 11): a plain label. The variable names, and file
// paths, stay in the data (`keyName`) for lookups and tools, and are never drawn on the page.

const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

export function keyLabel(row: { provider: string; keyName: string }): string {
  const name = row.keyName.trim();
  if (/^per-call receipts$/i.test(name)) return "Counted from this app's own receipts";
  if (/^signed in/i.test(name)) return "Signed in";
  if (/TWILIO/.test(name)) return "Twilio account";
  if (/OPENROUTER/.test(name) && /(_ALT|_2|SECOND)/.test(name)) return "OpenRouter key (second account)";
  if (!ENV_NAME.test(name) && !name.includes("~") && !/[\/]/.test(name)) return name; // already words
  const provider = row.provider.replace(/\s*\(.*\)$/, "");
  return /,/.test(name) ? `${provider} keys` : `${provider} key`;
}
