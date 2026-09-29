// Pure facts behind the Skills page (audit F3-03, F3-08, F3-23). Kept out of the route so they can
// be tested without the router, and so the page recomputes them from the current skill list on
// every render instead of freezing them in a memo taken before the data arrived.

export type SkillUsageRow = { name: string; category: string; uses: number };

/** Uses and skill count per category, in the order given. Always from the list passed in. */
export function categoryUsage(skills: readonly SkillUsageRow[], categories: readonly string[]) {
  return categories.map((name) => {
    const inCat = skills.filter((s) => s.category === name);
    return { name, uses: inCat.reduce((a, s) => a + (Number(s.uses) || 0), 0), count: inCat.length };
  });
}

/** A skill's share of the busiest skill in its group, 0–100. Never NaN: a group with no uses is 0. */
export function loadPercent(uses: number, maxUses: number) {
  if (!(maxUses > 0) || !(uses > 0)) return 0;
  return Math.round((uses / maxUses) * 100);
}

/** "Last used …" line. The aggregator writes "installed" / "never" for skills with no recorded run. */
export function lastUsedText(lastUsed: string | null | undefined) {
  const v = String(lastUsed ?? "").trim();
  if (v === "installed") return "Installed · no recorded use";
  if (!v || v === "never" || v === "—" || v === "-") return "No recorded use";
  return `Last used ${v}`;
}
