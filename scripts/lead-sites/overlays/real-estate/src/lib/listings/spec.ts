import type { Listing } from "@/data/types";

/** A bedroom, bathroom or parking count, or a dash when the business did not supply it (never a made-up zero). */
export function spec(l: Listing, key: "beds" | "baths" | "cars"): string | number {
  return l.unspecified?.includes(key) ? "–" : l[key];
}
