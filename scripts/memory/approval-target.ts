// Pure parser for the target an approval was issued for. Kept apart from ./approvals, which pulls in
// the approval service (node:crypto, bun:sqlite): voice-intents is bundled into the browser and only
// needs this (review T8: `bun run build` broke once the command bar imported voice-intents).

/** Parse the target an approval was issued for ("full:n-abc#h-<hash>", "memory:mem-x", "vanished:12"). */
export function approvalTarget(resource: string): { kind: string; target: string; headingKey?: string } | null {
  const i = resource.indexOf(":");
  if (i <= 0) return null;
  const kind = resource.slice(0, i);
  const rest = resource.slice(i + 1);
  if (kind === "vanished") return { kind, target: rest };
  const h = rest.indexOf("#");
  return h >= 0 ? { kind, target: rest.slice(0, h), headingKey: rest.slice(h + 1) } : { kind, target: rest };
}
