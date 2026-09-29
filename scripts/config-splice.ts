import yaml from "js-yaml";

/**
 * Replace (or append) one top-level block of a YAML config, leaving every other line —
 * comments, key order, CRLF — exactly as it was. Dumping the whole parsed config instead
 * strips comments and rewrites line endings across Hermes' hand-maintained config.yaml.
 */
export function spliceTopLevelBlock(text: string, key: string, value: unknown) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = yaml.dump({ [key]: value }, { lineWidth: 120, noRefs: true }).trimEnd().split("\n").join(eol) + eol;
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return text.replace(/\s*$/, "") + eol + block;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
  return [...lines.slice(0, start), block.trimEnd(), ...lines.slice(end)].join(eol);
}
