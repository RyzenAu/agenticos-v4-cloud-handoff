// One plural helper for owner-facing copy: "1 node", "2 nodes", "1,200 nodes" (audit P2-8: "1 nodes",
// "1 approvals entry needs fixing").
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;
/** "needs" or "need": the verb that agrees with a count. */
export const needs = (n: number) => (n === 1 ? "needs" : "need");
