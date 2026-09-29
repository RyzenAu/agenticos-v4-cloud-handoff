import { CLAUDE_API_PRICES as N, claudePriceKey } from "../ai-usage/prices";
import { CLAUDE_API_PRICES as O } from "./old-prices";
const keys = new Set([...Object.keys(O), ...Object.keys(N)]);
for (const k of keys) { const a = JSON.stringify(O[k]), b = JSON.stringify(N[k]); if (a !== b) console.log("DIFF", k, "old", a, "new", b); }
console.log("claudePriceKey fable-5:", claudePriceKey("claude-fable-5"), "opus-5:", claudePriceKey("claude-opus-5"), "opus-4-8:", claudePriceKey("claude-opus-4-8"));
