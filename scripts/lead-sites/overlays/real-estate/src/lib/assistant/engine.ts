import type { Agent, Listing, Suburb } from "@/data/types";
import { fmtLongDay, fullAddress, typeLabel, aud } from "@/lib/format";

/**
 * AI Walkthrough Assistant — rules-based provider.
 *
 * The assistant answers only from structured listing data it is given.
 * It recognises a set of intents, composes replies from listing fields,
 * and escalates anything it cannot answer to the listing agent. This is a
 * scripted demonstration, not a general language model; the `Provider`
 * interface below is what a model-backed provider would implement.
 */

export interface AssistantContext {
  listing: Listing;
  agent: Agent;
  suburb?: Suburb;
  others: Listing[];
}

export interface Reply {
  text: string;
  /** Which provider produced the reply. */
  provider?: "claude" | "rules";
  /** Optional listing slugs to render as cards. */
  listings?: string[];
  /** Ask the visitor for contact details to escalate. */
  escalate?: boolean;
  /** Follow-up suggestions. */
  suggestions?: string[];
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface AssistantProvider {
  name: string;
  /** `history` is the conversation so far, oldest first, not including `input`. */
  reply(input: string, ctx: AssistantContext, history?: Turn[]): Promise<Reply>;
}

const CONFIRM = "Please confirm anything important with the listing agent before you rely on it.";

function intent(input: string): string {
  const s = input.toLowerCase();
  const has = (...w: string[]) => w.some((x) => s.includes(x));
  if (has("inspect", "open home", "open house", "view", "when can i see")) return "inspections";
  if (has("price", "guide", "cost", "how much", "worth", "negotia", "offer")) return "price";
  if (has("auction")) return "auction";
  if (has("bed", "bath", "car", "park", "garage", "how many rooms")) return "rooms";
  if (has("land", "size", "sqm", "square", "how big", "block")) return "size";
  if (has("feature", "include", "what does it have", "solar", "pool", "air", "heating", "garden", "study", "office")) return "features";
  if (has("school", "transport", "ferry", "light rail", "bus", "cafe", "café", "suburb", "area", "neighbourhood", "nearby", "walk")) return "suburb";
  if (has("compare", "similar", "other", "else", "alternatives", "what else")) return "compare";
  if (has("agent", "who is selling", "contact", "call", "speak", "talk to")) return "agent";
  if (has("rent", "lease", "bond", "available", "pet", "furnished")) return "rental";
  if (has("strata", "levies", "levy", "body corporate")) return "strata";
  if (has("invest", "yield", "return", "capital growth", "should i buy", "good investment", "loan", "mortgage", "stamp duty", "legal", "contract")) return "advice";
  if (has("describe", "tell me about", "overview", "summary", "what is this")) return "overview";
  if (has("hello", "hi ", "hey")) return "greeting";
  return "unknown";
}

function inspectionsText(l: Listing): string {
  if (l.status === "sold" || l.status === "leased") return `This property has already ${l.status === "sold" ? "sold" : "been leased"}, so there are no further inspections.`;
  if (l.status === "under-offer") return "The property is under offer, so open inspections have been paused. The agent can tell you whether it might return to market.";
  if (!l.inspections.length) return "There are no scheduled inspections at the moment. The agent can arrange a private inspection.";
  const list = l.inspections.map((i) => `${fmtLongDay(i.date)} ${i.start}–${i.end}`).join("; ");
  return `Scheduled inspections: ${list}. This is a preview, so the inspection form on this page does not send anything. Please call the agency to arrange an inspection.`;
}

export const rulesProvider: AssistantProvider = {
  name: "Rules-based demonstration",
  async reply(input, ctx) {
    const { listing: l, agent, suburb, others } = ctx;
    const addr = l.address.street;
    const missing = l.unspecified?.length ? "The number of bedrooms, bathrooms or car spaces has not been supplied for this listing. Please ask the agency." : "";
    switch (intent(input)) {
      case "greeting":
        return { text: `Hello. I can answer questions about ${addr} using the listing's published details. What would you like to know?`, suggestions: ["When are the inspections?", "What's the price guide?", "What are the main features?"] };
      case "overview":
        return { text: `${addr} is a ${l.unspecified?.includes("beds") ? "" : `${l.beds}-bedroom `}${typeLabel(l.type).toLowerCase()} in ${l.address.suburb}. ${l.headline}. ${l.description[0] ?? ""}` };
      case "inspections":
        return { text: inspectionsText(l), suggestions: ["Register for an inspection", "Who is the agent?"] };
      case "price":
        if (l.method === "contact-agent") return { text: `The vendor has asked for price expectations to be discussed directly rather than published. Please ask the agency directly.`, escalate: true };
        if (l.resultDisplay) return { text: `${addr} ${l.resultDisplay.toLowerCase()}.` };
        return { text: `The listing shows: ${l.priceDisplay}.${l.events.some((e) => e.type === "price-updated") ? " The guide was revised during the campaign; the change is noted on the listing." : ""} I can't comment on negotiation or what the vendor will accept; that's a conversation for ${agent.name}. ${CONFIRM}` };
      case "auction":
        if (l.auctionAt) return { text: `The auction is scheduled for ${new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" }).format(new Date(l.auctionAt))}, on site unless the listing says otherwise. Bring identification if you'd like to register to bid. ${CONFIRM}` };
        return { text: `${addr} isn't being sold by auction. The listing shows: ${l.priceDisplay}.` };
      case "rooms":
        if (missing) return { text: missing, escalate: true };
        return { text: `${addr} has ${l.beds} bedroom${l.beds === 1 ? "" : "s"}, ${l.baths} bathroom${l.baths === 1 ? "" : "s"} and ${l.cars === 0 ? "no off-street parking" : `parking for ${l.cars} car${l.cars === 1 ? "" : "s"}`}.` };
      case "size":
        return { text: [l.landSqm ? `The land is approximately ${l.landSqm} m².` : "Land size isn't published for this listing.", l.internalSqm ? `Internal area is approximately ${l.internalSqm} m².` : "", "Measurements are approximate; please rely on the contract and your own checks."].filter(Boolean).join(" ") };
      case "features": {
        const notes = l.assistantNotes?.length ? ` Also noted by the agent: ${l.assistantNotes.join(" ")}` : "";
        return { text: `Listed features: ${l.features.join("; ")}.${notes}` };
      }
      case "suburb":
        if (!suburb) return { text: "I don't have suburb information for this listing.", escalate: true };
        return { text: `${suburb.name}: ${suburb.overview[0]} Schools nearby include ${suburb.schools.slice(0, 2).join(" and ")}. Transport: ${suburb.transport.slice(0, 2).join("; ")}.`, suggestions: [`Read the ${suburb.name} guide`] };
      case "compare": {
        const picks = others.slice(0, 3);
        if (!picks.length) return { text: "There are no comparable listings available at the moment." };
        return { text: `Here are current listings you might compare with ${addr}:`, listings: picks.map((p) => p.slug) };
      }
      case "agent":
        return { text: `${agent.name}, ${agent.role}, is shown as the contact for this listing. Please call the agency on the number shown on this page. This is a preview, so nothing you type here is passed on.`, escalate: true };
      case "rental":
        if (!l.rental) return { text: `${addr} is for sale rather than for lease. For rentals, try the Rent section.` };
        return { text: `Available from ${fmtLongDay(l.rental.availableFrom)}. Bond is ${l.rental.bondWeeks} weeks' rent (${aud(l.priceValue * l.rental.bondWeeks)}). ${l.rental.furnished ? "Furnished." : "Unfurnished."} Pets ${l.rental.petsConsidered ? "are considered on application" : "are not accepted"}.` };
      case "strata": {
        const note = l.assistantNotes?.find((n) => /strata|lev/i.test(n));
        if (note) return { text: `${note} ${CONFIRM}` };
        return { text: "Strata details aren't published on this listing. Please ask the agency for the strata report.", escalate: true };
      }
      case "advice":
        return { text: "I can't give financial, legal or investment advice, and I'm not a substitute for a licensed agent, solicitor or adviser. I can share what's published about the property, and point you to the agency's contact details. This is a preview, so nothing is passed on.", escalate: true };
      default:
        return { text: `I don't have that information in the listing for ${fullAddress(l)}. I'd rather not guess. Please ask the agency directly. This is a preview, so nothing you type here is passed on.`, escalate: true };
    }
  },
};

/**
 * Model-backed provider: posts the conversation to /api/assistant, which
 * calls Claude with the listing's published data. Falls back to the rules
 * provider when no API key is configured or the model is unavailable, so
 * the drawer always answers.
 */
export const claudeProvider: AssistantProvider = {
  name: "Claude via the Anthropic API",
  async reply(input, ctx, history = []) {
    let res: Response;
    try {
      res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: ctx.listing.slug, messages: [...history, { role: "user", text: input }] }),
      });
    } catch {
      return { ...(await rulesProvider.reply(input, ctx)), provider: "rules" };
    }
    if (res.status === 503 || res.status === 502) return { ...(await rulesProvider.reply(input, ctx)), provider: "rules" };
    if (res.status === 429) {
      const j = (await res.json()) as { error?: string };
      return { text: j.error ?? "Too many questions in a short time. Please try again in a few minutes.", provider: "claude" };
    }
    if (!res.ok) throw new Error(`assistant ${res.status}`);
    return (await res.json()) as Reply;
  },
};

export const provider: AssistantProvider = { name: "Local example walkthrough", async reply(input, ctx, history) { const result = await rulesProvider.reply(input, ctx, history); return {...result, text: (ctx.listing.supplied ? "From the details supplied for this preview. " : "Example property only. ") + result.text, provider: "rules"}; } };

export function defaultSuggestions(l: Listing): string[] {
  const s = ["When are the inspections?", "What are the main features?"];
  if (l.method === "auction") s.push("When is the auction?");
  else if (l.rental) s.push("Are pets considered?");
  else s.push("What's the price guide?");
  s.push("What's the suburb like?", "Show me similar properties");
  return s;
}
